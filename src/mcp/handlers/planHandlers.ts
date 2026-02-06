/**
 * @fileoverview Plan MCP Tool Handlers
 * 
 * Implements the business logic for all Plan-related MCP tools.
 * 
 * @module mcp/handlers/planHandlers
 */

import { ToolHandlerContext } from '../types';
import { 
  PlanSpec, 
  PlanInstance, 
  JobNodeSpec, 
  SubPlanNodeSpec,
  NodeStatus,
  PlanStatus,
} from '../../plan/types';
import { PlanRunner } from '../../plan/runner';
import { PRODUCER_ID_PATTERN } from '../tools/planTools';
import * as git from '../../git';

/**
 * Extended context with Plan Runner
 */
interface PlanHandlerContext extends ToolHandlerContext {
  PlanRunner: PlanRunner;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Recursively map sub-plans from input to SubPlanNodeSpec
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
 * Validate and transform Plan input
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
    })),
    subPlans: mapsubPlansRecursively(args.subPlans),  // Recursive mapping!
  };
  
  return { valid: true, spec };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Create a Plan
 */
export async function handleCreatePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input
  const validation = validatePlanInput(args);
  if (!validation.valid || !validation.spec) {
    return {
      success: false,
      error: validation.error,
    };
  }
  
  try {
    // Set repo path
    validation.spec.repoPath = ctx.workspacePath;
    const repoPath = ctx.workspacePath;
    
    // Resolve base branch - default to current or 'main'
    const currentBranch = await git.branches.currentOrNull(repoPath);
    const baseBranch = validation.spec.baseBranch || currentBranch || 'main';
    validation.spec.baseBranch = baseBranch;
    
    // Resolve target branch
    // If baseBranch is a default branch (main/master), create a feature branch
    // Never merge work directly back to a default branch
    if (!validation.spec.targetBranch) {
      const { targetBranchRoot, needsCreation } = await git.orchestrator.resolveTargetBranchRoot(
        baseBranch,
        repoPath,
        'copilot_plan'
      );
      validation.spec.targetBranch = targetBranchRoot;
      
      // If a new feature branch is needed, create it
      if (needsCreation) {
        const exists = await git.branches.exists(targetBranchRoot, repoPath);
        if (!exists) {
          await git.branches.create(repoPath, targetBranchRoot, baseBranch);
        }
      }
    }
    
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
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Create a single job (becomes a Plan with one node)
 */
export async function handleCreateJob(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.name) {
    return { success: false, error: 'Job must have a name' };
  }
  
  if (!args.task) {
    return { success: false, error: 'Job must have a task' };
  }
  
  try {
    const repoPath = ctx.workspacePath;
    
    // Resolve base branch
    const currentBranch = await git.branches.currentOrNull(repoPath);
    const baseBranch = args.baseBranch || currentBranch || 'main';
    
    // Resolve target branch - create feature branch if starting from default
    let targetBranch = args.targetBranch;
    if (!targetBranch) {
      const { targetBranchRoot, needsCreation } = await git.orchestrator.resolveTargetBranchRoot(
        baseBranch,
        repoPath,
        'copilot_plan'
      );
      targetBranch = targetBranchRoot;
      
      if (needsCreation) {
        const exists = await git.branches.exists(targetBranch, repoPath);
        if (!exists) {
          await git.branches.create(repoPath, targetBranch, baseBranch);
        }
      }
    }
    
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
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get Plan status
 */
export async function handleGetPlanStatus(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'Plan id is required' };
  }
  
  const status = ctx.PlanRunner.getStatus(args.id);
  if (!status) {
    return { success: false, error: `Plan not found: ${args.id}` };
  }
  
  const { plan, status: planStatus, counts, progress } = status;
  
  // Build node status list
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
  
  // Get effective endedAt from state machine (computed from node data)
  const sm = ctx.PlanRunner.getStateMachine(plan.id);
  const effectiveEndedAt = sm?.getEffectiveEndedAt() || plan.endedAt;
  
  return {
    success: true,
    planId: plan.id,
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
 * List all Plans
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
        endedAt: sm?.getEffectiveEndedAt() || plan.endedAt,
      };
    }),
  };
}

/**
 * Get node details
 */
