/**
 * @fileoverview Update Job MCP Tool Handler
 * 
 * Implements handler for updating job specifications.
 * 
 * @module mcp/handlers/plan/updateJobHandler
 */

import { JobNode, normalizeWorkSpec } from '../../../plan/types';
import { validateAllowedFolders, validateAllowedUrls, validatePowerShellCommands } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  lookupNode,
  isError,
} from '../utils';
import { validateAgentModels } from '../../validation';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle the `update_copilot_plan_job` MCP tool call.
 *
 * Updates a job's job specification and resets execution as needed.
 * Any provided stage (prechecks, work, postchecks) will replace the existing
 * definition and reset execution to re-run from that stage.
 *
 * @param args - Must contain `planId`, `jobId`. At least one of `prechecks`, 
 *               `work`, `postchecks` must be provided. Optional `resetToStage`.
 * @param ctx  - Handler context.
 * @returns `{ success, message, ... }`.
 */
export async function handleUpdatePlanJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Accept both jobId (new) and nodeId (legacy) for backward compatibility
  const jobIdValue = args.jobId || args.nodeId;
  const fieldError = validateRequired({ ...args, jobId: jobIdValue }, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}

  // Validate at least one stage is provided (use 'in' to allow falsy values like null)
  if (!('prechecks' in args) && !('work' in args) && !('postchecks' in args)) {
    return errorResult('At least one stage update (prechecks, work, postchecks) must be provided');
  }

  // Validate allowedFolders paths exist in any provided stages
  const folderValidation = await validateAllowedFolders({ ...args, jobId: jobIdValue }, 'update_copilot_plan_job');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS in any provided stages
  const urlValidation = await validateAllowedUrls({ ...args, jobId: jobIdValue }, 'update_copilot_plan_job');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names in any provided stages
  const modelValidation = await validateAgentModels({ ...args, jobId: jobIdValue }, 'update_copilot_plan_job', ctx.configProvider);
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }
  
  // Reject PowerShell commands containing 2>&1 (causes false failures)
  const psValidation = validatePowerShellCommands({ ...args, jobId: jobIdValue });
  if (!psValidation.valid) {
    return { success: false, error: psValidation.error };
  }
  
  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, jobIdValue);
  if (isError(nodeResult)) {return nodeResult;}
  const { node } = nodeResult;
  
  if (node.type !== 'job') {
    return errorResult(`Job "${jobIdValue}" is not a job and cannot be updated`);
  }
  const jobNode = node as JobNode;
  
  // Snapshot Validation job is auto-managed — reject updates
  if (jobNode.producerId === '__snapshot-validation__') {
    return errorResult('The Snapshot Validation job is auto-managed and cannot be updated. Its prechecks, work, and postchecks are configured automatically by the orchestrator.');
  }
  
  // Check if job is currently running or scheduled - cannot update while executing
  const nodeState = plan.nodeStates.get(jobIdValue);
  if (nodeState?.status === 'running' || nodeState?.status === 'scheduled') {
    return errorResult(`Job "${jobNode.name}" is currently ${nodeState.status} and cannot be updated. Wait for it to complete or force-fail it first.`);
  }
  
  // Check if job has already completed successfully - cannot update completed jobs
  if (nodeState?.status === 'succeeded') {
    return errorResult(`Job "${jobNode.name}" has already completed successfully and cannot be updated.`);
  }
  
  // Apply spec updates directly to the node
  if (args.work !== undefined) {
    jobNode.work = normalizeWorkSpec(args.work);
    
    // If plan uses repository, write work spec to store
    if (plan.definition && ctx.PlanRepository) {
      try {
        if (args.work !== null) {
          await ctx.PlanRepository.writeNodeSpec(plan.id, jobNode.producerId, 'work', jobNode.work!);
        }
      } catch (err) {
        log.warn('Failed to write work spec to store, continuing with in-memory update', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (args.prechecks !== undefined) {
    jobNode.prechecks = args.prechecks === null ? undefined : normalizeWorkSpec(args.prechecks);
    
    // If plan uses repository, write prechecks spec to store
    if (plan.definition && ctx.PlanRepository) {
      try {
        if (args.prechecks !== null) {
          await ctx.PlanRepository.writeNodeSpec(plan.id, jobNode.producerId, 'prechecks', jobNode.prechecks!);
        }
      } catch (err) {
        log.warn('Failed to write prechecks spec to store, continuing with in-memory update', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (args.postchecks !== undefined) {
    jobNode.postchecks = args.postchecks === null ? undefined : normalizeWorkSpec(args.postchecks);
    
    // If plan uses repository, write postchecks spec to store
    if (plan.definition && ctx.PlanRepository) {
      try {
        if (args.postchecks !== null) {
          await ctx.PlanRepository.writeNodeSpec(plan.id, jobNode.producerId, 'postchecks', jobNode.postchecks!);
        }
      } catch (err) {
        log.warn('Failed to write postchecks spec to store, continuing with in-memory update', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  
  // Handle resetToStage: clear step statuses from that stage onward
  if (nodeState) {
    const stageOrder = ['prechecks', 'work', 'postchecks'] as const;
    const resetTo = args.resetToStage || ('work' in args ? 'work' : 'prechecks' in args ? 'prechecks' : 'postchecks');
    const resetIdx = stageOrder.indexOf(resetTo as typeof stageOrder[number]);
    
    if (resetIdx >= 0 && nodeState.stepStatuses) {
      for (let i = resetIdx; i < stageOrder.length; i++) {
        delete nodeState.stepStatuses[stageOrder[i]];
      }
      // Also clear commit/merge-ri since they follow postchecks
      delete nodeState.stepStatuses['commit'];
      delete nodeState.stepStatuses['merge-ri'];
    }
    
    // Reset auto-heal budget for updated phases so new work gets fresh heal attempts
    if (nodeState.autoHealAttempted) {
      if (args.work !== undefined) delete nodeState.autoHealAttempted['work'];
      if (args.prechecks !== undefined) delete nodeState.autoHealAttempted['prechecks'];
      if (args.postchecks !== undefined) delete nodeState.autoHealAttempted['postchecks'];
    }
    
    // Only set resumeFromPhase for nodes that have previously executed.
    // For nodes that have never run (attempts === 0 and status is pending/ready),
    // we must NOT set resumeFromPhase because there's nothing to resume from.
    // Setting it incorrectly causes the executor to skip merge-fi/setup/work phases,
    // leading to data loss when dependencies haven't been merged.
    const hasExecuted = (nodeState.attempts ?? 0) > 0 || !['pending', 'ready', 'scheduled'].includes(nodeState.status);
    if (hasExecuted) {
      nodeState.resumeFromPhase = resetTo as typeof nodeState.resumeFromPhase;
    }
  }
  
  // Record workSpec update event in state history for timeline rendering
  if (!plan.stateHistory) plan.stateHistory = [];
  const updateParts: string[] = [];
  if (args.work !== undefined) updateParts.push('work');
  if (args.prechecks !== undefined) updateParts.push('prechecks');
  if (args.postchecks !== undefined) updateParts.push('postchecks');
  const lastPlanStatus = plan.stateHistory?.length ? plan.stateHistory[plan.stateHistory.length - 1].to : 'running';
  plan.stateHistory.push({ from: lastPlanStatus || 'running', to: 'job-updated', timestamp: Date.now(), reason: `${jobNode.name}: updated ${updateParts.join(', ')}` });

  // Persist the updated plan, notify UI, then resume execution if not paused.
  ctx.PlanRunner.savePlan(args.planId);
  ctx.PlanRunner.emit('planUpdated', args.planId);
  if (plan.isPaused !== true) {
    await ctx.PlanRunner.resume(args.planId);
  }
  
  return {
    success: true,
    message: `Updated job "${jobNode.name}"`,
    planId: args.planId,
    jobId: args.jobId,
    jobName: jobNode.name,
    hasNewPrechecks: args.prechecks !== undefined,
    hasNewWork: args.work !== undefined,
    hasNewPostchecks: args.postchecks !== undefined,
    resetToStage: args.resetToStage || (args.work ? 'work' : args.prechecks ? 'prechecks' : 'postchecks'),
  };
}