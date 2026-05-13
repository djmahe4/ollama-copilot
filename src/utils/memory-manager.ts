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

type MemoryType = 'STM' | 'LTM';
type EntityType = 'file' | 'function' | 'class' | 'requirement' | 'decision' | 'test';

export interface MemoryEntry {
  readonly id: string;
  readonly type: MemoryType | 'capability';
  readonly filePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly description: string;
  readonly content: string;
  readonly vector: readonly number[];
  readonly relations: Array<{ type: string; targetId: string }>;
  readonly timestamp: number;
  readonly ttl?: number; // for STM
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

interface MemoryMap {
  [sourceId: string]: Array<{ relation: string; targetId: string }>;
}

interface IndexingRule {
  include: string[];
  exclude: string[];
  maxSizeKB: number;
}

interface VectorIndex {
  entries: Map<string, { vector: number[]; metadata: { uri: string; chunkIndex: number } }>;
  dimension: number;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_DIR        = path.join('.ollama-agentic', 'memory');
const LTM_FILE         = 'memory.json';
const VECTORS_FILE     = 'vectors.jsonl';
const FLUSH_INTERVAL_MS = 5_000;
const HASH_DIM         = 256;
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_TOP_K    = 8;

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

export class MemoryManager implements vscode.Disposable {
  /** In-memory cache of LTM and STM entries. */
  private index = new Map<string, MemoryEntry>();
  private stm = new Map<string, MemoryEntry>();
  private memoryMap: MemoryMap = {};
  private vectorIndex: VectorIndex | null = null;
  /** IDs written in this session but not yet flushed. */
  private readonly dirty = new Set<string>();

  private storePath = '';
  private lastFlushMs = 0;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private initialised = false;

  private indexingRules: IndexingRule = {
    include: ['**/*.ts', '**/*.js', '**/*.py', '**/*.md', '**/*.json', '**/*.yaml', '**/*.tsx', '**/*.jsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.min.js', '**/coverage/**'],
    maxSizeKB: 500,
  };

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialised) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      console.warn('[MemoryManager] No workspace folder – memory store disabled');
      return;
    }

    this.storePath = path.join(root, STORE_DIR);
    await this.ensureStoreDir();
    await this.loadState();
    await this.loadFromDisk();

    this.flushTimer = setInterval(() => {
      this.flushDirtyAsync();
    }, FLUSH_INTERVAL_MS);

