/**
 * @fileoverview IOrchestrationEngine — abstraction layer between the VS Code UI
 * and the underlying execution engine (TypeScript PlanRunner or .NET daemon).
 *
 * This interface defines the contract that the UI, MCP handlers, and commands
 * use to interact with plan orchestration. It mirrors IPlanRunner's shape but
 * decouples consumers from the concrete engine implementation.
 *
 * @module interfaces/IOrchestrationEngine
 */

import type { EventEmitter } from 'events';
import type {
  PlanSpec,
  PlanInstance,
  PlanStatus,
  NodeStatus,
  ExecutionPhase,
  AttemptRecord,
} from '../plan/types';
import type { RetryNodeOptions } from './IPlanRunner';

/**
 * Engine kind indicator.
 */
export type EngineKind = 'typescript' | 'dotnet';

/**
 * Unified orchestration engine interface.
 *
 * Both the TypeScript (in-process) and .NET (out-of-process daemon) engines
 * implement this interface so the UI, commands, and MCP handlers can swap
 * engines transparently based on the `experimental.useDotNetEngine` setting.
 */
export interface IOrchestrationEngine extends EventEmitter {
  /** Which engine implementation is active. */
  readonly kind: EngineKind;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Start the engine (initialize internal state, connect to daemon, etc.) */
  initialize(): Promise<void>;

  /** Gracefully shut down the engine. */
  shutdown(): Promise<void>;

  /** Synchronously persist critical state (called during deactivate). */
  persistSync(): void;

  // ── Plan Creation ──────────────────────────────────────────────────

  enqueue(spec: PlanSpec): Promise<PlanInstance>;

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
  }): Promise<PlanInstance>;

  // ── Plan Queries ───────────────────────────────────────────────────

  get(planId: string): PlanInstance | undefined;
  getAll(): PlanInstance[];
  getByStatus(status: PlanStatus): PlanInstance[];

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

  // ── Node Queries ───────────────────────────────────────────────────

  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase, attemptNumber?: number): string;
  getNodeAttempts(planId: string, nodeId: string): AttemptRecord[];

  getNodeFailureContext(planId: string, nodeId: string): {
    logs: string;
    phase: string;
    errorMessage: string;
    sessionId?: string;
    worktreePath?: string;
  } | { error: string };

  // ── Plan Control ───────────────────────────────────────────────────

  pause(planId: string): Promise<boolean>;
  resume(planId: string): Promise<boolean>;
  cancel(planId: string): Promise<boolean>;
  delete(planId: string): Promise<boolean>;

  // ── Node Control ───────────────────────────────────────────────────

  retryNode(planId: string, nodeId: string, options?: RetryNodeOptions): Promise<{ success: boolean; error?: string }>;
  forceFailNode(planId: string, nodeId: string): Promise<void>;

  // ── Logs ──────────────────────────────────────────────────────────

  /** Get daemon log contents (only available for dotnet engine). */
  getDaemonLogs(): Promise<string | null>;

  /** Get repo-specific log contents. */
  getRepoLogs(repoRoot: string): Promise<string | null>;
}
