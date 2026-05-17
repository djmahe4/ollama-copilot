/**
 * Modular Splitter – Workspace-aware RAG + Code Splitting
 *
 *  7. Workspace-aware retrieval (RAG over local files with rg → grep/findstr
 *     → pure-Node.js fallback – works on Windows, macOS, and Linux)
 * 18. Automatic code splitting (split large files into logical modules)
 *
 * Cross-platform strategy (technique 7):
 *   1. ripgrep  (`rg`)         – preferred; available on all OSes if installed;
 *                                respects .gitignore by default
 *   2. macOS/Linux: `grep -rn` – POSIX, always present; gitignored dirs passed
 *                                as --exclude-dir flags
 *      Windows:    `findstr`   – built-in CMD utility; results filtered post-hoc
 *   3. Pure Node.js walk       – zero external dependencies; honours .gitignore
 *                                via a built-in pattern matcher
 *
 * Gitignore support:
 *   - Root .gitignore (and nested ones) are parsed and respected in all strategies.
 *   - Pass `{ ignoreGitignore: true }` to bypass for debugging purposes.
 *
 * DELTA TYPE: EXTEND (new module, no upstream mutation)
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { chunkByTokens, TextChunk } from './optimization-engine';
import { safeReadFile } from './safe-fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RagMatch {
  readonly file: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly score: number;
}

export interface RagResult {
  readonly query: string;
  readonly matches: readonly RagMatch[];
  /** Which search strategy succeeded. */
  readonly strategy: 'rg' | 'grep' | 'findstr' | 'node';
}

export interface SplitModule {
  readonly name: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Options for ragSearch. */
export interface RagSearchOptions {
  fileGlob?: string;
  /**
   * When true, completely bypass .gitignore rules.
   * Useful for debugging — allows scanning venv/, node_modules/, dist/, etc.
   * Default: false (gitignore rules are always applied).
   */
  ignoreGitignore?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MATCHES = 40;
/** Extensions searched by the pure-Node fallback walker. */
const NODE_FALLBACK_EXTS = new Set(['.ts', '.js', '.py', '.java', '.go', '.rs', '.md', '.txt']);
/** Maximum files the Node walker will open (guards against huge repos). */
const NODE_WALKER_LIMIT = 2_000;

/** Hard-coded noise directories always excluded (even without a .gitignore). */
const ALWAYS_EXCLUDED = new Set([
  'node_modules', '.git', 'out', 'dist', '.vscode',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  'venv', '.venv', 'env', '.env',
  'target',           // Rust / Maven
  'build', 'bin', 'obj',  // C# / Java / generic build dirs
  '.gradle', '.idea', '.vs',
  'coverage', '.nyc_output'
]);

// ---------------------------------------------------------------------------
// Gitignore parser
// ---------------------------------------------------------------------------

export interface GitignoreRules {
  /** Raw patterns from all .gitignore files found under workspaceRoot. */
  readonly patterns: readonly string[];
  /** Compiled matchers for fast per-entry decisions. */
  readonly compiled: readonly GitignorePattern[];
}

interface GitignorePattern {
  readonly original: string;
  readonly regex: RegExp;
  readonly dirOnly: boolean;   // pattern ends with '/'
}

/**
 * Read and parse all .gitignore files found directly under `workspaceRoot`
 * (root `.gitignore` + one level of sub-directory `.gitignore` files).
 *
 * Negation patterns (`!`) are intentionally skipped for simplicity.
 * Returns an empty rule set when no .gitignore is found.
 */
export async function loadGitignoreRules(workspaceRoot: string): Promise<GitignoreRules> {
  const rawPatterns: string[] = [];

  const collectFrom = async (filePath: string, prefix: string): Promise<void> => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) { continue; }
        // Prefix sub-directory patterns so they match from the repo root
        rawPatterns.push(prefix ? `${prefix}/${line}` : line);
      }
    } catch { /* file not found or unreadable – skip */ }
  };

  // Root .gitignore
  await collectFrom(path.join(workspaceRoot, '.gitignore'), '');

  // Nested .gitignore files one level deep