    this.initialised = true;
    console.log(`[MemoryManager] Initialized with ${this.index.size} LTM entries`);
  }

  private async persistState(): Promise<void> {
    const state = {
      memoryMap: this.memoryMap,
      vectorIndex: this.vectorIndex,
    };
    await fs.promises.writeFile(path.join(this.storePath, LTM_FILE), JSON.stringify(state, null, 2), 'utf8');
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
  // Indexing Pipeline (Phase 1: Git-aware Flat Indexing)
  // -------------------------------------------------------------------------

  /**
   * Scans the workspace for relevant files based on rules and .gitignore.
   * @param debugMode If true, overrides .gitignore to scan all matching files.
   */
  async indexWorkspace(debugMode = false): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return [];
    }

    // 1. Get all files matching include patterns
    const files = await vscode.workspace.findFiles(
      this.indexingRules.include[0], 
      this.indexingRules.exclude.join(','),
      1000
    );

    const relativePaths = files.map(uri => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return root ? path.relative(root, uri.fsPath) : uri.fsPath;
    });
    
    if (debugMode) {
      return relativePaths;
    }

    // 2. Filter by .gitignore
    const ignorePatterns = await this.loadGitignorePatterns();
    return relativePaths.filter(p => !this.isIgnored(p, ignorePatterns));
  }

  /**
   * Fully index the workspace. 
   * This is the "Knowledge Compilation" step from the LLM Wiki paradigm.
   */
  async indexWorkspaceFull(debugMode = false): Promise<{ indexed: number; errors: number }> {
    const files = await this.indexWorkspace(debugMode);
    let indexedCount = 0;
    let errorCount = 0;

    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('apiUrl') ?? 'http://localhost:11434';

    for (const relativePath of files) {
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fullPath = path.join(root!, relativePath);
         const content = await fs.promises.readFile(fullPath, 'utf8');
        
        // Logical splitting (AST-lite)
        const modules = splitIntoModules(content);
        
        for (const mod of modules) {
          const vector = await this.computeVector(mod.content);
          const id = stableId(relativePath, mod.startLine);
          
            this.index.set(id, {
              id,
              type: 'LTM',
              filePath: relativePath,
              startLine: mod.startLine,
              endLine: mod.endLine,
              description: mod.name ?? 'code chunk',
              content: mod.content.slice(0, 1500),
              vector,
              relations: [],
              timestamp: Date.now()
            });

          this.dirty.add(id);
          indexedCount++;
        }
      } catch (err) {
        errorCount++;
      }
    }

    await this.persistState();
    return { indexed: indexedCount, errors: errorCount };
  }

  private async loadGitignorePatterns(): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return [];
    }
    
    try {
      const content = await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8');
      return content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    } catch {
      return [];
    }
  }

  private isIgnored(filePath: string, patterns: string[]): boolean {
    // Simple pattern match for .gitignore
    return patterns.some(p => {
      const normalizedP = p.startsWith('/') ? p.slice(1) : p;
      return filePath.startsWith(normalizedP) || filePath.includes(normalizedP);
    });
  }


  /**
   * Index a single entry directly (for testing or manual ingestion).
   * Non-blocking.
   */
  indexEntry(entry: Omit<MemoryEntry, 'id' | 'vector' | 'timestamp'>): void {
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
   * @returns A sorted list of results.
   */
  async search(query: string, topK: number = DEFAULT_TOP_K): Promise<MemorySearchResult[]> {
    if (this.index.size === 0) {
      return [];
    }

    const queryVec = await this.computeVector(query);
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
      `// ${r.entry.filePath ?? 'unknown'}:${r.entry.startLine ?? 0}-${r.entry.endLine ?? 0} ` +
      `[score=${r.score.toFixed(2)}] ${r.entry.description}\n${r.entry.content}`
    );
    return `// === Retrieved Memory Context ===\n${lines.join('\n\n')}\n// ===`;
  }

  /**
   * Analyzes the current index to discover implicit relations between chunks.
   * Uses a combination of name-matching and structural heuristics to build a knowledge graph.
   */
  async discoverRelations(): Promise<void> {
    const entries = Array.from(this.index.values());
    const nameToIdMap = new Map<string, string>();

    // First pass: map names to IDs for fast lookup
    for (const entry of entries) {
      if (entry.description) {
        nameToIdMap.set(entry.description.split(' ')[0].replace(/[^a-zA-Z0-9_]/g, ''), entry.id);
      }
    }

    for (const entry of entries) {
      const relations: Array<{ type: string; targetId: string }> = [];
      const content = entry.content;

      // 1. Detect Imports (File-level relations)
      const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importedPath = match[1];
        const target = entries.find(e => e.filePath?.includes(importedPath));
        if (target) {
          relations.push({ type: 'imports', targetId: target.id });
        }
      }

      // 2. Detect Calls/Mentions (Entity-level relations)
      for (const [name, id] of nameToIdMap.entries()) {
         if (entry.id === id) {
           continue;
         }
        
        // Look for the name followed by an open paren (function call) or just the name as a token
        const callRegex = new RegExp(`\\b${name}\\s*\\(`, 'g');
        if (callRegex.test(content)) {
          relations.push({ type: 'calls', targetId: id });
        } else if (content.includes(name)) {
          relations.push({ type: 'mentions', targetId: id });
        }
      }

      // 3. Detect Inheritance (Class-level relations)
      const extendsRegex = /extends\s+([a-zA-Z0-9_]+)/g;
      while ((match = extendsRegex.exec(content)) !== null) {
        const baseClass = match[1];
        const targetId = nameToIdMap.get(baseClass);
        if (targetId) {
          relations.push({ type: 'extends', targetId });
        }
      }

      if (relations.length > 0) {
        // Remove duplicate relations
        const uniqueRelations = Array.from(new Map(relations.map(r => [r.type + r.targetId, r])).values());
        this.index.set(entry.id, { ...entry, relations: uniqueRelations });
        this.dirty.add(entry.id);
      }
    }
    
    await this.persistState();
    this.flushDirtyAsync();
  }

  /**
   * Performs a health check on the knowledge base.
   * Identifies orphans, contradictions, and outdated entries.
   */
  async lintMemory(): Promise<{ orphans: string[]; contradictions: string[][]; outdated: string[] }> {
    const entries = Array.from(this.index.values());
    const referencedIds = new Set<string>();
    const contradictions: string[][] = [];
    const outdated: string[] = [];
    
    // 1. Track all references for orphan detection
    for (const entry of entries) {
      for (const rel of entry.relations) {
        referencedIds.add(rel.targetId);
      }
    }

    // 2. Detect Contradictions and Outdated entries
    const coordMap = new Map<string, string>(); // "path:line" -> id

     for (const entry of entries) {
       const coord = `${entry.filePath ?? 'unknown'}:${entry.startLine}`;
       if (coordMap.has(coord)) {
        const otherId = coordMap.get(coord)!;
        if (otherId !== entry.id) {
          contradictions.push([entry.id, otherId]);
        }
      } else {
        coordMap.set(coord, entry.id);
      }

      // Check if entry is actually still present in the file (Freshness check)
      try {
       const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
       if (root && entry.filePath) {
         const fullPath = path.join(root, entry.filePath);
         const content = await fs.promises.readFile(fullPath, 'utf8');
         // If the content at that line has changed significantly, mark as outdated
          // (Simplified: just check if the chunk still exists as a substring)
          if (!content.includes(entry.content.slice(0, 100))) {
            outdated.push(entry.id);
          }
        }
      } catch {
        outdated.push(entry.id); // File deleted or unreadable
      }
    }

    // 3. Identify Orphans
    // An orphan is not referenced AND is not the first chunk of any file
    const orphans = entries
      .filter(e => {
        const isReferenced = referencedIds.has(e.id);
        const isRoot = e.startLine === 1; 
        return !isReferenced && !isRoot;
      })
      .map(e => e.id);

    return { orphans, contradictions, outdated };
  }

  /**
   * Prunes identified problematic entries from the memory store.
   */
  async pruneMemory(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.index.delete(id);
    }
    this.dirty.add('COMPACT'); // Trigger a full rewrite
    await this.persistState();
    this.flushDirtyAsync();
  }

  /**
   * Store a discovered capability (e.g., "ripgrep is installed") into LTM.
   */
  async storeCapability(tool: string, version: string): Promise<void> {
    const id = `cap_${tool}`;
    const content = `Tool ${tool} is installed. Version: ${version}`;
    const vector = await this.computeVector(content);

    this.index.set(id, {
      id,
      type: 'capability',
      description: `Capability: ${tool}`,
      content,
      vector,
      relations: [],
      timestamp: Date.now()
    });
    this.dirty.add(id);
  }
  public getStats(): MemoryStats {
    return {
      totalEntries: this.index.size,
      storePathExists: this.storePath !== '' && fs.existsSync(this.storePath),
      lastFlushMs: this.lastFlushMs
    };
  }

  // -------------------------------------------------------------------------
  // Private: async indexing pipeline
  // -------------------------------------------------------------------------

  /**
   * Index specifically changed files from patches.
   * Non-blocking.
   */
  async indexPatches(
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
           type: 'LTM',
           filePath: patch.path,
           startLine: mod.startLine,
           endLine: mod.endLine,
           description,
           content: mod.content.slice(0, 1_500),   // cap stored size
           relations: [],
           vector: embedding,
           timestamp: Date.now()
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
         // eslint-disable-next-line @typescript-eslint/naming-convention
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
    partial: Omit<MemoryEntry, 'id' | 'vector' | 'timestamp'>
  ): Promise<void> {
    const vector = await this.computeVector(partial.content);
    const filePath = partial.filePath ?? 'unknown';
    const startLine = partial.startLine ?? 1;
    const id = stableId(filePath, startLine);
    this.index.set(id, { ...partial, id, vector, timestamp: Date.now() });
    this.dirty.add(id);
  }

  private async computeVector(text: string): Promise<number[]> {
    try {
      const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
      const baseUrl = cfg.get<string>('apiUrl') ?? 'http://localhost:11434';
      const embedModel = cfg.get<string>('embeddingModel') ?? DEFAULT_EMBED_MODEL;
      
      const body = JSON.stringify({ 
        model: embedModel, 
        prompt: text.slice(0, 2000) 
      });
      
      const raw = await postJson(`${baseUrl}/api/embeddings`, body, 8000);
      const data = JSON.parse(raw) as { embedding?: number[] };
      const vec = data.embedding;
      
      if (Array.isArray(vec) && vec.length > 0) {
        return normalizeArr(vec);
      }
    } catch (err) {
      console.error('[MemoryManager] Embedding error, falling back to hash:', err);
    }
    return hashEmbed(text);
  }

  // -------------------------------------------------------------------------
  // Private: persistence (JSON)
  // -------------------------------------------------------------------------

  private async ensureStoreDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.storePath, { recursive: true });
      // Add .gitignore entry in the parent directory if not present
      await ensureGitignored(path.dirname(this.storePath));
    } catch { /* already exists or permission denied – continue */ }
  }

  private async loadState(): Promise<void> {
    try {
      const file = path.join(this.storePath, LTM_FILE);
      const raw = await fs.promises.readFile(file, 'utf8');
      const state = JSON.parse(raw);
      this.memoryMap = state.memoryMap ?? {};
      this.vectorIndex = state.vectorIndex ?? null;
    } catch { /* file not found or corrupt – start fresh */ }
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
         headers: { 
           // eslint-disable-next-line @typescript-eslint/naming-convention
           'Content-Type': 'application/json', 
           // eslint-disable-next-line @typescript-eslint/naming-convention
           'Content-Length': Buffer.byteLength(body) 
         },
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
