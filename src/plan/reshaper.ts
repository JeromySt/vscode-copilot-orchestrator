import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../core/logger';
import type {
  PlanInstance,
  PlanNode,
  JobNodeSpec,
  NodeExecutionState,
} from './types';

const log = Logger.for('plan');

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AddNodeResult {
  success: boolean;
  nodeId?: string;
  error?: string;
}

export interface MutationResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recompute `plan.roots` and `plan.leaves` from the current topology. */
export function recomputeRootsAndLeaves(plan: PlanInstance): void {
  const roots: string[] = [];
  const leaves: string[] = [];
  for (const node of plan.jobs.values()) {
    if (node.dependencies.length === 0) { roots.push(node.id); }
    if (node.dependents.length === 0) { leaves.push(node.id); }
  }
  plan.roots = roots;
  plan.leaves = leaves;

  // Keep the SV node's dependencies in sync with the current leaf set.
  syncSnapshotValidationDeps(plan);
}

/**
 * Sync the auto-injected snapshot-validation node's dependencies to match
 * the current set of leaf nodes (excluding itself).  Called automatically
 * by `recomputeRootsAndLeaves` after every topology mutation so the SV
 * node always waits for all real work nodes to finish.
 */
function syncSnapshotValidationDeps(plan: PlanInstance): void {
  const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__');
  if (!svNodeId) { return; } // no SV node in this plan

  const svNode = plan.jobs.get(svNodeId);
  if (!svNode) { return; }

  // Desired deps = every node with no dependents, except the SV node itself.
  const desiredDeps = new Set<string>();
  for (const node of plan.jobs.values()) {
    if (node.id !== svNodeId && node.dependents.length === 0) {
      desiredDeps.add(node.id);
    }
  }

  // But wait — nodes whose only dependent is the SV node are the real leaves.
  // After this function wires them, they'll have svNodeId in dependents.
  // So we need: every node whose dependents are empty OR contain only svNodeId.
  desiredDeps.clear();
  for (const node of plan.jobs.values()) {
    if (node.id === svNodeId) { continue; }
    const nonSvDependents = node.dependents.filter(d => d !== svNodeId);
    if (nonSvDependents.length === 0) {
      desiredDeps.add(node.id);
    }
  }

  const currentDeps = new Set(svNode.dependencies);
  if (setsEqual(currentDeps, desiredDeps)) { return; } // no change needed

  // Remove SV from old deps' dependents
  for (const oldDep of svNode.dependencies) {
    if (!desiredDeps.has(oldDep)) {
      const depNode = plan.jobs.get(oldDep);
      if (depNode) {
        depNode.dependents = depNode.dependents.filter(d => d !== svNodeId);
      }
    }
  }

  // Add SV to new deps' dependents
  for (const newDep of desiredDeps) {
    if (!currentDeps.has(newDep)) {
      const depNode = plan.jobs.get(newDep);
      if (depNode && !depNode.dependents.includes(svNodeId)) {
        depNode.dependents.push(svNodeId);
      }
    }
  }

  svNode.dependencies = [...desiredDeps];

  // Recompute SV node's execution state
  recomputeNodeStatus(plan, svNodeId);

  // Update plan.leaves — SV should be the sole leaf
  plan.leaves = [svNodeId];
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) { return false; }
  for (const v of a) { if (!b.has(v)) { return false; } }
  return true;
}

/**
 * Returns true if adding an edge `fromId → toId` would create a cycle.
 * Uses BFS from `toId` following dependencies to see if we can reach `fromId`.
 */
export function hasCycle(plan: PlanInstance, fromId: string, toId: string): boolean {
  // An edge fromId → toId means "fromId depends on toId".
  // A cycle exists if toId can already reach fromId via its own dependencies.
  // Equivalently: walk *dependents* from toId; if we hit fromId, cycle.
  // But actually: fromId depends on toId means toId is upstream of fromId.
  // Cycle if fromId is already upstream of toId (i.e., toId can reach fromId via dependencies).
  const visited = new Set<string>();
  const queue = [toId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === fromId) { return true; }
    if (visited.has(current)) { continue; }
    visited.add(current);
    const node = plan.jobs.get(current);
    if (node) {
      for (const dep of node.dependencies) {
        if (!visited.has(dep)) { queue.push(dep); }
      }
    }
  }
  return false;
}

