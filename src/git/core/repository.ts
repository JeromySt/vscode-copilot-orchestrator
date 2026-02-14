/**
 * @fileoverview Repository Operations - General git repository operations (fully async).
 * 
 * Single responsibility: Common repository queries and operations.
 * All operations are async to avoid blocking the event loop.
 * 
 * @module git/core/repository
 */

import * as fs from 'fs';
import * as path from 'path';
import { execAsync, execAsyncOrNull, execAsyncOrThrow, GitLogger, CommandResult } from './executor';

/**
 * Commit information.
 */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

/**
 * File change status.
 */
export interface FileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  path: string;
  oldPath?: string; // For renames
}

/**
 * Fetch from remote.
 */
export async function fetch(cwd: string, options: { remote?: string; all?: boolean; tags?: boolean; log?: GitLogger } = {}): Promise<void> {
  const { remote = 'origin', all = false, tags = false, log } = options;
  
  const args = ['fetch'];
  if (all) args.push('--all');
  if (tags) args.push('--tags');
  if (!all) args.push(remote);
  
  log?.(`[git] Fetching${all ? ' all remotes' : ` from ${remote}`}`);
  await execAsyncOrThrow(args, cwd);
  log?.(`[git] ✓ Fetch complete`);
}

/**
 * Pull changes (fast-forward only).
 */
export async function pull(cwd: string, log?: GitLogger): Promise<boolean> {
  log?.(`[git] Pulling changes (fast-forward only)`);
  const result = await execAsync(['pull', '--ff-only'], { cwd });
  
  if (result.success) {
    log?.(`[git] ✓ Pull complete`);
    return true;
  }
  
  // Check if it failed because no tracking branch
  if (result.stderr.includes('no tracking information')) {
    log?.(`[git] No upstream tracking branch, skipping pull`);
    return true;
  }
  
  log?.(`[git] ⚠ Pull failed: ${result.stderr}`);
  return false;
}

/**
 * Push to remote.
 */
export async function push(cwd: string, options: { remote?: string; branch?: string; force?: boolean; log?: GitLogger } = {}): Promise<boolean> {
  const { remote = 'origin', branch, force = false, log } = options;
  
  const args = ['push', remote];
  if (branch) args.push(branch);
  if (force) args.push('--force-with-lease');
  
  log?.(`[git] Pushing to ${remote}${branch ? `/${branch}` : ''}`);
  const result = await execAsync(args, { cwd });
  
  if (result.success) {
    log?.(`[git] ✓ Push complete`);
    return true;
  }
  
  log?.(`[git] ✗ Push failed: ${result.stderr}`);
  return false;
}

/**
 * Stage all changes.
 */
export async function stageAll(cwd: string, log?: GitLogger): Promise<void> {
  log?.(`[git] Staging all changes`);
  await execAsyncOrThrow(['add', '-A'], cwd);
}

/**
 * Create a commit.
 */
export async function commit(cwd: string, message: string, options: { allowEmpty?: boolean; log?: GitLogger } = {}): Promise<boolean> {
  const { allowEmpty = false, log } = options;
  log?.(`[git] Creating commit`);
  
  const args = ['commit', '-m', message];
  if (allowEmpty) args.push('--allow-empty');
  
  const result = await execAsync(args, { cwd });
  
  if (result.success) {
    log?.(`[git] ✓ Committed`);
    return true;
  }
  
  if (result.stdout.includes('nothing to commit') || result.stderr.includes('nothing to commit')) {
    log?.(`[git] Nothing to commit`);
    return true;
  }
  
  log?.(`[git] ✗ Commit failed: ${result.stderr}`);
  return false;
}

/**
 * Check if there are uncommitted changes.
 */
