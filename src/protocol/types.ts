/**
 * Protocol types for Ollama Copilot extension
 */

// Ollama API types
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
  };
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
}

// Agent Plan types
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SubTask {
  readonly id: string;
  description: string;
  status: TaskStatus;
  result?: string;
  summary?: string; // Compressed summary of the result
  error?: string;
}

export interface PlannerOutput {
  feature: string;
  assumptions: string[];
  files_to_read: string[];
  search_queries: string[];
  steps: string[];
}

// Coder types
export interface Patch {
  path: string;
  diff: string;
}

export interface CoderOutput {
  patches: Patch[];
  notes: string[];
}

// Test Agent types
export interface TestResult {
  success: boolean;
  output: string;
  errors: string[];
}

export interface TestFix {
  analysis: string;
  patches: Patch[];
}

// Session state
export interface SessionState {
  userRequest: string;
  plan: PlannerOutput | null;
  context: FileContext[];
  patches: Patch[];
  appliedPatches: string[];
  testResults: TestResult | null;
}

// File context
export interface FileContext {
  path: string;
  content: string;
  relevance?: string;
}

// Tool types
export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// UI Message types
export interface UIMessage {
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: number;
}

export interface DiffPreview {
  patches: Patch[];
  preview: string;
}

// Command execution
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
