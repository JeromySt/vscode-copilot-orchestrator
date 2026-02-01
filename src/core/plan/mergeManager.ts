/**
 * @fileoverview Plan Merge Manager - Handles merging completed work back to target branches.
 * 
 * Single responsibility: Merge completed job/sub-plan branches to target branches,
 * including incremental (leaf) merging and final RI merge.
 * 
 * Uses the git/* modules for all git operations - fully async to avoid blocking.
 * 
 * @module core/plan/mergeManager
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { Logger, ComponentLogger } from '../logger';
import { PlanSpec, InternalPlanState } from './types';
import * as git from '../../git';

const log: ComponentLogger = Logger.for('plans');

/**
 * Configuration for merge operations.
 */
interface MergeConfig {
  /** Which side to prefer on conflicts: 'ours' or 'theirs' */
  prefer: 'ours' | 'theirs';
  /** Whether to push to remote after successful merge */
  pushOnSuccess: boolean;
}

/**
 * Get merge configuration from VS Code settings.
 */
function getMergeConfig(): MergeConfig {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  return {
    prefer: cfg.get<'ours' | 'theirs'>('prefer', 'theirs'),
    pushOnSuccess: cfg.get<boolean>('pushOnSuccess', false),
  };
}

/**
 * Check if a work unit is a leaf (nothing consumes from it).
 */
export function isLeafWorkUnit(spec: PlanSpec, workUnitId: string): boolean {
  // Check if any job consumes from this work unit
  for (const job of spec.jobs) {
    if (job.consumesFrom.includes(workUnitId)) {
      return false;
    }
  }
  // Check if any sub-plan consumes from this work unit
  for (const sp of spec.subPlans || []) {
    if (sp.consumesFrom.includes(workUnitId)) {
      return false;
    }
  }
  return true;
}

/**
 * Merge a completed leaf job's branch to targetBranch immediately.
 * This provides incremental value to the user as work completes.
 */
export async function mergeLeafToTarget(
  spec: PlanSpec,
  plan: InternalPlanState,
  jobId: string,
  completedBranch: string,
  repoPath: string
): Promise<boolean> {
  const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
  const planJob = spec.jobs.find(j => j.id === jobId);
  const config = getMergeConfig();

  log.info(`Merging leaf ${jobId} to ${targetBranch}`, {
    planId: spec.id,
    completedBranch,
  });

  try {
    // Checkout target branch
    await git.branches.checkout(repoPath, targetBranch);

    // Attempt merge
    const mergeSuccess = await attemptMerge(
      repoPath,
      completedBranch,
      targetBranch,
      `Merge ${planJob?.name || jobId} from plan ${spec.name || spec.id}`,
      config
    );

    if (!mergeSuccess) {
      log.error(`Failed to merge leaf ${jobId}`);
      return false;
    }

    // Optionally push the updated target branch (only if pushOnSuccess is enabled)
    if (config.pushOnSuccess) {
      const pushSuccess = await git.repository.push(repoPath, { 
        branch: targetBranch,
        log: s => log.debug(s)
      });
      if (!pushSuccess) {
        log.warn(`Failed to push after leaf merge - check if remote is configured and accessible`);
      }
    }

    // Track that this leaf has been merged
    plan.mergedLeaves.add(jobId);
    plan.riMergeCompleted = true;

    log.info(`Leaf ${jobId} merged successfully`, {
      totalMerged: plan.mergedLeaves.size,
      pushed: config.pushOnSuccess,
    });

    return true;
  } catch (error: any) {
    log.error(`Failed to merge leaf ${jobId}`, { error: error.message });
    return false;
  }
}

/**
 * Perform the final RI merge for a completed plan.
 * With incremental leaf merging, this is primarily a fallback/cleanup.
 */
