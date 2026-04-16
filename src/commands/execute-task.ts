/**
 * execute-task command
 *
 * Runs the full Plan → Orchestrate → Patch workflow via TaskOrchestrator.
 * Registered as 'llama-a-coder.executeTask'.
 *
 * DELTA TYPE: EXTEND (new command module)
 */

import * as vscode from 'vscode';
import { TaskOrchestrator } from '../agentic-core/task-orchestrator';
import { ChatViewProvider } from '../ui/chatView';
import { StatusBarManager } from '../ui/status-bar';

const PROMPT_TITLE       = 'Llama A Coder – Execute Task';
const PROMPT_PLACEHOLDER = 'Describe the feature or task to implement…';

/** Register the execute-task command and return a disposable. */
export function registerExecuteTask(
  context: vscode.ExtensionContext,
  orchestrator: TaskOrchestrator,
  chatView: ChatViewProvider,
  statusBar: StatusBarManager
): vscode.Disposable {
  return vscode.commands.registerCommand('llama-a-coder.executeTask', async () => {
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }

    await vscode.commands.executeCommand('ollama-copilot.chatView.focus');

    const userRequest = await vscode.window.showInputBox({
      title: PROMPT_TITLE,
      placeHolder: PROMPT_PLACEHOLDER
    });
    if (!userRequest) { return; }

    statusBar.showThinking();
    chatView.addMessage('user', userRequest);

    try {
      const result = await orchestrator.run(
        userRequest,
        msg => chatView.addMessage('system', msg)
      );

      const summary =
        `⚙️ **Task complete** (${result.durationMs}ms)\n\n` +
        `Steps: ${result.subTasks.length} | ` +
        `Passed: ${result.subTasks.filter(t => t.status === 'done').length} | ` +
        `Failed: ${result.subTasks.filter(t => t.status === 'failed').length}\n\n` +
        (result.patches.length > 0
          ? `Generated ${result.patches.length} patch(es). Use **Apply Patch** to apply them.`
          : 'No patches generated.');

      chatView.addMessage('assistant', summary);

      if (result.patches.length > 0) {
        chatView.showDiffPreview([...result.patches]);
      }

      const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
      statusBar.showReady(cfg.get<string>('model') ?? '');
    } catch (err) {
      statusBar.showError(String(err));
      chatView.addMessage('error', `Task execution failed: ${err}`);
    }
  });
}
