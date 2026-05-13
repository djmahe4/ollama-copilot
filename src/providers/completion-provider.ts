/**
 * Completion Provider
 *
 * Provides inline code completions powered by Ollama.
 *
 * 14. Dynamic imports – OllamaClient is imported lazily to avoid blocking
 *     extension activation.
 * 13. Lazy loading – provider registration deferred until first text-doc open.
 * 16. Rate limiting (max 1 completion request per 600 ms).
 * 22. Security validation (no completion in untrusted workspaces).
 *
 * Cross-platform: VS Code InlineCompletionItemProvider API is cross-platform.
 *
 * DELTA TYPE: EXTEND (new provider, no upstream mutation)
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Constants  (no magic numbers – technique 30 awareness)
// ---------------------------------------------------------------------------

/** Minimum milliseconds between completion requests (technique 16). */
const DEBOUNCE_MS = 600;
/** Max tokens for a single completion (keeps latency low). */
const MAX_COMPLETION_TOKENS = 256;

// ---------------------------------------------------------------------------
// CompletionProvider
// ---------------------------------------------------------------------------

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastRequestMs = 0;
  /** Lazily-loaded client reference (technique 14 – dynamic import). */
  private ollamaClientModule: typeof import('../ollama/client') | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -------------------------------------------------------------------------
  // vscode.InlineCompletionItemProvider
  // -------------------------------------------------------------------------

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    // Security: skip untrusted workspaces (technique 22)
    if (!vscode.workspace.isTrusted) { return null; }

    // Rate limiting (technique 16)
    const now = Date.now();
    if (now - this.lastRequestMs < DEBOUNCE_MS) { return null; }
    this.lastRequestMs = now;

    // Only complete when the cursor is at end of a non-trivial line
    const lineText = document.lineAt(position.line).text;
    const prefix   = lineText.slice(0, position.character).trimStart();
    if (prefix.length < 3) { return null; }
    if (token.isCancellationRequested) { return null; }

    const cfg     = vscode.workspace.getConfiguration('ollamaCopilot');
    const apiUrl  = cfg.get<string>('apiUrl')  ?? 'http://localhost:11434';
    const model   = cfg.get<string>('model')   ?? 'qwen2.5-coder:7b';
    const temp    = cfg.get<number>('temperature') ?? 0.1;

    try {
      // Dynamic import – only loaded when actually needed (technique 14)
      if (!this.ollamaClientModule) {
        this.ollamaClientModule = await import('../ollama/client');
      }
       const { OllamaClient: ollamaClient } = this.ollamaClientModule;

      if (token.isCancellationRequested) { return null; }

      const context = this.buildContext(document, position);
       const client  = new ollamaClient(apiUrl, model);

       const completion = await client.chat(
         [{ role: 'user', content: context }],
         // eslint-disable-next-line @typescript-eslint/naming-convention
         { temperature: temp, num_predict: MAX_COMPLETION_TOKENS }
       );

      if (!completion.trim() || token.isCancellationRequested) { return null; }

      const item = new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position)
      );
      return new vscode.InlineCompletionList([item]);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Static registration helper (technique 13 – lazy registration)
  // -------------------------------------------------------------------------

  /**
   * Register this provider lazily: only after the first text document opens.
   * Returns a disposable that unregisters the provider.
   */
  static registerLazy(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CompletionProvider(context);
    let registered: vscode.Disposable | undefined;

    const onOpen = vscode.workspace.onDidOpenTextDocument(() => {
      if (!registered) {
        registered = vscode.languages.registerInlineCompletionItemProvider(
          { pattern: '**' },
          provider
        );
        context.subscriptions.push(registered);
      }
    });

    context.subscriptions.push(onOpen);
    return onOpen;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private buildContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    const startLine = Math.max(0, position.line - 20);
    const lines     = [];
    for (let i = startLine; i <= position.line; i++) {
      lines.push(document.lineAt(i).text);
    }
    const lang = document.languageId;
    return (
      `Complete the following ${lang} code. Output only the completion, no explanation.\n\n` +
      `\`\`\`${lang}\n${lines.join('\n')}`
    );
  }
}
