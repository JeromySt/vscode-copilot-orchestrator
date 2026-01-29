/**
 * @fileoverview Branch Operations - Git branch management.
 * 
 * Single responsibility: Create, delete, and query git branches.
 * 
 * @module git/core/branches
 */

import { exec, execOrNull, execOrThrow, GitLogger } from './executor';

/**
 * Check if a branch is considered a "default" branch.
 * 
 * This always consults git to determine the default branch rather than relying on
 * hardcoded names, respecting each repository's actual configuration.
 * 
 * @param branchName - Branch name to check (with or without refs/heads/ prefix)
 * @param repoPath - Path to the git repository
 */
export function isDefaultBranch(branchName: string, repoPath: string): boolean {
  const baseName = branchName.replace(/^refs\/heads\//, '');
  
  // Check if git considers this the default branch via origin/HEAD
  const originHead = execOrNull(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath);
  if (originHead) {
    const defaultRef = originHead.replace('refs/remotes/origin/', '');
    if (baseName === defaultRef) {
      return true;
    }
  }
  
  // Fallback: check git config for init.defaultBranch
  const configDefault = execOrNull(['config', '--get', 'init.defaultBranch'], repoPath);
  if (configDefault && baseName === configDefault) {
    return true;
  }
  
  // Final fallback: common default branch names
  return baseName === 'main' || baseName === 'master';
}

/**
 * Check if a local branch exists.
 */
export function exists(branchName: string, repoPath: string): boolean {
  const result = exec(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoPath });
  return result.success;
}

/**
 * Check if a remote branch exists.
 */
export function remoteExists(branchName: string, repoPath: string, remote: string = 'origin'): boolean {
  const result = exec(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branchName}`], { cwd: repoPath });
  return result.success;
}

/**
 * Get the current branch name.
 */
export function current(repoPath: string): string {
  return execOrThrow(['branch', '--show-current'], repoPath);
}

/**
 * Get the current branch name, or null if in detached HEAD state.
 */
export function currentOrNull(repoPath: string): string | null {
  return execOrNull(['branch', '--show-current'], repoPath);
}

/**
 * Create a local branch from another branch.
 */
export function create(
  branchName: string,
  fromBranch: string,
  repoPath: string,
  log?: GitLogger
): void {
  log?.(`[branch] Creating branch '${branchName}' from '${fromBranch}'`);
  execOrThrow(['branch', branchName, fromBranch], repoPath);
  log?.(`[branch] ✓ Created branch '${branchName}'`);
}

/**
 * Create or reset a branch to point at another branch/commit.
 */
export function createOrReset(
  branchName: string,
  fromRef: string,
  repoPath: string,
  log?: GitLogger
): void {
  log?.(`[branch] Creating/resetting branch '${branchName}' to '${fromRef}'`);
  execOrThrow(['branch', '-f', branchName, fromRef], repoPath);
  log?.(`[branch] ✓ Branch '${branchName}' set to '${fromRef}'`);
}

/**
 * Delete a local branch (throws on error).
 */
export function remove(
  branchName: string,
  repoPath: string,
  options: { force?: boolean; log?: GitLogger } = {}
): void {
  const { force = false, log } = options;
  log?.(`[branch] Deleting branch '${branchName}'`);
  const flag = force ? '-D' : '-d';
  execOrThrow(['branch', flag, branchName], repoPath);
  log?.(`[branch] ✓ Deleted branch '${branchName}'`);
}

/**
 * Delete a local branch (returns success/failure, doesn't throw).
 */
export function deleteLocal(
  repoPath: string,
  branchName: string,
  options: { force?: boolean; log?: GitLogger } = {}
): boolean {
  const { force = false, log } = options;
  log?.(`[branch] Deleting local branch '${branchName}'`);
  const flag = force ? '-D' : '-d';
  const result = exec(['branch', flag, branchName], { cwd: repoPath });
  if (result.success) {
    log?.(`[branch] ✓ Deleted local branch '${branchName}'`);
  }
  return result.success;
}

/**
 * Delete a remote branch (returns success/failure, doesn't throw).
 */
export function deleteRemote(
  repoPath: string,
  branchName: string,
  options: { remote?: string; log?: GitLogger } = {}
): boolean {
  const { remote = 'origin', log } = options;
  log?.(`[branch] Deleting remote branch '${remote}/${branchName}'`);
  const result = exec(['push', remote, '--delete', branchName], { cwd: repoPath });
  if (result.success) {
    log?.(`[branch] ✓ Deleted remote branch '${remote}/${branchName}'`);
  }
  return result.success;
}

/**
 * Switch to a branch (throws on error).
 */
export function checkout(repoPath: string, branchName: string, log?: GitLogger): void {
  log?.(`[branch] Switching to branch '${branchName}'`);
  execOrThrow(['switch', branchName], repoPath);
  log?.(`[branch] ✓ Switched to '${branchName}'`);
}

/**
 * List all local branches.
 */
export function list(repoPath: string): string[] {
  const result = execOrNull(['branch', '--format=%(refname:short)'], repoPath);
  if (!result) return [];
  return result.split(/\r?\n/).filter(Boolean);
}

/**
 * Get the commit SHA a branch points to.
 */
export function getCommit(branchName: string, repoPath: string): string | null {
  return execOrNull(['rev-parse', branchName], repoPath);
}

/**
 * Get the merge base between two branches.
 */
export function getMergeBase(branch1: string, branch2: string, repoPath: string): string | null {
  return execOrNull(['merge-base', branch1, branch2], repoPath);
}
