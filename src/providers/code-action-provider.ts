/**
 * Code Action Provider
 *
 * Offers Ollama-powered quick fixes and refactors via the VS Code lightbulb.
 *
 * 21. Exhaustive switch/case on action kinds.
 * 20. Strict type guards on diagnostic metadata.
 * 16. Rate limiting (max 1 code action per 800 ms).
 * 22. Security validation (untrusted workspace guard).
 *
 * Cross-platform: VS Code CodeActionProvider API is cross-platform.
 *
 * DELTA TYPE: EXTEND (new provider, no upstream mutation)
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS    = 800;
const MAX_FIX_TOKENS = 512;

// ---------------------------------------------------------------------------
// Action kinds
// ---------------------------------------------------------------------------

type ActionKind = 'fix' | 'refactor' | 'explain';

function codeActionKind(kind: ActionKind): vscode.CodeActionKind {
  switch (kind) {
    case 'fix':      return vscode.CodeActionKind.QuickFix;
    case 'refactor': return vscode.CodeActionKind.Refactor;
    case 'explain':  return vscode.CodeActionKind.Empty;
    // Exhaustive: TypeScript will flag a missing case (technique 21)
  }
}

// ---------------------------------------------------------------------------
// CodeActionProvider
// ---------------------------------------------------------------------------

export class CodeActionProvider implements vscode.CodeActionProvider {
  private lastRequestMs = 0;
  private ollamaModule: typeof import('../ollama/client') | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -------------------------------------------------------------------------
  // vscode.CodeActionProvider
  // -------------------------------------------------------------------------

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    _context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeAction[]> {
    if (!vscode.workspace.isTrusted) { return []; }

    const now = Date.now();
    if (now - this.lastRequestMs < DEBOUNCE_MS) { return []; }
    this.lastRequestMs = now;

    const selectedText = document.getText(range).trim();
    if (!selectedText || token.isCancellationRequested) { return []; }

    return [
      this.buildAction('fix',      document, range, selectedText),
      this.buildAction('refactor', document, range, selectedText),
      this.buildAction('explain',  document, range, selectedText)
    ];
  }

  // -------------------------------------------------------------------------
  // Static registration
  // -------------------------------------------------------------------------

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CodeActionProvider(context);
    const disposable = vscode.languages.registerCodeActionsProvider(
      { pattern: '**' },
      provider,
      {
        providedCodeActionKinds: [
          vscode.CodeActionKind.QuickFix,
          vscode.CodeActionKind.Refactor,
          vscode.CodeActionKind.Empty
        ]
      }
    );
    context.subscriptions.push(disposable);
    return disposable;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private buildAction(
    kind: ActionKind,
    document: vscode.TextDocument,
    range: vscode.Range,
    selectedText: string
  ): vscode.CodeAction {
    const labels: Record<ActionKind, string> = {
      fix:      '🦙 Fix with Llama A Coder',
      refactor: '🦙 Refactor with Llama A Coder',
      explain:  '🦙 Explain with Llama A Coder'
    };

    const action = new vscode.CodeAction(labels[kind], codeActionKind(kind));
    action.command = {
      command: `llama-a-coder.codeAction.${kind}`,
      title: labels[kind],
      arguments: [document, range, selectedText]
    };
    return action;
  }
}

// ---------------------------------------------------------------------------
// Code action command handler (registered separately from the provider)
// ---------------------------------------------------------------------------

export function registerCodeActionCommands(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const kinds: ActionKind[] = ['fix', 'refactor', 'explain'];

  return kinds.map(kind =>
    vscode.commands.registerCommand(
      `llama-a-coder.codeAction.${kind}`,
      async (
        document: vscode.TextDocument,
        range: vscode.Range,
        selectedText: string
      ) => {
        if (!isTextDocument(document) || !isRange(range) || typeof selectedText !== 'string') {
          return;
        }

        const cfg    = vscode.workspace.getConfiguration('ollamaCopilot');
        const apiUrl = cfg.get<string>('apiUrl')  ?? 'http://localhost:11434';
        const model  = cfg.get<string>('model')   ?? 'qwen2.5-coder:7b';

         // Dynamic import (technique 14)
         const { OllamaClient: ollamaClient } = await import('../ollama/client');
         const client = new ollamaClient(apiUrl, model);

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Llama A Coder: ${kind}…`, cancellable: false },
          async () => {
            const prompt = buildPrompt(kind, document.languageId, selectedText);
            try {
               const result = await client.chat(
                 [{ role: 'user', content: prompt }],
                 // eslint-disable-next-line @typescript-eslint/naming-convention
                 { temperature: 0.1, num_predict: MAX_FIX_TOKENS }
               );
              if (result.trim()) {
                const edit = new vscode.WorkspaceEdit();
                if (kind === 'explain') {
                  // Show in information message rather than replacing code
                  vscode.window.showInformationMessage(result.slice(0, 300));
                } else {
                  edit.replace(document.uri, range, result);
                  await vscode.workspace.applyEdit(edit);
                }
              }
            } catch (err) {
              vscode.window.showErrorMessage(`Code action failed: ${err}`);
            }
          }
        );
      }
    )
  );
}

// ---------------------------------------------------------------------------
// Type guards (technique 20)
// ---------------------------------------------------------------------------

function isTextDocument(value: unknown): value is vscode.TextDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    'languageId' in value
  );
}

function isRange(value: unknown): value is vscode.Range {
  return value instanceof vscode.Range;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(kind: ActionKind, lang: string, code: string): string {
  switch (kind) {
    case 'fix':
      return `Fix any bugs in this ${lang} code. Output only the corrected code, no explanation.\n\n\`\`\`${lang}\n${code}\n\`\`\``;
    case 'refactor':
      return `Refactor this ${lang} code for clarity and performance. Output only the refactored code.\n\n\`\`\`${lang}\n${code}\n\`\`\``;
    case 'explain':
      return `Explain what this ${lang} code does in 2-3 sentences.\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  }
}
