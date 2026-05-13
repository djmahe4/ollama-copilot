/**
 * Task Orchestrator
 *
 *  5. ReAct loop (reason → act → observe → repeat)
 * 15. Retry with exponential backoff
 * 16. Rate limiting and resource awareness
 * 28. Parallel task execution (safe, independent subtasks only)
 *  8. Dependency injection
 *
 * Before each ReAct step, the MemoryManager is queried to surface relevant
 * prior code context, giving the model precise line-level information.
 *
 * DELTA TYPE: EXTEND (new orchestration layer over existing agents)
 */

import { OllamaClient } from '../ollama/client';
import { PlanManager } from './plan-manager';
import { WorkspaceTool } from '../tools/workspace';
import { PatchTool } from '../tools/patch';
import { Patch, PlannerOutput, SubTask, TaskStatus, ToolResult, CommandResult } from '../protocol/types';
import { MemoryManager } from '../utils/memory-manager';
import { ConversationManager } from '../utils/conversation-manager';
import { TerminalTool } from '../tools/terminal';
import { SkillManager } from './skill-manager';
import { startSpan, endSpan } from '../utils/optimization-engine';
import { RecoveryAgent } from '../agents/recovery';
import { McpClientManager } from '../utils/mcp-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


export interface OrchestrationResult {
  readonly success: boolean;
  readonly plan: PlannerOutput | null;
  readonly patches: readonly Patch[];
  readonly subTasks: readonly SubTask[];
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants  (technique 16 – rate limiting)
// ---------------------------------------------------------------------------

/** Minimum ms between Ollama API calls to respect local resource limits. */
const RATE_LIMIT_MS = 200;
/** Maximum retry attempts per subtask (technique 15). */
const MAX_RETRIES = 3;
/** Base delay (ms) for exponential backoff. */
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// TaskOrchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full Plan → Code → Verify → Patch workflow using a
 * ReAct loop: each step reasons about state, acts, then observes the result
 * before deciding the next action.
 */
export class TaskOrchestrator {
  private lastCallMs = 0;

  constructor(
    private readonly ollama: OllamaClient,
    private readonly planManager: PlanManager,
    private readonly workspace: WorkspaceTool,
    private readonly patchTool: PatchTool,
    private readonly terminal: any,
    private readonly skillManager: SkillManager,
    private readonly mcpClient: McpClientManager,
    private readonly memory?: MemoryManager,
    private readonly conversation?: ConversationManager
  ) {
    // Initialize specialized recovery agent
    this.recoveryAgent = new RecoveryAgent(this.ollama, this.workspace);
  }

