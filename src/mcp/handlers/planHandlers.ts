/**
 * @fileoverview Plan MCP Tool Handlers
 * 
 * Implements the business logic for all Plan-related MCP tools.
 * 
 * @module mcp/handlers/planHandlers
 */

import { 
  PlanSpec, 
  JobNodeSpec, 
  GroupSpec,
  JobNode,
  normalizeWorkSpec,
} from '../../plan/types';
import { computeMergedLeafWorkSummary } from '../../plan';
import { validateAllowedFolders, validateAllowedUrls } from '../validation';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  lookupNode,
  isError,
  resolveBaseBranch,
  resolveTargetBranch,
} from './utils';
import { validateAgentModels } from '../validation';

// ============================================================================
// GROUP FLATTENING
// ============================================================================

/**
 * Flatten groups recursively into a flat array of JobNodeSpec.
 * 
 * Each job gets:
 * - Qualified producerId: "group/path/local_id"
 * - group field set to the full group path
 * - Dependencies resolved with qualified paths
 * 
 * @param groups - Array of group specs from MCP input
 * @param groupPath - Current group path prefix (e.g., "backend/api")
 * @returns Flattened array of JobNodeSpec
 */
function flattenGroupsToJobs(
  groups: any[] | undefined, 
  groupPath: string
): JobNodeSpec[] {
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    return [];
  }
  
  const result: JobNodeSpec[] = [];
  
  for (const g of groups) {
    const groupName = g.name;
    const currentPath = groupPath ? `${groupPath}/${groupName}` : groupName;
    
    // Flatten jobs in this group
    for (const j of g.jobs || []) {
      const qualifiedId = `${currentPath}/${j.producer_id}`;
      
      // Resolve dependencies - local refs become qualified, already-qualified refs pass through
      const resolvedDeps = (j.dependencies || []).map((dep: string) => {
        // If dep contains '/', it's already qualified
        if (dep.includes('/')) return dep;
        // Otherwise, qualify it with our group path
        return `${currentPath}/${dep}`;
      });
      
      result.push({
        producerId: qualifiedId,
        name: j.name || j.producer_id,
        task: j.task,
        work: j.work,
        dependencies: resolvedDeps,
        prechecks: j.prechecks,
        postchecks: j.postchecks,
        instructions: j.instructions,
        baseBranch: j.baseBranch,
        expectsNoChanges: j.expects_no_changes,
        group: currentPath,
      });
    }
    
    // Recursively flatten nested groups
    result.push(...flattenGroupsToJobs(g.groups, currentPath));
  }
  
  return result;
}

/**
 * Validate groups recursively for dependency references.
 * 
 * Note: Schema validation (required fields, unknown properties, patterns)
 * is handled by Ajv in the MCP handler layer. This function only validates
 * business logic that requires semantic understanding:
 * - Dependency references resolve to valid producer_ids
 * - No self-referential dependencies
 * 
 * @param groups - Array of groups to validate
 * @param groupPath - Current group path for error messages
 * @param validGlobalRefs - All valid producer_ids for dependency checking
 * @param errors - Array to accumulate errors
 */
function validateGroupsRecursively(
  groups: any[] | undefined,
  groupPath: string,
  validGlobalRefs: Set<string>,
  errors: string[]
): void {
  if (!groups || !Array.isArray(groups)) return;
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group.name) continue; // Schema validation catches this
    
    const currentPath = groupPath ? `${groupPath}/${group.name}` : group.name;
    
    // Validate job dependencies in this group
    for (let j = 0; j < (group.jobs || []).length; j++) {
      const job = group.jobs[j];
      if (!job.producer_id) continue; // Schema validation catches this
      
      const qualifiedId = `${currentPath}/${job.producer_id}`;
      
      // Check dependencies resolve
      if (Array.isArray(job.dependencies)) {
        for (const dep of job.dependencies) {
          const resolvedDep = dep.includes('/') ? dep : `${currentPath}/${dep}`;
          if (!validGlobalRefs.has(resolvedDep)) {
            errors.push(`Job '${qualifiedId}' references unknown dependency '${dep}'`);
          }
          if (resolvedDep === qualifiedId) {
            errors.push(`Job '${qualifiedId}' cannot depend on itself`);
          }
        }
      }
    }
    
    // Recursively validate nested groups
    validateGroupsRecursively(group.groups, currentPath, validGlobalRefs, errors);
  }
}

