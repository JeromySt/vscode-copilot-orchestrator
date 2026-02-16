/**
 * @fileoverview Plan Runner - Slim Orchestrator
 *
 * Coordinates plan execution by delegating to focused sub-modules:
 * - {@link PlanLifecycleManager} -- CRUD & lifecycle
 * - {@link NodeManager} -- node operations (retry, force-fail, queries)
 * - {@link ExecutionPump} -- scheduling & pump loop
 * - {@link JobExecutionEngine} -- job execution, FI/RI merges
 * - {@link PlanEventEmitter} -- typed event emission
 * - {@link PlanConfigManager} -- configuration access
 *
 * @module plan/runner
 */

import { EventEmitter } from 'events';
import type { IProcessMonitor } from '../interfaces/IProcessMonitor';
import type {
  PlanSpec,
  PlanInstance,
  PlanStatus,
  NodeStatus,
  JobNode,
  JobExecutionResult,
  ExecutionContext,
  NodeTransitionEvent,
  JobWorkSummary,
  LogEntry,
  ExecutionPhase,
  NodeExecutionState,
  AttemptRecord,
  WorkSpec,
} from './types';
import type { PlanRunnerConfig, RetryNodeOptions } from '../interfaces/IPlanRunner';
import type { PlanStateMachine } from './stateMachine';
import { PlanScheduler } from './scheduler';
import type { PlanPersistence } from './persistence';
import { Logger } from '../core/logger';
import type { GlobalCapacityManager, GlobalCapacityStats } from '../core/globalCapacity';
import { PlanLifecycleManager, PlanRunnerState } from './planLifecycle';
import { NodeManager } from './nodeManager';
import { ExecutionPump } from './executionPump';
import { JobExecutionEngine } from './executionEngine';
import { PlanEventEmitter } from './planEvents';
import type { PlanConfigManager } from './configManager';

const log = Logger.for('plan-runner');

export interface PlanRunnerEvents {
  'planCreated': (plan: PlanInstance) => void;
  'planStarted': (plan: PlanInstance) => void;
  'planCompleted': (plan: PlanInstance, status: PlanStatus) => void;
  'planDeleted': (planId: string) => void;
  'nodeTransition': (event: NodeTransitionEvent) => void;
  'nodeStarted': (planId: string, nodeId: string) => void;
  'nodeCompleted': (planId: string, nodeId: string, success: boolean) => void;
  'nodeRetry': (planId: string, nodeId: string) => void;
}

/** Strategy interface for executing individual job nodes. */
export interface JobExecutor {
  /** Execute a job within the given context. */
  execute(context: ExecutionContext): Promise<JobExecutionResult>;
  /** Request cancellation of a running job. */
  cancel(planId: string, nodeId: string): void;
  /** Retrieve in-memory logs for a job execution. */
  getLogs?(planId: string, nodeId: string): LogEntry[];
  /** Retrieve logs filtered to a specific execution phase. */
  getLogsForPhase?(planId: string, nodeId: string, phase: ExecutionPhase): LogEntry[];
  /** Get the current size of the log file for a job execution. */
  getLogFileSize?(planId: string, nodeId: string): number;
  /** Get the file path for the log file of a job execution. */
  getLogFilePath?(planId: string, nodeId: string, attemptNumber?: number): string | undefined;
  /** Append a log entry to a job's execution log. */
  log?(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string, attemptNumber?: number): void;
  /** Compute aggregated work summary from baseBranch to current HEAD. */
  computeAggregatedWorkSummary?(
    node: JobNode,
    worktreePath: string,
    baseBranch: string,
    repoPath: string
  ): Promise<JobWorkSummary>;
}




/**
 * Central orchestrator for Plan execution.
 *
 * Delegates to focused sub-modules for each responsibility area.
 * Lifecycle: {@link initialize} -> {@link enqueue} -> pump loop -> {@link shutdown}.
 */
export class PlanRunner extends EventEmitter {
  private readonly _state: PlanRunnerState;
  private readonly _lifecycle: PlanLifecycleManager;
  private readonly _nodeManager: NodeManager;
  private readonly _pump: ExecutionPump;
  private readonly _engine: JobExecutionEngine;
  private readonly _events: PlanEventEmitter;

  constructor(config: PlanRunnerConfig, deps: {
    configManager: PlanConfigManager;
    persistence: PlanPersistence;
    processMonitor: IProcessMonitor;
    stateMachineFactory: (plan: PlanInstance) => PlanStateMachine;
    git: import('../interfaces/IGitOperations').IGitOperations;
  }) {
    super();

    const events = new PlanEventEmitter();
    const scheduler = new PlanScheduler({ globalMaxParallel: config.maxParallel || 8 });

    const state: PlanRunnerState = {
      plans: new Map(),
      stateMachines: new Map(),
      scheduler,
      persistence: deps.persistence,
      config,
      processMonitor: deps.processMonitor,
      events,
      configManager: deps.configManager,
      stateMachineFactory: deps.stateMachineFactory,
    };

    this._state = state;
    this._events = events;
    this._lifecycle = new PlanLifecycleManager(state, log, deps.git);
    this._nodeManager = new NodeManager(state, log, deps.git);
    this._engine = new JobExecutionEngine(state, this._nodeManager, log, deps.git);
    this._pump = new ExecutionPump(state, log, (plan, sm, node) => {
      this._engine.executeJobNode(plan, sm, node);
    });

    this._wireEvents();
  }

