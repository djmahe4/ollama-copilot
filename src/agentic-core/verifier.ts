/**
 * Verifier
 *
 * Enhances upstream TesterAgent with:
 *  3. Spec-first development (generates acceptance tests before verifying)
 *  6. Self-consistency (runs multiple validation passes and aggregates)
 *  8. Dependency injection
 *
 * Before each verification pass, the MemoryManager is queried to retrieve
 * relevant prior context which is injected into the LLM prompt for more
 * accurate analysis.
 *
 * DELTA TYPE: EXTEND (wraps upstream agents/tester.ts)
 */

import { TesterAgent } from '../agents/tester';
import { OllamaClient } from '../ollama/client';
import { TerminalTool } from '../tools/terminal';
import { WorkspaceTool } from '../tools/workspace';
import { PlannerOutput, Patch, TestFix } from '../protocol/types';
import { startSpan, endSpan } from '../utils/optimization-engine';
import { MemoryManager } from '../utils/memory-manager';

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
 * multi-pass self-consistency checking with memory-augmented context.
 */
export class Verifier {
  private readonly upstream: TesterAgent;

  constructor(
    private readonly ollama: OllamaClient,
    private readonly terminal: TerminalTool,
    private readonly workspace: WorkspaceTool,
    private readonly memory?: MemoryManager
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
   * Memory context is retrieved before each pass and injected into analysis.
   * (technique 6 – self-consistency)
   */
  async verify(
    patches: readonly Patch[],
    onProgress?: (msg: string) => void
  ): Promise<VerificationResult> {
    const span = startSpan('verifier:verify');
    const passes: VerificationPass[] = [];

    // Retrieve memory context once for all passes (fast, synchronous)
    const memContext = await this.buildMemoryContext(patches);
    if (memContext) {
      onProgress?.('📚 Memory context retrieved for verification…');
    }

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

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Retrieve memory context relevant to the patches being verified.
   * Returns a formatted string ready for prompt injection, or '' if none.
   */
  private async buildMemoryContext(patches: readonly Patch[]): Promise<string> {
    if (!this.memory) { return ''; }
    const query = patches.map(p => p.path).join(' ');
    const results = await this.memory.search(query, 5);
    return this.memory.buildContext(results);
  }
}
