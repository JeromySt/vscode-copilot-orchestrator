/**
 * @fileoverview IPlanRunner Interface
 *
 * Full interface for the PlanRunner that MCP handlers and UI call.
 * Decouples consumers from the concrete PlanRunner implementation.
 *
 * @module interfaces/IPlanRunner
 */

import type { EventEmitter } from 'events';
import type {
  PlanSpec,
  PlanInstance,
  PlanStatus,
  NodeStatus,
  NodeExecutionState,
  ExecutionPhase,
  AttemptRecord,
  WorkSpec,
} from '../plan/types';
import type { PlanStateMachine } from '../plan/stateMachine';
import type { GlobalCapacityStats } from '../core/globalCapacity';

/**
 * Options for retrying a failed node
 */
export interface RetryNodeOptions {
  /** New work spec to replace/augment original */
  newWork?: WorkSpec;
  /** New prechecks spec to replace original */
  newPrechecks?: WorkSpec | null;
  /** New postchecks spec to replace original (use null to remove postchecks) */
  newPostchecks?: WorkSpec | null;
  /** Reset worktree to base commit (default: false) */
  clearWorktree?: boolean;
}

/**
 * Plan Runner configuration
 */
export interface PlanRunnerConfig {
  /** Storage path for persistence */
  storagePath: string;
  /** Default repository path */
  defaultRepoPath?: string;
  /** Global max parallel jobs */
  maxParallel?: number;
  /** Pump interval in ms */
  pumpInterval?: number;
}

/**
 * Full interface for the PlanRunner.
 *
 * All public methods that MCP handlers, UI panels, and other consumers call.
 */
export interface IPlanRunner extends EventEmitter {
  // ── Plan Creation ──────────────────────────────────────────────────

  enqueue(spec: PlanSpec): PlanInstance;

  enqueueJob(jobSpec: {
    name: string;
    task: string;
    work?: string;
    prechecks?: string;
    postchecks?: string;
    instructions?: string;
    baseBranch?: string;
    targetBranch?: string;
    expectsNoChanges?: boolean;
    autoHeal?: boolean;
    startPaused?: boolean;
  }): PlanInstance;

  // ── Plan Queries ───────────────────────────────────────────────────

  get(planId: string): PlanInstance | undefined;
  getPlan(planId: string): PlanInstance | undefined;
  getAll(): PlanInstance[];
  getByStatus(status: PlanStatus): PlanInstance[];
  getStateMachine(planId: string): PlanStateMachine | undefined;

  getStatus(planId: string): {
    plan: PlanInstance;
    status: PlanStatus;
    counts: Record<NodeStatus, number>;
    progress: number;
  } | undefined;

  getGlobalStats(): {
    running: number;
    maxParallel: number;
    queued: number;
  };

  getEffectiveEndedAt(planId: string): number | undefined;
  getEffectiveStartedAt(planId: string): number | undefined;

  getRecursiveStatusCounts(planId: string): {
    totalNodes: number;
    counts: Record<NodeStatus, number>;
  };

  getGlobalCapacityStats(): Promise<GlobalCapacityStats | null>;

  // ── Node Queries ───────────────────────────────────────────────────

  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase, attemptNumber?: number): string;
  getNodeLogFilePath(planId: string, nodeId: string, attemptNumber?: number): string | undefined;
  getNodeAttempt(planId: string, nodeId: string, attemptNumber: number): AttemptRecord | null;
  getNodeAttempts(planId: string, nodeId: string): AttemptRecord[];
  getProcessStats(planId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: any[];
    duration: number | null;
  }>;
  getAllProcessStats(planId: string): Promise<any>;

  getNodeFailureContext(planId: string, nodeId: string): {
    logs: string;
    phase: string;
    errorMessage: string;
    sessionId?: string;
    lastAttempt?: NodeExecutionState['lastAttempt'];
    worktreePath?: string;
  } | { error: string };

  // ── Plan Control ───────────────────────────────────────────────────

  pause(planId: string): boolean;
  resume(planId: string): Promise<boolean>;
  cancel(planId: string, options?: { skipPersist?: boolean }): boolean;
  delete(planId: string): boolean;

  // ── Node Control ───────────────────────────────────────────────────

  retryNode(planId: string, nodeId: string, options?: RetryNodeOptions): Promise<{ success: boolean; error?: string }>;
  forceFailNode(planId: string, nodeId: string): Promise<void>;

  // ── Lifecycle ──────────────────────────────────────────────────────

  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  persistSync(): void;

  // ── Executor ───────────────────────────────────────────────────────

  setExecutor(executor: any): void;
  setGlobalCapacityManager(manager: any): void;
}
