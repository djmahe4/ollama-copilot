/**
 * Patch tool for applying unified diffs
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Patch, ToolResult } from '../protocol/types';
import { WorkspaceTool } from './workspace';

export class PatchTool {
  private workspace: WorkspaceTool;

  constructor(workspace: WorkspaceTool) {
    this.workspace = workspace;
  }

  /**
   * Apply a unified diff patch to a file
   */
  async applyPatch(patch: Patch): Promise<ToolResult<void>> {
    try {
      const { path: relativePath, diff } = patch;

      // Check if file exists
      const exists = await this.workspace.fileExists(relativePath);
      
      if (!exists) {
        // Check if this is a new file creation
        if (diff.includes('--- /dev/null') || diff.includes('--- a/dev/null')) {
          return await this.createFileFromDiff(relativePath, diff);
        }
        return {
          success: false,
          error: `File does not exist: ${relativePath}`
        };
      }

      // Read current file content
      const readResult = await this.workspace.readFile(relativePath);
      if (!readResult.success || !readResult.data) {
        return {
          success: false,
          error: `Could not read file: ${relativePath}`
        };
      }

      const originalContent = readResult.data;
      const patchedContent = this.applyUnifiedDiff(originalContent, diff);

      if (!patchedContent) {
        return {
          success: false,
          error: `Failed to apply patch to ${relativePath}`
        };
      }

      // Write the patched content
      const writeResult = await this.workspace.writeFile(relativePath, patchedContent);
      return writeResult;

    } catch (error) {
      return {
        success: false,
        error: `Patch application failed: ${error}`
      };
    }
  }

  /**
   * Apply unified diff to content with context verification
   */
  private applyUnifiedDiff(original: string, diff: string): string | null {
    try {
      const lines = original.split('\n');
      const diffLines = diff.split('\n');
      
      let currentLine = 0;
      const result: string[] = [];
      let i = 0;

      while (i < diffLines.length) {
        const line = diffLines[i];

        if (line.startsWith('---') || line.startsWith('+++')) {
          i++;
          continue;
        }

        if (line.startsWith('@@')) {
          // Parse hunk header: @@ -start,len +start,len @@
          const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
          if (!match) {
            i++;
            continue;
          }

          const oldStart = parseInt(match[1], 10);
          // currentLine is 0-indexed, oldStart is 1-indexed
          
          // 1. Sync currentLine to the start of the hunk
          while (currentLine < oldStart - 1 && currentLine < lines.length) {
            result.push(lines[currentLine]);
            currentLine++;
          }

          // 2. Process the hunk
          i++;
          while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
            const hunkLine = diffLines[i];
            
            if (hunkLine.startsWith(' ')) {
              // Context line: MUST match original content
              const contextContent = hunkLine.substring(1);
              if (currentLine >= lines.length || lines[currentLine] !== contextContent) {
                console.error(`Context mismatch at line ${currentLine + 1}: expected "${contextContent}" but found "${lines[currentLine]}"`);
                return null; // Fail patch
              }
              result.push(lines[currentLine]);
              currentLine++;
            } else if (hunkLine.startsWith('-')) {
              // Removed line: MUST match original content
              const removedContent = hunkLine.substring(1);
              if (currentLine >= lines.length || lines[currentLine] !== removedContent) {
                console.error(`Content mismatch at line ${currentLine + 1}: expected to remove "${removedContent}" but found "${lines[currentLine]}"`);
                return null; // Fail patch
              }
              currentLine++;
            } else if (hunkLine.startsWith('+')) {
              // Added line: just push to result
              result.push(hunkLine.substring(1));
            } else {
              // Unexpected line format within hunk
              i++;
              continue;
            }
            i++;
          }
          continue; // Outer loop will increment i if we didn't continue
        }
        i++;
      }

      // Copy remaining lines
      while (currentLine < lines.length) {
        result.push(lines[currentLine]);
        currentLine++;
      }

      return result.join('\n');
    } catch (error) {
      console.error('Diff application error:', error);
      return null;
    }
  }

  /**
   * Create a new file from a diff that creates it
   */
  private async createFileFromDiff(relativePath: string, diff: string): Promise<ToolResult<void>> {
    try {
      const lines = diff.split('\n');
      const content: string[] = [];

      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          content.push(line.substring(1));
        }
      }

      return await this.workspace.createFile(relativePath, content.join('\n'));
    } catch (error) {
      return {
        success: false,
        error: `Failed to create file from diff: ${error}`
      };
    }
  }

  /**
   * Generate a preview of what the patch will do
   */
  async generatePreview(patches: Patch[]): Promise<ToolResult<string>> {
    try {
      const previews: string[] = [];

      for (const patch of patches) {
        const { path: relativePath, diff } = patch;
        
        previews.push(`\n${'='.repeat(60)}`);
        previews.push(`File: ${relativePath}`);
        previews.push('='.repeat(60));
        previews.push(diff);
      }

      return {
        success: true,
        data: previews.join('\n')
      };
    } catch (error) {
      return {
        success: false,
        error: `Preview generation failed: ${error}`
      };
    }
  }

  /**
   * Show diff in VS Code editor
   */
  async showDiffInEditor(patch: Patch): Promise<void> {
    const { path: relativePath } = patch;
    const workspaceRoot = this.workspace.getWorkspaceRoot();
    const fullPath = path.join(workspaceRoot, relativePath);

    // Open the file
    const uri = vscode.Uri.file(fullPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  }
}
