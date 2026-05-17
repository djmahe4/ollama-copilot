/**
 * Webview Panel for Ollama Copilot UI
 */

import * as vscode from 'vscode';
import { SessionState, Patch } from '../protocol/types';

export class CopilotPanel {
  private panel: vscode.WebviewPanel | undefined;
  private context: vscode.ExtensionContext;
  private messageHandler?: (message: any) => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Create or show the panel
   */
  public show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ollamaCopilot',
      'Ollama Copilot',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    this.panel.webview.html = this.getHtmlContent();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: any) => {
        if (this.messageHandler) {
          this.messageHandler(message);
        }
      },
      undefined,
      this.context.subscriptions
    );

    // Cleanup when panel is closed
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      this.context.subscriptions
    );
  }

  /**
   * Set message handler for webview messages
   */
  public onMessage(handler: (message: any) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Send message to webview
   */
  public postMessage(message: any): void {
    this.panel?.webview.postMessage(message);
  }

  /**
   * Add a chat message
   */
  public addMessage(type: 'user' | 'assistant' | 'system' | 'error', content: string): void {
    this.postMessage({
      command: 'addMessage',
      type,
      content,
      timestamp: Date.now()
    });
  }

  /**
   * Update progress
   */
  public updateProgress(message: string): void {
    this.postMessage({
      command: 'updateProgress',
      message
    });
  }

  /**
   * Show diff preview
   */
  public showDiffPreview(patches: Patch[]): void {
    this.postMessage({
      command: 'showDiffPreview',
      patches
    });
  }

  /**
   * Clear chat
   */
  public clearChat(): void {
    this.postMessage({
      command: 'clearChat'
    });
  }

  /**
   * Generate HTML content for webview
   */
  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ollama Copilot</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      padding: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background-color: var(--vscode-sideBar-background);
    }

    .header h1 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .header p {
      font-size: 12px;
      opacity: 0.7;
    }

    .container {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }

    .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .message {
      margin-bottom: 16px;
      padding: 12px;
      border-radius: 6px;
      max-width: 90%;
    }

    .message.user {
      background-color: var(--vscode-inputValidation-infoBackground);
      margin-left: auto;
    }

    .message.assistant {
      background-color: var(--vscode-editor-inactiveSelectionBackground);
    }

    .message.system {
      background-color: var(--vscode-inputValidation-warningBackground);
      font-size: 12px;
      opacity: 0.9;
    }

    .message.error {
      background-color: var(--vscode-inputValidation-errorBackground);
    }

    .message-header {
      font-size: 11px;
      opacity: 0.6;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
    }

    .message-content {
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .diff-preview {
      margin-top: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .diff-header {
      padding: 12px;
      background-color: var(--vscode-sideBar-background);
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .diff-content {
      padding: 12px;
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      max-height: 400px;
      overflow-y: auto;
    }

    .command-proposal {
      margin-top: 16px;
      padding: 16px;
      background-color: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
    }

    .command-proposal h3 {
      font-size: 13px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .command-input-container {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .command-input {
      flex: 1;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-family: monospace;
      font-size: 12px;
    }

    .memory-stats {
      margin-top: 16px;
      padding: 12px;
      background-color: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 12px;
    }

    .memory-stats h3 {
      font-size: 13px;
      margin-bottom: 8px;
    }

    .memory-stat-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      opacity: 0.8;
    }

    .diff-file {
      margin-bottom: 20px;
    }

    .diff-file-path {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      margin-bottom: 8px;
    }

    .diff-line {
      font-family: monospace;
      line-height: 1.4;
    }

    .diff-line.add {
      background-color: rgba(0, 255, 0, 0.1);
      color: #4EC9B0;
    }

    .diff-line.remove {
      background-color: rgba(255, 0, 0, 0.1);
      color: #F48771;
    }

    .input-container {
      padding: 16px;
      border-top: 1px solid var(--vscode-panel-border);
      background-color: var(--vscode-sideBar-background);
    }

    .input-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    textarea {
      flex: 1;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      resize: vertical;
      min-height: 60px;
    }

    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      transition: background-color 0.2s;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button.secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .button-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .progress {
      padding: 8px;
      background-color: var(--vscode-inputValidation-infoBackground);
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 12px;
      display: none;
    }

    .progress.active {
      display: block;
    }

    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 Ollama Copilot</h1>
    <p>Agentic coding assistant powered by local Ollama</p>
  </div>

    <div class="container">
      <div class="chat-container" id="chatContainer">
        <div class="message system">
          <div class="message-content">
            Welcome to Ollama Copilot! Type your feature request below and click "Implement Feature" to get started.
          </div>
        </div>
      </div>

      <div id="commandProposal" class="hidden"></div>
      <div id="memoryStats" class="hidden"></div>
      <div id="diffPreview" class="hidden"></div>

      <div class="input-container">

      <div class="progress" id="progress"></div>
      
      <div class="input-row">
        <textarea id="userInput" placeholder="Describe the feature you want to implement..."></textarea>
      </div>

      <div class="button-row">
        <button id="implementBtn">🚀 Implement Feature</button>
        <button id="applyBtn" class="secondary" disabled>✓ Apply Patches</button>
        <button id="testBtn" class="secondary" disabled>🧪 Run Tests</button>
        <button id="clearBtn" class="secondary">🗑️ Clear</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chatContainer');
    const diffPreview = document.getElementById('diffPreview');
    const userInput = document.getElementById('userInput');
    const implementBtn = document.getElementById('implementBtn');
    const applyBtn = document.getElementById('applyBtn');
    const testBtn = document.getElementById('testBtn');
    const clearBtn = document.getElementById('clearBtn');
    const progress = document.getElementById('progress');

    let currentPatches = [];

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;

      switch (message.command) {
        case 'addMessage':
          addMessage(message.type, message.content, message.timestamp);
          break;
        case 'updateProgress':
          updateProgress(message.message);
          break;
        case 'showDiffPreview':
          showDiffPreview(message.patches);
          break;
        case 'showCommandProposal':
          showCommandProposal(message.command);
          break;
        case 'updateMemoryStats':
          updateMemoryStats(message.stats);
          break;
        case 'clearChat':
          clearChat();
          break;
        }
      }
    });

    // Button handlers

    implementBtn.addEventListener('click', () => {
      const request = userInput.value.trim();
      if (!request) return;

      vscode.postMessage({
        command: 'implementFeature',
        request
      });

      userInput.value = '';
      implementBtn.disabled = true;
    });

    applyBtn.addEventListener('click', () => {
      vscode.postMessage({
        command: 'applyPatches'
      });
      applyBtn.disabled = true;
    });

    testBtn.addEventListener('click', () => {
      vscode.postMessage({
        command: 'runTests'
      });
    });

    clearBtn.addEventListener('click', () => {
      clearChat();
      vscode.postMessage({
        command: 'clearSession'
      });
    });

    function addMessage(type, content, timestamp) {
      const messageDiv = document.createElement('div');
      messageDiv.className = \`message \${type}\`;

      const header = document.createElement('div');
      header.className = 'message-header';
       header.innerHTML = \`
         <span>\${type.toUpperCase()}</span>
         <span>\${new Date(timestamp).toLocaleTimeString()}</span>
       \`;

      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      contentDiv.textContent = content;

      messageDiv.appendChild(header);
      messageDiv.appendChild(contentDiv);
      chatContainer.appendChild(messageDiv);

      chatContainer.scrollTop = chatContainer.scrollHeight;
      
      implementBtn.disabled = false;
      progress.classList.remove('active');
    }

    function updateProgress(message) {
      progress.textContent = message;
      progress.classList.add('active');
    }

    function showDiffPreview(patches) {
      currentPatches = patches;
      
      diffPreview.className = '';
       diffPreview.innerHTML = \`
         <div class="diff-header">📝 Proposed Changes (\${patches.length} file\${patches.length !== 1 ? 's' : ''})</div>
         <div class="diff-content" id="diffContent"></div>
       \`;

      const diffContent = document.getElementById('diffContent');
      
      patches.forEach(patch => {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'diff-file';
        
        const pathDiv = document.createElement('div');
        pathDiv.className = 'diff-file-path';
        pathDiv.textContent = patch.path;
        fileDiv.appendChild(pathDiv);

        const lines = patch.diff.split('\\n');
        lines.forEach(line => {
          const lineDiv = document.createElement('div');
          lineDiv.className = 'diff-line';
          
          if (line.startsWith('+')) {
            lineDiv.classList.add('add');
          } else if (line.startsWith('-')) {
            lineDiv.classList.add('remove');
          }
          
          lineDiv.textContent = line || ' ';
          fileDiv.appendChild(lineDiv);
        });

        diffContent.appendChild(fileDiv);
      });

      applyBtn.disabled = false;
      testBtn.disabled = false;
    }

    function showCommandProposal(command) {
      const proposalDiv = document.getElementById('commandProposal');
      proposalDiv.className = '';
      proposalDiv.innerHTML = \`
        <div class="command-proposal">
          <h3>🚀 Command Proposal</h3>
          <div class="command-input-container">
            <input type="text" id="proposedCmd" class="command-input" value="\${command}">
          </div>
          <div class="button-row">
            <button id="runCmdBtn">Run Command</button>
            <button id="cancelCmdBtn" class="secondary">Cancel</button>
          </div>
        </div>
      \`;

      document.getElementById('runCmdBtn').addEventListener('click', () => {
        const finalCmd = document.getElementById('proposedCmd').value;
        vscode.postMessage({
          command: 'executeTerminalCommand',
          command: finalCmd
        });
        proposalDiv.className = 'hidden';
      });

      document.getElementById('cancelCmdBtn').addEventListener('click', () => {
        vscode.postMessage({
          command: 'cancelTerminalCommand'
        });
        proposalDiv.className = 'hidden';
      });
    }

    function updateMemoryStats(stats) {
      const statsDiv = document.getElementById('memoryStats');
      statsDiv.className = '';
      statsDiv.innerHTML = \`
        <div class="memory-stats">
          <h3>🧠 Knowledge Base Stats</h3>
          <div class="memory-stat-item">
            <span>Total Chunks:</span>
            <span>\${stats.totalEntries}</span>
          </div>
          <div class="memory-stat-item">
            <span>Store Status:</span>
            <span>\${stats.storePathExists ? '✅ Active' : '❌ Missing'}</span>
          </div>
          <div class="memory-stat-item">
            <span>Last Flush:</span>
            <span>\${new Date(stats.lastFlushMs).toLocaleTimeString()}</span>
          </div>
        </div>
      \`;
    }

    function clearChat() {

      chatContainer.innerHTML = \`
        <div class="message system">
          <div class="message-content">
            Chat cleared. Ready for new requests.
          </div>
        </div>
      \`;
      
      diffPreview.className = 'hidden';
      diffPreview.innerHTML = '';
      currentPatches = [];
      applyBtn.disabled = true;
      testBtn.disabled = true;
      implementBtn.disabled = false;
      progress.classList.remove('active');
    }
  </script>
</body>
</html>`;
  }
}
