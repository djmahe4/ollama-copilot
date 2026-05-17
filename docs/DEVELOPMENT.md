# Development Guide

This document provides detailed information for developers who want to extend or modify the Ollama Copilot extension.

## Project Structure

```
ollama-copilot/
├── .vscode/
│   ├── launch.json          # Debug configuration
│   └── tasks.json           # Build tasks
├── resources/
│   └── icon.svg            # Extension icon
  ├── src/
  │   ├── extension.ts         # Main entry point & orchestration
  │   ├── agents/
  │   │   ├── planner.ts      # Planning agent
  │   │   ├── coder.ts        # Code generation agent
  │   │   └── tester.ts       # Testing & fixing agent
  │   ├── ollama/
  │   │   └── client.ts       # Ollama AI client
  │   ├── protocol/
  │   │   ├── types.ts        # TypeScript interfaces
  │   │   └── prompts.ts      # System prompts for agents
  │   ├── tools/
  │   │   ├── workspace.ts    # File operations
  │   │   ├── search.ts       # Code search
  │   │   ├── patch.ts        # Diff generation & application
  │   │   └── terminal.ts     # Command execution
  │   ├── utils/
  │   │   ├── memory-manager.ts # Hybrid LTM/STM memory system
  │   │   └── modular-splitter.ts # AST-lite code chunking
  │   └── ui/
  │       └── panel.ts        # Webview UI

├── package.json            # Extension manifest
├── tsconfig.json          # TypeScript configuration
├── .eslintrc.json        # Linting rules
└── README.md             # User documentation
```

## Core Components

### 1. Extension (extension.ts)

The main controller that:
- Initializes all components
- Manages session state
- Coordinates agent workflow
- Handles UI messages

Key class: `OllamaCopilotExtension`

### 2. Agents

#### Planner Agent (agents/planner.ts)
- **Input**: User request + workspace structure
- **Output**: JSON plan with files to read, search queries, and steps
- **LLM Call**: Single completion with JSON output
- **Retry**: Auto-retries on invalid JSON

#### Coder Agent (agents/coder.ts)
- **Input**: User request + plan + code context
- **Output**: Array of patches in unified diff format
- **LLM Call**: Single completion with JSON output
- **Context**: Gathers files from plan and search results

#### Tester Agent (agents/tester.ts)
- **Input**: Test output + relevant code files
- **Output**: Analysis + fix patches
- **LLM Call**: Single completion with JSON output
- **Features**: Extracts affected files from error messages

### 3. Tools

#### Workspace Tool (tools/workspace.ts)
Operations:
- `listFiles(glob)` - Find files matching pattern
- `readFile(path)` - Read file contents
- `createFile(path, content)` - Create new file
- `writeFile(path, content)` - Update existing file
- `getWorkspaceStructure()` - Get tree view

#### Search Tool (tools/search.ts)
Operations:
- `searchText(query)` - Full-text search
- `searchFiles(pattern)` - Find files by name
- `findDefinitions(symbol)` - Find where symbol is defined

#### Patch Tool (tools/patch.ts)
Operations:
- `applyPatch(patch)` - Apply unified diff
- `generatePreview(patches)` - Create preview text
- `showDiffInEditor(patch)` - Open file in editor

Features:
- Handles new file creation (`--- /dev/null`)
- Applies unified diff format
- Safe validation before writing

  #### Terminal Tool (tools/terminal.ts)
  Operations:
  - `runCommand(cmd)` - Execute whitelisted command
  - `runTests()` - Auto-detect and run tests
  - `runBuild()` - Auto-detect and run build
  
  Security:
  - Command whitelist enforcement
  - 60-second timeout
  - 10MB output buffer limit
  
  ### 4. Memory System (utils/memory-manager.ts)
  
  Implements a compounding knowledge base for the agent:
  - **LTM (Long-Term Memory)**: Persistent, vectorized index of the workspace.
  - **STM (Short-Term Memory)**: Session-specific cache for current tasks.
  - **Knowledge Compilation**: Indexes codebase using a modular splitting strategy.
  - **Semantic Search**: Uses Ollama embeddings to retrieve precise code context.
  - **Relation Graph**: Automatically maps imports, function calls, and class inheritance.
  - **Self-Healing**: Linting and pruning for orphans, contradictions, and outdated entries.
  
  ### 5. Ollama Client (ollama/client.ts)


