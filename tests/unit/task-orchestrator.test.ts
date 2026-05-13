import { TaskOrchestrator } from '../../src/agentic-core/task-orchestrator';
import { OllamaClient } from '../../src/ollama/client';
import { PlanManager } from '../../src/agentic-core/plan-manager';
import { WorkspaceTool } from '../../tools/workspace';
import { PatchTool } from '../../tools/patch';
import { TerminalTool } from '../../tools/terminal';
import { MemoryManager } from '../../utils/memory-manager';
import { ConversationManager } from '../../utils/conversation-manager';
import { SkillManager } from '../../src/agentic-core/skill-manager';
import { McpClientManager } from '../../utils/mcp-client';

describe('TaskOrchestrator', () => {
  let orchestrator: TaskOrchestrator;
  let mockOllama: any;
  let mockPlanManager: any;
  let mockWorkspace: any;
  let mockPatchTool: any;
  let mockTerminal: any;
  let mockMemory: any;
  let mockConversation: any;
  let mockSkillManager: any;
  let mockMcpClient: any;

  beforeEach(() => {
    mockOllama = { chat: jest.fn() };
    mockPlanManager = { plan: jest.fn() };
    mockWorkspace = { readFile: jest.fn() };
    mockPatchTool = { applyPatch: jest.fn() };
    mockTerminal = { runCommand: jest.fn(), getDebugContext: jest.fn() };
    mockMemory = { search: jest.fn(), buildContext: jest.fn() };
    mockConversation = { getModelReadyHistory: jest.fn().mockReturnValue([]), addMessage: jest.fn() };
    mockSkillManager = {};
    mockMcpClient = { 
      listTools: jest.fn().mockResolvedValue([]),
      resolveToolByIntent: jest.fn(),
      callTool: jest.fn()
    };

    orchestrator = new TaskOrchestrator(
      mockOllama, mockPlanManager, mockWorkspace, mockPatchTool, 
      mockTerminal, mockMemory, mockConversation, mockSkillManager, mockMcpClient
    );
  });

  it('should run a simple task through the ReAct loop', async () => {
    const userRequest = 'Create a hello world file';
    
    // Mock Planning
    mockPlanManager.plan.mockResolvedValue({
      feature: 'Hello World',
      steps: ['Create file hello.txt'],
      files_to_read: [],
      search_queries: []
    });

    // Mock ReAct Step 1: Reason and produce patch
    mockOllama.chat.mockResolvedValueOnce(JSON.stringify({
      patches: [{ path: 'hello.txt', diff: '+++ hello.txt\n+Hello World' }],
      notes: ['Created hello.txt']
    }));

    // Mock Patch Apply
    mockPatchTool.applyPatch.mockResolvedValue({ success: true });

    // Mock final reasoning step to mark as done
    mockOllama.chat.mockResolvedValueOnce(JSON.stringify({ action: 'done' }));

    const result = await orchestrator.run(userRequest);

    expect(result.success).toBe(true);
    expect(result.patches.length).toBe(1);
    expect(result.subTasks[0].status).toBe('done');
  });

  it('should handle tool calls in the ReAct loop', async () => {
    const userRequest = 'Check documentation and then fix';
    
    mockPlanManager.plan.mockResolvedValue({
      feature: 'Doc Fix',
      steps: ['Check docs', 'Fix code'],
      files_to_read: [],
      search_queries: []
    });

    // Step 1: Agent calls a tool
    mockOllama.chat.mockResolvedValueOnce('CALL: search_docs { "query": "API" }');
    
    // Mock MCP resolution and call
    mockMcpClient.resolveToolByIntent.mockResolvedValue({
      serverName: 'Context7',
      tool: 'search_docs',
      params: { query: 'API' }
    });
    mockMcpClient.callTool.mockResolvedValue({ success: true, data: 'API docs say use X' });

    // Step 2: Agent now has observation and finishes
    mockOllama.chat.mockResolvedValueOnce(JSON.stringify({
      patches: [{ path: 'code.ts', diff: '+ Use X' }],
      notes: ['Updated based on docs']
    }));

    // Final reason: done
    mockOllama.chat.mockResolvedValueOnce(JSON.stringify({ action: 'done' }));

    // Patch apply
    mockPatchTool.applyPatch.mockResolvedValue({ success: true });

    const result = await orchestrator.run(userRequest);

    expect(result.success).toBe(true);
    expect(mockMcpClient.callTool).toHaveBeenCalled();
  });
});
