# 🧠 Compounding Memory System (Knowledge Compilation)

## Executive Summary
The Compounding Memory System transforms the "Llama A Coder" extension from a stateless chat interface into a durable, knowledge-aware agent. Instead of relying solely on the limited context window of an LLM, the system "compiles" the workspace into a persistent, vectorized knowledge base (LTM) and a short-term session cache (STM). This allows the agent to maintain a deep, line-level understanding of the entire codebase, surfacing precise context during the ReAct loop.

---

## 🏗️ Architecture Overview

### The Hybrid Memory Model
The system utilizes a two-tier storage architecture to balance long-term stability with session-specific agility.

| Tier | Scope | Persistence | Primary Use Case |
| :--- | :--- | :--- | :--- |
| **Short-Term Memory (STM)** | Session/Task | In-Memory | Tracking current progress, intermediate results, and immediate observations. |
| **Long-Term Memory (LTM)** | Project/Workspace | File-backed (`.ollama-agentic/`) | Global codebase knowledge, architectural patterns, and historical decisions. |

### Storage Strategy
To ensure performance and transparency, the system avoids external databases in favor of a local, file-based approach:
- **`.ollama-agentic/memory/vectors.jsonl`**: An append-only JSON Lines file containing the vectorized chunks. This allows for high-speed incremental writes without rewriting the entire index.
- **`.ollama-agentic/memory/memory.json`**: A metadata file storing the relation map, indexing statistics, and vector dimensions.

---

## 🛠️ Core Components

### 1. `MemoryManager`
The central orchestrator for the memory lifecycle. It handles:
- **Initialization**: Loading the index from disk and establishing the store directory.
- **Indexing Pipeline**: Coordinating the flow from raw files to vectorized entries.
- **Semantic Retrieval**: Performing cosine similarity searches against the in-memory vector index.
- **State Persistence**: Managing the asynchronous flush of "dirty" entries to disk.

### 2. `ModularSplitter`
Instead of fixed-size windowing (which breaks semantic meaning), the system uses a logical splitting strategy. It identifies "modules" (functions, classes, blocks) based on structural markers, ensuring that a single memory entry contains a complete, coherent piece of logic.

---

## 🔄 The Knowledge Pipeline

The process of turning a codebase into a "compiled" knowledge base follows four distinct phases:

### Phase 1: Git-Aware Indexing
The system scans the workspace for files matching specific include patterns (`.ts`, `.py`, `.md`, etc.). It strictly respects `.gitignore` to avoid indexing build artifacts or dependencies, though a **Debug Mode** can override this for comprehensive analysis.

### Phase 2: Semantic Embedding
Each modular chunk is passed through the Ollama `/api/embeddings` endpoint (using models like `nomic-embed-text`).
- **Contextualization**: The system often generates a one-sentence description of the chunk using the chat model before embedding, increasing retrieval precision.
- **Fallback**: If the embedding model is unavailable, the system falls back to a deterministic **Feature-Hashing TF-IDF** embedding to maintain basic searchability.

### Phase 3: Relation Discovery (The Knowledge Graph)
The system analyzes the indexed chunks to build a directed graph of dependencies:
- **`imports`**: Detected via regex analysis of import/require statements.
- **`calls`**: Detected by matching entity names against call patterns (e.g., `functionName(`).
- **`extends`**: Detected via class inheritance keywords.
- **`mentions`**: Detected when one chunk's description appears in another's content.

### Phase 4: Retrieval & Injection
During the `TaskOrchestrator` ReAct loop, the agent generates a query based on the current subtask. The `MemoryManager` performs a semantic search and injects the top-K most relevant chunks as comments at the top of the prompt, providing the LLM with precise "ground truth" code.

---

## 🧹 Maintenance & Health

To prevent "knowledge rot," the system includes a built-in linting and pruning engine:

### Knowledge Linting
The `lintMemory()` process identifies three types of issues:
1. **Orphans**: Entries that are not referenced by any other entity and are not file roots.
2. **Contradictions**: Multiple entries claiming the same file coordinate (path:line), usually caused by inconsistent indexing.
3. **Outdated**: Entries whose content no longer matches the current state of the file on disk.

### Pruning
Users can atomically remove problematic entries via the `pruneMemory` command, triggering a compaction of the `.jsonl` store to reclaim space and improve search speed.

---

## ⚙️ Configuration & Usage

### VS Code Settings
```json
{
  "ollamaCopilot.embeddingModel": "nomic-embed-text",
  "ollamaCopilot.apiUrl": "http://localhost:11434"
}
```

### Available Commands
- **`Llama A Coder: Index Workspace`**: Triggers full knowledge compilation.
- **`Llama A Coder: Lint Memory`**: Runs a health check and offers to prune invalid entries.

---

## 📋 Design Rationale

| Decision | Rationale |
| :--- | :--- |
| **JSONL over SQLite** | Zero dependencies, human-readable, Git-versionable, and extremely fast for append-only writes. |
| **AST-lite Splitting** | Preserves the semantic boundary of functions/classes, preventing the "cut-off" problem of fixed-window RAG. |
| **Local Embeddings** | Maintains 100% privacy and removes latency/cost associated with cloud embedding APIs. |
| **Cosine Similarity** | Standard, efficient metric for comparing normalized high-dimensional vectors. |