export async function loadGitignoreRules(workspaceRoot: string): Promise<GitignoreRules> {
  const rawPatterns: string[] = [];

  const collectFrom = async (filePath: string, prefix: string): Promise<void> => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) { continue; }
        rawPatterns.push(prefix ? `${prefix}/${line}` : line);
      }
    } catch { /* file not found or unreadable – skip */ }
  };

  await collectFrom(path.join(workspaceRoot, '.gitignore'), '');

  try {
    const entries = await fs.promises.readdir(workspaceRoot);
    for (const entry of entries) {
      if (ALWAYS_EXCLUDED.has(entry)) { continue; }
      const sub = path.join(workspaceRoot, entry);
      try {
        const stat = await fs.promises.stat(sub);
        if (stat.isDirectory()) {
          await collectFrom(path.join(sub, '.gitignore'), entry);
        }
      } catch { /* stat failed – skip */ }
    }
  } catch { /* readdir failed – skip */ }

  const compiled = rawPatterns.map(p => compilePattern(p));
  return { patterns: rawPatterns, compiled };
}
    const entries = await fs.promises.readdir(workspaceRoot);
    for (const entry of entries) {
      if (ALWAYS_EXCLUDED.has(entry)) { continue; }
      const sub = path.join(workspaceRoot, entry);
      try {
        const stat = await fs.promises.stat(sub);
        if (stat.isDirectory()) {
          await collectFrom(path.join(sub, '.gitignore'), entry);
        }
      } catch { /* stat failed – skip */ }
    }
  } catch { /* readdirSync failed – skip */ }

  const compiled = rawPatterns.map(p => compilePattern(p));
  return { patterns: rawPatterns, compiled };
}

/** Convert a single gitignore glob pattern to a RegExp. */
function compilePattern(pattern: string): GitignorePattern {
  const dirOnly = pattern.endsWith('/');
  const stripped = dirOnly ? pattern.slice(0, -1) : pattern;

  // Escape regex metacharacters except * and ?
  let regexStr = stripped
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')   // placeholder for **
    .replace(/\*/g,   '[^/]*')    // * = anything except separator
    .replace(/\?/g,   '[^/]')     // ? = single non-separator char
    .replace(/\u0001/g, '.*');    // ** = anything including separators

  // Pattern with no slash is matched against the basename only
  const anchored = stripped.includes('/') ? `^${regexStr}` : `(^|/)${regexStr}`;
  const regex = new RegExp(`${anchored}($|/)`, 'i');   // case-insensitive for Windows

  return { original: pattern, regex, dirOnly };
}

/**
 * Return true if `relativePath` (using forward slashes) should be excluded
 * according to `rules`.
 */
