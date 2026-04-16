/**
 * Llama A Coder Extension – Main Entry Point
 *
 * Production-grade agentic coding assistant powered by local Ollama models.
 * Fork of ollama-copilot (anandof28) – evolved with full agentic-core,
 * MCP server support, optimization engine, and enhanced command surface.
 *
 * DELTA TYPE: MODIFY (all upstream logic preserved; new modules wired in)
 */

import * as vscode from 'vscode';

// Upstream modules (preserved unchanged)
import { OllamaClient }      from './ollama/client';
import { ModelSelector }     from './ollama/modelSelector';
import { PlannerAgent }      from './agents/planner';
import { CoderAgent }        from './agents/coder';
import { TesterAgent }       from './agents/tester';
import { WorkspaceTool }     from './tools/workspace';
import { SearchTool }        from './tools/search';
import { PatchTool }         from './tools/patch';
import { TerminalTool }      from './tools/terminal';
import { ChatViewProvider }  from './ui/chatView';
import { SessionState }      from './protocol/types';

// New modules
import { McpClientManager }  from './utils/mcp-client';
import { ModelManager }      from './ollama/model-manager';
import { PlanManager }       from './agentic-core/plan-manager';
import { TaskOrchestrator }  from './agentic-core/task-orchestrator';
import { StatusBarManager }  from './ui/status-bar';
import { SidebarProvider }   from './ui/sidebar-provider';
import { CompletionProvider }          from './providers/completion-provider';
import { CodeActionProvider, registerCodeActionCommands } from './providers/code-action-provider';
import { registerSwitchModel }   from './commands/switch-model';
import { registerGeneratePlan }  from './commands/generate-plan';
import { registerExecuteTask }   from './commands/execute-task';
import { registerApplyPatch }    from './commands/apply-patch';
import { registerReviewChanges } from './commands/review-changes';
import { Patch } from './protocol/types';

/**
 * Main extension controller
 */
export class OllamaCopilotExtension {
  // Upstream fields (unchanged)
  private ollama: OllamaClient;
  private modelSelector: ModelSelector;
  private planner: PlannerAgent;
  private coder: CoderAgent;
  private tester: TesterAgent;
  private workspace: WorkspaceTool;
  private search: SearchTool;
  private patch: PatchTool;
  private terminal: TerminalTool;
  private chatView: ChatViewProvider;
  private session: SessionState;
  private currentMode: 'code' | 'plan' | 'ask' = 'code';

  // New fields
  private mcpClient: McpClientManager;
  private modelManager: ModelManager;
  private planManager: PlanManager;
  private orchestrator: TaskOrchestrator;
  private statusBar: StatusBarManager;
  private sidebarProvider: SidebarProvider;
  /** Patches staged by the orchestrator and awaiting apply. */
  private pendingPatches: Patch[] = [];

