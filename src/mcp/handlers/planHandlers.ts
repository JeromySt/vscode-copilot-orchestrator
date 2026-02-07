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
  SubPlanNodeSpec,
} from '../../plan/types';
import { PRODUCER_ID_PATTERN } from '../tools/planTools';
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

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Recursively map raw sub-plan input objects to typed {@link SubPlanNodeSpec} arrays.
 *
 * Transforms the snake_case `producer_id` field from JSON input to the
 * camelCase `producerId` used internally, and recursively processes any
 * nested `subPlans` to support the "out-and-back" pattern.
 *
 * @param subPlans - Raw sub-plan objects from the MCP `create_copilot_plan` tool call.
 * @returns Typed sub-plan specs, or `undefined` if the input is empty/absent.
 */
function mapsubPlansRecursively(subPlans: any[] | undefined): SubPlanNodeSpec[] | undefined {
  if (!subPlans || !Array.isArray(subPlans) || subPlans.length === 0) {
    return undefined;
  }
  
  return subPlans.map((s: any): SubPlanNodeSpec => ({
    producerId: s.producer_id,
    name: s.name || s.producer_id,
    dependencies: s.dependencies || [],
    maxParallel: s.maxParallel,
    jobs: (s.jobs || []).map((j: any): JobNodeSpec => ({
      producerId: j.producer_id,
      name: j.name || j.producer_id,
      task: j.task,
      work: j.work,
      dependencies: j.dependencies || [],
      prechecks: j.prechecks,
      postchecks: j.postchecks,
      instructions: j.instructions,
      expectsNoChanges: j.expects_no_changes,
      group: j.group,
    })),
    subPlans: mapsubPlansRecursively(s.subPlans),  // Recursive!
  }));
}

/**
 * Recursively validate sub-plans with proper scope isolation.
 * 
 * SCOPING RULES:
 * - Each sub-plan has its own isolated scope for producer_ids
 * - Jobs within a sub-plan can only reference other jobs/sub-plans in the same sub-plan
 * - Nested sub-plans have their own isolated scope (producer_ids can repeat at different levels)
 * - A sub-plan's external dependencies (its own dependencies array) reference the PARENT scope
 * 
 * @param subPlans - Array of sub-plans to validate
 * @param siblingProducerIds - Set of producer_ids at this level (for sibling duplicate checking)
 * @param path - Current path for error messages
 * @param errors - Array to add errors to
 */
function validatesubPlansRecursively(
  subPlans: any[] | undefined,
  siblingProducerIds: Set<string>,
  path: string,
  errors: string[]
): void {
  if (!subPlans || !Array.isArray(subPlans)) return;
  
  for (let i = 0; i < subPlans.length; i++) {
    const subPlan = subPlans[i];
    const subPlanPath = path ? `${path} > ${subPlan.producer_id || `subPlan[${i}]`}` : (subPlan.producer_id || `subPlan[${i}]`);
    
    if (!subPlan.producer_id) {
      errors.push(`sub-plan at index ${i}${path ? ` in ${path}` : ''} is missing required 'producer_id' field`);
      continue;
    }
    
    if (!PRODUCER_ID_PATTERN.test(subPlan.producer_id)) {
      errors.push(`sub-plan '${subPlanPath}' has invalid producer_id format`);
      continue;
    }
    
    // Only check for duplicates among siblings at this level
    if (siblingProducerIds.has(subPlan.producer_id)) {
      errors.push(`Duplicate producer_id: '${subPlan.producer_id}' at level ${path || 'root'}`);
      continue;
    }
    siblingProducerIds.add(subPlan.producer_id);
    
    if (!subPlan.jobs || !Array.isArray(subPlan.jobs) || subPlan.jobs.length === 0) {
      errors.push(`sub-plan '${subPlanPath}' must have at least one job`);
    }
    
    if (!Array.isArray(subPlan.dependencies)) {
      errors.push(`sub-plan '${subPlanPath}' must have a 'dependencies' array`);
    }
    
    // =========================================================================
    // INTERNAL SCOPE VALIDATION (jobs and nested sub-plans within this sub-plan)
    // =========================================================================
    
    // Validate jobs within this sub-plan (isolated scope)
    const internalJobIds = new Set<string>();
    for (let j = 0; j < (subPlan.jobs || []).length; j++) {
      const job = subPlan.jobs[j];
      
      if (!job.producer_id) {
        errors.push(`Job at index ${j} in '${subPlanPath}' is missing required 'producer_id' field`);
        continue;
      }
      
      if (!PRODUCER_ID_PATTERN.test(job.producer_id)) {
        errors.push(`Job '${job.producer_id}' in '${subPlanPath}' has invalid producer_id format`);
        continue;
      }
      
      // Check duplicates only within this sub-plan's internal scope
      if (internalJobIds.has(job.producer_id)) {
        errors.push(`Duplicate producer_id '${job.producer_id}' within '${subPlanPath}'`);
        continue;
      }
      internalJobIds.add(job.producer_id);
      
      if (!job.task) {
        errors.push(`Job '${job.producer_id}' in '${subPlanPath}' is missing required 'task' field`);
      }
      
      if (!Array.isArray(job.dependencies)) {
        errors.push(`Job '${job.producer_id}' in '${subPlanPath}' must have a 'dependencies' array`);
      }
    }
    
    // Collect nested sub-plan producer_ids for internal scope
    const internalNestedSubplanIds = new Set<string>();
    if (subPlan.subPlans && Array.isArray(subPlan.subPlans)) {
      for (const nested of subPlan.subPlans) {
        if (nested.producer_id) {
          // Check for duplicates among internal nested sub-plans
          if (internalNestedSubplanIds.has(nested.producer_id) || internalJobIds.has(nested.producer_id)) {
            errors.push(`Duplicate producer_id '${nested.producer_id}' within '${subPlanPath}'`);
          } else {
            internalNestedSubplanIds.add(nested.producer_id);
          }
        }
      }
    }
    
    // Valid references within this sub-plan's internal scope
    const validInternalRefs = new Set([...internalJobIds, ...internalNestedSubplanIds]);
    
    // Validate job dependencies (must reference other internal jobs/sub-plans)
    for (const job of subPlan.jobs || []) {
      if (!Array.isArray(job.dependencies)) continue;
      
      for (const dep of job.dependencies) {
        if (!validInternalRefs.has(dep)) {
          errors.push(
            `Job '${job.producer_id}' in '${subPlanPath}' references unknown dependency '${dep}'. ` +
            `Valid producer_ids in this scope: ${[...validInternalRefs].join(', ') || '(none)'}`
          );
        }
        if (dep === job.producer_id) {
          errors.push(`Job '${job.producer_id}' in '${subPlanPath}' cannot depend on itself`);
        }
      }
    }
    
    // Validate nested sub-plan dependencies (must reference internal jobs/sub-plans)
    if (subPlan.subPlans && Array.isArray(subPlan.subPlans)) {
      for (const nested of subPlan.subPlans) {
        if (!Array.isArray(nested.dependencies)) continue;
        
        for (const dep of nested.dependencies) {
          if (!validInternalRefs.has(dep)) {
            errors.push(
              `sub-plan '${nested.producer_id}' in '${subPlanPath}' references unknown dependency '${dep}'. ` +
              `Valid producer_ids in this scope: ${[...validInternalRefs].join(', ') || '(none)'}`
            );
          }
        }
      }
    }
    
    // Recursively validate nested sub-plans with a FRESH scope
    // Each nested sub-plan has its own isolated internal scope
    validatesubPlansRecursively(subPlan.subPlans, new Set<string>(), subPlanPath, errors);
  }
}

