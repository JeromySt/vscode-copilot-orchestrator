/**
 * @fileoverview State serialization utilities for plan persistence.
 * 
 * Provides functions to serialize PlanInstance objects into storable metadata,
 * including node states, group states, and metadata fields.
 * 
 * @module plan/repository/planStatePersister
 */

import type { StoredPlanMetadata, StoredJobMetadata, IPlanRepositoryStore } from '../../interfaces/IPlanRepositoryStore';
import type { PlanInstance, NodeExecutionState, GroupExecutionState } from '../types/plan';

/**
 * Data structure for serialized plan state.
 */
export interface PlanStateData {
  jobs: StoredJobMetadata[];
  producerIdToNodeId: Record<string, string>;
  roots: string[];
  leaves: string[];
  nodeStates: Record<string, NodeExecutionState>;
  groupStates?: Record<string, GroupExecutionState>;
  startedAt?: Date | number;
  endedAt?: Date | number;
  baseCommitAtStart?: string;
  isPaused: boolean;
  stateHistory?: Array<{ from?: string; to?: string; status?: string; timestamp: number; reason?: string }>;
  pauseHistory?: Array<{ pausedAt: number; resumedAt?: number; reason?: string }>;
  resumeAfterPlan?: string;
  branchReady?: boolean;
  snapshot?: any;
  workSummary?: any;
  stateVersion: number;
}

/**
 * Serialize a PlanInstance into storable metadata format.
 * 
 * Checks disk for existing specs (hasWork/hasPrechecks/hasPostchecks flags).
 * For finalized plans, this preserves spec flags even when in-memory nodes
 * don't have inline specs loaded.
 * 
 * @param plan - PlanInstance to serialize.
 * @param store - Plan repository store for checking existing specs.
 * @returns Serialized plan state data.
 */
export async function serializePlanState(
  plan: PlanInstance,
  store: IPlanRepositoryStore
): Promise<PlanStateData> {
  const jobs: StoredJobMetadata[] = [];
  
  for (const [nodeId, node] of plan.jobs) {
    const jobNode = node as any;
    
    // Check disk for existing specs
    const hasWorkOnDisk = await store.hasNodeSpec(plan.id, nodeId, 'work');
    const hasPrechecksOnDisk = await store.hasNodeSpec(plan.id, nodeId, 'prechecks');
    const hasPostchecksOnDisk = await store.hasNodeSpec(plan.id, nodeId, 'postchecks');
    
    jobs.push({
      id: nodeId,
      producerId: jobNode.producerId,
      name: jobNode.name,
      task: jobNode.task,
      dependencies: jobNode.dependencies || [],
      group: jobNode.group,
      hasWork: !!jobNode.work || hasWorkOnDisk,
      hasPrechecks: !!jobNode.prechecks || hasPrechecksOnDisk,
      hasPostchecks: !!jobNode.postchecks || hasPostchecksOnDisk,
      workRef: hasWorkOnDisk ? `specs/${nodeId}/current/work.json` : undefined,
      prechecksRef: hasPrechecksOnDisk ? `specs/${nodeId}/current/prechecks.json` : undefined,
      postchecksRef: hasPostchecksOnDisk ? `specs/${nodeId}/current/postchecks.json` : undefined,
      autoHeal: jobNode.autoHeal,
      expectsNoChanges: jobNode.expectsNoChanges,
      baseBranch: jobNode.baseBranch,
      assignedWorktreePath: jobNode.assignedWorktreePath,
    });
  }
  
  // Serialize producerIdToNodeId
  const producerIdToNodeId: Record<string, string> = {};
  for (const [pid, nid] of plan.producerIdToNodeId) {
    producerIdToNodeId[pid] = nid;
  }
  
  // Serialize node states
  const nodeStates: Record<string, NodeExecutionState> = {};
  for (const [nodeId, nodeState] of plan.nodeStates) {
    nodeStates[nodeId] = { ...nodeState };
  }
  
  // Serialize group states
  let groupStates: Record<string, GroupExecutionState> | undefined;
  if (plan.groupStates) {
    groupStates = {};
    for (const [groupId, groupState] of plan.groupStates) {
      groupStates[groupId] = { ...groupState };
    }
  }
  
  return {
    jobs,
    producerIdToNodeId,
    roots: plan.roots,
    leaves: plan.leaves,
    nodeStates,
    groupStates,
    startedAt: plan.startedAt,
    endedAt: plan.endedAt,
    baseCommitAtStart: plan.baseCommitAtStart,
    isPaused: plan.isPaused ?? false,
    stateHistory: plan.stateHistory,
    pauseHistory: plan.pauseHistory,
    resumeAfterPlan: plan.resumeAfterPlan,
    branchReady: plan.branchReady,
    snapshot: plan.snapshot,
    workSummary: plan.workSummary,
    stateVersion: plan.stateVersion,
  };
}