  constructor(context: vscode.ExtensionContext) {
    // Get configuration
    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    const apiUrl = config.get<string>('apiUrl') || 'http://localhost:11434';
    const model = config.get<string>('model') || 'qwen2.5-coder:7b';
    const allowedCommands = config.get<string[]>('allowedCommands') || [
      'npm test',
      'npm run build',
      'npm run lint',
      'pnpm test',
      'pytest'
    ];

    // Initialize components
    this.ollama = new OllamaClient(apiUrl, model);
    this.workspace = new WorkspaceTool();
    this.search = new SearchTool();
    this.patch = new PatchTool(this.workspace);
    this.terminal = new TerminalTool(allowedCommands, this.workspace.getWorkspaceRoot());

    // Initialize agents
    this.planner = new PlannerAgent(this.ollama, this.workspace);
    this.coder = new CoderAgent(this.ollama, this.workspace, this.search);
    this.tester = new TesterAgent(this.ollama, this.terminal, this.workspace);

    // Initialize UI
    this.chatView = new ChatViewProvider(context);

    // Initialize model selector
    this.modelSelector = new ModelSelector();

    // Initialize MCP client manager
    this.mcpClient = new McpClientManager(context);

    // Initialize new agentic-core modules
    const cfg2 = vscode.workspace.getConfiguration('ollamaCopilot');
    const apiUrl2 = cfg2.get<string>('apiUrl') ?? 'http://localhost:11434';
    this.modelManager  = new ModelManager(apiUrl2);
    this.planManager   = new PlanManager(this.ollama, this.workspace);
    this.orchestrator  = new TaskOrchestrator(
      this.ollama, this.planManager, this.workspace, this.patch
    );
    this.statusBar     = new StatusBarManager(context);
    this.sidebarProvider = new SidebarProvider(context, this.chatView, this.statusBar);

    // Initialize session state
    this.session = {
      userRequest: '',
      plan: null,
      context: [],
      patches: [],
      appliedPatches: [],
      testResults: null
    };

    // Setup message handler
    this.chatView.onMessage(message => this.handleMessage(message));

    // Initialize models in chat view
    this.refreshModels();

    // Initialize MCP servers asynchronously (non-blocking)
    this.mcpClient.initialize().catch(err => {
      console.error('[Llama A Coder] MCP initialization error:', err);
    });

    // Listen for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ollamaCopilot.model')) {
          const newModel = this.modelSelector.getCurrentModel();
          this.ollama.setModel(newModel);
          this.modelSelector.updateStatusBar();
        }
        if (e.affectsConfiguration('ollamaCopilot.apiUrl')) {
          const config = vscode.workspace.getConfiguration('ollamaCopilot');
          const newApiUrl = config.get<string>('apiUrl') || 'http://localhost:11434';
          this.ollama.setBaseUrl(newApiUrl);
        }
      })
    );
  }

  /**
   * Get the chat view provider
   */
  public getChatView(): ChatViewProvider {
    return this.chatView;
  }

  /**
   * Get the MCP client manager
   */
  public getMcpClient(): McpClientManager {
    return this.mcpClient;
  }

  public getModelManager(): ModelManager   { return this.modelManager; }
  public getPlanManager(): PlanManager     { return this.planManager; }
  public getOrchestrator(): TaskOrchestrator { return this.orchestrator; }
  public getStatusBar(): StatusBarManager  { return this.statusBar; }
  public getPendingPatches(): readonly Patch[] { return this.pendingPatches; }

  /**
   * Dispose extension resources (called on deactivation)
   */
  public dispose(): void {
    this.mcpClient.dispose();
    this.sidebarProvider.dispose();
  }

  /**
   * Refresh available models
   */
  private async refreshModels(): Promise<void> {
    try {
      const models = await this.modelSelector.fetchModels();
      const modelNames = models.map(m => m.name);
      const currentModel = this.modelSelector.getCurrentModel();
      this.chatView.updateModels(modelNames, currentModel);
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }

  /**
   * Show model selector
   */
  public async showModelSelector(): Promise<void> {
    await this.modelSelector.selectModel();
  }

  /**
   * Handle messages from webview
   */
  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message.command) {
        case 'implementFeature':
          this.currentMode = 'code';
          await this.implementFeature(message.request);
          break;

        case 'planFeature':
          this.currentMode = 'plan';
          await this.planFeature(message.request);
          break;

        case 'askQuestion':
          this.currentMode = 'ask';
          await this.askQuestion(message.request);
          break;

        case 'selectModel':
          await this.changeModel(message.model);
          break;

        case 'requestModels':
          await this.refreshModels();
          break;

        case 'stopProcessing':
          this.chatView.stopProcessing();
          this.chatView.addMessage('system', '⏹ Operation stopped by user');
          break;

        case 'applyPatches':
          await this.applyPatches();
          break;

        case 'runTests':
          await this.runTests();
          break;

        case 'clearSession':
          this.clearSession();
          break;
      }
    } catch (error) {
      this.chatView.stopProcessing();
      this.chatView.addMessage('error', `Error: ${error}`);
    }
  }

  /**
   * Change the current model
   */
  private async changeModel(modelName: string): Promise<void> {
    this.ollama.setModel(modelName);
    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    await config.update('model', modelName, vscode.ConfigurationTarget.Global);
    this.chatView.addMessage('system', `✓ Switched to model: ${modelName}`);
    this.modelSelector.updateStatusBar();
  }

  /**
   * Main workflow: implement a feature
   */
  private async implementFeature(userRequest: string): Promise<void> {
    const cancelToken = this.chatView.startProcessing();
    
    try {
      // Check if workspace is open
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        this.chatView.addMessage('error', '⚠️ Please open a workspace folder to use Ollama Copilot features.');
        vscode.window.showWarningMessage(
          'Ollama Copilot requires an open workspace folder. Please open a folder and try again.'
        );
        return;
      }

      this.session.userRequest = userRequest;
      this.chatView.addMessage('user', userRequest);

      // Check cancellation
      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      // Step 1: Planning
      this.chatView.updateProgress('Step 1/3: Planning implementation...');
      
      const plan = await this.planner.plan(
        userRequest,
        (msg) => this.chatView.updateProgress(msg)
      );

      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      this.session.plan = plan;
      
      const planSummary = `Plan created:\n\n` +
        `Feature: ${plan.feature}\n\n` +
        `Steps:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
        `Files to analyze: ${plan.files_to_read.length}\n` +
        `Search queries: ${plan.search_queries.length}`;
      
      this.chatView.addMessage('assistant', planSummary);

      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      // Step 2: Code Generation
      this.chatView.updateProgress('Step 2/3: Generating code...');
      
      const coderOutput = await this.coder.generateCode(
        userRequest,
        plan,
        (msg) => this.chatView.updateProgress(msg)
      );

      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      this.session.patches = coderOutput.patches;

      const codeMsg = `Generated ${coderOutput.patches.length} patch${coderOutput.patches.length !== 1 ? 'es' : ''}\n\n` +
        `Notes:\n${coderOutput.notes.map(n => `• ${n}`).join('\n')}`;
      
      this.chatView.addMessage('assistant', codeMsg);

      // Step 3: Show preview
      this.chatView.updateProgress('Step 3/3: Preparing preview...');
      this.chatView.showDiffPreview(coderOutput.patches);

      this.chatView.addMessage('system', 
        'Review the changes above. Click "Apply Patches" to apply them to your workspace.'
      );

    } catch (error) {
      if (cancelToken.token.isCancellationRequested) {
        return; // Silent return if cancelled
      }
      this.chatView.addMessage('error', `Implementation failed: ${error}`);
      throw error;
    } finally {
      this.chatView.stopProcessing();
    }
  }

  /**
   * Apply patches to workspace
   */
  private async applyPatches(): Promise<void> {
    try {
      this.chatView.updateProgress('Applying patches...');

      const results: string[] = [];
      let successCount = 0;
      let failCount = 0;

      for (const patch of this.session.patches) {
        const result = await this.patch.applyPatch(patch);
        
        if (result.success) {
          successCount++;
          results.push(`✓ ${patch.path}`);
          this.session.appliedPatches.push(patch.path);
        } else {
          failCount++;
          results.push(`✗ ${patch.path}: ${result.error}`);
        }
      }

      const summary = `Applied patches:\n\n` +
        `Success: ${successCount}\n` +
        `Failed: ${failCount}\n\n` +
        results.join('\n');

      this.chatView.addMessage('assistant', summary);

      if (successCount > 0) {
        this.chatView.addMessage('system', 
          'Patches applied! Click "Run Tests" to verify the changes.'
        );
      }

    } catch (error) {
      this.chatView.addMessage('error', `Failed to apply patches: ${error}`);
      throw error;
    }
  }

  /**
   * Run tests and potentially fix issues
   */
  private async runTests(): Promise<void> {
    try {
      this.chatView.updateProgress('Running tests...');

      const testResult = await this.tester.runTestsAndAnalyze(
        (msg) => this.chatView.updateProgress(msg)
      );

      this.session.testResults = {
        success: testResult.success,
        output: testResult.output,
        errors: []
      };

      if (testResult.success) {
        this.chatView.addMessage('assistant', '✓ All tests passed!');
        this.chatView.addMessage('system', 
          'Implementation complete! Your feature has been successfully implemented and tested.'
        );
      } else {
        this.chatView.addMessage('error', 
          `Tests failed:\n\n${testResult.output.substring(0, 500)}...`
        );

        if (testResult.fix) {
          this.chatView.addMessage('assistant', 
            `Analysis: ${testResult.fix.analysis}\n\n` +
            `Generated ${testResult.fix.patches.length} fix${testResult.fix.patches.length !== 1 ? 'es' : ''}`
          );

          // Add fixes to session patches
          this.session.patches = testResult.fix.patches;
          this.chatView.showDiffPreview(testResult.fix.patches);

          this.chatView.addMessage('system', 
            'Review the proposed fixes and click "Apply Patches" to apply them.'
          );
        }
      }

    } catch (error) {
      this.chatView.addMessage('error', `Test execution failed: ${error}`);
      throw error;
    }
  }

  /**
   * Clear session state
   */
  private clearSession(): void {
    this.session = {
      userRequest: '',
      plan: null,
      context: [],
      patches: [],
      appliedPatches: [],
      testResults: null
    };
  }

  /**
   * Plan Mode: Create implementation plan without code generation
   */
  private async planFeature(userRequest: string): Promise<void> {
    const cancelToken = this.chatView.startProcessing();
    
    try {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        this.chatView.addMessage('error', '⚠️ Please open a workspace folder to use planning features.');
        return;
      }

      this.chatView.addMessage('user', userRequest);
      this.chatView.updateProgress('Creating implementation plan...');
      
      const plan = await this.planner.plan(
        userRequest,
        (msg) => this.chatView.updateProgress(msg)
      );

      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      this.session.plan = plan;
      this.chatView.updateProgress('');

      const planMsg = `📋 Implementation Plan:\\n\\n${plan.steps.map((s, i) => 
        `${i + 1}. ${s}`
      ).join('\n')}\n\nEstimated changes: ${plan.steps.length} steps`;

      this.chatView.addMessage('assistant', planMsg);
      this.chatView.addMessage('system', 
        'Switch to Code mode and send your request again to implement this plan.'
      );

    } catch (error) {
      if (cancelToken.token.isCancellationRequested) {
        return;
      }
      this.chatView.addMessage('error', `Planning failed: ${error}`);
      throw error;
    } finally {
      this.chatView.stopProcessing();
    }
  }

  /**
   * Ask Mode: Q&A with workspace context (no code modifications)
   */
  private async askQuestion(userRequest: string): Promise<void> {
    const cancelToken = this.chatView.startProcessing();
    
    try {
      this.chatView.addMessage('user', userRequest);
      
      // Gather workspace context if available
      let contextMessage = '';
      
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        this.chatView.updateProgress('Analyzing workspace...');
        
        // Get workspace structure
        const structure = await this.workspace.getWorkspaceStructure();
        if (structure.success) {
          contextMessage += `\n\n## Workspace Structure:\n${structure.data}\n`;
        }

        // Search for relevant files based on question keywords
        this.chatView.updateProgress('Searching relevant code...');
        const keywords = this.extractKeywords(userRequest);
        let relevantFiles: string[] = [];
        
        for (const keyword of keywords) {
          const searchResult = await this.search.searchText(keyword, 20);
          if (searchResult.success && searchResult.data) {
            relevantFiles.push(...searchResult.data.map((r: any) => r.file));
          }
        }

        // Remove duplicates and limit to top 5 files
        relevantFiles = [...new Set(relevantFiles)].slice(0, 5);

        // Read relevant files
        if (relevantFiles.length > 0) {
          this.chatView.updateProgress('Reading relevant files...');
          contextMessage += `\n## Relevant Files:\n`;
          
          for (const file of relevantFiles) {
            const content = await this.workspace.readFile(file);
            if (content.success) {
              contextMessage += `\n### ${file}\n\`\`\`\n${content.data}\n\`\`\`\n`;
            }
          }
        }
      }

      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      this.chatView.updateProgress('Generating answer...');

      // Chat with full context
      const response = await this.ollama.chat([
        {
          role: 'system',
          content: `You are an expert coding assistant analyzing this codebase. Answer questions clearly and concisely based on the provided workspace context. Reference specific files and code when relevant.

${contextMessage}`
        },
        {
          role: 'user',
          content: userRequest
        }
      ]);

      if (cancelToken.token.isCancellationRequested) {
        return;
      }

      this.chatView.updateProgress('');
      this.chatView.addMessage('assistant', response);

    } catch (error) {
      if (cancelToken.token.isCancellationRequested) {
        return;
      }
      this.chatView.addMessage('error', `Failed to get answer: ${error}`);
      throw error;
    } finally {
      this.chatView.stopProcessing();
    }
  }

  /**
   * Extract keywords from user request for searching
   */
  private extractKeywords(text: string): string[] {
    // Remove common words and extract meaningful terms
    const commonWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'how', 'what', 'where', 'when', 'why', 'can', 'does', 'do', 'i', 'you', 'this', 'that', 'these', 'those', 'add', 'create', 'make', 'implement', 'build']);
    
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !commonWords.has(word));
    
    // Return unique keywords, limit to 5
    return [...new Set(words)].slice(0, 5);
  }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('Llama A Coder extension is activating...');

  try {
    // Create extension instance (workspace check will be done when needed)
    const extension = new OllamaCopilotExtension(context);

    // Register chat view provider
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ChatViewProvider.viewType,
        extension.getChatView()
      )
    );

    // -----------------------------------------------------------------------
    // Upstream commands (preserved for backward compatibility)
    // -----------------------------------------------------------------------
    context.subscriptions.push(
      vscode.commands.registerCommand('ollama-copilot.openPanel', () => {
        vscode.commands.executeCommand('ollama-copilot.chatView.focus');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('ollama-copilot.implementFeature', () => {
        vscode.commands.executeCommand('ollama-copilot.chatView.focus');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('ollama-copilot.selectModel', async () => {
        await extension.showModelSelector();
      })
    );

    // -----------------------------------------------------------------------
    // New Llama A Coder commands
    // -----------------------------------------------------------------------

    /** Hot-swap model without full extension reload */
    context.subscriptions.push(
      vscode.commands.registerCommand('llama-a-coder.switchModel', async () => {
        await extension.showModelSelector();
      })
    );

    /** Trigger Plan Mode: generate a hierarchical implementation plan */
    context.subscriptions.push(
      vscode.commands.registerCommand('llama-a-coder.generatePlan', () => {
        vscode.commands.executeCommand('ollama-copilot.chatView.focus');
        extension.getChatView().addMessage(
          'system',
          '📋 Switch to **Plan** mode in the chat and describe what you want to build.'
        );
      })
    );

    /** Trigger Code Mode: execute the full plan → generate → patch workflow */
    context.subscriptions.push(
      vscode.commands.registerCommand('llama-a-coder.executeTask', () => {
        vscode.commands.executeCommand('ollama-copilot.chatView.focus');
        extension.getChatView().addMessage(
          'system',
          '💻 Switch to **Code** mode in the chat and describe the feature to implement.'
        );
      })
    );

    /** Apply staged patches from the last code-generation run */
    context.subscriptions.push(
      vscode.commands.registerCommand('llama-a-coder.applyPatch', () => {
        vscode.commands.executeCommand('ollama-copilot.chatView.focus');
        extension.getChatView().addMessage(
          'system',
          '🔧 Use the **Apply Patches** button in the chat to apply pending changes.'
        );
      })
    );

    /** Open diff review for staged patches */
    context.subscriptions.push(
      vscode.commands.registerCommand('llama-a-coder.reviewChanges', () => {
        vscode.commands.executeCommand('ollama-copilot.chatView.focus');
        extension.getChatView().addMessage(
          'system',
          '🔍 Review the diff preview above before applying patches.'
        );
      })
    );

    /** Manage MCP server list */
    context.subscriptions.push(
      vscode.commands.registerCommand('llama-a-coder.manageMcpServers', async () => {
        const servers = extension.getMcpClient().getRegisteredServers();
        if (servers.length === 0) {
          const action = await vscode.window.showInformationMessage(
            'No MCP servers are registered. Open settings to add one.',
            'Open Settings'
          );
          if (action === 'Open Settings') {
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'llamaACoder.mcpServers'
            );
          }
          return;
        }

        const items = servers.map(s => ({
          label: s.name,
          description: s.enabled ? '$(check) enabled' : '$(circle-slash) disabled',
          detail: `${(s.transport ?? 'sse').toUpperCase()} – ${s.url}`
        }));

        await vscode.window.showQuickPick(items, {
          title: 'Registered MCP Servers',
          placeHolder: 'Select a server to view details'
        });
      })
    );

    // -----------------------------------------------------------------------
    // Enhanced command registrations (delegate to command modules)
    // -----------------------------------------------------------------------
    context.subscriptions.push(
      registerSwitchModel(context, extension.getModelManager(), extension.getStatusBar()),
      registerGeneratePlan(context, extension.getPlanManager(), extension.getChatView(), extension.getStatusBar()),
      registerExecuteTask(context, extension.getOrchestrator(), extension.getChatView(), extension.getStatusBar()),
      registerApplyPatch(context, extension.getChatView(), extension.getStatusBar(), () => extension.getPendingPatches()),
      registerReviewChanges(context, extension.getChatView(), extension.getStatusBar(), () => extension.getPendingPatches()),
      ...registerCodeActionCommands(context)
    );

    // -----------------------------------------------------------------------
    // Providers (lazy completion + code actions)
    // -----------------------------------------------------------------------
    CompletionProvider.registerLazy(context);
    CodeActionProvider.register(context);

    // Dispose MCP resources when the extension is deactivated
    context.subscriptions.push({ dispose: () => extension.dispose() });

    console.log('Llama A Coder extension activated successfully!');

    vscode.window.showInformationMessage(
      '🦙 Llama A Coder is ready! Open the sidebar to get started.'
    );

  } catch (error) {
    console.error('Failed to activate Llama A Coder:', error);
    vscode.window.showErrorMessage(
      `Failed to activate Llama A Coder: ${error}`
    );
  }
}

/**
 * Extension deactivation
 */
export function deactivate() {
  console.log('Llama A Coder extension deactivated');
}
