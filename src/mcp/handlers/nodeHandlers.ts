/**
 * @fileoverview Node MCP Tool Handlers
 *
 * Implements the business logic for the new node-centric MCP tools.
 * These handlers use the PlanRunner internally but present a
 * node-first API to callers.
 *
 * @module mcp/handlers/nodeHandlers
 */

import { validateAllowedFolders, validateAllowedUrls, validateAgentModels } from '../validation';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
} from './utils';

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle the `get_copilot_node` MCP tool call.
 *
 * Looks up a node globally (no planId needed) by UUID or producer_id.
 */
export async function handleGetNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['node_id']);
  if (fieldError) {return fieldError;}

  // Search across all plans for the node
  const plans = ctx.PlanRunner.getAll();
  for (const plan of plans) {
    let nodeId = args.node_id;

    // Try direct node ID lookup
    if (!plan.nodes.has(nodeId)) {
      // Try producer_id lookup
      nodeId = plan.producerIdToNodeId.get(args.node_id) || '';
    }

    const node = plan.nodes.get(nodeId);
    const state = plan.nodeStates.get(nodeId);

    if (node && state) {
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
        groupId: plan.id,
        groupName: plan.spec.name,
      };
    }
  }

  return errorResult(`Node not found: ${args.node_id}`);
}

/**
 * Handle the `list_copilot_nodes` MCP tool call.
 *
 * Lists nodes with optional filters by group, status, or group name.
 */
export async function handleListNodes(args: any, ctx: PlanHandlerContext): Promise<any> {
  const allPlans = ctx.PlanRunner.getAll();
  const nodes: any[] = [];

  for (const plan of allPlans) {
    // Filter by group_id
    if (args.group_id && plan.id !== args.group_id) {continue;}

    // Filter by group_name
    if (args.group_name &&
        !plan.spec.name.toLowerCase().includes(args.group_name.toLowerCase())) {continue;}

    for (const [nodeId, state] of plan.nodeStates) {
      // Filter by status
      if (args.status && state.status !== args.status) {continue;}

      const node = plan.nodes.get(nodeId);
      if (!node) {continue;}

      nodes.push({
        id: nodeId,
        producerId: node.producerId,
        name: node.name,
        type: node.type,
        status: state.status,
        error: state.error,
        attempts: state.attempts,
        groupId: plan.id,
        groupName: plan.spec.name,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
      });
    }
  }

  return {
    success: true,
    count: nodes.length,
    nodes,
  };
}

/**
 * Handle the `get_copilot_group_status` MCP tool call.
 *
 * Returns group status (delegates to plan status internally).
 */
export async function handleGetGroupStatus(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['group_id']);
  if (fieldError) {return fieldError;}

  const status = ctx.PlanRunner.getStatus(args.group_id);
  if (!status) {
    return errorResult(`Group not found: ${args.group_id}`);
  }

  const { plan, status: planStatus, counts, progress } = status;

  const nodes: any[] = [];
  for (const [nodeId, state] of plan.nodeStates) {
    const node = plan.nodes.get(nodeId);
    const isLeaf = plan.leaves.includes(nodeId);
    nodes.push({
      id: nodeId,
      producerId: node?.producerId,
      name: node?.name,
      type: node?.type,
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

  const effectiveEndedAt = ctx.PlanRunner.getEffectiveEndedAt(plan.id) || plan.endedAt;

  return {
    success: true,
    groupId: plan.id,
    name: plan.spec.name,
    status: planStatus,
    progress: Math.round(progress * 100),
    counts,
    nodes,
    createdAt: plan.createdAt,
    startedAt: plan.startedAt,
    endedAt: effectiveEndedAt,
    workSummary: plan.workSummary,
  };
}

/**
 * Handle the `list_copilot_groups` MCP tool call.
 *
 * Lists all groups (plans), optionally filtered by status.
 */
export async function handleListGroups(args: any, ctx: PlanHandlerContext): Promise<any> {
  let plans = ctx.PlanRunner.getAll();

  if (args.status) {
    plans = plans.filter(plan => {
      const sm = ctx.PlanRunner.getStateMachine(plan.id);
      return sm?.computePlanStatus() === args.status;
    });
  }

  plans.sort((a, b) => b.createdAt - a.createdAt);

  return {
    success: true,
    count: plans.length,
    groups: plans.map(plan => {
      const sm = ctx.PlanRunner.getStateMachine(plan.id);
      const counts = sm?.getStatusCounts();

      return {
        groupId: plan.id,
        name: plan.spec.name,
        status: sm?.computePlanStatus() || 'unknown',
        nodeCount: plan.nodes.size,
        counts,
        createdAt: plan.createdAt,
        startedAt: plan.startedAt,
        endedAt: ctx.PlanRunner.getEffectiveEndedAt(plan.id) || plan.endedAt,
      };
    }),
  };
}

/**
 * Handle the `cancel_copilot_group` MCP tool call.
 */
export async function handleCancelGroup(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['group_id']);
  if (fieldError) {return fieldError;}

  const plan = ctx.PlanRunner.getPlan(args.group_id);
  if (!plan) {
    return errorResult(`Group not found: ${args.group_id}`);
  }

  ctx.PlanRunner.cancel(args.group_id);

  return {
    success: true,
    message: `Group '${plan.spec.name}' canceled.`,
  };
}

/**
 * Handle the `delete_copilot_group` MCP tool call.
 */
export async function handleDeleteGroup(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['group_id']);
  if (fieldError) {return fieldError;}

  const plan = ctx.PlanRunner.getPlan(args.group_id);
  if (!plan) {
    return errorResult(`Group not found: ${args.group_id}`);
  }

  await ctx.PlanRunner.delete(args.group_id);

  return {
    success: true,
    message: `Group '${plan.spec.name}' deleted.`,
  };
}