/** Check whether a plan is in a modifiable state. */
function isPlanModifiable(plan: PlanInstance): boolean {
  if (plan.isPaused) { return true; }
  if (plan.endedAt) { return false; }
  if (plan.startedAt) { return true; }
  // Not yet started — treat as modifiable
  return true;
}

/** States that allow a node to be modified (never ran). */
const MODIFIABLE_STATES = new Set(['pending', 'ready']);

/** Check if a dependency is "available" — either still has a worktree or has a committed result. */
function isDependencyAvailable(plan: PlanInstance, depNodeId: string): boolean {
  const state = plan.nodeStates.get(depNodeId);
  if (!state) { return false; }
  if (state.worktreePath && !state.worktreeCleanedUp) { return true; }
  if (state.completedCommit) { return true; }
  // Pending/ready nodes haven't started yet — they're valid future deps
  if (state.status === 'pending' || state.status === 'ready') { return true; }
  return false;
}

/** Build a PlanNode from a JobNodeSpec and resolved dependency node IDs. */
function buildNodeFromSpec(spec: JobNodeSpec, nodeId: string, resolvedDeps: string[]): PlanNode {
  return {
    id: nodeId,
    producerId: spec.producerId,
    name: spec.name ?? spec.producerId,
    type: 'job',
    task: spec.task,
    dependencies: resolvedDeps,
    dependents: [],
    work: spec.work,
    prechecks: spec.prechecks,
    postchecks: spec.postchecks,
    instructions: spec.instructions,
    baseBranch: spec.baseBranch,
    expectsNoChanges: spec.expectsNoChanges,
    autoHeal: spec.autoHeal,
    group: spec.group,
  };
}

/** Create the initial NodeExecutionState for a new node. */
function makeInitialState(resolvedDeps: string[], plan: PlanInstance): NodeExecutionState {
  const allDepsSatisfied = resolvedDeps.length === 0 || resolvedDeps.every(depId => {
    const s = plan.nodeStates.get(depId);
    return s?.status === 'succeeded';
  });
  return {
    status: allDepsSatisfied ? 'ready' : 'pending',
    version: 0,
    attempts: 0,
  };
}

/**
 * Recompute a node's execution state status after its dependencies change.
 * If all deps are succeeded (or there are none), set to 'ready'; otherwise 'pending'.
 * Only applies to nodes in modifiable (non-terminal) states.
 */
function recomputeNodeStatus(plan: PlanInstance, nodeId: string): void {
  const state = plan.nodeStates.get(nodeId);
  if (!state || !MODIFIABLE_STATES.has(state.status)) {return;}
  const node = plan.jobs.get(nodeId);
  if (!node) {return;}
  const allDepsSatisfied = node.dependencies.length === 0 || node.dependencies.every(depId => {
    const s = plan.nodeStates.get(depId);
    return s?.status === 'succeeded';
  });
  state.status = allDepsSatisfied ? 'ready' : 'pending';
}

/**
 * Add a new node to a running/paused plan.
 * Dependencies in `spec.dependencies` are producer IDs that are resolved to node IDs.
 */
export function addNode(plan: PlanInstance, spec: JobNodeSpec): AddNodeResult {
  if (!isPlanModifiable(plan)) {
    return { success: false, error: 'Plan is not in a modifiable state (must be running or paused)' };
  }

  // Validate producerId uniqueness
  if (plan.producerIdToNodeId.has(spec.producerId)) {
    return { success: false, error: `Producer ID '${spec.producerId}' already exists in plan` };
  }

  // Resolve dependency producer IDs → node IDs
  const resolvedDeps: string[] = [];
  for (const depProducerId of spec.dependencies) {
    const depNodeId = plan.producerIdToNodeId.get(depProducerId);
    if (!depNodeId) {
      return { success: false, error: `Dependency '${depProducerId}' not found in plan` };
    }
    if (!isDependencyAvailable(plan, depNodeId)) {
      return { success: false, error: `Dependency '${depProducerId}' has no available worktree or completed commit` };
    }
    resolvedDeps.push(depNodeId);
  }

  const nodeId = uuidv4();
  const node = buildNodeFromSpec(spec, nodeId, resolvedDeps);

  // Wire into plan
  plan.jobs.set(nodeId, node);
  plan.producerIdToNodeId.set(spec.producerId, nodeId);
  plan.nodeStates.set(nodeId, makeInitialState(resolvedDeps, plan));

  // Update dependents on upstream nodes
  for (const depId of resolvedDeps) {
    const depNode = plan.jobs.get(depId);
    if (depNode) { depNode.dependents.push(nodeId); }
  }

  recomputeRootsAndLeaves(plan);
  plan.stateVersion++;

  log.info('Node added', { planId: plan.id, nodeId, producerId: spec.producerId });
  return { success: true, nodeId };
}

