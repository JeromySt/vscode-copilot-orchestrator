/**
 * @fileoverview Merge Operations - Git merge and conflict handling.
 * 
 * Single responsibility: Perform merges and handle conflicts.
 * 
 * @module git/core/merge
 */

import { exec, execOrNull, execOrThrow, GitLogger } from './executor';

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
export function merge(options: MergeOptions): MergeResult {
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
  
  const result = exec(args, { cwd });
  
  if (result.success) {
    // For squash merges, we need to commit
    if (squash) {
      const commitMsg = message || `Merge branch '${source}'`;
      const commitResult = exec(['commit', '-m', commitMsg], { cwd });
      if (!commitResult.success && !commitResult.stderr.includes('nothing to commit')) {
        log?.(`[merge] ⚠ Squash commit warning: ${commitResult.stderr}`);
      }
    }
    
    log?.(`[merge] ✓ Merge completed`);
    return { success: true, hasConflicts: false, conflictFiles: [] };
  }
  
  // Check if it's a conflict
  if (result.stderr.includes('CONFLICT') || result.stdout.includes('CONFLICT')) {
    const conflicts = listConflicts(cwd);
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
export function abort(cwd: string, log?: GitLogger): void {
  log?.(`[merge] Aborting merge`);
  exec(['merge', '--abort'], { cwd });
}

/**
 * List files with merge conflicts.
 */
export function listConflicts(cwd: string): string[] {
  const result = execOrNull(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!result) return [];
  return result.split(/\r?\n/).filter(Boolean);
}

/**
 * Check if there's an in-progress merge.
 */
export function isInProgress(cwd: string): boolean {
  const result = exec(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd });
  if (!result.success) return false;
  
  const fs = require('fs');
  const path = require('path');
  const mergeHead = path.join(cwd, result.stdout.trim());
  return fs.existsSync(mergeHead);
}

/**
 * Resolve a conflict by choosing one side.
 * 
 * @param file - Conflicted file path (relative to cwd)
 * @param side - Which side to keep ('ours' or 'theirs')
 * @param cwd - Working directory
 */
export function resolveBySide(file: string, side: 'ours' | 'theirs', cwd: string, log?: GitLogger): void {
  log?.(`[merge] Resolving '${file}' using '${side}'`);
  execOrThrow(['checkout', `--${side}`, '--', file], cwd);
  execOrThrow(['add', file], cwd);
  log?.(`[merge] ✓ Resolved '${file}'`);
}

/**
 * Mark conflicts as resolved and continue merge.
 */
export function continueAfterResolve(cwd: string, message: string, log?: GitLogger): boolean {
  log?.(`[merge] Committing resolved merge`);
  
  // Stage all changes
  exec(['add', '-A'], { cwd });
  
  // Commit the merge
  const result = exec(['commit', '-m', message], { cwd });
  
  if (result.success) {
    log?.(`[merge] ✓ Merge committed`);
    return true;
  }
  
  log?.(`[merge] ✗ Failed to commit: ${result.stderr}`);
  return false;
}
