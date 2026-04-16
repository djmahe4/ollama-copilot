/**
 * apply-patch command
 *
 * Applies staged patches through PatchApplier (with pre-flight validation).
 * Registered as 'llama-a-coder.applyPatch'.
 *
 * DELTA TYPE: EXTEND (new command module)
 */

import * as vscode from 'vscode';
import { PatchApplier } from '../agentic-core/patch-applier';
import { PatchTool } from '../tools/patch';
import { WorkspaceTool } from '../tools/workspace';
import { ChatViewProvider } from '../ui/chatView';
import { StatusBarManager } from '../ui/status-bar';
import { Patch } from '../protocol/types';

/** Register the apply-patch command and return a disposable. */
export function registerApplyPatch(
  context: vscode.ExtensionContext,
  chatView: ChatViewProvider,
  statusBar: StatusBarManager,
  getPendingPatches: () => readonly Patch[]
): vscode.Disposable {
  return vscode.commands.registerCommand('llama-a-coder.applyPatch', async () => {
    const patches = getPendingPatches();
    if (patches.length === 0) {
      vscode.window.showInformationMessage('No pending patches to apply.');
      return;
    }

    // Confirm before applying
    const confirmed = await vscode.window.showWarningMessage(
      `Apply ${patches.length} patch(es) to the workspace?`,
      { modal: true },
      'Apply'
    );
    if (confirmed !== 'Apply') { return; }

    statusBar.showThinking();

    try {
      const workspace = new WorkspaceTool();
      const patchTool = new PatchTool(workspace);
      const applier   = new PatchApplier(patchTool, workspace);

      // Dry-run first to surface errors before touching the file system
      const dry = applier.dryRun(patches);
      if (dry.failCount > 0) {
        const failList = dry.applied
          .filter(r => !r.success)
          .map(r => `• ${r.path}: ${r.error}`)
          .join('\n');
        chatView.addMessage('error', `Dry-run failed:\n${failList}`);
        statusBar.showError('Patch dry-run failed');
        return;
      }

      const result = await applier.applyAll(patches);
      const summary =
        `✅ Applied ${result.successCount}/${patches.length} patch(es)` +
        (result.failCount > 0 ? ` | ❌ ${result.failCount} failed` : '');

      chatView.addMessage('assistant', summary);
      if (result.failCount > 0) {
        const errors = result.applied
          .filter(r => !r.success)
          .map(r => `• ${r.path}: ${r.error}`)
          .join('\n');
        chatView.addMessage('error', errors);
      }

      const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
      statusBar.showReady(cfg.get<string>('model') ?? '');
    } catch (err) {
      statusBar.showError(String(err));
      chatView.addMessage('error', `Patch application failed: ${err}`);
    }
  });
}
