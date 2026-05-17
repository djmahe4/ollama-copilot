/**
 * Plan Manager
 *
 * Extends upstream PlannerAgent with:
 *  4. Tree-of-Thought (ToT) reasoning – explores multiple plan branches and
 *     picks the one with the highest confidence score before returning.
 *  2. Prompt compression applied to gathered context before sending.
 *  1. Context-window-aware chunking of large workspace summaries.
 *  8. Dependency injection (PlannerAgent + OptimizationEngine injected).
 *
 * DELTA TYPE: EXTEND (wraps upstream PlannerAgent; does not modify it)
 */

import { PlannerAgent } from '../agents/planner';
import { OllamaClient } from '../ollama/client';
import { WorkspaceTool } from '../tools/workspace';
import { PlannerOutput } from '../protocol/types';
import { compressPrompt, chunkByTokens, startSpan, endSpan } from '../utils/optimization-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanBranch {
  readonly idea: string;
  readonly confidence: number;   // 0–1 heuristic
  readonly plan: PlannerOutput;
}

export interface ToTPlanResult {
  readonly chosen: PlanBranch;
  readonly alternatives: readonly PlanBranch[];
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of plan branches to explore in Tree-of-Thought pass. */
const TOT_BRANCHES = 3;
/** Max tokens allocated to workspace summary in the planner prompt. */
const MAX_CONTEXT_TOKENS = 3_000;

// ---------------------------------------------------------------------------
// PlanManager
// ---------------------------------------------------------------------------

/**
 * Wraps `PlannerAgent` and adds Tree-of-Thought multi-branch exploration.
 * The highest-confidence branch is returned as the final plan.
 */
export class PlanManager {
  private readonly upstream: PlannerAgent;

  constructor(
    private readonly ollama: OllamaClient,
    private readonly workspace: WorkspaceTool
  ) {
    this.upstream = new PlannerAgent(ollama, workspace);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate a plan using Tree-of-Thought reasoning.
   * Falls back to the upstream planner if ToT exploration fails.
   */
  async plan(
    userRequest: string,
    onProgress?: (msg: string) => void
  ): Promise<PlannerOutput> {
    const span = startSpan('plan-manager:plan');
    try {
      onProgress?.('🌳 Running Tree-of-Thought plan exploration…');
      const totResult = await this.runToT(userRequest, onProgress);
      const elapsed = endSpan('plan-manager:plan');
      onProgress?.(
        `✓ Plan selected (confidence=${totResult.chosen.confidence.toFixed(2)}, ` +
        `${elapsed?.durationMs ?? 0}ms)`
      );
      return totResult.chosen.plan;
    } catch {
      endSpan('plan-manager:plan');
      onProgress?.('⚠️ ToT failed, using upstream planner…');
      return this.upstream.plan(userRequest, onProgress);
    }
  }

  // -------------------------------------------------------------------------
  // Tree-of-Thought implementation  (technique 4)
  // -------------------------------------------------------------------------

  private async runToT(
    userRequest: string,
    onProgress?: (msg: string) => void
  ): Promise<ToTPlanResult> {
    const start = Date.now();

    // Gather + compress workspace context (techniques 1 + 2)
    const structureResult = await this.workspace.getWorkspaceStructure();
    const rawContext = structureResult.data ?? '';
    const chunks = chunkByTokens(rawContext, MAX_CONTEXT_TOKENS);
    const context = compressPrompt(chunks.map(c => c.content).join('\n') || rawContext);

    // Generate branch ideas in a single call to save latency
    const ideasPrompt = buildIdeasPrompt(userRequest, context);
    onProgress?.('🌿 Generating plan branch ideas…');
     const ideasRaw = await this.ollama.chat(
       [{ role: 'user', content: ideasPrompt }],
       { 
         temperature: 0.7, 
         // eslint-disable-next-line @typescript-eslint/naming-convention
         num_predict: 600 
       }
     );
    const ideas = parseIdeas(ideasRaw, TOT_BRANCHES);

    // Evaluate each branch sequentially (keep resource usage bounded)
    const branches: PlanBranch[] = [];
    for (let i = 0; i < ideas.length; i++) {
      onProgress?.(`🔍 Evaluating branch ${i + 1}/${ideas.length}…`);
      try {
        const plan = await this.upstream.plan(
          `${userRequest}\n\nApproach: ${ideas[i]}`,
          () => { /* suppress sub-progress */ }
        );
        const confidence = scoreIdea(ideas[i], plan);
        branches.push({ idea: ideas[i], confidence, plan });
      } catch {
        // skip failed branches
      }
    }

    if (branches.length === 0) {
      throw new Error('All ToT branches failed');
    }

    // Sort by confidence descending
    branches.sort((a, b) => b.confidence - a.confidence);
    const [chosen, ...alternatives] = branches;

    return { chosen, alternatives, durationMs: Date.now() - start };
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildIdeasPrompt(userRequest: string, context: string): string {
  return compressPrompt(
    `You are a senior software architect. Given the user request and workspace context, ` +
    `propose exactly ${TOT_BRANCHES} distinct implementation approaches as a numbered list. ` +
    `Each approach should be a single sentence.\n\n` +
    `User request: ${userRequest}\n\nWorkspace context (summary):\n${context}`
  );
}

function parseIdeas(raw: string, limit: number): string[] {
  const lines = raw.split('\n').filter(l => /^\d+[.)]\s/.test(l.trim()));
  return lines.slice(0, limit).map(l => l.replace(/^\d+[.)]\s*/, '').trim());
}

/** Heuristic confidence: longer step lists with more files score higher. */
function scoreIdea(idea: string, plan: PlannerOutput): number {
  const stepScore = Math.min(plan.steps.length / 10, 1);
  const fileScore = Math.min(plan.files_to_read.length / 5, 1);
  const lengthScore = Math.min(idea.length / 100, 1);
  return (stepScore * 0.5 + fileScore * 0.3 + lengthScore * 0.2);
}
