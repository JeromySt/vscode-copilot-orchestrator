/**
 * @fileoverview Plan Builder
 * 
 * Builds an immutable Plan topology from a PlanSpec.
 * Handles:
 * - Assigning UUIDs to nodes
 * - Resolving producerId references to node IDs
 * - Computing dependents (reverse edges)
 * - Identifying roots and leaves
 * - Validating the Plan (no cycles, valid references)
 * 
 * @module plan/builder
 */

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  PlanSpec,
  PlanInstance,
  PlanNode,
  JobNode,
  SubPlanNode,
  JobNodeSpec,
  SubPlanNodeSpec,
  NodeExecutionState,
} from './types';

/**
 * Validation error thrown when a {@link PlanSpec} is invalid.
 *
 * @example
 * ```typescript
 * try {
 *   buildPlan(spec);
 * } catch (e) {
 *   if (e instanceof PlanValidationError) {
 *     console.error(e.details); // ['Duplicate producerId: "a"', ...]
 *   }
 * }
 * ```
 */
export class PlanValidationError extends Error {
  /**
   * @param message - Summary error message.
   * @param details - Individual validation errors (one per issue).
   */
  constructor(message: string, public details?: string[]) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/**
 * Build a {@link PlanInstance} from a {@link PlanSpec}.
 *
 * Performs three passes:
 * 1. Creates nodes and maps `producerId` → `nodeId`.
 * 2. Resolves dependency references from producer IDs to node UUIDs.
 * 3. Computes reverse edges (dependents), identifies roots/leaves, and
 *    validates the DAG for cycles.
 *
 * Root nodes (no dependencies) start in `'ready'` status; all others start
 * as `'pending'`.
 *
 * @param spec    - The plan specification describing jobs and sub-plans.
 * @param options - Optional overrides for parent plan context, repo path, or worktree root.
 * @returns A fully constructed, validated plan instance.
 * @throws {PlanValidationError} If the spec contains duplicate IDs, unknown references,
 *         cycles, or has no nodes.
 *
 * @example
 * ```typescript
 * const plan = buildPlan({
 *   name: 'My Plan',
 *   baseBranch: 'main',
 *   jobs: [
 *     { producerId: 'a', task: 'Build', dependencies: [] },
 *     { producerId: 'b', task: 'Test', dependencies: ['a'] },
 *   ],
 * });
 * ```
 */
export function buildPlan(
  spec: PlanSpec,
  options: {
    parentPlanId?: string;
    parentNodeId?: string;
    repoPath?: string;
    worktreeRoot?: string;
  } = {}
): PlanInstance {
  const planId = uuidv4();
  const errors: string[] = [];
  
  // Maps for building the Plan
  const nodes = new Map<string, PlanNode>();
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
  
  // Process sub-plans
  for (const subPlanSpec of spec.subPlans || []) {
    if (!subPlanSpec.producerId) {
      errors.push(`sub-plan is missing required 'producerId' field`);
      continue;
    }
    
    if (producerIdToNodeId.has(subPlanSpec.producerId)) {
      errors.push(`Duplicate producerId: '${subPlanSpec.producerId}'`);
      continue;
    }
    
    const nodeId = uuidv4();
    
    // Build the child PlanSpec from the SubPlanNodeSpec
    // Note: targetBranch is set at instantiation time in runner.ts to inherit from parent
    const childSpec: PlanSpec = {
      name: subPlanSpec.name || subPlanSpec.producerId,
      jobs: subPlanSpec.jobs,
      subPlans: subPlanSpec.subPlans,
      maxParallel: subPlanSpec.maxParallel,
      baseBranch: spec.baseBranch,
      targetBranch: spec.targetBranch, // Inherit from parent - leaf jobs merge directly
      cleanUpSuccessfulWork: spec.cleanUpSuccessfulWork,
    };
    
    const node: SubPlanNode = {
      id: nodeId,
      producerId: subPlanSpec.producerId,
      name: subPlanSpec.name || subPlanSpec.producerId,
      type: 'subPlan',
      childSpec,
      maxParallel: subPlanSpec.maxParallel,
      dependencies: [], // Will be resolved in second pass
      dependents: [],
    };
    
    nodes.set(nodeId, node);
    producerIdToNodeId.set(subPlanSpec.producerId, nodeId);
  }
  
  // Second pass: Resolve dependencies (producerId -> nodeId)
  const allSpecs = [
    ...spec.jobs.map(j => ({ producerId: j.producerId, dependencies: j.dependencies })),
    ...(spec.subPlans || []).map(s => ({ producerId: s.producerId, dependencies: s.dependencies })),
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
    errors.push('Plan must have at least one node');
  }
  
  // Validate: Must have at least one root
  if (roots.length === 0 && nodes.size > 0) {
    errors.push('Plan has no root nodes (all nodes have dependencies) - this indicates a cycle');
  }
  
  // Throw if there are errors
  if (errors.length > 0) {
    throw new PlanValidationError('Invalid Plan specification', errors);
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
  const worktreeRoot = options.worktreeRoot || path.join(repoPath, '.worktrees', planId.slice(0, 8));
  
  return {
    id: planId,
    spec,
    nodes,
    producerIdToNodeId,
    roots,
    leaves,
    nodeStates,
    parentPlanId: options.parentPlanId,
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
 * Detect cycles in the dependency DAG using iterative DFS.
 *
 * @param nodes - Map of node ID → node definition.
 * @returns A human-readable error message describing the cycle, or `null` if acyclic.
 */
function detectCycles(nodes: Map<string, PlanNode>): string | null {
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
 * Create a Plan with a single job node from minimal input.
 *
 * Generates a `producerId` from the job name and delegates to {@link buildPlan}.
 *
 * @param jobSpec - Minimal job definition (name, task, optional work/checks/branches).
 * @param options - Optional overrides for repo path and worktree root.
 * @returns A single-node plan instance.
 * @throws {PlanValidationError} If the generated spec is somehow invalid.
 */
export function buildSingleJobPlan(
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
): PlanInstance {
  const producerId = jobSpec.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
  
  const spec: PlanSpec = {
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
  
  return buildPlan(spec, options);
}
