/**
 * @fileoverview Shared path validation utility for store implementations.
 *
 * Guards against path traversal attacks by ensuring a resolved target path
 * is strictly inside the allowed base directory.
 *
 * @module plan/store/pathValidation
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Validate that a target path is strictly inside the allowed base directory.
 * Throws if the target path escapes the base directory.
 *
 * Note: This performs only a lexical path check (path.resolve). It does not
 * follow symlinks. Use `validatePathAsync` in async I/O contexts where symlink
 * escape protection is needed.
 *
 * @param basePath - The directory that all valid paths must reside within.
 * @param targetPath - The path to validate.
 * @throws {Error} If `targetPath` escapes `basePath`.
 */
export function validatePath(basePath: string, targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const baseResolved = path.resolve(basePath);

  if (!resolved.startsWith(baseResolved + path.sep)) {
    throw new Error(`Path traversal blocked: ${targetPath}`);
  }
}

/**
 * Async path validation that additionally resolves symlinks via `fs.realpath`
 * to protect against symlink-escape attacks.
 *
 * Performs the lexical check first (fast), then resolves both paths via
 * `fs.realpath` to detect cases where a symlink inside the base directory
 * points outside of it. If the target path does not yet exist (ENOENT), the
 * realpath check is skipped and the lexical check alone is used.
 *
 * @param basePath - The directory that all valid paths must reside within.
 * @param targetPath - The path to validate.
 * @throws {Error} If `targetPath` escapes `basePath` (lexically or via symlinks).
 */
export async function validatePathAsync(basePath: string, targetPath: string): Promise<void> {
  // Lexical check first (guards against .. traversal without I/O)
  validatePath(basePath, targetPath);

  // Realpath check to guard against symlink escapes
  try {
    const baseReal = await fs.promises.realpath(basePath).catch(() => path.resolve(basePath));
    const targetReal = await fs.promises.realpath(targetPath);
    if (!targetReal.startsWith(baseReal + path.sep)) {
      throw new Error(`Path traversal blocked (symlink): ${targetPath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Target does not exist yet; the lexical check above is sufficient
      return;
    }
    throw err;
  }
}
