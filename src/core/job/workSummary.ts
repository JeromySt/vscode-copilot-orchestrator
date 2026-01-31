/**
 * @fileoverview Work Summary - Calculate and describe work performed by a job.
 * 
 * Single responsibility: Analyze git history to summarize job output.
 * Uses git/* modules for all git operations (async to avoid blocking).
 * 
 * @module core/job/workSummary
 */

import * as path from 'path';
import { Logger, ComponentLogger } from '../logger';
import * as git from '../../git';
import { Job, WorkSummary, CommitDetail } from './types';

const log: ComponentLogger = Logger.for('jobs');

/**
 * Calculate a summary of work performed by a job.
 * Analyzes commits since the job branch forked from baseBranch.
 */
export async function calculateWorkSummary(job: Job): Promise<WorkSummary> {
  // Use provided worktreePath for plan-managed jobs, otherwise build the path
  const worktreePath = job.inputs.worktreePath || 
    path.join(job.inputs.repoPath, job.inputs.worktreeRoot, job.id);
  const baseBranch = job.inputs.baseBranch;

  let commits = 0;
  let filesAdded = 0;
  let filesModified = 0;
  let filesDeleted = 0;
  const commitDetails: CommitDetail[] = [];

  try {
    // Find the merge-base (where the worktree branch forked from baseBranch)
    const mergeBase = await git.branches.getMergeBase('HEAD', baseBranch, worktreePath);
    
    if (!mergeBase) {
      log.warn(`Could not find merge base for job`, { jobId: job.id, baseBranch });
      return createEmptySummary();
    }

    // Get commit list since merge base
    const commitList = await git.repository.getCommitLog(mergeBase, 'HEAD', worktreePath);
    commits = commitList.length;

    // Get detailed commit information
    for (const commit of commitList) {
      const changes = await git.repository.getCommitChanges(commit.hash, worktreePath);
      
      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];
      
      for (const change of changes) {
        if (change.status === 'added') added.push(change.path);
        else if (change.status === 'modified') modified.push(change.path);
        else if (change.status === 'deleted') deleted.push(change.path);
        else if (change.status === 'renamed') modified.push(change.path);
        else if (change.status === 'copied') added.push(change.path);
      }
      
      commitDetails.push({
        hash: commit.hash,
        shortHash: commit.shortHash,
        author: commit.author,
        date: commit.date,
        message: commit.message,
        filesAdded: added,
        filesModified: modified,
        filesDeleted: deleted,
      });
    }

    // Get total file changes since the fork point (for summary)
    const totalChanges = await git.repository.getDiffStats(mergeBase, 'HEAD', worktreePath);
    filesAdded = totalChanges.added;
    filesModified = totalChanges.modified;
    filesDeleted = totalChanges.deleted;

    log.debug(`Calculated work summary for job`, {
      jobId: job.id,
      commits,
      mergeBase: mergeBase.substring(0, 8),
    });
  } catch (e: any) {
    log.warn(`Could not calculate work summary`, { jobId: job.id, error: e.message });
  }

  // Build description string
  const description = buildDescription(commits, filesAdded, filesModified, filesDeleted);

  return { commits, filesAdded, filesModified, filesDeleted, description, commitDetails };
}

/**
 * Create an empty work summary.
 */
function createEmptySummary(): WorkSummary {
  return {
    commits: 0,
    filesAdded: 0,
    filesModified: 0,
    filesDeleted: 0,
    description: 'No changes recorded',
    commitDetails: []
  };
}

/**
 * Build a human-readable description from change stats.
 */
function buildDescription(commits: number, added: number, modified: number, deleted: number): string {
  if (commits === 0) {
    return 'No changes recorded';
  }

  const parts: string[] = [];
  
  if (commits === 1) {
    parts.push('1 commit');
  } else {
    parts.push(`${commits} commits`);
  }

  const fileParts: string[] = [];
  if (added > 0) fileParts.push(`+${added}`);
  if (modified > 0) fileParts.push(`~${modified}`);
  if (deleted > 0) fileParts.push(`-${deleted}`);
  
  if (fileParts.length > 0) {
    parts.push(`(${fileParts.join(', ')} files)`);
  }

  return parts.join(' ');
}

/**
 * Re-export for backwards compatibility
 */
export function calculateWorkSummaryFromGit(job: Job): WorkSummary {
  // Note: This sync wrapper is deprecated. Use calculateWorkSummary instead.
  // Returns empty summary - caller should use async version
  log.warn('calculateWorkSummaryFromGit is deprecated, use async calculateWorkSummary');
  return createEmptySummary();
}
