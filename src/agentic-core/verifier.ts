/**
 * Verifier
 *
 * Enhances upstream TesterAgent with:
 *  3. Spec-first development (generates acceptance tests before verifying)
 *  6. Self-consistency (runs multiple validation passes and aggregates)
 *  8. Dependency injection
 *
 * DELTA TYPE: EXTEND (wraps upstream agents/tester.ts)
 */

import { TesterAgent } from '../agents/tester';
import { OllamaClient } from '../ollama/client';
import { TerminalTool } from '../tools/terminal';
import { WorkspaceTool } from '../tools/workspace';
import { PlannerOutput, Patch, TestFix } from '../protocol/types';
import { startSpan, endSpan } from '../utils/optimization-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationPass {
  readonly label: string;
  readonly success: boolean;
  readonly output: string;
  readonly fix?: TestFix;
}

export interface VerificationResult {
  readonly passes: readonly VerificationPass[];
  readonly overallSuccess: boolean;
  readonly consensusFix?: TestFix;
  readonly durationMs: number;
}

export interface AcceptanceCriteria {
  readonly scenario: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

// ---------------------------------------------------------------------------
// Constants  (technique 6 – self-consistency)
// ---------------------------------------------------------------------------

/** Number of independent verification passes for self-consistency. */
const CONSISTENCY_PASSES = 2;

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/**
 * Wraps `TesterAgent` and adds spec-first criteria generation plus
 * multi-pass self-consistency checking.
 */
export class Verifier {
  private readonly upstream: TesterAgent;

  constructor(
    private readonly ollama: OllamaClient,
    private readonly terminal: TerminalTool,
    private readonly workspace: WorkspaceTool
  ) {
    this.upstream = new TesterAgent(ollama, terminal, workspace);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate acceptance criteria for a plan before any code is written.
   * (technique 3 – spec-first development)
   */
  async generateAcceptanceCriteria(
    plan: PlannerOutput
  ): Promise<AcceptanceCriteria[]> {
    const prompt =
      `You are a QA engineer. For the following feature, output a JSON array of ` +
      `acceptance criteria objects with fields: scenario, given, when, then.\n\n` +
      `Feature: ${plan.feature}\nSteps:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

    try {
      const raw = await this.ollama.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.2, num_predict: 800 }
      );
      const match = /\[[\s\S]*\]/.exec(raw);
      if (match) {
        return JSON.parse(match[0]) as AcceptanceCriteria[];
      }
    } catch {
      // Return empty list; spec-first is advisory
    }
    return [];
  }

  /**
   * Run CONSISTENCY_PASSES independent verification passes and aggregate.
   * (technique 6 – self-consistency)
   *
   * A result is considered "consistent" if at least half the passes agree.
   */
  async verify(
    patches: readonly Patch[],
    onProgress?: (msg: string) => void
  ): Promise<VerificationResult> {
    const span = startSpan('verifier:verify');
    const passes: VerificationPass[] = [];

    for (let i = 0; i < CONSISTENCY_PASSES; i++) {
      onProgress?.(`🔬 Verification pass ${i + 1}/${CONSISTENCY_PASSES}…`);
      try {
        const result = await this.upstream.runTestsAndAnalyze(onProgress);
        passes.push({
          label: `pass-${i + 1}`,
          success: result.success,
          output: result.output,
          fix: result.fix
        });
      } catch (err) {
        passes.push({
          label: `pass-${i + 1}`,
          success: false,
          output: String(err)
        });
      }
    }

    const successCount = passes.filter(p => p.success).length;
    const overallSuccess = successCount >= Math.ceil(CONSISTENCY_PASSES / 2);
    const elapsed = endSpan('verifier:verify');

    // If majority failed, pick the first fix available (technique 6)
    const consensusFix = overallSuccess
      ? undefined
      : passes.find(p => p.fix !== undefined)?.fix;

    return {
      passes,
      overallSuccess,
      consensusFix,
      durationMs: elapsed?.durationMs ?? 0
    };
  }
}
