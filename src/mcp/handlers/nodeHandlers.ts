/**
 * @fileoverview Node MCP Tool Handlers
 *
 * Implements the business logic for the new node-centric MCP tools.
 * These handlers use the PlanRunner internally but present a
 * node-first API to callers.
 *
 * @module mcp/handlers/nodeHandlers
 */

import {
  NodeSpec,
  JobNodeSpec,
  PlanSpec,
} from '../../plan/types';
import { validateAllowedFolders, validateAllowedUrls, validateAgentModels } from '../validation';
import { PRODUCER_ID_PATTERN } from '../tools/planTools';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  resolveBaseBranch,
  resolveTargetBranch,
} from './utils';

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate node specs from create_copilot_node input.
 */
function validateNodeSpecs(nodes: any[]): { valid: boolean; error?: string; specs?: NodeSpec[] } {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { valid: false, error: 'Must provide at least one node in the nodes array' };
  }

  const errors: string[] = [];
  const producerIds = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (!node.producer_id) {
      errors.push(`Node at index ${i} is missing required 'producer_id' field`);
      continue;
    }

    if (!PRODUCER_ID_PATTERN.test(node.producer_id)) {
      errors.push(
        `Node '${node.producer_id}' has invalid producer_id format. ` +
        `Must be 3-64 characters, lowercase letters, numbers, and hyphens only.`
      );
      continue;
    }

    if (producerIds.has(node.producer_id)) {
      errors.push(`Duplicate producer_id: '${node.producer_id}'`);
      continue;
    }
    producerIds.add(node.producer_id);

    if (!node.task) {
      errors.push(`Node '${node.producer_id}' is missing required 'task' field`);
    }

    if (!Array.isArray(node.dependencies)) {
      errors.push(`Node '${node.producer_id}' must have a 'dependencies' array (use [] for root nodes)`);
    }
  }

  // Validate dependency references
  for (const node of nodes) {
    if (!Array.isArray(node.dependencies)) continue;
    for (const dep of node.dependencies) {
      if (!producerIds.has(dep)) {
        errors.push(
          `Node '${node.producer_id}' references unknown dependency '${dep}'. ` +
          `Valid producer_ids: ${[...producerIds].join(', ')}`
        );
      }
      if (dep === node.producer_id) {
        errors.push(`Node '${node.producer_id}' cannot depend on itself`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }

  const specs: NodeSpec[] = nodes.map((n: any): NodeSpec => ({
    producerId: n.producer_id,
    name: n.name || n.producer_id,
    task: n.task,
    work: n.work,
    prechecks: n.prechecks,
    postchecks: n.postchecks,
    instructions: n.instructions,
    dependencies: n.dependencies || [],
    baseBranch: n.base_branch,
    expectsNoChanges: n.expects_no_changes,
    group: n.group,
  }));

  return { valid: true, specs };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle the `create_copilot_node` MCP tool call.
 *
 * Creates nodes. Internally delegates to PlanRunner by converting to PlanSpec format.
 */
export async function handleCreateNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const validation = validateNodeSpecs(args.nodes);
  if (!validation.valid || !validation.specs) {
    return errorResult(validation.error || 'Invalid input');
  }

  // Validate agent model names
  const modelValidation = await validateAgentModels(args, 'create_copilot_node');
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'create_copilot_node');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'create_copilot_node');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }

  try {
    const repoPath = ctx.workspacePath;

    if (validation.specs.length === 1) {
      // Single node → create as a single job plan
      const nodeSpec = validation.specs[0];
      const nodeName = nodeSpec.name || nodeSpec.producerId;
      const baseBranch = await resolveBaseBranch(repoPath, ctx.git, args.base_branch || nodeSpec.baseBranch);
      const targetBranch = await resolveTargetBranch(baseBranch, repoPath, ctx.git, args.target_branch, nodeName);

      const plan = ctx.PlanRunner.enqueueJob({
        name: nodeName,
        task: nodeSpec.task,
        work: nodeSpec.work as string | undefined,
        prechecks: nodeSpec.prechecks as string | undefined,
        postchecks: nodeSpec.postchecks as string | undefined,
        instructions: nodeSpec.instructions,
        baseBranch,
        targetBranch,
        expectsNoChanges: nodeSpec.expectsNoChanges,
      });

      const nodeId = plan.roots[0];

      return {
        success: true,
        nodeId,
        groupId: plan.id,
        baseBranch: plan.baseBranch,
        targetBranch: plan.targetBranch,
        message: `Node '${nodeName}' created. ` +
                 `Use nodeId '${nodeId}' or groupId '${plan.id}' to monitor progress.`,
      };
    } else {
      // Multiple nodes → create as a plan
      const batchName = `Batch (${validation.specs.length} nodes)`;
      const baseBranch = await resolveBaseBranch(repoPath, ctx.git, args.base_branch);
      const targetBranch = await resolveTargetBranch(baseBranch, repoPath, ctx.git, args.target_branch, batchName);

      const spec: PlanSpec = {
        name: batchName,
        repoPath,
        baseBranch,
        targetBranch,
        maxParallel: args.max_parallel,
        cleanUpSuccessfulWork: args.clean_up_successful_work,
        jobs: validation.specs.map((n): JobNodeSpec => ({
          producerId: n.producerId,
          name: n.name,
          task: n.task,
          work: n.work,
          prechecks: n.prechecks,
          postchecks: n.postchecks,
          instructions: n.instructions,
          dependencies: n.dependencies,
          baseBranch: n.baseBranch,
          expectsNoChanges: n.expectsNoChanges,
          group: n.group,
        })),
      };

      const plan = ctx.PlanRunner.enqueue(spec);

      const nodeMapping: Record<string, string> = {};
      for (const [producerId, nodeId] of plan.producerIdToNodeId) {
        nodeMapping[producerId] = nodeId;
      }

      return {
        success: true,
        groupId: plan.id,
        nodeCount: plan.nodes.size,
        nodeMapping,
        message: `Batch of ${plan.nodes.size} nodes created. ` +
                 `Use groupId '${plan.id}' to monitor progress.`,
      };
    }
  } catch (error: any) {
    return errorResult(error.message);
  }
}

/**
 * Handle the `get_copilot_node` MCP tool call.
 *
 * Looks up a node globally (no planId needed) by UUID or producer_id.
 */
export async function handleGetNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['node_id']);
  if (fieldError) return fieldError;

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
    if (args.group_id && plan.id !== args.group_id) continue;

    // Filter by group_name
    if (args.group_name &&
        !plan.spec.name.toLowerCase().includes(args.group_name.toLowerCase())) continue;

    for (const [nodeId, state] of plan.nodeStates) {
      // Filter by status
      if (args.status && state.status !== args.status) continue;

      const node = plan.nodes.get(nodeId);
      if (!node) continue;

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
  if (fieldError) return fieldError;

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
  if (fieldError) return fieldError;

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
  if (fieldError) return fieldError;

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
  if (fieldError) return fieldError;

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
  if (fieldError) return fieldError;

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
  if (fieldError) return fieldError;

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
  if (fieldError) return fieldError;

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
