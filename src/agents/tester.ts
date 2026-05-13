/**
 * Tester Agent - Runs tests and generates fixes
 */

import { OllamaClient } from '../ollama/client';
import { TestFix, OllamaMessage, FileContext, Patch } from '../protocol/types';
import { TESTER_SYSTEM_PROMPT, buildTesterPrompt } from '../protocol/prompts';
import { TerminalTool } from '../tools/terminal';
import { WorkspaceTool } from '../tools/workspace';
import * as path from 'path';
import { parseJsonObject, parseAndRetryJson } from './jsonParser';

export class TesterAgent {
  private ollama: OllamaClient;
  private terminal: TerminalTool;
  private workspace: WorkspaceTool;

  constructor(ollama: OllamaClient, terminal: TerminalTool, workspace: WorkspaceTool) {
    this.ollama = ollama;
    this.terminal = terminal;
    this.workspace = workspace;
  }

  /**
   * Run tests and analyze failures
   */
  async runTestsAndAnalyze(
    onProgress?: (message: string) => void
  ): Promise<{ success: boolean; output: string; fix?: TestFix }> {
    try {
      // Run tests
      onProgress?.('Running tests...');
      const testResult = await this.terminal.runTests();

      if (!testResult.data) {
        return {
          success: false,
          output: testResult.error || 'Test execution failed'
        };
      }

      const { exitCode, stdout, stderr } = testResult.data;
      const output = `${stdout}\n${stderr}`.trim();

      // If tests passed, we're done
      if (exitCode === 0) {
        onProgress?.('All tests passed!');
        return {
          success: true,
          output
        };
      }

      // Tests failed - analyze and generate fix
      onProgress?.('Tests failed. Analyzing failures...');
      const fix = await this.generateFix(output, onProgress);

      return {
        success: false,
        output,
        fix
      };

    } catch (error) {
      return {
        success: false,
        output: `Test execution error: ${error}`
      };
    }
  }

  /**
   * Generate a fix for test failures
   */
  async generateFix(
    testOutput: string,
    onProgress?: (message: string) => void
  ): Promise<TestFix> {
    try {
      // Extract file names from error output
      const affectedFiles = this.extractAffectedFiles(testOutput);

      // Gather context
      onProgress?.('Gathering context for fix...');
      const context: FileContext[] = [];
      
      for (const filePath of affectedFiles.slice(0, 5)) {
        const result = await this.workspace.readFile(filePath);
        if (result.success && result.data) {
          context.push({
            path: filePath,
            content: result.data
          });
        }
      }

      // Build prompt
      const userPrompt = buildTesterPrompt(testOutput, context);

      // Call Ollama
      const messages: OllamaMessage[] = [
        { role: 'system', content: TESTER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];

      onProgress?.('Generating fix...');

      const fix = await parseAndRetryJson<TestFix>(
        this.ollama,
        messages,
        { temperature: 0.1, num_predict: 3000 },
        (msg: string) => onProgress?.(msg)
      );

      if (!this.isValidTestFix(fix)) {
        throw new Error('Invalid test fix structure');
      }

      onProgress?.('Fix generated!');
      return fix;

    } catch (error) {
      throw new Error(`Fix generation failed: ${error}`);
    }
  }

  /**
   * Extract affected file paths from error output
   */
  private extractAffectedFiles(output: string): string[] {
    const files = new Set<string>();
    const workspaceRoot = this.workspace.getWorkspaceRoot();
    
    // Common patterns for file paths in error messages
    const patterns = [
      /at\s+.*?\(([^)]+\.(?:ts|js|tsx|jsx)):(\d+):\d+\)/g,
      /([A-Za-z0-9_./\\-]+\.(?:ts|js|tsx|jsx)):(\d+):\d+/g,
      /Error in ([A-Za-z0-9_./\\-]+\.(?:ts|js|tsx|jsx))/g
    ];

    for (const pattern of patterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          const normalizedPath = this.normalizeExtractedPath(match[1], workspaceRoot);
          if (normalizedPath) {
            files.add(normalizedPath);
          }
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Normalize extracted paths to workspace-relative format
   */
  private normalizeExtractedPath(rawPath: string, workspaceRoot: string): string | null {
    const withoutParens = rawPath.replace(/[()]/g, '').trim();
    const normalized = withoutParens.replace(/\\/g, '/');

    if (normalized.includes('node_modules/') || normalized.startsWith('file://')) {
      return null;
    }

    const workspaceNormalized = workspaceRoot.replace(/\\/g, '/');
    if (normalized.startsWith(workspaceNormalized + '/')) {
      return path.posix.normalize(normalized.slice(workspaceNormalized.length + 1));
    }

    return path.posix.normalize(normalized);
  }

  /**
   * Validate tester fix output structure
   */
  private isValidTestFix(fix: any): fix is TestFix {
    return (
      typeof fix === 'object' &&
      typeof fix.analysis === 'string' &&
      Array.isArray(fix.patches) &&
      fix.patches.every((patch: Patch) =>
        patch && typeof patch.path === 'string' && typeof patch.diff === 'string'
      )
    );
  }
}
