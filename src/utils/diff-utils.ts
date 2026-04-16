/**
 * Diff Utilities
 *
 * Helpers for producing and inspecting unified diffs that are:
 *  26. Git-friendly minimal diffs (no spurious whitespace or context bloat)
 *  11. Immutable result types
 *
 * DELTA TYPE: EXTEND (new module – complements upstream tools/patch.ts)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HunkHeader {
  readonly origStart: number;
  readonly origCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly heading: string;
}

export interface DiffHunk {
  readonly header: HunkHeader;
  readonly lines: readonly string[];
}

export interface ParsedDiff {
  readonly fromFile: string;
  readonly toFile: string;
  readonly hunks: readonly DiffHunk[];
}

// ---------------------------------------------------------------------------
// 26 – Git-friendly minimal diff generation
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;

/**
 * Parse a unified-diff string into a structured `ParsedDiff`.
 * Returns `undefined` if the string is not a valid unified diff.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff | undefined {
  const lines = diff.split('\n');
  let fromFile = '';
  let toFile = '';
  const hunks: DiffHunk[] = [];
  let currentHunk: { header: HunkHeader; lines: string[] } | undefined;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      fromFile = line.slice(4).trim();
    } else if (line.startsWith('+++ ')) {
      toFile = line.slice(4).trim();
    } else {
      const m = HUNK_HEADER_RE.exec(line);
      if (m) {
        if (currentHunk) {
          hunks.push({ header: currentHunk.header, lines: currentHunk.lines });
        }
        currentHunk = {
          header: {
            origStart: parseInt(m[1], 10),
            origCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
            newStart: parseInt(m[3], 10),
            newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
            heading: m[5] ?? ''
          },
          lines: []
        };
      } else if (currentHunk) {
        currentHunk.lines.push(line);
      }
    }
  }

  if (currentHunk) {
    hunks.push({ header: currentHunk.header, lines: currentHunk.lines });
  }

  if (!fromFile && !toFile && hunks.length === 0) {
    return undefined;
  }
  return { fromFile, toFile, hunks };
}

/**
 * Render a `ParsedDiff` back to a unified-diff string.
 * Strips trailing whitespace from context/added lines (technique 26).
 */
export function renderUnifiedDiff(parsed: ParsedDiff): string {
  const out: string[] = [];
  out.push(`--- ${parsed.fromFile}`);
  out.push(`+++ ${parsed.toFile}`);
  for (const hunk of parsed.hunks) {
    const { origStart, origCount, newStart, newCount, heading } = hunk.header;
    out.push(`@@ -${origStart},${origCount} +${newStart},${newCount} @@${heading}`);
    for (const line of hunk.lines) {
      out.push(line.trimEnd());
    }
  }
  return out.join('\n');
}

/**
 * Return a minimal unified diff between `original` and `updated` using a
 * simple line-level LCS approach. Produces only changed hunks with 3 lines
 * of context (git default). (technique 26 – git-friendly minimal diffs)
 */
export function minimalDiff(
  filePath: string,
  original: string,
  updated: string
): string {
  if (original === updated) {
    return '';
  }

  const origLines = original.split('\n');
  const newLines = updated.split('\n');
  const hunks = computeHunks(origLines, newLines, 3);

  if (hunks.length === 0) {
    return '';
  }

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of hunks) {
    out.push(hunk);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Internal LCS / hunk builder
// ---------------------------------------------------------------------------

/** Compute edit script and format as hunk strings with `contextLines` context. */
function computeHunks(
  origLines: string[],
  newLines: string[],
  contextLines: number
): string[] {
  // Build edit script: array of [type, line] where type is ' ' | '+' | '-'
  const edits = buildEdits(origLines, newLines);

  // Group into hunks based on proximity of changes
  const hunks: string[] = [];
  let i = 0;

  while (i < edits.length) {
    if (edits[i][0] === ' ') {
      i++;
      continue;
    }

    // Found a change; collect window with context
    const start = Math.max(0, i - contextLines);
    let end = i;
    while (end < edits.length) {
      if (edits[end][0] !== ' ') {
        end = Math.min(edits.length, end + contextLines + 1);
      } else {
        const nextChange = edits.slice(end).findIndex(e => e[0] !== ' ');
        if (nextChange === -1 || nextChange > contextLines) {
          break;
        }
        end += nextChange + 1;
      }
    }
    end = Math.min(edits.length, end + contextLines);

    const window = edits.slice(start, end);
    let origStart = 1, newStart = 1, origCount = 0, newCount = 0;

    // Count preceding context to derive line numbers
    let origLine = 1, newLine = 1;
    for (let j = 0; j < start; j++) {
      if (edits[j][0] !== '+') { origLine++; }
      if (edits[j][0] !== '-') { newLine++; }
    }
    origStart = origLine;
    newStart = newLine;

    const hunkLines: string[] = [];
    for (const [type, line] of window) {
      hunkLines.push(`${type}${line}`);
      if (type !== '+') { origCount++; }
      if (type !== '-') { newCount++; }
    }

    hunks.push(
      `@@ -${origStart},${origCount} +${newStart},${newCount} @@`,
      ...hunkLines
    );
    i = end;
  }

  return hunks;
}

type EditType = [' ' | '+' | '-', string];

/** Myers-inspired greedy diff – O(n*d) in practice. */
function buildEdits(a: string[], b: string[]): EditType[] {
  // Simple patience-like approach: LCS via DP
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const edits: EditType[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      edits.push([' ', a[i]]);
      i++; j++;
    } else if (j < n && (i >= m || dp[i + 1]?.[j] <= (dp[i]?.[j + 1] ?? 0))) {
      edits.push(['+', b[j]]);
      j++;
    } else {
      edits.push(['-', a[i]]);
      i++;
    }
  }
  return edits;
}
