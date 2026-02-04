/**
 * @fileoverview DAG Builder
 * 
 * Builds an immutable DAG topology from a DagSpec.
 * Handles:
 * - Assigning UUIDs to nodes
 * - Resolving producerId references to node IDs
 * - Computing dependents (reverse edges)
 * - Identifying roots and leaves
 * - Validating the DAG (no cycles, valid references)
 * 
 * @module dag/builder
 */

import { v4 as uuidv4 } from 'uuid';
import {
  DagSpec,
  DagInstance,
  DagNode,
  JobNode,
  SubDagNode,
  JobNodeSpec,
  SubDagNodeSpec,
  NodeExecutionState,
} from './types';

/**
 * Validation error for DAG building
 */
export class DagValidationError extends Error {
  constructor(message: string, public details?: string[]) {
    super(message);
    this.name = 'DagValidationError';
  }
}

/**
 * Build a DagInstance from a DagSpec.
 * 
 * @param spec - The DAG specification
 * @param options - Optional build options
 * @returns A fully constructed DagInstance
 * @throws DagValidationError if the spec is invalid
 */
export function buildDag(
  spec: DagSpec,
  options: {
    parentDagId?: string;
    parentNodeId?: string;
    repoPath?: string;
    worktreeRoot?: string;
  } = {}
): DagInstance {
  const dagId = uuidv4();
  const errors: string[] = [];
  
  // Maps for building the DAG
  const nodes = new Map<string, DagNode>();
  const producerIdToNodeId = new Map<string, string>();
  
  // First pass: Create all nodes and build producerId map
  for (const jobSpec of spec.jobs) {
    if (!jobSpec.producerId) {
      errors.push(`Job is missing required 'producerId' field`);
      continue;
    }
    
    if (producerIdToNodeId.has(jobSpec.producerId)) {
      errors.push(`Duplicate producerId: '${jobSpec.producerId}'`);
      continue;
    }
    
    const nodeId = uuidv4();
    const node: JobNode = {
      id: nodeId,
      producerId: jobSpec.producerId,
      name: jobSpec.name || jobSpec.producerId,
      type: 'job',
      task: jobSpec.task,
      work: jobSpec.work,
      prechecks: jobSpec.prechecks,
      postchecks: jobSpec.postchecks,
      instructions: jobSpec.instructions,
      baseBranch: jobSpec.baseBranch,
      dependencies: [], // Will be resolved in second pass
      dependents: [],
    };
    
    nodes.set(nodeId, node);
    producerIdToNodeId.set(jobSpec.producerId, nodeId);
  }
  
  // Process sub-DAGs
  for (const subDagSpec of spec.subDags || []) {
    if (!subDagSpec.producerId) {
      errors.push(`Sub-DAG is missing required 'producerId' field`);
      continue;
    }
    
    if (producerIdToNodeId.has(subDagSpec.producerId)) {
      errors.push(`Duplicate producerId: '${subDagSpec.producerId}'`);
      continue;
    }
    
    const nodeId = uuidv4();
    
    // Build the child DagSpec from the SubDagNodeSpec
    const childSpec: DagSpec = {
      name: subDagSpec.name || subDagSpec.producerId,
      jobs: subDagSpec.jobs,
      subDags: subDagSpec.subDags,
      maxParallel: subDagSpec.maxParallel,
      baseBranch: spec.baseBranch,
      targetBranch: undefined, // Sub-DAGs don't have their own target branch
      cleanUpSuccessfulWork: spec.cleanUpSuccessfulWork,
    };
    
    const node: SubDagNode = {
      id: nodeId,
      producerId: subDagSpec.producerId,
      name: subDagSpec.name || subDagSpec.producerId,
      type: 'subdag',
      childSpec,
      maxParallel: subDagSpec.maxParallel,
      dependencies: [], // Will be resolved in second pass
      dependents: [],
    };
    
    nodes.set(nodeId, node);
    producerIdToNodeId.set(subDagSpec.producerId, nodeId);
  }
  
  // Second pass: Resolve dependencies (producerId -> nodeId)
  const allSpecs = [
    ...spec.jobs.map(j => ({ producerId: j.producerId, dependencies: j.dependencies })),
    ...(spec.subDags || []).map(s => ({ producerId: s.producerId, dependencies: s.dependencies })),
  ];
  
  for (const nodeSpec of allSpecs) {
    const nodeId = producerIdToNodeId.get(nodeSpec.producerId);
    if (!nodeId) continue;
    
    const node = nodes.get(nodeId);
    if (!node) continue;
    
    const resolvedDeps: string[] = [];
    for (const depProducerId of nodeSpec.dependencies) {
      const depNodeId = producerIdToNodeId.get(depProducerId);
      if (!depNodeId) {
        errors.push(`Node '${nodeSpec.producerId}' references unknown dependency '${depProducerId}'`);
        continue;
      }
      resolvedDeps.push(depNodeId);
    }
    
    node.dependencies = resolvedDeps;
  }
  
  // Third pass: Compute dependents (reverse edges)
  for (const node of nodes.values()) {
    for (const depId of node.dependencies) {
      const depNode = nodes.get(depId);
      if (depNode) {
        depNode.dependents.push(node.id);
      }
    }
  }
  
  // Identify roots (no dependencies) and leaves (no dependents)
  const roots: string[] = [];
  const leaves: string[] = [];
  
  for (const node of nodes.values()) {
    if (node.dependencies.length === 0) {
      roots.push(node.id);
    }
    if (node.dependents.length === 0) {
      leaves.push(node.id);
    }
  }
  
  // Validate: Check for cycles
  const cycleError = detectCycles(nodes);
  if (cycleError) {
    errors.push(cycleError);
  }
  
  // Validate: Must have at least one node
  if (nodes.size === 0) {
    errors.push('DAG must have at least one node');
  }
  
  // Validate: Must have at least one root
  if (roots.length === 0 && nodes.size > 0) {
    errors.push('DAG has no root nodes (all nodes have dependencies) - this indicates a cycle');
  }
  
  // Throw if there are errors
  if (errors.length > 0) {
    throw new DagValidationError('Invalid DAG specification', errors);
  }
  
  // Build initial node states
  const nodeStates = new Map<string, NodeExecutionState>();
  for (const node of nodes.values()) {
    const initialStatus = node.dependencies.length === 0 ? 'ready' : 'pending';
    nodeStates.set(node.id, {
      status: initialStatus,
      attempts: 0,
    });
  }
  
  // Determine worktree root
  const repoPath = options.repoPath || spec.repoPath || process.cwd();
  const worktreeRoot = options.worktreeRoot || `${repoPath}/.worktrees/${dagId.slice(0, 8)}`;
  
  return {
    id: dagId,
    spec,
    nodes,
    producerIdToNodeId,
    roots,
    leaves,
    nodeStates,
    parentDagId: options.parentDagId,
    parentNodeId: options.parentNodeId,
    repoPath,
    baseBranch: spec.baseBranch || 'main',
    targetBranch: spec.targetBranch,
    worktreeRoot,
    createdAt: Date.now(),
    cleanUpSuccessfulWork: spec.cleanUpSuccessfulWork !== false,
    maxParallel: spec.maxParallel || 4,
  };
}

