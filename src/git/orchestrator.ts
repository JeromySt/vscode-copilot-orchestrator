/**
 * @fileoverview Orchestrator-specific git utilities.
 * 
 * Contains business logic specific to the orchestrator's branching strategy.
 * Uses the core git modules for actual git operations.
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
import { exec, GitLogger } from './core/executor';

const log = Logger.for('git');

// =============================================================================
// Branch Resolution
// =============================================================================

/**
 * Determine the targetBranchRoot for a job or plan.
 * 
 * Rules:
 * - If baseBranch is a default branch → create and return a new feature branch name
 * - If baseBranch is not default → return baseBranch as-is
 * 
 * @returns Object with targetBranchRoot and whether a new branch needs to be created
 */
export function resolveTargetBranchRoot(
  baseBranch: string,
  repoPath: string,
  featureBranchPrefix: string = 'copilot_jobs'
): { targetBranchRoot: string; needsCreation: boolean } {
  if (branches.isDefaultBranch(baseBranch, repoPath)) {
    // Default branch - must create a feature branch
    const featureBranch = `${featureBranchPrefix}/${randomUUID()}`;
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
export function createJobWorktree(options: JobWorktreeOptions): string {
  const { repoPath, worktreeRoot, jobId, baseBranch, targetBranch, logger } = options;
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  // Ensure orchestrator directories are in .gitignore
  ensureGitignorePatterns(repoPath, [worktreeRoot, '.orchestrator'], logFn);
  
  // Fetch latest changes
  logFn('[git] Fetching latest changes...');
  exec(['fetch', '--all', '--tags'], { cwd: repoPath });
  
  // Switch to base branch and try to pull
  logFn(`[git] Switching to base branch '${baseBranch}'`);
  branches.checkout(baseBranch, repoPath);
  
  // Try to pull (non-fatal if fails)
  const pullResult = exec(['pull', '--ff-only'], { cwd: repoPath });
  if (!pullResult.success && pullResult.stderr && !pullResult.stderr.includes('no tracking information')) {
    logFn(`[git] Warning: Pull failed - ${pullResult.stderr}`);
  }
  
  // Create worktree path
  const worktreeRootAbs = path.join(repoPath, worktreeRoot);
  const worktreePath = path.join(worktreeRootAbs, jobId);
  
  // Check if worktree already exists (for retry scenarios)
  if (worktrees.isValid(worktreePath)) {
    logFn(`[git] Worktree already exists, reusing: ${worktreePath}`);
    exec(['fetch', '--all'], { cwd: worktreePath });
    return worktreePath;
  }
  
  // Create new worktree
  worktrees.create({
    repoPath,
    worktreePath,
    branchName: targetBranch,
    fromRef: baseBranch,
    log: logFn
  });
  
  return worktreePath;
}

/**
 * Remove a job worktree and optionally its branch.
 */
export function removeJobWorktree(
  worktreePath: string,
  repoPath: string,
  options: { deleteBranch?: boolean; branchName?: string; logger?: GitLogger } = {}
): void {
  const { deleteBranch = false, branchName, logger } = options;
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  // Remove worktree
  try {
    worktrees.remove(worktreePath, repoPath, logFn);
  } catch (e) {
    logFn(`[git] Warning: Could not remove worktree: ${e}`);
  }
  
  // Delete branch if requested
  if (deleteBranch && branchName) {
    try {
      branches.remove(branchName, repoPath, { force: true, log: logFn });
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
export function finalizeWorktree(
  worktreePath: string,
  commitMessage: string,
  logger?: GitLogger
): boolean {
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  logFn('[git] Finalizing worktree changes...');
  
  // Stage all changes
  repository.stageAll(worktreePath);
  
  // Check if there are staged changes
  if (!repository.hasStagedChanges(worktreePath)) {
    logFn('[git] No changes to commit');
    return false;
  }
  
  // Commit
  repository.commit(worktreePath, commitMessage, logFn);
  logFn('[git] ✓ Changes committed');
  return true;
}

// =============================================================================
// Merge Helpers  
// =============================================================================

/**
 * Squash merge a branch into another.
 */
export function squashMerge(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  repoPath: string,
  logger?: GitLogger
): void {
  const logFn = logger || ((msg: string) => log.debug(msg));
  
  logFn(`[git] Squash merging '${sourceBranch}' into '${targetBranch}'`);
  
  // Switch to target branch
  branches.checkout(targetBranch, repoPath, logFn);
  
  // Squash merge
  exec(['merge', '--squash', sourceBranch], { cwd: repoPath, throwOnError: true });
  
  // Commit (may have nothing to commit if branches are in sync)
  if (repository.hasStagedChanges(repoPath)) {
    repository.commit(repoPath, commitMessage, logFn);
    logFn('[git] ✓ Squash merge completed');
  } else {
    logFn('[git] ✓ No changes to commit (branches already in sync)');
  }
}

// =============================================================================
// Gitignore Management
// =============================================================================

/**
 * Ensure specified patterns are in .gitignore.
 */
export function ensureGitignorePatterns(
  repoPath: string,
  patterns: string[],
  logger?: GitLogger
): void {
  const gitignorePath = path.join(repoPath, '.gitignore');
  
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    
    let modified = false;
    const linesToAdd: string[] = [];
    
    for (const pattern of patterns) {
      const normalizedPattern = pattern.startsWith('/') ? pattern : `/${pattern}`;
      if (!content.includes(pattern)) {
        linesToAdd.push(normalizedPattern);
        modified = true;
      }
    }
    
    if (modified) {
      const separator = content.endsWith('\n') || content === '' ? '' : '\n';
      const newContent = content + separator + '# Copilot Orchestrator\n' + linesToAdd.join('\n') + '\n';
      fs.writeFileSync(gitignorePath, newContent, 'utf-8');
      logger?.('[git] Updated .gitignore with orchestrator patterns');
    }
  } catch (e) {
    logger?.(`[git] Warning: Could not update .gitignore: ${e}`);
  }
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

// Re-export commonly used functions from core modules
export { isDefaultBranch, exists as branchExists, current as getCurrentBranch } from './core/branches';
export { isValid as isValidWorktree, getBranch as getWorktreeBranch } from './core/worktrees';
