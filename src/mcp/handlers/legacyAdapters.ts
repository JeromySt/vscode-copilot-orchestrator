/**
 * @fileoverview Legacy Adapter Layer
 *
 * Adapts old plan-based MCP tool calls to the new job-centric handlers.
 * The old tools (`create_copilot_plan`, `get_copilot_plan_status`, etc.)
 * are kept for backward compatibility and internally delegate to the
 * new job/group handlers where appropriate.
 *
 * Old tool responses are translated back to the expected format so
 * existing callers continue to work without changes.
 *
 * @module mcp/handlers/legacyAdapters
 */

import { PlanHandlerContext } from './utils';
import {
  handleGetGroupStatus,
  handleListGroups,
  handleCancelGroup,
  handleDeleteGroup,
  handleRetryGroup,
  handleGetJob,
  handleRetryJob,
  handleJobFailureContext,
} from './jobHandlers';

/**
 * Adapt `get_copilot_plan_status` to `get_copilot_group_status`.
 *
 * Translates `{ id }` → `{ groupId }` and maps the response back
 * with `planId` instead of `groupId`.
 */
export async function adaptGetPlanStatus(args: any, ctx: PlanHandlerContext): Promise<any> {
  const result = await handleGetGroupStatus({ groupId: args.planId }, ctx);
  if (result.success && result.groupId) {
    result.planId = result.groupId;
  }
  return result;
}

/**
 * Adapt `list_copilot_plans` to `list_copilot_groups`.
 *
 * Maps `groups` response array back to `Plans` for backward compat.
 */
export async function adaptListPlans(args: any, ctx: PlanHandlerContext): Promise<any> {
  const result = await handleListGroups(args, ctx);
  if (result.success && result.groups) {
    result.Plans = result.groups.map((g: any) => ({
      ...g,
      id: g.groupId,
      nodes: g.nodeCount,
    }));
  }
  return result;
}

/**
 * Adapt `cancel_copilot_plan` to `cancel_copilot_group`.
 */
export async function adaptCancelPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleCancelGroup({ groupId: args.planId }, ctx);
}

/**
 * Adapt `delete_copilot_plan` to `delete_copilot_group`.
 */
export async function adaptDeletePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleDeleteGroup({ groupId: args.planId }, ctx);
}

/**
 * Adapt `retry_copilot_plan` to `retry_copilot_group`.
 */
export async function adaptRetryPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleRetryGroup({
    groupId: args.planId,
    node_ids: args.jobIds, // Use consistent camelCase name
    newWork: args.newWork,
    clearWorktree: args.clearWorktree,
  }, ctx);
}

/**
 * Adapt `get_copilot_job_details` to `get_copilot_job`.
 *
 * The old tool requires planId, but the new tool doesn't need it.
 * We still accept planId for compatibility but ignore it.
 */
export async function adaptGetJobDetails(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleGetJob({ jobId: args.jobId || args.nodeId }, ctx);
}

/**
 * Adapt `retry_copilot_plan_job` to `retry_copilot_job`.
 */
export async function adaptRetryPlanJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleRetryJob({
    jobId: args.jobId || args.nodeId,
    newWork: args.newWork,
    clearWorktree: args.clearWorktree,
  }, ctx);
}

/**
 * Adapt `get_copilot_plan_job_failure_context` to `get_copilot_job_failure_context`.
 */
export async function adaptGetJobFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleJobFailureContext({ jobId: args.jobId || args.nodeId }, ctx);
}
