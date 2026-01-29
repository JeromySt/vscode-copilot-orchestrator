/**
 * @fileoverview Repository Operations - General git repository operations.
 * 
 * Single responsibility: Common repository queries and operations.
 * 
 * @module git/core/repository
 */

import { exec, execOrNull, execOrThrow, GitLogger, CommandResult } from './executor';

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
export function fetch(cwd: string, options: { remote?: string; all?: boolean; tags?: boolean; log?: GitLogger } = {}): void {
  const { remote = 'origin', all = false, tags = false, log } = options;
  
  const args = ['fetch'];
  if (all) args.push('--all');
  if (tags) args.push('--tags');
  if (!all) args.push(remote);
  
  log?.(`[git] Fetching${all ? ' all remotes' : ` from ${remote}`}`);
  execOrThrow(args, cwd);
  log?.(`[git] ✓ Fetch complete`);
}

/**
 * Pull changes (fast-forward only).
 */
export function pull(cwd: string, log?: GitLogger): boolean {
  log?.(`[git] Pulling changes (fast-forward only)`);
  const result = exec(['pull', '--ff-only'], { cwd });
  
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
export function push(cwd: string, options: { remote?: string; branch?: string; force?: boolean; log?: GitLogger } = {}): boolean {
  const { remote = 'origin', branch, force = false, log } = options;
  
  const args = ['push', remote];
  if (branch) args.push(branch);
  if (force) args.push('--force-with-lease');
  
  log?.(`[git] Pushing to ${remote}${branch ? `/${branch}` : ''}`);
  const result = exec(args, { cwd });
  
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
export function stageAll(cwd: string, log?: GitLogger): void {
  log?.(`[git] Staging all changes`);
  execOrThrow(['add', '-A'], cwd);
}

/**
 * Create a commit.
 */
export function commit(cwd: string, message: string, log?: GitLogger): boolean {
  log?.(`[git] Creating commit`);
  const result = exec(['commit', '-m', message], { cwd });
  
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
export function hasChanges(cwd: string): boolean {
  const result = exec(['status', '--porcelain'], { cwd });
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Check if there are staged changes.
 */
export function hasStagedChanges(cwd: string): boolean {
  const result = exec(['diff', '--cached', '--name-only'], { cwd });
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Get the current HEAD commit hash.
 */
export function getHead(cwd: string): string | null {
  return execOrNull(['rev-parse', 'HEAD'], cwd);
}

/**
 * Get commit log between two refs.
 */
export function getCommitLog(from: string, to: string, cwd: string): CommitInfo[] {
  const format = '%H|%h|%an|%ai|%s';
  const result = execOrNull(['log', `${from}..${to}`, `--pretty=format:${format}`, '--reverse'], cwd);
  
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
export function getCommitChanges(commitHash: string, cwd: string): FileChange[] {
  const result = execOrNull(['diff-tree', '--no-commit-id', '--name-status', '-r', commitHash], cwd);
  
  if (!result) return [];
  
  return result.split(/\r?\n/).filter(Boolean).map(line => {
    const [status, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    
    const statusMap: Record<string, FileChange['status']> = {
      'A': 'added',
      'M': 'modified',
      'D': 'deleted',
      'R': 'renamed',
      'C': 'copied'
    };
    
    return {
      status: statusMap[status.charAt(0)] || 'modified',
      path
    };
  });
}

/**
 * Get diff stats between two refs.
 */
export function getDiffStats(from: string, to: string, cwd: string): { added: number; modified: number; deleted: number } {
  const result = execOrNull(['diff', '--name-status', from, to], cwd);
  
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
export function ensureGitignore(repoPath: string, patterns: string[], log?: GitLogger): void {
  const fs = require('fs');
  const path = require('path');
  
  const gitignorePath = path.join(repoPath, '.gitignore');
  
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
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
      
      fs.writeFileSync(gitignorePath, content, 'utf-8');
      log?.(`[git] Updated .gitignore with orchestrator directories`);
    }
  } catch (e) {
    log?.(`[git] ⚠ Could not update .gitignore: ${e}`);
  }
}
