/**
 * @fileoverview Worktree Operations - Git worktree management.
 * 
 * Single responsibility: Create, remove, and query git worktrees.
 * 
 * @module git/core/worktrees
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec, execOrThrow, execOrNull, GitLogger } from './executor';
import * as branches from './branches';

/**
 * Worktree creation options.
 */
export interface CreateOptions {
  /** Working directory of the main repository */
  repoPath: string;
  /** Path where the worktree will be created */
  worktreePath: string;
  /** Branch name for the worktree */
  branchName: string;
  /** Branch/commit to base the worktree branch on */
  fromRef: string;
  /** Logger function */
  log?: GitLogger;
}

/**
 * Create a git worktree.
 * 
 * Creates or resets the branch to point at fromRef and creates a worktree
 * with that branch checked out.
 * 
 * @param options - Worktree creation options
 * @throws Error if worktree creation fails
 */
export function create(options: CreateOptions): void {
  const { repoPath, worktreePath, branchName, fromRef, log } = options;
  
  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  
  log?.(`[worktree] Creating worktree at '${worktreePath}' on branch '${branchName}' from '${fromRef}'`);
  
  // Use -B to create or reset the branch to fromRef's HEAD
  execOrThrow(['worktree', 'add', '-B', branchName, worktreePath, fromRef], repoPath);
  
  log?.(`[worktree] ✓ Created worktree`);
  
  // Initialize submodules
  initializeSubmodules(worktreePath, branchName, log);
}

/**
 * Remove a git worktree (throws on error).
 * 
 * @param worktreePath - Path to the worktree to remove
 * @param repoPath - Path to the main repository
 * @param log - Optional logger
 */
export function remove(worktreePath: string, repoPath: string, log?: GitLogger): void {
  log?.(`[worktree] Removing worktree at '${worktreePath}'`);
  execOrThrow(['worktree', 'remove', worktreePath, '--force'], repoPath);
  exec(['worktree', 'prune'], { cwd: repoPath });
  log?.(`[worktree] ✓ Removed worktree`);
  
  // Git worktree remove sometimes leaves empty directories behind
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      log?.(`[worktree] ✓ Removed leftover directory`);
    } catch (e) {
      // Ignore - best effort cleanup
    }
  }
}

/**
 * Remove a git worktree (returns success/failure, doesn't throw).
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path to the worktree to remove
 * @param options - Options including force flag and logger
 */
export function removeSafe(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean; log?: GitLogger } = {}
): boolean {
  const { force = true, log } = options;
  log?.(`[worktree] Removing worktree at '${worktreePath}'`);
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const result = exec(args, { cwd: repoPath });
  if (result.success) {
    exec(['worktree', 'prune'], { cwd: repoPath });
    log?.(`[worktree] ✓ Removed worktree`);
  }
  
  // Git worktree remove sometimes leaves empty directories behind
  // Clean up any remaining directory
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      log?.(`[worktree] ✓ Removed leftover directory`);
    } catch (e) {
      // Ignore - best effort cleanup
    }
  }
  
  return result.success;
}

/**
 * Check if a path is a valid git worktree.
 */
export function isValid(worktreePath: string): boolean {
  const gitPath = path.join(worktreePath, '.git');
  return fs.existsSync(worktreePath) && fs.existsSync(gitPath);
}

/**
 * Get the branch name of a worktree.
 */
export function getBranch(worktreePath: string): string | null {
  return branches.currentOrNull(worktreePath);
}

/**
 * List all worktrees for a repository.
 */
export function list(repoPath: string): Array<{ path: string; branch: string | null }> {
  const result = execOrNull(['worktree', 'list', '--porcelain'], repoPath);
  if (!result) return [];
  
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  
  for (const line of result.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.substring(9);
      currentBranch = null;
    } else if (line.startsWith('branch ')) {
      currentBranch = line.substring(7).replace('refs/heads/', '');
    }
  }
  
  if (currentPath) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }
  
  return worktrees;
}

/**
 * Prune stale worktree references.
 */
export function prune(repoPath: string): void {
  exec(['worktree', 'prune'], { cwd: repoPath });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Initialize submodules in a worktree.
 */
function initializeSubmodules(worktreePath: string, worktreeBranch: string, log?: GitLogger): void {
  const gitmodulesPath = path.join(worktreePath, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) {
    log?.(`[worktree] No submodules detected`);
    return;
  }
  
  log?.(`[worktree] Initializing submodules...`);
  
  try {
    exec(['submodule', 'update', '--init', '--recursive'], { 
      cwd: worktreePath, 
      throwOnError: true 
    });
    log?.(`[worktree] ✓ Submodules initialized`);
    
    // Configure submodule.recurse for future git operations
    exec(['config', 'submodule.recurse', 'true'], { cwd: worktreePath });
    log?.(`[worktree] ✓ Configured submodule.recurse`);
  } catch (error) {
    log?.(`[worktree] ⚠ Submodule initialization warning: ${error}`);
    // Don't fail the worktree creation if submodule init fails
  }
}
