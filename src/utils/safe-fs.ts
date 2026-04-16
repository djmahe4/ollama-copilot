/**
 * Safe File System Utilities
 *
 * Wraps Node.js / VS Code file operations with:
 *  22. Security validation (path traversal prevention, input sanitisation)
 *  11. Immutable result types
 *
 * DELTA TYPE: EXTEND (new module, no upstream mutation)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolResult } from '../protocol/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size allowed for reads (1 MiB). */
const MAX_READ_BYTES = 1_048_576;

/** Allowed file-name characters (no shell-special chars). */
const SAFE_PATH_RE = /^[\w\-./\\]+$/;

// ---------------------------------------------------------------------------
// Validation helpers  (technique 22)
// ---------------------------------------------------------------------------

/**
 * Validate that `relativePath` is safe to use within `workspaceRoot`.
 * Prevents path-traversal attacks by resolving both paths and asserting
 * the result is still within the workspace boundary.
 */
export function validatePath(workspaceRoot: string, relativePath: string): string {
  if (!relativePath || relativePath.trim().length === 0) {
    throw new SafeFsError('Path must not be empty');
  }
  // Reject null bytes
  if (relativePath.includes('\0')) {
    throw new SafeFsError('Path contains null byte');
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  const normalRoot = path.resolve(workspaceRoot);
  if (!resolved.startsWith(normalRoot + path.sep) && resolved !== normalRoot) {
    throw new SafeFsError(`Path traversal detected: '${relativePath}'`);
  }
  return resolved;
}

/**
 * Sanitise a string value so it is safe to embed in file paths or
 * shell-adjacent contexts. Strips characters outside the safe set.
 * (technique 22 – input sanitisation)
 */
export function sanitiseName(value: string): string {
  return value.replace(/[^\w\-. ]/g, '_').trim();
}

/**
 * Return true only if the path contains only safe identifier characters.
 */
export function isSafePath(value: string): boolean {
  return SAFE_PATH_RE.test(value);
}

// ---------------------------------------------------------------------------
// File I/O  (with security wrappers)
// ---------------------------------------------------------------------------

/**
 * Read a file safely, enforcing workspace-root containment and size limit.
 */
export async function safeReadFile(
  workspaceRoot: string,
  relativePath: string
): Promise<ToolResult<string>> {
  try {
    const fullPath = validatePath(workspaceRoot, relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_READ_BYTES) {
      return {
        success: false,
        error: `File too large to read: ${relativePath} (${stat.size} bytes)`
      };
    }
    const content = await fs.readFile(fullPath, 'utf-8');
    return { success: true, data: content };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Write a file safely, enforcing workspace-root containment.
 * Creates parent directories as needed.
 */
export async function safeWriteFile(
  workspaceRoot: string,
  relativePath: string,
  content: string
): Promise<ToolResult<void>> {
  try {
    const fullPath = validatePath(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Check whether a file exists inside the workspace boundary.
 */
export async function safeFileExists(
  workspaceRoot: string,
  relativePath: string
): Promise<boolean> {
  try {
    const fullPath = validatePath(workspaceRoot, relativePath);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/** Thrown when a file-system operation violates a security constraint. */
export class SafeFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFsError';
  }
}
