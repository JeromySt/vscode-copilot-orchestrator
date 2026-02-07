/**
 * @fileoverview Node-Centric DI Interfaces
 *
 * Defines the dependency injection interfaces for the simplified node model.
 * These interfaces replace plan-centric abstractions with node-first equivalents.
 *
 * @module interfaces/INodeRunner
 */

import type {
  NodeSpec,
  NodeInstance,
  NodeStatus,
  WorkSpec,
  GroupInfo,
  GroupSpec,
  GroupStatus,
  GroupStatusSnapshot,
  JobExecutionResult,
  LogEntry,
  ExecutionPhase,
} from '../plan/types';

// ============================================================================
// INodeRegistry
// ============================================================================

/**
 * Registry for node instances.
 * Replaces the plan-level Map<planId, PlanInstance>.
 */
export interface INodeRegistry {
  /** Register a new node */
  register(node: NodeInstance): void;

  /** Get node by UUID */
  get(nodeId: string): NodeInstance | undefined;

  /** Get node by producer ID (within optional group scope) */
  getByProducerId(producerId: string, groupId?: string): NodeInstance | undefined;

  /** Get all nodes in a group */
  getByGroup(groupId: string): NodeInstance[];

  /** Get all ungrouped nodes */
  getUngrouped(): NodeInstance[];

  /** Get all nodes */
  getAll(): NodeInstance[];

  /** Remove a node */
  delete(nodeId: string): boolean;

  /** Check existence */
  has(nodeId: string): boolean;
}

// ============================================================================
// INodeRunner
// ============================================================================

/**
 * Orchestrator interface.
 * Replaces PlanRunner with a node-centric API.
 */
export interface INodeRunner {
  /** Create nodes (optionally grouped) */
  createNodes(specs: NodeSpec[], group?: GroupSpec): Promise<NodeInstance[]>;

  /** Create a group of nodes from a GroupSpec */
  createGroup(spec: GroupSpec): Promise<{ groupId: string; nodes: NodeInstance[] }>;

  /** Get a node by ID */
  getNode(nodeId: string): NodeInstance | undefined;

  /** Get group status (derived from member nodes) */
  getGroupStatus(groupId: string): GroupStatusSnapshot | undefined;

  /** List all groups */
  listGroups(filter?: { status?: GroupStatus }): GroupInfo[];

  /** Cancel a node or all nodes in a group */
  cancel(nodeId: string): void;
  cancelGroup(groupId: string): void;

  /** Retry a failed node */
  retryNode(nodeId: string, newWork?: WorkSpec, clearWorktree?: boolean): Promise<void>;

  /** Delete a node (or group) and its history */
  deleteNode(nodeId: string): void;
  deleteGroup(groupId: string): void;

  /** Set the executor strategy */
  setExecutor(executor: INodeExecutor): void;

  /** Lifecycle */
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

// ============================================================================
// INodeExecutor
// ============================================================================

/**
 * Context passed to executor (replaces ExecutionContext).
 * No longer references PlanInstance — node is self-contained.
 */
export interface NodeExecutionContext {
  node: NodeInstance;
  baseCommit: string;
  worktreePath: string;
  onProgress?: (step: string) => void;
  abortSignal?: AbortSignal;
  copilotSessionId?: string;
}

/** Same shape as JobExecutionResult, renamed for consistency */
export type NodeExecutionResult = JobExecutionResult;

/**
 * Strategy interface for executing node work.
 * Replaces JobExecutor — same shape, renamed for consistency.
 */
export interface INodeExecutor {
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
  cancel(nodeId: string): void;
  getLogs?(nodeId: string): LogEntry[];
  getLogsForPhase?(nodeId: string, phase: ExecutionPhase): LogEntry[];
  log?(nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void;
}

// ============================================================================
// INodeStateMachine
// ============================================================================

/**
 * State machine for node transitions.
 * Operates on individual nodes; group-level status is derived.
 */
export interface INodeStateMachine {
  /** Transition a node to a new status */
  transition(nodeId: string, newStatus: NodeStatus, updates?: Partial<NodeInstance>): boolean;

  /** Check if a node's dependencies are all succeeded */
  areDependenciesMet(nodeId: string): boolean;

  /** Propagate blocked status to dependents of a failed node */
  propagateBlocked(failedNodeId: string): void;

  /** Get nodes ready for scheduling (optionally scoped to group) */
  getReadyNodes(groupId?: string): NodeInstance[];

  /** Compute derived group status */
  computeGroupStatus(groupId: string): GroupStatus;

  /** Reset node for retry */
  resetNodeToPending(nodeId: string): void;
}

// ============================================================================
// INodePersistence
// ============================================================================

/**
 * Persistence interface for nodes and groups.
 */
export interface INodePersistence {
  saveNode(node: NodeInstance): Promise<void>;
  loadNode(nodeId: string): Promise<NodeInstance | undefined>;
  deleteNode(nodeId: string): Promise<void>;
  loadAllNodes(): Promise<NodeInstance[]>;

  saveGroup(group: GroupInfo): Promise<void>;
  loadGroup(groupId: string): Promise<GroupInfo | undefined>;
  deleteGroup(groupId: string): Promise<void>;
  loadAllGroups(): Promise<GroupInfo[]>;

  /** One-time migration from legacy PlanInstance format */
  migrateLegacyPlans?(): Promise<{ migrated: number; errors: string[] }>;
}