/**
 * Serialize a PlanInstance synchronously into storable metadata format.
 * 
 * Uses existing metadata to preserve hasWork/hasPrechecks/hasPostchecks flags
 * for nodes that don't have inline specs loaded.
 * 
 * @param plan - PlanInstance to serialize.
 * @param existingMetadata - Existing metadata for flag preservation.
 * @returns Serialized plan state data.
 */
export function serializePlanStateSync(
  plan: PlanInstance,
  existingMetadata?: StoredPlanMetadata
): PlanStateData {
  // Build map of existing job flags from on-disk metadata
  const existingJobFlags = new Map<string, { 
    hasWork: boolean; 
    hasPrechecks: boolean; 
    hasPostchecks: boolean;
  }>();
  
  if (existingMetadata) {
    for (const job of existingMetadata.jobs || []) {
      existingJobFlags.set(job.id, { 
        hasWork: !!job.hasWork, 
        hasPrechecks: !!job.hasPrechecks, 
        hasPostchecks: !!job.hasPostchecks 
      });
    }
  }
  
  const jobs: StoredJobMetadata[] = [];
  
  for (const [nodeId, node] of plan.jobs) {
    const jobNode = node as any;
    const existing = existingJobFlags.get(nodeId);
    
    jobs.push({
      id: nodeId,
      producerId: jobNode.producerId,
      name: jobNode.name,
      task: jobNode.task,
      dependencies: jobNode.dependencies || [],
      group: jobNode.group,
      hasWork: !!jobNode.work || (existing?.hasWork ?? false),
      hasPrechecks: !!jobNode.prechecks || (existing?.hasPrechecks ?? false),
      hasPostchecks: !!jobNode.postchecks || (existing?.hasPostchecks ?? false),
      autoHeal: jobNode.autoHeal,
      expectsNoChanges: jobNode.expectsNoChanges,
      baseBranch: jobNode.baseBranch,
      assignedWorktreePath: jobNode.assignedWorktreePath,
    });
  }
  
  // Serialize producerIdToNodeId
  const producerIdToNodeId: Record<string, string> = {};
  for (const [pid, nid] of plan.producerIdToNodeId) {
    producerIdToNodeId[pid] = nid;
  }
  
  // Serialize node states
  const nodeStates: Record<string, NodeExecutionState> = {};
  for (const [nodeId, nodeState] of plan.nodeStates) {
    nodeStates[nodeId] = { ...nodeState };
  }
  
  // Serialize group states
  let groupStates: Record<string, GroupExecutionState> | undefined;
  if (plan.groupStates) {
    groupStates = {};
    for (const [groupId, groupState] of plan.groupStates) {
      groupStates[groupId] = { ...groupState };
    }
  }
  
  return {
    jobs,
    producerIdToNodeId,
    roots: plan.roots,
    leaves: plan.leaves,
    nodeStates,
    groupStates,
    startedAt: plan.startedAt,
    endedAt: plan.endedAt,
    baseCommitAtStart: plan.baseCommitAtStart,
    isPaused: plan.isPaused ?? false,
    stateHistory: plan.stateHistory,
    pauseHistory: plan.pauseHistory,
    resumeAfterPlan: plan.resumeAfterPlan,
    branchReady: plan.branchReady,
    snapshot: plan.snapshot,
    workSummary: plan.workSummary,
    stateVersion: plan.stateVersion,
  };
}

/**
 * Serialize a single node execution state.
 * 
 * @param state - Node execution state to serialize.
 * @returns Serialized node state.
 */
export function serializeNodeState(state: NodeExecutionState): NodeExecutionState {
  return { ...state };
}
