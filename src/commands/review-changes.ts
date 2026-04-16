/**
 * review-changes command
 *
 * Shows a diff preview of pending patches and runs SelfCritique over them.
 * Registered as 'llama-a-coder.reviewChanges'.
 *
 * DELTA TYPE: EXTEND (new command module)
 */

import * as vscode from 'vscode';
import { SelfCritique } from '../agentic-core/self-critique';
import { OllamaClient } from '../ollama/client';
import { ChatViewProvider } from '../ui/chatView';
import { StatusBarManager } from '../ui/status-bar';
import { Patch } from '../protocol/types';

/** Register the review-changes command and return a disposable. */
export function registerReviewChanges(
  context: vscode.ExtensionContext,
  chatView: ChatViewProvider,
  statusBar: StatusBarManager,
  getPendingPatches: () => readonly Patch[]
): vscode.Disposable {
  return vscode.commands.registerCommand('llama-a-coder.reviewChanges', async () => {
    const patches = getPendingPatches();
    if (patches.length === 0) {
      vscode.window.showInformationMessage('No pending patches to review.');
      return;
    }

    // Show diff preview via upstream ChatViewProvider
    chatView.showDiffPreview([...patches]);

    // Run self-critique asynchronously
    statusBar.showThinking();
    chatView.addMessage('system', `🔍 Running self-critique on ${patches.length} patch(es)…`);

    try {
      const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
      const apiUrl = cfg.get<string>('apiUrl') ?? 'http://localhost:11434';
      const model  = cfg.get<string>('model')  ?? 'qwen2.5-coder:7b';

      const ollama   = new OllamaClient(apiUrl, model);
      const critique = new SelfCritique(ollama);

      const result = await critique.critique(
        patches,
        msg => chatView.addMessage('system', msg)
      );

      const icon = result.aggregateVerdict === 'ok'      ? '✅' :
                   result.aggregateVerdict === 'warning'  ? '⚠️' : '❌';

      let summary = `${icon} Critique verdict: **${result.aggregateVerdict}**\n`;
      if (result.blockers.length > 0) {
        summary += `\n**Blockers (${result.blockers.length}):**\n` +
          result.blockers.map(b => `• [${b.category}] ${b.description}`).join('\n');
      }
      if (result.warnings.length > 0) {
        summary += `\n**Warnings (${result.warnings.length}):**\n` +
          result.warnings.map(w => `• [${w.category}] ${w.description}`).join('\n');
      }
      if (result.blockers.length === 0 && result.warnings.length === 0) {
        summary += '\nNo issues found.';
      }

      chatView.addMessage('assistant', summary);
      statusBar.showReady(model);
    } catch (err) {
      statusBar.showError(String(err));
      chatView.addMessage('error', `Review failed: ${err}`);
    }
  });
}
