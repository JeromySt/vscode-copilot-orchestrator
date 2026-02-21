/**
 * @fileoverview Job MCP Tool Handlers
 *
 * Implements the business logic for the new job-centric MCP tools.
 * These handlers use the PlanRunner internally but present a
 * job-first API to callers.
 *
 * @module mcp/handlers/jobHandlers
 */

import { validateAllowedFolders, validateAllowedUrls, validateAgentModels, validatePowerShellCommands } from '../validation';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
} from './utils';

// ============================================================================
// HELPERS
// ============================================================================

/** Resolve plan by planId. Returns the plan or an error result. */
function resolvePlan(args: any, ctx: PlanHandlerContext): { plan?: any; error?: any } {
  const plan = ctx.PlanRunner.getPlan(args.planId);
  if (!plan) {
    return { error: errorResult(`Plan not found: ${args.planId}`) };
  }
  return { plan };
}

/** Resolve a job within a plan by jobId or producerId. */
function resolveJob(plan: any, jobId: string): string {
  if (plan.jobs.has(jobId)) { return jobId; }
  return plan.producerIdToNodeId.get(jobId) || '';
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle the `get_copilot_job` MCP tool call.
 *
 * Looks up a job by planId + jobId (UUID or producerId).
 */
export async function handleGetJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}

  const { plan, error } = resolvePlan(args, ctx);
  if (error) { return error; }

  const nodeId = resolveJob(plan, args.jobId);
  const node = plan.jobs.get(nodeId);
  const state = plan.nodeStates.get(nodeId);

  if (!node || !state) {
    return errorResult(`Job not found: ${args.jobId}`);
  }

  return {
    success: true,
    node: {
      id: node.id,
      producerId: node.producerId,
      name: node.name,
      type: node.type,
      dependencies: node.dependencies.map((depId: string) => {
        const depNode = plan.jobs.get(depId);
        return { id: depId, producerId: depNode?.producerId, name: depNode?.name };
      }),
      dependents: node.dependents.map((depId: string) => {
        const depNode = plan.jobs.get(depId);
        return { id: depId, producerId: depNode?.producerId, name: depNode?.name };
      }),
      ...(node.type === 'job' ? {
        task: (node as any).task,
        work: (node as any).work || await plan.definition?.getWorkSpec(nodeId),
        prechecks: (node as any).prechecks || await plan.definition?.getPrechecksSpec(nodeId),
        postchecks: (node as any).postchecks || await plan.definition?.getPostchecksSpec(nodeId),
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
    planId: plan.id,
    groupId: plan.id,
    groupName: plan.spec.name,
  };
}

/**
 * Handle the `list_copilot_jobs` MCP tool call.
 *
 * Lists jobs in a plan with optional filters by status or group name.
 */
export async function handleListJobs(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) {return fieldError;}

  const { plan, error } = resolvePlan(args, ctx);
  if (error) { return error; }

  const nodes: any[] = [];

  // Filter by groupName
  if (args.groupName &&
      !plan.spec.name.toLowerCase().includes(args.groupName.toLowerCase())) {
    return { success: true, count: 0, nodes: [] };
  }

  for (const [nodeId, state] of plan.nodeStates) {
      // Filter by status
      if (args.status && state.status !== args.status) {continue;}

      const node = plan.jobs.get(nodeId);
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
  const fieldError = validateRequired(args, ['groupId']);
  if (fieldError) {return fieldError;}

  const status = ctx.PlanRunner.getStatus(args.groupId);
  if (!status) {
    return errorResult(`Group not found: ${args.groupId}`);
  }

  const { plan, status: planStatus, counts, progress } = status;

  const nodes: any[] = [];
  for (const [nodeId, state] of plan.nodeStates) {
    const node = plan.jobs.get(nodeId);
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
        nodeCount: plan.jobs.size,
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
  const fieldError = validateRequired(args, ['groupId']);
  if (fieldError) {return fieldError;}

  const plan = ctx.PlanRunner.getPlan(args.groupId);
  if (!plan) {
    return errorResult(`Group not found: ${args.groupId}`);
  }

  ctx.PlanRunner.cancel(args.groupId);

  return {
    success: true,
    message: `Group '${plan.spec.name}' canceled.`,
  };
}

/**
 * Handle the `delete_copilot_group` MCP tool call.
 */
export async function handleDeleteGroup(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['groupId']);
  if (fieldError) {return fieldError;}

  const plan = ctx.PlanRunner.getPlan(args.groupId);
  if (!plan) {
    return errorResult(`Group not found: ${args.groupId}`);
  }

  await ctx.PlanRunner.delete(args.groupId);

  return {
    success: true,
    message: `Group '${plan.spec.name}' deleted.`,
  };
}

/**
 * Handle the `retry_copilot_group` MCP tool call.
 */
export async function handleRetryGroup(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['groupId']);
  if (fieldError) {return fieldError;}

  const plan = ctx.PlanRunner.getPlan(args.groupId);
  if (!plan) {
    return errorResult(`Group not found: ${args.groupId}`);
  }

  try {
    // Determine which nodes to retry
    let nodeIdsToRetry: string[] = args.jobIds || [];

    if (nodeIdsToRetry.length === 0) {
      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'failed') {
          nodeIdsToRetry.push(nodeId);
        }
      }
    }

    if (nodeIdsToRetry.length === 0) {
      return {
        ...errorResult('No failed jobs to retry'),
        groupId: args.groupId,
      };
    }

    const retryOptions = {
      newWork: args.newWork,
      clearWorktree: args.clearWorktree || false,
    };

    const retriedNodes: Array<{ id: string; name: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const nodeId of nodeIdsToRetry) {
      const result = await ctx.PlanRunner.retryNode(args.groupId, nodeId, retryOptions);
      const node = plan.jobs.get(nodeId);
      if (result.success) {
        retriedNodes.push({ id: nodeId, name: node?.name || nodeId });
      } else {
        errors.push({ id: nodeId, error: result.error || 'Unknown error' });
      }
    }

    await ctx.PlanRunner.resume(args.groupId);

    return {
      success: retriedNodes.length > 0,
      message: retriedNodes.length > 0
        ? `Retrying ${retriedNodes.length} job(s) in group '${plan.spec.name}'`
        : 'No jobs were retried',
      groupId: args.groupId,
      retriedNodes,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error: any) {
    return errorResult(error.message);
  }
}

