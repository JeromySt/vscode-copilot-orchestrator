/**
 * @fileoverview Orchestrator-specific git utilities (fully async).
 * 
 * Contains business logic specific to the orchestrator's branching strategy.
 * Uses the core git modules for actual git operations.
 * All operations are async to avoid blocking the event loop.
 * 
 * @module git/orchestrator
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../core/logger';
import * as branches from './core/branches';
import * as worktrees from './core/worktrees';
import * as repository from './core/repository';
import { ensureGitignoreEntries } from './core/gitignore';
import { execAsync, GitLogger } from './core/executor';

const log = Logger.for('git');

// =============================================================================
// Branch Resolution
// =============================================================================

/**
 * Convert a string to a valid git branch name slug.
 * 
 * Rules:
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Remove consecutive hyphens
 * - Remove leading/trailing hyphens
 * - Truncate to reasonable length
 */
export function slugify(name: string, maxLength: number = 50): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
    .replace(/-+/g, '-')           // Collapse consecutive hyphens
    .replace(/^-|-$/g, '')         // Remove leading/trailing hyphens
    .slice(0, maxLength);          // Truncate
}

/**
 * Determine the targetBranchRoot for a job or plan.
 * 
 * Rules:
 * - If baseBranch is a default branch → create and return a new feature branch name
 * - If baseBranch is not default → return baseBranch as-is
 * 
 * @param baseBranch - The base branch to check
 * @param repoPath - Path to the git repository
 * @param featureBranchPrefix - Prefix for the feature branch (e.g., 'copilot_plan', 'users/name')
 * @param branchSuffix - Optional suffix for the branch name (e.g., plan name slug). If not provided, generates a short UUID.
 * @returns Object with targetBranchRoot and whether a new branch needs to be created
 */
export async function resolveTargetBranchRoot(
  baseBranch: string,
  repoPath: string,
  featureBranchPrefix: string = 'copilot_jobs',
  branchSuffix?: string
): Promise<{ targetBranchRoot: string; needsCreation: boolean }> {
  const isDefault = await branches.isDefaultBranch(baseBranch, repoPath);
  if (isDefault) {
    // Default branch - must create a feature branch
    // Use provided suffix (plan name slug) or generate a short unique ID
    const suffix = branchSuffix || randomUUID().split('-')[0];
    // Remove trailing slash from prefix to avoid double slashes
    const normalizedPrefix = featureBranchPrefix.replace(/\/+$/, '');
    const featureBranch = `${normalizedPrefix}/${suffix}`;
    return { targetBranchRoot: featureBranch, needsCreation: true };
  } else {
    // Non-default branch - use as-is
    return { targetBranchRoot: baseBranch, needsCreation: false };
  }
}

// =============================================================================
// Worktree Management (Orchestrator-specific)
// =============================================================================

export interface JobWorktreeOptions {
  /** Repository path */
  repoPath: string;
  /** Root directory for worktrees (relative to repoPath) */
  worktreeRoot: string;
  /** Unique job/worktree identifier */
  jobId: string;
  /** Branch to base the worktree on */
  baseBranch: string;
  /** Branch name for the worktree (usually targetBranch) */
  targetBranch: string;
  /** Logger function */
  logger?: GitLogger;
}

/**
 * Create a job worktree with proper orchestrator setup.
 * 
 * This handles:
 * - Ensuring .gitignore includes orchestrator directories
 * - Fetching latest changes
 * - Creating the worktree with submodule support
 * - Handling retry scenarios where worktree already exists
 * 
 * @returns Absolute path to the created worktree
 */
