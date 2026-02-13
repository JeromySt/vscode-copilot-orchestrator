/**
 * @fileoverview Retry Node MCP Tool Handler
 * 
 * Implements handler for retrying a specific failed node.
 * 
 * @module mcp/handlers/plan/retryNodeHandler
 */

import { validateAllowedFolders, validateAllowedUrls } from '../../validation';
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
 * Handle the `retry_copilot_plan_node` MCP tool call.
 *
 * Resets a specific failed node back to ready state and resumes plan execution.
 * Optionally provides new work specifications for the retry attempt.
 *
 * @param args - Must contain `planId` and `nodeId`. Optional retry options.
 * @param ctx  - Handler context.
 * @returns `{ success, message, planId, nodeId, nodeName }` or error.
 */
export async function handleRetryPlanNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) return fieldError;

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'retry_copilot_plan_node');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'retry_copilot_plan_node');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {
    const modelValidation = await validateAgentModels(args, 'retry_copilot_plan_node');
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
  }
  
  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) return nodeResult;
  const { node, state } = nodeResult;
  
  if (!state || state.status !== 'failed') {
    return errorResult(
      `Node ${args.nodeId} is not in failed state (current: ${state?.status || 'unknown'})`
    );
  }
  
  // Build retry options from args
  const retryOptions = {
    newWork: args.newWork,
    newPrechecks: args.newPrechecks,
    newPostchecks: args.newPostchecks,
    clearWorktree: args.clearWorktree || false,
  };
  
  const result = await ctx.PlanRunner.retryNode(args.planId, args.nodeId, retryOptions);
  
  if (!result.success) {
    return errorResult(result.error || 'Retry failed');
  }
  
  // Resume the Plan if it was stopped
  await ctx.PlanRunner.resume(args.planId);
  
  return {
    success: true,
    message: `Retrying node "${node.name}"`,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: node.name,
    hasNewWork: !!args.newWork,
    clearWorktree: retryOptions.clearWorktree,
  };
}