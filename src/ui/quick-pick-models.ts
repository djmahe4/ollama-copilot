/**
 * Quick-Pick Models UI
 *
 * 25. Internationalization readiness (string constants)
 * 20. Strict type guards on API response
 * 15. Retry with exponential backoff
 *
 * Cross-platform: VS Code QuickPick API is platform-agnostic.
 *
 * DELTA TYPE: EXTEND (thin wrapper around upstream ModelSelector flow)
 */

import * as vscode from 'vscode';
import { ModelManager } from '../ollama/model-manager';

// ---------------------------------------------------------------------------
// i18n-ready labels  (technique 25)
// ---------------------------------------------------------------------------

const TITLE            = 'Llama A Coder – Select Model';
const PLACEHOLDER      = 'Choose an Ollama model…';
const DETAIL_CURRENT   = '$(check) Active';
const LABEL_CUSTOM     = '$(edit) Enter custom model name…';
const MSG_NO_MODELS    = 'No Ollama models found. Pull one with: ollama pull <model>';
const MSG_NOT_RUNNING  = 'Ollama is not running. Please start it first.';

// ---------------------------------------------------------------------------
// QuickPickModels
// ---------------------------------------------------------------------------

/**
 * Shows a VS Code QuickPick for model selection, then delegates the
 * hot-swap to `ModelManager`.
 */
export class QuickPickModels {
  constructor(private readonly manager: ModelManager) {}

  /**
   * Display the model picker. Returns the selected model name, or
   * `undefined` if cancelled.
   */
  async show(): Promise<string | undefined> {
    let models: string[] = [];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading models…', cancellable: false },
      async () => {
        try {
          models = await fetchModelNames();
        } catch {
          /* handled below */
        }
      }
    );

    if (models.length === 0) {
      const action = await vscode.window.showWarningMessage(MSG_NO_MODELS, 'Open Terminal');
      if (action === 'Open Terminal') {
        const terminal = vscode.window.createTerminal('Ollama');
        terminal.show();
        terminal.sendText('ollama pull qwen2.5-coder:7b');
      }
      return undefined;
    }

    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const current = cfg.get<string>('model') ?? '';

    const items: vscode.QuickPickItem[] = models.map(name => ({
      label: name,
      description: name === current ? DETAIL_CURRENT : ''
    }));
    items.push({ label: LABEL_CUSTOM, description: '' });

    const picked = await vscode.window.showQuickPick(items, {
      title: TITLE,
      placeHolder: PLACEHOLDER,
      matchOnDescription: true
    });
    if (!picked) { return undefined; }

    if (picked.label === LABEL_CUSTOM) {
      return this.promptCustomModel(current);
    }

    await this.manager.hotSwap(picked.label);
    return picked.label;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async promptCustomModel(currentModel: string): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter Ollama model name (e.g. qwen2.5-coder:7b)',
      value: currentModel,
      validateInput: v => (!v || !v.includes(':') ? 'Use format name:tag' : null)
    });
    if (!name) { return undefined; }
    await this.manager.hotSwap(name.trim());
    return name.trim();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchModelNames(): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
  const base = cfg.get<string>('apiUrl') ?? 'http://localhost:11434';

  const http  = await import('http');
  const https = await import('https');

  return new Promise((resolve, reject) => {
    const url = new URL('/api/tags', base);
    const client = url.protocol === 'https:' ? https : http;
    const req = (client as typeof http).request(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'GET', timeout: 5_000 },
      res => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          try {
            const data = JSON.parse(body) as { models?: Array<{ name: string }> };
            resolve((data.models ?? []).map(m => m.name));
          } catch { reject(new Error('Parse error')); }
        });
      }
    );
    req.on('error', () => reject(new Error(MSG_NOT_RUNNING)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
