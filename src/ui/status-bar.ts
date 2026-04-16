/**
 * Status Bar Manager
 *
 * 13. Lazy loading – creates the status bar item only when first accessed.
 * 10. Memory leak prevention – disposes the item via context.subscriptions.
 * 25. Internationalization readiness – all user-facing strings are constants.
 *
 * Cross-platform: VS Code StatusBarItem API is platform-agnostic.
 *
 * DELTA TYPE: EXTEND (new UI module)
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// i18n-ready string constants  (technique 25)
// ---------------------------------------------------------------------------

const LABEL_READY     = '🦙';
const LABEL_THINKING  = '$(loading~spin) Llama';
const LABEL_ERROR     = '$(error) Llama';
const TOOLTIP_DEFAULT = 'Llama A Coder – click to switch model';
const TOOLTIP_BUSY    = 'Llama A Coder – processing…';

// ---------------------------------------------------------------------------
// StatusBarManager
// ---------------------------------------------------------------------------

/**
 * Manages the Llama A Coder status bar item.
 * The underlying VS Code item is created lazily (technique 13).
 */
export class StatusBarManager {
  /** Lazily-created backing item – null until first access. */
  private _item: vscode.StatusBarItem | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Show the status bar item with the current model name. */
  showReady(modelName: string): void {
    const item = this.item;
    item.text = `${LABEL_READY} ${modelName}`;
    item.tooltip = TOOLTIP_DEFAULT;
    item.backgroundColor = undefined;
    item.show();
  }

  /** Indicate that the agent is processing. */
  showThinking(): void {
    const item = this.item;
    item.text = LABEL_THINKING;
    item.tooltip = TOOLTIP_BUSY;
    item.show();
  }

  /** Indicate an error state. */
  showError(message: string): void {
    const item = this.item;
    item.text = LABEL_ERROR;
    item.tooltip = message;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    item.show();
  }

  /** Hide the status bar item. */
  hide(): void {
    this._item?.hide();
  }

  // -------------------------------------------------------------------------
  // Lazy item getter  (technique 13)
  // -------------------------------------------------------------------------

  private get item(): vscode.StatusBarItem {
    if (!this._item) {
      this._item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        99
      );
      this._item.command = 'llama-a-coder.switchModel';
      // Register for disposal with the extension context (technique 10)
      this.context.subscriptions.push(this._item);
    }
    return this._item;
  }
}