HTTP client for Ollama API:
- `chat(messages)` - Non-streaming completion
- `chatStream(messages, onChunk)` - Streaming completion
- JSON request/response handling
- Error handling and retries

No external dependencies - uses Node's `http`/`https`.

### 5. UI (ui/panel.ts)

Webview panel with:
- Chat message display
- Progress indicator
- Diff preview with syntax highlighting
- Action buttons (Implement, Apply, Test, Clear)
- Real-time updates via messaging

## Data Flow

### Implement Feature Flow

```
1. User types request → Webview sends message
2. Extension calls PlannerAgent.plan()
   → Ollama generates plan
   → Extension displays plan in chat
3. Extension calls CoderAgent.generateCode()
   → Gathers context from workspace
   → Ollama generates patches
   → Extension displays patches in diff preview
4. User clicks "Apply Patches"
   → Extension calls PatchTool.applyPatch() for each
   → Reports success/failure
5. User clicks "Run Tests"
   → Extension calls TesterAgent.runTestsAndAnalyze()
   → If failures, generates fixes
   → Shows new patches for approval
```

### Message Flow (Extension ↔ Webview)

**Extension → Webview:**
```typescript
{ command: 'addMessage', type, content, timestamp }
{ command: 'updateProgress', message }
{ command: 'showDiffPreview', patches }
{ command: 'clearChat' }
```

**Webview → Extension:**
```typescript
{ command: 'implementFeature', request }
{ command: 'applyPatches' }
{ command: 'runTests' }
{ command: 'clearSession' }
```

## Extension Points

### Adding a New Agent

1. Create `src/agents/myagent.ts`:

```typescript
import { OllamaClient } from '../ollama/client';

export class MyAgent {
  constructor(private ollama: OllamaClient) {}

  async doSomething(input: string): Promise<Result> {
    const messages = [
      { role: 'system', content: 'You are...' },
      { role: 'user', content: input }
    ];

    const response = await this.ollama.chat(messages);
    return parseResponse(response);
  }
}
```

2. Register in `extension.ts`:

```typescript
this.myAgent = new MyAgent(this.ollama);
```

3. Use in workflow:

```typescript
const result = await this.myAgent.doSomething(data);
```

### Adding a New Tool

1. Create `src/tools/mytool.ts`:

```typescript
import { ToolResult } from '../protocol/types';

export class MyTool {
  async doOperation(input: string): Promise<ToolResult<Output>> {
    try {
      // Implementation
      return { success: true, data: output };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}
```

2. Initialize in extension constructor
3. Pass to agents that need it

### Customizing Prompts

Edit `src/protocol/prompts.ts`:

```typescript
export const MY_AGENT_PROMPT = `
You are an expert at...

Rules:
- Rule 1
- Rule 2

Output format: ...
`;
```

Use in agent:
```typescript
const messages = [
  { role: 'system', content: MY_AGENT_PROMPT },
  { role: 'user', content: userInput }
];
```

  ### Adding UI Actions
  
  1. Add button to webview HTML in `panel.ts`
  2. Add click handler that posts message:
  ```javascript
  myBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'myAction', data });
  });
  ```
  
  3. Handle in extension:
  ```typescript
  case 'myAction':
    await this.handleMyAction(message.data);
    break;
  ```
  
  ## Workspace Knowledge Management
  
  The extension maintains a local knowledge base in `.ollama-agentic/memory/`.
  
  ### Re-Indexing
  To force a re-compilation of the knowledge base:
  - Run command: `Llama A Coder: Index Workspace`
  - Use **Debug Mode** to override `.gitignore` and scan all matching files.
  
  ### Memory Maintenance
  To ensure the index remains high-signal:
  - Run command: `Llama A Coder: Lint Memory`
  - The system will identify:
    - **Orphans**: Unreferenced chunks.
    - **Contradictions**: Duplicate entries for the same code location.
    - **Outdated**: Chunks that no longer match the file on disk.
  - Select "Prune Now" to remove these entries.
  
  ## Best Practices


### Error Handling

Always wrap operations in try-catch:

```typescript
try {
  const result = await this.riskyOperation();
  this.panel.addMessage('assistant', 'Success!');
} catch (error) {
  this.panel.addMessage('error', `Failed: ${error}`);
  throw error; // Re-throw if needed
}
```

