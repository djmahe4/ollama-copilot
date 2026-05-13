import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { MemoryManager, MemoryEntry } from '../utils/memory-manager';

/**
 * SkillManager - Handles discovery, indexing, and injection of agentic skills
 * from across the ecosystem (OpenCode, Claude Code, Cursor, etc.)
 */
export class SkillManager {
  private readonly workspaceRoot: string;
  private readonly userConfigRoot: string;
  private currentRootPreference: 'user_config' | 'workspace' = 'user_config';
  
  // Map of provider to search patterns
  private readonly skillPaths = {
    'opencode': ['.config/opencode/skills'],
    'antigravity': ['.gemini/antigravity/skills'],
    'codex': ['AGENTS.md'],
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'claude-code': ['CLAUDE.md'],
    'cursor': ['.cursor/rules'],
    'windsurf': ['.windsurf/rules'],
    'aider': ['*.md'], // Usually specific files, filtered by keyword
    'cline': ['.clinerules'],
    'copilot': ['.github/copilot-instructions.md'],
  };
  
  constructor(private readonly memory: MemoryManager, workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.userConfigRoot = this.resolveUserConfigRoot();
  }

  private resolveUserConfigRoot(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
      // Use %APPDATA% or similar if needed, but for now follow the .config pattern
      return path.join(home, '.config');
    }
    return path.join(home, '.config');
  }

  public setRootPreference(preference: 'user_config' | 'workspace'): void {
    this.currentRootPreference = preference;
  }

  /**
   * Scans all configured paths for skill definitions and indexes them into LTM.
   */
  async discoverAndIndexSkills(): Promise<{ indexed: number }> {
    let totalIndexed = 0;
    const root = this.currentRootPreference === 'user_config' ? this.userConfigRoot : this.workspaceRoot;

    for (const [provider, paths] of Object.entries(this.skillPaths)) {
      for (const p of paths) {
        const fullPath = path.normalize(path.join(root, p));
        
        if (!fs.existsSync(fullPath)) {
          continue;
        }

        const skills = await this.scanDirectory(fullPath);
        for (const skill of skills) {
          await this.indexSkill(provider, skill);
          totalIndexed++;
        }
      }
    }
    return { indexed: totalIndexed };
  }

  private async scanDirectory(dirPath: string): Promise<Array<{ path: string; content: string }>> {
    const results: Array<{ path: string; content: string }> = [];
    const stats = fs.statSync(dirPath);

    if (stats.isFile()) {
      results.push({ path: dirPath, content: await fs.promises.readFile(dirPath, 'utf8') });
    } else if (stats.isDirectory()) {
      const files = await fs.promises.readdir(dirPath);
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        if (file.endsWith('.md') || file.endsWith('.mdc') || file === 'AGENTS.md' || file === 'CLAUDE.md') {
          results.push({ path: fullPath, content: await fs.promises.readFile(fullPath, 'utf8') });
        } else if ((await fs.promises.stat(fullPath)).isDirectory()) {
          results.push(...await this.scanDirectory(fullPath));
        }
      }
    }
    return results;
  }

  private async indexSkill(provider: string, skill: { path: string; content: string }): Promise<void> {
    const fileName = path.basename(skill.path);
    
    this.memory.indexEntry({
      type: 'capability',
      filePath: skill.path,
      description: `Skill [${provider}]: ${fileName}`,
      content: skill.content.slice(0, 5000), // Preserve significant portion of the rule
      relations: [],
    });
  }

  /**
   * Retrieves skills relevant to a specific task via semantic search.
   */
  async getRelevantSkills(query: string, topK: number = 3): Promise<string> {
    const results = await this.memory.search(`Skill ${query}`, topK);
    if (results.length === 0) {
      return '';
    }

    return results.map(r => 
      `## Skill: ${r.entry.description}\nSource: ${r.entry.filePath}\n${r.entry.content}`
    ).join('\n\n');
  }
}
