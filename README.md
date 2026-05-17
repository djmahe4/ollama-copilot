# Llama A Coder

> 🦙 **A production-grade, fully local agentic coding assistant powered by Ollama**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.75+-blue.svg)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/djmahe4/ollama-copilot)

**Llama A Coder** (`djmahe4.llama-a-coder`) is a VS Code extension that brings a full agentic coding pipeline to your editor, running **entirely on your local machine** using [Ollama](https://ollama.ai).

It is a structured evolution of [ollama-copilot](https://github.com/anandof28/ollama-copilot), extended with an agentic core, project-based embeddings memory, MCP server integration, 30 mandatory optimization techniques, and a complete target module structure — while preserving all upstream behaviour.

---

## ✨ What's New in v1.2.0

| Area | What was added |
|------|---------------|
| **Agentic Core** | Tree-of-Thought planner, ReAct task orchestrator, multi-pass verifier, self-critique engine |
| **Memory RAG** | Local file-based embeddings store (`.ollama-agentic/memory/`) with <100 ms vector search |
| **MCP Support** | Independent MCP server discovery/registration; Context7 auto-detection |
| **Ollama** | True hot-swap model switching, multi-model routing, streaming handler with cancellation |
| **UI** | Status bar, quick-pick model selector, CSP-ready webview helpers, accessibility + i18n hooks |
| **Commands** | `switchModel`, `generatePlan`, `executeTask`, `applyPatch`, `reviewChanges`, `manageMcpServers` |
| **Providers** | Lazy inline completions, lightbulb code actions (fix / refactor / explain) |
| **Cross-platform** | All search, file, and process operations work identically on Windows, macOS, Linux |

---

## 🚀 Features

### 🧠 Three Intelligent Modes (upstream, preserved)

- **💻 Code Mode** — Full Plan → Generate → Preview → Apply pipeline
- **📋 Plan Mode** — Hierarchical implementation plan with Tree-of-Thought reasoning
- **💬 Ask Mode** — Context-aware Q&A with workspace RAG

### ⚙️ Agentic Pipeline

```
User Request
    │
    ▼
PlanManager (Tree-of-Thought, 3 branches)
    │
    ▼
TaskOrchestrator (ReAct loop, parallel safe batches)
    │   ├── MemoryManager.search() ← pre-step context retrieval
    │   └── OllamaClient.chat()    ← model call with memory context
    ▼
PatchApplier (dry-run validation → apply → MemoryManager.indexPatches())
    │
    ▼
Verifier (spec-first + self-consistency, memory-augmented)
    │
    ▼
SelfCritique (static security scan + LLM quality pass)
```

### 🗄️ Project-Based Embeddings Memory

A fully local, zero-server vector store that learns your codebase:

- **Storage**: `.ollama-agentic/memory/vectors.jsonl` (JSONL, git-ignored)
- **Indexing**: After every successful patch, changed functions/variables are re-embedded and stored with precise line metadata
- **Search**: Cosine similarity search in <100 ms against an in-memory index
- **Embeddings**: Ollama `/api/embeddings` (e.g. `nomic-embed-text`) with automatic feature-hashing TF-IDF fallback — works even without a dedicated embedding model
- **Non-blocking**: All writes use `queueMicrotask` + `setImmediate`; <50 ms overhead on the main pipeline
- **Incremental**: Only changed modules are re-embedded (uses `splitIntoModules` for chunk-level granularity)

### 🔌 MCP Server Support

Connect any [Model Context Protocol](https://modelcontextprotocol.io) server for real-time docs and API lookup:

- Auto-discover common servers (Context7 recommended)
- stdio or SSE transport
- All tool calls validated and sandboxed
- Fallback to workspace RAG when no MCP is available

### 🔍 Cross-Platform Workspace Search

`ragSearch()` tries four strategies in order, so it always works:

| # | Strategy | When used |
|---|----------|-----------|
| 1 | `rg` (ripgrep) | If installed; respects `.gitignore` automatically |
| 2 | `grep -rn` | macOS / Linux built-in |
| 2 | `findstr /S /N` | Windows built-in |
| 3 | Pure Node.js walker | Always available; honours `.gitignore` |

All strategies skip `.gitignore`-listed paths (venv, node_modules, dist, etc.).  
Pass `{ ignoreGitignore: true }` to `ragSearch()` to override for debugging.

---

## 📦 Installation

### Prerequisites

1. **VS Code** 1.75 or later
2. **Ollama** running locally ([install guide](https://ollama.ai/download))
3. A code model pulled, e.g.:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```
4. _(Optional)_ An embedding model for enhanced memory search:
   ```bash
   ollama pull nomic-embed-text
   ```

### Install from Marketplace

Search for **Llama A Coder** in the VS Code Extensions panel, or:

```bash
code --install-extension djmahe4.llama-a-coder
```

### Install from Source

```bash
git clone https://github.com/djmahe4/ollama-copilot
cd ollama-copilot
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host
```

---

## ⚙️ Configuration

All settings are under `ollamaCopilot.*` and `llamaACoder.*`.

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.apiUrl` | `http://localhost:11434` | Ollama API base URL |
| `ollamaCopilot.model` | `qwen2.5-coder:7b` | Active code model |
| `ollamaCopilot.temperature` | `0.1` | Model temperature |
| `llamaACoder.embeddingModel` | `nomic-embed-text` | Embedding model for memory store |
| `llamaACoder.mcpServers` | `[]` | MCP server configurations |
| `llamaACoder.mcpAutoDiscover` | `true` | Auto-discover known MCP servers on activation |
| `llamaACoder.mcpPreferContext7` | `true` | Prefer Context7 for documentation lookups |

### MCP Server Example

```jsonc
// .vscode/settings.json
{
  "llamaACoder.mcpServers": [
    {
      "name": "context7",
      "url": "https://mcp.context7.com/mcp",
      "transport": "sse",
      "enabled": true
    }
  ]
}
```

---

## 🎮 Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `Llama A Coder: Switch Model` | — | Hot-swap the active Ollama model |
| `Llama A Coder: Generate Plan` | — | Tree-of-Thought implementation plan |
| `Llama A Coder: Execute Task` | — | Full Plan→Code→Patch pipeline |
| `Llama A Coder: Apply Patch` | — | Apply staged patches to workspace |
| `Llama A Coder: Review Changes` | — | Diff preview + SelfCritique analysis |
| `Llama A Coder: Manage MCP Servers` | — | View/manage connected MCP servers |

All upstream commands (`ollama-copilot.*`) remain fully functional.

---

## 🏗️ Architecture

```
src/
├── agentic-core/
│   ├── plan-manager.ts       ← Tree-of-Thought planner (wraps upstream PlannerAgent)
│   ├── task-orchestrator.ts  ← ReAct loop + parallel batching + memory context
│   ├── patch-applier.ts      ← Validated patch apply + memory indexing trigger
│   ├── verifier.ts           ← Spec-first + self-consistency + memory context
│   └── self-critique.ts      ← Static security scan + LLM quality passes
├── ollama/
│   ├── client.ts             ← Upstream (unchanged)
│   ├── model-manager.ts      ← Multi-model routing + hot-swap + rate limiting
│   └── streaming-handler.ts  ← Cancellable streaming, memory-safe, retry
├── ui/
│   ├── sidebar-provider.ts   ← Composes ChatViewProvider + StatusBar
│   ├── chat-webview.ts       ← CSP nonces, HTML escaping, ARIA, i18n helpers
│   ├── status-bar.ts         ← Lazy-loaded status bar item
│   └── quick-pick-models.ts  ← Model picker with hot-swap
├── commands/                 ← One file per command (switch-model, generate-plan, …)
├── providers/
│   ├── completion-provider.ts  ← Lazy inline completions, debounced
│   └── code-action-provider.ts ← Fix / Refactor / Explain lightbulb actions
└── utils/
    ├── memory-manager.ts     ← ★ Embeddings RAG store (JSONL, cosine search)
    ├── mcp-client.ts         ← MCP server discovery + tool-call gateway
    ├── modular-splitter.ts   ← Cross-platform RAG search + code splitting
    ├── optimization-engine.ts← Chunking, prompt compression, instrumentation
    ├── diff-utils.ts         ← Git-friendly minimal diff helpers
    └── safe-fs.ts            ← Path-traversal-safe file I/O
```

---

## 🛡️ Security

- No `eval()`, `innerHTML` assignment, or dynamic code execution
- All file paths validated against workspace root (path-traversal prevention)
- Content Security Policy nonces on all webview HTML
- Input sanitised before any shell-adjacent operation
- Untrusted workspace guard on completion and code-action providers
- All MCP tool calls validated and sandboxed

---

## 🔧 30 Optimization Techniques

Every module implements a subset of the mandatory optimization techniques:

| # | Technique | Where |
|---|-----------|-------|
| 1 | Context-window chunking | `optimization-engine`, `plan-manager` |
| 2 | Prompt compression | `optimization-engine`, `plan-manager`, `self-critique` |
| 3 | Spec-first development | `verifier` |
| 4 | Tree-of-Thought reasoning | `plan-manager` |
| 5 | ReAct loop | `task-orchestrator` |
| 6 | Self-consistency | `verifier`, `self-critique` |
| 7 | Workspace RAG | `modular-splitter`, `memory-manager` |
| 8 | Dependency injection | all agentic-core modules |
| 9 | Performance instrumentation | `optimization-engine` (spans) |
| 10 | Memory leak prevention | `streaming-handler`, `sidebar-provider`, `memory-manager` |
| 11 | Immutable data structures | all result types |
| 12 | Zero-allocation critical paths | `streaming-handler` |
| 13 | Lazy loading | `status-bar`, `completion-provider` |
| 14 | Dynamic imports | `completion-provider`, `code-action-provider` |
| 15 | Retry + exponential backoff | `task-orchestrator`, `model-manager`, `streaming-handler` |
| 16 | Rate limiting | `task-orchestrator`, `model-manager` |
| 17 | Multi-model routing | `model-manager` |
| 18 | Automatic code splitting | `modular-splitter` |
| 19 | Barrel exports | `*/index.ts` files |
| 20 | Strict type guards | `self-critique`, `code-action-provider` |
| 21 | Exhaustive switch/case | `self-critique`, `code-action-provider`, `chat-webview` |
| 22 | Security validation | `safe-fs`, `self-critique`, `modular-splitter` |
| 23 | CSP-ready patterns | `chat-webview` |
| 24 | Accessibility hooks | `chat-webview`, `sidebar-provider` |
| 25 | Internationalization | `chat-webview`, `status-bar`, `quick-pick-models` |
| 26 | Git-friendly minimal diffs | `diff-utils`, `patch-applier` |
| 27 | Incremental compilation | `tsconfig.json` (`incremental: true`) |
| 28 | Parallel task execution | `task-orchestrator` |
| 29 | Auto documentation generation | `optimization-engine` |
| 30 | Dead code elimination awareness | `optimization-engine` (export registry) |

---

## 📄 License

MIT © [djmahe4](https://github.com/djmahe4)

Upstream work © [anandof28](https://github.com/anandof28/ollama-copilot) — MIT

Ollama Copilot is a VS Code extension that brings GitHub Copilot-like AI assistance directly to your editor, running **entirely on your local machine** using [Ollama](https://ollama.ai). Unlike simple chat extensions, this is a full **agentic system** with multi-mode support for planning, coding, and Q&A.

## ✨ Features

### 🎯 Three Intelligent Modes

- **💻 Code Mode**: Full implementation workflow - plan → generate → preview → apply
- **📋 Plan Mode**: Create detailed implementation plans without code generation  
- **💬 Ask Mode**: Context-aware Q&A about your codebase

### 🚀 Core Capabilities

- **🧠 Multi-Agent System**: Specialized agents for planning, coding, and testing
- **🔍 Workspace Intelligence**: Deep understanding of your project structure and tech stack
- **📝 Multi-File Editing**: Make coordinated changes across multiple files
- **👀 Safe Previews**: Review unified diffs before applying any changes
- **✅ Test Integration**: Automatically run tests and iterate on failures
- **🎨 Modern UI**: Clean sidebar chat interface similar to GitHub Copilot
- **📚 Chat History**: Persistent conversation history across sessions
- **⏹️ Cancellation Support**: Stop long-running operations at any time
- **🏠 100% Local**: All AI processing happens on your machine via Ollama
- **🔒 Secure**: Whitelisted command execution for safety

## 📋 Prerequisites

### 1. Install Ollama

Download and install Ollama from [ollama.ai](https://ollama.ai)

### 2. Pull a Model

```bash
# Recommended: Qwen 2.5 Coder (7B)
ollama pull qwen2.5-coder:7b

# Or try other models:
ollama pull codellama:7b
ollama pull deepseek-coder:6.7b
ollama pull mistral:7b
```

### 3. Start Ollama Server

```bash
ollama serve
```

## 🔧 Installation

### From VSIX (Recommended)

1. Download the latest `.vsix` file from [Releases](../../releases)
2. Open VS Code
3. Press `Cmd+Shift+X` (macOS) or `Ctrl+Shift+X` (Windows/Linux) to open Extensions
4. Click the `...` menu → **Install from VSIX...**
5. Select the downloaded `.vsix` file
6. Reload VS Code when prompted

### From Source

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/ollama-copilot.git
cd ollama-copilot

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package extension
npx vsce package --allow-missing-repository

# Install the .vsix file in VS Code
```

## 🎯 Quick Start

### 1. Open the Chat Sidebar

Click the 🤖 **Ollama Copilot** icon in the Activity Bar (left sidebar)

### 2. Select Your Model

Use the dropdown at the top of the chat to choose your preferred Ollama model

### 3. Choose a Mode

- **💻 Code** - Full implementation workflow
- **📋 Plan** - Planning only
- **💬 Ask** - Q&A with workspace context

### 4. Start Chatting!

**Example prompts:**

```
Code Mode:
"Add a login form with email validation"
"Refactor the UserService to use dependency injection"
"Create a REST API endpoint for user registration"

Plan Mode:
"How should I implement user authentication?"
"What's the best way to add caching to this API?"

Ask Mode:
"What does the fetchData function in api.ts do?"
"How is error handling implemented in this codebase?"
"Where is the database connection configured?"
```

## 🏗️ Architecture

```
ollama-copilot/
├── src/
│   ├── extension.ts          # Main extension controller
│   ├── agents/                # AI agents
│   │   ├── planner.ts        # Implementation planning
│   │   ├── coder.ts          # Code generation
│   │   └── tester.ts         # Test execution & fixing
│   ├── ollama/               # Ollama integration
│   │   ├── client.ts         # HTTP client for Ollama API
│   │   └── modelSelector.ts  # Model selection UI
│   ├── tools/                # Workspace operations
│   │   ├── workspace.ts      # File I/O and structure
│   │   ├── search.ts         # Code search
│   │   ├── patch.ts          # Unified diff application
│   │   └── terminal.ts       # Command execution
│   ├── ui/                   # User interface
│   │   └── chatView.ts       # Sidebar chat panel
│   └── protocol/             # Type definitions
│       ├── types.ts          # TypeScript interfaces
│       └── prompts.ts        # System prompts
└── docs/                     # Documentation
```

## ⚙️ Configuration

Open VS Code Settings (`Cmd+,` or `Ctrl+,`) and search for "Ollama Copilot":

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.apiUrl` | `http://localhost:11434` | Ollama API base URL |
| `ollamaCopilot.model` | `qwen2.5-coder:7b` | Default Ollama model |
| `ollamaCopilot.temperature` | `0.1` | Model temperature (0-2) |
| `ollamaCopilot.maxTokens` | `4000` | Maximum tokens to generate |
| `ollamaCopilot.allowedCommands` | `["npm test", ...]` | Whitelisted terminal commands |

## 🎨 Features in Detail

### Code Mode: Full Implementation

1. **Planning Phase**: AI analyzes your request and workspace to create an implementation plan
2. **Code Generation**: Generates code changes across multiple files
3. **Preview**: Shows unified diffs of all proposed changes
4. **Apply**: Safely applies patches to your workspace
5. **Testing**: Runs tests and iterates if failures occur

### Plan Mode: Architecture Planning

- Creates detailed implementation plans without generating code
- Perfect for understanding how to approach complex features
- Lists files to modify, steps to take, and considerations
- Switch to Code mode to implement the plan

### Ask Mode: Intelligent Q&A

- Context-aware answers based on your actual codebase
- Searches and reads relevant files automatically
- References specific code and file locations
- No code modifications, just helpful information

### Chat History

- Conversations persist across VS Code sessions
- Stored locally in VS Code's global state
- Automatically trimmed to last 100 messages
- Clear chat anytime with dedicated button

### Stop Button

- Cancel long-running operations
- Appears during AI processing
- Safe cancellation at natural breakpoints
- Resume with new prompts

## 🛠️ Development

### Setup

```bash
npm install
npm run compile
```

### Run & Debug

Press `F5` in VS Code to launch the extension in a new Extension Development Host window

### Package

```bash
npm run package
# Creates ollama-copilot-X.X.X.vsix
```

### Lint

```bash
npm run lint
```

## 📖 Documentation

- [Getting Started Guide](docs/GETTING_STARTED.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Installation Guide](docs/INSTALL.md)
- [Model Selector](docs/MODEL_SELECTOR.md)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Ollama](https://ollama.ai) - For making local LLMs accessible
- [VS Code](https://code.visualstudio.com/) - For the amazing extension API
- Inspired by [GitHub Copilot](https://github.com/features/copilot) and [Aider](https://github.com/paul-gauthier/aider)

---

**Made with ❤️ for the open source community**
