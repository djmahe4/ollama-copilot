/**
 * Conversation Manager
 * 
 * Handles short-term memory (STM) for the chat thread.
 * Implements history compaction (distillation) to prevent prompt bloat
 * and generates handover packets for seamless model transitions.
 */

import { OllamaClient } from '../ollama/client';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ConversationState {
  distilledSummary: string;
  lastCompactionTimestamp: number;
}

export class ConversationManager {
  private history: Message[] = [];
  private state: ConversationState = {
    distilledSummary: '',
    lastCompactionTimestamp: 0
  };
  
  /** Trigger compaction when history reaches this length. */
  private readonly compactionThreshold = 15;

  constructor(private readonly ollama: OllamaClient) {}

  /** Record a message in the conversation thread. */
  public addMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    this.history.push({ role, content, timestamp: Date.now() });
  }

  /** 
   * Compresses history by distilling it into a running summary.
   * Prunes old messages while preserving the core state.
   */
  public async compact(): Promise<void> {
    if (this.history.length < this.compactionThreshold) {
      return;
    }

    const historyText = this.history
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const prompt = `You are a memory distillation agent. 
Analyze the following conversation history and provide a concise, technical summary of:
1. The primary goal/objective of the user.
2. Key technical decisions made so far.
3. The current status of the task and pending items.

Keep the summary under 300 words. Focus on facts, not pleasantries.

Conversation History:
${historyText}`;

    try {
      const summary = await this.ollama.chat([
        { role: 'system', content: 'You are a memory distillation agent. Your goal is to condense a conversation into a precise state summary for another LLM to resume work.' },
        { role: 'user', content: prompt }
      ]);
      
      this.state.distilledSummary = summary;
      this.state.lastCompactionTimestamp = Date.now();
      
      // Keep the most recent messages to preserve immediate context and tonal continuity
      this.history = this.history.slice(-6);
    } catch (err) {
      console.error('[ConversationManager] Compaction failed:', err);
    }
  }

  /** 
   * Returns the prompt history optimized for the LLM.
   * Combines the distilled summary with the remaining short-term history.
   */
  public getModelReadyHistory(): Message[] {
    const systemContext: Message = {
      role: 'system',
      content: this.state.distilledSummary 
        ? `CONVERSATION STATE SUMMARY (Distilled Memory):\n${this.state.distilledSummary}\n\nContinue the conversation based on this state.`
        : 'You are an expert coding assistant. Help the user with their project.',
      timestamp: Date.now()
    };
    
    return [systemContext, ...this.history];
  }

  /** 
   * Generates a "Handover Packet" for model switching.
   * This is used to inject the current state as a system message to a new model.
   */
  public getHandoverPacket(): string {
    const recent = this.history.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
    return `[MODEL HANDOVER PACKET]\nTimestamp: ${new Date().toISOString()}\nState Summary: ${this.state.distilledSummary}\nRecent Context:\n${recent}`;
  }

  /** Clear all conversational state. */
  public clear(): void {
    this.history = [];
    this.state = { distilledSummary: '', lastCompactionTimestamp: 0 };
  }

  public getHistory(): readonly Message[] {
    return this.history;
  }
}