/**
 * Handle the `retry_copilot_group` MCP tool call.
 */
export async function handleRetryGroup(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['group_id']);
  if (fieldError) {return fieldError;}

  const plan = ctx.PlanRunner.getPlan(args.group_id);
  if (!plan) {
    return errorResult(`Group not found: ${args.group_id}`);
  }

  try {
    // Determine which nodes to retry
    let nodeIdsToRetry: string[] = args.node_ids || [];

    if (nodeIdsToRetry.length === 0) {
      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'failed') {
          nodeIdsToRetry.push(nodeId);
        }
      }
    }

    if (nodeIdsToRetry.length === 0) {
      return {
        ...errorResult('No failed nodes to retry'),
        groupId: args.group_id,
      };
    }

    const retryOptions = {
      newWork: args.newWork,
      clearWorktree: args.clearWorktree || false,
    };

    const retriedNodes: Array<{ id: string; name: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const nodeId of nodeIdsToRetry) {
      const result = await ctx.PlanRunner.retryNode(args.group_id, nodeId, retryOptions);
      const node = plan.nodes.get(nodeId);
      if (result.success) {
        retriedNodes.push({ id: nodeId, name: node?.name || nodeId });
      } else {
        errors.push({ id: nodeId, error: result.error || 'Unknown error' });
      }
    }

    await ctx.PlanRunner.resume(args.group_id);

    return {
      success: retriedNodes.length > 0,
      message: retriedNodes.length > 0
        ? `Retrying ${retriedNodes.length} node(s) in group '${plan.spec.name}'`
        : 'No nodes were retried',
      groupId: args.group_id,
      retriedNodes,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error: any) {
    return errorResult(error.message);
  }
}

/**
 * Handle the `retry_copilot_node` MCP tool call.
 *
 * Retries a specific failed node. Finds the node globally (no planId needed).
 */
export async function handleRetryNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['node_id']);
  if (fieldError) {return fieldError;}

  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {
    const modelValidation = await validateAgentModels(args, 'retry_copilot_node');
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
  }

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'retry_copilot_node');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'retry_copilot_node');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }

  const retryOptions = {
    newWork: args.newWork,
    clearWorktree: args.clearWorktree || false,
  };

  // Find the node across all plans
  const plans = ctx.PlanRunner.getAll();
  for (const plan of plans) {
    let nodeId = args.node_id;
    if (!plan.nodes.has(nodeId)) {
      nodeId = plan.producerIdToNodeId.get(args.node_id) || '';
    }

    if (plan.nodes.has(nodeId)) {
      const result = await ctx.PlanRunner.retryNode(plan.id, nodeId, retryOptions);
      if (result.success) {
        await ctx.PlanRunner.resume(plan.id);
        return {
          success: true,
          message: `Retry initiated for node '${args.node_id}'.`,
          groupId: plan.id,
        };
      } else {
        return errorResult(result.error || 'Failed to retry node');
      }
    }
  }

  return errorResult(`Node not found: ${args.node_id}`);
}

/**
 * Handle the `force_fail_copilot_node` MCP tool call.
 *
 * Forces a stuck running/scheduled node to failed state so it can be retried.
 */
export async function handleForceFailNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['node_id']);
  if (fieldError) {return fieldError;}

  // Find the node across all plans
  const plans = ctx.PlanRunner.getAll();
  for (const plan of plans) {
    let nodeId = args.node_id;
    if (!plan.nodes.has(nodeId)) {
      nodeId = plan.producerIdToNodeId.get(args.node_id) || '';
    }

    if (plan.nodes.has(nodeId)) {
      try {
        await ctx.PlanRunner.forceFailNode(plan.id, nodeId);
        return {
          success: true,
          message: `Node '${args.node_id}' has been force failed. It can now be retried.`,
          groupId: plan.id,
        };
      } catch (error) {
        return errorResult((error as Error)?.message || 'Failed to force fail node');
      }
    }
  }

  return errorResult(`Node not found: ${args.node_id}`);
}

/**
 * Handle the `get_copilot_node_failure_context` MCP tool call.
 *
 * Gets failure context for a node without requiring planId.
 */
export async function handleNodeFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['node_id']);
  if (fieldError) {return fieldError;}

  const plans = ctx.PlanRunner.getAll();
  for (const plan of plans) {
    let nodeId = args.node_id;
    if (!plan.nodes.has(nodeId)) {
      nodeId = plan.producerIdToNodeId.get(args.node_id) || '';
    }

    const node = plan.nodes.get(nodeId);
    const state = plan.nodeStates.get(nodeId);

    if (node && state) {
      if (state.status !== 'failed') {
        return errorResult(`Node '${args.node_id}' is not in failed state (current: ${state.status})`);
      }

      // Get logs from executor
      const executor = (ctx.PlanRunner as any).executor;
      let logs: any[] = [];
      if (executor?.getLogs) {
        logs = executor.getLogs(plan.id, nodeId);
      }

      return {
        success: true,
        nodeId,
        producerId: node.producerId,
        name: node.name,
        groupId: plan.id,
        groupName: plan.spec.name,
        failedPhase: state.lastAttempt?.phase,
        error: state.error,
        attempts: state.attempts,
        worktreePath: state.worktreePath,
        copilotSessionId: state.copilotSessionId,
        lastAttempt: state.lastAttempt,
        logs: logs.map((l: any) => ({
          timestamp: l.timestamp,
          phase: l.phase,
          type: l.type,
          message: l.message,
        })),
      };
    }
  }

  return errorResult(`Node not found: ${args.node_id}`);
}
