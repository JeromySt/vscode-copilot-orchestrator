/**
 * @fileoverview Clone Plan MCP Tool Handler
 *
 * Duplicates an existing plan (even canceled/failed ones) as a new scaffold.
 * The new plan starts in 'scaffolding' status with all jobs from the source.
 *
 * @module mcp/handlers/plan/clonePlanHandler
 */

import { validateInput } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
  resolveBaseBranch,
  resolveTargetBranch,
} from '../utils';
import { handleAddPlanJob } from './addJobHandler';
import { Logger } from '../../../core/logger';
import type { JobNode } from '../../../plan/types';

const log = Logger.for('mcp');

/**
 * Handle clone_copilot_plan MCP tool call.
 *
 * Clones an existing plan's job definitions into a new scaffolding plan.
 * The clone preserves: job producerIds, names, tasks, work specs, dependencies,
 * groups, prechecks, postchecks, autoHeal, and expectsNoChanges settings.
 *
 * The clone does NOT preserve: execution state, commits, worktrees, or timing.
 */
export async function handleClonePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const { sourcePlanId, name: newName, targetBranch } = args || {};

  if (!sourcePlanId || typeof sourcePlanId !== 'string') {
    return errorResult("Missing required field 'sourcePlanId'");
  }

  // Get the source plan
  const sourceStatus = ctx.PlanRunner.getStatus(sourcePlanId);
  if (!sourceStatus) {
    return errorResult(`Source plan not found: ${sourcePlanId}`);
  }

  const { plan: sourcePlan } = sourceStatus;
  const planName = newName || `${sourcePlan.spec.name} (clone)`;

  try {
    const repoPath = ctx.workspacePath;
    const resolvedBaseBranch = await resolveBaseBranch(
      repoPath, ctx.git, sourcePlan.spec.baseBranch
    );
    const resolvedTargetBranch = await resolveTargetBranch(
      resolvedBaseBranch, repoPath, ctx.git,
      targetBranch || undefined, planName, ctx.configProvider
    );
    const worktreeRoot = repoPath ? `${repoPath}/.worktrees` : '';

    // Scaffold the new empty plan
    const newPlan = await ctx.PlanRepository.scaffold(planName, {
      baseBranch: resolvedBaseBranch,
      targetBranch: resolvedTargetBranch,
      maxParallel: sourcePlan.spec.maxParallel,
      repoPath,
      worktreeRoot,
      env: sourcePlan.spec.env,
    });

    ctx.PlanRunner.registerPlan(newPlan);
    const newPlanId = newPlan.id;

    // Map source nodeIds → producerIds for dependency resolution
    const nodeIdToProducer = new Map<string, string>();
    for (const [nodeId, node] of sourcePlan.jobs) {
      nodeIdToProducer.set(nodeId, node.producerId);
    }

    // Add each job from the source plan
    let addedCount = 0;
    const errors: string[] = [];

    for (const [nodeId, node] of sourcePlan.jobs) {
      if (node.type !== 'job') continue;
      const job = node as JobNode;

      // Skip auto-injected SV nodes — they'll be re-created by finalize
      if (job.producerId.startsWith('sv-')) continue;

      // Resolve dependencies from nodeIds to producerIds
      const deps = node.dependencies
        .map(depId => nodeIdToProducer.get(depId))
        .filter((p): p is string => p !== undefined && !p.startsWith('sv-'));

      const jobArgs = {
        planId: newPlanId,
        producerId: node.producerId,
        name: node.name,
        task: job.task,
        work: job.work,
        dependencies: deps,
        group: job.group,
        prechecks: job.prechecks,
        postchecks: job.postchecks,
        autoHeal: job.autoHeal,
        expectsNoChanges: job.expectsNoChanges,
      };

      const result = await handleAddPlanJob(jobArgs, ctx);
      if (result.success) {
        addedCount++;
      } else {
        const errMsg = typeof result.content === 'string'
          ? result.content
          : result.content?.[0]?.text || 'Unknown error';
        errors.push(`${node.producerId}: ${errMsg}`);
      }
    }

    log.info('Plan cloned', {
      sourcePlanId,
      newPlanId,
      name: planName,
      jobsCloned: addedCount,
      errors: errors.length,
    });

    const result: any = {
      success: true,
      planId: newPlanId,
      sourcePlanId,
      name: planName,
      jobsCloned: addedCount,
      message: `Plan cloned as '${planName}' (ID: ${newPlanId}) with ${addedCount} jobs. ` +
        `Use finalize_copilot_plan to start, or add_copilot_plan_job to modify.`,
    };

    if (errors.length > 0) {
      result.warnings = errors;
      result.message += ` WARNING: ${errors.length} job(s) failed to clone.`;
    }

    return result;
  } catch (error: any) {
    log.error('Failed to clone plan', { error: error.message, sourcePlanId });
    return errorResult(`Failed to clone plan: ${error.message}`);
  }
}
