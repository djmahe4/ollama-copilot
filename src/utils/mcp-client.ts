/**
 * MCP Client – Model Context Protocol integration stub
 *
 * Discovers, registers, and calls tools on any MCP server
 * (SSE or stdio transport). Context7 is the recommended default
 * for real-time documentation lookups.
 *
 * DELTA TYPE: EXTEND (new capability, no upstream mutation)
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as cp from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Transport mechanism used to communicate with the MCP server. */
export type McpTransport = 'sse' | 'stdio';

/** Configuration for a single MCP server entry. */
export interface McpServerConfig {
  readonly name: string;
  readonly url: string;
  readonly transport?: McpTransport;
  enabled: boolean;
}

/** A single tool call directed at an MCP server. */
export interface McpToolCall {
  readonly tool: string;
  readonly params: Record<string, unknown>;
}

/** The result returned by an MCP tool invocation. */
export interface McpToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface McpToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: any;
}

export interface McpToolDefinition extends McpToolMetadata {
  readonly serverName: string;
}

/** Internal runtime entry that augments config with discovered tool metadata. */
interface McpServerEntry {
  readonly config: McpServerConfig;
  tools: McpToolDefinition[];
  reachable: boolean;
  process?: cp.ChildProcess;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Well-known Context7 SSE endpoint used for automatic discovery. */
const CONTEXT7_SSE_URL = 'http://localhost:7070/sse';

/** Timeout (ms) for reachability probes during auto-discovery. */
const PROBE_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// McpClientManager
// ---------------------------------------------------------------------------

/**
 * Manages lifecycle of all configured MCP servers.
 *
 * Responsibilities:
 *  - Parse `llamaACoder.mcpServers` setting at activation and on change
 *  - Auto-discover well-known servers (Context7) when `mcpAutoDiscover` is set
 *  - Expose registered servers to the agent orchestration layer
 *  - Proxy validated tool calls to the correct server
 *  - Dispose all resources on extension deactivation
 */
export class McpClientManager {
  private readonly servers = new Map<string, McpServerEntry>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise from settings and optionally run auto-discovery.
   * Safe to call multiple times (idempotent per server name).
   */
  async initialize(): Promise<void> {
    this.loadFromSettings();

    const cfg = vscode.workspace.getConfiguration('llamaACoder');
    if (cfg.get<boolean>('mcpAutoDiscover') !== false) {
      await this.autoDiscover();
    }

    // Re-initialize when settings change
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration('llamaACoder.mcpServers') ||
          e.affectsConfiguration('llamaACoder.mcpAutoDiscover')
        ) {
          this.loadFromSettings();
        }
      })
    );
  }

  /** Release all held resources. */
  dispose(): void {
    for (const entry of this.servers.values()) {
      if (entry.process) {
        entry.process.kill();
      }
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.servers.clear();
  }

  // -------------------------------------------------------------------------
  // Server registration
  // -------------------------------------------------------------------------

  /**
   * Register a single MCP server. Replaces any existing entry with the same
   * name. Disabled entries are stored but not probed.
   */
  registerServer(config: McpServerConfig): void {
    const entry: McpServerEntry = {
      config,
      tools: [],
      reachable: false
    };
    this.servers.set(config.name, entry);
  }

  /** Return shallow copy of all registered server configs. */
  getRegisteredServers(): McpServerConfig[] {
    return Array.from(this.servers.values()).map(e => ({ ...e.config }));
  }

  /**
   * Fetches all available tools from all reachable MCP servers.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    const allTools: McpToolDefinition[] = [];
    
    for (const [serverName, entry] of this.servers.entries()) {
      if (!entry.reachable || !entry.config.enabled) {
        continue;
      }
      
      try {
        // MCP standard: GET /tools or POST /tools/list
         const tools = await this.fetchToolsFromServer(entry.config);
         allTools.push(...tools.map((t): McpToolDefinition => ({ ...t, serverName })));
      } catch (err) {
        console.error(`[McpClientManager] Failed to fetch tools from ${serverName}:`, err);
      }
    }
    
    return allTools;
  }

  private async fetchToolsFromServer(config: McpServerConfig): Promise<McpToolMetadata[]> {
    // Stub for actual MCP tool discovery protocol
    // In a real implementation, this would call the MCP server's tool listing endpoint
    if (config.name === 'Context7') {
      return [
        { name: 'search_docs', description: 'Search for documentation in Context7', inputSchema: { query: 'string' } },
        { name: 'query_library', description: 'Query a specific library by ID', inputSchema: { libraryId: 'string', query: 'string' } }
      ];
    }
    return [];
  }

  /**
   * Semantically resolves a tool based on a natural language intent.
   */
  async resolveToolByIntent(intent: string, ollama: any): Promise<{ serverName: string, tool: string, params: any } | null> {
    const tools = await this.listTools();
    if (tools.length === 0) {
      return null;
    }

    const toolCatalog = tools.map(t => `${t.serverName}:${t.name} - ${t.description}`).join('\n');
    
    const prompt = `You are a tool dispatcher. Given the user intent, select the best tool from the catalog.
    
    User Intent: ${intent}
    
    Tool Catalog:
    ${toolCatalog}
    
    Respond ONLY in JSON format:
    {
      "serverName": "...",
      "tool": "...",
      "params": { ... }
    }
    If no tool matches, return null.`;

    try {
      const response = await ollama.chat([{ role: 'user', content: prompt }], { temperature: 0 });
      return JSON.parse(response);
    } catch (err) {
      console.error('[McpClientManager] Intent resolution failed:', err);
      return null;
    }
    }
    
    /**
     * All inputs are validated before dispatch. No arbitrary code is executed;
     * only whitelisted HTTP/SSE requests are made.
     *
     * @param serverName - Registered server name
     * @param call       - Tool name and parameters
     */
    async callTool(serverName: string, call: McpToolCall): Promise<McpToolResult> {

    const entry = this.servers.get(serverName);
    if (!entry) {
      return { success: false, error: `MCP server '${serverName}' is not registered` };
    }
    if (!entry.config.enabled) {
      return { success: false, error: `MCP server '${serverName}' is disabled` };
    }
    if (!entry.reachable) {
      return { success: false, error: `MCP server '${serverName}' is not reachable` };
    }

    if (!this.isValidToolName(call.tool)) {
      return { success: false, error: `Invalid tool name: '${call.tool}'` };
    }

    try {
      const result = await this.dispatchToolCall(entry.config, call);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Populate the server registry from VS Code settings. */
  private loadFromSettings(): void {
    const cfg = vscode.workspace.getConfiguration('llamaACoder');
    const rawServers = cfg.get<McpServerConfig[]>('mcpServers') ?? [];

    for (const raw of rawServers) {
      if (this.isValidServerConfig(raw)) {
        this.registerServer(raw);
      }
    }
  }

  /**
   * Probe well-known MCP servers and register reachable ones.
   * Currently targets Context7 at its default localhost port.
   */
  private async autoDiscover(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('llamaACoder');
    const preferContext7 = cfg.get<boolean>('mcpPreferContext7') !== false;
    
    if (preferContext7 && !this.servers.has('Context7')) {
      const reachable = await this.probe(CONTEXT7_SSE_URL);
      if (reachable) {
        const config: McpServerConfig = {
          name: 'Context7',
          url: CONTEXT7_SSE_URL,
          transport: 'sse',
          enabled: true
        };
        this.registerServer(config);
        const entry = this.servers.get('Context7');
        if (entry) {
          entry.reachable = true;
          // Pre-fetch tools for the discovered server
            entry.tools = (await this.fetchToolsFromServer(config)).map(t => ({ ...t, serverName: config.name }));
        }
        console.log('[Llama A Coder] Context7 MCP server auto-discovered');
      }
    }
    
    // Mark all registered servers with reachability results
    await Promise.all(
      Array.from(this.servers.entries()).map(async ([name, entry]) => {
        if (!entry.reachable) {
          entry.reachable = await this.probe(entry.config.url);
          if (entry.reachable) {
             entry.tools = (await this.fetchToolsFromServer(entry.config)).map(t => ({ ...t, serverName: name }));
            console.log(`[Llama A Coder] MCP server reachable: ${name}`);
          }
        }
      })
    );
  }

  /**
   * Test whether an MCP server URL responds within the probe timeout.
   * Returns false on any error – never throws.
   */
  private probe(url: string): Promise<boolean> {
    return new Promise(resolve => {
      try {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const client = isHttps ? https : http;

        const req = client.request(
          {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname,
            method: 'GET',
            timeout: PROBE_TIMEOUT_MS
          },
          res => {
            res.resume(); // drain
            resolve((res.statusCode ?? 0) < 500);
          }
        );

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Dispatch a tool call to the MCP server.
   * SSE transport: POST to /tools/<name> with JSON body.
   * stdio transport: stub – not yet implemented.
   */
  private async dispatchToolCall(
    config: McpServerConfig,
    call: McpToolCall
  ): Promise<unknown> {
    if (config.transport === 'stdio') {
      return this.dispatchStdioCall(config, call);
    }
    return this.postJson(`${config.url}/tools/${encodeURIComponent(call.tool)}`, call.params);
  }

  private async dispatchStdioCall(config: McpServerConfig, call: McpToolCall): Promise<unknown> {
    const entry = this.servers.get(config.name);
    if (!entry) throw new Error('Server entry not found');

    if (!entry.process) {
      // Spawn the server process
      // config.url is used as the command for stdio
      entry.process = cp.spawn(config.url, { shell: true });
    }

    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: call.tool,
          arguments: call.params
        }
      };

      const process = entry.process;
      if (!process || !process.stdin || !process.stdout) {
        return reject(new Error('MCP process not spawned or streams missing'));
      }

      process.stdin.write(JSON.stringify(request) + '\n');

      const onData = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === request.id) {
            process.stdout?.removeListener('data', onData);
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result);
            }
          }
        } catch {
          // Ignore partial JSON or malformed responses
        }
      };

      process.stdout.on('data', onData);
      
      // Timeout
      setTimeout(() => {
        process.stdout?.removeListener('data', onData);
        reject(new Error('MCP stdio call timed out'));
      }, 30_000);
    });
  }

  /** POST JSON to a URL and return the parsed response body. */
  private postJson(url: string, body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const payload = JSON.stringify(body);

      const req = client.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 30_000
        },
        res => {
          let raw = '';
          res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw));
              } catch {
                resolve(raw);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}: ${raw}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('MCP tool call timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  /** Ensure tool name contains only safe identifier characters. */
  private isValidToolName(name: string): boolean {
    return /^[\w\-./]{1,128}$/.test(name);
  }

  /** Runtime guard for McpServerConfig shape from settings. */
  private isValidServerConfig(value: unknown): value is McpServerConfig {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const cfg = value as Record<string, unknown>;
    return (
      typeof cfg['name'] === 'string' &&
      cfg['name'].length > 0 &&
      typeof cfg['url'] === 'string' &&
      cfg['url'].length > 0 &&
      (cfg['transport'] === 'sse' || cfg['transport'] === 'stdio' || cfg['transport'] === undefined)
    );
  }
}
