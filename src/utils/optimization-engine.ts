/**
 * Optimization Engine
 *
 * Centralises cross-cutting optimization concerns used throughout the extension:
 *   1.  Context-window-aware chunking
 *   2.  Prompt compression (chain-of-density)
 *   9.  Performance instrumentation hooks
 *  29.  Auto documentation generation stubs
 *  30.  Dead code elimination awareness (export surface tracking)
 *
 * DELTA TYPE: EXTEND (new module, no upstream mutation)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single chunk produced by context-window splitting. */
export interface TextChunk {
  readonly index: number;
  readonly content: string;
  /** Estimated token count using heuristic (chars / 4). */
  readonly estimatedTokens: number;
}

/** Performance span recorded during an instrumented operation. */
export interface PerfSpan {
  readonly label: string;
  readonly startMs: number;
  endMs?: number;
  durationMs?: number;
}

/** Result of the auto-documentation stub. */
export interface DocStub {
  readonly symbol: string;
  readonly signature: string;
  readonly docComment: string;
}

// ---------------------------------------------------------------------------
// 1 + 2 – Context-window chunking & prompt compression
// ---------------------------------------------------------------------------

/** Heuristic: ~4 characters per token (good enough for chunking decisions). */
const CHARS_PER_TOKEN = 4;

/**
 * Split `text` into chunks that each fit within `maxTokens`.
 * Prefers splitting on paragraph / newline boundaries to keep semantic units
 * intact (technique 1 – context-window-aware chunking).
 */
export function chunkByTokens(text: string, maxTokens: number): TextChunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const paragraphs = text.split(/\n{2,}/);
  const chunks: TextChunk[] = [];
  let buffer = '';
  let index = 0;

  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }
    chunks.push({
      index,
      content: buffer.trimEnd(),
      estimatedTokens: Math.ceil(buffer.length / CHARS_PER_TOKEN)
    });
    index++;
    buffer = '';
  };

  for (const para of paragraphs) {
    const candidate = buffer.length === 0 ? para : `${buffer}\n\n${para}`;
    if (candidate.length > maxChars) {
      flush();
      // Para itself might exceed limit – hard-split by line
      const lines = para.split('\n');
      for (const line of lines) {
        const withLine = buffer.length === 0 ? line : `${buffer}\n${line}`;
        if (withLine.length > maxChars) {
          flush();
          buffer = line;
        } else {
          buffer = withLine;
        }
      }
    } else {
      buffer = candidate;
    }
  }
  flush();
  return chunks;
}

/**
 * Compress a prompt using a minimal chain-of-density pass.
 * Removes redundant whitespace, collapses repeated words, and trims
 * boilerplate filler phrases (technique 2 – prompt compression).
 *
 * NOTE: This is a lightweight heuristic pass – not a model call.
 */
export function compressPrompt(prompt: string): string {
  return prompt
    .replace(/[ \t]+/g, ' ')           // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')         // collapse excess blank lines
    .replace(/\b(please|kindly|feel free to)\b/gi, '')  // remove filler
    .replace(/ {2,}/g, ' ')             // final space normalisation
    .trim();
}

// ---------------------------------------------------------------------------
// 9 – Performance instrumentation hooks
// ---------------------------------------------------------------------------

/** Active spans keyed by label. */
const activeSpans = new Map<string, PerfSpan>();

/**
 * Start a named performance span.
 * Call `endSpan(label)` to finish it and receive the duration.
 */
export function startSpan(label: string): PerfSpan {
  const span: PerfSpan = { label, startMs: Date.now() };
  activeSpans.set(label, span);
  return span;
}

/**
 * End a named performance span and return it with duration filled in.
 * Returns `undefined` if no matching span was started.
 */
export function endSpan(label: string): PerfSpan | undefined {
  const span = activeSpans.get(label);
  if (!span) {
    return undefined;
  }
  const ended: PerfSpan = {
    ...span,
    endMs: Date.now(),
    durationMs: Date.now() - span.startMs
  };
  activeSpans.delete(label);
  return ended;
}

// ---------------------------------------------------------------------------
// 29 – Auto documentation generation
// ---------------------------------------------------------------------------

/** Simple regex patterns for TypeScript symbol detection. */
const FN_PATTERN = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/m;
const CLASS_PATTERN = /^export\s+class\s+(\w+)/m;
const INTERFACE_PATTERN = /^export\s+interface\s+(\w+)/m;

/**
 * Generate a minimal JSDoc stub for the first exported symbol found in
 * `sourceText`. Returns `undefined` if no symbol is detected.
 * (technique 29 – auto documentation generation)
 */
export function generateDocStub(sourceText: string): DocStub | undefined {
  const fnMatch = FN_PATTERN.exec(sourceText);
  if (fnMatch) {
    const [, name, params] = fnMatch;
    const paramLines = params
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => ` * @param ${p.split(':')[0].trim()} -`);
    const docComment = ['/**', ...paramLines, ' * @returns', ' */'].join('\n');
    return { symbol: name, signature: fnMatch[0], docComment };
  }

  const classMatch = CLASS_PATTERN.exec(sourceText);
  if (classMatch) {
    return {
      symbol: classMatch[1],
      signature: classMatch[0],
      docComment: `/** ${classMatch[1]} */`
    };
  }

  const ifaceMatch = INTERFACE_PATTERN.exec(sourceText);
  if (ifaceMatch) {
    return {
      symbol: ifaceMatch[1],
      signature: ifaceMatch[0],
      docComment: `/** ${ifaceMatch[1]} */`
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 30 – Dead code elimination awareness
// ---------------------------------------------------------------------------

/** Registry of exported symbol names – helps surfaces unused exports. */
const exportRegistry = new Set<string>();

/** Register an exported symbol so dead-code analysis tooling can track it. */
export function registerExport(name: string): void {
  exportRegistry.add(name);
}

/** Return all currently registered export names. */
export function getRegisteredExports(): ReadonlySet<string> {
  return exportRegistry;
}