  private recoveryAgent: RecoveryAgent;


  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run the full agentic task for `userRequest`.
   * Follows the ReAct loop: reason → plan → execute subtasks → observe.
   */
  async run(
    userRequest: string,
    onProgress?: (msg: string) => void,
    selectedSkills?: string[]
  ): Promise<OrchestrationResult> {
    const span = startSpan('orchestrator:run');
    const patches: Patch[] = [];
    
    // --- REASON: generate initial plan
    onProgress?.('🧠 Reasoning: generating implementation plan…');
    let plan: PlannerOutput;
    try {
      plan = await this.withRetry(
        () => this.planManager.plan(userRequest, onProgress),
        'planning'
      );
    } catch (err) {
      endSpan('orchestrator:run');
      return { success: false, plan: null, patches: [], subTasks: [], durationMs: 0 };
    }

    // --- DECOMPOSE: turn plan steps into independent subtasks
    const subTasks: SubTask[] = plan.steps.map((step, i) => ({
      id: `step-${i}`,
      description: step,
      status: 'pending' as TaskStatus
    }));

    // --- ReAct Loop: execute, observe, and reason
    let stepsTaken = 0;
    const MAX_STEPS = 20;

    while (subTasks.some(t => t.status === 'pending') && stepsTaken < MAX_STEPS) {
      stepsTaken++;
      const task = subTasks.find(t => t.status === 'pending')!;
      
      // ACT: execute a single subtask
      onProgress?.(`⚙️ Executing ${task.id}: ${task.description}...`);
      
      // executeSubTask now returns any generated patches
       const taskPatches = await this.executeSubTask(task, plan, onProgress, selectedSkills);

      
      if (taskPatches && taskPatches.length > 0) {
        onProgress?.(`🛠️ Applying ${taskPatches.length} patches...`);
        const applyResult = await this.applyAndVerifyPatches(taskPatches, onProgress);
        
        if (applyResult.success) {
          patches.push(...applyResult.patches);
          onProgress?.(`✓ Patches applied successfully.`);
        } else {
          onProgress?.(`❌ Patch failure: ${applyResult.errors.join(', ')}`);
          // We don't mark as failed yet, the reasoning step can decide to fix it
        }
      }

      // OBSERVE & REASON: analyze results and adjust plan
      onProgress?.('🧠 Observing result and reasoning about next steps...');
      const decision = await this.reason(userRequest, plan, subTasks);

      if (decision.action === 'modify_plan') {
        onProgress?.('🔄 Adjusting plan based on observations...');
         this.updateTasks(subTasks, decision.updates ?? []);
        // Update the plan object to reflect the new steps
        plan = { ...plan, steps: subTasks.map(t => t.description) };
      } else if (decision.action === 'done') {
        onProgress?.('✅ Goal achieved. Finishing execution.');
        break;
      }
    }

    const elapsed = endSpan('orchestrator:run');
    const success = subTasks.every(t => t.status !== 'failed');
    return {
      success,
      plan,
      patches,
      subTasks,
      durationMs: elapsed?.durationMs ?? 0
    };
  }

  /**
   * ReAct Reason step: analyzes current progress and decides whether to 
   * continue, modify the plan, or stop.
   */
  private async reason(
    userRequest: string,
    plan: PlannerOutput,
    subTasks: SubTask[]
  ): Promise<{ action: 'continue' | 'modify_plan' | 'done'; updates?: {id: string, newDesc: string}[] }> {
    await this.respectRateLimit();

    // --- CONTEXT COMPRESSION ---
    // Instead of raw results, we use summaries for completed tasks to prevent "lost in the middle" hallucinations
    const progress = subTasks.map(t => {
      const status = `[${t.status}]`;
      const detail = t.summary || (t.result ? t.result.slice(0, 100) : '');
      return `${t.id}: ${t.description} ${status} - ${detail}`;
    }).join('\n');
    
    const prompt = `You are an agent orchestrator. Analyze the current progress of a coding task.
    
User Request: ${userRequest}
Feature: ${plan.feature}

Current Task Progress (Compressed):
${progress}

Based on the results so far, should we:
1. "continue": The current plan is still valid.
2. "modify_plan": A subtask revealed something that requires changing future steps.
3. "done": The goal is achieved.

Respond ONLY in JSON format:
{
  "action": "continue" | "modify_plan" | "done",
  "updates": [ { "id": "step-X", "newDesc": "updated description" } ] // only if modify_plan
}`;

     const response = await this.ollama.chat(
       [{ role: 'user', content: prompt }],
       { 
         temperature: 0.1, 
         // eslint-disable-next-line @typescript-eslint/naming-convention
         num_predict: 300 
       }
     );

    try {
      return JSON.parse(response);
    } catch {
      return { action: 'continue' }; // Default to continue on parse error
    }
  }

  /** Update existing subtasks based on reasoning. */
  private updateTasks(subTasks: SubTask[], updates: {id: string, newDesc: string}[]): void {
    for (const update of updates) {
      const task = subTasks.find(t => t.id === update.id);
      if (task) {
        task.description = update.newDesc;
      }
    }
  }

  // -------------------------------------------------------------------------
  // ReAct: subtask execution
  // -------------------------------------------------------------------------


