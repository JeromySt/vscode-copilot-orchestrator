/**
 * @fileoverview DAG MCP Tool Handlers
 * 
 * Implements the business logic for all DAG-related MCP tools.
 * 
 * @module mcp/handlers/dagHandlers
 */

import { ToolHandlerContext } from '../types';
import { 
  DagSpec, 
  DagInstance, 
  JobNodeSpec, 
  SubDagNodeSpec,
  NodeStatus,
  DagStatus,
} from '../../dag/types';
import { DagRunner } from '../../dag/runner';
import { PRODUCER_ID_PATTERN } from '../tools/dagTools';
import * as git from '../../git';

/**
 * Extended context with DAG runner
 */
interface DagHandlerContext extends ToolHandlerContext {
  dagRunner: DagRunner;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Recursively map sub-DAGs from input to SubDagNodeSpec
 */
function mapSubDagsRecursively(subDags: any[] | undefined): SubDagNodeSpec[] | undefined {
  if (!subDags || !Array.isArray(subDags) || subDags.length === 0) {
    return undefined;
  }
  
  return subDags.map((s: any): SubDagNodeSpec => ({
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
    subDags: mapSubDagsRecursively(s.subDags),  // Recursive!
  }));
}

/**
 * Recursively validate sub-DAGs with proper scope isolation.
 * 
 * SCOPING RULES:
 * - Each sub-DAG has its own isolated scope for producer_ids
 * - Jobs within a sub-DAG can only reference other jobs/sub-DAGs in the same sub-DAG
 * - Nested sub-DAGs have their own isolated scope (producer_ids can repeat at different levels)
 * - A sub-DAG's external dependencies (its own dependencies array) reference the PARENT scope
 * 
 * @param subDags - Array of sub-DAGs to validate
 * @param siblingProducerIds - Set of producer_ids at this level (for sibling duplicate checking)
 * @param path - Current path for error messages
 * @param errors - Array to add errors to
 */
function validateSubDagsRecursively(
  subDags: any[] | undefined,
  siblingProducerIds: Set<string>,
  path: string,
  errors: string[]
): void {
  if (!subDags || !Array.isArray(subDags)) return;
  
  for (let i = 0; i < subDags.length; i++) {
    const subDag = subDags[i];
    const subDagPath = path ? `${path} > ${subDag.producer_id || `subDag[${i}]`}` : (subDag.producer_id || `subDag[${i}]`);
    
    if (!subDag.producer_id) {
      errors.push(`Sub-DAG at index ${i}${path ? ` in ${path}` : ''} is missing required 'producer_id' field`);
      continue;
    }
    
    if (!PRODUCER_ID_PATTERN.test(subDag.producer_id)) {
      errors.push(`Sub-DAG '${subDagPath}' has invalid producer_id format`);
      continue;
    }
    
    // Only check for duplicates among siblings at this level
    if (siblingProducerIds.has(subDag.producer_id)) {
      errors.push(`Duplicate producer_id: '${subDag.producer_id}' at level ${path || 'root'}`);
      continue;
    }
    siblingProducerIds.add(subDag.producer_id);
    
    if (!subDag.jobs || !Array.isArray(subDag.jobs) || subDag.jobs.length === 0) {
      errors.push(`Sub-DAG '${subDagPath}' must have at least one job`);
    }
    
    if (!Array.isArray(subDag.dependencies)) {
      errors.push(`Sub-DAG '${subDagPath}' must have a 'dependencies' array`);
    }
    
    // =========================================================================
    // INTERNAL SCOPE VALIDATION (jobs and nested sub-DAGs within this sub-DAG)
    // =========================================================================
    
    // Validate jobs within this sub-DAG (isolated scope)
    const internalJobIds = new Set<string>();
    for (let j = 0; j < (subDag.jobs || []).length; j++) {
      const job = subDag.jobs[j];
      
      if (!job.producer_id) {
        errors.push(`Job at index ${j} in '${subDagPath}' is missing required 'producer_id' field`);
        continue;
      }
      
      if (!PRODUCER_ID_PATTERN.test(job.producer_id)) {
        errors.push(`Job '${job.producer_id}' in '${subDagPath}' has invalid producer_id format`);
        continue;
      }
      
      // Check duplicates only within this sub-DAG's internal scope
      if (internalJobIds.has(job.producer_id)) {
        errors.push(`Duplicate producer_id '${job.producer_id}' within '${subDagPath}'`);
        continue;
      }
      internalJobIds.add(job.producer_id);
      
      if (!job.task) {
        errors.push(`Job '${job.producer_id}' in '${subDagPath}' is missing required 'task' field`);
      }
      
      if (!Array.isArray(job.dependencies)) {
        errors.push(`Job '${job.producer_id}' in '${subDagPath}' must have a 'dependencies' array`);
      }
    }
    
    // Collect nested sub-DAG producer_ids for internal scope
    const internalNestedSubDagIds = new Set<string>();
    if (subDag.subDags && Array.isArray(subDag.subDags)) {
      for (const nested of subDag.subDags) {
        if (nested.producer_id) {
          // Check for duplicates among internal nested sub-DAGs
          if (internalNestedSubDagIds.has(nested.producer_id) || internalJobIds.has(nested.producer_id)) {
            errors.push(`Duplicate producer_id '${nested.producer_id}' within '${subDagPath}'`);
          } else {
            internalNestedSubDagIds.add(nested.producer_id);
          }
        }
      }
    }
    
    // Valid references within this sub-DAG's internal scope
    const validInternalRefs = new Set([...internalJobIds, ...internalNestedSubDagIds]);
    
    // Validate job dependencies (must reference other internal jobs/sub-DAGs)
    for (const job of subDag.jobs || []) {
      if (!Array.isArray(job.dependencies)) continue;
      
      for (const dep of job.dependencies) {
        if (!validInternalRefs.has(dep)) {
          errors.push(
            `Job '${job.producer_id}' in '${subDagPath}' references unknown dependency '${dep}'. ` +
            `Valid producer_ids in this scope: ${[...validInternalRefs].join(', ') || '(none)'}`
          );
        }
        if (dep === job.producer_id) {
          errors.push(`Job '${job.producer_id}' in '${subDagPath}' cannot depend on itself`);
        }
      }
    }
    
    // Validate nested sub-DAG dependencies (must reference internal jobs/sub-DAGs)
    if (subDag.subDags && Array.isArray(subDag.subDags)) {
      for (const nested of subDag.subDags) {
        if (!Array.isArray(nested.dependencies)) continue;
        
        for (const dep of nested.dependencies) {
          if (!validInternalRefs.has(dep)) {
            errors.push(
              `Sub-DAG '${nested.producer_id}' in '${subDagPath}' references unknown dependency '${dep}'. ` +
              `Valid producer_ids in this scope: ${[...validInternalRefs].join(', ') || '(none)'}`
            );
          }
        }
      }
    }
    
    // Recursively validate nested sub-DAGs with a FRESH scope
    // Each nested sub-DAG has its own isolated internal scope
    validateSubDagsRecursively(subDag.subDags, new Set<string>(), subDagPath, errors);
  }
}

/**
 * Validate and transform DAG input
 */
function validateDagInput(args: any): { valid: boolean; error?: string; spec?: DagSpec } {
  // Name is required
  if (!args.name || typeof args.name !== 'string') {
    return { valid: false, error: 'DAG must have a name' };
  }
  
  // Jobs array is required
  if (!args.jobs || !Array.isArray(args.jobs) || args.jobs.length === 0) {
    return { valid: false, error: 'DAG must have at least one job in the jobs array' };
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
  
  // Validate sub-DAGs recursively (they have their own internal scope)
  // Also collect root-level sub-DAG producer_ids
  if (args.subDags && Array.isArray(args.subDags)) {
    for (const subDag of args.subDags) {
      if (subDag.producer_id) {
        if (allProducerIds.has(subDag.producer_id)) {
          errors.push(`Duplicate producer_id: '${subDag.producer_id}'`);
        } else {
          allProducerIds.add(subDag.producer_id);
        }
      }
    }
    
    // Validate sub-DAGs structure recursively
    validateSubDagsRecursively(args.subDags, new Set<string>(), '', errors);
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
  
  // Validate root-level sub-DAG dependency references
  if (args.subDags) {
    for (const subDag of args.subDags) {
      if (!Array.isArray(subDag.dependencies)) continue;
      
      for (const dep of subDag.dependencies) {
        if (!allProducerIds.has(dep)) {
          errors.push(
            `Sub-DAG '${subDag.producer_id}' references unknown dependency '${dep}'`
          );
        }
      }
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  
  // Transform to DagSpec using recursive mapping
  const spec: DagSpec = {
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
    subDags: mapSubDagsRecursively(args.subDags),  // Recursive mapping!
  };
  
  return { valid: true, spec };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Create a DAG
 */
export async function handleCreateDag(args: any, ctx: DagHandlerContext): Promise<any> {
  // Validate input
  const validation = validateDagInput(args);
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
        'copilot_dag'
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
    
    // Create the DAG
    const dag = ctx.dagRunner.enqueue(validation.spec);
    
    // Build node mapping for response
    const nodeMapping: Record<string, string> = {};
    for (const [producerId, nodeId] of dag.producerIdToNodeId) {
      nodeMapping[producerId] = nodeId;
    }
    
    return {
      success: true,
      dagId: dag.id,
      name: dag.spec.name,
      baseBranch: dag.baseBranch,
      targetBranch: dag.targetBranch,
      message: `DAG '${dag.spec.name}' created with ${dag.nodes.size} nodes. ` +
               `Base: ${dag.baseBranch}, Target: ${dag.targetBranch}. ` +
               `Use dagId '${dag.id}' to monitor progress.`,
      nodeMapping,
      status: {
        status: 'pending',
        nodes: dag.nodes.size,
        roots: dag.roots.length,
        leaves: dag.leaves.length,
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
 * Create a single job (becomes a DAG with one node)
 */
export async function handleCreateJob(args: any, ctx: DagHandlerContext): Promise<any> {
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
        'copilot_dag'
      );
      targetBranch = targetBranchRoot;
      
      if (needsCreation) {
        const exists = await git.branches.exists(targetBranch, repoPath);
        if (!exists) {
          await git.branches.create(repoPath, targetBranch, baseBranch);
        }
      }
    }
    
    const dag = ctx.dagRunner.enqueueJob({
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
    const nodeId = dag.roots[0];
    
    return {
      success: true,
      dagId: dag.id,
      nodeId,
      baseBranch: dag.baseBranch,
      targetBranch: dag.targetBranch,
      message: `Job '${args.name}' created. Base: ${dag.baseBranch}, Target: ${dag.targetBranch}. Use dagId '${dag.id}' to monitor progress.`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get DAG status
 */
export async function handleGetDagStatus(args: any, ctx: DagHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'DAG id is required' };
  }
  
  const status = ctx.dagRunner.getStatus(args.id);
  if (!status) {
    return { success: false, error: `DAG not found: ${args.id}` };
  }
  
  const { dag, status: dagStatus, counts, progress } = status;
  
  // Build node status list
  const nodes: any[] = [];
  for (const [nodeId, state] of dag.nodeStates) {
    const node = dag.nodes.get(nodeId);
    const isLeaf = dag.leaves.includes(nodeId);
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
  
  return {
    success: true,
    dagId: dag.id,
    name: dag.spec.name,
    status: dagStatus,
    progress: Math.round(progress * 100),
    counts,
    nodes,
    createdAt: dag.createdAt,
    startedAt: dag.startedAt,
    endedAt: dag.endedAt,
    workSummary: dag.workSummary,
  };
}

/**
 * List all DAGs
 */
export async function handleListDags(args: any, ctx: DagHandlerContext): Promise<any> {
  let dags = ctx.dagRunner.getAll();
  
  // Filter by status if specified
  if (args.status) {
    dags = dags.filter(dag => {
      const sm = ctx.dagRunner.getStateMachine(dag.id);
      return sm?.computeDagStatus() === args.status;
    });
  }
  
  // Sort by creation time (newest first)
  dags.sort((a, b) => b.createdAt - a.createdAt);
  
  return {
    success: true,
    count: dags.length,
    dags: dags.map(dag => {
      const sm = ctx.dagRunner.getStateMachine(dag.id);
      const counts = sm?.getStatusCounts();
      
      return {
        id: dag.id,
        name: dag.spec.name,
        status: sm?.computeDagStatus() || 'unknown',
        nodes: dag.nodes.size,
        counts,
        createdAt: dag.createdAt,
        startedAt: dag.startedAt,
        endedAt: dag.endedAt,
      };
    }),
  };
}

/**
 * Get node details
 */
export async function handleGetNodeDetails(args: any, ctx: DagHandlerContext): Promise<any> {
  if (!args.dagId) {
    return { success: false, error: 'dagId is required' };
  }
  
  if (!args.nodeId) {
    return { success: false, error: 'nodeId is required' };
  }
  
  const dag = ctx.dagRunner.get(args.dagId);
  if (!dag) {
    return { success: false, error: `DAG not found: ${args.dagId}` };
  }
  
  // Try to find node by ID or producer_id
  let nodeId = args.nodeId;
  if (!dag.nodes.has(nodeId)) {
    // Try by producer_id
    nodeId = dag.producerIdToNodeId.get(args.nodeId) || '';
  }
  
  const node = dag.nodes.get(nodeId);
  const state = dag.nodeStates.get(nodeId);
  
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
        const depNode = dag.nodes.get(depId);
        return { id: depId, producerId: depNode?.producerId, name: depNode?.name };
      }),
      dependents: node.dependents.map(depId => {
        const depNode = dag.nodes.get(depId);
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
      mergedToTarget: dag.leaves.includes(nodeId) ? state.mergedToTarget : undefined,
      isLeaf: dag.leaves.includes(nodeId),
    },
  };
}

/**
 * Get node logs
 */
export async function handleGetNodeLogs(args: any, ctx: DagHandlerContext): Promise<any> {
  if (!args.dagId || !args.nodeId) {
    return { success: false, error: 'dagId and nodeId are required' };
  }
  
  const dag = ctx.dagRunner.get(args.dagId);
  if (!dag) {
    return { success: false, error: `DAG not found: ${args.dagId}` };
  }
  
  const node = dag.nodes.get(args.nodeId);
  if (!node) {
    return { success: false, error: `Node not found: ${args.nodeId}` };
  }
  
  const phase = args.phase || 'all';
  const logs = ctx.dagRunner.getNodeLogs(args.dagId, args.nodeId, phase);
  
  return {
    success: true,
    dagId: args.dagId,
    nodeId: args.nodeId,
    nodeName: node.name,
    phase,
    logs,
  };
}

/**
 * Cancel a DAG
 */
export async function handleCancelDag(args: any, ctx: DagHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'DAG id is required' };
  }
  
  const success = ctx.dagRunner.cancel(args.id);
  
  return {
    success,
    message: success 
      ? `DAG ${args.id} has been canceled` 
      : `Failed to cancel DAG ${args.id}`,
  };
}

/**
 * Delete a DAG
 */
export async function handleDeleteDag(args: any, ctx: DagHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'DAG id is required' };
  }
  
  const success = ctx.dagRunner.delete(args.id);
  
  return {
    success,
    message: success 
      ? `DAG ${args.id} has been deleted` 
      : `Failed to delete DAG ${args.id}`,
  };
}

/**
 * Retry failed nodes in a DAG
 */
export async function handleRetryDag(args: any, ctx: DagHandlerContext): Promise<any> {
  if (!args.id) {
    return { success: false, error: 'DAG id is required' };
  }
  
  const dag = ctx.dagRunner.getDag(args.id);
  if (!dag) {
    return { success: false, error: `DAG ${args.id} not found` };
  }
  
  // Determine which nodes to retry
  let nodeIdsToRetry: string[] = args.nodeIds || [];
  
  if (nodeIdsToRetry.length === 0) {
    // No specific nodes - retry all failed nodes
    for (const [nodeId, state] of dag.nodeStates) {
      if (state.status === 'failed') {
        nodeIdsToRetry.push(nodeId);
      }
    }
  }
  
  if (nodeIdsToRetry.length === 0) {
    return { 
      success: false, 
      error: 'No failed nodes to retry',
      dagId: args.id,
    };
  }
  
  // Reset the failed nodes
  const retriedNodes: string[] = [];
  for (const nodeId of nodeIdsToRetry) {
    const state = dag.nodeStates.get(nodeId);
    if (state && (state.status === 'failed' || state.status === 'blocked')) {
      // Reset state
      state.status = 'ready';
      state.error = undefined;
      state.startedAt = undefined;
      state.endedAt = undefined;
      // Keep attempts count for tracking
      retriedNodes.push(nodeId);
    }
  }
  
  // Also unblock any nodes that were blocked due to these failures
  for (const [nodeId, state] of dag.nodeStates) {
    if (state.status === 'blocked') {
      const node = dag.nodes.get(nodeId);
      if (node) {
        // Check if all dependencies are now non-failed
        let allDepsOk = true;
        for (const depId of node.dependencies) {
          const depState = dag.nodeStates.get(depId);
          if (depState && depState.status === 'failed') {
            allDepsOk = false;
            break;
          }
        }
        if (allDepsOk) {
          state.status = 'pending';
        }
      }
    }
  }
  
  // Resume the DAG if it was stopped
  ctx.dagRunner.resume(args.id);
  
  return {
    success: true,
    message: `Retrying ${retriedNodes.length} node(s)`,
    dagId: args.id,
    retriedNodes: retriedNodes.map(id => {
      const node = dag.nodes.get(id);
      return { id, name: node?.name || id };
    }),
  };
}
