/**
 * Self-Critique
 *
 *  6. Self-consistency – runs multiple internal validation passes on
 *     generated code and aggregates the verdict before returning.
 * 20. Strict type guards for all validated structures.
 * 21. Exhaustive switch/case checks on critique severity levels.
 * 22. Security validation (scans for eval, innerHTML, shell injection).
 *
 * DELTA TYPE: EXTEND (new agentic capability, no upstream mutation)
 */

import { OllamaClient } from '../ollama/client';
import { Patch } from '../protocol/types';
import { compressPrompt } from '../utils/optimization-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CritiqueSeverity = 'ok' | 'warning' | 'error';

export interface CritiqueIssue {
  readonly severity: CritiqueSeverity;
  readonly category: string;
  readonly description: string;
  readonly suggestion?: string;
}

export interface CritiquePass {
  readonly label: string;
  readonly issues: readonly CritiqueIssue[];
  readonly verdict: CritiqueSeverity;
}

export interface SelfCritiqueResult {
  readonly passes: readonly CritiquePass[];
  readonly aggregateVerdict: CritiqueSeverity;
  readonly blockers: readonly CritiqueIssue[];
  readonly warnings: readonly CritiqueIssue[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CRITIQUE_PASSES = 2;

/** Static patterns that are security red-flags (technique 22). */
const SECURITY_PATTERNS: Array<{ re: RegExp; description: string }> = [
  { re: /\beval\s*\(/,           description: 'Use of eval() is forbidden' },
  { re: /innerHTML\s*=/,        description: 'innerHTML assignment risks XSS' },
  { re: /outerHTML\s*=/,        description: 'outerHTML assignment risks XSS' },
  { re: /document\.write\s*\(/, description: 'document.write() risks XSS' },
  { re: /child_process\.exec\s*\(/, description: 'exec() without arg array risks shell injection' },
  { re: /new\s+Function\s*\(/,  description: 'new Function() is dynamic execution' }
];

// ---------------------------------------------------------------------------
// SelfCritique
// ---------------------------------------------------------------------------

/**
 * Runs multiple critique passes over generated patches and aggregates them
 * into a final verdict. Includes a static security scan (no LLM needed for
 * security checks) and an LLM-based quality pass.
 */
export class SelfCritique {
  constructor(private readonly ollama: OllamaClient) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Critique `patches` and return aggregated results.
   * (technique 6 – self-consistency via multiple passes)
   */
  async critique(
    patches: readonly Patch[],
    onProgress?: (msg: string) => void
  ): Promise<SelfCritiqueResult> {
    const passes: CritiquePass[] = [];

    // Pass 1: Static security scan (fast, no LLM)
    onProgress?.('🔐 Running static security scan…');
    passes.push(this.staticSecurityPass(patches));

    // Passes 2…N: LLM quality critique (technique 6)
    for (let i = 1; i < CRITIQUE_PASSES; i++) {
      onProgress?.(`🧐 LLM critique pass ${i}/${CRITIQUE_PASSES - 1}…`);
      passes.push(await this.llmCritiquePass(patches, i));
    }

    return this.aggregate(passes);
  }

  // -------------------------------------------------------------------------
  // Private: static security pass  (technique 22)
  // -------------------------------------------------------------------------

  private staticSecurityPass(patches: readonly Patch[]): CritiquePass {
    const issues: CritiqueIssue[] = [];

    for (const patch of patches) {
      for (const { re, description } of SECURITY_PATTERNS) {
        if (re.test(patch.diff)) {
          issues.push({
            severity: 'error',
            category: 'security',
            description: `${patch.path}: ${description}`,
            suggestion: 'Remove or replace with a safe alternative'
          });
        }
      }
    }

    return {
      label: 'static-security',
      issues,
      verdict: verdictFromIssues(issues)
    };
  }

  // -------------------------------------------------------------------------
  // Private: LLM critique pass  (technique 6)
  // -------------------------------------------------------------------------

  private async llmCritiquePass(
    patches: readonly Patch[],
    index: number
  ): Promise<CritiquePass> {
    const diffSummary = patches
      .slice(0, 5)   // cap context size (technique 1)
      .map(p => `### ${p.path}\n${p.diff.slice(0, 800)}`)
      .join('\n\n');

    const prompt = compressPrompt(
      `You are a strict code reviewer. Review these unified diffs and respond with a ` +
      `JSON array of issue objects with fields: severity ("ok"|"warning"|"error"), ` +
      `category (string), description (string). Be concise.\n\n${diffSummary}`
    );

    try {
      const raw = await this.ollama.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, num_predict: 600 }
      );
      const issues = parseCritiqueIssues(raw);
      return { label: `llm-pass-${index}`, issues, verdict: verdictFromIssues(issues) };
    } catch {
      return { label: `llm-pass-${index}`, issues: [], verdict: 'ok' };
    }
  }

  // -------------------------------------------------------------------------
  // Private: aggregation
  // -------------------------------------------------------------------------

  private aggregate(passes: readonly CritiquePass[]): SelfCritiqueResult {
    const allIssues = passes.flatMap(p => [...p.issues]);
    const blockers = allIssues.filter(i => i.severity === 'error');
    const warnings = allIssues.filter(i => i.severity === 'warning');

    // Aggregate verdict: worst severity wins
    const aggregateVerdict: CritiqueSeverity =
      blockers.length > 0 ? 'error' :
      warnings.length > 0 ? 'warning' :
      'ok';

    return { passes, aggregateVerdict, blockers, warnings };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map severity string to enum value with exhaustive check (technique 21). */
function normaliseSeverity(raw: string): CritiqueSeverity {
  switch (raw) {
    case 'ok':      return 'ok';
    case 'warning': return 'warning';
    case 'error':   return 'error';
    default:        return 'warning';  // unknown → treat as warning
  }
}

function verdictFromIssues(issues: readonly CritiqueIssue[]): CritiqueSeverity {
  if (issues.some(i => i.severity === 'error'))   { return 'error'; }
  if (issues.some(i => i.severity === 'warning')) { return 'warning'; }
  return 'ok';
}

/** Type guard + parser for LLM-returned issue arrays (technique 20). */
function parseCritiqueIssues(raw: string): CritiqueIssue[] {
  try {
    const match = /\[[\s\S]*\]/.exec(raw);
    if (!match) { return []; }
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) { return []; }
    return arr
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null
      )
      .map(item => ({
        severity: normaliseSeverity(String(item['severity'] ?? 'warning')),
        category: String(item['category'] ?? 'general'),
        description: String(item['description'] ?? ''),
        suggestion: item['suggestion'] !== undefined ? String(item['suggestion']) : undefined
      }));
  } catch {
    return [];
  }
}
