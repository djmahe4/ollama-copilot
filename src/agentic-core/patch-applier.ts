/**
 * Patch Applier
 *
 * Enhances upstream PatchTool with:
 * 26. Git-friendly minimal diffs (uses diff-utils for pre-flight validation)
 * 22. Security validation (path containment before write)
 * 11. Immutable result types
 *  8. Dependency injection (PatchTool + SafeFs + MemoryManager injected)
 *
 * After every successful apply the changed files are indexed into the
 * MemoryManager asynchronously (non-blocking, <50 ms overhead).
 *
 * DELTA TYPE: EXTEND (wraps upstream tools/patch.ts)
 */

import { PatchTool } from '../tools/patch';
import { WorkspaceTool } from '../tools/workspace';
import { Patch, ToolResult } from '../protocol/types';
import { parseUnifiedDiff } from '../utils/diff-utils';
import { validatePath } from '../utils/safe-fs';
import { MemoryManager } from '../utils/memory-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyResult {
  readonly path: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface BulkApplyResult {
  readonly applied: readonly ApplyResult[];
  readonly successCount: number;
  readonly failCount: number;
}

// ---------------------------------------------------------------------------
// PatchApplier
// ---------------------------------------------------------------------------

/**
 * Validates and applies patches through the upstream PatchTool, adding
 * pre-flight checks for diff structure and path safety.
 * On success, triggers non-blocking memory indexing of changed files.
 */
export class PatchApplier {
  constructor(
    private readonly upstream: PatchTool,
    private readonly workspace: WorkspaceTool,
    private readonly memory?: MemoryManager
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Validate and apply a single patch.
   * Returns a failure result instead of throwing on invalid input.
   */
  async apply(patch: Patch): Promise<ApplyResult> {
    // Security: validate path containment (technique 22)
    const workspaceRoot = this.workspace.getWorkspaceRoot();
    try {
      validatePath(workspaceRoot, patch.path);
    } catch (err) {
      return { path: patch.path, success: false, error: String(err) };
    }

    // Structural: validate that the diff is parseable (technique 26)
    const parsed = parseUnifiedDiff(patch.diff);
    if (!parsed && patch.diff.trim().length > 0) {
      return {
        path: patch.path,
        success: false,
        error: 'Diff failed structural validation (not a valid unified diff)'
      };
    }

    const result: ToolResult<void> = await this.upstream.applyPatch(patch);
    return {
      path: patch.path,
      success: result.success,
      error: result.error
    };
  }

  /**
   * Apply multiple patches sequentially, collecting results.
   * Successful patches are indexed into memory asynchronously.
   * Never throws; failed patches are reported in the result object.
   */
  async applyAll(patches: readonly Patch[]): Promise<BulkApplyResult> {
    const applied: ApplyResult[] = [];
    const succeeded: Patch[] = [];

    for (const patch of patches) {
      const result = await this.apply(patch);
      applied.push(result);
      if (result.success) { succeeded.push(patch); }
    }

    // Non-blocking memory update for successfully applied patches
    if (succeeded.length > 0 && this.memory) {
      this.memory.indexPatches(succeeded, this.workspace.getWorkspaceRoot()).catch(err => {
        console.error('[PatchApplier] Background indexing failed:', err);
      });
    }

    const successCount = applied.filter(r => r.success).length;
    return { applied, successCount, failCount: applied.length - successCount };
  }

  /**
   * Dry-run: validate all patches without writing to disk.
   * Returns the same shape as `applyAll` but with no file mutations.
   */
  dryRun(patches: readonly Patch[]): BulkApplyResult {
    const workspaceRoot = this.workspace.getWorkspaceRoot();
    const applied: ApplyResult[] = patches.map(patch => {
      try {
        validatePath(workspaceRoot, patch.path);
      } catch (err) {
        return { path: patch.path, success: false, error: String(err) };
      }
      const parsed = parseUnifiedDiff(patch.diff);
      if (!parsed && patch.diff.trim().length > 0) {
        return {
          path: patch.path,
          success: false,
          error: 'Invalid unified diff'
        };
      }
      return { path: patch.path, success: true };
    });

    const successCount = applied.filter(r => r.success).length;
    return { applied, successCount, failCount: applied.length - successCount };
  }
}
