/**
 * @fileoverview Shared path validation utility for store implementations.
 *
 * Guards against path traversal attacks by ensuring a resolved target path
 * is strictly inside the allowed base directory.
 *
 * @module plan/store/pathValidation
 */

import * as path from 'path';

/**
 * Validate that a target path is strictly inside the allowed base directory.
 * Throws if the target path escapes the base directory.
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
