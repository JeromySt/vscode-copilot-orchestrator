/**
 * @fileoverview Get Plan MCP Tool Handlers
 * 
 * Implements handlers for retrieving plan status and listing plans.
 * 
 * @module mcp/handlers/plan/getPlanHandler
 */

import { computeMergedLeafWorkSummary } from '../../../plan';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
} from '../utils';

/**
 * Handle the `get_copilot_plan_status` MCP tool call.
 *
 * Returns the overall plan status, per-node states, progress percentage,
 * and timing information.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns Plan status object including `{ planId, status, progress, counts, nodes, ... }`.
 */
export async function handleGetPlanStatus(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;
  
  const status = ctx.PlanRunner.getStatus(args.id);
  if (!status) {
    return errorResult(`Plan not found: ${args.id}`);
  }
  
  const { plan, status: planStatus, counts, progress } = status;
  
  // Track group statuses
  const groupStatusMap = new Map<string, { nodes: number; succeeded: number; failed: number; running: number; pending: number }>();
  
  // Build node status list
  const nodes: any[] = [];
  for (const [nodeId, state] of plan.nodeStates) {
    const node = plan.nodes.get(nodeId);
    const isLeaf = plan.leaves.includes(nodeId);
    
    // Get group from JobNode
    const nodeGroup = node?.type === 'job' ? (node as import('../../../plan/types').JobNode).group : undefined;
    
    // Track group status
    if (nodeGroup) {
      if (!groupStatusMap.has(nodeGroup)) {
        groupStatusMap.set(nodeGroup, { nodes: 0, succeeded: 0, failed: 0, running: 0, pending: 0 });
      }
      const grp = groupStatusMap.get(nodeGroup)!;
      grp.nodes++;
      if (state.status === 'succeeded') grp.succeeded++;
      else if (state.status === 'failed' || state.status === 'blocked') grp.failed++;
      else if (state.status === 'running' || state.status === 'scheduled') grp.running++;
      else grp.pending++;
    }
    
    nodes.push({
      id: nodeId,
      producerId: node?.producerId,
      name: node?.name,
      type: node?.type,
      group: nodeGroup,
      status: state.status,
      error: state.error,
      attempts: state.attempts,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      completedCommit: state.completedCommit,
      mergedToTarget: isLeaf ? state.mergedToTarget : undefined,
      worktreePath: state.worktreePath,
    });
  }
  
  // Build groups summary
  const groups: Record<string, { status: string; nodes: number }> = {};
  for (const [groupName, stats] of groupStatusMap) {
    let groupStatus: string;
    if (stats.failed > 0) {
      groupStatus = stats.succeeded > 0 ? 'partial' : 'failed';
    } else if (stats.running > 0) {
      groupStatus = 'running';
    } else if (stats.succeeded === stats.nodes) {
      groupStatus = 'succeeded';
    } else {
      groupStatus = 'pending';
    }
    groups[groupName] = { status: groupStatus, nodes: stats.nodes };
  }
  
  // Get effective endedAt recursively including child plans
  const effectiveEndedAt = ctx.PlanRunner.getEffectiveEndedAt(plan.id) || plan.endedAt;
  
  // Use merged-leaf-only workSummary when targetBranch is set
  const workSummary = plan.targetBranch
    ? computeMergedLeafWorkSummary(plan, plan.nodeStates)
    : plan.workSummary;
  
  return {
    success: true,
    planId: plan.id,
    name: plan.spec.name,
    status: planStatus,
    progress: Math.round(progress * 100),
    counts,
    nodes,
    groups: Object.keys(groups).length > 0 ? groups : undefined,
    createdAt: plan.createdAt,
    startedAt: plan.startedAt,
    endedAt: effectiveEndedAt,
    // Only include workSummary if there's actually merged work to show
    ...(workSummary && { workSummary }),
  };
}

/**
 * Handle the `list_copilot_plans` MCP tool call.
 *
 * Returns all plans, optionally filtered by status. Results are sorted
 * newest-first by creation timestamp.
 *
 * @param args - Optional `status` filter (`pending | running | succeeded | failed | partial | canceled`).
 * @param ctx  - Handler context.
 * @returns `{ success: true, count, Plans: [...] }`.
 */
export async function handleListPlans(args: any, ctx: PlanHandlerContext): Promise<any> {
  let Plans = ctx.PlanRunner.getAll();
  
  // Filter by status if specified
  if (args.status) {
    Plans = Plans.filter(plan => {
      const sm = ctx.PlanRunner.getStateMachine(plan.id);
      return sm?.computePlanStatus() === args.status;
    });
  }
  
  // Sort by creation time (newest first)
  Plans.sort((a, b) => b.createdAt - a.createdAt);
  
  return {
    success: true,
    count: Plans.length,
    Plans: Plans.map(plan => {
      const sm = ctx.PlanRunner.getStateMachine(plan.id);
      const counts = sm?.getStatusCounts();
      
      return {
        id: plan.id,
        name: plan.spec.name,
        status: sm?.computePlanStatus() || 'unknown',
        nodes: plan.nodes.size,
        counts,
        createdAt: plan.createdAt,
        startedAt: plan.startedAt,
        endedAt: ctx.PlanRunner.getEffectiveEndedAt(plan.id) || plan.endedAt,
      };
    }),
  };
}