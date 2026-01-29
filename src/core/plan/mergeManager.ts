/**
 * @fileoverview Plan Merge Manager - Handles merging completed work back to target branches.
 * 
 * Single responsibility: Merge completed job/sub-plan branches to target branches,
 * including incremental (leaf) merging and final RI merge.
 * 
 * Uses the git/* modules for all git operations - no direct execSync usage.
 * 
 * @module core/plan/mergeManager
 */

import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
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
}

/**
 * Get merge configuration from VS Code settings.
 */
function getMergeConfig(): MergeConfig {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  return {
    prefer: cfg.get<'ours' | 'theirs'>('prefer', 'theirs'),
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
export function mergeLeafToTarget(
  spec: PlanSpec,
  plan: InternalPlanState,
  jobId: string,
  completedBranch: string,
  repoPath: string
): boolean {
  const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
  const planJob = spec.jobs.find(j => j.id === jobId);
  const config = getMergeConfig();

  log.info(`Merging leaf ${jobId} to ${targetBranch}`, {
    planId: spec.id,
    completedBranch,
  });

  try {
    // Checkout target branch
    git.branches.checkout(repoPath, targetBranch);

    // Attempt merge
    const mergeSuccess = attemptMerge(
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

    // Push the updated target branch
    const pushSuccess = git.repository.push(repoPath, { branch: targetBranch });
    if (!pushSuccess) {
      log.warn(`Failed to push after leaf merge`);
    }

    // Track that this leaf has been merged
    plan.mergedLeaves.add(jobId);
    plan.riMergeCompleted = true;

    log.info(`Leaf ${jobId} merged successfully`, {
      totalMerged: plan.mergedLeaves.size,
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
export function performFinalMerge(
  spec: PlanSpec,
  plan: InternalPlanState,
  repoPath: string
): void {
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
    cleanupIntegrationBranches(plan, repoPath);
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
    git.branches.checkout(repoPath, targetBranch);

    // Merge each unmerged leaf job's branch
    for (const leafJobId of unmergedLeaves) {
      const leafJob = spec.jobs.find(j => j.id === leafJobId);
      const leafBranch = plan.completedBranches.get(leafJobId);
      if (!leafBranch || !leafJob) continue;

      log.info(`Fallback merging ${leafBranch} into ${targetBranch}`);

      const mergeSuccess = attemptMerge(
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

    // Push the updated target branch
    const pushSuccess = git.repository.push(repoPath, { branch: targetBranch });
    if (pushSuccess) {
      log.info(`RI merge completed and pushed`, { planId: spec.id, targetBranch });
    } else {
      log.warn(`Failed to push ${targetBranch}`);
    }

    plan.riMergeCompleted = true;
    cleanupIntegrationBranches(plan, repoPath);
  } catch (error: any) {
    log.error(`Final RI merge failed`, { planId: spec.id, error: error.message });
    plan.error = `RI merge failed: ${error.message}`;
    plan.riMergeCompleted = false;
  }
}

/**
 * Attempt a git merge, using Copilot CLI to resolve conflicts if needed.
 */
function attemptMerge(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  config: MergeConfig
): boolean {
  // Use git.merge module
  const result = git.merge.merge({
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
  const copilotResult = spawnSync(copilotCmd, [], {
    cwd: repoPath,
    shell: true,
    encoding: 'utf-8',
    timeout: 300000, // 5 minute timeout
  });

  if (copilotResult.status !== 0) {
    log.error(`Copilot CLI failed to resolve merge conflict`, {
      exitCode: copilotResult.status,
      sourceBranch,
      targetBranch,
    });
    // Abort the merge
    git.merge.abort(repoPath);
    return false;
  }

  log.info(`Merge conflict resolved by Copilot CLI`);
  return true;
}

/**
 * Clean up integration branches created for sub-plans.
 */
export function cleanupIntegrationBranches(
  plan: InternalPlanState,
  repoPath: string
): void {
  if (!plan.subPlanIntegrationBranches || plan.subPlanIntegrationBranches.size === 0) {
    return;
  }

  log.info(`Cleaning up ${plan.subPlanIntegrationBranches.size} integration branches`, {
    planId: plan.id,
  });

  for (const [subPlanId, integrationBranch] of plan.subPlanIntegrationBranches) {
    // Delete local branch
    const localDeleted = git.branches.deleteLocal(repoPath, integrationBranch, { force: true });
    if (localDeleted) {
      log.debug(`Deleted local integration branch: ${integrationBranch}`);
    }

    // Delete remote branch
    const remoteDeleted = git.branches.deleteRemote(repoPath, integrationBranch);
    if (remoteDeleted) {
      log.debug(`Deleted remote integration branch: ${integrationBranch}`);
    }
  }
}
