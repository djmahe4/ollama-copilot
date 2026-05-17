/**
 * switch-model command
 *
 * Hot-swaps the active Ollama model via ModelManager + QuickPickModels.
 * Registered as 'llama-a-coder.switchModel'.
 *
 * DELTA TYPE: EXTEND (new command module)
 */

import * as vscode from 'vscode';
import { ModelManager } from '../ollama/model-manager';
import { QuickPickModels } from '../ui/quick-pick-models';
import { StatusBarManager } from '../ui/status-bar';

/** Register the switch-model command and return a disposable. */
export function registerSwitchModel(
  context: vscode.ExtensionContext,
  manager: ModelManager,
  statusBar: StatusBarManager
): vscode.Disposable {
  const picker = new QuickPickModels(manager);

  return vscode.commands.registerCommand('llama-a-coder.switchModel', async () => {
    statusBar.showThinking();
    try {
      const chosen = await picker.show();
      if (chosen) {
        statusBar.showReady(chosen);
        vscode.window.showInformationMessage(`🦙 Switched to model: ${chosen}`);
      } else {
        // Restore current model label
        const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
        statusBar.showReady(cfg.get<string>('model') ?? '');
      }
    } catch (err) {
      statusBar.showError(String(err));
      vscode.window.showErrorMessage(`Model switch failed: ${err}`);
    }
  });
}