/**
 * Collect all producer_ids from groups recursively (for reference validation).
 */
function collectGroupProducerIds(groups: any[] | undefined, groupPath: string, ids: Set<string>): void {
  if (!groups || !Array.isArray(groups)) return;
  
  for (const g of groups) {
    const currentPath = groupPath ? `${groupPath}/${g.name}` : g.name;
    
    for (const j of g.jobs || []) {
      if (j.producer_id) {
        const qualifiedId = `${currentPath}/${j.producer_id}`;
        if (ids.has(qualifiedId)) {
          // Duplicate - will be caught in validation
        }
        ids.add(qualifiedId);
      }
    }
    
    collectGroupProducerIds(g.groups, currentPath, ids);
  }
}

/**
 * Validate and transform raw `create_copilot_plan` input into a {@link PlanSpec}.
 *
 * Note: Schema validation (required fields, allowed properties, patterns) is
 * handled by Ajv in the MCP handler layer. This function performs:
 * 1. Semantic validation (dependency resolution, duplicate detection)
 * 2. Transformation to internal PlanSpec format
 * 3. Group flattening
 *
 * @param args - Raw arguments from the `tools/call` request (already schema-validated).
 * @returns `{ valid: true, spec }` on success, or `{ valid: false, error }` on failure.
 */
