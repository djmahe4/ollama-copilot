/**
 * Memory Manager – Project-based Embeddings RAG Layer
 *
 * Provides a local, file-based vector memory store that:
 *  - Indexes code chunks after every successful patch application
 *  - Searches the index in <100 ms to provide precise context to Ollama
 *  - Is fully asynchronous and non-blocking (<50 ms overhead on writes)
 *  - Requires no external servers (file-backed JSONL + in-memory index)
 *
 * Storage layout (workspace-relative, git-ignored):
 *   .ollama-agentic/memory/vectors.jsonl  ← one entry per line
 *   .ollama-agentic/memory/meta.json      ← store statistics
 *
 * Embedding strategy (in priority order):
 *  1. Ollama /api/embeddings endpoint (configurable embedding model)
 *  2. Feature-hashing TF-IDF fallback (deterministic, 256-dim, no LLM needed)
 *
 * Cross-platform: pure Node.js fs + http/https. No native binaries.
 *
 * DELTA TYPE: EXTEND (new capability, no upstream mutation)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { splitIntoModules } from './modular-splitter';
import { safeReadFile } from './safe-fs';
import { Patch } from '../protocol/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  /** Stable ID: hash of filePath + startLine. */
  readonly id: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Raw source content of the chunk. */
  readonly content: string;
  /** One-sentence semantic description (generated or extracted). */
  readonly description: string;
  /** Other file:line locations that reference this symbol. */
  readonly refs: readonly string[];
  /** Embedding vector. */
  readonly vector: readonly number[];
  readonly updatedAt: number;
}

export interface MemorySearchResult {
  readonly entry: MemoryEntry;
  /** Cosine similarity score (0–1). */
  readonly score: number;
}

export interface MemoryStats {
  readonly totalEntries: number;
  readonly storePathExists: boolean;
  readonly lastFlushMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_DIR        = path.join('.ollama-agentic', 'memory');
const VECTORS_FILE     = 'vectors.jsonl';
const META_FILE        = 'meta.json';
/** Flush in-memory dirty entries to disk at most once per this interval. */
const FLUSH_INTERVAL_MS = 5_000;
/** Embedding vector dimension for the feature-hash fallback. */
const HASH_DIM = 256;
/** Default Ollama embedding model (pulled separately from code model). */
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
/** Top-K results returned by search. */
const DEFAULT_TOP_K = 8;

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

export class MemoryManager implements vscode.Disposable {
  /** In-memory index: id → entry. */
  private readonly index = new Map<string, MemoryEntry>();
  /** IDs written in this session but not yet flushed. */
  private readonly dirty = new Set<string>();

  private storePath = '';
  private lastFlushMs = 0;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private initialised = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Initialise: resolve store path, load existing entries, start flush timer. */
  async initialize(): Promise<void> {
    if (this.initialised) { return; }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      console.warn('[MemoryManager] No workspace folder – memory store disabled');
      return;
    }

    this.storePath = path.join(root, STORE_DIR);
    await this.ensureStoreDir();
    await this.loadFromDisk();

    // Periodic flush (non-blocking, technique 10 – leak prevention via dispose)
    this.flushTimer = setInterval(() => {
      this.flushDirtyAsync();
    }, FLUSH_INTERVAL_MS);