/**
 * Handle the `retry_copilot_job` MCP tool call.
 *
 * Retries a specific failed job by planId + jobId.
 */
export async function handleRetryJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}

  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {
    const modelValidation = await validateAgentModels(args, 'retry_copilot_job', ctx.configProvider);
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
  }

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'retry_copilot_job');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'retry_copilot_job');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }

  // Reject PowerShell commands containing 2>&1 (causes false failures)
  const psValidation = validatePowerShellCommands(args);
  if (!psValidation.valid) {
    return { success: false, error: psValidation.error };
  }

  const { plan, error } = resolvePlan(args, ctx);
  if (error) { return error; }

  const nodeId = resolveJob(plan, args.jobId);
  if (!plan.jobs.has(nodeId)) {
    return errorResult(`Job not found: ${args.jobId}`);
  }

  const retryOptions = {
    newWork: args.newWork,
    newPrechecks: args.newPrechecks,
    newPostchecks: args.newPostchecks,
    clearWorktree: args.clearWorktree || false,
  };

  const node = plan.jobs.get(nodeId);
  const result = await ctx.PlanRunner.retryNode(plan.id, nodeId, retryOptions);
  if (result.success) {
    await ctx.PlanRunner.resume(plan.id);
    return {
      success: true,
      message: `Retry initiated for job '${node?.name || args.jobId}'.`,
      planId: plan.id,
      jobId: nodeId,
      jobName: node?.name || args.jobId,
    };
  } else {
    return errorResult(result.error || 'Failed to retry job');
  }
}

/**
 * Handle the `force_fail_copilot_job` MCP tool call.
 *
 * Forces a stuck running/scheduled job to failed state so it can be retried.
 */
export async function handleForceFailJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}

  const { plan, error } = resolvePlan(args, ctx);
  if (error) { return error; }

  const nodeId = resolveJob(plan, args.jobId);
  if (!plan.jobs.has(nodeId)) {
    return errorResult(`Job not found: ${args.jobId}`);
  }

  try {
    await ctx.PlanRunner.forceFailNode(plan.id, nodeId);
    return {
      success: true,
      message: `Job '${args.jobId}' has been force failed. It can now be retried.`,
      planId: plan.id,
      groupId: plan.id,
    };
  } catch (err) {
    return errorResult((err as Error)?.message || 'Failed to force fail job');
  }
}

/**
 * Handle the `get_copilot_job_failure_context` MCP tool call.
 *
 * Gets failure context for a job by planId + jobId.
 */
export async function handleJobFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}

  const { plan, error } = resolvePlan(args, ctx);
  if (error) { return error; }

  const nodeId = resolveJob(plan, args.jobId);
  const node = plan.jobs.get(nodeId);
  const state = plan.nodeStates.get(nodeId);

  if (!node || !state) {
    return errorResult(`Job not found: ${args.jobId}`);
  }

  if (state.status !== 'failed') {
    return errorResult(`Job '${args.jobId}' is not in failed state (current: ${state.status})`);
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
    planId: plan.id,
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
