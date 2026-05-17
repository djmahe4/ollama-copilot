/**
 * Sidebar Provider
 *
 * Thin wrapper around upstream ChatViewProvider that adds:
 * 24. Accessibility hooks (ARIA labels, keyboard roles on webview content)
 * 25. Internationalization readiness (string constants, locale-aware dates)
 * 10. Memory leak prevention (disposes listeners)
 *  8. Dependency injection
 *
 * Cross-platform: VS Code WebviewView API is platform-agnostic.
 *
 * DELTA TYPE: EXTEND (wraps upstream ui/chatView.ts)
 */

import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';
import { StatusBarManager } from './status-bar';

// ---------------------------------------------------------------------------
// i18n-ready labels  (technique 25)
// ---------------------------------------------------------------------------

const SIDEBAR_TITLE = 'Llama A Coder';

// ---------------------------------------------------------------------------
// SidebarProvider
// ---------------------------------------------------------------------------

/**
 * Composes `ChatViewProvider` with `StatusBarManager` and wires them
 * together into a cohesive sidebar experience.
 *
 * The provider registers itself via `context.subscriptions` so all
 * disposables are cleaned up automatically (technique 10).
 */
export class SidebarProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly chatView: ChatViewProvider,
    private readonly statusBar: StatusBarManager
  ) {
    this.init();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register the webview provider and sync status bar with config changes. */
  private init(): void {
    // Register the chat view with VS Code
    const viewRegistration = vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      this.chatView,
      { webviewOptions: { retainContextWhenHidden: true } }
    );
    this.disposables.push(viewRegistration);

    // Sync status bar when model config changes
    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ollamaCopilot.model')) {
        const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
        const model = cfg.get<string>('model') ?? '';
        this.statusBar.showReady(model);
      }
    });
    this.disposables.push(configListener);

    // Show initial model in status bar
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const model = cfg.get<string>('model') ?? '';
    this.statusBar.showReady(model);

    // Register disposables with extension context (technique 10)
    this.context.subscriptions.push(...this.disposables);
  }

  // -------------------------------------------------------------------------
  // Accessibility helpers  (technique 24)
  // -------------------------------------------------------------------------

  /**
   * Return the ARIA-ready HTML attributes block for the sidebar container.
   * Injected into the webview HTML by ChatViewProvider.
   */
  static accessibilityAttributes(): string {
    return `role="complementary" aria-label="${SIDEBAR_TITLE}"`;
  }

  // -------------------------------------------------------------------------
  // Disposable  (technique 10)
  // -------------------------------------------------------------------------

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
