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
 * with that branch checked out. For submodules, creates symlinks to the
 * original submodule folders (avoiding expensive re-checkout).
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
  
  // Setup submodules via symlinks (much faster than full checkout)
  const submoduleMs = await setupSubmoduleSymlinks(repoPath, worktreePath, log);
  
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
 * Create a worktree in detached HEAD mode at a specific commit/branch.
 * 
 * This is useful when you don't need a branch - commits can be merged by SHA.
 * Benefits: No branch to manage/cleanup, no "branch already checked out" errors.
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path where the worktree will be created
 * @param commitish - Branch name or commit to checkout (detached)
 * @param log - Optional logger
 * @throws Error if worktree creation fails
 */
export async function createDetached(
  repoPath: string,
  worktreePath: string,
  commitish: string,
  log?: GitLogger
): Promise<void> {
  await createDetachedWithTiming(repoPath, worktreePath, commitish, log);
}

/**
 * Create a worktree in detached HEAD mode and return timing info.
 * 
 * This is the preferred method for job worktrees:
 * - No branch created (detached HEAD)
 * - Returns the base commit SHA for tracking
 * - Submodules set up via symlinks
 * 
 * @param repoPath - Path to the main repository
 * @param worktreePath - Path where the worktree will be created
 * @param commitish - Branch name or commit to start from (detached)
 * @param log - Optional logger
 * @returns Timing breakdown and base commit SHA
 */
export async function createDetachedWithTiming(
  repoPath: string,
  worktreePath: string,
  commitish: string,
  log?: GitLogger
): Promise<CreateTiming & { baseCommit: string }> {
  const totalStart = Date.now();
  
  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  try {
    await fs.promises.access(parentDir);
  } catch {
    await fs.promises.mkdir(parentDir, { recursive: true });
  }
  
  // Resolve the commitish to a SHA first (for tracking)
  const resolveResult = await execAsync(['rev-parse', commitish], { cwd: repoPath });
  const baseCommit = resolveResult.success ? resolveResult.stdout.trim() : commitish;
  
  log?.(`[worktree] Creating detached worktree at '${worktreePath}' from '${commitish}' (${baseCommit.slice(0, 8)})`);
  
  // Use --detach to create worktree in detached HEAD mode
  const wtAddStart = Date.now();
  await execAsyncOrThrow(['worktree', 'add', '--detach', worktreePath, commitish], repoPath);
  const worktreeMs = Date.now() - wtAddStart;
  
  log?.(`[worktree] ✓ Created detached worktree (${worktreeMs}ms)`);
  
  // Setup submodules via symlinks
  const submoduleMs = await setupSubmoduleSymlinks(repoPath, worktreePath, log);
  
  const totalMs = Date.now() - totalStart;
  return { worktreeMs, submoduleMs, totalMs, baseCommit };
}

/**
 * Get the current HEAD commit SHA from a worktree.
 */
export async function getHeadCommit(worktreePath: string): Promise<string | null> {
  const result = await execAsync(['rev-parse', 'HEAD'], { cwd: worktreePath });
  return result.success ? result.stdout.trim() : null;
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
 * Setup submodules in a worktree using symlinks.
 * 
 * Instead of running expensive `git submodule update --init --recursive`,
 * we create symlinks from the worktree's submodule paths to the original
 * submodule folders in the main repo. This is MUCH faster and works because:
 * - The main repo's submodules are already initialized
 * - Submodule content doesn't typically change between branches
 * - If it does, the user can manually init submodules
 * 
 * Returns time taken in ms (0 if no submodules).
 */
async function setupSubmoduleSymlinks(repoPath: string, worktreePath: string, log?: GitLogger): Promise<number> {
  const gitmodulesPath = path.join(worktreePath, '.gitmodules');
  
  log?.(`[worktree] Checking for submodules at: ${gitmodulesPath}`);
  
  // Check if .gitmodules exists in worktree
  try {
    await fs.promises.access(gitmodulesPath);
    const stats = await fs.promises.stat(gitmodulesPath);
    if (stats.size === 0) {
      log?.(`[worktree] .gitmodules exists but is empty - no submodules`);
      return 0;
    }
    log?.(`[worktree] .gitmodules found (${stats.size} bytes)`);
  } catch (err: any) {
    log?.(`[worktree] No submodules detected: ${err.code || err.message}`);
    return 0;
  }
  
  const submodStart = Date.now();
  
  // Parse .gitmodules to get submodule paths
  const listResult = await execAsync(
    ['config', '--file', gitmodulesPath, '--get-regexp', '^submodule\\..*\\.path$'],
    { cwd: worktreePath }
  );
  
  if (!listResult.success || !listResult.stdout.trim()) {
    log?.(`[worktree] Could not parse .gitmodules`);
    return 0;
  }
  
  const lines = listResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  let symlinksCreated = 0;
  let symlinksFailed = 0;
  
  for (const line of lines) {
    const match = line.match(/^submodule\.(.*?)\.path\s+(.*)$/);
    if (!match) continue;
    
    const submoduleName = match[1];
    const submodulePath = match[2];
    
    const sourceInRepo = path.join(repoPath, submodulePath);
    const destInWorktree = path.join(worktreePath, submodulePath);
    
    try {
      // Check if submodule exists in main repo
      const sourceStats = await fs.promises.stat(sourceInRepo);
      if (!sourceStats.isDirectory()) {
        log?.(`[worktree] ⚠ Submodule '${submoduleName}' at '${sourceInRepo}' is not a directory`);
        symlinksFailed++;
        continue;
      }
      
      // Ensure parent directory exists in worktree
      await fs.promises.mkdir(path.dirname(destInWorktree), { recursive: true });
      
      // Remove any existing file/directory at destination
      try {
        const destStats = await fs.promises.lstat(destInWorktree);
        if (destStats.isSymbolicLink() || destStats.isFile()) {
          await fs.promises.unlink(destInWorktree);
        } else if (destStats.isDirectory()) {
          await fs.promises.rm(destInWorktree, { recursive: true, force: true });
        }
      } catch {
        // Destination doesn't exist, that's fine
      }
      
      // Create symlink (use junction on Windows for directory symlinks without admin rights)
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await fs.promises.symlink(sourceInRepo, destInWorktree, symlinkType);
      
      symlinksCreated++;
      log?.(`[worktree] ✓ Symlinked submodule '${submoduleName}': ${destInWorktree} -> ${sourceInRepo}`);
      
    } catch (err: any) {
      symlinksFailed++;
      log?.(`[worktree] ⚠ Failed to symlink submodule '${submoduleName}': ${err.message}`);
    }
  }
  
  const submodTime = Date.now() - submodStart;
  
  if (symlinksCreated > 0) {
    log?.(`[worktree] ✓ Created ${symlinksCreated} submodule symlink(s) in ${submodTime}ms`);
  }
  
  if (symlinksFailed > 0) {
    log?.(`[worktree] ⚠ ${symlinksFailed} submodule symlink(s) failed - run 'git submodule update --init' in worktree if needed`);
  }
  
  // Configure submodule.recurse for git operations (in case user does init later)
  await execAsync(['config', 'submodule.recurse', 'true'], { cwd: worktreePath });
  
  return submodTime;
}
