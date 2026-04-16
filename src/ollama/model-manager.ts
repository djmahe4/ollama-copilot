/**
 * Model Manager
 *
 * Enhances upstream ModelSelector with:
 * 17. Multi-model routing strategy (route by task type)
 * 16. Rate limiting and resource awareness (per-model call budgets)
 * 15. Retry with exponential backoff on transient Ollama errors
 *  8. Dependency injection
 * 11. Immutable model config records
 *
 * Cross-platform: uses only Node.js http/https – no shell calls.
 *
 * DELTA TYPE: EXTEND (wraps upstream ModelSelector)
 */

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { ModelSelector } from './modelSelector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType = 'plan' | 'code' | 'test' | 'ask' | 'critique';

export interface ModelConfig {
  readonly name: string;
  readonly taskAffinity: readonly TaskType[];
  readonly temperature: number;
  readonly maxTokens: number;
  /** Minimum ms between calls to this model (rate-limit, technique 16). */
  readonly callIntervalMs: number;
}

export interface ModelStats {
  readonly name: string;
  totalCalls: number;
  totalErrors: number;
  lastCallMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CALL_INTERVAL_MS = 100;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 400;

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

/**
 * Manages model configurations and routes tasks to the most appropriate
 * available model. Wraps the upstream ModelSelector for hot-swap support.
 */
export class ModelManager {
  private readonly configs = new Map<string, ModelConfig>();
  private readonly stats = new Map<string, ModelStats>();
  private readonly upstream: ModelSelector;

  constructor(private readonly baseUrl: string = 'http://localhost:11434') {
    this.upstream = new ModelSelector();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Register a model with its configuration.
   * Safe to call multiple times (idempotent per name).
   */
  registerModel(config: ModelConfig): void {
    this.configs.set(config.name, config);
    if (!this.stats.has(config.name)) {
      this.stats.set(config.name, {
        name: config.name,
        totalCalls: 0,
        totalErrors: 0,
        lastCallMs: 0
      });
    }
  }

  // -------------------------------------------------------------------------
  // 17 – Multi-model routing
  // -------------------------------------------------------------------------

  /**
   * Return the best available model name for the given `taskType`.
   * Falls back to the currently configured model if no affinity match found.
   */
  async routeFor(taskType: TaskType): Promise<string> {
    const available = await this.fetchAvailableNames();
    const availableSet = new Set(available);

    // Find registered configs that match this task and are available
    const candidates = Array.from(this.configs.values()).filter(
      cfg => cfg.taskAffinity.includes(taskType) && availableSet.has(cfg.name)
    );

    if (candidates.length > 0) {
      // Pick the least-recently-used candidate (technique 16 – resource awareness)
      candidates.sort((a, b) => {
        const sa = this.stats.get(a.name)?.lastCallMs ?? 0;
        const sb = this.stats.get(b.name)?.lastCallMs ?? 0;
        return sa - sb;
      });
      return candidates[0].name;
    }

    // Fallback: currently configured model
    return this.upstream.getCurrentModel();
  }

  // -------------------------------------------------------------------------
  // Hot-swap (enhances upstream selectModel)
  // -------------------------------------------------------------------------

  /**
   * Hot-swap the active model without a full extension reload.
   * Updates VS Code config so all agents pick up the change immediately.
   */
  async hotSwap(modelName: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    await cfg.update('model', modelName, vscode.ConfigurationTarget.Global);
    this.upstream.updateStatusBar();
  }

  /** Open the upstream QuickPick model selector. */
  async showSelector(): Promise<void> {
    await this.upstream.selectModel();
  }

  // -------------------------------------------------------------------------
  // 15 – Retry with exponential backoff + 16 – Rate limiting
  // -------------------------------------------------------------------------

  /**
   * Record a completed call for rate-limit tracking.
   */
  recordCall(modelName: string, wasError: boolean): void {
    const s = this.stats.get(modelName);
    if (s) {
      s.totalCalls++;
      if (wasError) { s.totalErrors++; }
      s.lastCallMs = Date.now();
    }
  }

  /**
   * Wait until the per-model rate limit allows the next call.
   * (technique 16 – rate limiting)
   */
  async waitForRateLimit(modelName: string): Promise<void> {
    const cfg = this.configs.get(modelName);
    const interval = cfg?.callIntervalMs ?? DEFAULT_CALL_INTERVAL_MS;
    const stats = this.stats.get(modelName);
    if (!stats) { return; }
    const gap = Date.now() - stats.lastCallMs;
    if (gap < interval) {
      await sleep(interval - gap);
    }
  }

  /**
   * Wrap an async operation with retry + exponential backoff.
   * (technique 15)
   */
  async withRetry<T>(fn: () => Promise<T>, modelName: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.waitForRateLimit(modelName);
      try {
        const result = await fn();
        this.recordCall(modelName, false);
        return result;
      } catch (err) {
        lastErr = err;
        this.recordCall(modelName, true);
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw new Error(`ModelManager: '${modelName}' failed after ${MAX_RETRIES} retries: ${lastErr}`);
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  getStats(): ReadonlyMap<string, ModelStats> {
    return this.stats;
  }

  getConfig(modelName: string): ModelConfig | undefined {
    return this.configs.get(modelName);
  }

  dispose(): void {
    this.upstream.dispose();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async fetchAvailableNames(): Promise<string[]> {
    try {
      const raw = await makeGetRequest(`${this.baseUrl}/api/tags`);
      const data = JSON.parse(raw) as { models?: Array<{ name: string }> };
      return (data.models ?? []).map(m => m.name);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeGetRequest(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        timeout: 5_000
      },
      res => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => { resolve(body); });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
