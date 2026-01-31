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
export async function commit(cwd: string, message: string, log?: GitLogger): Promise<boolean> {
  log?.(`[git] Creating commit`);
  const result = await execAsync(['commit', '-m', message], { cwd });
  
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
