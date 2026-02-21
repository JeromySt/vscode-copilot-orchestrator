/**
 * @fileoverview Retry Job MCP Tool Handler
 * 
 * Implements handler for retrying a specific failed job.
 * 
 * @module mcp/handlers/plan/retryJobHandler
 */

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

/**
 * Handle the `retry_copilot_plan_job` MCP tool call.
 *
 * Resets a specific failed job back to ready state and resumes plan execution.
 * Optionally provides new work specifications for the retry attempt.
 *
 * @param args - Must contain `planId` and `jobId`. Optional retry options.
 * @param ctx  - Handler context.
 * @returns `{ success, message, planId, jobId, jobName }` or error.
 */
export async function handleRetryPlanJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Accept both jobId (new) and nodeId (legacy) for backward compatibility
  const jobIdValue = args.jobId || args.nodeId;
  const fieldError = validateRequired({ ...args, jobId: jobIdValue }, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders({ ...args, jobId: jobIdValue }, 'retry_copilot_plan_job');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls({ ...args, jobId: jobIdValue }, 'retry_copilot_plan_job');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {
    const modelValidation = await validateAgentModels({ ...args, jobId: jobIdValue }, 'retry_copilot_plan_job', ctx.configProvider);
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
    // Reject PowerShell commands containing 2>&1 (causes false failures)
    const psValidation = validatePowerShellCommands({ ...args, jobId: jobIdValue });
    if (!psValidation.valid) {
      return { success: false, error: psValidation.error };
    }
  }
  
  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, jobIdValue);
  if (isError(nodeResult)) {return nodeResult;}
  const { node, state } = nodeResult;
  
  if (!state || state.status !== 'failed') {
    return errorResult(
      `Job ${jobIdValue} is not in failed state (current: ${state?.status || 'unknown'})`
    );
  }
  
  // Build retry options from args
  const retryOptions = {
    newWork: args.newWork,
    newPrechecks: args.newPrechecks,
    newPostchecks: args.newPostchecks,
    clearWorktree: args.clearWorktree || false,
  };
  
  const result = await ctx.PlanRunner.retryNode(args.planId, jobIdValue, retryOptions);
  
  if (!result.success) {
    return errorResult(result.error || 'Retry failed');
  }
  
  // Resume the Plan if it was stopped
  await ctx.PlanRunner.resume(args.planId);
  
  return {
    success: true,
    message: `Retrying job "${node.name}"`,
    planId: args.planId,
    jobId: jobIdValue,
    jobName: node.name,
    hasNewWork: !!args.newWork,
    clearWorktree: retryOptions.clearWorktree,
  };
}