  /** Forward PlanEventEmitter events to this EventEmitter for backward compat. */
  private _wireEvents(): void {
    const fwd = (name: string) => {
      this._events.on(name, (...args: any[]) => this.emit(name, ...args));
    };
    fwd('planCreated');
    fwd('planStarted');
    fwd('planDeleted');
    fwd('planUpdated');
    fwd('nodeTransition');
    fwd('nodeStarted');
    fwd('nodeCompleted');
    fwd('nodeRetry');
    fwd('nodeUpdated');
    // planCompleted also triggers wake lock update
    this._events.on('planCompleted', (plan: PlanInstance, status: PlanStatus) => {
      this.emit('planCompleted', plan, status);
      this._pump.updateWakeLock().catch(err => log.warn('Failed to update wake lock', { error: err }));
    });
  }

  // -- Executor injection ----------------------------------------------------

  setExecutor(executor: JobExecutor): void {
    this._state.executor = executor;
  }

  setCopilotRunner(runner: import('../interfaces/ICopilotRunner').ICopilotRunner): void {
    this._state.copilotRunner = runner;
  }

  setGlobalCapacityManager(manager: GlobalCapacityManager): void {
    this._state.globalCapacity = manager;
  }

  setPowerManager(pm: import('../core/powerManager').PowerManager): void {
    this._state.powerManager = pm;
  }

  // -- Lifecycle -------------------------------------------------------------

  async initialize(): Promise<void> {
    await this._lifecycle.initialize();
    this._pump.startPump();
  }

  async shutdown(): Promise<void> {
    this._pump.stopPump();
    await this._lifecycle.shutdown();
  }

  persistSync(): void {
    this._lifecycle.persistSync();
  }

  // -- Plan creation ---------------------------------------------------------

  enqueue(spec: PlanSpec): PlanInstance {
    return this._lifecycle.enqueue(spec);
  }

  enqueueJob(jobSpec: {
    name: string; task: string; work?: string; prechecks?: string;
    postchecks?: string; instructions?: string; baseBranch?: string;
    targetBranch?: string; expectsNoChanges?: boolean; autoHeal?: boolean;
    startPaused?: boolean;
  }): PlanInstance {
    return this._lifecycle.enqueueJob(jobSpec);
  }

  // -- Plan queries ----------------------------------------------------------

  get(planId: string): PlanInstance | undefined { return this._lifecycle.get(planId); }
  getPlan(planId: string): PlanInstance | undefined { return this._lifecycle.get(planId); }
  getAll(): PlanInstance[] { return this._lifecycle.getAll(); }
  getByStatus(status: PlanStatus): PlanInstance[] { return this._lifecycle.getByStatus(status); }
  getStateMachine(planId: string): PlanStateMachine | undefined { return this._lifecycle.getStateMachine(planId); }
  getStatus(planId: string) { return this._lifecycle.getStatus(planId); }
  getGlobalStats() { return this._lifecycle.getGlobalStats(); }
  getEffectiveEndedAt(planId: string) { return this._lifecycle.getEffectiveEndedAt(planId); }
  getEffectiveStartedAt(planId: string) { return this._lifecycle.getEffectiveStartedAt(planId); }
  getRecursiveStatusCounts(planId: string) { return this._lifecycle.getRecursiveStatusCounts(planId); }
  async getGlobalCapacityStats(): Promise<GlobalCapacityStats | null> { return this._lifecycle.getGlobalCapacityStats(); }

  // -- Node queries ----------------------------------------------------------

  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase, attemptNumber?: number): string {
    return this._nodeManager.getNodeLogs(planId, nodeId, phase, attemptNumber);
  }
  getNodeLogFilePath(planId: string, nodeId: string, attemptNumber?: number) {
    return this._nodeManager.getNodeLogFilePath(planId, nodeId, attemptNumber);
  }
  getNodeAttempt(planId: string, nodeId: string, attemptNumber: number) {
    return this._nodeManager.getNodeAttempt(planId, nodeId, attemptNumber);
  }
  getNodeAttempts(planId: string, nodeId: string) {
    return this._nodeManager.getNodeAttempts(planId, nodeId);
  }
  async getProcessStats(planId: string, nodeId: string) {
    return this._nodeManager.getProcessStats(planId, nodeId);
  }
  async getAllProcessStats(planId: string) {
    return this._nodeManager.getAllProcessStats(planId);
  }
  getNodeFailureContext(planId: string, nodeId: string) {
    return this._nodeManager.getNodeFailureContext(planId, nodeId);
  }

  // -- Plan control ----------------------------------------------------------

  pause(planId: string): boolean {
    return this._lifecycle.pause(planId, () => this._pump.updateWakeLock());
  }

  async resume(planId: string): Promise<boolean> {
    return this._lifecycle.resume(planId, () => this._pump.startPump());
  }

  cancel(planId: string, options?: { skipPersist?: boolean }): boolean {
    return this._lifecycle.cancel(planId, options, () => this._pump.updateWakeLock());
  }

  delete(planId: string): boolean {
    return this._lifecycle.delete(planId);
  }

  savePlan(planId: string): boolean {
    const plan = this._state.plans.get(planId);
    if (!plan) {return false;}
    this._state.persistence.save(plan);
    return true;
  }

  // -- Node control ----------------------------------------------------------

  async retryNode(planId: string, nodeId: string, options?: RetryNodeOptions): Promise<{ success: boolean; error?: string }> {
    return this._nodeManager.retryNode(planId, nodeId, options, () => this._pump.startPump());
  }

  async forceFailNode(planId: string, nodeId: string): Promise<void> {
    return this._nodeManager.forceFailNode(planId, nodeId);
  }
}

// Re-export types from IPlanRunner to maintain backwards compatibility
export type { PlanRunnerConfig, RetryNodeOptions } from '../interfaces/IPlanRunner';
