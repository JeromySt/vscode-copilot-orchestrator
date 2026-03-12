/**
 * @fileoverview Recover Plan MCP Tool Handler
 * 
 * Implements the handler for recovering canceled or failed plans.
 * 
 * @module mcp/handlers/plan/recoverPlanHandler
 */

import {
  PlanHandlerContext,
  validateRequired,
} from '../utils';

/**
 * Handle the `recover_copilot_plan` MCP tool call.
 *
 * Recovers a canceled or archived plan by:
 * 1. Recreating the target branch at the base commit
 * 2. Recovering worktree states from successfully completed jobs
 * 3. Transitioning the plan to paused state
 * 4. Optionally using Copilot CLI agent to verify recovery
 *
 * @param args - Must contain `planId`, optionally `useCopilotAgent`.
 * @param ctx  - Handler context.
 * @returns Recovery result with success status and details.
 */
export async function handleRecoverPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) {
    return fieldError;
  }
  
  const { planId, useCopilotAgent = true } = args;
  
  // Check if PlanRecovery service is available
  if (!ctx.PlanRecovery) {
    return {
      success: false,
      error: 'Plan recovery service not available'
    };
  }
  
  // Check if the plan can be recovered
  if (!ctx.PlanRecovery.canRecover(planId)) {
    const statusInfo = ctx.PlanRunner.getStatus(planId);
    const status = statusInfo?.status || 'unknown';
    return {
      success: false,
      error: `Cannot recover plan with status '${status}'. Only canceled or failed plans can be recovered.`
    };
  }
  
  try {
    // Analyze recoverable nodes (to report totalNodeCount in response)
    const analysis = await ctx.PlanRecovery.analyzeRecoverableNodes(planId);
    
    // Perform recovery
    const result = await ctx.PlanRecovery.recover(planId, { useCopilotAgent });
    
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Recovery failed'
      };
    }
    
    return {
      success: true,
      planId,
      recoveredBranch: result.recoveredBranch,
      recoveredNodeCount: result.recoveredNodes.length,
      recoveredNodes: result.recoveredNodes,
      totalNodeCount: analysis.length,
      message: `Plan '${planId}' recovered. Branch '${result.recoveredBranch}' recreated. ${result.recoveredNodes.length} of ${analysis.length} nodes recovered. Plan is now PAUSED.`
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Recovery operation failed'
    };
  }
}
