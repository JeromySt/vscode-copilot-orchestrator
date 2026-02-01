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
 * Timing breakdown for worktree creation.
 */
export interface CreateTiming {
  worktreeMs: number;
  submoduleMs: number;
  totalMs: number;
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
  await createWithTiming(options);
}

/**
 * Create a git worktree and return timing breakdown.
 * 
 * Creates or resets the branch to point at fromRef and creates a worktree
 * with that branch checked out. Also initializes submodules if present.
 * 
 * @param options - Worktree creation options
 * @returns Timing breakdown
 * @throws Error if worktree creation fails
 */
export async function createWithTiming(options: CreateOptions): Promise<CreateTiming> {
  const { repoPath, worktreePath, branchName, fromRef, log } = options;
  const totalStart = Date.now();
  
  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  try {
    await fs.promises.access(parentDir);
  } catch {
    await fs.promises.mkdir(parentDir, { recursive: true });
  }
  
  log?.(`[worktree] Creating worktree at '${worktreePath}' on branch '${branchName}' from '${fromRef}'`);
  
  // Use -B to create or reset the branch to fromRef's HEAD
  const wtAddStart = Date.now();
  await execAsyncOrThrow(['worktree', 'add', '-B', branchName, worktreePath, fromRef], repoPath);
  const worktreeMs = Date.now() - wtAddStart;
  
  log?.(`[worktree] ✓ Created worktree (${worktreeMs}ms)`);
  
  // Initialize submodules (await so we can time it)
  const submoduleMs = await initializeSubmodules(worktreePath, branchName, log);
  
  const totalMs = Date.now() - totalStart;
  return { worktreeMs, submoduleMs, totalMs };
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
  
  if (!result.success) {
    log?.(`[worktree] ⚠ git worktree remove failed: ${result.stderr}`);
  }
  
  // Always prune to clean up stale worktree references
  await execAsync(['worktree', 'prune'], { cwd: repoPath });
  
  if (result.success) {
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
 * Returns time taken in ms (0 if no submodules).
 * 
 * For worktrees, we need to:
 * 1. Check if .gitmodules exists
 * 2. Run submodule init to register submodules
 * 3. Run submodule update to actually clone them
 */
async function initializeSubmodules(worktreePath: string, worktreeBranch: string, log?: GitLogger): Promise<number> {
  const gitmodulesPath = path.join(worktreePath, '.gitmodules');
  
  // Async check for .gitmodules
  try {
    await fs.promises.access(gitmodulesPath);
  } catch {
    log?.(`[worktree] No submodules detected (no .gitmodules file)`);
    return 0;
  }
  
  // Submodules exist - initialize them
  log?.(`[worktree] .gitmodules found, initializing submodules...`);
  
  try {
    const submodStart = Date.now();
    
    // First, explicitly init submodules (required for worktrees)
    log?.(`[worktree] Running: git submodule init`);
    const initResult = await execAsync(['submodule', 'init'], { 
      cwd: worktreePath,
      timeoutMs: 30000
    });
    if (!initResult.success) {
      log?.(`[worktree] ⚠ submodule init warning: ${initResult.stderr}`);
    }
    
    // Then update with recursive to clone nested submodules
    log?.(`[worktree] Running: git submodule update --init --recursive`);
    const updateResult = await execAsync(['submodule', 'update', '--init', '--recursive'], { 
      cwd: worktreePath, 
      timeoutMs: 300000 // 5 minutes for large submodules
    });
    
    if (!updateResult.success) {
      log?.(`[worktree] ⚠ submodule update failed: ${updateResult.stderr}`);
      // Try alternative: sync and then update
      log?.(`[worktree] Trying: git submodule sync --recursive`);
      await execAsync(['submodule', 'sync', '--recursive'], { cwd: worktreePath });
      
      log?.(`[worktree] Retrying: git submodule update --init --recursive`);
      const retryResult = await execAsync(['submodule', 'update', '--init', '--recursive'], { 
        cwd: worktreePath, 
        timeoutMs: 300000
      });
      if (!retryResult.success) {
        log?.(`[worktree] ⚠ submodule update retry failed: ${retryResult.stderr}`);
      }
    }
    
    const submodTime = Date.now() - submodStart;
    log?.(`[worktree] ✓ Submodules initialized (${submodTime}ms)`);
    
    // Configure submodule.recurse for future git operations
    await execAsync(['config', 'submodule.recurse', 'true'], { cwd: worktreePath });
    
    return submodTime;
  } catch (error) {
    log?.(`[worktree] ⚠ Submodule initialization error: ${error}`);
    return 0;
  }
}
