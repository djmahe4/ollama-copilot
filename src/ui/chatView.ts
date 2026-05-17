/**
 * Webview Sidebar for Ollama Copilot Chat
 * Similar to GitHub Copilot's chat interface
 */

import * as vscode from 'vscode';
import { SessionState, Patch } from '../protocol/types';

interface ChatMessage {
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: number;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollama-copilot.chatView';
  private view?: vscode.WebviewView;
  private messageHandler?: (message: any) => void;
  private currentModel: string = 'qwen2.5-coder:7b';
  private availableModels: string[] = [];
  private chatHistory: ChatMessage[] = [];
  private isProcessing: boolean = false;
  private cancellationTokenSource?: vscode.CancellationTokenSource;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Load chat history from storage
    this.chatHistory = this.context.globalState.get<ChatMessage[]>('chatHistory', []);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Restore chat history if any
    if (this.chatHistory.length > 0) {
      setTimeout(() => {
        this.postMessage({ command: 'restoreHistory', history: this.chatHistory });
      }, 100);
    }

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: any) => {
        if (this.messageHandler) {
          this.messageHandler(message);
        }
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
    this.view?.webview.postMessage(message);
  }

  /**
   * Update available models
   */
  public updateModels(models: string[], currentModel: string): void {
    this.availableModels = models;
    this.currentModel = currentModel;
    this.postMessage({
      command: 'updateModels',
      models,
      currentModel
    });
  }

  /**
   * Add a chat message
   */
  public addMessage(type: 'user' | 'assistant' | 'system' | 'error', content: string): void {
    const message: ChatMessage = {
      type,
      content,
      timestamp: Date.now()
    };
    
    // Add to history
    this.chatHistory.push(message);
    this.saveHistory();
    
    // Send to webview
    this.postMessage({
      command: 'addMessage',
      type,
      content,
      timestamp: message.timestamp
    });
  }

  /**
   * Save chat history to storage
   */
  private async saveHistory(): Promise<void> {
    // Keep only last 100 messages to prevent storage bloat
    if (this.chatHistory.length > 100) {
      this.chatHistory = this.chatHistory.slice(-100);
    }
    await this.context.globalState.update('chatHistory', this.chatHistory);
  }

  /**
   * Start processing - creates cancellation token
   */
  public startProcessing(): vscode.CancellationTokenSource {
    this.isProcessing = true;
    this.cancellationTokenSource = new vscode.CancellationTokenSource();
    this.postMessage({ command: 'setProcessing', processing: true });
    return this.cancellationTokenSource;
  }

  /**
   * Stop processing
   */
  public stopProcessing(): void {
    if (this.cancellationTokenSource) {
      this.cancellationTokenSource.cancel();
      this.cancellationTokenSource.dispose();
      this.cancellationTokenSource = undefined;
    }
    this.isProcessing = false;
    this.postMessage({ command: 'setProcessing', processing: false });
    this.updateProgress('');
  }

  /**
   * Check if currently processing
   */
  public getIsProcessing(): boolean {
    return this.isProcessing;
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
  public async clearChat(): Promise<void> {
    this.chatHistory = [];
    await this.saveHistory();
    this.postMessage({
      command: 'clearChat'
    });
  }

  /**
   * Generate HTML content for webview
   */
  private getHtmlContent(webview: vscode.Webview): string {
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
      background-color: var(--vscode-sideBar-background);
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Header with mode selector */
    .header {
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    .mode-selector {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }

    .mode-btn {
      flex: 1;
      padding: 6px 12px;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }

    .mode-btn:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .mode-btn.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }

    .model-selector-container {
      margin-top: 8px;
    }

    .model-label {
      font-size: 11px;
      opacity: 0.7;
      margin-bottom: 4px;
      display: block;
    }

    select {
      width: 100%;
      padding: 6px 8px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
    }

    select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    /* Chat container */
    .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      scroll-behavior: smooth;
    }

    .message {
      margin-bottom: 16px;
      animation: fadeIn 0.3s ease-in;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message-header {
      font-size: 11px;
      opacity: 0.6;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .message-icon {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
    }

    .message.user .message-icon {
      background-color: var(--vscode-inputValidation-infoBackground);
    }

    .message.assistant .message-icon {
      background-color: var(--vscode-charts-purple);
    }

    .message.system .message-icon {
      background-color: var(--vscode-charts-yellow);
    }

    .message.error .message-icon {
      background-color: var(--vscode-errorForeground);
    }

    .message-content {
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .message.user .message-content {
      background-color: var(--vscode-inputValidation-infoBackground);
      border-left: 3px solid var(--vscode-inputValidation-infoBorder);
    }

    .message.assistant .message-content {
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-left: 3px solid var(--vscode-charts-purple);
    }

    .message.system .message-content {
      background-color: var(--vscode-inputValidation-warningBackground);
      border-left: 3px solid var(--vscode-inputValidation-warningBorder);
      font-size: 12px;
    }

    .message.error .message-content {
      background-color: var(--vscode-inputValidation-errorBackground);
      border-left: 3px solid var(--vscode-errorForeground);
    }

    .message-content code {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .code-block {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background-color: var(--vscode-textCodeBlock-background);
    }

    .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      opacity: 0.85;
    }

    .code-language {
      text-transform: lowercase;
    }

    .copy-code-btn {
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
      cursor: pointer;
    }

    .copy-code-btn:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .code-block pre {
      margin: 0;
      padding: 10px 12px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
    }

    .message-content p {
      margin: 0;
    }

    .message-content p + p {
      margin-top: 8px;
    }

    .message-content h1,
    .message-content h2,
    .message-content h3,
    .message-content h4,
    .message-content h5,
    .message-content h6 {
      margin: 10px 0 6px;
      font-weight: 600;
      line-height: 1.3;
    }

    .message-content h1 { font-size: 18px; }
    .message-content h2 { font-size: 16px; }
    .message-content h3 { font-size: 14px; }

    .message-content ul,
    .message-content ol {
      margin: 6px 0 6px 20px;
      padding: 0;
    }

    .message-content li {
      margin: 2px 0;
    }

    .message-content blockquote {
      margin: 8px 0;
      padding: 6px 10px;
      border-left: 3px solid var(--vscode-textLink-foreground);
      background-color: var(--vscode-editor-background);
      opacity: 0.95;
    }

    .message-content hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 10px 0;
    }

    .message-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 12px;
    }

    .message-content th,
    .message-content td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
      text-align: left;
      vertical-align: top;
    }

    .message-content th {
      background-color: var(--vscode-editor-background);
      font-weight: 600;
    }

    .progress {
      padding: 8px 12px;
      background-color: var(--vscode-inputValidation-infoBackground);
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Input area */
    .input-container {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    .input-wrapper {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    textarea {
      flex: 1;
      min-height: 36px;
      max-height: 120px;
      padding: 8px 12px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      font-size: 13px;
      font-family: var(--vscode-font-family);
      resize: none;
      line-height: 1.4;
    }

    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    button {
      padding: 8px 16px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background-color 0.2s;
    }

    button:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .diff-preview {
      margin-top: 12px;
      padding: 12px;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
    }

    .diff-file {
      margin-bottom: 12px;
    }

    .diff-file-name {
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--vscode-textLink-foreground);
    }

    .diff-line {
      font-family: var(--vscode-editor-font-family);
      padding: 2px 8px;
      white-space: pre;
    }

    .diff-add {
      background-color: var(--vscode-diffEditor-insertedTextBackground);
      color: var(--vscode-gitDecoration-addedResourceForeground);
    }

    .diff-remove {
      background-color: var(--vscode-diffEditor-removedTextBackground);
      color: var(--vscode-gitDecoration-deletedResourceForeground);
    }

    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      text-align: center;
      opacity: 0.6;
    }

    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .empty-state-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .empty-state-description {
      font-size: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="mode-selector">
      <button class="mode-btn active" data-mode="code" title="Code Mode: Plan and implement features">
        💻 Code
      </button>
      <button class="mode-btn" data-mode="plan" title="Plan Mode: Create implementation plans only">
        📋 Plan
      </button>
      <button class="mode-btn" data-mode="ask" title="Ask Mode: Simple Q&A without code changes">
        💬 Ask
      </button>
      <button class="mode-btn" data-mode="plan" title="Plan Mode: Create implementation plans only">
        📋 Plan
      </button>
      <button class="mode-btn" data-mode="ask" title="Ask Mode: Simple Q&A without code changes">
        💬 Ask
      </button>
    </div>
    <div class="model-selector-container">
      <label class="model-label">Model</label>
      <select id="modelSelect">
        <option value="">Loading models...</option>
      </select>
    </div>
  </div>

  <div class="chat-container" id="chatContainer">
    <div class="empty-state">
      <div class="empty-state-icon">🤖</div>
      <div class="empty-state-title">Ollama Copilot</div>
      <div class="empty-state-description">
        Ask questions, plan features, or implement code changes.<br>
        Your local AI coding assistant powered by Ollama.
      </div>
    </div>
  </div>

  <div class="input-container">
    <div class="input-wrapper">
      <textarea 
        id="messageInput" 
        placeholder="Ask Ollama Copilot a question or describe a feature..."
        rows="1"
      ></textarea>
      <button id="sendButton">Send</button>
      <button id="stopButton" style="display: none;" title="Stop generation">⏹ Stop</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentMode = 'code';
    let isProcessing = false;

    // DOM elements
    const chatContainer = document.getElementById('chatContainer');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const stopButton = document.getElementById('stopButton');
    const modelSelect = document.getElementById('modelSelect');
    const modeButtons = document.querySelectorAll('.mode-btn');

    // Mode selection
    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode;
        updatePlaceholder();
      });
    });

    function updatePlaceholder() {
      const placeholders = {
        code: 'Describe a feature to implement...',
        plan: 'What feature would you like me to plan?',
        ask: 'Ask a question about your code...'
      };
      messageInput.placeholder = placeholders[currentMode] || placeholders.code;
    }

    // Model selection
    modelSelect.addEventListener('change', (e) => {
      vscode.postMessage({
        command: 'selectModel',
        model: e.target.value
      });
    });

    // Send message
    function sendMessage() {
      const message = messageInput.value.trim();
      if (!message || isProcessing) return;

      vscode.postMessage({
        command: currentMode === 'code' ? 'implementFeature' : 
                 currentMode === 'plan' ? 'planFeature' : 'askQuestion',
        request: message,
        mode: currentMode
      });

      messageInput.value = '';
      autoResize();
    }

    sendButton.addEventListener('click', sendMessage);

    chatContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!target.classList.contains('copy-code-btn')) {
        return;
      }

      const encodedCode = target.getAttribute('data-code') || '';
      let code = '';
      try {
        code = decodeURIComponent(encodedCode);
      } catch {
        code = '';
      }

      try {
        await navigator.clipboard.writeText(code);
        const originalLabel = target.textContent;
        target.textContent = 'Copied';
        setTimeout(() => {
          target.textContent = originalLabel || 'Copy';
        }, 1200);
      } catch {
        target.textContent = 'Failed';
        setTimeout(() => {
          target.textContent = 'Copy';
        }, 1200);
      }
    });
    
    // Stop button
    stopButton.addEventListener('click', () => {
      vscode.postMessage({ command: 'stopProcessing' });
    });
    
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isProcessing) {
          sendMessage();
        }
      }
    });

    // Auto-resize textarea
    function autoResize() {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    }
    messageInput.addEventListener('input', autoResize);

    // Update UI based on processing state
    function setProcessing(processing) {
      isProcessing = processing;
      sendButton.style.display = processing ? 'none' : 'block';
      stopButton.style.display = processing ? 'block' : 'none';
      messageInput.disabled = processing;
    }

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
        case 'setProcessing':
          setProcessing(message.processing);
          break;
        case 'restoreHistory':
          restoreHistory(message.history);
          break;
        case 'showDiffPreview':
          showDiffPreview(message.patches);
          break;
        case 'clearChat':
          clearChat();
          break;
        case 'updateModels':
          updateModelSelector(message.models, message.currentModel);
          break;
      }
    });

    function addMessage(type, content, timestamp) {
      // Remove empty state
      const emptyState = chatContainer.querySelector('.empty-state');
      if (emptyState) {
        emptyState.remove();
      }

      const messageDiv = document.createElement('div');
      messageDiv.className = \`message \${type}\`;

      const icons = {
        user: '👤',
        assistant: '🤖',
        system: '⚙️',
        error: '⚠️'
      };

      const labels = {
        user: 'You',
        assistant: 'Ollama',
        system: 'System',
        error: 'Error'
      };

       messageDiv.innerHTML = \`
         <div class="message-header">
           <span class="message-icon">\${icons[type] || '💬'}</span>
           <span>\${labels[type] || type}</span>
           <span style="margin-left: auto; font-size: 10px;">\${formatTime(timestamp)}</span>
         </div>
         <div class="message-content">\${renderMessageContent(content)}</div>
       \`;

      chatContainer.appendChild(messageDiv);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function updateProgress(message) {
      const progressDiv = chatContainer.querySelector('.progress');
      
      if (!message) {
        if (progressDiv) progressDiv.remove();
        return;
      }

      if (progressDiv) {
        const textSpan = progressDiv.querySelector('span');
        if (textSpan) {
          textSpan.textContent = message;
        }
      } else {
        const newProgressDiv = document.createElement('div');
        newProgressDiv.className = 'progress';
        newProgressDiv.innerHTML = \`
          <div class="spinner"></div>
          <span>\${escapeHtml(message)}</span>
        \`;
        chatContainer.appendChild(newProgressDiv);
      }
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function showDiffPreview(patches) {
      updateProgress('');
 
      const diffDiv = document.createElement('div');
      diffDiv.className = 'diff-preview';
 
      let diffHtml = '<h4 style="margin-bottom: 8px;">📝 Proposed Changes:</h4>';
 
      patches.forEach(patch => {
        const lines = patch.diff.split('\n');
        diffHtml += \`
          <div class="diff-file">
            <div class="diff-file-name">\${escapeHtml(patch.path)}</div>
            \${lines.map(line => {
              const className = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : 
                                line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : '';
              return \`<div class="diff-line \${className}">\${escapeHtml(line)}</div>\`;
            }).join('')}
          </div>
        \`;
      });
 
      diffDiv.innerHTML = diffHtml;
      chatContainer.appendChild(diffDiv);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
 
    function clearChat() {
      chatContainer.innerHTML = \`
        <div class="empty-state">
          <div class="empty-state-icon">🤖</div>
          <div class="empty-state-title">Ollama Copilot</div>
          <div class="empty-state-description">
            Ask questions, plan features, or implement code changes.<br>
            Your local AI coding assistant powered by Ollama.
          </div>
        </div>
      \`;
    }
 
    function restoreHistory(history) {

      // Remove empty state
      const emptyState = chatContainer.querySelector('.empty-state');
      if (emptyState) {
        emptyState.remove();
      }

      // Add all messages from history
      history.forEach(msg => {
        addMessage(msg.type, msg.content, msg.timestamp);
      });
    }

    function updateModelSelector(models, currentModel) {
       modelSelect.innerHTML = models.map(model => 
         \`<option value="\${model}" \${model === currentModel ? 'selected' : ''}>\${model}</option>\`
       ).join('');
    }

    function formatTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function renderMessageContent(content) {
      if (!content) {
        return '';
      }

      const parts = [];
      const backtick = String.fromCharCode(96);
      const fence = backtick + backtick + backtick;
      const codeBlockPattern = fence + '([a-zA-Z0-9_+#.-]*)\\n?([\\s\\S]*?)' + fence;
      const codeBlockRegex = new RegExp(codeBlockPattern, 'g');
      let lastIndex = 0;
      let match;

      while ((match = codeBlockRegex.exec(content)) !== null) {
        const plainText = content.slice(lastIndex, match.index);
        if (plainText) {
          parts.push(renderRichText(plainText));
        }

        const language = (match[1] || 'code').trim();
        const rawCode = match[2] || '';
        const displayCode = rawCode.replace(/\n$/, '');
        const encodedCode = encodeURIComponent(displayCode);

        parts.push(
          '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-language">' + escapeHtml(language) + '</span>' +
              '<button class="copy-code-btn" data-code="' + encodedCode + '">Copy</button>' +
            '</div>' +
            '<pre><code>' + escapeHtml(displayCode) + '</code></pre>' +
          '</div>'
        );

        lastIndex = codeBlockRegex.lastIndex;
      }

      const remainingText = content.slice(lastIndex);
      if (remainingText) {
        parts.push(renderRichText(remainingText));
      }

      return parts.join('');
    }

    function renderInline(text) {
      const escaped = escapeHtml(text);
      const backtick = String.fromCharCode(96);
      const inlineCodePattern = backtick + '([^' + backtick + ']+)' + backtick;
      const inlineCodeRegex = new RegExp(inlineCodePattern, 'g');
      const withInlineCode = escaped.replace(inlineCodeRegex, '<code>$1</code>');
      const withBold = withInlineCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      const withItalic = withBold.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      return withItalic;
    }

    function renderRichText(text) {
      const normalized = (text || '').replace(/\r\n/g, '\n').trim();
      if (!normalized) {
        return '';
      }

      const blocks = normalized.split(/\n{2,}/);
      return blocks.map(renderBlock).join('');
    }

    function renderBlock(block) {
      const lines = block.split('\n');
      const firstLine = lines[0].trim();

      if (/^#{1,6}\s+/.test(firstLine) && lines.length === 1) {
        const level = Math.min((firstLine.match(/^#+/) || ['#'])[0].length, 6);
        const content = firstLine.replace(/^#{1,6}\s+/, '');
        return '<h' + level + '>' + renderInline(content) + '</h' + level + '>';
      }

      if (lines.every(line => /^\s*>/.test(line.trim()))) {
        const quoteText = lines.map(line => line.replace(/^\s*>\s?/, '')).join('<br>');
        return '<blockquote>' + renderInline(quoteText) + '</blockquote>';
      }

      if (firstLine.match(/^(-{3,}|\*{3,}|_{3,})$/) && lines.length === 1) {
        return '<hr>';
      }

      if (isTable(lines)) {
        return renderTable(lines);
      }

      if (lines.every(line => /^\s*[-*+]\s+/.test(line))) {
        return '<ul>' + lines.map(line => '<li>' + renderInline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>').join('') + '</ul>';
      }

      if (lines.every(line => /^\s*\d+\.\s+/.test(line))) {
        return '<ol>' + lines.map(line => '<li>' + renderInline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>').join('') + '</ol>';
      }

      return '<p>' + renderInline(block).replace(/\n/g, '<br>') + '</p>';
    }

    function isTable(lines) {
      if (lines.length < 2) {
        return false;
      }

      const hasPipes = lines.every(line => line.includes('|'));
      if (!hasPipes) {
        return false;
      }

      return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1]);
    }

    function renderTable(lines) {
      const parseRow = (line) => line
        .split('|')
        .map(cell => cell.trim())
        .filter((_, index, arr) => !(index === 0 && arr[index] === '') && !(index === arr.length - 1 && arr[index] === ''));

      const headers = parseRow(lines[0]);
      const bodyRows = lines.slice(2).map(parseRow);

      const headerHtml = '<tr>' + headers.map(cell => '<th>' + renderInline(cell) + '</th>').join('') + '</tr>';
      const bodyHtml = bodyRows.map(row => '<tr>' + row.map(cell => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>').join('');

      return '<table><thead>' + headerHtml + '</thead><tbody>' + bodyHtml + '</tbody></table>';
    }

    // Request initial models
    vscode.postMessage({ command: 'requestModels' });
  </script>
</body>
</html>`;
  }
}