/**
 * Validate and transform raw `create_copilot_plan` input into a {@link PlanSpec}.
 *
 * Performs comprehensive validation:
 * 1. Ensures required fields (`name`, `jobs`) are present.
 * 2. Validates every `producer_id` against {@link PRODUCER_ID_PATTERN}.
 * 3. Checks for duplicate `producer_id` values within each scope.
 * 4. Verifies dependency references resolve to known sibling producer IDs.
 * 5. Detects self-referential dependencies.
 * 6. Recursively validates nested sub-plans with isolated scopes.
 *
 * @param args - Raw arguments from the `tools/call` request.
 * @returns `{ valid: true, spec }` on success, or `{ valid: false, error }` on failure.
 *
 * @example
 * ```ts
 * const result = validatePlanInput({
 *   name: 'My Plan',
 *   jobs: [{ producer_id: 'build', task: 'Build app', dependencies: [] }],
 * });
 * if (result.valid) {
 *   // result.spec is a PlanSpec ready for PlanRunner.enqueue()
 * }
 * ```
 */
function validatePlanInput(args: any): { valid: boolean; error?: string; spec?: PlanSpec } {
  // Name is required
  if (!args.name || typeof args.name !== 'string') {
    return { valid: false, error: 'Plan must have a name' };
  }
  
  // Jobs array is required
  if (!args.jobs || !Array.isArray(args.jobs) || args.jobs.length === 0) {
    return { valid: false, error: 'Plan must have at least one job in the jobs array' };
  }
  
  // Collect all producer_ids for reference validation at root level
  const allProducerIds = new Set<string>();
  const errors: string[] = [];
  
  // Validate each job at root level
  for (let i = 0; i < args.jobs.length; i++) {
    const job = args.jobs[i];
    
    // producer_id is required
    if (!job.producer_id) {
      errors.push(`Job at index ${i} is missing required 'producer_id' field`);
      continue;
    }
    
    // Validate producer_id format
    if (!PRODUCER_ID_PATTERN.test(job.producer_id)) {
      errors.push(
        `Job '${job.producer_id}' has invalid producer_id format. ` +
        `Must be 3-64 characters, lowercase letters, numbers, and hyphens only.`
      );
      continue;
    }
    
    // Check for duplicates
    if (allProducerIds.has(job.producer_id)) {
      errors.push(`Duplicate producer_id: '${job.producer_id}'`);
      continue;
    }
    allProducerIds.add(job.producer_id);
    
    // task is required
    if (!job.task) {
      errors.push(`Job '${job.producer_id}' is missing required 'task' field`);
    }
    
    // dependencies must be an array
    if (!Array.isArray(job.dependencies)) {
      errors.push(`Job '${job.producer_id}' must have a 'dependencies' array (use [] for root jobs)`);
    }
  }
  
  // Validate sub-plans recursively (they have their own internal scope)
  // Also collect root-level sub-plan producer_ids
  if (args.subPlans && Array.isArray(args.subPlans)) {
    for (const subPlan of args.subPlans) {
      if (subPlan.producer_id) {
        if (allProducerIds.has(subPlan.producer_id)) {
          errors.push(`Duplicate producer_id: '${subPlan.producer_id}'`);
        } else {
          allProducerIds.add(subPlan.producer_id);
        }
      }
    }
    
    // Validate sub-plans structure recursively
    validatesubPlansRecursively(args.subPlans, new Set<string>(), '', errors);
  }
  
  // Validate root-level job dependency references
  for (const job of args.jobs) {
    if (!Array.isArray(job.dependencies)) continue;
    
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
  
  // Validate root-level sub-plan dependency references
  if (args.subPlans) {
    for (const subPlan of args.subPlans) {
      if (!Array.isArray(subPlan.dependencies)) continue;
      
      for (const dep of subPlan.dependencies) {
        if (!allProducerIds.has(dep)) {
          errors.push(
            `sub-plan '${subPlan.producer_id}' references unknown dependency '${dep}'`
          );
        }
      }
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  
  // Transform to PlanSpec using recursive mapping
  const spec: PlanSpec = {
    name: args.name,
    baseBranch: args.baseBranch,
    targetBranch: args.targetBranch,
    maxParallel: args.maxParallel,
    cleanUpSuccessfulWork: args.cleanUpSuccessfulWork,
    jobs: args.jobs.map((j: any): JobNodeSpec => ({
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
    })),
    subPlans: mapsubPlansRecursively(args.subPlans),  // Recursive mapping!
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
  
  try {
    validation.spec.repoPath = ctx.workspacePath;
    const repoPath = ctx.workspacePath;
    
    const baseBranch = await resolveBaseBranch(repoPath, validation.spec.baseBranch);
    validation.spec.baseBranch = baseBranch;
    
    validation.spec.targetBranch = await resolveTargetBranch(
      baseBranch, repoPath, validation.spec.targetBranch
    );
    
    // Create the Plan
    const plan = ctx.PlanRunner.enqueue(validation.spec);
    
    // Build node mapping for response
    const nodeMapping: Record<string, string> = {};
    for (const [producerId, nodeId] of plan.producerIdToNodeId) {
      nodeMapping[producerId] = nodeId;
    }
    
    return {
      success: true,
      planId: plan.id,
      name: plan.spec.name,
      baseBranch: plan.baseBranch,
      targetBranch: plan.targetBranch,
      message: `Plan '${plan.spec.name}' created with ${plan.nodes.size} nodes. ` +
               `Base: ${plan.baseBranch}, Target: ${plan.targetBranch}. ` +
               `Use planId '${plan.id}' to monitor progress.`,
      nodeMapping,
      status: {
        status: 'pending',
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
  
  try {
    const repoPath = ctx.workspacePath;
    const baseBranch = await resolveBaseBranch(repoPath, args.baseBranch);
    const targetBranch = await resolveTargetBranch(baseBranch, repoPath, args.targetBranch);
    
    const plan = ctx.PlanRunner.enqueueJob({
      name: args.name,
      task: args.task,
      work: args.work,
      prechecks: args.prechecks,
      postchecks: args.postchecks,
      instructions: args.instructions,
      baseBranch,
      targetBranch,
    });
    
    // Get the single node ID
    const nodeId = plan.roots[0];
    
    return {
      success: true,
      planId: plan.id,
      nodeId,
      baseBranch: plan.baseBranch,
      targetBranch: plan.targetBranch,
      message: `Job '${args.name}' created. Base: ${plan.baseBranch}, Target: ${plan.targetBranch}. Use planId '${plan.id}' to monitor progress.`,
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
    workSummary: plan.workSummary,
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
    clearWorktree: args.clearWorktree || false,
  };
  
  // Retry the failed nodes using the PlanRunner method
  const retriedNodes: Array<{ id: string; name: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  
  for (const nodeId of nodeIdsToRetry) {
    const result = ctx.PlanRunner.retryNode(args.id, nodeId, retryOptions);
    const node = plan.nodes.get(nodeId);
    
    if (result.success) {
      retriedNodes.push({ id: nodeId, name: node?.name || nodeId });
    } else {
      errors.push({ id: nodeId, error: result.error || 'Unknown error' });
    }
  }
  
  // Resume the Plan if it was stopped
  ctx.PlanRunner.resume(args.id);
  
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
  const retryOptions = {    newWork: args.newWork,
    clearWorktree: args.clearWorktree || false,
  };
  
  const result = ctx.PlanRunner.retryNode(args.planId, args.nodeId, retryOptions);
  
  if (!result.success) {
    return errorResult(result.error || 'Retry failed');
  }
  
  // Resume the Plan if it was stopped
  ctx.PlanRunner.resume(args.planId);
  
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