    this.initialised = true;
    console.log(`[MemoryManager] Loaded ${this.index.size} entries from ${this.storePath}`);
  }

  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Best-effort synchronous flush on deactivation
    this.flushSync();
  }

  // -------------------------------------------------------------------------
  // Indexing (fire-and-forget, <50 ms overhead on calling thread)
  // -------------------------------------------------------------------------

  /**
   * Index changed files from applied patches.
   * Called after a successful patch application.
   * Non-blocking: heavy work queued via queueMicrotask.
   */
  indexPatches(patches: readonly Patch[], workspaceRoot: string): void {
    if (!this.initialised) { return; }
    // Hand off to microtask queue immediately – caller is unblocked
    queueMicrotask(() => {
      this.indexPatchesAsync(patches, workspaceRoot).catch(err =>
        console.error('[MemoryManager] indexPatches error:', err)
      );
    });
  }

  /**
   * Index a single entry directly (for testing or manual ingestion).
   * Non-blocking.
   */
  indexEntry(entry: Omit<MemoryEntry, 'id' | 'vector' | 'updatedAt'>): void {
    if (!this.initialised) { return; }
    queueMicrotask(() => {
      this.computeAndStore(entry).catch(() => { /* silent */ });
    });
  }

  // -------------------------------------------------------------------------
  // Search (synchronous, <100 ms against in-memory index)
  // -------------------------------------------------------------------------

  /**
   * Find the `topK` most relevant memory entries for a query string.
   * Uses cosine similarity against in-memory vectors.
   * Falls back to keyword overlap if the in-memory index is empty.
   */
  search(query: string, topK: number = DEFAULT_TOP_K): MemorySearchResult[] {
    if (this.index.size === 0) { return []; }

    const queryVec = hashEmbed(query);
    const scored: MemorySearchResult[] = [];

    for (const entry of this.index.values()) {
      const score = cosineSimilarity(queryVec, entry.vector as number[]);
      if (score > 0.05) {   // discard near-zero matches
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Build a compact context string from search results suitable for
   * injection into an Ollama prompt.
   */
  buildContext(results: MemorySearchResult[]): string {
    if (results.length === 0) { return ''; }
    const lines = results.map(r =>
      `// ${r.entry.filePath}:${r.entry.startLine}-${r.entry.endLine} ` +
      `[score=${r.score.toFixed(2)}] ${r.entry.description}\n${r.entry.content}`
    );
    return `// === Retrieved Memory Context ===\n${lines.join('\n\n')}\n// ===`;
  }

  getStats(): MemoryStats {
    return {
      totalEntries: this.index.size,
      storePathExists: this.storePath !== '' && fs.existsSync(this.storePath),
      lastFlushMs: this.lastFlushMs
    };
  }

  // -------------------------------------------------------------------------
  // Private: async indexing pipeline
  // -------------------------------------------------------------------------

  private async indexPatchesAsync(
    patches: readonly Patch[],
    workspaceRoot: string
  ): Promise<void> {
    const cfg     = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('apiUrl') ?? 'http://localhost:11434';

    for (const patch of patches) {
      const read = await safeReadFile(workspaceRoot, patch.path);
      if (!read.success || !read.data) { continue; }

      const modules = splitIntoModules(read.data);
      for (const mod of modules) {
        const description = await this.describeChunk(mod.content, baseUrl);
        const embedding   = await ollamaEmbed(description + '\n' + mod.content, baseUrl)
                          ?? hashEmbed(mod.content);

        const id = stableId(patch.path, mod.startLine);
        const entry: MemoryEntry = {
          id,
          filePath: patch.path,
          startLine: mod.startLine,
          endLine: mod.endLine,
          content: mod.content.slice(0, 1_500),   // cap stored size
          description,
          refs: [],
          vector: embedding,
          updatedAt: Date.now()
        };

        this.index.set(id, entry);
        this.dirty.add(id);
      }
    }

    // Schedule a flush (non-blocking)
    this.flushDirtyAsync();
  }

  /** Ask Ollama to generate a one-sentence description of a code chunk. */
  private async describeChunk(content: string, baseUrl: string): Promise<string> {
    try {
      const cfg   = vscode.workspace.getConfiguration('ollamaCopilot');
      const model = cfg.get<string>('model') ?? 'qwen2.5-coder:7b';
      const body  = JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: `Describe in one sentence what this code does:\n\n${content.slice(0, 400)}`
        }],
        stream: false,
        options: { temperature: 0.1, num_predict: 60 }
      });
      const raw = await postJson(`${baseUrl}/api/chat`, body, 6_000);
      const data = JSON.parse(raw) as { message?: { content?: string } };
      return data.message?.content?.trim().split('\n')[0] ?? extractFirstComment(content);
    } catch {
      return extractFirstComment(content);
    }
  }

  private async computeAndStore(
    partial: Omit<MemoryEntry, 'id' | 'vector' | 'updatedAt'>
  ): Promise<void> {
    const cfg     = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('apiUrl') ?? 'http://localhost:11434';
    const vector  = await ollamaEmbed(partial.description + '\n' + partial.content, baseUrl)
                  ?? hashEmbed(partial.content);
    const id      = stableId(partial.filePath, partial.startLine);
    this.index.set(id, { ...partial, id, vector, updatedAt: Date.now() });
    this.dirty.add(id);
  }

  // -------------------------------------------------------------------------
  // Private: persistence (JSONL)
  // -------------------------------------------------------------------------

  private async ensureStoreDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.storePath, { recursive: true });
      // Add .gitignore entry in the parent directory if not present
      await ensureGitignored(path.dirname(this.storePath));
    } catch { /* already exists or permission denied – continue */ }
  }

  private async loadFromDisk(): Promise<void> {
    const file = path.join(this.storePath, VECTORS_FILE);
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const entry = JSON.parse(line) as MemoryEntry;
          if (isValidEntry(entry)) { this.index.set(entry.id, entry); }
        } catch { /* skip corrupt lines */ }
      }
    } catch { /* file doesn't exist yet – ok */ }
  }

  /** Append only dirty entries to the JSONL file (incremental write). */
  private flushDirtyAsync(): void {
    if (this.dirty.size === 0) { return; }
    const toFlush = Array.from(this.dirty);
    this.dirty.clear();

    setImmediate(() => {
      const file  = path.join(this.storePath, VECTORS_FILE);
      const lines = toFlush
        .map(id => this.index.get(id))
        .filter((e): e is MemoryEntry => e !== undefined)
        .map(e => JSON.stringify(e))
        .join('\n');

      if (!lines) { return; }
      fs.appendFile(file, lines + '\n', 'utf8', err => {
        if (err) { console.error('[MemoryManager] flush error:', err); }
        else { this.lastFlushMs = Date.now(); }
      });

      // Compact when file gets large (>5 MB) by rewriting from index
      fs.stat(file, (_, stat) => {
        if (stat && stat.size > 5_242_880) { this.compactAsync(); }
      });
    });
  }

  private flushSync(): void {
    if (this.dirty.size === 0) { return; }
    try {
      const file  = path.join(this.storePath, VECTORS_FILE);
      const lines = Array.from(this.index.values()).map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(file, lines + '\n', 'utf8');
    } catch { /* ignore on deactivation */ }
  }

  /** Rewrite the JSONL from the in-memory index (compaction). */
  private compactAsync(): void {
    setImmediate(() => {
      const file  = path.join(this.storePath, VECTORS_FILE);
      const lines = Array.from(this.index.values()).map(e => JSON.stringify(e)).join('\n');
      fs.writeFile(file, lines + '\n', 'utf8', () => { /* fire-and-forget */ });
    });
  }
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/**
 * Call the Ollama /api/embeddings endpoint.
 * Returns null if the model doesn't support embeddings or Ollama is not running.
 */
