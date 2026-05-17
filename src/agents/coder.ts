/**
 * Coder Agent - Generates code patches
 */

import { OllamaClient } from '../ollama/client';
import { CoderOutput, OllamaMessage, PlannerOutput, FileContext } from '../protocol/types';
import { CODER_SYSTEM_PROMPT, buildCoderPrompt } from '../protocol/prompts';
import { WorkspaceTool } from '../tools/workspace';
import { SearchTool } from '../tools/search';
import { parseJsonObject, parseAndRetryJson } from './jsonParser';

export class CoderAgent {
  private ollama: OllamaClient;
  private workspace: WorkspaceTool;
  private search: SearchTool;

  constructor(ollama: OllamaClient, workspace: WorkspaceTool, search: SearchTool) {
    this.ollama = ollama;
    this.workspace = workspace;
    this.search = search;
  }

  /**
   * Generate code patches based on plan and context
   */
  async generateCode(
    userRequest: string,
    plan: PlannerOutput,
    onProgress?: (message: string) => void
  ): Promise<CoderOutput> {
    try {
      // Gather context from workspace
      onProgress?.('Gathering code context...');
      const context = await this.gatherContext(plan);

      // Build the prompt
      const userPrompt = buildCoderPrompt(userRequest, plan, context);

      // Call Ollama
      const messages: OllamaMessage[] = [
        { role: 'system', content: CODER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];

      onProgress?.('Generating code changes...');

      const coderOutput = await parseAndRetryJson<CoderOutput>(
        this.ollama,
        messages,
        { temperature: 0.1, num_predict: 4000 },
        (msg: string) => onProgress?.(msg)
      );

      // Validate structure
      if (!this.isValidCoderOutput(coderOutput)) {
        throw new Error('Invalid coder output structure');
      }

      onProgress?.('Code generation complete!');
      return coderOutput;

    } catch (error) {
      throw new Error(`Code generation failed: ${error}`);
    }
  }

  /**
   * Gather context files based on the plan
   */
  private async gatherContext(plan: PlannerOutput): Promise<FileContext[]> {
    const context: FileContext[] = [];
    const seenFiles = new Set<string>();

    // Read files specified in plan
    for (const filePath of plan.files_to_read) {
      if (seenFiles.has(filePath)) {
        continue;
      }

      const result = await this.workspace.readFile(filePath);
      if (result.success && result.data) {
        context.push({
          path: filePath,
          content: result.data,
          relevance: 'Specified in plan'
        });
        seenFiles.add(filePath);
      }
    }

    // Search for relevant files
    for (const query of plan.search_queries) {
      const searchResult = await this.search.searchText(query, 10);
      if (searchResult.success && searchResult.data) {
        for (const match of searchResult.data) {
          if (seenFiles.has(match.file)) {
            continue;
          }

          const fileResult = await this.workspace.readFile(match.file);
          if (fileResult.success && fileResult.data) {
            context.push({
              path: match.file,
              content: fileResult.data,
              relevance: `Found via search: ${query}`
            });
            seenFiles.add(match.file);

            // Limit context size
            if (context.length >= 10) {
              break;
            }
          }
        }
      }

      if (context.length >= 10) {
        break;
      }
    }

    return context;
  }
  /**
   * Validate coder output structure
   */
  private isValidCoderOutput(output: any): output is CoderOutput {
    return (
      typeof output === 'object' &&
      Array.isArray(output.patches) &&
      Array.isArray(output.notes) &&
      output.patches.every((p: any) => 
        typeof p.path === 'string' && typeof p.diff === 'string'
      )
    );
  }
}
