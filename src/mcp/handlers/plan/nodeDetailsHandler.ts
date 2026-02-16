/**
 * @fileoverview Node Details MCP Tool Handlers
 * 
 * Implements handlers for retrieving detailed node information, logs, attempts, and failure context.
 * 
 * @module mcp/handlers/plan/nodeDetailsHandler
 */

import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  lookupNode,
  isError,
} from '../utils';

/**
 * Handle the `get_copilot_node_details` MCP tool call.
 *
 * Returns detailed information about a single node including its
 * dependencies, dependents, work specification, and execution state.
 * The node can be looked up by UUID or by `producer_id`.
 *
 * @param args - Must contain `planId` and `nodeId` (UUID or producer_id).
 * @param ctx  - Handler context.
 * @returns Node details with `{ node, state }` sub-objects.
 */
export async function handleGetNodeDetails(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) {return fieldError;}
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  // Try to find node by ID or producer_id
  let nodeId = args.nodeId;
  if (!plan.nodes.has(nodeId)) {
    // Try by producer_id
    nodeId = plan.producerIdToNodeId.get(args.nodeId) || '';
  }
  
  const node = plan.nodes.get(nodeId);
  const state = plan.nodeStates.get(nodeId);
  
  if (!node || !state) {
    return errorResult(`Node not found: ${args.nodeId}`);
  }
  
  return {
    success: true,
    node: {
      id: node.id,
      producerId: node.producerId,
      name: node.name,
      type: node.type,
      dependencies: node.dependencies.map(depId => {
        const depNode = plan.nodes.get(depId);
        return { id: depId, producerId: depNode?.producerId, name: depNode?.name };
      }),
      dependents: node.dependents.map(depId => {
        const depNode = plan.nodes.get(depId);
        return { id: depId, producerId: depNode?.producerId, name: depNode?.name };
      }),
      ...(node.type === 'job' ? {
        task: (node as any).task,
        work: (node as any).work,
        prechecks: (node as any).prechecks,
        postchecks: (node as any).postchecks,
      } : {}),
    },
    state: {
      status: state.status,
      attempts: state.attempts,
      scheduledAt: state.scheduledAt,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      error: state.error,
      baseCommit: state.baseCommit,
      completedCommit: state.completedCommit,
      worktreePath: state.worktreePath,
      mergedToTarget: plan.leaves.includes(nodeId) ? state.mergedToTarget : undefined,
      isLeaf: plan.leaves.includes(nodeId),
    },
  };
}

/**
 * Handle the `get_copilot_node_logs` MCP tool call.
 *
 * Returns execution logs for a node, optionally filtered by execution
 * phase (`prechecks`, `work`, `postchecks`, `commit`, or `all`).
 *
 * @param args - Must contain `planId` and `nodeId`. Optional `phase` filter.
 * @param ctx  - Handler context.
 * @returns `{ success, planId, nodeId, nodeName, phase, logs }`.
 */
export async function handleGetNodeLogs(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) {return fieldError;}
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) {return nodeResult;}
  const { node } = nodeResult;
  
  const phase = args.phase || 'all';
  const logs = ctx.PlanRunner.getNodeLogs(args.planId, args.nodeId, phase);
  
  return {
    success: true,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: node.name,
    phase,
    logs,
  };
}

/**
 * Handle the `get_copilot_node_attempts` MCP tool call.
 *
 * Returns the execution attempt history for a node. Each attempt records
 * status, timestamps, phase information, error details, and optionally
 * the full execution logs.
 *
 * @param args - Must contain `planId` and `nodeId`. Optional `attemptNumber`
 *               (1-based) to retrieve a single attempt, and `includeLogs`
 *               to include raw log content.
 * @param ctx  - Handler context.
 * @returns `{ success, totalAttempts, attempts: [...] }`.
 */
export async function handleGetNodeAttempts(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) {return fieldError;}
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) {return nodeResult;}
  const { node } = nodeResult;
  
  // Get specific attempt or all attempts
  if (args.attemptNumber) {
    const attempt = ctx.PlanRunner.getNodeAttempt(args.planId, args.nodeId, args.attemptNumber);
    if (!attempt) {
      return errorResult(`Attempt ${args.attemptNumber} not found`);
    }
    
    return {
      success: true,
      planId: args.planId,
      nodeId: args.nodeId,
      nodeName: node.name,
      attempt: args.includeLogs ? attempt : { ...attempt, logs: undefined },
    };
  }
  
  // Return all attempts
  const attempts = ctx.PlanRunner.getNodeAttempts(args.planId, args.nodeId);
  
  // Optionally strip logs for compact response
  const formattedAttempts = args.includeLogs 
    ? attempts 
    : attempts.map(a => ({ ...a, logs: a.logs ? `[${a.logs.length} chars - use includeLogs: true to retrieve]` : undefined }));
  
  return {
    success: true,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: node.name,
    totalAttempts: attempts.length,
    attempts: formattedAttempts,
  };
}

/**
 * Handle the `get_copilot_plan_node_failure_context` MCP tool call.
 *
 * Returns diagnostic information for a failed node: the failed execution
 * phase, error message, Copilot session ID (for agent work), worktree
 * path, and execution logs from the last attempt.
 *
 * @param args - Must contain `planId` and `nodeId`.
 * @param ctx  - Handler context.
 * @returns Failure context object or `{ success: false, error }`.
 */
export async function handleGetNodeFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) {return fieldError;}
  
  const result = ctx.PlanRunner.getNodeFailureContext(args.planId, args.nodeId);
  
  if ('error' in result) {
    return errorResult(result.error);
  }
  
  const plan = ctx.PlanRunner.getPlan(args.planId);
  const node = plan?.nodes.get(args.nodeId);
  
  return {
    success: true,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: node?.name || args.nodeId,
    phase: result.phase,
    errorMessage: result.errorMessage,
    sessionId: result.sessionId,
    worktreePath: result.worktreePath,
    lastAttempt: result.lastAttempt,
    logs: result.logs,
  };
}