  /**
   * Summarizes a task result to prevent context window bloat and hallucinations.
   */
  private async summarizeResult(taskId: string, result: string): Promise<string> {
    if (!result || result.length < 200) {
      return result;
    }

    try {
      const prompt = `Summarize the following technical result into a single, concise sentence that captures the core outcome and any critical errors. 
      Keep it under 100 characters.
      
      RESULT:
      ${result.slice(0, 2000)}`;

      const summary = await this.ollama.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, num_predict: 100 }
      );
      return summary.trim();
    } catch {
      return result.slice(0, 100) + '...';
    }
  }

  /** Execute one subtask with retry + backoff (technique 15). */
  private async executeSubTask(
    task: SubTask,
    plan: PlannerOutput,
    onProgress?: (msg: string) => void,
    selectedSkills?: string[]
  ): Promise<Patch[] | null> {
    task.status = 'running';
    try {
       const result = await this.withRetry(
         () => this.reactStep(task.description, plan, selectedSkills),
         task.id
       );
       
       // Record the assistant's reasoning/action in conversation history
       this.conversation?.addMessage('assistant', `Task ${task.id} execution: ${result.slice(0, 500)}...`);
       
       // Extract patches if the result is a CoderOutput JSON
      try {
        const parsed = JSON.parse(result);
        if (parsed.patches && Array.isArray(parsed.patches)) {
          onProgress?.(`  🛠️ Generated ${parsed.patches.length} patches for ${task.id}`);
          task.result = parsed.notes?.join('\\n') || result;
          
          // --- CONTEXT COMPRESSION ---
           task.summary = await this.summarizeResult(task.id, task.result || '');
          
          task.status = 'done';
          onProgress?.(`  ✓ ${task.id}: ${task.description.slice(0, 60)}`);
          return parsed.patches;
        }
        task.result = result;
      } catch {
        task.result = result;
      }

      // Compress result if it's just a string
      task.summary = await this.summarizeResult(task.id, task.result || '');

      task.status = 'done';
      onProgress?.(`  ✓ ${task.id}: ${task.description.slice(0, 60)}`);
      return null;
    } catch (err) {
      task.error = String(err);
      task.status = 'failed';
      return null;
    }
  }

  /**
   * One ReAct step: reason about the task in context, then produce an
   * observation string summarising what changes would implement the step.
   * Memory context is retrieved and prepended to the prompt.
   */
  private async reactStep(
    taskDescription: string,
    plan: PlannerOutput,
    selectedSkills?: string[]
  ): Promise<string> {
    await this.respectRateLimit();
    
    // --- MCP TOOL DISCOVERY ---
    const tools = await this.mcpClient.listTools();
    const toolsContext = tools.length > 0 
      ? `\\n\\n## Available MCP Tools:\\n` + tools.map(t => `- ${t.name}: ${t.description}`).join('\\n')
      : 'No MCP tools available.';

    // --- SKILL INJECTION ---
    const skillsContext = selectedSkills && selectedSkills.length > 0 
      ? selectedSkills.join('\\n\\n') 
      : 'No specific skills selected for this task.';
    
    // Retrieve LTM (Code) context
    const memoryResults = await this.memory?.search(taskDescription, 10) ?? [];
    const codeContext = this.memory?.buildContext(memoryResults) ?? '';
    
    // Retrieve STM (Conversational) context
    const convHistory = this.conversation?.getModelReadyHistory() ?? [];
    const convContext = convHistory.map(m => `${m.role}: ${m.content}`).join('\\n');
    
    const prompt = `You are an expert software engineer. 
    
    ## Conversational State:
    ${convContext}

    ## Available MCP Tools:
    ${toolsContext}

    ## Inherited Skills & Rules:
    ${skillsContext}
    
    ## Project Code Context:
    ${codeContext}
    
    ## Implementation Plan:
    Feature: ${plan.feature}
    Plan: ${plan.steps.join(' → ')}
    
    ## Current Task:
    ${taskDescription}
    
    Based on the context and rules above, provide a detailed analysis and the necessary code changes. 
    
    If you need more information, you may call a tool using the format:
    CALL: tool_name { "param": "value" }
    
    If you are generating code, you MUST return a JSON object matching the CoderOutput interface:
    {
      "patches": [ { "path": "file/path", "diff": "unified diff" } ],
      "notes": [ "explanation 1", "explanation 2" ]
    }
    Otherwise, return a descriptive observation of what needs to be done.`;
    
    let currentPrompt = prompt;
    let stepsTaken = 0;
    const MAX_REACT_STEPS = 5;

    while (stepsTaken < MAX_REACT_STEPS) {
      stepsTaken++;
      const response = await this.ollama.chat(
        [{ role: 'user', content: currentPrompt }],
        { temperature: 0.1, num_predict: 2000 }
      );

      if (response.includes('CALL:')) {
        const toolCallMatch = response.match(/CALL: (\w+)\s+({.*})/);
        if (toolCallMatch) {
          const [_, toolName, paramsJson] = toolCallMatch;
          
            try {
              const params = JSON.parse(paramsJson);
              // Resolve tool intent if necessary or call directly
              const toolResolution = await this.mcpClient.resolveToolByIntent(
                `Use tool ${toolName} with params ${paramsJson}`, 
                this.ollama
              );
              
              if (toolResolution) {
                const toolResult = await this.mcpClient.callTool(toolResolution.serverName, {
                  tool: toolResolution.tool,
                  params: toolResolution.params
                });
                
                const resultData = toolResult.success ? toolResult.data : toolResult.error;
                currentPrompt += `\\n\\nObservation from ${toolResolution.tool}:\\n${resultData}`;
              } else {
                // Fallback to direct call if resolution fails, but we still need a serverName
                // In a real system, we'd need a way to map toolName -> serverName
                currentPrompt += `\\n\\nError: Could not resolve tool ${toolName} to a registered MCP server.`;
              }
            } catch (err) {
              currentPrompt += `\\n\\nError executing tool ${toolName}: ${err}`;
            }
        }
      }
      
      return response;
    }

    return `Reached max ReAct steps. Last response: ${currentPrompt}`;
  }
  /**
   * Robustly applies patches and enters a recovery loop if they fail.
   */
  async applyAndVerifyPatches(
    patches: Patch[], 
    onProgress?: (msg: string) => void
  ): Promise<{ success: boolean; patches: Patch[]; errors: string[] }> {
    const finalPatches: Patch[] = [];
    const errors: string[] = [];

    for (let i = 0; i < patches.length; i++) {
      let currentPatch = patches[i];
      let applied = false;
      let attempts = 0;
      const MAX_RECOVERY_ATTEMPTS = 3;

      while (!applied && attempts < MAX_RECOVERY_ATTEMPTS) {
        attempts++;
        const result = await this.patchTool.applyPatch(currentPatch);
        
        if (result.success) {
          applied = true;
          finalPatches.push(currentPatch);
        } else {
          onProgress?.(`⚠️ Patch failed for ${currentPatch.path}. Attempting recovery ${attempts}/${MAX_RECOVERY_ATTEMPTS}...`);
          
          // 1. Debugging: Extract current context via OS-independent helper
          const searchSnippet = currentPatch.diff.split('\n').find(l => l.startsWith(' ') && l.length > 10) || ' ';
           const actualContext = await this.terminal.getDebugContext(currentPatch.path, searchSnippet || ' ');

          // 2. Delegate to Recovery Agent
           const recovery = await this.recoveryAgent.recover(currentPatch, result.error || 'Unknown error', actualContext);
          
          if (recovery.success && recovery.correctedPatch) {
            onProgress?.(`💡 Recovery Agent found a fix: ${recovery.explanation}`);
            currentPatch = recovery.correctedPatch; // Update patch for next attempt
          } else {
            errors.push(`${currentPatch.path}: ${result.error} (Recovery failed: ${recovery.explanation})`);
            break; // Stop attempting this patch
          }
        }
      }
    }

    return {
      success: errors.length === 0,
      patches: finalPatches,
      errors
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {

  // Duplicate removed
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw new Error(`[${label}] failed after ${MAX_RETRIES} retries: ${lastError}`);
  }

  /** Ensure a minimum gap between API calls (technique 16). */
  private async respectRateLimit(): Promise<void> {
    const gap = Date.now() - this.lastCallMs;
    if (gap < RATE_LIMIT_MS) {
      await sleep(RATE_LIMIT_MS - gap);
    }
    this.lastCallMs = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