// ---------------------------------------------------------------------------
// removeNode
// ---------------------------------------------------------------------------

/**
 * Remove a pending/ready node from the plan.
 * Fails if any non-pending node depends on it.
 */
export function removeNode(plan: PlanInstance, nodeId: string): MutationResult {
  const node = plan.jobs.get(nodeId);
  if (!node) {
    return { success: false, error: `Node '${nodeId}' not found` };
  }

  const state = plan.nodeStates.get(nodeId);
  if (!state || !MODIFIABLE_STATES.has(state.status)) {
    return { success: false, error: `Node '${nodeId}' is in '${state?.status}' state and cannot be removed` };
  }

  // Validate no non-pending dependents
  for (const depId of node.dependents) {
    const depState = plan.nodeStates.get(depId);
    if (depState && !MODIFIABLE_STATES.has(depState.status)) {
      return { success: false, error: `Cannot remove: dependent node '${depId}' is in '${depState.status}' state` };
    }
  }

  // Remove from dependents lists of upstream nodes, adding downstream nodes to bridge the gap
  for (const depId of node.dependencies) {
    const depNode = plan.jobs.get(depId);
    if (depNode) {
      depNode.dependents = depNode.dependents.filter(id => id !== nodeId);
      for (const downId of node.dependents) {
        if (!depNode.dependents.includes(downId)) {
          depNode.dependents.push(downId);
        }
      }
    }
  }

  // Remove from dependencies lists of downstream nodes, inheriting upstream deps to bridge
  for (const depId of node.dependents) {
    const depNode = plan.jobs.get(depId);
    if (depNode) {
      depNode.dependencies = depNode.dependencies.filter(id => id !== nodeId);
      for (const upId of node.dependencies) {
        if (!depNode.dependencies.includes(upId)) {
          depNode.dependencies.push(upId);
        }
      }
      recomputeNodeStatus(plan, depId);
    }
  }

  // Remove from maps
  plan.jobs.delete(nodeId);
  plan.nodeStates.delete(nodeId);
  if (node.producerId) {
    plan.producerIdToNodeId.delete(node.producerId);
  }

  recomputeRootsAndLeaves(plan);
  plan.stateVersion++;

  log.info('Node removed', { planId: plan.id, nodeId });
  return { success: true };
}

// ---------------------------------------------------------------------------
// updateNodeDependencies
// ---------------------------------------------------------------------------

/**
 * Replace the dependencies of a pending/ready node.
 * `newDeps` are node IDs (not producer IDs).
 */
export function updateNodeDependencies(
  plan: PlanInstance,
  nodeId: string,
  newDeps: string[],
): MutationResult {
  const node = plan.jobs.get(nodeId);
  if (!node) {
    return { success: false, error: `Node '${nodeId}' not found` };
  }

  const state = plan.nodeStates.get(nodeId);
  if (!state || !MODIFIABLE_STATES.has(state.status)) {
    return { success: false, error: `Node '${nodeId}' is in '${state?.status}' state and cannot be modified` };
  }

  // Validate new deps exist, are available, and don't create cycles
  for (const depId of newDeps) {
    if (!plan.jobs.has(depId)) {
      return { success: false, error: `Dependency node '${depId}' not found` };
    }
    if (!isDependencyAvailable(plan, depId)) {
      return { success: false, error: `Dependency '${depId}' has no available worktree or completed commit` };
    }
    // Check if depId can reach nodeId via its dependencies (would form a cycle)
    if (isReachableViaUpstream(plan, depId, nodeId, new Set([nodeId]))) {
      return { success: false, error: `Adding dependency on '${depId}' would create a cycle` };
    }
  }

  // Remove nodeId from old upstream dependents lists
  for (const oldDepId of node.dependencies) {
    const oldDepNode = plan.jobs.get(oldDepId);
    if (oldDepNode) {
      oldDepNode.dependents = oldDepNode.dependents.filter(id => id !== nodeId);
    }
  }

  // Set new dependencies
  node.dependencies = [...newDeps];

  // Add nodeId to new upstream dependents lists
  for (const depId of newDeps) {
    const depNode = plan.jobs.get(depId);
    if (depNode && !depNode.dependents.includes(nodeId)) {
      depNode.dependents.push(nodeId);
    }
  }

  // Re-evaluate node status
  const allDepsSatisfied = newDeps.length === 0 || newDeps.every(depId => {
    const s = plan.nodeStates.get(depId);
    return s?.status === 'succeeded';
  });
  state.status = allDepsSatisfied ? 'ready' : 'pending';

  recomputeRootsAndLeaves(plan);
  plan.stateVersion++;

  log.info('Node dependencies updated', { planId: plan.id, nodeId, newDeps });
  return { success: true };
}

