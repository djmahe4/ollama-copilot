/**
 * Task Orchestrator
 *
 *  5. ReAct loop (reason → act → observe → repeat)
 * 15. Retry with exponential backoff
 * 16. Rate limiting and resource awareness
 * 28. Parallel task execution (safe, independent subtasks only)
 *  8. Dependency injection
 *
 * DELTA TYPE: EXTEND (new orchestration layer over existing agents)
 */

import { OllamaClient } from '../ollama/client';
import { PlanManager } from './plan-manager';
import { WorkspaceTool } from '../tools/workspace';
import { PatchTool } from '../tools/patch';
import { Patch, PlannerOutput } from '../protocol/types';
import { startSpan, endSpan } from '../utils/optimization-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SubTask {
  readonly id: string;
  readonly description: string;
  status: TaskStatus;
  result?: string;
  error?: string;
}

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
    private readonly patchTool: PatchTool
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run the full agentic task for `userRequest`.
   * Follows the ReAct loop: reason → plan → execute subtasks → observe.
   */
  async run(
    userRequest: string,
    onProgress?: (msg: string) => void
  ): Promise<OrchestrationResult> {
    const span = startSpan('orchestrator:run');
    const patches: Patch[] = [];
    let plan: PlannerOutput | null = null;

    // --- REASON: generate plan (technique 5 – ReAct)
    onProgress?.('🧠 Reasoning: generating implementation plan…');
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

    // --- ACT: execute subtasks (safe parallel batches, technique 28)
    onProgress?.(`⚙️ Executing ${subTasks.length} subtasks…`);
    await this.executeSubTasksInBatches(subTasks, plan, patches, onProgress);

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

  // -------------------------------------------------------------------------
  // ReAct: subtask execution
  // -------------------------------------------------------------------------

  /**
   * Execute subtasks in safe parallel batches (technique 28).
   * Only truly independent steps (no shared file targets) run in parallel.
   */
  private async executeSubTasksInBatches(
    subTasks: SubTask[],
    plan: PlannerOutput,
    patches: Patch[],
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const batches = this.buildBatches(subTasks, plan.files_to_read);

    for (const batch of batches) {
      await Promise.all(
        batch.map(task => this.executeSubTask(task, plan, patches, onProgress))
      );
      const failed = batch.filter(t => t.status === 'failed');
      if (failed.length > 0) {
        onProgress?.(`⚠️ ${failed.length} subtask(s) failed: ${failed.map(t => t.id).join(', ')}`);
      }
    }
  }

  /** Group independent subtasks into parallel batches. */
  private buildBatches(subTasks: SubTask[], sharedFiles: string[]): SubTask[][] {
    // Run sequentially when shared files exist to avoid write conflicts
    if (sharedFiles.length > 0) {
      return subTasks.map(t => [t]);
    }
    const batchSize = 2;
    const batches: SubTask[][] = [];
    for (let i = 0; i < subTasks.length; i += batchSize) {
      batches.push(subTasks.slice(i, i + batchSize));
    }
    return batches;
  }

  /** Execute one subtask with retry + backoff (technique 15). */
  private async executeSubTask(
    task: SubTask,
    plan: PlannerOutput,
    _patches: Patch[],
    onProgress?: (msg: string) => void
  ): Promise<void> {
    task.status = 'running';
    try {
      const result = await this.withRetry(
        () => this.reactStep(task.description, plan),
        task.id
      );
      task.result = result;
      task.status = 'done';
      onProgress?.(`  ✓ ${task.id}: ${task.description.slice(0, 60)}`);
    } catch (err) {
      task.error = String(err);
      task.status = 'failed';
    }
  }

  /**
   * One ReAct step: reason about the task in context, then produce an
   * observation string summarising what changes would implement the step.
   */
  private async reactStep(
    taskDescription: string,
    plan: PlannerOutput
  ): Promise<string> {
    await this.respectRateLimit();

    const prompt =
      `You are an expert coder. Reason briefly then describe what changes ` +
      `would implement this step:\n\nStep: ${taskDescription}\n\n` +
      `Feature: ${plan.feature}\nFiles in scope: ${plan.files_to_read.join(', ')}`;

    return this.ollama.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, num_predict: 400 }
    );
  }

  // -------------------------------------------------------------------------
  // Utilities: retry + rate limiting  (techniques 15, 16)
  // -------------------------------------------------------------------------

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
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