function validatePlanInput(args: any): { valid: boolean; error?: string; spec?: PlanSpec } {
  // Collect all producer_ids for reference validation
  const allProducerIds = new Set<string>();
  const errors: string[] = [];
  
  // Collect root job producer_ids and check for duplicates
  for (const job of args.jobs || []) {
    if (!job.producer_id) continue; // Schema validation catches this
    
    if (allProducerIds.has(job.producer_id)) {
      errors.push(`Duplicate producer_id: '${job.producer_id}'`);
    } else {
      allProducerIds.add(job.producer_id);
    }
  }
  
  // Collect all producer_ids from groups (qualified paths)
  collectGroupProducerIds(args.groups, '', allProducerIds);
  
  // Validate root-level job dependencies
  for (const job of args.jobs || []) {
    if (!job.producer_id || !Array.isArray(job.dependencies)) continue;
    
    for (const dep of job.dependencies) {
      if (!allProducerIds.has(dep)) {
        errors.push(
          `Job '${job.producer_id}' references unknown dependency '${dep}'. ` +
          `Valid producer_ids: ${[...allProducerIds].join(', ')}`
        );
      }
      if (dep === job.producer_id) {
        errors.push(`Job '${job.producer_id}' cannot depend on itself`);
      }
    }
  }
  
  // Validate group job dependencies
  validateGroupsRecursively(args.groups, '', allProducerIds, errors);
  
  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  
  // Transform to PlanSpec - flatten groups into jobs
  const rootJobs: JobNodeSpec[] = (args.jobs || []).map((j: any): JobNodeSpec => ({
    producerId: j.producer_id,
    name: j.name || j.producer_id,
    task: j.task,
    work: j.work,
    dependencies: j.dependencies || [],
    prechecks: j.prechecks,
    postchecks: j.postchecks,
    instructions: j.instructions,
    baseBranch: j.baseBranch,
    expectsNoChanges: j.expects_no_changes,
    group: j.group,
  }));
  
  // Flatten groups into additional jobs
  const groupJobs = flattenGroupsToJobs(args.groups, '');
  
  const spec: PlanSpec = {
    name: args.name,
    baseBranch: args.baseBranch,
    targetBranch: args.targetBranch,
    maxParallel: args.maxParallel,
    cleanUpSuccessfulWork: args.cleanUpSuccessfulWork,
    startPaused: args.startPaused,
    jobs: [...rootJobs, ...groupJobs],
    // Note: groups are flattened into jobs, not stored separately
  };
  
  return { valid: true, spec };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle the `create_copilot_plan` MCP tool call.
 *
 * Validates input via {@link validatePlanInput}, resolves base/target branches
 * using the workspace git repository, then enqueues the plan via
 * {@link PlanRunner.enqueue}.
 *
 * @param args - Raw tool arguments matching the `create_copilot_plan` input schema.
 * @param ctx  - Handler context providing {@link PlanRunner} and workspace path.
 * @returns On success: `{ success: true, planId, name, nodeMapping, status, ... }`.
 *          On failure: `{ success: false, error }`.
 *
 * @example
 * ```jsonc
 * // MCP tools/call request
 * {
 *   "name": "create_copilot_plan",
 *   "arguments": {
 *     "name": "Build & Test",
 *     "jobs": [
 *       { "producer_id": "build", "task": "Build", "work": "npm run build", "dependencies": [] },
 *       { "producer_id": "test",  "task": "Test",  "work": "npm test",      "dependencies": ["build"] }
 *     ]
 *   }
 * }
 * ```
 */
export async function handleCreatePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input
  const validation = validatePlanInput(args);
  if (!validation.valid || !validation.spec) {
    return errorResult(validation.error || 'Invalid input');
  }

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'create_copilot_plan');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'create_copilot_plan');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names
  const modelValidation = await validateAgentModels(args, 'create_copilot_plan');
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }
  
  try {
    validation.spec.repoPath = ctx.workspacePath;
    const repoPath = ctx.workspacePath;
    
    const baseBranch = await resolveBaseBranch(repoPath, validation.spec.baseBranch);
    validation.spec.baseBranch = baseBranch;
    
    validation.spec.targetBranch = await resolveTargetBranch(
      baseBranch, repoPath, validation.spec.targetBranch, validation.spec.name
    );
    
    // Create the Plan
    const plan = ctx.PlanRunner.enqueue(validation.spec);
    
    // Build node mapping for response
    const nodeMapping: Record<string, string> = {};
    for (const [producerId, nodeId] of plan.producerIdToNodeId) {
      nodeMapping[producerId] = nodeId;
    }
    
    const isPaused = plan.isPaused === true;
    const pauseNote = isPaused
      ? ' Plan is PAUSED. Use resume_copilot_plan to start execution.'
      : '';
    
    return {
      success: true,
      planId: plan.id,
      name: plan.spec.name,
      baseBranch: plan.baseBranch,
      targetBranch: plan.targetBranch,
      paused: isPaused,
      message: `Plan '${plan.spec.name}' created with ${plan.nodes.size} nodes. ` +
               `Base: ${plan.baseBranch}, Target: ${plan.targetBranch}.${pauseNote} ` +
               `Use planId '${plan.id}' to monitor progress.`,
      nodeMapping,
      status: {
        status: isPaused ? 'paused' : 'pending',
        nodes: plan.nodes.size,
        roots: plan.roots.length,
        leaves: plan.leaves.length,
      },
    };
  } catch (error: any) {
    return errorResult(error.message);
  }
}

/**
 * Handle the `create_copilot_job` MCP tool call.
 *
 * Convenience wrapper that creates a Plan containing a single job node.
 * Resolves base/target branches and delegates to {@link PlanRunner.enqueueJob}.
 *
 * @param args - Raw tool arguments matching the `create_copilot_job` input schema.
 *               Must include `name` and `task`; other fields are optional.
 * @param ctx  - Handler context providing {@link PlanRunner} and workspace path.
 * @returns On success: `{ success: true, planId, nodeId, baseBranch, targetBranch, message }`.
 *          On failure: `{ success: false, error }`.
 *
 * @example
 * ```jsonc
 * // MCP tools/call request
 * {
 *   "name": "create_copilot_job",
 *   "arguments": { "name": "Lint", "task": "Run linter", "work": "npm run lint" }
 * }
 * ```
 */
