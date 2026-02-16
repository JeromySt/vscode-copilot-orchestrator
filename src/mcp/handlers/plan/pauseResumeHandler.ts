/**
 * @fileoverview Pause/Resume Plan MCP Tool Handlers
 * 
 * Implements handlers for pausing and resuming plan execution.
 * 
 * @module mcp/handlers/plan/pauseResumeHandler
 */

import {
  PlanHandlerContext,
  validateRequired,
} from '../utils';

/**
 * Handle the `pause_copilot_plan` MCP tool call.
 *
 * Pauses a running plan, preventing new nodes from starting while
 * allowing currently executing nodes to complete.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handlePausePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) {return fieldError;}
  
  const success = ctx.PlanRunner.pause(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been paused. Running jobs will complete but no new work will be scheduled.` 
      : `Failed to pause Plan ${args.id}`,
  };
}

/**
 * Handle the `resume_copilot_plan` MCP tool call.
 *
 * Resumes a paused plan. Allows new work to be scheduled again.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleResumePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) {return fieldError;}
  
  const success = await ctx.PlanRunner.resume(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been resumed. New work will be scheduled.` 
      : `Failed to resume Plan ${args.id}`,
  };
}