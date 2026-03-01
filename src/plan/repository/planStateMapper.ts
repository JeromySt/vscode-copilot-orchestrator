/**
 * @fileoverview State reconstruction utilities for plan persistence.
 * 
 * Provides functions to reconstruct PlanInstance objects from stored metadata,
 * deserialize node states, and normalize status values.
 * 
 * @module plan/repository/planStateMapper
 */

import type { 
  StoredPlanMetadata, 
  IPlanRepositoryStore 
} from '../../interfaces/IPlanRepositoryStore';
import type { 
  PlanInstance, 
  NodeExecutionState,
  GroupInstance,
  GroupExecutionState 
} from '../types/plan';
import type { WorkSpec } from '../types/specs';
import { FilePlanDefinition } from './FilePlanDefinition';

/**
 * Dependencies required by the state mapper.
 */
export interface PlanStateMapperDeps {
  store: IPlanRepositoryStore;
  repoPath: string;
  worktreeRoot: string;
}

/**
 * Build a PlanInstance from metadata without calling buildPlan().
 * 
 * Uses stable node IDs from metadata.producerIdToNodeId. This is the
 * authoritative reconstruction path for both scaffolding and finalized plans.
 * No UUID regeneration, no duplicate SV injection.
 * 
 * @param metadata - Stored plan metadata.
 * @param deps - Dependencies (store, repoPath, worktreeRoot).
 * @returns Fully constructed PlanInstance with stable IDs.
 */
export function buildPlanInstance(
  metadata: StoredPlanMetadata, 
  deps: PlanStateMapperDeps
): PlanInstance {
  // For scaffolding plans, jobs are inline in spec.jobs (with full specs).
  // For finalized plans, spec.jobs is [] and jobs are in metadata.jobs
  // (StoredJobMetadata[] with hasWork/hasPrechecks/hasPostchecks flags).
  const specJobs = metadata.spec.jobs || [];
  const storedJobs = metadata.jobs || [];
  const jobs = specJobs.length > 0 ? specJobs : storedJobs;
  
  const nodes = new Map<string, any>();
  const nodeStates = buildNodeStates(metadata.nodeStates || {});
  const producerIdToNodeId = new Map<string, string>();
  const groups = buildGroups(metadata.groups || {});
  const groupStates = buildGroupStates(metadata.groupStates || {});
  const groupPathToId = buildGroupPathToId(metadata.groupPathToId || {});

  // First pass: create nodes from job specs using stable IDs
  for (const jobSpec of jobs) {
    const nodeId = (jobSpec as any).id || metadata.producerIdToNodeId[(jobSpec as any).producerId];
    if (!nodeId) {
      continue; // Skip jobs without stable IDs
    }

    const node: any = {
      id: nodeId,
      producerId: (jobSpec as any).producerId,
      name: (jobSpec as any).name || (jobSpec as any).producerId,
      type: 'job',
      task: (jobSpec as any).task,
      work: (jobSpec as any).work,
      prechecks: (jobSpec as any).prechecks,
      postchecks: (jobSpec as any).postchecks,
      autoHeal: (jobSpec as any).autoHeal,
      expectsNoChanges: (jobSpec as any).expectsNoChanges,
      baseBranch: (jobSpec as any).baseBranch,
      assignedWorktreePath: (jobSpec as any).assignedWorktreePath,
      dependencies: (jobSpec as any).dependencies || [],
      dependents: [],
      group: (jobSpec as any).group,
      // Resolve groupId (UUID) from group path
      groupId: (jobSpec as any).group && metadata.groupPathToId 
        ? metadata.groupPathToId[(jobSpec as any).group] 
        : undefined,
    };

    nodes.set(nodeId, node);
    producerIdToNodeId.set((jobSpec as any).producerId, nodeId);
    
    // Ensure node state exists
    if (!nodeStates.has(nodeId)) {
      nodeStates.set(nodeId, { status: 'pending', version: 0, attempts: 0 });
    }
  }

  // Resolve dependencies: during scaffolding, spec.jobs stores deps as producerIds;
  // after finalization, metadata.jobs already has nodeId deps. Handle both.
  for (const [, node] of nodes) {
    node.dependencies = node.dependencies.map((dep: string) => {
      if (nodes.has(dep)) { return dep; }           // already a nodeId
      return producerIdToNodeId.get(dep) || dep;     // resolve producerId → nodeId
    });
  }

  // Second pass: compute dependents (reverse edges) from dependencies
  for (const [nodeId, node] of nodes) {
    for (const depId of node.dependencies) {
      const depNode = nodes.get(depId);
      if (depNode) {
        depNode.dependents.push(nodeId);
      }
    }
  }

  const planInstance: PlanInstance = {
    id: metadata.id,
    spec: metadata.spec as any,
    jobs: nodes,
    nodeStates,
    producerIdToNodeId,
    roots: metadata.roots || [],
    leaves: metadata.leaves || [],
    groups,
    groupStates,
    groupPathToId,
    parentPlanId: metadata.parentPlanId,
    parentNodeId: metadata.parentNodeId,
    repoPath: metadata.repoPath,
    baseBranch: metadata.baseBranch,
    targetBranch: metadata.targetBranch,
    worktreeRoot: metadata.worktreeRoot,
    createdAt: metadata.createdAt,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    baseCommitAtStart: metadata.baseCommitAtStart,
    isPaused: metadata.isPaused,
    stateHistory: metadata.stateHistory,
    pauseHistory: metadata.pauseHistory,
    resumeAfterPlan: metadata.resumeAfterPlan,
    branchReady: metadata.branchReady,
    env: metadata.env,
    snapshot: metadata.snapshot,
    workSummary: metadata.workSummary,
    stateVersion: metadata.stateVersion || 0,
    cleanUpSuccessfulWork: metadata.cleanUpSuccessfulWork,
    maxParallel: metadata.maxParallel,
    definition: new FilePlanDefinition(metadata, deps.store),
  } as PlanInstance;

  return planInstance;
}

