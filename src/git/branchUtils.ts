/**
 * @fileoverview Branch Utilities - Core branch management logic.
 * 
 * Handles the branching logic for both standalone jobs and plans:
 * 
 * ## Branch Origin Rules:
 * - Default branch (main, master) → MUST create feature branch as targetBranchRoot
 * - Non-default branch → Use current branch as targetBranchRoot
 * 
 * ## Worktree Ownership:
 * - Standalone jobs: Job creates/manages/cleans up its own worktree
 * - Plan-managed jobs: Plan creates/manages/cleans up worktrees, job just executes
 * 
 * @module git/branchUtils
 */

import { spawnSync, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

/**
 * Check if a branch is considered a "default" branch.
 * Default branches require feature branch creation - we never merge directly into them.
 * 
 * This always consults git to determine the default branch rather than relying on
 * hardcoded names, respecting each repository's actual configuration.
 */
export function isDefaultBranch(branchName: string, repoPath: string): boolean {
  const baseName = branchName.replace(/^refs\/heads\//, '');
  
  // Check if git considers this the default branch via origin/HEAD
  try {
    const result = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    if (result.status === 0) {
      const defaultRef = result.stdout.trim().replace('refs/remotes/origin/', '');
      if (baseName === defaultRef) {
        return true;
      }
    }
  } catch {
    // Continue to fallback check
  }
  
  // Fallback: check git config for init.defaultBranch
  try {
    const result = spawnSync('git', ['config', '--get', 'init.defaultBranch'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    if (result.status === 0) {
      const configDefault = result.stdout.trim();
      if (baseName === configDefault) {
        return true;
      }
    }
  } catch {
    // Continue to final fallback
  }
  
  // Final fallback: if no origin/HEAD and no config, check if this looks like 'main' or 'master'
  // This only applies when git config is unavailable (rare edge case)
  if (baseName === 'main' || baseName === 'master') {
    return true;
  }
  
  return false;
}

/**
 * Check if a local branch exists.
 */
export function localBranchExists(branchName: string, repoPath: string): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
    cwd: repoPath
  });
  return result.status === 0;
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8'
  });
  return result.stdout.trim();
}

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
  if (isDefaultBranch(baseBranch, repoPath)) {
    // Default branch - must create a feature branch
    const featureBranch = `${featureBranchPrefix}/${randomUUID()}`;
    return { targetBranchRoot: featureBranch, needsCreation: true };
  } else {
    // Non-default branch - use as-is
    return { targetBranchRoot: baseBranch, needsCreation: false };
  }
}

/**
 * Create a local branch from another branch.
 */
export function createBranch(
  branchName: string,
  fromBranch: string,
  repoPath: string,
  log: (s: string) => void
): void {
  log(`[branch] Creating branch '${branchName}' from '${fromBranch}'`);
  execSync(`git branch "${branchName}" "${fromBranch}"`, { cwd: repoPath });
  log(`[branch] ✓ Created branch '${branchName}'`);
}

/**
 * Delete a local branch.
 */
export function deleteBranch(
  branchName: string,
  repoPath: string,
  log: (s: string) => void,
  force: boolean = false
): void {
  log(`[branch] Deleting branch '${branchName}'`);
  const flag = force ? '-D' : '-d';
  execSync(`git branch ${flag} "${branchName}"`, { cwd: repoPath });
  log(`[branch] ✓ Deleted branch '${branchName}'`);
}

/**
 * Create a worktree for a branch.
 * 
 * @param worktreePath - Absolute path where worktree will be created
 * @param branchName - Branch to check out in the worktree (will be created if needed)
 * @param fromBranch - Branch to create the new branch from (if branchName doesn't exist)
 */
export function createWorktree(
  worktreePath: string,
  branchName: string,
  fromBranch: string,
  repoPath: string,
  log: (s: string) => void
): void {
  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  
  log(`[worktree] Creating worktree at '${worktreePath}' on branch '${branchName}' from '${fromBranch}'`);
  
  // Use -B to create or reset the branch to fromBranch's HEAD
  execSync(`git worktree add -B "${branchName}" "${worktreePath}" "${fromBranch}"`, { cwd: repoPath });
  
  log(`[worktree] ✓ Created worktree`);
  
  // Initialize and update submodules in the worktree
  initializeSubmodules(worktreePath, repoPath, branchName, log);
}

/**
 * Initialize and update submodules in a worktree.
 * 
 * This ensures that any submodules defined in the repository are properly
 * checked out in the worktree context.
 */