export async function hasChanges(cwd: string): Promise<boolean> {
  const result = await execAsync(['status', '--porcelain'], { cwd });
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Check if there are staged changes.
 */
export async function hasStagedChanges(cwd: string): Promise<boolean> {
  const result = await execAsync(['diff', '--cached', '--name-only'], { cwd });
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Get the current HEAD commit hash.
 */
export async function getHead(cwd: string): Promise<string | null> {
  return execAsyncOrNull(['rev-parse', 'HEAD'], cwd);
}

/**
 * Resolve a ref (branch name, tag, commit, etc.) to a full commit SHA.
 */
export async function resolveRef(ref: string, cwd: string): Promise<string> {
  const result = await execAsyncOrThrow(['rev-parse', ref], cwd);
  return result.trim();
}

/**
 * Get commit log between two refs.
 */
export async function getCommitLog(from: string, to: string, cwd: string): Promise<CommitInfo[]> {
  const format = '%H|%h|%an|%ai|%s';
  const result = await execAsyncOrNull(['log', `${from}..${to}`, `--pretty=format:${format}`, '--reverse'], cwd);
  
  if (!result) return [];
  
  return result.split(/\r?\n/).filter(Boolean).map(line => {
    const [hash, shortHash, author, date, ...messageParts] = line.split('|');
    return {
      hash,
      shortHash,
      author,
      date,
      message: messageParts.join('|')
    };
  });
}

/**
 * Get files changed in a commit.
 */
export async function getCommitChanges(commitHash: string, cwd: string): Promise<FileChange[]> {
  const result = await execAsyncOrNull(['diff-tree', '--no-commit-id', '--name-status', '-r', commitHash], cwd);
  
  if (!result) return [];
  
  return result.split(/\r?\n/).filter(Boolean).map(line => {
    const [status, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    
    const statusMap: Record<string, FileChange['status']> = {
      'A': 'added',
      'M': 'modified',
      'D': 'deleted',
      'R': 'renamed',
      'C': 'copied'
    };
    
    return {
      status: statusMap[status.charAt(0)] || 'modified',
      path: filePath
    };
  });
}

/**
 * Get diff stats between two refs.
 */
export async function getDiffStats(from: string, to: string, cwd: string): Promise<{ added: number; modified: number; deleted: number }> {
  const result = await execAsyncOrNull(['diff', '--name-status', from, to], cwd);
  
  let added = 0, modified = 0, deleted = 0;
  
  if (result) {
    for (const line of result.split(/\r?\n/).filter(Boolean)) {
      const status = line.charAt(0);
      if (status === 'A') added++;
      else if (status === 'M') modified++;
      else if (status === 'D') deleted++;
      else if (status === 'R') modified++; // Rename counts as modified
      else if (status === 'C') added++;    // Copy counts as added
    }
  }
  
  return { added, modified, deleted };
}

/**
 * Ensure orchestrator directories are in .gitignore.
 */
export async function ensureGitignore(repoPath: string, patterns: string[], log?: GitLogger): Promise<void> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  
  try {
    let content = '';
    try {
      content = await fs.promises.readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist
    }
    
    let modified = false;
    const toAdd: string[] = [];
    
    for (const pattern of patterns) {
      if (!content.includes(pattern.replace(/^\//, ''))) {
        toAdd.push(pattern);
        modified = true;
      }
    }
    
    if (modified) {
      if (!content.endsWith('\n') && content.length > 0) {
        content += '\n';
      }
      content += '# Copilot Orchestrator\n';
      content += toAdd.join('\n') + '\n';
      
      await fs.promises.writeFile(gitignorePath, content, 'utf-8');
      log?.(`[git] Updated .gitignore with orchestrator directories`);
    }
  } catch (e) {
    log?.(`[git] ⚠ Could not update .gitignore: ${e}`);
  }
}

// =============================================================================
// STASH OPERATIONS
// =============================================================================

/**
 * Check if there are uncommitted changes (staged or unstaged).
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await execAsync(['status', '--porcelain'], { cwd });
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Get list of uncommitted (dirty) files.
 * Returns file paths from `git status --porcelain`.
 */
export async function getDirtyFiles(cwd: string): Promise<string[]> {
  const result = await execAsync(['status', '--porcelain'], { cwd });
  if (!result.success || !result.stdout.trim()) {
    return [];
  }
  
  // Porcelain format: "XY filename" where XY is status, filename starts at index 3
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    // Handle renamed files: "R  old -> new"
    const filename = line.slice(3);
    if (filename.includes(' -> ')) {
      return filename.split(' -> ')[1];
    }
    return filename;
  });
}

/**
 * Stash uncommitted changes with a message.
 * Returns true if changes were stashed, false if nothing to stash.
 */
export async function stashPush(cwd: string, message: string, log?: GitLogger): Promise<boolean> {
  log?.(`[git] Stashing changes: ${message}`);
  
  // Check if there's anything to stash
  const hasChanges = await hasUncommittedChanges(cwd);
  if (!hasChanges) {
    log?.(`[git] Nothing to stash`);
    return false;
  }
  
  const result = await execAsync(['stash', 'push', '-m', message], { cwd });
  if (result.success) {
    log?.(`[git] ✓ Changes stashed`);
    return true;
  }
  
  throw new Error(`Failed to stash changes: ${result.stderr}`);
}

/**
 * Pop the most recent stash.
 */
export async function stashPop(cwd: string, log?: GitLogger): Promise<boolean> {
  log?.(`[git] Popping stash`);
  
  const result = await execAsync(['stash', 'pop'], { cwd });
  if (result.success) {
    log?.(`[git] ✓ Stash popped`);
    return true;
  }
  
  // "No stash entries found" is not an error for our purposes
  if (result.stderr.includes('No stash entries found')) {
    log?.(`[git] No stash to pop`);
    return false;
  }
  
  throw new Error(`Failed to pop stash: ${result.stderr}`);
}

/**
 * Drop the most recent stash (or a specific stash by index).
 */
export async function stashDrop(cwd: string, index?: number, log?: GitLogger): Promise<boolean> {
  const stashRef = index !== undefined ? `stash@{${index}}` : '';
  log?.(`[git] Dropping stash${stashRef ? ` ${stashRef}` : ''}`);
  
  const args = stashRef ? ['stash', 'drop', stashRef] : ['stash', 'drop'];
  const result = await execAsync(args, { cwd });
  if (result.success) {
    log?.(`[git] ✓ Stash dropped`);
    return true;
  }
  
  // "No stash entries found" is not an error for our purposes
  if (result.stderr.includes('No stash entries found')) {
    log?.(`[git] No stash to drop`);
    return false;
  }
  
  throw new Error(`Failed to drop stash: ${result.stderr}`);
}

/**
 * Checkout (discard changes to) a specific file.
 */
export async function checkoutFile(cwd: string, filePath: string, log?: GitLogger): Promise<void> {
  log?.(`[git] Checking out (discarding changes to): ${filePath}`);
  
  const result = await execAsync(['checkout', '--', filePath], { cwd });
  if (result.success) {
    log?.(`[git] ✓ File checked out: ${filePath}`);
    return;
  }
  
  throw new Error(`Failed to checkout file ${filePath}: ${result.stderr}`);
}

/**
 * Reset to a specific commit (hard reset).
 */
export async function resetHard(cwd: string, ref: string, log?: GitLogger): Promise<void> {
  log?.(`[git] Resetting to ${ref} (hard)`);
  
  const result = await execAsync(['reset', '--hard', ref], { cwd });
  if (result.success) {
    log?.(`[git] ✓ Reset to ${ref}`);
    return;
  }
  
  throw new Error(`Failed to reset to ${ref}: ${result.stderr}`);
}

/**
 * Update a branch reference to point to a specific commit without checkout.
 */
export async function updateRef(cwd: string, refName: string, commit: string, log?: GitLogger): Promise<void> {
  log?.(`[git] Updating ref ${refName} to ${commit}`);
  
  const result = await execAsync(['update-ref', refName, commit], { cwd });
  if (result.success) {
    log?.(`[git] ✓ Updated ${refName} to ${commit}`);
    return;
  }
  
  throw new Error(`Failed to update ref ${refName}: ${result.stderr}`);
}

/**
 * List stash entries.
 */
export async function stashList(cwd: string): Promise<string[]> {
  const result = await execAsyncOrNull(['stash', 'list'], cwd);
  if (!result) return [];
  return result.split(/\r?\n/).filter(Boolean);
}

/**
 * Stage a specific file.
 */
export async function stageFile(cwd: string, filePath: string, log?: GitLogger): Promise<void> {
  await execAsync(['add', filePath], { cwd, log });
}

/**
 * Get the diff of a specific file (unstaged changes).
 */
export async function getFileDiff(repoPath: string, filePath: string): Promise<string | null> {
  return execAsyncOrNull(['diff', filePath], repoPath);
}

/**
 * Get the diff of a specific file (staged changes).
 */
export async function getStagedFileDiff(repoPath: string, filePath: string): Promise<string | null> {
  return execAsyncOrNull(['diff', '--cached', filePath], repoPath);
}

/**
 * List files modified in the most recent stash.
 */
export async function stashShowFiles(repoPath: string): Promise<string[]> {
  const result = await execAsyncOrNull(['stash', 'show', '--name-only'], repoPath);
  return result ? result.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Get the patch (diff) of the most recent stash.
 */
export async function stashShowPatch(repoPath: string): Promise<string | null> {
  return execAsyncOrNull(['stash', 'show', '-p'], repoPath);
}

/**
 * Check if there are changes between two refs.
 */
export async function hasChangesBetween(from: string, to: string, repoPath: string): Promise<boolean> {
  const stats = await getDiffStats(from, to, repoPath);
  return (stats.added + stats.modified + stats.deleted) > 0;
}

/**
 * Clean untracked files and directories.
 */
export async function clean(cwd: string, log?: GitLogger): Promise<void> {
  log?.(`[git] Cleaning untracked files`);
  const result = await execAsync(['clean', '-fd'], { cwd });
  if (result.success) {
    log?.(`[git] ✓ Clean complete`);
    return;
  }
  throw new Error(`Failed to clean: ${result.stderr}`);
}

/**
 * Count commits between two refs.
 */
export async function getCommitCount(from: string, to: string, cwd: string): Promise<number> {
  const result = await execAsyncOrNull(['rev-list', '--count', `${from}..${to}`], cwd);
  return result ? (parseInt(result.trim(), 10) || 0) : 0;
}

/**
 * Get file changes between two refs with file paths grouped by status.
 */
export async function getFileChangesBetween(from: string, to: string, cwd: string): Promise<FileChange[]> {
  const result = await execAsyncOrNull(['diff', '--name-status', `${from}..${to}`], cwd);
  if (!result) return [];

  const statusMap: Record<string, FileChange['status']> = {
    'A': 'added', 'M': 'modified', 'D': 'deleted', 'R': 'renamed', 'C': 'copied'
  };

  return result.split(/\r?\n/).filter(Boolean).map(line => {
    const [status, ...pathParts] = line.split('\t');
    return {
      status: statusMap[status.charAt(0)] || 'modified',
      path: pathParts.join('\t'),
    };
  });
}

/**
 * Get list of ignored files for troubleshooting.
 * Uses git status --ignored to show files excluded by .gitignore.
 */
export async function getIgnoredFiles(cwd: string, log?: GitLogger): Promise<string[]> {
  log?.(`[git] Getting ignored files`);
  
  const result = await execAsync(['status', '--ignored', '--short'], { cwd });
  if (!result.success || !result.stdout.trim()) {
    log?.(`[git] ✓ No ignored files found`);
    return [];
  }
  
  // Filter to only lines starting with !! (ignored files)
  const ignoredFiles = result.stdout.trim().split(/\r?\n/)
    .filter(line => line.startsWith('!!'))
    .map(line => line.slice(3).trim()); // Remove '!! ' prefix
  
  log?.(`[git] ✓ Found ${ignoredFiles.length} ignored files`);
  return ignoredFiles;
}
