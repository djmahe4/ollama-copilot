/**
 * Terminal tool for running commands with dynamic discovery and user-override
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CommandResult, ToolResult } from '../protocol/types';
import { ShellSession } from '../utils/shell-session';
import { DebugLogger } from '../utils/debug-logger';

const execAsync = promisify(exec);

export class TerminalTool {
  private allowedCommands: string[];
  private workspaceRoot: string;
  private _osType: 'win32' | 'darwin' | 'linux';
  private session: ShellSession;
  private logger: DebugLogger;
  private debugMode: boolean;

  public get osType(): 'win32' | 'darwin' | 'linux' {
    return this._osType;
  }

  constructor(allowedCommands: string[], workspaceRoot: string, logger: DebugLogger, debugMode: boolean = false) {
    this.allowedCommands = allowedCommands;
    this.workspaceRoot = workspaceRoot;
    this._osType = process.platform as 'win32' | 'darwin' | 'linux';
    this.session = new ShellSession(this.workspaceRoot, this._osType);
    this.logger = logger;
    this.debugMode = debugMode;
  }

  /**
   * Run a command. 
   * @param force If true, bypasses the whitelist (used when user explicitly approves via UI).
   * @param useSession If true, uses the persistent shell session (supporting 'cd' and state).
   * @param taskId Optional task ID to associate this command with for logging.
   */
  async runCommand(command: string, force = false, useSession = true, taskId?: string): Promise<ToolResult<CommandResult>> {
    try {
      if (!force && !this.isCommandAllowed(command)) {
        return {
          success: false,
          error: `Command not allowed: ${command}. Allowed commands: ${this.allowedCommands.join(', ')}`
        };
      }

      let finalCommand = command;
      
      // --- DEBUG MODE: REDIRECTION ---
      if (this.debugMode && taskId) {
        const logPath = this.logger.getLogPath(taskId);
        // Append stdout and stderr to the log file
        finalCommand = `${command} >> ${logPath} 2>&1`;
      }

      if (useSession) {
        const stdout = await this.session.execute(finalCommand);
        
        // If we redirected, stdout might be empty or just a success message.
        // We should still capture the actual result for the agent.
        let actualStdout = stdout;
        if (this.debugMode && taskId) {
          // In debug mode, we might want to return the last N lines of the log as the result
          actualStdout = await this.getDebugContext(this.logger.getLogPath(taskId), ''); 
        }

        return {
          success: true,
          data: {
            exitCode: 0,
            stdout: actualStdout.trim(),
            stderr: '' 
          }
        };
      }

      // Fallback to one-off exec for non-session commands
      let execCommand = finalCommand;
      if (this.osType === 'win32' && !execCommand.startsWith('powershell')) {
        execCommand = `cmd /c ${execCommand}`;
      }

      const { stdout, stderr } = await execAsync(execCommand, {
        cwd: this.workspaceRoot,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024
      });

      return {
        success: true,
        data: {
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Command execution failed: ${error.message}`,
        data: {
          exitCode: error.code || 1,
          stdout: error.stdout?.trim() || '',
          stderr: error.stderr?.trim() || error.message
        }
      };
    }
  }

  /**
   * Check if a tool is available on the system.
   * Returns the version string if found, otherwise null.
   */
  async checkToolExists(tool: string): Promise<string | null> {
    try {
      const cmd = this._osType === 'win32' ? `where ${tool}` : `which ${tool}`;
      const result = await this.runCommand(cmd, true, false);
      if (result.success && result.data?.stdout) {
        // Use the first line of output as the path/version indicator
        return result.data.stdout.split('\n')[0].trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Retrieve a snippet of code or log around a specific search term.
   * Uses OS-specific tools to ensure line numbers and context are captured.
   */
  async getDebugContext(filePath: string, searchSnippet: string): Promise<string> {
    try {
      let command = '';
      const escapedSnippet = searchSnippet.replace(/"/g, '\\"');

      if (this.osType === 'win32') {
        // If searchSnippet is empty, just get the last 50 lines
        if (!searchSnippet) {
          command = `powershell -Command "Get-Content -Path '${filePath}' -Tail 50 | ForEach-Object { \"Line $\_\n\_\_ : $\_\_\" }"`; 
          // Note: The above is a placeholder, I'll refine the Win command below
          command = `powershell -Command "Get-Content -Path '${filePath}' -Tail 50"`;
        } else {
          command = `powershell -Command "Get-Content -Path '${filePath}' | Select-String -Pattern '${escapedSnippet}' -Context 5,5 | ForEach-Object { \"Line $($_\.LineNumber): $($_\.Line)\"; if($_\.Context.PreContext) { $\_\.Context.PreContext | ForEach-Object { \"Line $($_\.LineNumber): $($_\.Line)\" } }; if($_\.Context.PostContext) { $\_\.Context.PostContext | ForEach-Object { \"Line $($_\.LineNumber): $($_\.Line)\" } }"`;
        }
      } else {
        if (!searchSnippet) {
          command = `tail -n 50 "${filePath}"`;
        } else {
          command = `grep -nC 5 "${escapedSnippet}" "${filePath}"`;
        }
      }

      const result = await this.runCommand(command, true, false);
       return result.success && result.data ? result.data.stdout : `Could not retrieve context: ${result.error}`;
    } catch (error: any) {
      return `Error retrieving context: ${error.message}`;
    }
  }

  private isCommandAllowed(command: string): boolean {
    const trimmedCommand = command.trim();
    return this.allowedCommands.some(allowed => {
      return trimmedCommand === allowed || trimmedCommand.startsWith(allowed + ' ');
    });
  }

  async showInTerminal(command: string, output: string): Promise<void> {
    const terminal = vscode.window.createTerminal('Ollama Copilot');
    terminal.show();
    terminal.sendText(`# Command: ${command}`);
    terminal.sendText(`# Output:\n${output}`);
  }

  async runTests(): Promise<ToolResult<CommandResult>> {
    const testCommands = ['npm test', 'pnpm test', 'pytest', 'npm run test'];
    for (const cmd of testCommands) {
      if (this.isCommandAllowed(cmd)) {
        return await this.runCommand(cmd);
      }
    }
    return { success: false, error: 'No allowed test command found' };
  }

  async runBuild(): Promise<ToolResult<CommandResult>> {
    const buildCommands = ['npm run build', 'pnpm build'];
    for (const cmd of buildCommands) {
      if (this.isCommandAllowed(cmd)) {
        return await this.runCommand(cmd);
      }
    }
    return { success: false, error: 'No allowed build command found' };
  }

  setAllowedCommands(commands: string[]): void {
    this.allowedCommands = commands;
  }

  dispose() {
    this.session.dispose();
  }
}