export async function performFinalMerge(
  spec: PlanSpec,
  plan: InternalPlanState,
  repoPath: string
): Promise<void> {
  const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
  const config = getMergeConfig();

  // Find leaf jobs (jobs that no other job or sub-plan consumes from)
  const allConsumedFrom = new Set<string>();
  for (const job of spec.jobs) {
    job.consumesFrom.forEach(source => allConsumedFrom.add(source));
  }
  for (const sp of spec.subPlans || []) {
    sp.consumesFrom.forEach(source => allConsumedFrom.add(source));
  }

  const allLeafIds = new Set(
    spec.jobs
      .filter(j => !allConsumedFrom.has(j.id) && plan.done.includes(j.id))
      .map(j => j.id)
  );

  // Check which leaves haven't been merged yet
  const unmergedLeaves = [...allLeafIds].filter(id => !plan.mergedLeaves.has(id));

  if (unmergedLeaves.length === 0) {
    log.info(`All ${allLeafIds.size} leaves already merged incrementally`, {
      planId: spec.id,
    });
    plan.riMergeCompleted = true;
    await cleanupIntegrationBranches(plan, repoPath);
    return;
  }

  // Fallback: merge any leaves that weren't merged incrementally
  log.warn(`${unmergedLeaves.length} leaves need fallback merge`, {
    planId: spec.id,
    unmerged: unmergedLeaves,
    alreadyMerged: [...plan.mergedLeaves],
  });

  try {
    // Checkout target branch
    await git.branches.checkout(repoPath, targetBranch);

    // Merge each unmerged leaf job's branch
    for (const leafJobId of unmergedLeaves) {
      const leafJob = spec.jobs.find(j => j.id === leafJobId);
      const leafBranch = plan.completedBranches.get(leafJobId);
      if (!leafBranch || !leafJob) continue;

      log.info(`Fallback merging ${leafBranch} into ${targetBranch}`);

      const mergeSuccess = await attemptMerge(
        repoPath,
        leafBranch,
        targetBranch,
        `Merge ${leafJob.name || leafJob.id} from plan ${spec.name || spec.id}`,
        config
      );

      if (mergeSuccess) {
        plan.mergedLeaves.add(leafJobId);
      } else {
        plan.error = `RI merge failed: conflict merging ${leafBranch}`;
        return;
      }
    }

    // Optionally push the updated target branch (only if pushOnSuccess is enabled)
    if (config.pushOnSuccess) {
      const pushSuccess = await git.repository.push(repoPath, { 
        branch: targetBranch,
        log: s => log.debug(s)
      });
      if (pushSuccess) {
        log.info(`RI merge completed and pushed`, { planId: spec.id, targetBranch });
      } else {
        log.warn(`Failed to push ${targetBranch} - check if remote is configured and accessible`);
      }
    } else {
      log.info(`RI merge completed (push disabled)`, { planId: spec.id, targetBranch });
    }

    plan.riMergeCompleted = true;
    await cleanupIntegrationBranches(plan, repoPath);
  } catch (error: any) {
    log.error(`Final RI merge failed`, { planId: spec.id, error: error.message });
    plan.error = `RI merge failed: ${error.message}`;
    plan.riMergeCompleted = false;
  }
}

/**
 * Attempt a git merge, using Copilot CLI to resolve conflicts if needed.
 */
async function attemptMerge(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  config: MergeConfig
): Promise<boolean> {
  // Use git.merge module
  const result = await git.merge.merge({
    source: sourceBranch,
    target: targetBranch,
    cwd: repoPath,
    message: commitMessage,
    log: (msg) => log.debug(msg),
  });

  if (result.success) {
    log.info(`Merged ${sourceBranch} into ${targetBranch}`);
    return true;
  }

  if (!result.hasConflicts) {
    // Non-conflict failure
    log.error(`Merge failed`, { error: result.error });
    return false;
  }

  // Merge conflict - use Copilot CLI to resolve
  log.info(`Merge conflict, using Copilot CLI to resolve...`, {
    sourceBranch,
    targetBranch,
    conflictFiles: result.conflictFiles,
  });

  const mergeInstruction =
    `@agent Resolve the current git merge conflict. ` +
    `We are merging branch '${sourceBranch}' into '${targetBranch}'. ` +
    `Prefer '${config.prefer}' changes when there are conflicts. ` +
    `Complete the merge and commit with message 'orchestrator: ${commitMessage}'`;

  const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
  
  // Run async to avoid blocking the event loop
  const copilotResult = await new Promise<{ status: number | null }>((resolve) => {
    const child = spawn(copilotCmd, [], {
      cwd: repoPath,
      shell: true,
      timeout: 300000, // 5 minute timeout
    });
    
    child.on('close', (code) => {
      resolve({ status: code });
    });
    
    child.on('error', (err) => {
      log.error('Copilot CLI spawn error', { error: err.message });
      resolve({ status: 1 });
    });
  });

  if (copilotResult.status !== 0) {
    log.error(`Copilot CLI failed to resolve merge conflict`, {
      exitCode: copilotResult.status,
      sourceBranch,
      targetBranch,
    });
    // Abort the merge
    await git.merge.abort(repoPath);
    return false;
  }

  log.info(`Merge conflict resolved by Copilot CLI`);
  return true;
}

/**
 * Check if remote operations are enabled (pushOnSuccess setting).
 */
function isPushEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  return cfg.get<boolean>('pushOnSuccess', false);
}

/**
 * Clean up integration branches created for sub-plans.
 */
export async function cleanupIntegrationBranches(
  plan: InternalPlanState,
  repoPath: string
): Promise<void> {
  if (!plan.subPlanIntegrationBranches || plan.subPlanIntegrationBranches.size === 0) {
    return;
  }

  log.info(`Cleaning up ${plan.subPlanIntegrationBranches.size} integration branches`, {
    planId: plan.id,
  });

  const pushEnabled = isPushEnabled();

  for (const [subPlanId, integrationBranch] of plan.subPlanIntegrationBranches) {
    // Delete local branch
    const localDeleted = await git.branches.deleteLocal(repoPath, integrationBranch, { 
      force: true,
      log: s => log.debug(s)
    });
    if (localDeleted) {
      log.debug(`Deleted local integration branch: ${integrationBranch}`);
    } else {
      // Branch might be checked out - this is okay, it will be cleaned up later
      log.debug(`Could not delete integration branch (may be checked out): ${integrationBranch}`);
    }

    // Only delete remote branch if pushOnSuccess is enabled
    if (pushEnabled) {
      const remoteDeleted = await git.branches.deleteRemote(repoPath, integrationBranch, {
        log: s => log.debug(s)
      });
      if (remoteDeleted) {
        log.debug(`Deleted remote integration branch: ${integrationBranch}`);
      }
    }
  }
}
