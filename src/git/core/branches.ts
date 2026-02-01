/**
 * @fileoverview Branch Operations - Git branch management (fully async).
 * 
 * Single responsibility: Create, delete, and query git branches.
 * All operations are async to avoid blocking the event loop.
 * 
 * @module git/core/branches
 */

import { execAsync, execAsyncOrNull, execAsyncOrThrow, GitLogger } from './executor';

// Cache for default branch per repo (doesn't change during session)
const defaultBranchCache = new Map<string, string | null>();

/**
 * Get the default branch for a repository (cached).
 */
async function getDefaultBranch(repoPath: string): Promise<string | null> {
  if (defaultBranchCache.has(repoPath)) {
    return defaultBranchCache.get(repoPath)!;
  }
  
  // Check if git considers this the default branch via origin/HEAD
  const originHead = await execAsyncOrNull(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath);
  if (originHead) {
    const defaultRef = originHead.replace('refs/remotes/origin/', '');
    defaultBranchCache.set(repoPath, defaultRef);
    return defaultRef;
  }
  
  // Fallback: check git config for init.defaultBranch
  const configDefault = await execAsyncOrNull(['config', '--get', 'init.defaultBranch'], repoPath);
  if (configDefault) {
    defaultBranchCache.set(repoPath, configDefault);
    return configDefault;
  }
  
  // No explicit default found
  defaultBranchCache.set(repoPath, null);
  return null;
}

/**
 * Check if a branch is considered a "default" branch.
 * 
 * This always consults git to determine the default branch rather than relying on
 * hardcoded names, respecting each repository's actual configuration.
 * 
 * @param branchName - Branch name to check (with or without refs/heads/ prefix)
 * @param repoPath - Path to the git repository
 */
export async function isDefaultBranch(branchName: string, repoPath: string): Promise<boolean> {
  const baseName = branchName.replace(/^refs\/heads\//, '');
  
  // Use cached default branch lookup
  const defaultBranch = await getDefaultBranch(repoPath);
  if (defaultBranch && baseName === defaultBranch) {
    return true;
  }
  
  // Final fallback: common default branch names
  return baseName === 'main' || baseName === 'master';
}

/**
 * Check if a local branch exists.
 */
export async function exists(branchName: string, repoPath: string): Promise<boolean> {
  const result = await execAsync(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoPath });
  return result.success;
}

/**
 * Check if a remote branch exists.
 */
export async function remoteExists(branchName: string, repoPath: string, remote: string = 'origin'): Promise<boolean> {
  const result = await execAsync(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branchName}`], { cwd: repoPath });
  return result.success;
}

/**
 * Get the current branch name.
 */
export async function current(repoPath: string): Promise<string> {
  return execAsyncOrThrow(['branch', '--show-current'], repoPath);
}

/**
 * Get the current branch name, or null if in detached HEAD state.
 */
export async function currentOrNull(repoPath: string): Promise<string | null> {
  return execAsyncOrNull(['branch', '--show-current'], repoPath);
}

/**
 * Create a local branch from another branch.
 */
export async function create(
  branchName: string,
  fromBranch: string,
  repoPath: string,
  log?: GitLogger
): Promise<void> {
  log?.(`[branch] Creating branch '${branchName}' from '${fromBranch}'`);
  await execAsyncOrThrow(['branch', branchName, fromBranch], repoPath);
  log?.(`[branch] ✓ Created branch '${branchName}'`);
}

/**
 * Create or reset a branch to point at another branch/commit.
 */
export async function createOrReset(
  branchName: string,
  fromRef: string,
  repoPath: string,
  log?: GitLogger
): Promise<void> {
  log?.(`[branch] Creating/resetting branch '${branchName}' to '${fromRef}'`);
  await execAsyncOrThrow(['branch', '-f', branchName, fromRef], repoPath);
  log?.(`[branch] ✓ Branch '${branchName}' set to '${fromRef}'`);
}

/**
 * Delete a local branch (throws on error).
 */
export async function remove(
  branchName: string,
  repoPath: string,
  options: { force?: boolean; log?: GitLogger } = {}
): Promise<void> {
  const { force = false, log } = options;
  log?.(`[branch] Deleting branch '${branchName}'`);
  const flag = force ? '-D' : '-d';
  await execAsyncOrThrow(['branch', flag, branchName], repoPath);
  log?.(`[branch] ✓ Deleted branch '${branchName}'`);
}

/**
 * Delete a local branch (returns success/failure, doesn't throw).
 */
export async function deleteLocal(
  repoPath: string,
  branchName: string,
  options: { force?: boolean; log?: GitLogger } = {}
): Promise<boolean> {
  const { force = false, log } = options;
  log?.(`[branch] Deleting local branch '${branchName}'`);
  const flag = force ? '-D' : '-d';
  const result = await execAsync(['branch', flag, branchName], { cwd: repoPath });
  if (result.success) {
    log?.(`[branch] ✓ Deleted local branch '${branchName}'`);
  }
  return result.success;
}

/**
 * Delete a remote branch (returns success/failure, doesn't throw).
 */
export async function deleteRemote(
  repoPath: string,
  branchName: string,
  options: { remote?: string; log?: GitLogger } = {}
): Promise<boolean> {
  const { remote = 'origin', log } = options;
  log?.(`[branch] Deleting remote branch '${remote}/${branchName}'`);
  const result = await execAsync(['push', remote, '--delete', branchName], { cwd: repoPath });
  if (result.success) {
    log?.(`[branch] ✓ Deleted remote branch '${remote}/${branchName}'`);
  }
  return result.success;
}

/**
 * Switch to a branch (throws on error).
 */
export async function checkout(repoPath: string, branchName: string, log?: GitLogger): Promise<void> {
  log?.(`[branch] Switching to branch '${branchName}'`);
  await execAsyncOrThrow(['switch', branchName], repoPath);
  log?.(`[branch] ✓ Switched to '${branchName}'`);
}

/**
 * List all local branches.
 */
export async function list(repoPath: string): Promise<string[]> {
  const result = await execAsyncOrNull(['branch', '--format=%(refname:short)'], repoPath);
  if (!result) return [];
  return result.split(/\r?\n/).filter(Boolean);
}

/**
 * Get the commit SHA a branch points to.
 */
export async function getCommit(branchName: string, repoPath: string): Promise<string | null> {
  return execAsyncOrNull(['rev-parse', branchName], repoPath);
}

/**
 * Get the merge base between two branches.
 */
export async function getMergeBase(branch1: string, branch2: string, repoPath: string): Promise<string | null> {
  return execAsyncOrNull(['merge-base', branch1, branch2], repoPath);
}