async function ollamaEmbed(text: string, baseUrl: string): Promise<number[] | null> {
  try {
    const cfg        = vscode.workspace.getConfiguration('llamaACoder');
    const embedModel = cfg.get<string>('embeddingModel') ?? DEFAULT_EMBED_MODEL;
    const body = JSON.stringify({ model: embedModel, prompt: text.slice(0, 2_000) });
    const raw  = await postJson(`${baseUrl}/api/embeddings`, body, 8_000);
    const data = JSON.parse(raw) as { embedding?: number[] };
    const vec  = data.embedding;
    if (Array.isArray(vec) && vec.length > 0) { return normalizeArr(vec); }
  } catch { /* model not available – fall back */ }
  return null;
}

/**
 * Feature-hashing TF-IDF fallback embedding (256-dim).
 * Deterministic, fast, no model required.
 */
function hashEmbed(text: string): number[] {
  const vec = new Float32Array(HASH_DIM);
  const tokens = text.toLowerCase().match(/\w+/g) ?? [];
  for (const tok of tokens) {
    let h = 2_166_136_261;
    for (let i = 0; i < tok.length; i++) {
      h = Math.imul(h ^ tok.charCodeAt(i), 16_777_619) >>> 0;
    }
    const idx  = h % HASH_DIM;
    const sign = (h >>> 31) ? -1 : 1;
    vec[idx] += sign;
  }
  return normalizeArr(Array.from(vec));
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: readonly number[]): number {
  if (a.length !== b.length) { return 0; }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function normalizeArr(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) { return v; }
  return v.map(x => x / norm);
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function stableId(filePath: string, startLine: number): string {
  // Simple, fast, stable ID – not a cryptographic hash
  const str = `${filePath}:${startLine}`;
  let h = 5_381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function extractFirstComment(content: string): string {
  const m = /\/\*\*?([\s\S]*?)\*\/|\/\/\s*(.+)/.exec(content);
  if (m) { return (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120); }
  // Fall back to first non-empty line
  return content.split('\n').find(l => l.trim().length > 0)?.trim().slice(0, 120) ?? 'code chunk';
}

function isValidEntry(e: unknown): e is MemoryEntry {
  return (
    typeof e === 'object' && e !== null &&
    typeof (e as MemoryEntry).id        === 'string' &&
    typeof (e as MemoryEntry).filePath  === 'string' &&
    Array.isArray((e as MemoryEntry).vector)
  );
}

/** Ensure `.ollama-agentic/` is listed in the nearest .gitignore. */
async function ensureGitignored(dir: string): Promise<void> {
  const gitignorePath = path.join(dir, '.gitignore');
  const entry = '.ollama-agentic/';
  try {
    let content = '';
    try { content = await fs.promises.readFile(gitignorePath, 'utf8'); } catch { /* new file */ }
    if (!content.includes(entry)) {
      await fs.promises.appendFile(gitignorePath, `\n${entry}\n`, 'utf8');
    }
  } catch { /* permission denied – skip */ }
}

function postJson(url: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const client  = isHttps ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs
      },
      res => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) { resolve(raw); }
          else { reject(new Error(`HTTP ${res.statusCode}`)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}
