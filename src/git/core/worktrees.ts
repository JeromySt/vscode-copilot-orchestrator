/**
 * @fileoverview Worktree Operations - Git worktree management (fully async).
 * 
 * Single responsibility: Create, remove, and query git worktrees.
 * All operations are async to avoid blocking the event loop.
 * 
 * @module git/core/worktrees
 */

import * as fs from 'fs';
import * as path from 'path';
import { execAsync, execAsyncOrThrow, execAsyncOrNull, GitLogger } from './executor';
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
export async function create(options: CreateOptions): Promise<void> {
  const { repoPath, worktreePath, branchName, fromRef, log } = options;
  
  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  try {
    await fs.promises.access(parentDir);
  } catch {
    await fs.promises.mkdir(parentDir, { recursive: true });
  }
  
  log?.(`[worktree] Creating worktree at '${worktreePath}' on branch '${branchName}' from '${fromRef}'`);
  
  // Use -B to create or reset the branch to fromRef's HEAD
  await execAsyncOrThrow(['worktree', 'add', '-B', branchName, worktreePath, fromRef], repoPath);
  
  log?.(`[worktree] ✓ Created worktree`);
  
  // Initialize submodules
  await initializeSubmodules(worktreePath, branchName, log);
}

/**
 * Remove a git worktree (throws on error).
 * 
 * @param worktreePath - Path to the worktree to remove
 * @param repoPath - Path to the main repository
 * @param log - Optional logger
 */
export async function remove(worktreePath: string, repoPath: string, log?: GitLogger): Promise<void> {
  log?.(`[worktree] Removing worktree at '${worktreePath}'`);
  await execAsyncOrThrow(['worktree', 'remove', worktreePath, '--force'], repoPath);
  await execAsync(['worktree', 'prune'], { cwd: repoPath });
  log?.(`[worktree] ✓ Removed worktree`);
  
  // Git worktree remove sometimes leaves empty directories behind
  try {
    await fs.promises.access(worktreePath);
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
    log?.(`[worktree] ✓ Removed leftover directory`);
  } catch {
    // Ignore - directory doesn't exist or cleanup failed
  }
}

/**
 * Remove a git worktree (returns success/failure, doesn't throw).
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path to the worktree to remove
 * @param options - Options including force flag and logger
 */
export async function removeSafe(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean; log?: GitLogger } = {}
): Promise<boolean> {
  const { force = true, log } = options;
  log?.(`[worktree] Removing worktree at '${worktreePath}'`);
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const result = await execAsync(args, { cwd: repoPath });
  if (result.success) {
    await execAsync(['worktree', 'prune'], { cwd: repoPath });
    log?.(`[worktree] ✓ Removed worktree`);
  }
  
  // Git worktree remove sometimes leaves empty directories behind
  // Clean up any remaining directory
  try {
    await fs.promises.access(worktreePath);
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
    log?.(`[worktree] ✓ Removed leftover directory`);
  } catch {
    // Ignore - directory doesn't exist or cleanup failed
  }
  
  return result.success;
}

/**
 * Check if a path is a valid git worktree.
 */
export async function isValid(worktreePath: string): Promise<boolean> {
  const gitPath = path.join(worktreePath, '.git');
  try {
    await fs.promises.access(worktreePath);
    await fs.promises.access(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the branch name of a worktree.
 */
export async function getBranch(worktreePath: string): Promise<string | null> {
  return branches.currentOrNull(worktreePath);
}

/**
 * List all worktrees for a repository.
 */
export async function list(repoPath: string): Promise<Array<{ path: string; branch: string | null }>> {
  const result = await execAsyncOrNull(['worktree', 'list', '--porcelain'], repoPath);
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
export async function prune(repoPath: string): Promise<void> {
  await execAsync(['worktree', 'prune'], { cwd: repoPath });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Initialize submodules in a worktree.
 */
async function initializeSubmodules(worktreePath: string, worktreeBranch: string, log?: GitLogger): Promise<void> {
  const gitmodulesPath = path.join(worktreePath, '.gitmodules');
  try {
    await fs.promises.access(gitmodulesPath);
  } catch {
    log?.(`[worktree] No submodules detected`);
    return;
  }
  
  log?.(`[worktree] Initializing submodules...`);
  
  try {
    await execAsync(['submodule', 'update', '--init', '--recursive'], { 
      cwd: worktreePath, 
      throwOnError: true 
    });
    log?.(`[worktree] ✓ Submodules initialized`);
    
    // Configure submodule.recurse for future git operations
    await execAsync(['config', 'submodule.recurse', 'true'], { cwd: worktreePath });
    log?.(`[worktree] ✓ Configured submodule.recurse`);
  } catch (error) {
    log?.(`[worktree] ⚠ Submodule initialization warning: ${error}`);
    // Don't fail the worktree creation if submodule init fails
  }
}