export async function handleCreateJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.name) {
    return errorResult('Job must have a name');
  }
  
  if (!args.task) {
    return errorResult('Job must have a task');
  }

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'create_copilot_job');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'create_copilot_job');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names
  const modelValidation = await validateAgentModels(args, 'create_copilot_job');
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }
  
  try {
    const repoPath = ctx.workspacePath;
    const baseBranch = await resolveBaseBranch(repoPath, args.baseBranch);
    const targetBranch = await resolveTargetBranch(baseBranch, repoPath, args.targetBranch, args.name);
    
    const plan = ctx.PlanRunner.enqueueJob({
      name: args.name,
      task: args.task,
      work: args.work,
      prechecks: args.prechecks,
      postchecks: args.postchecks,
      instructions: args.instructions,
      baseBranch,
      targetBranch,
      startPaused: args.startPaused,
    });
    
    // Get the single node ID
    const nodeId = plan.roots[0];
    
    const isPaused = plan.isPaused === true;
    const pauseNote = isPaused
      ? ' Job is PAUSED. Use resume_copilot_plan to start execution.'
      : '';
    
    return {
      success: true,
      planId: plan.id,
      nodeId,
      baseBranch: plan.baseBranch,
      targetBranch: plan.targetBranch,
      paused: isPaused,
      message: `Job '${args.name}' created. Base: ${plan.baseBranch}, Target: ${plan.targetBranch}.${pauseNote} Use planId '${plan.id}' to monitor progress.`,
    };
  } catch (error: any) {
    return errorResult(error.message);
  }
}

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
    const nodeGroup = node?.type === 'job' ? (node as import('../../plan/types').JobNode).group : undefined;
    
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
  if (fieldError) return fieldError;
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) return planResult;
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
  if (fieldError) return fieldError;
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) return nodeResult;
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
  if (fieldError) return fieldError;
  
  const planResult = lookupPlan(ctx, args.planId);
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) return nodeResult;
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
 * Handle the `cancel_copilot_plan` MCP tool call.
 *
 * Cancels a running plan and all of its in-progress or pending jobs.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleCancelPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;
  
  const success = ctx.PlanRunner.cancel(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been canceled` 
      : `Failed to cancel Plan ${args.id}`,
  };
}

/**
 * Handle the `pause_copilot_plan` MCP tool call.
 *
 * Pauses a running plan. Running jobs will complete but no new work will be scheduled.
 * Worktrees are preserved so the plan can be resumed later.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handlePausePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;
  
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
  if (fieldError) return fieldError;
  
  const success = await ctx.PlanRunner.resume(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been resumed. New work will be scheduled.` 
      : `Failed to resume Plan ${args.id}`,
  };
}

/**
 * Handle the `delete_copilot_plan` MCP tool call.
 *
 * Permanently deletes a plan and its execution history.
 *
 * @param args - Must contain `id` (Plan UUID).
 * @param ctx  - Handler context.
 * @returns `{ success, message }`.
 */