export async function createJobWorktree(options: JobWorktreeOptions): Promise<string> {
  const { repoPath, worktreeRoot, jobId, baseBranch, targetBranch, logger } = options;
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  // Ensure orchestrator directories are in .gitignore
  await ensureGitignoreEntries(repoPath, [worktreeRoot, '.orchestrator'], logFn);
  
  // Fetch latest changes (does not affect working directory)
  logFn('[git] Fetching latest changes...');
  await execAsync(['fetch', '--all', '--tags'], { cwd: repoPath });
  
  // NOTE: We intentionally do NOT checkout baseBranch in the main repo.
  // All work happens in worktrees to avoid disrupting the user's working directory.
  // The worktree will be created from the fetched baseBranch ref directly.
  
  // Create worktree path
  const worktreeRootAbs = path.join(repoPath, worktreeRoot);
  const worktreePath = path.join(worktreeRootAbs, jobId);
  
  // Check if worktree already exists (for retry scenarios)
  const isValidWt = await worktrees.isValid(worktreePath);
  if (isValidWt) {
    logFn(`[git] Worktree already exists, reusing: ${worktreePath}`);
    await execAsync(['fetch', '--all'], { cwd: worktreePath });
    return worktreePath;
  }
  
  // Create new worktree from the base branch ref (fetched, not checked out)
  // Use origin/baseBranch if available, otherwise local baseBranch
  let fromRef = baseBranch;
  const remoteRef = `origin/${baseBranch}`;
  const hasRemote = await branches.exists(remoteRef, repoPath);
  if (hasRemote) {
    fromRef = remoteRef;
    logFn(`[git] Creating worktree from ${fromRef}`);
  } else {
    logFn(`[git] Creating worktree from local ${fromRef}`);
  }
  
  await worktrees.create({
    repoPath,
    worktreePath,
    branchName: targetBranch,
    fromRef,
    log: logFn
  });
  
  return worktreePath;
}

/**
 * Remove a job worktree and optionally its branch.
 */
export async function removeJobWorktree(
  worktreePath: string,
  repoPath: string,
  options: { deleteBranch?: boolean; branchName?: string; logger?: GitLogger } = {}
): Promise<void> {
  const { deleteBranch = false, branchName, logger } = options;
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  // Remove worktree
  try {
    await worktrees.remove(worktreePath, repoPath, logFn);
  } catch (e) {
    logFn(`[git] Warning: Could not remove worktree: ${e}`);
  }
  
  // Delete branch if requested
  if (deleteBranch && branchName) {
    try {
      await branches.remove(branchName, repoPath, { force: true, log: logFn });
    } catch (e) {
      logFn(`[git] Warning: Could not delete branch: ${e}`);
    }
  }
}

// =============================================================================
// Commit Helpers
// =============================================================================

/**
 * Finalize a worktree by staging and committing all changes.
 */
export async function finalizeWorktree(
  worktreePath: string,
  commitMessage: string,
  logger?: GitLogger
): Promise<boolean> {
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  logFn('[git] Finalizing worktree changes...');
  
  // Stage all changes
  await repository.stageAll(worktreePath);
  
  // Check if there are staged changes
  const hasStaged = await repository.hasStagedChanges(worktreePath);
  if (!hasStaged) {
    logFn('[git] No changes to commit');
    return false;
  }
  
  // Commit
  await repository.commit(worktreePath, commitMessage, { log: logFn });
  logFn('[git] ✓ Changes committed');
  return true;
}

// =============================================================================
// Merge Helpers  
// =============================================================================

/**
 * Squash merge a branch into another.
 * 
 * IMPORTANT: This function operates in the provided repoPath, which should
 * be a worktree path, NOT the main repository. The caller is responsible
 * for ensuring the target branch is checked out in the worktree.
 */
export async function squashMerge(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  worktreePath: string,
  logger?: GitLogger
): Promise<void> {
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  logFn(`[git] Squash merging '${sourceBranch}' into '${targetBranch}'`);
  
  // Verify we're on the target branch
  const currentBranch = await branches.current(worktreePath);
  if (currentBranch !== targetBranch) {
    logFn(`[git] Switching to target branch '${targetBranch}'`);
    await branches.checkout(targetBranch, worktreePath, logFn);
  }
  
  // Squash merge
  await execAsync(['merge', '--squash', sourceBranch], { cwd: worktreePath, throwOnError: true });
  
  // Commit (may have nothing to commit if branches are in sync)
  const hasStaged = await repository.hasStagedChanges(worktreePath);
  if (hasStaged) {
    await repository.commit(worktreePath, commitMessage, { log: logFn });
    logFn('[git] ✓ Squash merge completed');
  } else {
    logFn('[git] ✓ No changes to commit (branches already in sync)');
  }
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

// Re-export commonly used functions from core modules
export { isDefaultBranch, exists as branchExists, currentOrNull as getCurrentBranch, create as createBranch } from './core/branches';
export { isValid as isValidWorktree, getBranch as getWorktreeBranch } from './core/worktrees';
