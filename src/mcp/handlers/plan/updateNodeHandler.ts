/**
 * @fileoverview Update Node MCP Tool Handler
 * 
 * Implements handler for updating node job specifications.
 * 
 * @module mcp/handlers/plan/updateNodeHandler
 */

import { JobNode, normalizeWorkSpec } from '../../../plan/types';
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
 * Handle the `update_copilot_plan_node` MCP tool call.
 *
 * Updates a node's job specification and resets execution as needed.
 * Any provided stage (prechecks, work, postchecks) will replace the existing
 * definition and reset execution to re-run from that stage.
 *
 * @param args - Must contain `planId`, `nodeId`. At least one of `prechecks`, 
 *               `work`, `postchecks` must be provided. Optional `resetToStage`.
 * @param ctx  - Handler context.
 * @returns `{ success, message, ... }`.
 */
export async function handleUpdatePlanNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) return fieldError;

  // Validate at least one stage is provided (use 'in' to allow falsy values like null)
  if (!('prechecks' in args) && !('work' in args) && !('postchecks' in args)) {
    return errorResult('At least one stage update (prechecks, work, postchecks) must be provided');
  }

  // Validate allowedFolders paths exist in any provided stages
  const folderValidation = await validateAllowedFolders(args, 'update_copilot_plan_node');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS in any provided stages
  const urlValidation = await validateAllowedUrls(args, 'update_copilot_plan_node');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names in any provided stages
  const modelValidation = await validateAgentModels(args, 'update_copilot_plan_node');
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }
  
  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) return nodeResult;
  const { node } = nodeResult;
  
  if (node.type !== 'job') {
    return errorResult(`Node "${args.nodeId}" is not a job node and cannot be updated`);
  }
  const jobNode = node as JobNode;
  
  // Check if node is currently running or scheduled - cannot update while executing
  const nodeState = plan.nodeStates.get(args.nodeId);
  if (nodeState?.status === 'running' || nodeState?.status === 'scheduled') {
    return errorResult(`Node "${jobNode.name}" is currently ${nodeState.status} and cannot be updated. Wait for it to complete or force-fail it first.`);
  }
  
  // Check if node has already completed successfully - cannot update completed nodes
  if (nodeState?.status === 'succeeded') {
    return errorResult(`Node "${jobNode.name}" has already completed successfully and cannot be updated.`);
  }
  
  // Apply spec updates directly to the node
  if (args.work !== undefined) {
    jobNode.work = normalizeWorkSpec(args.work);
  }
  if (args.prechecks !== undefined) {
    jobNode.prechecks = args.prechecks === null ? undefined : normalizeWorkSpec(args.prechecks);
  }
  if (args.postchecks !== undefined) {
    jobNode.postchecks = args.postchecks === null ? undefined : normalizeWorkSpec(args.postchecks);
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
    
    // Set resumeFromPhase so executor knows where to pick up
    nodeState.resumeFromPhase = resetTo as typeof nodeState.resumeFromPhase;
  }
  
  // Persist the updated plan. Only resume execution if the plan was already
  // running — do NOT auto-resume a paused plan just because a node was updated.
  if (plan.isPaused !== true) {
    await ctx.PlanRunner.resume(args.planId);
  }
  
  return {
    success: true,
    message: `Updated node "${jobNode.name}"`,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: jobNode.name,
    hasNewPrechecks: args.prechecks !== undefined,
    hasNewWork: args.work !== undefined,
    hasNewPostchecks: args.postchecks !== undefined,
    resetToStage: args.resetToStage || (args.work ? 'work' : args.prechecks ? 'prechecks' : 'postchecks'),
  };
}