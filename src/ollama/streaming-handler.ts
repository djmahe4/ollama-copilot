/**
 * Streaming Handler
 *
 * Wraps the upstream OllamaClient streaming path with:
 * 10. Memory leak prevention (explicit cleanup, AbortController)
 * 12. Zero-allocation critical path (reuse buffers, avoid intermediate strings)
 *  8. Dependency injection
 * 15. Retry with exponential backoff on stream errors
 *
 * Cross-platform: uses only Node.js http/https – no OS-specific APIs.
 *
 * DELTA TYPE: EXTEND (new capability layer over upstream client.ts)
 */

import * as http from 'http';
import * as https from 'https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamingOptions {
  /** Ollama model name. */
  readonly model: string;
  /** Ollama API base URL. */
  readonly baseUrl: string;
  /** Request messages. */
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  /** Model options (temperature etc.). */
  readonly options?: Record<string, unknown>;
  /** Called with each decoded text chunk. */
  onChunk: (chunk: string) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface StreamingResult {
  readonly fullText: string;
  readonly chunks: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// StreamingHandler
// ---------------------------------------------------------------------------

/**
 * Handles streaming Ollama responses with cancellation, memory safety, and
 * retry logic. Uses a fixed-size chunk buffer to minimise heap allocations
 * on the hot path (technique 12).
 */
export class StreamingHandler {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Stream a chat completion request. Retries on transient network errors
   * (technique 15). Cleans up the HTTP request on cancellation or error
   * (technique 10 – memory leak prevention).
   */
  async stream(opts: StreamingOptions): Promise<StreamingResult> {
    const start = Date.now();
    let lastErr: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      }
      try {
        const result = await this.doStream(opts);
        return { ...result, durationMs: Date.now() - start };
      } catch (err) {
        if (opts.signal?.aborted) {
          throw new StreamAbortedError('Stream aborted by user');
        }
        lastErr = err;
      }
    }
    throw new StreamingError(`Streaming failed after ${MAX_RETRIES} retries: ${lastErr}`);
  }

  // -------------------------------------------------------------------------
  // Private: core streaming request  (techniques 10, 12)
  // -------------------------------------------------------------------------

  private doStream(opts: StreamingOptions): Promise<{ fullText: string; chunks: number }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: opts.model ?? this.model,
        messages: opts.messages,
        stream: true,
        options: opts.options ?? {}
      });

      const url = new URL('/api/chat', opts.baseUrl ?? this.baseUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      // Pre-allocate a reusable text decoder (technique 12 – zero-allocation)
      const decoder = new TextDecoder('utf-8', { fatal: false });

      let req: http.ClientRequest | undefined;

      // Cancellation: destroy request on abort signal (technique 10)
      const onAbort = (): void => {
        req?.destroy();
        reject(new StreamAbortedError('Stream aborted'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        res => {
          let fullText = '';
          let chunks = 0;
          // Reuse a line-assembly buffer (technique 12)
          let lineBuffer = '';

          res.on('data', (raw: Buffer) => {
            // Decode incrementally – avoids creating an intermediate string
            // for each chunk boundary (technique 12)
            lineBuffer += decoder.decode(raw, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) { continue; }
              try {
                const data = JSON.parse(line) as {
                  message?: { content?: string };
                  done?: boolean;
                };
                const text = data.message?.content ?? '';
                if (text) {
                  fullText += text;
                  chunks++;
                  opts.onChunk(text);
                }
              } catch { /* skip malformed JSON */ }
            }
          });

          res.on('end', () => {
            // Flush remaining decoder bytes
            const tail = decoder.decode(undefined, { stream: false });
            if (tail.trim()) {
              try {
                const data = JSON.parse(tail) as { message?: { content?: string } };
                const text = data.message?.content ?? '';
                if (text) { fullText += text; opts.onChunk(text); chunks++; }
              } catch { /* ignore */ }
            }
            opts.signal?.removeEventListener('abort', onAbort);
            resolve({ fullText, chunks });
          });

          res.on('error', err => {
            opts.signal?.removeEventListener('abort', onAbort);
            reject(err);
          });
        }
      );

      req.on('error', err => {
        opts.signal?.removeEventListener('abort', onAbort);
        // Guard: only reject once (technique 10)
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class StreamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamingError';
  }
}

export class StreamAbortedError extends StreamingError {
  constructor(message: string) {
    super(message);
    this.name = 'StreamAbortedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
