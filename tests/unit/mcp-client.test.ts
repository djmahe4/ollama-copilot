import { McpClientManager } from '../../src/utils/mcp-client';
import * as vscode from 'vscode';
import * as http from 'http';

jest.mock('vscode', () => ({
  workspace: {
    getConfiguration: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(true),
    }),
  },
}));

jest.mock('http');

describe('McpClientManager', () => {
  let mcpClient: McpClientManager;
  let mockContext: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockContext = { subscriptions: [] };
    mcpClient = new McpClientManager(mockContext);
  });

  it('should register a server from config', () => {
    const config = { name: 'TestServer', url: 'http://localhost:1234', enabled: true };
    mcpClient.registerServer(config);
    
    const registered = mcpClient.getRegisteredServers();
    expect(registered).toContainEqual(config);
  });

  it('should return empty tools if no servers are reachable', async () => {
    const tools = await mcpClient.listTools();
    expect(tools).toEqual([]);
  });

  it('should resolve tool by intent using Ollama', async () => {
    const mockOllama = {
      chat: jest.fn().mockResolvedValue(JSON.stringify({
        serverName: 'Context7',
        tool: 'search_docs',
        params: { query: 'test' }
      }))
    };

    // Register a server so it's reachable for the test
    mcpClient.registerServer({ name: 'Context7', url: 'http://localhost:7070', enabled: true });
    (mcpClient as any).servers.get('Context7').reachable = true;

    const resolution = await mcpClient.resolveToolByIntent('Find some docs', mockOllama);
    
    expect(resolution).toEqual({
      serverName: 'Context7',
      tool: 'search_docs',
      params: { query: 'test' }
    });
  });

  it('should return null when intent resolution fails', async () => {
    const mockOllama = {
      chat: jest.fn().mockResolvedValue('null')
    };
    
    mcpClient.registerServer({ name: 'Context7', url: 'http://localhost:7070', enabled: true });
    (mcpClient as any).servers.get('Context7').reachable = true;

    const resolution = await mcpClient.resolveToolByIntent('unknown', mockOllama);
    expect(resolution).toBeNull();
  });
});
