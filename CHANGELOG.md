# Changelog

All notable changes to the "Llama A Coder" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-16

### Fork Bootstrap – PHASE 0 (DELTA TYPE: MODIFY / EXTEND)

#### Added
- **Extension rebrand**: displayName → "Llama A Coder", publisher → djmahe4, id → djmahe4.llama-A-coder
- **MCP Client stub** (`src/utils/mcp-client.ts`): `McpClientManager` with server registration, auto-discovery, reachability probing, Context7 auto-detection, and safe validated tool-call dispatch (SSE transport)
- **MCP configuration settings**:
  - `llamaACoder.mcpServers` – user-managed list of MCP server configs (name, url, transport, enabled)
  - `llamaACoder.mcpAutoDiscover` – auto-detect well-known MCP servers on activation (default: true)
  - `llamaACoder.mcpPreferContext7` – prefer Context7 for documentation lookups (default: true)
- **New commands** (all under "Llama A Coder" category):
  - `llama-a-coder.switchModel` – hot-swap Ollama model without reload
  - `llama-a-coder.generatePlan` – trigger Plan Mode from the command palette
  - `llama-a-coder.executeTask` – trigger Code Mode from the command palette
  - `llama-a-coder.applyPatch` – shortcut to apply staged patches
  - `llama-a-coder.reviewChanges` – open diff review for staged patches
  - `llama-a-coder.manageMcpServers` – QuickPick view of registered MCP servers
- **Graceful MCP deactivation**: `McpClientManager.dispose()` called via `context.subscriptions`

#### Changed
- Activity bar container title: "Ollama Copilot" → "Llama A Coder"
- Configuration section title: "Ollama Copilot" → "Llama A Coder"
- Activation/deactivation log messages updated to "Llama A Coder"
- Ready notification emoji updated to 🦙

#### Preserved (upstream compatibility)
- All upstream command IDs (`ollama-copilot.*`) remain registered unchanged
- Full multi-agent system (Planner, Coder, Tester agents) untouched
- Sidebar chat view type and provider unchanged
- Patch, search, terminal, workspace tools untouched
- Model selector, streaming, and session state logic untouched

## [1.1.1] - 2026-02-22

### Added
- **GitHub Actions CI/CD**: New workflow to build, lint, package `.vsix`, and publish on version tags
- **Release Automation**: Automatically creates GitHub releases and uploads packaged `.vsix` assets
- **Open VSX Support (Optional)**: Workflow can publish to Open VSX when `OVSX_PAT` is configured

### Changed
- **Chat Rendering**: Assistant messages now render with Copilot-like markdown behavior
  - Fenced code blocks with language labels
  - Copy button for code blocks
  - Support for headings, lists, blockquotes, separators, and simple tables
- **Message Formatting**: Improved inline formatting for code, bold, and italic text in chat

### Fixed
- **Agent JSON Parsing Reliability**: Centralized and hardened JSON extraction/parsing across Planner, Coder, and Tester agents
- **Tester Output Validation**: Added structure validation for generated test fixes before applying
- **Failure Context Extraction**: Improved test-error file path extraction and normalization for better fix context

## [1.1.0] - 2026-02-21

### Added
- **Sidebar Chat Interface**: Modern chat UI similar to GitHub Copilot in the Activity Bar
- **Three Intelligent Modes**:
  - 💻 Code Mode: Full implementation workflow
  - 📋 Plan Mode: Planning only without code generation
  - 💬 Ask Mode: Context-aware Q&A about codebase
- **Chat History**: Persistent conversation history across VS Code sessions
- **Stop Button**: Cancel long-running operations
- **Enhanced Workspace Intelligence**: Deep analysis of project structure and tech stack
- **Keyword Search**: Intelligent file discovery based on user queries
- **Cancellation Support**: Graceful handling of operation cancellation

### Changed
- Moved from panel UI to sidebar chat interface
- Improved workspace understanding with detailed tech stack detection
- Enhanced Ask mode with automatic context gathering
- Better error handling and user feedback

### Fixed
- TypeScript compilation issues
- Activation event warnings
- Model selector integration

## [1.0.0] - 2026-02-20

### Added
- Initial release
- Multi-agent system (Planner, Coder, Tester)
- Ollama integration with streaming support
- Model selector with status bar
- Unified diff patch system
- Terminal tool for safe command execution
- Workspace file operations
- Code search functionality
- Configuration system
- Webview panel UI

### Features
- Plan → Generate → Preview → Apply workflow
- Multi-file editing support
- Test integration and auto-fixing
- Local AI processing via Ollama
- Secure whitelisted command execution

[1.1.1]: https://github.com/YOUR_USERNAME/ollama-copilot/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/YOUR_USERNAME/ollama-copilot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/YOUR_USERNAME/ollama-copilot/releases/tag/v1.0.0
