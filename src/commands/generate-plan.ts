/**
 * generate-plan command
 *
 * Opens the chat sidebar in Plan mode and prompts the user to describe
 * what they want to build. Delegates planning to PlanManager (ToT).
 * Registered as 'llama-a-coder.generatePlan'.
 *
 * DELTA TYPE: EXTEND (new command module)
 */

import * as vscode from 'vscode';
import { PlanManager } from '../agentic-core/plan-manager';
import { ChatViewProvider } from '../ui/chatView';
import { StatusBarManager } from '../ui/status-bar';

const PROMPT_PLACEHOLDER = 'Describe the feature or task to plan…';
const PROMPT_TITLE       = 'Llama A Coder – Generate Plan';

/** Register the generate-plan command and return a disposable. */
export function registerGeneratePlan(
  context: vscode.ExtensionContext,
  planManager: PlanManager,
  chatView: ChatViewProvider,
  statusBar: StatusBarManager
): vscode.Disposable {
  return vscode.commands.registerCommand('llama-a-coder.generatePlan', async () => {
    // Focus the sidebar first
    await vscode.commands.executeCommand('ollama-copilot.chatView.focus');

    const userRequest = await vscode.window.showInputBox({
      title: PROMPT_TITLE,
      placeHolder: PROMPT_PLACEHOLDER
    });
    if (!userRequest) { return; }

    statusBar.showThinking();
    chatView.addMessage('user', userRequest);

    try {
      const plan = await planManager.plan(
        userRequest,
        msg => chatView.addMessage('system', msg)
      );

      const summary =
        `📋 **Plan: ${plan.feature}**\n\n` +
        plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
        `\n\nFiles to read: ${plan.files_to_read.length}`;

      chatView.addMessage('assistant', summary);

      const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
      statusBar.showReady(cfg.get<string>('model') ?? '');
    } catch (err) {
      statusBar.showError(String(err));
      chatView.addMessage('error', `Plan generation failed: ${err}`);
    }
  });
}
