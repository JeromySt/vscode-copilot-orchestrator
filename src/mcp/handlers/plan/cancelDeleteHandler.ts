/**
 * @fileoverview Cancel/Delete Plan MCP Tool Handlers
 * 
 * Implements handlers for canceling and deleting plans.
 * 
 * @module mcp/handlers/plan/cancelDeleteHandler
 */

import {
  PlanHandlerContext,
  validateRequired,
} from '../utils';

/**
 * Handle the `cancel_copilot_plan` MCP tool call.
 *
 * Cancels a running plan, stopping all executing nodes and
 * preventing new nodes from starting.
 *
 * @param args - Must contain `planId` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleCancelPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) {return fieldError;}
  
  const success = ctx.PlanRunner.cancel(args.planId);
  
  return {
    success,
    message: success 
      ? `Plan ${args.planId} has been canceled` 
      : `Failed to cancel Plan ${args.planId}`,
  };
}

/**
 * Handle the `delete_copilot_plan` MCP tool call.
 *
 * Permanently deletes a plan and its execution history.
 *
 * @param args - Must contain `planId` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleDeletePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) {return fieldError;}
  
  const success = ctx.PlanRunner.delete(args.planId);
  
  return {
    success,
    message: success 
      ? `Plan ${args.planId} has been deleted` 
      : `Failed to delete Plan ${args.planId}`,
  };
}