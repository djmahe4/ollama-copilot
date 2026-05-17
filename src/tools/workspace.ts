/**
 * Workspace file operations tool
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolResult } from '../protocol/types';

export class WorkspaceTool {
  private workspaceRoot: string;

  constructor() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace folder open');
    }
    this.workspaceRoot = workspaceFolders[0].uri.fsPath;
  }

  /**
   * List files matching a glob pattern
   */
  async listFiles(globPattern: string = '**/*'): Promise<ToolResult<string[]>> {
    try {
      // Exclude common directories
      const excludePattern = '**/node_modules/**,**/out/**,**/dist/**,**/.git/**';
      const files = await vscode.workspace.findFiles(globPattern, excludePattern, 1000);
      
      const relativePaths = files.map((uri: vscode.Uri) => 
        path.relative(this.workspaceRoot, uri.fsPath)
      );

      return {
        success: true,
        data: relativePaths
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list files: ${error}`
      };
    }
  }

  /**
   * Resolve a relative path to an absolute path and verify it's within the workspace root.
   */
  private resolveSafePath(relativePath: string): string {
    const fullPath = path.resolve(this.workspaceRoot, relativePath);
    const rootWithSlash = this.workspaceRoot.endsWith(path.sep) 
      ? this.workspaceRoot 
      : this.workspaceRoot + path.sep;
    
    if (fullPath !== this.workspaceRoot && !fullPath.startsWith(rootWithSlash)) {
      throw new Error(`Access denied: Path ${relativePath} is outside workspace root`);
    }
    return fullPath;
  }

  /**
   * Read file contents
   */
  async readFile(relativePath: string): Promise<ToolResult<string>> {
    try {
      const fullPath = this.resolveSafePath(relativePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      return {
        success: true,
        data: content
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file ${relativePath}: ${error}`
      };
    }
  }

  /**
   * Create a new file
   */
  async createFile(relativePath: string, content: string): Promise<ToolResult<void>> {
    try {
      const fullPath = this.resolveSafePath(relativePath);
      const dir = path.dirname(fullPath);
      
      // Create directory if it doesn't exist
      await fs.mkdir(dir, { recursive: true });
      
      // Write file
      await fs.writeFile(fullPath, content, 'utf-8');
      
      return {
        success: true
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create file ${relativePath}: ${error}`
      };
    }
  }

  /**
   * Write content to an existing file
   */
  async writeFile(relativePath: string, content: string): Promise<ToolResult<void>> {
    try {
      const fullPath = this.resolveSafePath(relativePath);
      await fs.writeFile(fullPath, content, 'utf-8');
      
      return {
        success: true
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to write file ${relativePath}: ${error}`
      };
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(relativePath: string): Promise<boolean> {
    try {
      const fullPath = this.resolveSafePath(relativePath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get workspace structure as a tree with context
   */
  async getWorkspaceStructure(): Promise<ToolResult<string>> {
    try {
      // Get all relevant source files
      const result = await this.listFiles('**/*.{ts,js,tsx,jsx,json,md,py,go,rs,java,cpp,c,h,css,scss,html,vue,svelte}');
      if (!result.success || !result.data) {
        return {
          success: false,
          error: result.error || 'Failed to list files'
        };
      }

      let structure = 'WORKSPACE ANALYSIS\n' + '='.repeat(80) + '\n\n';

      // 1. Project Overview
      structure += '📋 PROJECT OVERVIEW\n' + '-'.repeat(80) + '\n';
      structure += `Root: ${path.basename(this.workspaceRoot)}\n`;
      structure += `Total Files: ${result.data.length}\n\n`;

      // 2. Tech Stack Detection
      structure += '🔧 TECH STACK\n' + '-'.repeat(80) + '\n';
      structure += await this.detectTechStack(result.data);
      structure += '\n\n';

      // 3. Key Files
      structure += '📄 KEY FILES\n' + '-'.repeat(80) + '\n';
      structure += await this.listKeyFiles(result.data);
      structure += '\n\n';

      // 4. Directory Structure
      structure += '📁 DIRECTORY STRUCTURE\n' + '-'.repeat(80) + '\n';
      structure += this.buildEnhancedTree(result.data);
      structure += '\n';

      return {
        success: true,
        data: structure
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get workspace structure: ${error}`
      };
    }
  }

  /**
   * Detect tech stack from files
   */
  private async detectTechStack(files: string[]): Promise<string> {
    const stack: string[] = [];
    
    // Check for package.json
    if (files.some(f => f === 'package.json')) {
      try {
        const pkgResult = await this.readFile('package.json');
        if (pkgResult.success && pkgResult.data) {
          const pkg = JSON.parse(pkgResult.data);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          
           if (deps['react']) {
             stack.push('React');
           }
           if (deps['vue']) {
             stack.push('Vue');
           }
           if (deps['@angular/core']) {
             stack.push('Angular');
           }
           if (deps['express']) {
             stack.push('Express');
           }
           if (deps['next']) {
             stack.push('Next.js');
           }
           if (deps['typescript']) {
             stack.push('TypeScript');
           }
           if (deps['vite']) {
             stack.push('Vite');
           }
           if (deps['webpack']) {
             stack.push('Webpack');
           }
        }
      } catch {}
    }

    // Check file extensions
     if (files.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
       stack.push('TypeScript');
     }
     if (files.some(f => f.endsWith('.py'))) {
       stack.push('Python');
     }
     if (files.some(f => f.endsWith('.go'))) {
       stack.push('Go');
     }
     if (files.some(f => f.endsWith('.rs'))) {
       stack.push('Rust');
     }
     if (files.some(f => f.endsWith('.java'))) {
       stack.push('Java');
     }
     if (files.some(f => f.endsWith('.vue'))) {
       stack.push('Vue');
     }
    
    return stack.length > 0 ? stack.join(', ') : 'Unknown';
  }

  /**
   * List important configuration and documentation files
   */
  private async listKeyFiles(files: string[]): Promise<string> {
    const keyFiles = [
      'package.json', 'tsconfig.json', 'README.md', 'CONTRIBUTING.md',
      'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml',
      'pom.xml', 'build.gradle', '.env.example'
    ];
    
    const found = files.filter(f => 
      keyFiles.includes(path.basename(f)) || 
      f.match(/^(src|lib|app)\/.*\.(ts|js|py|go)$/)
    );

    return found.slice(0, 15).map(f => `  - ${f}`).join('\n') || '  (none found)';
  }

  /**
   * Build enhanced tree with file counts
   */
  private buildEnhancedTree(files: string[]): string {
    const sorted = files.sort();
    const dirMap = new Map<string, { files: string[], subdirs: Set<string> }>();
    
    // Group files by directory
    for (const file of sorted) {
      const dir = path.dirname(file);
      if (!dirMap.has(dir)) {
        dirMap.set(dir, { files: [], subdirs: new Set() });
      }
      dirMap.get(dir)!.files.push(path.basename(file));
      
      // Track subdirectories
      const parts = dir.split(path.sep);
      for (let i = 0; i < parts.length; i++) {
        const parentDir = parts.slice(0, i).join(path.sep) || '.';
        if (!dirMap.has(parentDir)) {
          dirMap.set(parentDir, { files: [], subdirs: new Set() });
        }
        if (i < parts.length) {
          dirMap.get(parentDir)!.subdirs.add(parts[i]);
        }
      }
    }

    // Build tree output (limit to main directories to avoid clutter)
    const tree: string[] = [];
    const rootDirs = dirMap.get('.')?.subdirs || new Set();
    
    for (const dir of Array.from(rootDirs).sort()) {
      const dirFiles = dirMap.get(dir)?.files || [];
      tree.push(`${dir}/ (${dirFiles.length} files)`);
      
      // Show first few files as examples
      dirFiles.slice(0, 3).forEach(f => {
        tree.push(`  ├─ ${f}`);
      });
      if (dirFiles.length > 3) {
        tree.push(`  └─ ... and ${dirFiles.length - 3} more`);
      }
    }

    return tree.join('\n') || '  (empty)';
  }

  /**
   * Get the workspace root path
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}
