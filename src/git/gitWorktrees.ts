/**
 * @fileoverview Legacy Git Worktree Creation (async).
 * 
 * This module provides the legacy createWorktrees function for backward compatibility.
 * It now uses the async git/core modules to avoid blocking the event loop.
 * 
 * @module git/gitWorktrees
 */

import * as path from 'path';
import * as fs from 'fs';
import { ensureDirAsync } from '../core/utils';
import { execAsync, execAsyncOrThrow } from './core/executor';
import * as worktrees from './core/worktrees';

export type WorktreePlan = {
  jobId: string;
  repoPath: string;
  worktreeRoot: string;
  baseBranch: string;
  targetBranch: string;
};

/**
 * Create worktrees for a job (async version).
 * 
 * This handles:
 * - Ensuring .gitignore includes orchestrator directories
 * - Fetching latest changes
 * - Creating the worktree with submodule support
 * - Handling retry scenarios where worktree already exists
 * 
 * @param plan - Worktree creation plan
 * @param log - Logger function
 * @returns Path to the created worktree
 */
export async function createWorktrees(plan: WorktreePlan, log: (s: string) => void): Promise<string> {
  const { repoPath, worktreeRoot, baseBranch, targetBranch, jobId } = plan;

  // Ensure orchestrator directories are in .gitignore to prevent tracking runtime data
  await ensureGitignorePatterns(repoPath, worktreeRoot, log);

  // Fetch latest changes
  log(`[orchestrator] Fetching latest changes...`);
  await execAsync(['fetch', '--all', '--tags'], { cwd: repoPath });

  // Switch to base branch - handle both local and remote-tracked branches
  log(`[orchestrator] Switching to base branch '${baseBranch}'`);
  await execAsyncOrThrow(['switch', baseBranch], repoPath);

  // Try to pull if branch has upstream, otherwise skip
  const pullResult = await execAsync(['pull', '--ff-only'], { cwd: repoPath });

  // Log output regardless of success (informational)
  if (pullResult.stdout) log(pullResult.stdout);
  if (pullResult.stderr && pullResult.success) log(pullResult.stderr);

  // Only warn if pull failed for reasons other than "no tracking information"
  if (!pullResult.success && pullResult.stderr && !pullResult.stderr.includes('no tracking information')) {
    log(`[orchestrator] Warning: Pull failed - ${pullResult.stderr}`);
    // Don't throw, continue with current state
  }

  // Create worktree path
  const wtRootAbs = path.join(repoPath, worktreeRoot);
  await ensureDirAsync(wtRootAbs);
  const jobRoot = path.join(wtRootAbs, jobId);

  // Check if worktree already exists (for retry/continue scenarios)
  const isValidWt = await worktrees.isValid(jobRoot);
  if (isValidWt) {
    log(`[orchestrator] Worktree already exists, reusing: ${jobRoot}`);
    // Just ensure we're up to date
    await execAsync(['fetch', '--all'], { cwd: jobRoot });
    return jobRoot;
  }

  // Create new worktree
  await ensureDirAsync(jobRoot);

  // The worktree branch IS the targetBranch - no separate "job branch" needed
  // This avoids creating duplicate branches that point to the same commit
  const worktreeBranch = targetBranch;

  log(`[orchestrator] Creating worktree on branch '${worktreeBranch}' from '${baseBranch}'`);

  // Use -B to create or reset the branch to baseBranch's HEAD
  await execAsyncOrThrow(['worktree', 'add', '-B', worktreeBranch, jobRoot, baseBranch], repoPath);

  // Initialize submodules
  await initializeSubmodules(repoPath, jobRoot, worktreeBranch, log);

  return jobRoot;
}

/**
 * Ensure orchestrator directories are in .gitignore.
 */
async function ensureGitignorePatterns(repoPath: string, worktreeRoot: string, log: (s: string) => void): Promise<void> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  
  try {
    let gitignoreContent = '';
    try {
      gitignoreContent = await fs.promises.readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist
    }

    let modified = false;

    // Add worktreeRoot to .gitignore if not already there
    const ignorePattern = worktreeRoot.startsWith('/') ? worktreeRoot : `/${worktreeRoot}`;
    if (!gitignoreContent.includes(worktreeRoot)) {
      gitignoreContent += (gitignoreContent.endsWith('\n') || gitignoreContent === '' ? '' : '\n') +
        `# Copilot Orchestrator\n${ignorePattern}\n`;
      modified = true;
    }

    // Add .orchestrator directory (contains logs, patches, job metadata)
    if (!gitignoreContent.includes('.orchestrator')) {
      gitignoreContent += (gitignoreContent.endsWith('\n') ? '' : '\n') +
        `/.orchestrator\n`;
      modified = true;
    }

    if (modified) {
      await fs.promises.writeFile(gitignorePath, gitignoreContent, 'utf-8');
      log(`[orchestrator] Updated .gitignore with orchestrator directories`);
    }
  } catch (e) {
    log(`[orchestrator] Warning: Could not update .gitignore: ${e}`);
  }
}

/**
 * Initialize submodules in a worktree.
 */
async function initializeSubmodules(
  repoPath: string,
  jobRoot: string,
  worktreeBranch: string,
  log: (s: string) => void
): Promise<void> {
  // Initialize submodules in the main repo
  await execAsync(['submodule', 'update', '--init', '--recursive'], { cwd: repoPath });
  
  // Configure submodule.recurse in the worktree
  await execAsync(['config', 'submodule.recurse', 'true'], { cwd: jobRoot });

  // Get list of submodules
  const listResult = await execAsync(
    ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
    { cwd: repoPath }
  );

  if (!listResult.success || !listResult.stdout) {
    return;
  }

  const lines = listResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  
  for (const line of lines) {
    const m = line.match(/^submodule\.(.*?)\.path\s+(.*)$/);
    if (!m) continue;

    const name = m[1];
    const smPath = m[2];

    // Get branch for this submodule
    const branchResult = await execAsync(
      ['config', '--file', '.gitmodules', `submodule.${name}.branch`],
      { cwd: repoPath }
    );
    const branch = branchResult.stdout?.trim() || 'main';

    const abs = path.join(repoPath, smPath);
    const dest = path.join(jobRoot, smPath);
    await ensureDirAsync(path.dirname(dest));

    // Check if remote branch exists
    const checkResult = await execAsync(
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      { cwd: abs }
    );

    if (checkResult.success) {
      // Use worktreeBranch for submodule worktrees as well (consistent naming)
      await execAsync(
        ['worktree', 'add', '-B', worktreeBranch, dest, `origin/${branch}`],
        { cwd: abs }
      );
    } else {
      // Fallback to HEAD
      const headResult = await execAsync(['rev-parse', 'HEAD'], { cwd: abs });
      const head = headResult.stdout?.trim() || 'HEAD';
      await execAsync(['worktree', 'add', dest, head], { cwd: abs });
    }
  }
}
