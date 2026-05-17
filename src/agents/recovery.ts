/**
 * Recovery Agent - Specialized in resolving patch application failures.
 * 
 * This agent analyzes the "delta" between the desired state (the patch) 
 * and the actual state (the current file content) to generate a correction.
 */

import { OllamaClient } from '../ollama/client';
import { WorkspaceTool } from '../tools/workspace';
import { Patch } from '../protocol/types';

export interface RecoveryResult {
  readonly success: boolean;
  readonly correctedPatch?: Patch;
  readonly explanation: string;
}

export class RecoveryAgent {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly workspace: WorkspaceTool
  ) {}

  /**
   * Analyzes a patch failure and generates a corrected version of the patch.
   * @param patch The original patch that failed.
   * @param error The error message from the patch tool.
   * @param actualContext The surrounding code at the failure point.
   */
  async recover(patch: Patch, error: string, actualContext: string): Promise<RecoveryResult> {
    try {
      // Get the full content of the file to provide the LLM with absolute context
      const readResult = await this.workspace.readFile(patch.path);
      const fullContent = readResult.success ? readResult.data : 'Could not read file content';

      const prompt = `You are a Patch Recovery Specialist. A unified diff failed to apply.
      
      FILE: ${patch.path}
      ERROR: ${error}
      
      ORIGINAL PATCH:
${patch.diff}
      
      ACTUAL CONTEXT NEAR FAILURE:
${actualContext}
      
      FULL FILE CONTENT:
${fullContent}
      
      TASK:
      1. Analyze why the patch failed (e.g., line numbers shifted, code changed slightly).
      2. Generate a CORRECTED unified diff that applies to the CURRENT state of the file.
      3. Ensure the diff is valid and maintains the original intent of the change.
      
      Respond ONLY in JSON format:
      {
        "success": true,
        "correctedPatch": {
          "path": "${patch.path}",
          "diff": "..."
        },
        "explanation": "Explain why it failed and how you fixed it"
      }`;

      const response = await this.ollama.chat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, num_predict: 1000 }
      );

      const parsed = JSON.parse(response);
      
      if (parsed.success && parsed.correctedPatch) {
        return {
          success: true,
          correctedPatch: parsed.correctedPatch,
          explanation: parsed.explanation
        };
      }

      return {
        success: false,
        explanation: 'Agent could not find a viable correction.'
      };
    } catch (err) {
      return {
        success: false,
        explanation: `Recovery failed with error: ${err}`
      };
    }
  }
}