export async function handleDeletePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;
  
  const success = ctx.PlanRunner.delete(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been deleted` 
      : `Failed to delete Plan ${args.id}`,
  };
}

/**
 * Handle the `retry_copilot_plan` MCP tool call.
 *
 * Resets failed nodes back to `ready` state and resumes plan execution.
 * Can retry all failed nodes (default) or a specific subset identified
 * by `nodeIds`.  An optional `newWork` spec replaces the original work
 * for the retried nodes.
 *
 * @param args - Must contain `id`. Optional `nodeIds`, `newWork`, `clearWorktree`.
 * @param ctx  - Handler context.
 * @returns `{ success, retriedNodes, errors }`.
 *
 * @example
 * ```jsonc
 * // Retry all failed nodes with replacement work
 * {
 *   "name": "retry_copilot_plan",
 *   "arguments": {
 *     "id": "plan-uuid",
 *     "newWork": "@agent Fix the build errors"
 *   }
 * }
 * ```
 */
export async function handleRetryPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['id']);
  if (fieldError) return fieldError;

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'retry_copilot_plan');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'retry_copilot_plan');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {
    const modelValidation = await validateAgentModels(args, 'retry_copilot_plan');
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
  }
  
  const planResult = lookupPlan(ctx, args.id, 'getPlan');
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  // Determine which nodes to retry
  let nodeIdsToRetry: string[] = args.nodeIds || [];
  
  if (nodeIdsToRetry.length === 0) {
    // No specific nodes - retry all failed nodes
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'failed') {
        nodeIdsToRetry.push(nodeId);
      }
    }
  }
  
  if (nodeIdsToRetry.length === 0) {
    return { 
      ...errorResult('No failed nodes to retry'),
      planId: args.id,
    };
  }
  
  // Build retry options from args
  const retryOptions = {
    newWork: args.newWork,
    newPrechecks: args.newPrechecks,
    newPostchecks: args.newPostchecks,
    clearWorktree: args.clearWorktree || false,
  };
  
  // Retry the failed nodes using the PlanRunner method
  const retriedNodes: Array<{ id: string; name: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  
  for (const nodeId of nodeIdsToRetry) {
    const result = await ctx.PlanRunner.retryNode(args.id, nodeId, retryOptions);
    const node = plan.nodes.get(nodeId);
    
    if (result.success) {
      retriedNodes.push({ id: nodeId, name: node?.name || nodeId });
    } else {
      errors.push({ id: nodeId, error: result.error || 'Unknown error' });
    }
  }
  
  // Resume the Plan if it was stopped
  await ctx.PlanRunner.resume(args.id);
  
  return {
    success: retriedNodes.length > 0,
    message: retriedNodes.length > 0 
      ? `Retrying ${retriedNodes.length} node(s)` 
      : 'No nodes were retried',
    planId: args.id,
    retriedNodes,
    errors: errors.length > 0 ? errors : undefined,
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
  if (fieldError) return fieldError;
  
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

/**
 * Handle the `retry_copilot_plan_node` MCP tool call.
 *
 * Retries a single failed node in a plan. This is a convenience wrapper
 * around the multi-node retry logic. The node must be in `failed` state.
 *
 * Recommended workflow:
 * 1. Call `get_copilot_plan_node_failure_context` to analyse the failure.
 * 2. Call this handler with optional `newWork` to replace the original work.
 * 3. Monitor progress with `get_copilot_plan_status`.
 *
 * @param args - Must contain `planId` and `nodeId`. Optional `newWork`, `clearWorktree`.
 * @param ctx  - Handler context.
 * @returns `{ success, message, planId, nodeId, nodeName, hasNewWork, clearWorktree }`.
 */
export async function handleRetryPlanNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) return fieldError;

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'retry_copilot_plan_node');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'retry_copilot_plan_node');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names if any new specs are provided
  if (args.newWork || args.newPrechecks || args.newPostchecks) {    const modelValidation = await validateAgentModels(args, 'retry_copilot_plan_node');
    if (!modelValidation.valid) {
      return { success: false, error: modelValidation.error };
    }
  }
  
  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) return nodeResult;
  const { node, state } = nodeResult;
  
  if (!state || state.status !== 'failed') {
    return errorResult(
      `Node ${args.nodeId} is not in failed state (current: ${state?.status || 'unknown'})`
    );
  }
  
  // Build retry options from args
  const retryOptions = {
    newWork: args.newWork,
    newPrechecks: args.newPrechecks,
    newPostchecks: args.newPostchecks,
    clearWorktree: args.clearWorktree || false,
  };
  
  const result = await ctx.PlanRunner.retryNode(args.planId, args.nodeId, retryOptions);
  
  if (!result.success) {
    return errorResult(result.error || 'Retry failed');
  }
  
  // Resume the Plan if it was stopped
  await ctx.PlanRunner.resume(args.planId);
  
  return {
    success: true,
    message: `Retrying node "${node.name}"`,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: node.name,
    hasNewWork: !!args.newWork,
    clearWorktree: retryOptions.clearWorktree,
  };
}

/**
 * Handle the `update_copilot_plan_node` MCP tool call.
 *
 * Updates a node's job specification and resets execution as needed.
 * Any provided stage (prechecks, work, postchecks) will replace the existing
 * definition and reset execution to re-run from that stage.
 *
 * @param args - Must contain `planId`, `nodeId`. At least one of `prechecks`, 
 *               `work`, `postchecks` must be provided. Optional `resetToStage`.
 * @param ctx  - Handler context.
 * @returns `{ success, message, ... }`.
 */
export async function handleUpdatePlanNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'nodeId']);
  if (fieldError) return fieldError;

  // Validate at least one stage is provided (use 'in' to allow falsy values like null)
  if (!('prechecks' in args) && !('work' in args) && !('postchecks' in args)) {
    return errorResult('At least one stage update (prechecks, work, postchecks) must be provided');
  }

  // Validate allowedFolders paths exist in any provided stages
  const folderValidation = await validateAllowedFolders(args, 'update_copilot_plan_node');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS in any provided stages
  const urlValidation = await validateAllowedUrls(args, 'update_copilot_plan_node');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names in any provided stages
  const modelValidation = await validateAgentModels(args, 'update_copilot_plan_node');
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }
  
  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) return planResult;
  const plan = planResult;
  
  const nodeResult = lookupNode(plan, args.nodeId);
  if (isError(nodeResult)) return nodeResult;
  const { node } = nodeResult;
  
  if (node.type !== 'job') {
    return errorResult(`Node "${args.nodeId}" is not a job node and cannot be updated`);
  }
  const jobNode = node as JobNode;
  
  // Check if node is currently running or scheduled - cannot update while executing
  const nodeState = plan.nodeStates.get(args.nodeId);
  if (nodeState?.status === 'running' || nodeState?.status === 'scheduled') {
    return errorResult(`Node "${jobNode.name}" is currently ${nodeState.status} and cannot be updated. Wait for it to complete or force-fail it first.`);
  }
  
  // Check if node has already completed successfully - cannot update completed nodes
  if (nodeState?.status === 'succeeded') {
    return errorResult(`Node "${jobNode.name}" has already completed successfully and cannot be updated.`);
  }
  
  // Apply spec updates directly to the node
  if (args.work !== undefined) {
    jobNode.work = normalizeWorkSpec(args.work);
  }
  if (args.prechecks !== undefined) {
    jobNode.prechecks = args.prechecks === null ? undefined : normalizeWorkSpec(args.prechecks);
  }
  if (args.postchecks !== undefined) {
    jobNode.postchecks = args.postchecks === null ? undefined : normalizeWorkSpec(args.postchecks);
  }
  
  // Handle resetToStage: clear step statuses from that stage onward
  if (nodeState) {
    const stageOrder = ['prechecks', 'work', 'postchecks'] as const;
    const resetTo = args.resetToStage || ('work' in args ? 'work' : 'prechecks' in args ? 'prechecks' : 'postchecks');
    const resetIdx = stageOrder.indexOf(resetTo as typeof stageOrder[number]);
    
    if (resetIdx >= 0 && nodeState.stepStatuses) {
      for (let i = resetIdx; i < stageOrder.length; i++) {
        delete nodeState.stepStatuses[stageOrder[i]];
      }
      // Also clear commit/merge-ri since they follow postchecks
      delete nodeState.stepStatuses['commit'];
      delete nodeState.stepStatuses['merge-ri'];
    }
    
    // Set resumeFromPhase so executor knows where to pick up
    nodeState.resumeFromPhase = resetTo as typeof nodeState.resumeFromPhase;
  }
  
  // Resume the Plan if it was stopped (also persists the updated plan)
  await ctx.PlanRunner.resume(args.planId);
  
  return {
    success: true,
    message: `Updated node "${jobNode.name}"`,
    planId: args.planId,
    nodeId: args.nodeId,
    nodeName: jobNode.name,
    hasNewPrechecks: args.prechecks !== undefined,
    hasNewWork: args.work !== undefined,
    hasNewPostchecks: args.postchecks !== undefined,
    resetToStage: args.resetToStage || (args.work ? 'work' : args.prechecks ? 'prechecks' : 'postchecks'),
  };
}
