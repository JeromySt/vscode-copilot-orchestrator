/**
 * @fileoverview Job Details MCP Tool Handlers
 * 
 * Implements handlers for retrieving detailed job information, logs, attempts, and failure context.
 * 
 * @module mcp/handlers/plan/jobDetailsHandler
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
 * Handle the `get_copilot_job_details` MCP tool call.
 *
 * Returns detailed information about a single job including its
 * dependencies, dependents, work specification, and execution state.
 * The job can be looked up by UUID or by `producerId`.
 *
 * @param args - Must contain `planId` and `jobId` (UUID or producerId).
 * @param ctx  - Handler context.
 * @returns Job details with `{ node, state }` sub-objects.
 */
export async function handleGetJobDetails(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Accept both jobId (new) and nodeId (legacy) for backward compatibility
  const jobIdValue = args.jobId || args.nodeId;
  const fieldError = validateRequired({ ...args, jobId: jobIdValue }, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  // Try to find job by ID or producerId
  let nodeId = jobIdValue;
  if (!plan.jobs.has(nodeId)) {
    // Try by producerId
    nodeId = plan.producerIdToNodeId.get(jobIdValue) || '';
  }
  
  const node = plan.jobs.get(nodeId);
  const state = plan.nodeStates.get(nodeId);
  
  if (!node || !state) {
    return errorResult(`Job not found: ${jobIdValue}`);
  }
  
  return {
    success: true,
    node: {
      id: node.id,
      producerId: node.producerId,
      name: node.name,
      type: node.type,
      dependencies: node.dependencies.map(depId => {
        const depNode = plan.jobs.get(depId);
        return { id: depId, producerId: depNode?.producerId, name: depNode?.name };
      }),
      dependents: node.dependents.map(depId => {
        const depNode = plan.jobs.get(depId);
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
 * Handle the `get_copilot_job_logs` MCP tool call.
 *
 * Returns execution logs for a job, optionally filtered by execution
 * phase (`merge-fi`, `setup`, `prechecks`, `work`, `commit`, `postchecks`, `merge-ri`, or `all`).
 *
 * @param args - Must contain `planId` and `jobId`. Optional `phase` filter.
 * @param ctx  - Handler context.
 * @returns `{ success, planId, jobId, jobName, phase, logs }`.
 */
export async function handleGetJobLogs(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Accept both jobId (new) and nodeId (legacy) for backward compatibility
  const jobIdValue = args.jobId || args.nodeId;
  const fieldError = validateRequired({ ...args, jobId: jobIdValue }, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, jobIdValue);
  if (isError(nodeResult)) {return nodeResult;}
  const { node } = nodeResult;
  
  const phase = args.phase || 'all';
  const logs = ctx.PlanRunner.getNodeLogs(args.planId, jobIdValue, phase);
  
  return {
    success: true,
    planId: args.planId,
    jobId: jobIdValue,
    jobName: node.name,
    phase,
    logs,
  };
}

/**
 * Handle the `get_copilot_job_attempts` MCP tool call.
 *
 * Returns the execution attempt history for a job. Each attempt records
 * status, timestamps, phase information, error details, and optionally
 * the full execution logs.
 *
 * @param args - Must contain `planId` and `jobId`. Optional `attemptNumber`
 *               (1-based) to retrieve a single attempt, and `includeLogs`
 *               to include raw log content.
 * @param ctx  - Handler context.
 * @returns `{ success, totalAttempts, attempts: [...] }`.
 */
export async function handleGetJobAttempts(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Accept both jobId (new) and nodeId (legacy) for backward compatibility
  const jobIdValue = args.jobId || args.nodeId;
  const fieldError = validateRequired({ ...args, jobId: jobIdValue }, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) {return planResult;}
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, jobIdValue);
  if (isError(nodeResult)) {return nodeResult;}
  const { node } = nodeResult;
  
  // Get specific attempt or all attempts
  if (args.attemptNumber) {
    const attempt = ctx.PlanRunner.getNodeAttempt(args.planId, jobIdValue, args.attemptNumber);
    if (!attempt) {
      return errorResult(`Attempt ${args.attemptNumber} not found`);
    }
    
    return {
      success: true,
      planId: args.planId,
      jobId: jobIdValue,
      jobName: node.name,
      attempt: args.includeLogs ? attempt : { ...attempt, logs: undefined },
    };
  }
  
  // Return all attempts
  const attempts = ctx.PlanRunner.getNodeAttempts(args.planId, jobIdValue);
  
  // Optionally strip logs for compact response
  const formattedAttempts = args.includeLogs 
    ? attempts 
    : attempts.map(a => ({ ...a, logs: a.logs ? `[${a.logs.length} chars - use includeLogs: true to retrieve]` : undefined }));
  
  return {
    success: true,
    planId: args.planId,
    jobId: jobIdValue,
    jobName: node.name,
    totalAttempts: attempts.length,
    attempts: formattedAttempts,
  };
}

/**
 * Handle the `get_copilot_plan_job_failure_context` MCP tool call.
 *
 * Returns diagnostic information for a failed job: the failed execution
 * phase, error message, Copilot session ID (for agent work), worktree
 * path, and execution logs from the last attempt.
 *
 * @param args - Must contain `planId` and `jobId`.
 * @param ctx  - Handler context.
 * @returns Failure context object or `{ success: false, error }`.
 */
export async function handleGetJobFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Accept both jobId (new) and nodeId (legacy) for backward compatibility
  const jobIdValue = args.jobId || args.nodeId;
  const fieldError = validateRequired({ ...args, jobId: jobIdValue }, ['planId', 'jobId']);
  if (fieldError) {return fieldError;}
  
  const result = ctx.PlanRunner.getNodeFailureContext(args.planId, jobIdValue);
  
  if ('error' in result) {
    return errorResult(result.error);
  }
  
  const plan = ctx.PlanRunner.getPlan(args.planId);
  const node = plan?.jobs.get(jobIdValue);
  
  return {
    success: true,
    planId: args.planId,
    jobId: jobIdValue,
    jobName: node?.name || jobIdValue,
    phase: result.phase,
    errorMessage: result.errorMessage,
    sessionId: result.sessionId,
    worktreePath: result.worktreePath,
    lastAttempt: result.lastAttempt,
    logs: result.logs,
  };
}