/**
 * Detect cycles in the DAG using DFS.
 * Returns an error message if a cycle is found, null otherwise.
 */
function detectCycles(nodes: Map<string, DagNode>): string | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  
  function dfs(nodeId: string): string | null {
    if (visiting.has(nodeId)) {
      // Found a cycle - build the cycle path
      const cycleStart = path.indexOf(nodeId);
      const cyclePath = path.slice(cycleStart).map(id => {
        const node = nodes.get(id);
        return node?.producerId || id;
      });
      cyclePath.push(nodes.get(nodeId)?.producerId || nodeId);
      return `Circular dependency detected: ${cyclePath.join(' -> ')}`;
    }
    
    if (visited.has(nodeId)) {
      return null;
    }
    
    visiting.add(nodeId);
    path.push(nodeId);
    
    const node = nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        const error = dfs(depId);
        if (error) return error;
      }
    }
    
    visiting.delete(nodeId);
    path.pop();
    visited.add(nodeId);
    
    return null;
  }
  
  for (const nodeId of nodes.keys()) {
    const error = dfs(nodeId);
    if (error) return error;
  }
  
  return null;
}

/**
 * Create a simple single-job DAG from minimal input.
 * Convenience function for creating a DAG with just one job.
 */
export function buildSingleJobDag(
  jobSpec: {
    name: string;
    task: string;
    work?: string;
    prechecks?: string;
    postchecks?: string;
    instructions?: string;
    baseBranch?: string;
    targetBranch?: string;
    repoPath?: string;
  },
  options?: {
    repoPath?: string;
    worktreeRoot?: string;
  }
): DagInstance {
  const producerId = jobSpec.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
  
  const spec: DagSpec = {
    name: jobSpec.name,
    baseBranch: jobSpec.baseBranch,
    targetBranch: jobSpec.targetBranch,
    repoPath: jobSpec.repoPath,
    jobs: [{
      producerId,
      name: jobSpec.name,
      task: jobSpec.task,
      work: jobSpec.work,
      prechecks: jobSpec.prechecks,
      postchecks: jobSpec.postchecks,
      instructions: jobSpec.instructions,
      dependencies: [],
    }],
  };
  
  return buildDag(spec, options);
}