/**
 * Check if `target` is reachable from `start` by walking upstream (dependencies).
 * Used for cycle detection when adding an edge.
 */
function isReachableViaUpstream(
  plan: PlanInstance,
  start: string,
  target: string,
  excluded: Set<string>,
): boolean {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) { return true; }
    if (visited.has(current)) { continue; }
    visited.add(current);
    const node = plan.jobs.get(current);
    if (node) {
      for (const dep of node.dependencies) {
        if (!visited.has(dep) && !excluded.has(dep)) { queue.push(dep); }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// addNodeBefore
// ---------------------------------------------------------------------------

/**
 * Insert a new node as a dependency of an existing pending node.
 * The new node's dependencies come from `spec.dependencies`.
 * The existing node is rewired to depend only on the new node;
 * its previous upstream edges are removed.
 */
export function addNodeBefore(
  plan: PlanInstance,
  existingNodeId: string,
  spec: JobNodeSpec,
): AddNodeResult {
  const existingNode = plan.jobs.get(existingNodeId);
  if (!existingNode) {
    return { success: false, error: `Node '${existingNodeId}' not found` };
  }

  const existingState = plan.nodeStates.get(existingNodeId);
  if (!existingState || !MODIFIABLE_STATES.has(existingState.status)) {
    return { success: false, error: `Node '${existingNodeId}' is in '${existingState?.status}' state and cannot be modified` };
  }

  if (!isPlanModifiable(plan)) {
    return { success: false, error: 'Plan is not in a modifiable state' };
  }

  if (plan.producerIdToNodeId.has(spec.producerId)) {
    return { success: false, error: `Producer ID '${spec.producerId}' already exists in plan` };
  }

  // Resolve the new node's own dependencies from spec
  const resolvedSpecDeps: string[] = [];
  for (const depProducerId of spec.dependencies) {
    const depNodeId = plan.producerIdToNodeId.get(depProducerId);
    if (!depNodeId) {
      return { success: false, error: `Dependency '${depProducerId}' not found in plan` };
    }
    if (!isDependencyAvailable(plan, depNodeId)) {
      return { success: false, error: `Dependency '${depProducerId}' has no available worktree or completed commit` };
    }
    resolvedSpecDeps.push(depNodeId);
  }

  // Cycle check: existingNode will depend on newNode, and newNode on specDeps.
  // If existingNode is reachable from any specDep (excluding existingNode's
  // current deps which will be severed), wiring creates a cycle.
  // Temporarily sever existingNode's deps so the walk doesn't follow the old edges.
  const savedDeps = existingNode.dependencies;
  existingNode.dependencies = [];
  for (const depId of resolvedSpecDeps) {
    if (depId === existingNodeId || hasCycle(plan, depId, existingNodeId)) {
      existingNode.dependencies = savedDeps;
      return { success: false, error: `Adding dependency '${depId}' would create a cycle through '${existingNodeId}'` };
    }
  }
  existingNode.dependencies = savedDeps;

  const nodeId = uuidv4();
  const newNode = buildNodeFromSpec(spec, nodeId, resolvedSpecDeps);

  // Wire: new node's dependents = [existingNodeId]
  newNode.dependents = [existingNodeId];

  // Register in plan
  plan.jobs.set(nodeId, newNode);
  plan.producerIdToNodeId.set(spec.producerId, nodeId);
  plan.nodeStates.set(nodeId, makeInitialState(resolvedSpecDeps, plan));

  // Update upstream dependents for new node's dependencies
  for (const depId of resolvedSpecDeps) {
    const depNode = plan.jobs.get(depId);
    if (depNode && !depNode.dependents.includes(nodeId)) {
      depNode.dependents.push(nodeId);
    }
  }

  // Remove existingNode from ALL old upstream nodes' dependents (it now depends only on newNode)
  for (const oldDepId of existingNode.dependencies) {
    const oldDepNode = plan.jobs.get(oldDepId);
    if (oldDepNode) {
      oldDepNode.dependents = oldDepNode.dependents.filter(id => id !== existingNodeId);
    }
  }

  // Rewire existing node to depend on the new node only
  existingNode.dependencies = [nodeId];
  recomputeNodeStatus(plan, existingNodeId);

  recomputeRootsAndLeaves(plan);
  plan.stateVersion++;

  log.info('Node added before', { planId: plan.id, newNodeId: nodeId, existingNodeId });
  return { success: true, nodeId };
}

// ---------------------------------------------------------------------------
// addNodeAfter
// ---------------------------------------------------------------------------

/**
 * Insert a new node that depends on an existing node.
 * The new node takes over the existing node's downstream dependents,
 * so it is inserted between the existing node and its former dependents.
 */
export function addNodeAfter(
  plan: PlanInstance,
  existingNodeId: string,
  spec: JobNodeSpec,
): AddNodeResult {
  const existingNode = plan.jobs.get(existingNodeId);
  if (!existingNode) {
    return { success: false, error: `Node '${existingNodeId}' not found` };
  }

  if (!isPlanModifiable(plan)) {
    return { success: false, error: 'Plan is not in a modifiable state' };
  }

  if (!isDependencyAvailable(plan, existingNodeId)) {
    return { success: false, error: `Node '${existingNodeId}' has no available worktree or completed commit` };
  }

  if (plan.producerIdToNodeId.has(spec.producerId)) {
    return { success: false, error: `Producer ID '${spec.producerId}' already exists in plan` };
  }

  // Resolve the new node's own dependencies from spec, plus the existing node
  const resolvedSpecDeps: string[] = [existingNodeId];
  for (const depProducerId of spec.dependencies) {
    const depNodeId = plan.producerIdToNodeId.get(depProducerId);
    if (!depNodeId) {
      return { success: false, error: `Dependency '${depProducerId}' not found in plan` };
    }
    if (!isDependencyAvailable(plan, depNodeId)) {
      return { success: false, error: `Dependency '${depProducerId}' has no available worktree or completed commit` };
    }
    if (!resolvedSpecDeps.includes(depNodeId)) {
      resolvedSpecDeps.push(depNodeId);
    }
  }

  // Cycle check: the new node will inherit existingNode's dependents.
  // If any spec dependency is itself a dependent of existingNode, wiring
  // would create a cycle (dependent → newNode → specDep → ... → dependent).
  for (const depId of resolvedSpecDeps) {
    if (depId === existingNodeId) { continue; }
    for (const existingDepId of existingNode.dependents) {
      if (depId === existingDepId || hasCycle(plan, depId, existingDepId)) {
        return { success: false, error: `Adding dependency '${depId}' would create a cycle via dependent '${existingDepId}'` };
      }
    }
  }

  const nodeId = uuidv4();
  const newNode = buildNodeFromSpec(spec, nodeId, resolvedSpecDeps);

  // Register in plan
  plan.jobs.set(nodeId, newNode);
  plan.producerIdToNodeId.set(spec.producerId, nodeId);
  plan.nodeStates.set(nodeId, makeInitialState(resolvedSpecDeps, plan));

  // The new node takes existing node's dependents (that are still modifiable)
  const transferredDependents: string[] = [];
  for (const depId of existingNode.dependents) {
    const depState = plan.nodeStates.get(depId);
    if (depState && MODIFIABLE_STATES.has(depState.status)) {
      const depNode = plan.jobs.get(depId);
      if (depNode) {
        // Replace existingNodeId with nodeId in the dependent's dependencies
        depNode.dependencies = depNode.dependencies.map(d => d === existingNodeId ? nodeId : d);
        transferredDependents.push(depId);
        recomputeNodeStatus(plan, depId);
      }
    }
  }

  // Update existing node's dependents: remove transferred, add newNode
  existingNode.dependents = existingNode.dependents.filter(id => !transferredDependents.includes(id));
  existingNode.dependents.push(nodeId);

  // Set new node's dependents to transferred
  newNode.dependents = transferredDependents;

  // Update dependents lists for other upstream nodes
  for (const depId of resolvedSpecDeps) {
    if (depId !== existingNodeId) {
      const depNode = plan.jobs.get(depId);
      if (depNode && !depNode.dependents.includes(nodeId)) {
        depNode.dependents.push(nodeId);
      }
    }
  }

  recomputeRootsAndLeaves(plan);
  plan.stateVersion++;

  log.info('Node added after', { planId: plan.id, newNodeId: nodeId, existingNodeId });
  return { success: true, nodeId };
}