export function isIgnored(
  relativePath: string,
  rules: GitignoreRules,
  isDirectory: boolean
): boolean {
  // Normalise to forward slashes for consistent matching on all platforms
  const normalised = relativePath.replace(/\\/g, '/');

  for (const pat of rules.compiled) {
    if (pat.dirOnly && !isDirectory) { continue; }
    if (pat.regex.test(normalised)) { return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 7 – Workspace-aware retrieval  (cross-platform RAG)
// ---------------------------------------------------------------------------

/**
 * Search `workspaceRoot` for `query`.
 *
 * Tries strategies in order until one succeeds:
 *  rg  →  grep (macOS/Linux) or findstr (Windows)  →  pure Node.js walk
 *
 * Never throws – always resolves.
 *
 * @param options.ignoreGitignore  Set `true` to scan everything including
 *   venv/, node_modules/, dist/, etc. Useful for debugging.
 */
export async function ragSearch(
  workspaceRoot: string,
  query: string,
  options: RagSearchOptions = {}
): Promise<RagResult> {
  const sanitised = sanitiseQuery(query);
  if (!sanitised) {
    return { query, matches: [], strategy: 'node' };
  }

  const skipGitignore = options.ignoreGitignore === true;
  const rules = skipGitignore ? { patterns: [], compiled: [] } : await loadGitignoreRules(workspaceRoot);

  // 1. ripgrep – honours .gitignore automatically unless overridden
  const rgResult = await tryRipgrep(workspaceRoot, sanitised, skipGitignore);
  if (rgResult !== null) {
    return { query, matches: rgResult, strategy: 'rg' };
  }

  // 2a. Windows: findstr
  if (process.platform === 'win32') {
    const findstrResult = await tryFindstr(workspaceRoot, sanitised, rules, skipGitignore);
    if (findstrResult !== null) {
      return { query, matches: findstrResult, strategy: 'findstr' };
    }
  } else {
    // 2b. macOS / Linux: grep
    const grepResult = await tryGrep(workspaceRoot, sanitised, rules, skipGitignore);
    if (grepResult !== null) {
      return { query, matches: grepResult, strategy: 'grep' };
    }
  }

  // 3. Pure Node.js fallback
  const nodeResult = nodeSearch(workspaceRoot, sanitised, MAX_MATCHES, rules, skipGitignore);
  return { query, matches: nodeResult, strategy: 'node' };
}

/**
 * Read a file and split it into chunks that fit within `maxTokens`.
 */
export async function chunkFile(
  workspaceRoot: string,
  relativePath: string,
  maxTokens: number = 2_000
): Promise<TextChunk[]> {
  const result = await safeReadFile(workspaceRoot, relativePath);
  if (!result.success || !result.data) {
    return [];
  }
  return chunkByTokens(result.data, maxTokens);
}

// ---------------------------------------------------------------------------
// 18 – Automatic code splitting
// ---------------------------------------------------------------------------

/**
 * Split `sourceCode` into logical `SplitModule`s by detecting top-level
 * TypeScript / JavaScript export declarations as natural split points.
 */
export function splitIntoModules(sourceCode: string): SplitModule[] {
  // Normalise line endings for cross-platform compatibility
  const lines = sourceCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const modules: SplitModule[] = [];
  let currentName = '_module';
  let currentStart = 0;
  let buffer: string[] = [];

  const flush = (endLine: number): void => {
    if (buffer.length > 0) {
      modules.push({
        name: currentName,
        content: buffer.join('\n'),
        startLine: currentStart,
        endLine
      });
    }
  };

  const EXPORT_RE =
    /^export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|interface|type|enum)\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const m = EXPORT_RE.exec(lines[i]);
    if (m && buffer.length > 0) {
      flush(i - 1);
      currentName = m[1];
      currentStart = i;
      buffer = [lines[i]];
    } else {
      buffer.push(lines[i]);
    }
  }
  flush(lines.length - 1);
  return modules;
}

// ---------------------------------------------------------------------------
// Private: ripgrep (strategy 1)
// ---------------------------------------------------------------------------

function tryRipgrep(
  cwd: string,
  pattern: string,
  ignoreGitignore: boolean
): Promise<RagMatch[] | null> {
  return new Promise(resolve => {
    const args = [
      '--json',
      '--max-count', String(MAX_MATCHES),
      '--type-add', 'code:*.{ts,js,py,java,go,rs,md}',
      '--type', 'code',
    ];

    if (ignoreGitignore) {
      // Debug override: scan everything including gitignored paths
      args.push('--no-ignore', '--hidden');
    }
    // Default: rg respects .gitignore automatically – no flag needed

    args.push('--', pattern);

    const child = cp.spawn('rg', args, { cwd, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code: number | null) => {
      if (code === null || (code !== 0 && code !== 1)) { resolve(null); return; }
      resolve(parseRgJson(stdout));
    });
  });
}

function parseRgJson(raw: string): RagMatch[] {
  const matches: RagMatch[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) { continue; }
    try {
      const obj = JSON.parse(line) as {
        type: string;
        data: {
          path?: { text: string };
          line_number?: number;
          lines?: { text: string };
          submatches?: unknown[];
        };
      };
      if (obj.type === 'match') {
        matches.push({
          file: path.normalize(obj.data.path?.text ?? ''),
          lineNumber: obj.data.line_number ?? 0,
          line: (obj.data.lines?.text ?? '').trimEnd(),
          score: obj.data.submatches?.length ?? 1
        });
      }
    } catch { /* skip malformed lines */ }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Private: grep (strategy 2b – macOS / Linux)
// ---------------------------------------------------------------------------

function tryGrep(
  cwd: string,
  pattern: string,
  rules: GitignoreRules,
  ignoreGitignore: boolean
): Promise<RagMatch[] | null> {
  return new Promise(resolve => {
    const args = ['-rn', '-I',
      '--include=*.ts', '--include=*.js', '--include=*.py',
      '--include=*.java', '--include=*.go', '--include=*.rs', '--include=*.md',
      '-m', String(MAX_MATCHES)
    ];

    if (!ignoreGitignore) {
      // Add --exclude-dir for each gitignored/always-excluded directory name
      const excluded = buildExcludedDirNames(rules);
      for (const dir of excluded) {
        args.push(`--exclude-dir=${dir}`);
      }
    }

    args.push('--', pattern, '.');

    const child = cp.spawn('grep', args, { cwd, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code: number | null) => {
      if (code === null || code > 1) { resolve(null); return; }
      resolve(parseGrepOutput(stdout, cwd));
    });
  });
}

// ---------------------------------------------------------------------------
// Private: findstr (strategy 2a – Windows)
// ---------------------------------------------------------------------------

function tryFindstr(
  cwd: string,
  pattern: string,
  rules: GitignoreRules,
  ignoreGitignore: boolean
): Promise<RagMatch[] | null> {
  return new Promise(resolve => {
    const args = ['/S', '/N', '/I', pattern, '*.ts', '*.js', '*.py', '*.md'];
    const child = cp.spawn('findstr', args, { cwd, windowsHide: true, shell: false });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code: number | null) => {
      if (code === null || code > 1) { resolve(null); return; }
      let matches = parseFindstrOutput(stdout, cwd);
      if (!ignoreGitignore) {
        const excluded = buildExcludedDirNames(rules);
        matches = matches.filter(m => !pathContainsExcluded(m.file, excluded));
      }
      resolve(matches);
    });
  });
}

