/**
 * @fileoverview Merge Operations - Git merge and conflict handling (fully async).
 * 
 * Single responsibility: Perform merges and handle conflicts.
 * All operations are async to avoid blocking the event loop.
 * 
 * @module git/core/merge
 */

import * as fs from 'fs';
import * as path from 'path';
import { execAsync, execAsyncOrNull, execAsyncOrThrow, GitLogger } from './executor';

/**
 * Result of a merge operation.
 */
export interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  conflictFiles: string[];
  error?: string;
}

/**
 * Merge options.
 */
export interface MergeOptions {
  /** Source branch to merge from */
  source: string;
  /** Target branch to merge into (must be checked out) */
  target: string;
  /** Working directory */
  cwd: string;
  /** Commit message (optional, uses default if not provided) */
  message?: string;
  /** Whether to allow fast-forward (default: true) */
  fastForward?: boolean;
  /** Whether to squash commits (default: false) */
  squash?: boolean;
  /** Logger function */
  log?: GitLogger;
}

/**
 * Perform a git merge.
 * 
 * @param options - Merge options
 * @returns Merge result indicating success and any conflicts
 */
export async function merge(options: MergeOptions): Promise<MergeResult> {
  const { 
    source, 
    target, 
    cwd, 
    message, 
    fastForward = true, 
    squash = false,
    log 
  } = options;
  
  log?.(`[merge] Merging '${source}' into '${target}'`);
  
  const args = ['merge'];
  
  if (squash) {
    args.push('--squash');
  } else if (!fastForward) {
    args.push('--no-ff');
  }
  
  if (message && !squash) {
    args.push('-m', message);
  } else if (!message && !squash) {
    args.push('--no-edit');
  }
  
  args.push(source);
  
  const result = await execAsync(args, { cwd });
  
  if (result.success) {
    // For squash merges, we need to commit
    if (squash) {
      const commitMsg = message || `Merge branch '${source}'`;
      const commitResult = await execAsync(['commit', '-m', commitMsg], { cwd });
      if (!commitResult.success && !commitResult.stderr.includes('nothing to commit')) {
        log?.(`[merge] ⚠ Squash commit warning: ${commitResult.stderr}`);
      }
    }
    
    log?.(`[merge] ✓ Merge completed`);
    return { success: true, hasConflicts: false, conflictFiles: [] };
  }
  
  // Check if it's a conflict
  if (result.stderr.includes('CONFLICT') || result.stdout.includes('CONFLICT')) {
    const conflicts = await listConflicts(cwd);
    log?.(`[merge] ⚠ Merge conflicts in ${conflicts.length} file(s)`);
    return { 
      success: false, 
      hasConflicts: true, 
      conflictFiles: conflicts,
      error: 'Merge conflicts detected'
    };
  }
  
  log?.(`[merge] ✗ Merge failed: ${result.stderr}`);
  return { 
    success: false, 
    hasConflicts: false, 
    conflictFiles: [],
    error: result.stderr || 'Merge failed'
  };
}

/**
 * Abort an in-progress merge.
 */
export async function abort(cwd: string, log?: GitLogger): Promise<void> {
  log?.(`[merge] Aborting merge`);
  await execAsync(['merge', '--abort'], { cwd });
}

/**
 * List files with merge conflicts.
 */
export async function listConflicts(cwd: string): Promise<string[]> {
  const result = await execAsyncOrNull(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!result) return [];
  return result.split(/\r?\n/).filter(Boolean);
}

/**
 * Check if there's an in-progress merge.
 */
export async function isInProgress(cwd: string): Promise<boolean> {
  const result = await execAsync(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd });
  if (!result.success) return false;
  
  const mergeHead = path.join(cwd, result.stdout.trim());
  try {
    await fs.promises.access(mergeHead);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a conflict by choosing one side.
 * 
 * @param file - Conflicted file path (relative to cwd)
 * @param side - Which side to keep ('ours' or 'theirs')
 * @param cwd - Working directory
 */
export async function resolveBySide(file: string, side: 'ours' | 'theirs', cwd: string, log?: GitLogger): Promise<void> {
  log?.(`[merge] Resolving '${file}' using '${side}'`);
  await execAsyncOrThrow(['checkout', `--${side}`, '--', file], cwd);
  await execAsyncOrThrow(['add', file], cwd);
  log?.(`[merge] ✓ Resolved '${file}'`);
}

/**
 * Mark conflicts as resolved and continue merge.
 */
export async function continueAfterResolve(cwd: string, message: string, log?: GitLogger): Promise<boolean> {
  log?.(`[merge] Committing resolved merge`);
  
  // Stage all changes
  await execAsync(['add', '-A'], { cwd });
  
  // Commit the merge
  const result = await execAsync(['commit', '-m', message], { cwd });
  
  if (result.success) {
    log?.(`[merge] ✓ Merge committed`);
    return true;
  }
  
  log?.(`[merge] ✗ Failed to commit: ${result.stderr}`);
  return false;
}
