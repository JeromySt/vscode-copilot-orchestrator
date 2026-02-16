/**
 * @fileoverview Merge Operations - Git merge and conflict handling (fully async).
 * 
 * Single responsibility: Perform merges and handle conflicts.
 * All operations are async to avoid blocking the event loop.
 * 
 * ## Merge Strategies
 * 
 * 1. **Standard merge** (`merge()`) - Requires target branch checked out.
 *    Used when working in a worktree with the branch checked out.
 * 
 * 2. **Checkout-free merge** (`mergeWithoutCheckout()`) - Uses `git merge-tree` (Git 2.38+).
 *    Performs merge entirely in git's object store without touching working directory.
 *    Returns tree SHA for conflict-free merges, or conflict info if conflicts occur.
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
 * Result of a checkout-free merge operation.
 */
export interface MergeTreeResult {
  /** Whether the merge can be done without conflicts */
  success: boolean;
  /** The resulting tree SHA (only set if success=true) */
  treeSha?: string;
  /** Whether there are conflicts */
  hasConflicts: boolean;
  /** List of conflicting files */
  conflictFiles: string[];
  /** Error message if failed for non-conflict reason */
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
  /** Whether to skip the commit (--no-commit flag) (default: false) */
  noCommit?: boolean;
  /** Logger function */
  log?: GitLogger;
}

/**
 * Options for checkout-free merge.
 */
export interface MergeTreeOptions {
  /** Source commit/branch to merge from */
  source: string;
  /** Target commit/branch to merge into */
  target: string;
  /** Repository path */
  repoPath: string;
  /** Logger function */
  log?: GitLogger;
}

/**
 * Perform a merge without checking out either branch (Git 2.38+).
 * 
 * Uses `git merge-tree --write-tree` to compute the merge result entirely
 * in git's object store. If successful, returns the tree SHA that can be
 * used to create a commit.
 * 
 * This is the fastest way to merge when there are no conflicts, as it
 * doesn't require creating a worktree or modifying any working directory.
 * 
 * Algorithm:
 * 1. Execute `git merge-tree --write-tree <target> <source>`
 * 2. If exit code 0: Parse tree SHA from stdout (conflict-free merge)
 * 3. If exit code 1 with CONFLICT markers: Parse conflict files from output
 * 4. If command not found: Return error for Git < 2.38
 * 5. Otherwise: Return unexpected error
 * 
 * @param options - Merge tree options
 * @returns Merge result with tree SHA if conflict-free
 */
export async function mergeWithoutCheckout(options: MergeTreeOptions): Promise<MergeTreeResult> {
  const { source, target, repoPath, log } = options;
  
  log?.(`[merge-tree] Computing merge of '${source}' into '${target}'`);
  
  // Step 1: Execute merge-tree command
  // --write-tree computes merge and returns tree SHA (Git 2.38+)
  // This operates entirely on git objects, no working directory modification
  const result = await execAsync(
    ['merge-tree', '--write-tree', target, source],
    { cwd: repoPath }
  );
  
  // Step 2: Handle success case (exit code 0)
  if (result.success) {
    const treeSha = result.stdout.trim();
    log?.(`[merge-tree] ✓ Merge computed successfully, tree: ${treeSha.slice(0, 8)}`);
    return {
      success: true,
      treeSha,
      hasConflicts: false,
      conflictFiles: []
    };
  }
  
  // Step 3: Handle merge conflicts (exit code 1 with CONFLICT output)
  // Git merge-tree outputs conflict information to stdout in human-readable format
  // Example output lines:
  //   "CONFLICT (content): Merge conflict in src/file.js"
  //   "CONFLICT (modify/delete): src/deleted.js deleted in HEAD and modified in branch"
  if (result.stdout.includes('CONFLICT') || result.stderr.includes('CONFLICT')) {
    const conflictFiles: string[] = [];
    const lines = result.stdout.split('\n');
    
    // Parse each line looking for conflict descriptions
    for (const line of lines) {
      // Extract filename from conflict description
      // Regex captures filename after "Merge conflict in " or similar patterns
      const match = line.match(/CONFLICT.*?:\s*Merge conflict in\s+(.+)/);
      if (match) {
        conflictFiles.push(match[1].trim());
      }
      
      // Handle modify/delete conflicts with different format
      const modifyDeleteMatch = line.match(/CONFLICT \(modify\/delete\):\s*(.+?)\s+deleted in/);
      if (modifyDeleteMatch) {
        conflictFiles.push(modifyDeleteMatch[1].trim());
      }
    }
    
    log?.(`[merge-tree] ⚠ Merge has conflicts in ${conflictFiles.length} file(s)`);
    return {
      success: false,
      hasConflicts: true,
      conflictFiles,
      error: `Merge conflicts in: ${conflictFiles.join(', ')}`
    };
  }
  
  // Step 4: Handle unsupported git version
  // merge-tree --write-tree was added in Git 2.38.0
  if (result.stderr.includes('is not a git command') || 
      result.stderr.includes('unknown option') ||
      result.stderr.includes('unrecognized option')) {
    log?.(`[merge-tree] ✗ git merge-tree --write-tree not available (requires Git 2.38+)`);
    return {
      success: false,
      hasConflicts: false,
      conflictFiles: [],
      error: 'git merge-tree --write-tree requires Git 2.38 or later'
    };
  }
  
  // Step 5: Handle unexpected errors
  log?.(`[merge-tree] ✗ Merge failed: ${result.stderr}`);
  return {
    success: false,
    hasConflicts: false,
    conflictFiles: [],
    error: result.stderr || 'Merge computation failed for unknown reason'
  };
}

/**
 * Create a commit from a tree SHA without checking out.
 * 
 * This is used after `mergeWithoutCheckout()` to create the actual merge commit.
 * 
 * @param treeSha - Tree SHA from mergeWithoutCheckout
 * @param parents - Parent commit SHAs (typically [target, source])
 * @param message - Commit message
 * @param repoPath - Repository path
 * @param log - Logger function
 * @returns The new commit SHA
 */
export async function commitTree(
  treeSha: string,
  parents: string[],
  message: string,
  repoPath: string,
  log?: GitLogger
): Promise<string> {
  log?.(`[commit-tree] Creating commit from tree ${treeSha.slice(0, 8)}`);
  
  // Build parent args: -p <parent1> -p <parent2> ...
  const parentArgs = parents.flatMap(p => ['-p', p]);
  
  const result = await execAsyncOrThrow(
    ['commit-tree', treeSha, ...parentArgs, '-m', message],
    repoPath
  );
  
  const commitSha = result.trim();
  log?.(`[commit-tree] ✓ Created commit ${commitSha.slice(0, 8)}`);
  return commitSha;
}

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
    noCommit = false,
    log 
  } = options;
  
  log?.(`[merge] Merging '${source}' into '${target}'`);
  
  const args = ['merge'];
  
  if (noCommit) {
    args.push('--no-commit');
  }
  
  if (squash) {
    args.push('--squash');
  } else if (!fastForward) {
    args.push('--no-ff');
  }
  
  if (message && !squash && !noCommit) {
    args.push('-m', message);
  } else if (!message && !squash && !noCommit) {
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
  if (!result) {return [];}
  return result.split(/\r?\n/).filter(Boolean);
}

/**
 * Check if there's an in-progress merge.
 */
export async function isInProgress(cwd: string): Promise<boolean> {
  const result = await execAsync(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd });
  if (!result.success) {return false;}
  
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
