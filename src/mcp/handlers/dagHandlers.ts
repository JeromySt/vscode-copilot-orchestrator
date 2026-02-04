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
  
  // Collect all producer_ids for reference validation
  const allProducerIds = new Set<string>();
  const errors: string[] = [];
  
  // Validate each job
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
  
  // Validate sub-DAGs if present
  if (args.subDags && Array.isArray(args.subDags)) {
    for (let i = 0; i < args.subDags.length; i++) {
      const subDag = args.subDags[i];
      
      if (!subDag.producer_id) {
        errors.push(`Sub-DAG at index ${i} is missing required 'producer_id' field`);
        continue;
      }
      
      if (!PRODUCER_ID_PATTERN.test(subDag.producer_id)) {
        errors.push(`Sub-DAG '${subDag.producer_id}' has invalid producer_id format`);
        continue;
      }
      
      if (allProducerIds.has(subDag.producer_id)) {
        errors.push(`Duplicate producer_id: '${subDag.producer_id}'`);
        continue;
      }
      allProducerIds.add(subDag.producer_id);
      
      if (!subDag.jobs || !Array.isArray(subDag.jobs) || subDag.jobs.length === 0) {
        errors.push(`Sub-DAG '${subDag.producer_id}' must have at least one job`);
      }
      
      if (!Array.isArray(subDag.dependencies)) {
        errors.push(`Sub-DAG '${subDag.producer_id}' must have a 'dependencies' array`);
      }
    }
  }
  
  // Validate all dependency references
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
  
  // Transform to DagSpec
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
    subDags: args.subDags?.map((s: any): SubDagNodeSpec => ({
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
    })),
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
      message: `DAG '${dag.spec.name}' created with ${dag.nodes.size} nodes. ` +
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
    const dag = ctx.dagRunner.enqueueJob({
      name: args.name,
      task: args.task,
      work: args.work,
      prechecks: args.prechecks,
      postchecks: args.postchecks,
      instructions: args.instructions,
      baseBranch: args.baseBranch,
      targetBranch: args.targetBranch,
    });
    
    // Get the single node ID
    const nodeId = dag.roots[0];
    
    return {
      success: true,
      dagId: dag.id,
      nodeId,
      message: `Job '${args.name}' created. Use dagId '${dag.id}' to monitor progress.`,
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
  
  // For now, return a placeholder - actual logs come from executor
  return {
    success: true,
    message: 'Log retrieval not yet implemented in new DAG system',
    dagId: args.dagId,
    nodeId: args.nodeId,
    phase: args.phase || 'all',
    logs: [],
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