export async function handleGetNodeDetails(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.planId) {
    return { success: false, error: 'planId is required' };
  }
  
  if (!args.nodeId) {
    return { success: false, error: 'nodeId is required' };
  }
  
  const plan = ctx.PlanRunner.get(args.planId);
  if (!plan) {
    return { success: false, error: `Plan not found: ${args.planId}` };
  }
  
  // Try to find node by ID or producer_id
  let nodeId = args.nodeId;
  if (!plan.nodes.has(nodeId)) {
    // Try by producer_id
    nodeId = plan.producerIdToNodeId.get(args.nodeId) || '';
  }
  
  const node = plan.nodes.get(nodeId);
  const state = plan.nodeStates.get(nodeId);
  
  if (!node || !state) {
    return { success: false, error: `Node not found: ${args.nodeId}` };
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
 * Get node logs
 */
export async function handleGetNodeLogs(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.planId || !args.nodeId) {
    return { success: false, error: 'planId and nodeId are required' };
  }
  
  const plan = ctx.PlanRunner.get(args.planId);
  if (!plan) {
    return { success: false, error: `Plan not found: ${args.planId}` };
  }
  
  const node = plan.nodes.get(args.nodeId);
  if (!node) {
    return { success: false, error: `Node not found: ${args.nodeId}` };
  }
  
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
 * Get node attempts (with optional logs)
 */
export async function handleGetNodeAttempts(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.planId || !args.nodeId) {
    return { success: false, error: 'planId and nodeId are required' };
  }
  
  const plan = ctx.PlanRunner.get(args.planId);
  if (!plan) {
    return { success: false, error: `Plan not found: ${args.planId}` };
  }
  
  const node = plan.nodes.get(args.nodeId);
  if (!node) {
    return { success: false, error: `Node not found: ${args.nodeId}` };
  }
  
  // Get specific attempt or all attempts
  if (args.attemptNumber) {
    const attempt = ctx.PlanRunner.getNodeAttempt(args.planId, args.nodeId, args.attemptNumber);
    if (!attempt) {
      return { success: false, error: `Attempt ${args.attemptNumber} not found` };
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
 * Cancel a Plan
 */
export async function handleCancelPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'Plan id is required' };
  }
  
  const success = ctx.PlanRunner.cancel(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been canceled` 
      : `Failed to cancel Plan ${args.id}`,
  };
}

/**
 * Delete a Plan
 */
export async function handleDeletePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'Plan id is required' };
  }
  
  const success = ctx.PlanRunner.delete(args.id);
  
  return {
    success,
    message: success 
      ? `Plan ${args.id} has been deleted` 
      : `Failed to delete Plan ${args.id}`,
  };
}

/**
 * Retry failed nodes in a Plan
 */
export async function handleRetryPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'Plan id is required' };
  }
  
  const plan = ctx.PlanRunner.getPlan(args.id);
  if (!plan) {
    return { success: false, error: `Plan ${args.id} not found` };
  }
  
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
      success: false, 
      error: 'No failed nodes to retry',
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
 * Get failure context for a failed node
 */
export async function handleGetNodeFailureContext(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.planId) {
    return { success: false, error: 'planId is required' };
  }
  if (!args.nodeId) {
    return { success: false, error: 'nodeId is required' };
  }
  
  const result = ctx.PlanRunner.getNodeFailureContext(args.planId, args.nodeId);
  
  if ('error' in result) {
    return { success: false, error: result.error };
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
 * Retry a specific node in a Plan
 */
export async function handleRetryPlanNode(args: any, ctx: PlanHandlerContext): Promise<any> {
  if (!args.planId) {
    return { success: false, error: 'planId is required' };
  }
  if (!args.nodeId) {
    return { success: false, error: 'nodeId is required' };
  }
  
  const plan = ctx.PlanRunner.getPlan(args.planId);
  if (!plan) {
    return { success: false, error: `Plan ${args.planId} not found` };
  }
  
  const node = plan.nodes.get(args.nodeId);
  if (!node) {
    return { success: false, error: `Node ${args.nodeId} not found in Plan ${args.planId}` };
  }
  
  const state = plan.nodeStates.get(args.nodeId);
  if (!state || state.status !== 'failed') {
    return { 
      success: false, 
      error: `Node ${args.nodeId} is not in failed state (current: ${state?.status || 'unknown'})` 
    };
  }
  
  // Build retry options from args
  const retryOptions = {
    newWork: args.newWork,
    clearWorktree: args.clearWorktree || false,
  };
  
  const result = ctx.PlanRunner.retryNode(args.planId, args.nodeId, retryOptions);
  
  if (!result.success) {
    return { success: false, error: result.error };
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