### Progress Updates

Keep users informed during long operations:

```typescript
this.panel.updateProgress('Step 1/3: Planning...');
await this.planner.plan(request, (msg) => 
  this.panel.updateProgress(msg)
);
```

### JSON Parsing

Use the parseJSON helper with retry logic:

```typescript
let result = this.parseJSON<MyType>(response);

if (!result) {
  // Retry with clarification
  messages.push({ role: 'user', content: 'Fix your JSON' });
  response = await this.ollama.chat(messages);
  result = this.parseJSON<MyType>(response);
}

if (!result) {
  throw new Error('Invalid JSON response');
}
```

### Resource Cleanup

Use VS Code's disposables:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('my.command', handler)
);
```

## Testing

### Manual Testing

1. Run extension (F5)
2. Open test workspace
3. Try various requests:
   - Simple tasks (single file)
   - Complex tasks (multiple files)
   - Invalid requests
   - Edge cases

### Testing Without Ollama

Mock the Ollama client:

```typescript
class MockOllamaClient extends OllamaClient {
  async chat(messages: OllamaMessage[]): Promise<string> {
    return JSON.stringify({
      feature: 'Test feature',
      // ... mock response
    });
  }
}
```

## Performance Optimization

### Context Gathering

Limit files read:
```typescript
for (const file of files.slice(0, 10)) { // Max 10 files
  // Read file
}
```

### Streaming for UI Responsiveness

Use streaming for long responses:
```typescript
await this.ollama.chatStream(
  messages,
  (chunk) => this.panel.updateProgress(chunk)
);
```

### Caching

Cache workspace structure:
```typescript
if (!this.cachedStructure) {
  this.cachedStructure = await this.workspace.getWorkspaceStructure();
}
```

## Security Considerations

### Command Execution

NEVER allow arbitrary commands:
```typescript
// ✗ WRONG
await exec(userInput);

// ✓ CORRECT
if (this.allowedCommands.includes(command)) {
  await exec(command);
}
```

### File Operations

Validate paths:
```typescript
const fullPath = path.join(workspaceRoot, relativePath);
if (!fullPath.startsWith(workspaceRoot)) {
  throw new Error('Path traversal attempt');
}
```

### User Confirmation

Always require approval for destructive actions:
```typescript
// Show preview first
this.panel.showDiffPreview(patches);

// Wait for user to click "Apply"
// (Handled via message passing)
```

## Debugging Tips

### Enable Verbose Logging

Add logging throughout:
```typescript
console.log('[Agent] Starting plan generation');
console.log('[Agent] Plan:', JSON.stringify(plan, null, 2));
```

View in: **Help → Toggle Developer Tools → Console**

### Breakpoint Debugging

1. Set breakpoints in TypeScript files
2. Press F5
3. Trigger the functionality
4. Step through code

### Inspect Messages

Log all webview messages:
```typescript
this.panel.onMessage(message => {
  console.log('[Message]', message);
  this.handleMessage(message);
});
```

### Test Ollama Directly

Use curl to test the model:
```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen2.5-coder:7b",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false
}'
```

## Common Issues

### "Cannot find module 'vscode'"

Run: `npm install`

### TypeScript errors about Node types

Make sure `tsconfig.json` includes:
```json
{
  "compilerOptions": {
    "types": ["node"]
  }
}
```

### Webview not updating

Check:
1. Messages are being sent: `console.log()` before `postMessage()`
2. Handler is registered: `this.panel.onMessage(...)`
3. Command matches: case-sensitive string matching

### Patches not applying

Common causes:
1. File changed since context was gathered
2. Diff format is malformed
3. Line numbers don't match

Debug: Add logging to `applyUnifiedDiff()` method

## Publishing

### Prepare for Publishing

1. Add icon: `resources/icon.png` (128x128)
2. Update README with screenshots
3. Test thoroughly
4. Update version in package.json
5. Add CHANGELOG.md

### Package Extension

```bash
npm install -g @vscode/vsce
vsce package
```

Creates `ollama-copilot-1.0.0.vsix`

### Install Locally

```bash
code --install-extension ollama-copilot-1.0.0.vsix
```

## Further Reading

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Ollama API Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Unified Diff Format](https://en.wikipedia.org/wiki/Diff#Unified_format)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

**Questions? Contributions welcome!**
