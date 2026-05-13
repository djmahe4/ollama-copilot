import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * DebugLogger - Handles persistent terminal logging for the agent.
 * 
 * This utility ensures that all terminal output in debug mode is captured,
 * stored in the workspace, and made available for surgical reading (tail/grep).
 */
export class DebugLogger {
  private readonly logsDir: string;

  constructor(workspaceRoot: string) {
    this.logsDir = path.join(workspaceRoot, '.ollama-agentic', 'logs');
    this.ensureLogsDir();
  }

  private ensureLogsDir(): void {
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
    } catch (err) {
      console.error('[DebugLogger] Failed to create logs directory:', err);
    }
  }

  /**
   * Returns the path to a log file for a specific task or session.
   */
  getLogPath(taskId: string): string {
    return path.join(this.logsDir, `${taskId}.log`);
  }

  /**
   * Append output to a task log.
   */
  async appendLog(taskId: string, content: string): Promise<void> {
    try {
      const logPath = this.getLogPath(taskId);
      const timestamp = new Date().toISOString();
      const formatted = `[${timestamp}] ${content}\n`;
      await fs.promises.appendFile(logPath, formatted, 'utf8');
    } catch (err) {
      console.error(`[DebugLogger] Failed to write to log ${taskId}:`, err);
    }
  }

  /**
   * Clear logs for a specific task.
   */
  async clearLog(taskId: string): Promise<void> {
    try {
      const logPath = this.getLogPath(taskId);
      if (fs.existsSync(logPath)) {
        await fs.promises.unlink(logPath);
      }
    } catch (err) {
      console.error(`[DebugLogger] Failed to clear log ${taskId}:`, err);
    }
  }

  /**
   * List all available log files.
   */
  async listLogs(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.logsDir);
      return files.filter(f => f.endsWith('.log'));
    } catch {
      return [];
    }
  }
}
