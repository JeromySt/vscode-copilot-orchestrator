/**
 * @fileoverview Work Summary Helper
 *
 * Computes per-node and aggregated work summaries by diffing git commits.
 * Extracted from executor.ts to keep the orchestrator slim.
 *
 * @module plan/workSummaryHelper
 */

import * as git from '../git';
import { Logger } from '../core/logger';
import type { JobNode, JobWorkSummary, CommitDetail } from './types';

const log = Logger.for('job-executor');

function emptyWorkSummary(node: JobNode): JobWorkSummary {
  return { nodeId: node.id, nodeName: node.name, commits: 0, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: node.task };
}

async function getCommitDetails(worktreePath: string, baseCommit: string, headCommit: string): Promise<CommitDetail[]> {
  try {
    const diffResult = await git.executor.execAsync(
      ['diff', '--stat', '--name-status', `${baseCommit}..${headCommit}`],
      { cwd: worktreePath },
    );
    if (!diffResult.success) return [];
    const filesAdded: string[] = [], filesModified: string[] = [], filesDeleted: string[] = [];
    for (const line of diffResult.stdout.split('\n').filter(l => l.trim())) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        if (parts[0] === 'A') filesAdded.push(parts[1]);
        else if (parts[0] === 'M') filesModified.push(parts[1]);
        else if (parts[0] === 'D') filesDeleted.push(parts[1]);
      }
    }
    return [{
      hash: headCommit, shortHash: headCommit.slice(0, 8),
      message: 'Work completed', author: 'Plan Runner', date: new Date().toISOString(),
      filesAdded, filesModified, filesDeleted,
    }];
  } catch { return []; }
}

export async function computeWorkSummary(node: JobNode, worktreePath: string, baseCommit: string): Promise<JobWorkSummary> {
  try {
    const head = await git.worktrees.getHeadCommit(worktreePath);
    if (!head || (head === baseCommit && node.expectsNoChanges)) {
      if (node.expectsNoChanges) return { ...emptyWorkSummary(node), description: 'Node declared expectsNoChanges', commitDetails: [] };
      return emptyWorkSummary(node);
    }
    const commitDetails = await getCommitDetails(worktreePath, baseCommit, head);
    let filesAdded = 0, filesModified = 0, filesDeleted = 0;
    for (const d of commitDetails) { filesAdded += d.filesAdded.length; filesModified += d.filesModified.length; filesDeleted += d.filesDeleted.length; }
    return { nodeId: node.id, nodeName: node.name, commits: commitDetails.length, filesAdded, filesModified, filesDeleted, description: node.task, commitDetails };
  } catch (error: any) {
    log.warn(`Failed to compute work summary: ${error.message}`);
    return emptyWorkSummary(node);
  }
}

export async function computeAggregatedWorkSummary(node: JobNode, worktreePath: string, baseBranch: string, repoPath: string): Promise<JobWorkSummary> {
  try {
    const headCommit = await git.worktrees.getHeadCommit(worktreePath);
    if (!headCommit) { log.warn('No HEAD commit in worktree for aggregated summary'); return emptyWorkSummary(node); }
    const baseBranchResult = await git.executor.execAsync(['rev-parse', baseBranch], { cwd: repoPath });
    if (!baseBranchResult.success || !baseBranchResult.stdout.trim()) { log.warn(`Failed to resolve baseBranch ${baseBranch}`); return emptyWorkSummary(node); }
    const baseBranchCommit = baseBranchResult.stdout.trim();
    const diffResult = await git.executor.execAsync(['diff', '--name-status', `${baseBranchCommit}..${headCommit}`], { cwd: worktreePath });
    let filesAdded = 0, filesModified = 0, filesDeleted = 0;
    if (diffResult.success) {
      for (const line of diffResult.stdout.split('\n').filter(l => l.trim())) {
        const parts = line.split('\t');
        if (parts.length >= 2) { if (parts[0] === 'A') filesAdded++; else if (parts[0] === 'M') filesModified++; else if (parts[0] === 'D') filesDeleted++; }
      }
    }
    const ccr = await git.executor.execAsync(['rev-list', '--count', `${baseBranchCommit}..${headCommit}`], { cwd: worktreePath });
    const commits = ccr.success ? parseInt(ccr.stdout.trim(), 10) || 0 : 0;
    return { nodeId: node.id, nodeName: node.name, commits, filesAdded, filesModified, filesDeleted, description: `Aggregated work from ${baseBranch}` };
  } catch (error: any) {
    log.warn(`Failed to compute aggregated work summary: ${error.message}`);
    return emptyWorkSummary(node);
  }
}
