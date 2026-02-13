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
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleCancelPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;
  
  const success = ctx.PlanRunner.cancel(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been canceled` 
      : `Failed to cancel Plan ${args.id}`,
  };
}

/**
 * Handle the `delete_copilot_plan` MCP tool call.
 *
 * Permanently deletes a plan and its execution history.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleDeletePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;
  
  const success = ctx.PlanRunner.delete(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been deleted` 
      : `Failed to delete Plan ${args.id}`,
  };
}