function parseFindstrOutput(raw: string, cwd: string): RagMatch[] {
  const matches: RagMatch[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m && matches.length < MAX_MATCHES) {
      matches.push({
        file: path.relative(cwd, path.resolve(cwd, m[1])),
        lineNumber: parseInt(m[2], 10),
        line: m[3],
        score: 1
      });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Private: pure Node.js walker (strategy 3)
// ---------------------------------------------------------------------------

function nodeSearch(
  root: string,
  pattern: string,
  limit: number,
  rules: GitignoreRules,
  ignoreGitignore: boolean
): RagMatch[] {
  const matches: RagMatch[] = [];
  const lowerPattern = pattern.toLowerCase();
  let filesScanned = 0;

  const walk = (dir: string): void => {
    if (matches.length >= limit || filesScanned >= NODE_WALKER_LIMIT) { return; }
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      if (matches.length >= limit || filesScanned >= NODE_WALKER_LIMIT) { break; }

      const full     = path.join(dir, entry);
      const relative = path.relative(root, full);

      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }

      if (stat.isDirectory()) {
        if (!ignoreGitignore) {
          // Skip always-excluded dirs
          if (ALWAYS_EXCLUDED.has(entry)) { continue; }
          // Skip gitignored dirs
          if (isIgnored(relative, rules, true)) { continue; }
        }
        walk(full);
      } else if (NODE_FALLBACK_EXTS.has(path.extname(entry).toLowerCase())) {
        if (!ignoreGitignore && isIgnored(relative, rules, false)) { continue; }
        filesScanned++;
        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
          for (let i = 0; i < lines.length && matches.length < limit; i++) {
            if (lines[i].toLowerCase().includes(lowerPattern)) {
              matches.push({
                file: relative,
                lineNumber: i + 1,
                line: lines[i],
                score: 1
              });
            }
          }
        } catch { /* unreadable – skip */ }
      }
    }
  };

  walk(root);
  return matches;
}

// ---------------------------------------------------------------------------
// Private: grep output parser
// ---------------------------------------------------------------------------

function parseGrepOutput(raw: string, cwd: string): RagMatch[] {
  const matches: RagMatch[] = [];
  for (const line of raw.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m && matches.length < MAX_MATCHES) {
      matches.push({
        file: path.relative(cwd, path.resolve(cwd, m[1])),
        lineNumber: parseInt(m[2], 10),
        line: m[3],
        score: 1
      });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Private: helper utilities
// ---------------------------------------------------------------------------

/**
 * Build a de-duplicated set of directory names to exclude.
 * Combines ALWAYS_EXCLUDED with names extracted from gitignore patterns.
 */
function buildExcludedDirNames(rules: GitignoreRules): Set<string> {
  const set = new Set(ALWAYS_EXCLUDED);
  for (const pat of rules.patterns) {
    // Extract simple basename patterns (no slashes, no wildcards in the name itself)
    const stripped = pat.replace(/\/$/, '');
    if (!stripped.includes('/') && !stripped.includes('*') && !stripped.includes('?')) {
      set.add(stripped);
    }
  }
  return set;
}

/** Return true if `filePath` contains any of the excluded directory names as a segment. */
function pathContainsExcluded(filePath: string, excluded: Set<string>): boolean {
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.some(seg => excluded.has(seg));
}

/** Strip shell metacharacters to prevent injection (technique 22). */
function sanitiseQuery(query: string): string {
  return query.replace(/[\`$;&|!\']/g, '').trim().slice(0, 200);
}
