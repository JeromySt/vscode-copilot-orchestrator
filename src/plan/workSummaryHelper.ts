/**
 * @fileoverview Work Summary Helper
 *
 * Computes per-node and aggregated work summaries by diffing git commits.
 * Extracted from executor.ts to keep the orchestrator slim.
 *
 * @module plan/workSummaryHelper
 */

import type { IGitOperations } from '../interfaces/IGitOperations';
import { Logger } from '../core/logger';
import type { JobNode, JobWorkSummary, CommitDetail } from './types';

const log = Logger.for('job-executor');

function emptyWorkSummary(node: JobNode): JobWorkSummary {
  return { nodeId: node.id, nodeName: node.name, commits: 0, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: node.task };
}

async function getCommitDetails(worktreePath: string, baseCommit: string, headCommit: string, git: IGitOperations): Promise<CommitDetail[]> {
  try {
    const changes = await git.repository.getFileChangesBetween(baseCommit, headCommit, worktreePath);
    if (changes.length === 0) {return [];}
    const filesAdded: string[] = [], filesModified: string[] = [], filesDeleted: string[] = [];
    for (const change of changes) {
      if (change.status === 'added') {filesAdded.push(change.path);}
      else if (change.status === 'modified') {filesModified.push(change.path);}
      else if (change.status === 'deleted') {filesDeleted.push(change.path);}
    }
    return [{
      hash: headCommit, shortHash: headCommit.slice(0, 8),
      message: 'Work completed', author: 'Plan Runner', date: new Date().toISOString(),
      filesAdded, filesModified, filesDeleted,
    }];
  } catch { return []; }
}

export async function computeWorkSummary(node: JobNode, worktreePath: string, baseCommit: string, git: IGitOperations): Promise<JobWorkSummary> {
  try {
    const head = await git.worktrees.getHeadCommit(worktreePath);
    if (!head || (head === baseCommit && node.expectsNoChanges)) {
      if (node.expectsNoChanges) {return { ...emptyWorkSummary(node), description: 'Node declared expectsNoChanges', commitDetails: [] };}
      return emptyWorkSummary(node);
    }
    const commitDetails = await getCommitDetails(worktreePath, baseCommit, head, git);
    let filesAdded = 0, filesModified = 0, filesDeleted = 0;
    for (const d of commitDetails) { filesAdded += d.filesAdded.length; filesModified += d.filesModified.length; filesDeleted += d.filesDeleted.length; }
    return { nodeId: node.id, nodeName: node.name, commits: commitDetails.length, filesAdded, filesModified, filesDeleted, description: node.task, commitDetails };
  } catch (error: any) {
    log.warn(`Failed to compute work summary: ${error.message}`);
    return emptyWorkSummary(node);
  }
}

export async function computeAggregatedWorkSummary(node: JobNode, worktreePath: string, baseBranch: string, repoPath: string, git: IGitOperations): Promise<JobWorkSummary> {
  try {
    const headCommit = await git.worktrees.getHeadCommit(worktreePath);
    if (!headCommit) { log.warn('No HEAD commit in worktree for aggregated summary'); return emptyWorkSummary(node); }
    let baseBranchCommit: string;
    try {
      baseBranchCommit = await git.repository.resolveRef(baseBranch, repoPath);
    } catch {
      log.warn(`Failed to resolve baseBranch ${baseBranch}`);
      return emptyWorkSummary(node);
    }
    const diffStats = await git.repository.getDiffStats(baseBranchCommit, headCommit, worktreePath);
    const commits = await git.repository.getCommitCount(baseBranchCommit, headCommit, worktreePath);
    return { nodeId: node.id, nodeName: node.name, commits, filesAdded: diffStats.added, filesModified: diffStats.modified, filesDeleted: diffStats.deleted, description: `Aggregated work from ${baseBranch}` };
  } catch (error: any) {
    log.warn(`Failed to compute aggregated work summary: ${error.message}`);
    return emptyWorkSummary(node);
  }
}
