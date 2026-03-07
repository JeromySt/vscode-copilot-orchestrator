/**
 * @fileoverview Archive Plan MCP Tool Handler
 * 
 * Implements the handler for archiving completed or canceled plans.
 * 
 * @module mcp/handlers/plan/archivePlanHandler
 */

import { Logger } from '../../../core/logger';
import type { PlanHandlerContext } from '../utils';
import { validateRequired, errorResult } from '../utils';

const log = Logger.for('mcp');

/**
 * Handle the `archive_copilot_plan` MCP tool call.
 *
 * Archives a completed or canceled plan by:
 * - Preserving plan state and logs
 * - Cleaning up git worktrees
 * - Deleting target branches
 * - Marking the plan as archived
 *
 * @param args - Must contain `planId` (Plan UUID), optional `force` and `deleteRemoteBranches`.
 * @param ctx  - Handler context with PlanArchiver access.
 * @returns Archive result with cleanup details.
 */
export async function handleArchivePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) {
    return fieldError;
  }
  
  const { planId, force = false, deleteRemoteBranches = false } = args;
  
  // Resolve IPlanArchiver from context
  const archiver = ctx.PlanArchiver;
  if (!archiver) {
    log.error('PlanArchiver not available in context', { planId });
    return errorResult('Plan archiver service not available');
  }
  
  // Check if the plan can be archived
  if (!archiver.canArchive(planId)) {
    const plan = ctx.PlanRunner.get(planId);
    const status = plan ? ctx.PlanRunner.getStatus(planId)?.status : 'unknown';
    log.warn('Cannot archive plan - invalid status', { planId, status });
    return errorResult(
      `Cannot archive plan with status '${status}'. Only succeeded, partial, failed, or canceled plans can be archived.`
    );
  }
  
  log.info('Archiving plan', { planId, force, deleteRemoteBranches });
  
  // Execute the archive operation
  const result = await archiver.archive(planId, { force, deleteRemoteBranches });
  
  if (!result.success) {
    log.error('Archive operation failed', { planId, error: result.error });
    return {
      success: false,
      error: `Archive failed: ${result.error}`
    };
  }
  
  log.info('Plan archived successfully', {
    planId,
    cleanedWorktrees: result.cleanedWorktrees.length,
    cleanedBranches: result.cleanedBranches.length
  });
  
  return {
    success: true,
    planId,
    cleanedWorktrees: result.cleanedWorktrees.length,
    cleanedBranches: result.cleanedBranches.length,
    worktrees: result.cleanedWorktrees,
    branches: result.cleanedBranches,
    message: `Plan '${planId}' archived. Cleaned ${result.cleanedWorktrees.length} worktrees and ${result.cleanedBranches.length} branches.`
  };
}