function initializeSubmodules(
  worktreePath: string,
  repoPath: string,
  worktreeBranch: string,
  log: (s: string) => void
): void {
  // Check if there's a .gitmodules file (indicates submodules exist)
  const gitmodulesPath = path.join(worktreePath, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) {
    log(`[worktree] No submodules detected`);
    return;
  }
  
  log(`[worktree] Initializing submodules...`);
  
  try {
    // Initialize submodules
    execSync('git submodule update --init --recursive', { 
      cwd: worktreePath,
      stdio: 'pipe'
    });
    log(`[worktree] ✓ Submodules initialized`);
    
    // Configure submodule.recurse for future git operations
    execSync('git config submodule.recurse true', { 
      cwd: worktreePath,
      stdio: 'pipe'
    });
    log(`[worktree] ✓ Configured submodule.recurse`);
    
    // For each submodule, create a worktree on the same branch if it has one configured
    const submodules = getSubmoduleInfo(repoPath);
    for (const submodule of submodules) {
      const submodulePath = path.join(worktreePath, submodule.path);
      
      if (!fs.existsSync(submodulePath)) {
        log(`[worktree] Submodule path not found: ${submodule.path}`);
        continue;
      }
      
      // Check if submodule has a specific branch configured
      if (submodule.branch) {
        log(`[worktree] Submodule '${submodule.name}' has branch '${submodule.branch}' configured`);
        
        // Check if the configured branch exists on remote
        const branchExists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${submodule.branch}`], { 
          cwd: submodulePath 
        });
        
        if (branchExists.status === 0) {
          // Create worktree branch in submodule tracking the configured branch
          try {
            execSync(`git checkout -B "${worktreeBranch}" "origin/${submodule.branch}"`, {
              cwd: submodulePath,
              stdio: 'pipe'
            });
            log(`[worktree] ✓ Submodule '${submodule.name}' on branch '${worktreeBranch}' tracking 'origin/${submodule.branch}'`);
          } catch (e) {
            log(`[worktree] ⚠ Could not checkout branch for submodule '${submodule.name}': ${e}`);
          }
        }
      }
    }
  } catch (error) {
    log(`[worktree] ⚠ Submodule initialization warning: ${error}`);
    // Don't fail the worktree creation if submodule init fails
  }
}

/**
 * Get information about submodules in a repository.
 */
function getSubmoduleInfo(repoPath: string): Array<{ name: string; path: string; branch?: string }> {
  const submodules: Array<{ name: string; path: string; branch?: string }> = [];
  
  try {
    // Get submodule paths from .gitmodules
    const result = spawnSync('git', ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], {
      cwd: repoPath,
      encoding: 'utf-8'
    });
    
    if (result.status !== 0 || !result.stdout) {
      return submodules;
    }
    
    const lines = result.stdout.trim().split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^submodule\.(.*?)\.path\s+(.*)$/);
      if (!match) continue;
      
      const name = match[1];
      const submodulePath = match[2];
      
      // Check if submodule has a branch configured
      const branchResult = spawnSync('git', ['config', '--file', '.gitmodules', `submodule.${name}.branch`], {
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      const branch = branchResult.status === 0 ? branchResult.stdout.trim() : undefined;
      
      submodules.push({ name, path: submodulePath, branch });
    }
  } catch {
    // Ignore errors reading submodule config
  }
  
  return submodules;
}

/**
 * Remove a worktree.
 */
export function removeWorktree(
  worktreePath: string,
  repoPath: string,
  log: (s: string) => void
): void {
  log(`[worktree] Removing worktree at '${worktreePath}'`);
  execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath });
  execSync('git worktree prune', { cwd: repoPath });
  log(`[worktree] ✓ Removed worktree`);
}

/**
 * Squash merge a branch into another branch.
 * 
 * @param sourceBranch - Branch to merge from
 * @param targetBranch - Branch to merge into
 * @param commitMessage - Commit message for the squash commit
 */
export function squashMerge(
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  repoPath: string,
  log: (s: string) => void
): void {
  log(`[merge] Squash merging '${sourceBranch}' into '${targetBranch}'`);
  
  // Switch to target branch
  execSync(`git switch "${targetBranch}"`, { cwd: repoPath });
  
  // Squash merge
  execSync(`git merge --squash "${sourceBranch}"`, { cwd: repoPath });
  
  // Commit (may fail if nothing to commit, that's ok)
  try {
    execSync(`git commit -m "${commitMessage}"`, { cwd: repoPath });
    log(`[merge] ✓ Squash merge completed`);
  } catch {
    log(`[merge] ✓ No changes to commit (branches already in sync)`);
  }
}

/**
 * Ensure all changes in a worktree are committed.
 */
export function finalizeWorktree(
  worktreePath: string,
  commitMessage: string,
  log: (s: string) => void
): void {
  log(`[worktree] Finalizing changes in worktree`);
  
  try {
    execSync('git add -A', { cwd: worktreePath });
    execSync(`git commit -m "${commitMessage}" || echo "no changes to commit"`, { 
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    log(`[worktree] ✓ Changes committed`);
  } catch {
    log(`[worktree] No changes to commit`);
  }
}

/**
 * Check if a path is a valid git worktree.
 */
export function isValidWorktree(worktreePath: string): boolean {
  const gitPath = path.join(worktreePath, '.git');
  return fs.existsSync(worktreePath) && fs.existsSync(gitPath);
}

/**
 * Get the branch name of a worktree.
 */
export function getWorktreeBranch(worktreePath: string): string | null {
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd: worktreePath,
      encoding: 'utf-8'
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}