/**
 * Build node states map from raw stored states.
 * 
 * @param rawStates - Record of stored node states.
 * @returns Map of node execution states with normalized status.
 */
export function buildNodeStates(
  rawStates: Record<string, any>
): Map<string, NodeExecutionState> {
  const nodeStates = new Map<string, NodeExecutionState>();
  
  for (const [nodeId, state] of Object.entries(rawStates)) {
    nodeStates.set(nodeId, {
      ...state,
      status: normalizeNodeStatus(state.status),
    });
  }
  
  return nodeStates;
}

/**
 * Build groups map from stored groups.
 * 
 * @param rawGroups - Record of stored groups.
 * @returns Map of group instances.
 */
function buildGroups(rawGroups: Record<string, any>): Map<string, GroupInstance> {
  const groups = new Map<string, GroupInstance>();
  
  for (const [groupId, group] of Object.entries(rawGroups)) {
    groups.set(groupId, group);
  }
  
  return groups;
}

/**
 * Build group states map from stored group states.
 * 
 * @param rawStates - Record of stored group states.
 * @returns Map of group execution states.
 */
function buildGroupStates(rawStates: Record<string, any>): Map<string, GroupExecutionState> {
  const groupStates = new Map<string, GroupExecutionState>();
  
  for (const [groupId, state] of Object.entries(rawStates)) {
    groupStates.set(groupId, state);
  }
  
  return groupStates;
}

/**
 * Build group path to ID map from stored mapping.
 * 
 * @param rawMapping - Record of group path to ID mappings.
 * @returns Map of group path to UUID.
 */
function buildGroupPathToId(rawMapping: Record<string, any>): Map<string, string> {
  const groupPathToId = new Map<string, string>();
  
  for (const [path, id] of Object.entries(rawMapping)) {
    groupPathToId.set(path, id as string);
  }
  
  return groupPathToId;
}

/**
 * Normalize and validate node status string.
 * 
 * @param raw - Raw status string from storage.
 * @returns Normalized status or 'pending' as fallback.
 */
export function normalizeNodeStatus(raw: string): string {
  const validStatuses = [
    'pending', 'ready', 'running', 'succeeded', 
    'failed', 'canceled', 'blocked', 'skipped'
  ];
  
  if (validStatuses.includes(raw)) {
    return raw;
  }
  
  return 'pending'; // Fallback for invalid status
}

/**
 * Load work specs from disk for finalized plans.
 * 
 * @param store - Plan repository store.
 * @param planId - Plan ID.
 * @param nodeId - Node ID.
 * @param hasWork - Whether node has work spec.
 * @param hasPrechecks - Whether node has prechecks spec.
 * @param hasPostchecks - Whether node has postchecks spec.
 * @returns Object with loaded specs.
 */
export async function loadNodeSpecs(
  store: IPlanRepositoryStore,
  planId: string,
  nodeId: string,
  hasWork: boolean,
  hasPrechecks: boolean,
  hasPostchecks: boolean
): Promise<{
  work?: WorkSpec;
  prechecks?: WorkSpec;
  postchecks?: WorkSpec;
}> {
  const specs: any = {};
  
  if (hasWork) {
    specs.work = await store.readNodeSpec(planId, nodeId, 'work');
  }
  if (hasPrechecks) {
    specs.prechecks = await store.readNodeSpec(planId, nodeId, 'prechecks');
  }
  if (hasPostchecks) {
    specs.postchecks = await store.readNodeSpec(planId, nodeId, 'postchecks');
  }
  
  return specs;
}
