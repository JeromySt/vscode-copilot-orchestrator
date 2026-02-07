/**
 * @fileoverview Legacy Adapter Layer
 *
 * Adapts old plan-based MCP tool calls to the new node-centric handlers.
 * The old tools (`create_copilot_plan`, `get_copilot_plan_status`, etc.)
 * are kept for backward compatibility and internally delegate to the
 * new node/group handlers where appropriate.
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
  handleGetNode,
  handleRetryNode,
  handleNodeFailureContext,
} from './nodeHandlers';

/**
 * Adapt `get_copilot_plan_status` to `get_copilot_group_status`.
 *
 * Translates `{ id }` → `{ group_id }` and maps the response back
 * with `planId` instead of `groupId`.
 */
export async function adaptGetPlanStatus(args: any, ctx: PlanHandlerContext): Promise<any> {
  const result = await handleGetGroupStatus({ group_id: args.id }, ctx);
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
  return handleCancelGroup({ group_id: args.id }, ctx);
}

/**
 * Adapt `delete_copilot_plan` to `delete_copilot_group`.
 */
export async function adaptDeletePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleDeleteGroup({ group_id: args.id }, ctx);
}

/**
 * Adapt `retry_copilot_plan` to `retry_copilot_group`.
 */
export async function adaptRetryPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleRetryGroup({
    group_id: args.id,
    node_ids: args.nodeIds,
    newWork: args.newWork,
    clearWorktree: args.clearWorktree,
  }, ctx);
}

/**
 * Adapt `get_copilot_node_details` to `get_copilot_node`.
 *
 * The old tool requires planId, but the new tool doesn't need it.
 * We still accept planId for compatibility but ignore it.
 */
export async function adaptGetNodeDetails(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleGetNode({ node_id: args.nodeId }, ctx);
}

/**
 * Adapt `retry_copilot_plan_node` to `retry_copilot_node`.
 */
export async function adaptRetryPlanNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleRetryNode({
    node_id: args.nodeId,
    newWork: args.newWork,
    clearWorktree: args.clearWorktree,
  }, ctx);
}

/**
 * Adapt `get_copilot_plan_node_failure_context` to `get_copilot_node_failure_context`.
 */
export async function adaptGetNodeFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  return handleNodeFailureContext({ node_id: args.nodeId }, ctx);
}
