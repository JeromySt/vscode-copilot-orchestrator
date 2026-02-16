/**
 * @fileoverview Retry Plan MCP Tool Handler
 * 
 * Implements handler for retrying failed nodes in a plan.
 * 
 * @module mcp/handlers/plan/retryPlanHandler
 */

import { validateAllowedFolders, validateAllowedUrls } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  isError,
} from '../utils';
import { validateAgentModels } from '../../validation';

/**
 * Handle the `retry_copilot_plan` MCP tool call.
 *
 * Resets failed nodes back to `ready` state and resumes plan execution.
 * Can retry all failed nodes (default) or a specific subset identified
 * by `nodeIds`.  An optional `newWork` spec replaces the original work
 * for the retried nodes.
 *
 * @param args - Must contain `id`. Optional `nodeIds`, `newWork`, `clearWorktree`.
 * @param ctx  - Handler context.
 * @returns `{ success, retriedNodes, errors }`.
 *
 * @example
 * ```jsonc
 * // Retry all failed nodes with replacement work
 * {
 *   "name": "retry_copilot_plan",
 *   "arguments": {
 *     "id": "plan-uuid",
 *     "newWork": "@agent Fix the build errors"
 *   }
 * }
 * ```
 */
export async function handleRetryPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) {return fieldError;}

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'retry_copilot_plan');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'retry_copilot_plan');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {
    const modelValidation = await validateAgentModels(args, 'retry_copilot_plan');
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
  }
  
  const planResult = lookupPlan(ctx, args.id, 'getPlan');
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  // Determine which nodes to retry
  let nodeIdsToRetry: string[] = args.nodeIds || [];
  
  if (nodeIdsToRetry.length === 0) {
    // No specific nodes - retry all failed nodes
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'failed') {
        nodeIdsToRetry.push(nodeId);
      }
    }
  }
  
  if (nodeIdsToRetry.length === 0) {
    return { 
      ...errorResult('No failed nodes to retry'),
      planId: args.id,
    };
  }
  
  // Build retry options from args
  const retryOptions = {
    newWork: args.newWork,
    newPrechecks: args.newPrechecks,
    newPostchecks: args.newPostchecks,
    clearWorktree: args.clearWorktree || false,
  };
  
  // Retry the failed nodes using the PlanRunner method
  const retriedNodes: Array<{ id: string; name: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  
  for (const nodeId of nodeIdsToRetry) {
    const result = await ctx.PlanRunner.retryNode(args.id, nodeId, retryOptions);
    const node = plan.nodes.get(nodeId);
    
    if (result.success) {
      retriedNodes.push({ id: nodeId, name: node?.name || nodeId });
    } else {
      errors.push({ id: nodeId, error: result.error || 'Unknown error' });
    }
  }
  
  // Resume the Plan if it was stopped
  await ctx.PlanRunner.resume(args.id);
  
  return {
    success: retriedNodes.length > 0,
    message: retriedNodes.length > 0 
      ? `Retrying ${retriedNodes.length} node(s)` 
      : 'No nodes were retried',
    planId: args.id,
    retriedNodes,
    errors: errors.length > 0 ? errors : undefined,
  };
}