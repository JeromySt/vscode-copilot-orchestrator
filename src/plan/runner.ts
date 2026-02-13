/**
 * @fileoverview Plan Runner
 * 
 * Main orchestrator for Plan execution. Combines:
 * - Plan building
 * - State machine management
 * - Scheduling
 * - Execution delegation
 * - Persistence
 * 
 * This is the primary interface for creating and running Plans.
 * 
 * @module plan/runner
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import { OrchestratorFileWatcher } from '../core';
import { ProcessMonitor } from '../process';

// Conditionally import vscode - may not be available in standalone processes
let vscode: typeof import('vscode') | undefined;
try {
  vscode = require('vscode');
} catch {
  // Running outside VS Code extension host (e.g., stdio server)
  vscode = undefined;
}

/**
 * Get a configuration value from VS Code settings, with fallback for standalone mode.
 */
function getConfig<T>(section: string, key: string, defaultValue: T): T {
  if (!vscode) {
    return defaultValue;
  }
  return vscode.workspace.getConfiguration(section).get<T>(key, defaultValue);
}

import {
  PlanSpec,
  PlanInstance,
  PlanNode,
  JobNode,
  NodeStatus,
  PlanStatus,
  JobExecutionResult,
  ExecutionContext,
  NodeTransitionEvent,
  PlanCompletionEvent,
  WorkSummary,
  JobWorkSummary,
  CommitDetail,
  LogEntry,
  ExecutionPhase,
  NodeExecutionState,
  nodePerformsWork,
  AttemptRecord,
  WorkSpec,
  CopilotUsageMetrics,
  normalizeWorkSpec,
} from './types';
import { buildPlan, buildSingleJobPlan, PlanValidationError } from './builder';
import { PlanStateMachine } from './stateMachine';
import { PlanScheduler } from './scheduler';
import { PlanPersistence } from './persistence';
import { Logger } from '../core/logger';
import { GlobalCapacityManager, GlobalCapacityStats } from '../core/globalCapacity';
import {
  formatLogEntries,
  appendWorkSummary as appendWorkSummaryHelper,
  mergeWorkSummary as mergeWorkSummaryHelper,
  computeProgress,
} from './helpers';
import * as git from '../git';
import { CopilotCliRunner, CopilotCliLogger } from '../agent/copilotCliRunner';
import { aggregateMetrics } from './metricsAggregator';
import { powerManager } from '../core/powerManager';

const log = Logger.for('plan-runner');

/**
 * Events emitted by the {@link PlanRunner}.
 *
 * Subscribe with `runner.on('planCreated', handler)`.
 *
 * @example
 * ```typescript
 * runner.on('planCompleted', (plan, status) => {
 *   console.log(`Plan ${plan.spec.name} finished with status ${status}`);
 * });
 * ```
 */
/**
 * Info about a dependency node, used for FI merge logging.
 */
interface DependencyInfo {
  nodeId: string;
  nodeName: string;
  commit: string;
  workSummary?: JobWorkSummary;
}

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

/**
 * Strategy interface for executing individual job nodes.
 *
 * Implement this to control *how* jobs run (e.g. local process, remote CI,
 * container). The default implementation is {@link DefaultJobExecutor}.
 */
export interface JobExecutor {
  /**
   * Execute a job within the given context.
   *
   * @param context - Execution context including plan, node, worktree, and abort signal.
   * @returns Result indicating success/failure, optional commit SHA, and work summary.
   */
  execute(context: ExecutionContext): Promise<JobExecutionResult>;

  /**
   * Request cancellation of a running job.
   *
   * @param planId - The plan the job belongs to.
   * @param nodeId - The node to cancel.
   */
  cancel(planId: string, nodeId: string): void;

  /**
   * Retrieve in-memory logs for a job execution.
   *
   * @param planId - Plan ID.
   * @param nodeId - Node ID.
   * @returns Array of log entries, or empty if unavailable.
   */
  getLogs?(planId: string, nodeId: string): LogEntry[];

  /**
   * Retrieve logs filtered to a specific execution phase.
   *
   * @param planId - Plan ID.
   * @param nodeId - Node ID.
   * @param phase  - The execution phase to filter by.
   * @returns Filtered log entries.
   */
  getLogsForPhase?(planId: string, nodeId: string, phase: ExecutionPhase): LogEntry[];

  /**
   * Get the current size of the log file for a job execution.
   *
   * @param planId - Plan ID.
   * @param nodeId - Node ID.
   * @returns File size in bytes, or 0 if unavailable.
   */
  getLogFileSize?(planId: string, nodeId: string): number;

  /**
   * Get the file path for the log file of a job execution.
   *
   * @param planId - Plan ID.
   * @param nodeId - Node ID.
   * @param attemptNumber - Optional 1-based attempt number for specific attempt's log.
   * @returns Absolute path to the log file, or undefined if unavailable.
   */
  getLogFilePath?(planId: string, nodeId: string, attemptNumber?: number): string | undefined;

  /**
   * Append a log entry to a job's execution log.
   *
   * @param planId  - Plan ID.
   * @param nodeId  - Node ID.
   * @param phase   - Current execution phase.
   * @param type    - Log level.
   * @param message - Log message text.
   * @param attemptNumber - Optional attempt number for per-attempt log files.
   */
  log?(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string, attemptNumber?: number): void;

  /**
   * Compute aggregated work summary from baseBranch to current HEAD.
   * This captures ALL work accumulated through the DAG, not just this job's work.
   * Used for leaf nodes to show total work being merged to targetBranch.
   *
   * @param node - The job node.
   * @param worktreePath - Path to the worktree.
   * @param baseBranch - Base branch name (e.g., 'main' or 'origin/main').
   * @param repoPath - Path to the main repository.
   * @returns Aggregated work summary.
   */
  computeAggregatedWorkSummary?(
    node: JobNode,
    worktreePath: string,
    baseBranch: string,
    repoPath: string
  ): Promise<JobWorkSummary>;
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
 * Options for retrying a failed node
 */
export interface RetryNodeOptions {
  /** New work spec to replace/augment original. Can be string, process, shell, or agent spec */
  newWork?: WorkSpec;
  /** New prechecks spec to replace original */
  newPrechecks?: WorkSpec | null;
  /** New postchecks spec to replace original (use null to remove postchecks) */
  newPostchecks?: WorkSpec | null;
  /** Reset worktree to base commit (default: false) */
  clearWorktree?: boolean;
}

/**
 * Central orchestrator for Plan execution.
 *
 * Combines plan building, state-machine management, scheduling, executor
 * delegation, persistence, and git merge operations (FI / RI).
 *
 * Lifecycle: {@link initialize} → {@link enqueue} → pump loop → {@link shutdown}.
 *
 * @example
 * ```typescript
 * const runner = new PlanRunner({ storagePath: '/tmp/plans' });
 * runner.setExecutor(new DefaultJobExecutor());
 * await runner.initialize();
 *
 * const plan = runner.enqueue(mySpec);
 * runner.on('planCompleted', (p, status) => console.log(status));
 * ```
 */
export class PlanRunner extends EventEmitter {
  private plans = new Map<string, PlanInstance>();
  private stateMachines = new Map<string, PlanStateMachine>();
  private scheduler: PlanScheduler;
  private persistence: PlanPersistence;
  private executor?: JobExecutor;
  private pumpTimer?: NodeJS.Timeout;
  private config: PlanRunnerConfig;
  private isRunning = false;
  private globalCapacity?: GlobalCapacityManager;
  private readonly _fileWatcher: OrchestratorFileWatcher;
  private readonly processMonitor = new ProcessMonitor();
  
  /**
   * Mutex for serializing Reverse Integration (RI) merges.
   * 
   * RI merges MUST be serialized because:
   * 1. Git's index lock prevents concurrent operations on the same repo
   *    (stash, reset --hard, checkout all acquire .git/index.lock)
   * 2. Concurrent merges that read the same target branch tip would create
   *    divergent merge commits — the second updateBranchRef would overwrite
   *    the first, silently losing its changes.
   * 
   * By serializing, each RI merge sees the latest target branch state
   * (including all prior RI merges) and creates its commit on top.
   */
  private riMergeMutex: Promise<void> = Promise.resolve();
  
  /**
   * Wake lock cleanup function - prevents system sleep during plan execution
   */
  private wakeLockCleanup?: () => void;
  private _acquiringWakeLock = false;
  
  constructor(config: PlanRunnerConfig) {
    super();
    this.config = config;
    this.scheduler = new PlanScheduler({
      globalMaxParallel: config.maxParallel || 8,
    });
    this.persistence = new PlanPersistence(config.storagePath);
    
    // Watch for external plan file deletions
    // Extract workspace path from storagePath (remove 'plans' suffix if present)
    const workspacePath = config.storagePath.endsWith('plans') 
      ? path.dirname(config.storagePath)
      : config.storagePath;
    this._fileWatcher = new OrchestratorFileWatcher(
      workspacePath,
      (planId) => this._handleExternalPlanDeletion(planId)
    );
  }
  
  /**
   * Inject the job executor strategy.
   * Must be called before {@link initialize} or the pump loop will be inert.
   *
   * @param executor - The executor implementation to use for running jobs.
   */
  setExecutor(executor: JobExecutor): void {
    this.executor = executor;
  }
  
  /**
   * Set the global capacity manager for cross-instance coordination.
   * 
   * @param manager - The global capacity manager instance
   */
  setGlobalCapacityManager(manager: GlobalCapacityManager): void {
    this.globalCapacity = manager;
  }
  
  /**
   * Log a message to the executor (helper for merge operations)
   */
  private execLog(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string, attemptNumber?: number): void {
    if (this.executor?.log) {
      this.executor.log(planId, nodeId, phase, type, message, attemptNumber);
    }
  }
  
  /**
   * Recover nodes that were running when the extension restarted.
   * 
   * When the extension restarts, nodes that were in "running" state may have
   * their processes terminated. This method checks if processes are still alive
   * and marks crashed nodes as failed.
   * 
   * @param plan - Plan to recover running nodes for
   */
  private async recoverRunningNodes(plan: PlanInstance): Promise<void> {
    for (const [nodeId, nodeState] of plan.nodeStates.entries()) {
      if (nodeState.status === 'running') {
        // Check if the process is still alive
        if (nodeState.pid && !this.processMonitor.isRunning(nodeState.pid)) {
          // Process died unexpectedly - mark as crashed
          log.warn(`Node ${nodeId} process (PID ${nodeState.pid}) not found - marking as crashed`);
          nodeState.status = 'failed';
          nodeState.error = `Process crashed or was terminated unexpectedly (PID: ${nodeState.pid})`;
          nodeState.failureReason = 'crashed';
          nodeState.endedAt = Date.now();
          nodeState.pid = undefined;  // Clear the stale PID
          nodeState.version++; // Increment version for UI updates
          
          // Emit completion event
          this.emit('nodeCompleted', plan.id, nodeId, false);
        } else if (!nodeState.pid) {
          // Running but no PID tracked (old state) - also mark as crashed
          log.warn(`Node ${nodeId} was running but has no PID - marking as crashed`);
          nodeState.status = 'failed';
          nodeState.error = 'Extension reloaded while node was running (no process tracking)';
          nodeState.failureReason = 'crashed';
          nodeState.endedAt = Date.now();
          nodeState.version++; // Increment version for UI updates
          
          // Emit completion event
          this.emit('nodeCompleted', plan.id, nodeId, false);
        }
        // If process IS running, leave it - the process monitor should re-attach
      }
    }
  }

  /**
   * Initialize the runner — loads persisted Plans from disk and starts
   * the periodic pump loop that advances execution.
   *
   * @throws If persistence storage is inaccessible.
   */
  async initialize(): Promise<void> {
    log.info('Initializing Plan Runner');
    
    // Load persisted Plans
    const loadedPlans = this.persistence.loadAll();
    for (const plan of loadedPlans) {
      // Validate and recover running nodes before setting up state machines
      await this.recoverRunningNodes(plan);
      
      this.plans.set(plan.id, plan);
      const sm = new PlanStateMachine(plan);
      this.setupStateMachineListeners(sm);
      this.stateMachines.set(plan.id, sm);
    }
    
    log.info(`Loaded ${loadedPlans.length} Plans from persistence`);
    
    // Persist any recovery changes
    for (const plan of this.plans.values()) {
      this.persistence.save(plan);
    }
    
    // Start the pump
    this.startPump();
    this.isRunning = true;
  }
  
  /**
   * Gracefully shut down the runner — stops the pump loop and
   * persists all in-flight Plan state to disk.
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down Plan Runner');
    this.stopPump();
    
    // Persist all Plans
    for (const plan of this.plans.values()) {
      this.persistence.save(plan);
    }
    
    // Dispose file watcher
    this._fileWatcher.dispose();
    
    this.isRunning = false;
  }
  
  /**
   * Persist all Plan state synchronously.
   * Intended for emergency / process-exit scenarios where async I/O is unsafe.
   */
  persistSync(): void {
    for (const plan of this.plans.values()) {
      this.persistence.saveSync(plan);
    }
  }
  
  /**
   * Get global capacity statistics for UI display.
   * 
   * @returns Global capacity stats or null if global capacity is not enabled
   */
  async getGlobalCapacityStats(): Promise<GlobalCapacityStats | null> {
    return (await this.globalCapacity?.getStats()) || null;
  }
  
  // ============================================================================
  // Plan CREATION
  // ============================================================================
  
  /**
   * Create and enqueue a Plan from a specification.
   * 
   * @param spec - The Plan specification
   * @returns The created Plan instance
   * @throws PlanValidationError if the spec is invalid
   */
  enqueue(spec: PlanSpec): PlanInstance {
    log.info(`Creating Plan: ${spec.name}`, {
      jobs: spec.jobs.length,
    });
    
    // Build the Plan
    const plan = buildPlan(spec, {
      repoPath: spec.repoPath || this.config.defaultRepoPath,
    });
    
    // Ensure main repo's .gitignore includes orchestrator temp files
    git.gitignore.ensureGitignoreEntries(plan.repoPath).catch((err: any) => {
      log.warn(`Failed to update main repo .gitignore: ${err.message}`);
    });
    
    // Store the Plan
    this.plans.set(plan.id, plan);
    
    // Start paused by default (plans default to true, single jobs default to false)
    const shouldPause = spec.startPaused !== undefined ? spec.startPaused : true;
    if (shouldPause) {
      plan.isPaused = true;
    }
    
    // Create state machine
    const sm = new PlanStateMachine(plan);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(plan.id, sm);
    
    // Persist
    this.persistence.save(plan);
    
    // Emit event
    this.emit('planCreated', plan);
    
    log.info(`Plan created: ${plan.id}`, {
      name: spec.name,
      nodes: plan.nodes.size,
      roots: plan.roots.length,
      leaves: plan.leaves.length,
      paused: shouldPause,
    });
    
    return plan;
  }
  
  /**
   * Create a simple single-job plan.
   * Convenience method for backwards compatibility with job-only workflows.
   *
   * @param jobSpec - Minimal job definition (name, task, optional work/checks).
   * @returns The created single-node {@link PlanInstance}.
   */
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
  }): PlanInstance {
    const plan = buildSingleJobPlan(jobSpec, {
      repoPath: this.config.defaultRepoPath,
    });
    
    // Single jobs default to running (startPaused: false) unless explicitly paused
    if (jobSpec.startPaused === true) {
      plan.isPaused = true;
    }
    
    // Store and setup
    this.plans.set(plan.id, plan);
    const sm = new PlanStateMachine(plan);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(plan.id, sm);
    
    // Persist
    this.persistence.save(plan);
    
    // Emit event
    this.emit('planCreated', plan);
    
    log.info(`Single-job Plan created: ${plan.id}`, { name: jobSpec.name });
    
    return plan;
  }
  
  // ============================================================================
  // Plan QUERIES
  // ============================================================================
  
  /**
   * Get a Plan by ID.
   *
   * @param planId - Unique plan identifier (UUID).
   * @returns The plan instance, or `undefined` if not found.
   */
  get(planId: string): PlanInstance | undefined {
    return this.plans.get(planId);
  }
  
  /**
   * Get all registered Plans (active and completed).
   *
   * @returns Array of every known plan instance.
   */
  getAll(): PlanInstance[] {
    return Array.from(this.plans.values());
  }
  
  /**
   * Filter Plans by their computed status.
   *
   * @param status - The plan status to filter on.
   * @returns Plans whose current computed status matches.
   */
  getByStatus(status: PlanStatus): PlanInstance[] {
    return Array.from(this.plans.values()).filter(plan => {
      const sm = this.stateMachines.get(plan.id);
      return sm?.computePlanStatus() === status;
    });
  }
  
  /**
   * Get the state machine for a Plan.
   *
   * @param planId - Plan identifier.
   * @returns The state machine, or `undefined` if the plan is unknown.
   */
  getStateMachine(planId: string): PlanStateMachine | undefined {
    return this.stateMachines.get(planId);
  }
  
  /**
   * Get Plan status along with node counts and a 0–1 progress ratio.
   *
   * @param planId - Plan identifier.
   * @returns Status snapshot, or `undefined` if the plan is unknown.
   */
  getStatus(planId: string): {
    plan: PlanInstance;
    status: PlanStatus;
    counts: Record<NodeStatus, number>;
    progress: number;
  } | undefined {
    const plan = this.plans.get(planId);
    const sm = this.stateMachines.get(planId);
    if (!plan || !sm) return undefined;
    
    const counts = sm.getStatusCounts();
    const progress = computeProgress(counts, plan.nodes.size);
    
    return {
      plan,
      status: sm.computePlanStatus(),
      counts,
      progress,
    };
  }
  
  /**
   * Get global execution statistics:
   * - Total running jobs across all plans
   * - Global max parallel limit
   * - Jobs waiting in queue (ready but blocked by limit)
   */
  getGlobalStats(): {
    running: number;
    maxParallel: number;
    queued: number;
  } {
    let running = 0;
    let queued = 0;
    
    for (const [planId, plan] of this.plans) {
      const sm = this.stateMachines.get(planId);
      if (!sm) continue;
      
      for (const [nodeId, state] of plan.nodeStates) {
        const node = plan.nodes.get(nodeId);
        if (!node) continue;
        
        // Count job nodes
        if (nodePerformsWork(node)) {
          if (state.status === 'running' || state.status === 'scheduled') {
            running++;
          } else if (state.status === 'ready') {
            queued++;
          }
        }
      }
    }
    
    return {
      running,
      maxParallel: this.scheduler.getGlobalMaxParallel(),
      queued,
    };
  }
  
  /**
   * Get the effective endedAt for a plan.
   * 
   * @param planId - The plan ID
   * @returns The maximum endedAt across all nodes
   */
  getEffectiveEndedAt(planId: string): number | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;
    
    let maxEndedAt: number | undefined;
    
    for (const [, state] of plan.nodeStates) {
      if (state.endedAt && (!maxEndedAt || state.endedAt > maxEndedAt)) {
        maxEndedAt = state.endedAt;
      }
    }
    
    return maxEndedAt;
  }
  
  /**
   * Get recursive status counts including all child plans.
   * This counts all work nodes across the entire plan hierarchy.
   * 
   * @param planId - Plan identifier
   * @returns Object with totalNodes and counts for each status
   */
  getRecursiveStatusCounts(planId: string): {
    totalNodes: number;
    counts: Record<NodeStatus, number>;
  } {
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    
    const result = { totalNodes: 0, counts: { ...defaultCounts } };
    this.computeRecursiveStatusCounts(planId, result);
    return result;
  }
  
  /**
   * Recursively compute status counts across a plan and all child plans.
   */
  private computeRecursiveStatusCounts(
    planId: string, 
    result: { totalNodes: number; counts: Record<NodeStatus, number> }
  ): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    
    for (const [, state] of plan.nodeStates) {
      result.totalNodes++;
      result.counts[state.status]++;
    }
  }
  
  /**
   * Get the effective startedAt for a plan (minimum startedAt across all nodes).
   * This represents when the first child actually started execution.
   * 
   * @param planId - The plan ID
   * @returns The minimum startedAt across all nodes, or undefined if no nodes started
   */
  getEffectiveStartedAt(planId: string): number | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;
    
    let minStartedAt: number | undefined;
    
    for (const [, state] of plan.nodeStates) {
      if (state.startedAt && (!minStartedAt || state.startedAt < minStartedAt)) {
        minStartedAt = state.startedAt;
      }
    }
    
    return minStartedAt;
  }
  
  /**
   * Get execution logs for a node, optionally filtered to a single phase.
   *
   * Falls back to on-disk log files when in-memory logs have been evicted.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @param phase  - Phase to filter by, or `'all'` / `undefined` for everything.
   * @param attemptNumber - Optional attempt number for per-attempt log files.
   * @returns Formatted log text.
   */
  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase, attemptNumber?: number): string {
    if (!this.executor) return 'No executor available.';
    
    // First try memory logs
    let logs: LogEntry[] = [];
    if (phase && phase !== 'all' && this.executor.getLogsForPhase) {
      logs = this.executor.getLogsForPhase(planId, nodeId, phase);
    } else if (this.executor.getLogs) {
      logs = this.executor.getLogs(planId, nodeId);
    }
    
    if (logs.length > 0) {
      return formatLogEntries(logs);
    }
    
    // Try reading from log file (use attempt number if provided)
    if ('readLogsFromFile' in this.executor && typeof (this.executor as any).readLogsFromFile === 'function') {
      const fileContent = (this.executor as any).readLogsFromFile(planId, nodeId, attemptNumber);
      if (fileContent && !fileContent.startsWith('No log file')) {
        // Filter by phase if requested
        if (phase && phase !== 'all') {
          const phaseMarker = `[${phase.toUpperCase()}]`;
          const lines = fileContent.split('\n').filter((line: string) => line.includes(phaseMarker));
          return lines.length > 0 ? lines.join('\n') : `No logs for ${phase} phase.`;
        }
        return fileContent;
      }
    }
    
    return 'No logs available.';
  }
  
  /**
   * Get the file path for a node's execution log.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns Absolute path to the log file, or undefined if unavailable.
   */
  getNodeLogFilePath(planId: string, nodeId: string, attemptNumber?: number): string | undefined {
    if (!this.executor?.getLogFilePath) return undefined;
    return this.executor.getLogFilePath(planId, nodeId, attemptNumber);
  }
  
  /**
   * Get execution logs for a node starting from a given offset.
   *
   * Used to capture only the logs produced during the current attempt,
   * avoiding accumulation of logs from previous attempts.
   *
   * @param planId         - Plan identifier.
   * @param nodeId         - Node identifier.
   * @param memoryOffset   - Index into the in-memory log array to start from.
   * @param fileByteOffset - Byte offset into the on-disk log file to start from.
   * @param attemptNumber  - Optional attempt number for per-attempt log files.
   * @returns Formatted log text for the current attempt only.
   */
  private getNodeLogsFromOffset(planId: string, nodeId: string, memoryOffset: number, fileByteOffset: number, attemptNumber?: number): string {
    if (!this.executor) return 'No executor available.';
    
    // First try memory logs (sliced from offset)
    if (this.executor.getLogs) {
      const allLogs = this.executor.getLogs(planId, nodeId);
      if (allLogs.length > 0) {
        const sliced = allLogs.slice(memoryOffset);
        return sliced.length > 0 ? formatLogEntries(sliced) : 'No logs available.';
      }
    }
    
    // Try reading from log file (from byte offset)
    if ('readLogsFromFileOffset' in this.executor && typeof (this.executor as any).readLogsFromFileOffset === 'function') {
      const fileContent = (this.executor as any).readLogsFromFileOffset(planId, nodeId, fileByteOffset, attemptNumber) as string;
      if (fileContent && !fileContent.startsWith('No log file')) {
        return fileContent;
      }
    }
    
    return 'No logs available.';
  }
  
  /**
   * Get details for a specific execution attempt of a node.
   *
   * @param planId        - Plan identifier.
   * @param nodeId        - Node identifier.
   * @param attemptNumber - 1-based attempt number.
   * @returns The attempt record, or `null` if not found.
   */
  getNodeAttempt(planId: string, nodeId: string, attemptNumber: number): AttemptRecord | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    
    const state = plan.nodeStates.get(nodeId);
    if (!state || !state.attemptHistory) return null;
    
    return state.attemptHistory.find(a => a.attemptNumber === attemptNumber) || null;
  }
  
  /**
   * Get the full attempt history for a node.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns Array of attempt records, empty if the node has no history.
   */
  getNodeAttempts(planId: string, nodeId: string): AttemptRecord[] {
    const plan = this.plans.get(planId);
    if (!plan) return [];
    
    const state = plan.nodeStates.get(nodeId);
    return state?.attemptHistory || [];
  }
  
  /**
   * Get OS-level process stats (PID, tree, duration) for a running node.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns Process information; fields are `null` when the process is not tracked.
   */
  async getProcessStats(planId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: any[];
    duration: number | null;
  }> {
    if (!this.executor) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    
    if ('getProcessStats' in this.executor && typeof (this.executor as any).getProcessStats === 'function') {
      return (this.executor as any).getProcessStats(planId, nodeId);
    }
    
    return { pid: null, running: false, tree: [], duration: null };
  }
  
  /**
   * Get process stats for all running nodes in a Plan, including sub-plans.
   *
   * Uses a single OS process snapshot for efficiency instead of per-node queries.
   *
   * @param planId - Root plan identifier.
   * @returns Flat list and hierarchical structure of running process information.
   */
  async getAllProcessStats(planId: string): Promise<{
    flat: Array<{
      nodeId: string;
      nodeName: string;
      planId?: string;
      planName?: string;
      pid: number | null;
      running: boolean;
      tree: any[];
      duration: number | null;
    }>;
    hierarchy: Array<{
      planId: string;
      planName: string;
      status: string;
      jobs: Array<{
        nodeId: string;
        nodeName: string;
        status: string;
        pid: number | null;
        running: boolean;
        tree: any[];
        duration: number | null;
      }>;
      children: any[]; // Nested sub-plans
    }>;
  }> {
    const plan = this.plans.get(planId);
    if (!plan || !this.executor) return { flat: [], hierarchy: [] };
    
    // Collect all running/scheduled job node keys for batch process fetch
    const nodeKeys: Array<{ planId: string; nodeId: string; nodeName: string; planName?: string }> = [];
    
    // Build hierarchical structure recursively
    const buildHierarchy = (d: PlanInstance, parentPath?: string): any => {
      const sm = this.stateMachines.get(d.id);
      const planStatus = sm?.computePlanStatus() || 'pending';
      
      const planPath = parentPath ? `${parentPath} → ${d.spec.name}` : d.spec.name;
      
      const jobs: any[] = [];
      const children: any[] = [];
      
      for (const [nodeId, state] of d.nodeStates) {
        const node = d.nodes.get(nodeId);
        if (!node) continue;
        
        // For job nodes that are running/scheduled
        if (node.type === 'job' && (state.status === 'running' || state.status === 'scheduled')) {
          nodeKeys.push({
            planId: d.id,
            nodeId,
            nodeName: node.name || nodeId.slice(0, 8),
            planName: parentPath ? planPath : undefined
          });
          
          jobs.push({
            nodeId,
            nodeName: node.name || nodeId.slice(0, 8),
            status: state.status,
            pid: null, // Will be filled after batch fetch
            running: false,
            tree: [],
            duration: null
          });
        }
      }
      
      // Return if there are jobs or active children (don't skip parent just because it has no running jobs)
      if (jobs.length === 0 && children.length === 0) {
        return null;
      }
      
      return {
        planId: d.id,
        planName: d.spec.name,
        parentPath: parentPath, // Include parent path for context
        status: planStatus,
        jobs,
        children
      };
    };
    
    // Build hierarchy starting from root Plan (but only include sub-plans in the output)
    const rootHierarchy: any[] = [];
    
    // For root Plan, collect jobs directly (not wrapped in a sub-plan node)
    const rootJobs: any[] = [];
    for (const [nodeId, state] of plan.nodeStates) {
      const node = plan.nodes.get(nodeId);
      if (!node) continue;
      
      if (node.type === 'job' && (state.status === 'running' || state.status === 'scheduled')) {
        nodeKeys.push({
          planId: plan.id,
          nodeId,
          nodeName: node.name || nodeId.slice(0, 8),
          planName: undefined
        });
        
        rootJobs.push({
          nodeId,
          nodeName: node.name || nodeId.slice(0, 8),
          status: state.status,
          pid: null,
          running: false,
          tree: [],
          duration: null
        });
      }
    }
    
    // Fetch process stats in batch
    let processStats: Map<string, any> = new Map();
    if (nodeKeys.length > 0 && 'getAllProcessStats' in this.executor) {
      try {
        const stats = await (this.executor as any).getAllProcessStats(nodeKeys);
        // Use planId/nodeId from each result to build map key
        // (results may skip entries when executions aren't found, so index doesn't match input)
        for (const stat of stats) {
          const key = `${stat.planId}:${stat.nodeId}`;
          processStats.set(key, stat);
        }
      } catch {
        // Fallback: individual fetches
      }
    }
    
    // Fill in process stats for root jobs
    for (const job of rootJobs) {
      const key = `${plan.id}:${job.nodeId}`;
      const stats = processStats.get(key);
      if (stats) {
        job.pid = stats.pid;
        job.running = stats.running;
        job.tree = stats.tree;
        job.duration = stats.duration;
      }
    }
    
    // Fill in process stats for hierarchy (recursive)
    const fillStats = (h: any) => {
      for (const job of h.jobs) {
        const key = `${h.planId}:${job.nodeId}`;
        const stats = processStats.get(key);
        if (stats) {
          job.pid = stats.pid;
          job.running = stats.running;
          job.tree = stats.tree;
          job.duration = stats.duration;
        }
      }
      for (const child of h.children) {
        fillStats(child);
      }
    };
    
    for (const h of rootHierarchy) {
      fillStats(h);
    }
    
    // Build flat list for backwards compatibility
    const flat: any[] = [];
    for (const job of rootJobs) {
      if (job.running || job.pid) {
        flat.push({
          nodeId: job.nodeId,
          nodeName: job.nodeName,
          planId: plan.id,
          planName: undefined,
          pid: job.pid,
          running: job.running,
          tree: job.tree,
          duration: job.duration
        });
      }
    }
    
    const collectFlat = (h: any, path?: string) => {
      const planPath = path ? `${path} → ${h.planName}` : h.planName;
      for (const job of h.jobs) {
        if (job.running || job.pid) {
          flat.push({
            nodeId: job.nodeId,
            nodeName: job.nodeName,
            planId: h.planId,
            planName: planPath,
            pid: job.pid,
            running: job.running,
            tree: job.tree,
            duration: job.duration
          });
        }
      }
      for (const child of h.children) {
        collectFlat(child, planPath);
      }
    };
    
    for (const h of rootHierarchy) {
      collectFlat(h);
    }
    
    return {
      flat,
      hierarchy: rootHierarchy,
      // Include root jobs separately for display
      rootJobs
    } as any;
  }
  
  // ============================================================================
  // Plan CONTROL
  // ============================================================================
  
  /**
   * Pause a Plan - stops scheduling new work but preserves worktrees for resume.
   * Running nodes will complete but no new nodes will be started.
   *
   * @param planId - Plan identifier.
   * @returns `true` if the plan was found and paused.
   */
  pause(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;
    
    if (plan.isPaused) {
      log.info(`Plan already paused: ${planId}`);
      return true;
    }
    
    log.info(`Pausing Plan: ${planId}`);
    plan.isPaused = true;
    
    // Persist
    this.persistence.save(plan);
    this.emit('planUpdated', planId);
    
    // Update wake lock in case this was the last running plan
    this.updateWakeLock().catch(err => log.warn('Failed to update wake lock', { error: err }));
    
    return true;
  }
  
  /**
   * Cancel all non-terminal nodes in a Plan, signal running executors to abort,
   * and clean up all worktrees since canceled plans cannot be resumed.
   *
   * @param planId - Plan identifier.
   * @param options - Optional cancellation options
   * @returns `true` if the plan was found and cancellation initiated.
   */
  cancel(planId: string, options?: { skipPersist?: boolean }): boolean {
    const plan = this.plans.get(planId);
    const sm = this.stateMachines.get(planId);
    if (!plan || !sm) return false;
    
    const cancelStack = new Error().stack;
    log.info(`Canceling Plan: ${planId}`, {
      stack: cancelStack?.split('\n').slice(1, 5).join('\n'),
    });
    
    // Cancel all running jobs in executor
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'running' || state.status === 'scheduled') {
        log.info(`Canceling node via executor`, { planId, nodeId, status: state.status });
        this.executor?.cancel(planId, nodeId);
      }
    }
    
    // Cancel all non-terminal nodes
    sm.cancelAll();
    
    // Clean up worktrees in background (since cancel is terminal, we don't need them)
    log.info(`Starting cleanup of canceled Plan resources`, { planId });
    this.cleanupPlanResources(plan).catch(err => {
      log.error(`Failed to cleanup canceled Plan resources`, { planId, error: err.message });
    });
    
    // Persist (unless skipped, e.g., when file is already deleted)
    if (!options?.skipPersist) {
      this.persistence.save(plan);
    }
    
    // Update wake lock in case this was the last running plan
    this.updateWakeLock().catch(err => log.warn('Failed to update wake lock', { error: err }));
    
    return true;
  }

  /**
   * Handle external deletion of a plan file.
   * 
   * Called by the file watcher when a plan JSON is deleted from the
   * filesystem (e.g., by `git clean -dfx`).
   * 
   * @param planId - ID of the deleted plan
   */
  private _handleExternalPlanDeletion(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) {
      // Plan wasn't in memory, nothing to do
      log.debug(`External deletion of unknown plan: ${planId}`);
      return;
    }
    
    log.warn(`Plan ${planId} ("${plan.spec.name}") was deleted externally`);
    
    // Get state machine to check plan status
    const sm = this.stateMachines.get(planId);
    if (sm && sm.computePlanStatus() === 'running') {
      log.warn(`Canceling running plan due to external file deletion`);
      // Cancel without trying to persist (file is already gone)
      this.cancel(planId, { skipPersist: true });
    }
    
    // Remove from in-memory state
    this.plans.delete(planId);
    this.stateMachines.delete(planId);
    
    // Fire deletion event (UI will update)
    this.emit('planDeleted', planId);
    
    // Show notification to user
    if (vscode) {
      vscode.window.showWarningMessage(
        `Plan "${plan.spec.name}" was deleted externally and has been removed.`
      );
    }
  }

  /**
   * Delete a Plan and clean up all associated resources (worktrees, logs, child plans).
   *
   * Running nodes are canceled before deletion. Resource cleanup runs in the background.
   *
   * @param planId - Plan identifier.
   * @returns `true` if the plan existed and was deleted.
   */
  delete(planId: string): boolean {
    // 1. Clear in-memory state FIRST (ensures UI updates)
    const hadPlan = this.plans.has(planId);
    if (!hadPlan) return false;
    
    const plan = this.plans.get(planId)!;
    log.info(`Deleting Plan: ${planId}`);
    
    // Cancel if running
    this.cancel(planId);
    
    // Remove from memory immediately
    this.plans.delete(planId);
    this.stateMachines.delete(planId);
    
    // 2. Fire event (UI will update even if FS fails)
    this.emit('planDeleted', planId);
    
    // 3. Attempt FS cleanup (ignore if already gone)
    try {
      this.persistence.delete(planId);
    } catch (err) {
      // Log unexpected errors but don't throw
      log.warn(`Failed to delete plan file: ${err}`);
    }
    
    // 4. Clean up worktrees and other resources (best effort)
    this.cleanupPlanResources(plan).catch(err => {
      log.error(`Failed to cleanup Plan resources`, { planId, error: err.message });
    });
    
    return true;
  }
  
  /**
   * Clean up all resources associated with a Plan (worktrees, logs)
   * 
   * NOTE: With detached HEAD worktrees, there are no branches to clean up.
   * We only remove worktrees and log files.
   */
  private async cleanupPlanResources(plan: PlanInstance): Promise<void> {
    const repoPath = plan.repoPath;
    const cleanupErrors: string[] = [];
    const cleanupStack = new Error().stack;
    
    // Collect all worktree paths from node states
    const worktreePaths: string[] = [];
    
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.worktreePath) {
        worktreePaths.push(state.worktreePath);
      }
    }
    
    log.info(`Cleaning up Plan resources`, {
      planId: plan.id,
      worktrees: worktreePaths.length,
      stack: cleanupStack?.split('\n').slice(1, 5).join('\n'),
    });
    
    // Remove worktrees (detached HEAD - no branches to clean up)
    for (const worktreePath of worktreePaths) {
      try {
        await git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
        log.debug(`Removed worktree: ${worktreePath}`);
      } catch (error: any) {
        cleanupErrors.push(`worktree ${worktreePath}: ${error.message}`);
      }
    }
    
    // Note: worktreeRoot (.worktrees) is shared across plans, so we don't try to remove it
    
    // Clean up log files
    // Log files are stored as flat files at {storagePath}/logs/{planId}_{nodeId}.log
    // (the executionKey "planId:nodeId" has ":" replaced with "_" by getLogFilePath)
    if (this.executor) {
      try {
        const fs = require('fs');
        const path = require('path');
        const storagePath = (this.executor as any).storagePath;
        if (storagePath) {
          const logsDir = path.join(storagePath, 'logs');
          if (fs.existsSync(logsDir)) {
            const safePlanId = plan.id.replace(/[^a-zA-Z0-9-_]/g, '_');
            const files = fs.readdirSync(logsDir) as string[];
            let removedCount = 0;
            for (const file of files) {
              if (file.startsWith(safePlanId + '_') && file.endsWith('.log')) {
                try {
                  fs.unlinkSync(path.join(logsDir, file));
                  removedCount++;
                } catch (e: any) {
                  cleanupErrors.push(`log file ${file}: ${e.message}`);
                }
              }
            }
            if (removedCount > 0) {
              log.debug(`Removed ${removedCount} log files for plan ${plan.id}`);
            }
          }
        }
      } catch (error: any) {
        cleanupErrors.push(`logs: ${error.message}`);
      }
    }
    
    if (cleanupErrors.length > 0) {
      log.warn(`Some cleanup operations failed`, { errors: cleanupErrors });
    } else {
      log.info(`Plan cleanup completed successfully`, { planId: plan.id });
    }
  }
  
  /**
   * Resume a paused or previously-completed-with-failures Plan.
   *
   * Clears `endedAt` so completion is recalculated and ensures the pump
   * loop is active to process any ready nodes.
   *
   * @param planId - Plan identifier.
   * @returns `true` if the plan was found and resumed.
   */
  async resume(planId: string): Promise<boolean> {
    const plan = this.plans.get(planId);
    if (!plan) return false;
    
    log.info(`Resuming Plan: ${planId}`);
    
    // Fetch latest refs so worktrees created after resume use current branch state
    try {
      await git.repository.fetch(plan.repoPath, { all: true });
      log.info(`Fetched latest refs for plan ${planId} before resuming`);
    } catch (e: any) {
      log.warn(`Git fetch failed before resume (continuing anyway): ${e.message}`);
    }
    
    // Clear paused state if set
    if (plan.isPaused) {
      plan.isPaused = false;
      this.emit('planUpdated', planId);
    }
    
    // Clear endedAt so it gets recalculated when the plan completes
    // This handles the case where the plan was previously marked complete
    if (plan.endedAt) {
      plan.endedAt = undefined;
    }
    
    // Ensure pump is running
    this.startPump();
    
    // Persist the current state
    this.persistence.save(plan);
    
    return true;
  }
  
  /**
   * Get a Plan by ID (alias exposed for external callers).
   *
   * @param planId - Plan identifier.
   * @returns The plan instance, or `undefined` if not found.
   */
  getPlan(planId: string): PlanInstance | undefined {
    return this.plans.get(planId);
  }
  
  // ============================================================================
  // PUMP LOOP
  // ============================================================================
  
  /**
   * Start the pump loop
   */
  private startPump(): void {
    if (this.pumpTimer) return;
    
    const interval = this.config.pumpInterval || 1000;
    this.pumpTimer = setInterval(() => this.pump(), interval);
    log.debug('Pump started', { interval });
  }
  
  /**
   * Stop the pump loop
   */
  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
      log.debug('Pump stopped');
    }
  }
  
  /**
   * Check if any plan is currently running
   */
  private hasRunningPlans(): boolean {
    for (const plan of this.plans.values()) {
      const sm = this.stateMachines.get(plan.id);
      const status = sm?.computePlanStatus();
      if (status === 'running') return true;
    }
    return false;
  }
  
  /**
   * Update wake lock state based on running plans
   */
  private async updateWakeLock(): Promise<void> {
    const hasRunning = this.hasRunningPlans();
    
    if (hasRunning && !this.wakeLockCleanup && !this._acquiringWakeLock) {
      // Acquire wake lock (guard against concurrent calls)
      this._acquiringWakeLock = true;
      try {
        this.wakeLockCleanup = await powerManager.acquireWakeLock('Copilot Plan execution in progress');
        log.info('Acquired wake lock - system sleep prevented');
      } catch (e) {
        log.warn('Failed to acquire wake lock', { error: e });
      } finally {
        this._acquiringWakeLock = false;
      }
    } else if (!hasRunning && this.wakeLockCleanup) {
      // Release wake lock
      this.wakeLockCleanup();
      this.wakeLockCleanup = undefined;
      log.info('Released wake lock - system sleep allowed');
    }
  }
  
  /**
   * Main pump loop - called periodically to advance Plan execution
   */
  private async pump(): Promise<void> {
    if (!this.executor) {
      return; // Can't do anything without an executor
    }
    
    // Count local running jobs and collect active plan IDs
    let localRunning = 0;
    const activePlanIds: string[] = [];
    
    for (const [planId, plan] of this.plans) {
      const sm = this.stateMachines.get(planId);
      if (!sm) continue;
      
      const status = sm.computePlanStatus();
      if (status === 'running') {
        activePlanIds.push(planId);
      }
      
      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'running' || state.status === 'scheduled') {
          const node = plan.nodes.get(nodeId);
          if (node && nodePerformsWork(node)) {
            localRunning++;
          }
        }
      }
    }
    
    // Update global registry with our current count
    if (this.globalCapacity) {
      await this.globalCapacity.updateRunningJobs(localRunning, activePlanIds);
    }
    
    // Get global running count (includes other instances)
    const globalRunning = this.globalCapacity 
      ? await this.globalCapacity.getTotalGlobalRunning()
      : localRunning;
    
    // Log overall status periodically (only if there are active Plans)
    const totalPlans = this.plans.size;
    if (totalPlans > 0) {
      log.debug(`Pump: ${totalPlans} Plans, ${globalRunning} jobs running (${localRunning} local)`);
    }
    
    // Process each Plan
    for (const [planId, plan] of this.plans) {
      const sm = this.stateMachines.get(planId);
      if (!sm) continue;
      
      const status = sm.computePlanStatus();
      
      // Skip completed Plans
      if (status !== 'pending' && status !== 'running' && status !== 'paused') {
        continue;
      }
      
      // Skip paused Plans (don't schedule new work, but let running work complete)
      if (plan.isPaused) {
        continue;
      }
      
      // Mark Plan as started if not already
      if (!plan.startedAt && status === 'running') {
        plan.startedAt = Date.now();
        this.emit('planStarted', plan);
        // Acquire wake lock when plan starts running
        this.updateWakeLock().catch(err => log.warn('Failed to update wake lock', { error: err }));
      }
      
      // Safety net: promote any pending nodes whose dependencies are now met.
      // This handles edge cases like extension reload where persisted state
      // saved 'pending' before the in-memory transition to 'ready'.
      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'pending') {
          const node = plan.nodes.get(nodeId);
          if (node && sm.areDependenciesMet(nodeId)) {
            log.info(`Pump: promoting stuck pending node to ready: ${node.name}`);
            sm.resetNodeToPending(nodeId);
          }
        }
      }
      
      // Get nodes to schedule - pass only actual job running count (sub-plans don't consume job slots)
      const nodesToSchedule = this.scheduler.selectNodes(plan, sm, globalRunning);
      
      // Log if there are ready nodes but none scheduled (potential bottleneck)
      const readyNodes = sm.getReadyNodes();
      if (readyNodes.length > 0 && nodesToSchedule.length === 0) {
        const counts = sm.getStatusCounts();
        log.debug(`Plan ${plan.spec.name} (${planId.slice(0, 8)}): ${readyNodes.length} ready but 0 scheduled`, {
          globalRunning,
          planRunning: counts.running + counts.scheduled,
          planMaxParallel: plan.maxParallel,
        });
      }
      
      // Schedule each node
      for (const nodeId of nodesToSchedule) {
        const node = plan.nodes.get(nodeId);
        if (!node) continue;
        
        // Mark as scheduled
        sm.transition(nodeId, 'scheduled');
        
        // Execute job node
        this.executeJobNode(plan, sm, node);
      }
      
      // Persist after scheduling
      if (nodesToSchedule.length > 0) {
        this.persistence.save(plan);
      }
    }
  }
  
  /**
   * Execute a job node
   */
  private async executeJobNode(
    plan: PlanInstance,
    sm: PlanStateMachine,
    node: JobNode
  ): Promise<void> {
    const nodeState = plan.nodeStates.get(node.id);
    if (!nodeState) return;
    
    log.info(`Executing job node: ${node.name}`, {
      planId: plan.id,
      nodeId: node.id,
    });
    
    // Capture log offsets before this attempt starts so we can extract
    // only the logs produced during this attempt when creating AttemptRecord.
    let logMemoryOffset = this.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
    let logFileOffset = this.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;
    
    try {
      // Transition to running
      sm.transition(node.id, 'running');
      nodeState.attempts++;
      this.emit('nodeStarted', plan.id, node.id);
      
      // Determine base commits from dependencies (RI/FI model)
      // First commit is the base, additional commits are merged in
      const baseCommits = sm.getBaseCommitsForNode(node.id);
      const baseCommitish = baseCommits.length > 0 ? baseCommits[0] : plan.baseBranch;
      const additionalSources = baseCommits.slice(1);
      
      // Build dependency info map for enhanced logging
      const dependencyInfoMap = new Map<string, DependencyInfo>();
      for (const depId of node.dependencies) {
        const depNode = plan.nodes.get(depId);
        const depState = plan.nodeStates.get(depId);
        if (depNode && depState?.completedCommit) {
          dependencyInfoMap.set(depState.completedCommit, {
            nodeId: depId,
            nodeName: depNode.name,
            commit: depState.completedCommit,
            workSummary: depState.workSummary,
          });
        }
      }
      
      // Create worktree path using first 8 chars of node UUID (flat structure)
      // All worktrees are directly under .worktrees/<shortId> for simplicity
      const worktreePath = path.join(plan.worktreeRoot, node.id.slice(0, 8));
      
      // Store in state (no branchName since we use detached HEAD)
      nodeState.worktreePath = worktreePath;
      
      // Setup detached worktree (or reuse existing one for retries)
      // This is part of Forward Integration (merge-fi) phase
      log.debug(`Setting up worktree for job ${node.name} at ${worktreePath} from ${baseCommitish}`);
      let timing: Awaited<ReturnType<typeof git.worktrees.createOrReuseDetached>>;
      try {
        timing = await git.worktrees.createOrReuseDetached(
          plan.repoPath,
          worktreePath,
          baseCommitish,
          s => log.debug(s)
        );
      } catch (wtError: any) {
        // Worktree creation is part of FI phase - log and set correct phase
        this.execLog(plan.id, node.id, 'merge-fi', 'error', `Failed to create worktree: ${wtError.message}`, nodeState.attempts);
        if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
        nodeState.stepStatuses['merge-fi'] = 'failed';
        const fiError = new Error(wtError.message) as Error & { failedPhase: string };
        fiError.failedPhase = 'merge-fi';
        throw fiError;
      }
      
      if (timing.reused) {
        log.info(`Reusing existing worktree for ${node.name} (retry)`);
        // On retry, preserve the original base commit for validation
        // Don't overwrite with current HEAD which includes prior work
        // But if baseCommit is somehow missing, fall back to timing.baseCommit
        if (!nodeState.baseCommit) {
          nodeState.baseCommit = timing.baseCommit;
        }
      } else {
        // Only set baseCommit on fresh worktree creation
        nodeState.baseCommit = timing.baseCommit;
        if (timing.totalMs > 500) {
          log.warn(`Slow worktree creation for ${node.name} took ${timing.totalMs}ms`);
        }
        
        // Ensure .gitignore includes orchestrator temp files
        try {
          const modified = await git.gitignore.ensureGitignoreEntries(worktreePath);
          if (modified) {
            log.debug(`Updated .gitignore in worktree: ${worktreePath}`);
            // Stage the gitignore change so it's included in the work commit
            await git.executor.execAsync(['add', '.gitignore'], { cwd: worktreePath });
          }
        } catch (err: any) {
          log.warn(`Failed to update .gitignore: ${err.message}`);
        }
      }
      
      // Log dependency info in merge-fi phase (even if no additional merges needed)
      if (baseCommits.length > 0) {
        const baseShort = typeof baseCommitish === 'string' && baseCommitish.length === 40 
          ? baseCommitish.slice(0, 8) 
          : baseCommitish;
        
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE START ==========', nodeState.attempts);
        
        // Log the worktree base dependency with its work summary
        const baseDep = dependencyInfoMap.get(baseCommits[0]);
        if (baseDep) {
          this.execLog(plan.id, node.id, 'merge-fi', 'info', '', nodeState.attempts);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `[Worktree Base] ${baseDep.nodeName}`, nodeState.attempts);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `  Commit: ${baseShort} (from dependency "${baseDep.nodeName}")`, nodeState.attempts);
          
          // Show work summary from the dependency node
          this.logDependencyWorkSummary(plan.id, node.id, baseDep.workSummary, nodeState.attempts);
        } else {
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `Worktree base: ${baseShort} (from dependency)`, nodeState.attempts);
        }
        
        if (additionalSources.length > 0) {
          log.info(`Merging ${additionalSources.length} additional source commits for job ${node.name}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', '', nodeState.attempts);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `Merging ${additionalSources.length} additional source commit(s) into worktree...`, nodeState.attempts);
          
          const mergeSuccess = await this.mergeSourcesIntoWorktree(
            plan, node, worktreePath, additionalSources, dependencyInfoMap, nodeState.attempts
          );
          
          if (!mergeSuccess) {
            this.execLog(plan.id, node.id, 'merge-fi', 'error', 'Forward integration merge FAILED', nodeState.attempts);
            this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE END ==========', nodeState.attempts);
            if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
            nodeState.stepStatuses['merge-fi'] = 'failed';
            nodeState.error = 'Failed to merge sources from dependencies';
            
            // Record failed FI attempt in history
            const fiFailedAttempt: AttemptRecord = {
              attemptNumber: nodeState.attempts,
              triggerType: nodeState.attempts === 1 ? 'initial' : 'retry',
              status: 'failed',
              startedAt: nodeState.startedAt || Date.now(),
              endedAt: Date.now(),
              failedPhase: 'merge-fi',
              error: nodeState.error,
              copilotSessionId: nodeState.copilotSessionId,
              stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
              worktreePath: nodeState.worktreePath,
              baseCommit: nodeState.baseCommit,
              logs: this.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
              logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
              workUsed: node.work,
              metrics: nodeState.metrics,
              phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
            };
            nodeState.attemptHistory = [...(nodeState.attemptHistory || []), fiFailedAttempt];
            
            // Clear process ID since execution is complete
            nodeState.pid = undefined;
            
            sm.transition(node.id, 'failed');
            this.emit('nodeCompleted', plan.id, node.id, false);
            this.persistence.save(plan);
            return;
          }
          
          this.execLog(plan.id, node.id, 'merge-fi', 'info', '', nodeState.attempts);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', 'Forward integration merge succeeded', nodeState.attempts);
        } else {
          this.execLog(plan.id, node.id, 'merge-fi', 'info', '', nodeState.attempts);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', 'Single dependency - no additional merges needed', nodeState.attempts);
        }
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE END ==========', nodeState.attempts);
        if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
        nodeState.stepStatuses['merge-fi'] = 'success';
        
        // FI succeeded - acknowledge consumption to all dependencies
        // This allows dependency worktrees to be cleaned up as soon as all consumers have FI'd
        await this.acknowledgeConsumption(plan, sm, node);
      } else if (node.dependencies.length > 0) {
        // Has dependencies but none produced commits (all expectsNoChanges)
        // Still need to acknowledge consumption so those worktrees can be cleaned up
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION ==========', nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', `Worktree base: ${plan.baseBranch} (dependencies have no commits to merge)`, nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '===========================================', nodeState.attempts);
        if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
        nodeState.stepStatuses['merge-fi'] = 'success';
        
        await this.acknowledgeConsumption(plan, sm, node);
      } else {
        // Root node - no dependencies
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION ==========', nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', `Worktree base: ${plan.baseBranch} (root node, no dependencies)`, nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '===========================================', nodeState.attempts);
        if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
        nodeState.stepStatuses['merge-fi'] = 'success';
      }
      
      // Track whether executor succeeded (or was skipped for RI-only retry)
      let executorSuccess = false;
      let autoHealSucceeded = false; // Track if success came from auto-heal
      
      // Check if resuming from merge-ri phase - skip executor entirely
      if (nodeState.resumeFromPhase === 'merge-ri') {
        log.info(`Resuming from merge-ri phase - skipping executor for ${node.name}`);
        this.execLog(plan.id, node.id, 'work', 'info', '========== WORK PHASES (SKIPPED - RESUMING FROM RI) ==========', nodeState.attempts);
        // The completedCommit is already set from the previous successful work phase
        executorSuccess = true;
        // Clear resumeFromPhase since we're handling the retry now
        nodeState.resumeFromPhase = undefined;
      } else {
        // Build execution context
        // Use nodeState.baseCommit which is preserved across retries
        const context: ExecutionContext = {
          plan,
          node,
          baseCommit: nodeState.baseCommit!,
          worktreePath,
          attemptNumber: nodeState.attempts,
          copilotSessionId: nodeState.copilotSessionId, // Pass existing session for resumption
          resumeFromPhase: nodeState.resumeFromPhase, // Resume from failed phase
          previousStepStatuses: nodeState.stepStatuses, // Preserve completed phase statuses
          onProgress: (step) => {
            log.debug(`Job progress: ${node.name} - ${step}`);
          },
          onStepStatusChange: (phase, status) => {
            if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
            (nodeState.stepStatuses as any)[phase] = status;
          },
        };
        
        // Execute
        log.info(`[executeNode] Starting executor.execute for ${node.name}`, { planId: plan.id, nodeId: node.id });
        const result = await this.executor!.execute(context);
        log.info(`[executeNode] Executor returned: success=${result.success}, error=${result.error?.slice(0, 100) || 'none'}`, { planId: plan.id, nodeId: node.id });
        
        // Store step statuses for UI display
        if (result.stepStatuses) {
          nodeState.stepStatuses = result.stepStatuses;
        }
        
        // Store captured Copilot session ID for future resumption
        if (result.copilotSessionId) {
          nodeState.copilotSessionId = result.copilotSessionId;
        }
        
        // Store agent execution metrics
        if (result.metrics) {
          nodeState.metrics = result.metrics;
        }
        
        // Store per-phase metrics breakdown
        if (result.phaseMetrics) {
          nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...result.phaseMetrics };
        }
        
        // Store process ID for crash detection
        if (result.pid) {
          nodeState.pid = result.pid;
        }
        
        // Clear resumeFromPhase after execution (success or failure)
        nodeState.resumeFromPhase = undefined;
        
        if (result.success) {
          executorSuccess = true;
          log.info(`[executeNode] Executor succeeded for ${node.name}`, { planId: plan.id, nodeId: node.id });
          // Store completed commit.
          // If the executor produced no commit (e.g., expectsNoChanges validation
          // node), carry forward the baseCommit so downstream nodes in the FI
          // chain still receive the correct parent commit.
          if (result.completedCommit) {
            nodeState.completedCommit = result.completedCommit;
          } else if (!nodeState.completedCommit && nodeState.baseCommit) {
            nodeState.completedCommit = nodeState.baseCommit;
          }
          
          // Store work summary on node state and aggregate to Plan
          if (result.workSummary) {
            nodeState.workSummary = result.workSummary;
            this.appendWorkSummary(plan, result.workSummary);
          }
          
          // For leaf nodes, also compute aggregated work summary
          // This shows total diff from baseBranch to completedCommit
          const isLeaf = plan.leaves.includes(node.id);
          if (isLeaf && nodeState.worktreePath && nodeState.completedCommit && this.executor) {
            const worktreePath = nodeState.worktreePath;
            const executor = this.executor;
            const method = executor.computeAggregatedWorkSummary;
            if (method) {
              try {
                const aggregated = await method.call(executor, node, worktreePath, plan.baseBranch, plan.repoPath);
                nodeState.aggregatedWorkSummary = aggregated;
                log.info(`Computed aggregated work summary for leaf node ${node.name}`, {
                  commits: aggregated.commits,
                  filesAdded: aggregated.filesAdded,
                  filesModified: aggregated.filesModified,
                  filesDeleted: aggregated.filesDeleted,
                });
              } catch (error: any) {
                log.warn(`Failed to compute aggregated work summary for ${node.name}: ${error.message}`);
              }
            }
          }
        } else {
          // Executor failed - handle the failure
          log.info(`[executeNode] Executor FAILED for ${node.name}, entering failure path`, { planId: plan.id, nodeId: node.id, error: result.error });
          nodeState.error = result.error;
          
          // Store lastAttempt for retry context
          nodeState.lastAttempt = {
            phase: result.failedPhase || 'work',
            startTime: nodeState.startedAt || Date.now(),
            endTime: Date.now(),
            error: result.error,
            exitCode: result.exitCode,
          };
          
          // Update stepStatuses from executor result (has proper success/failed values)
          if (result.stepStatuses) {
            nodeState.stepStatuses = result.stepStatuses;
          }

          // Record failed attempt in history (spread to snapshot — avoid mutation by auto-heal)
          const failedAttempt: AttemptRecord = {
            attemptNumber: nodeState.attempts,
            triggerType: nodeState.attempts === 1 ? 'initial' : 'retry',
            status: 'failed',
            startedAt: nodeState.startedAt || Date.now(),
            endedAt: Date.now(),
            failedPhase: result.failedPhase,
            error: result.error,
            exitCode: result.exitCode,
            copilotSessionId: nodeState.copilotSessionId,
            stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
            worktreePath: nodeState.worktreePath,
            baseCommit: nodeState.baseCommit,
            logs: this.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
            logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
            workUsed: node.work,
            metrics: nodeState.metrics,
            phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
          };
          nodeState.attemptHistory = [...(nodeState.attemptHistory || []), failedAttempt];
          
          // ============================================================
          // AUTO-HEAL: Automatic AI-assisted retry for process/shell failures
          // ============================================================
          // If a process/shell phase failed and auto-heal is enabled,
          // retry once by swapping ONLY the failed phase to a Copilot agent
          // and resuming from that phase. Earlier phases that passed are
          // skipped; later phases (including commit) run normally.
          const failedPhase = result.failedPhase || 'work';
          const isHealablePhase = ['prechecks', 'work', 'postchecks'].includes(failedPhase);
          const failedWorkSpec = failedPhase === 'prechecks' ? node.prechecks
            : failedPhase === 'postchecks' ? node.postchecks
            : node.work;
          const normalizedFailedSpec = normalizeWorkSpec(failedWorkSpec);
          const isAgentWork = normalizedFailedSpec?.type === 'agent';
          const isNonAgentWork = normalizedFailedSpec && normalizedFailedSpec.type !== 'agent';
          const autoHealEnabled = node.autoHeal !== false; // default true
          
          // Detect external interruption (SIGTERM, SIGKILL, etc.)
          const wasExternallyKilled = result.error?.includes('killed by signal');
          
          // INFO logging for auto-retry decision (visible in logs)
          log.info(`Auto-retry decision for ${node.name}: phase=${failedPhase}, isHealable=${isHealablePhase}, isAgentWork=${isAgentWork}, wasExternallyKilled=${wasExternallyKilled}, autoHealEnabled=${autoHealEnabled}`, {
            planId: plan.id,
            nodeId: node.id,
            error: result.error,
          });
          
          const phaseAlreadyHealed = nodeState.autoHealAttempted?.[failedPhase as 'prechecks' | 'work' | 'postchecks'];
          
          // Auto-retry is allowed if:
          // 1. Non-agent work (existing behavior - swap to agent)
          // 2. Agent work that was externally killed (retry same agent)
          const shouldAttemptAutoRetry = isHealablePhase && autoHealEnabled && !phaseAlreadyHealed &&
            (isNonAgentWork || (isAgentWork && wasExternallyKilled));
          
          log.info(`Auto-retry shouldAttempt=${shouldAttemptAutoRetry}: isHealablePhase=${isHealablePhase}, autoHealEnabled=${autoHealEnabled}, phaseAlreadyHealed=${phaseAlreadyHealed}, isNonAgentWork=${isNonAgentWork}, isAgentWork=${isAgentWork}`, {
            planId: plan.id,
            nodeId: node.id,
          });
          
          // Persist plan state BEFORE auto-retry to capture failure record
          this.persistence.save(plan);
          
          if (shouldAttemptAutoRetry) {
            if (!nodeState.autoHealAttempted) nodeState.autoHealAttempted = {};
            nodeState.autoHealAttempted[failedPhase as 'prechecks' | 'work' | 'postchecks'] = true;
            
            if (isAgentWork && wasExternallyKilled) {
              // Agent was interrupted - retry with same spec (don't swap to different agent spec)
              log.info(`Auto-retry: agent was externally killed, retrying ${node.name} (phase: ${failedPhase})`, {
                planId: plan.id,
                nodeId: node.id,
                signal: result.error,
              });
              
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: AGENT INTERRUPTED, RETRYING ==========', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', `Phase "${failedPhase}" agent was externally killed. Retrying same agent.`, nodeState.attempts);
              
              // Reset state for the retry attempt
              nodeState.error = undefined;
              nodeState.startedAt = Date.now();
              nodeState.attempts++;

              // Capture log offsets for the retry attempt so its logs are isolated
              const retryLogMemoryOffset = this.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
              const retryLogFileOffset = this.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;

              // Execute with resumeFromPhase to skip already-passed phases
              const retryContext: ExecutionContext = {
                plan,
                node,
                baseCommit: nodeState.baseCommit!,
                worktreePath,
                attemptNumber: nodeState.attempts,
                copilotSessionId: nodeState.copilotSessionId,
                resumeFromPhase: failedPhase as ExecutionContext['resumeFromPhase'],
                previousStepStatuses: nodeState.stepStatuses,
                onProgress: (step) => {
                  log.debug(`Auto-retry progress: ${node.name} - ${step}`);
                },
                onStepStatusChange: (phase, status) => {
                  if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
                  (nodeState.stepStatuses as any)[phase] = status;
                },
              };
              
              const retryResult = await this.executor!.execute(retryContext);
              
              // Store step statuses from retry attempt
              if (retryResult.stepStatuses) {
                nodeState.stepStatuses = retryResult.stepStatuses;
              }
              
              // Capture session ID from retry attempt
              if (retryResult.copilotSessionId) {
                nodeState.copilotSessionId = retryResult.copilotSessionId;
              }
              
              if (retryResult.success) {
                log.info(`Auto-retry succeeded for ${node.name}!`, {
                  planId: plan.id,
                  nodeId: node.id,
                });
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: SUCCESS ==========', nodeState.attempts);
                
                autoHealSucceeded = true;
                if (retryResult.completedCommit) {
                  nodeState.completedCommit = retryResult.completedCommit;
                }
                if (retryResult.workSummary) {
                  nodeState.workSummary = retryResult.workSummary;
                  this.appendWorkSummary(plan, retryResult.workSummary);
                }
                if (retryResult.metrics) {
                  nodeState.metrics = retryResult.metrics;
                }
                if (retryResult.phaseMetrics) {
                  nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...retryResult.phaseMetrics };
                }
                // Update log offsets so the success record captures only retry logs
                logMemoryOffset = retryLogMemoryOffset;
                logFileOffset = retryLogFileOffset;
                // Fall through to RI merge handling below
              } else {
                // Auto-retry also failed — record it and transition to failed
                log.warn(`Auto-retry failed for ${node.name}`, {
                  planId: plan.id,
                  nodeId: node.id,
                  error: retryResult.error,
                });
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: FAILED ==========', nodeState.attempts);
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'error', `Auto-retry could not complete: ${retryResult.error}`, nodeState.attempts);
                
                nodeState.error = `Auto-retry failed: ${retryResult.error}`;
                
                if (retryResult.metrics) {
                  nodeState.metrics = retryResult.metrics;
                }
                if (retryResult.phaseMetrics) {
                  nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...retryResult.phaseMetrics };
                }
                
                // Record retry attempt in history
                const retryAttempt: AttemptRecord = {
                  attemptNumber: nodeState.attempts,
                  triggerType: 'auto-heal',
                  status: 'failed',
                  startedAt: nodeState.startedAt || Date.now(),
                  endedAt: Date.now(),
                  failedPhase: retryResult.failedPhase,
                  error: retryResult.error,
                  exitCode: retryResult.exitCode,
                  copilotSessionId: nodeState.copilotSessionId,
                  stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
                  worktreePath: nodeState.worktreePath,
                  baseCommit: nodeState.baseCommit,
                  logs: this.getNodeLogsFromOffset(plan.id, node.id, retryLogMemoryOffset, retryLogFileOffset, nodeState.attempts),
                  logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
                  workUsed: node.work,
                  metrics: nodeState.metrics,
                  phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
                };
                nodeState.attemptHistory = [...(nodeState.attemptHistory || []), retryAttempt];
                
                // Clear process ID since execution is complete
                nodeState.pid = undefined;
                
                sm.transition(node.id, 'failed');
                this.emit('nodeCompleted', plan.id, node.id, false);
                
                log.error(`Job failed (after auto-retry): ${node.name}`, {
                  planId: plan.id,
                  nodeId: node.id,
                  error: retryResult.error,
                });
                this.persistence.save(plan);
                return;
              }
            } else {
            // Non-agent work failed — existing auto-heal logic (swap to agent)
            log.info(`Auto-heal: attempting AI-assisted fix for ${node.name} (phase: ${failedPhase})`, {
              planId: plan.id,
              nodeId: node.id,
              exitCode: result.exitCode,
            });
            
            // Log the auto-heal attempt in the failed phase's log stream
            this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '', nodeState.attempts);
            this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-HEAL: AI-ASSISTED FIX ATTEMPT ==========', nodeState.attempts);
            this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', `Phase "${failedPhase}" failed. Delegating to Copilot agent to diagnose and fix.`, nodeState.attempts);
            
            // Gather context the agent needs to diagnose and fix the failure:
            // 1. The original command that was run
            // 2. The full execution logs (stdout/stderr) from the failed phase
            const originalCommand = (() => {
              const spec = normalizeWorkSpec(failedWorkSpec);
              if (!spec) return 'Unknown command';
              if (spec.type === 'shell') return spec.command;
              if (spec.type === 'process') return `${spec.executable} ${(spec.args || []).join(' ')}`;
              return 'Unknown command';
            })();
            
            // Get the execution logs for the failed phase — these contain
            // the full stdout/stderr streams plus timing info
            const phaseLogs = this.getNodeLogs(plan.id, node.id, failedPhase as ExecutionPhase);
            // Truncate to last ~200 lines to avoid overwhelming the agent
            const logLines = phaseLogs.split('\n');
            const truncatedLogs = logLines.length > 200
              ? `... (${logLines.length - 200} earlier lines omitted)\n` + logLines.slice(-200).join('\n')
              : phaseLogs;
            
            // Get security settings from the original failed spec
            const originalAgentSpec = normalizedFailedSpec?.type === 'agent' ? normalizedFailedSpec : null;

            const healSpec: WorkSpec = {
              type: 'agent',
              instructions: [
                `# Auto-Heal: Fix Failed ${failedPhase} Phase`,
                '',
                `## Task Context`,
                `This node's task: ${node.task || node.name}`,
                '',
                `## Original Command`,
                '```',
                originalCommand,
                '```',
                '',
                `## Failure Details`,
                `- Phase: ${failedPhase}`,
                `- Exit code: ${result.exitCode ?? 'unknown'}`,
                '',
                `## Execution Logs`,
                'The following are the full stdout/stderr logs from the failed execution:',
                '',
                '```',
                truncatedLogs,
                '```',
                '',
                `## Instructions`,
                `1. Analyze the logs above to diagnose the root cause of the failure`,
                `2. Fix the issue in the worktree (edit files, fix configs, etc.)`,
                `3. Re-run the original command to verify it now passes:`,
                '   ```',
                `   ${originalCommand}`,
                '   ```',
              ].join('\n'),
              // Inherit allowed folders/URLs from original spec (if any)
              // This ensures auto-heal has same access as the original work
              allowedFolders: originalAgentSpec?.allowedFolders,
              allowedUrls: originalAgentSpec?.allowedUrls,
            };
            
            // Swap ONLY the failed phase to the agent, preserve the rest
            const originalPrechecks = node.prechecks;
            const originalWork = node.work;
            const originalPostchecks = node.postchecks;
            
            if (failedPhase === 'prechecks') {
              node.prechecks = healSpec;
            } else if (failedPhase === 'work') {
              node.work = healSpec;
            } else if (failedPhase === 'postchecks') {
              node.postchecks = healSpec;
            }
            
            // Reset state for the heal attempt
            nodeState.error = undefined;
            nodeState.startedAt = Date.now();
            nodeState.attempts++;
            
            // Capture log offsets for the auto-heal attempt
            const healLogMemoryOffset = this.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
            const healLogFileOffset = this.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;
            
            // Execute with resumeFromPhase to skip already-passed phases
            const healContext: ExecutionContext = {
              plan,
              node,
              baseCommit: nodeState.baseCommit!,
              worktreePath,
              attemptNumber: nodeState.attempts,
              copilotSessionId: nodeState.copilotSessionId,
              resumeFromPhase: failedPhase as ExecutionContext['resumeFromPhase'],
              previousStepStatuses: nodeState.stepStatuses,
              onProgress: (step) => {
                log.debug(`Auto-heal progress: ${node.name} - ${step}`);
              },
              onStepStatusChange: (phase, status) => {
                if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
                (nodeState.stepStatuses as any)[phase] = status;
              },
            };
            
            const healResult = await this.executor!.execute(healContext);
            
            // Restore original specs regardless of outcome
            node.prechecks = originalPrechecks;
            node.work = originalWork;
            node.postchecks = originalPostchecks;
            
            // Store step statuses from heal attempt
            if (healResult.stepStatuses) {
              nodeState.stepStatuses = healResult.stepStatuses;
            }
            
            // Capture session ID from heal attempt
            if (healResult.copilotSessionId) {
              nodeState.copilotSessionId = healResult.copilotSessionId;
            }
            
            if (healResult.success) {
              log.info(`Auto-heal succeeded for ${node.name}!`, {
                planId: plan.id,
                nodeId: node.id,
              });
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-HEAL: SUCCESS ==========', nodeState.attempts);
              
              autoHealSucceeded = true;
              if (healResult.completedCommit) {
                nodeState.completedCommit = healResult.completedCommit;
              }
              if (healResult.workSummary) {
                nodeState.workSummary = healResult.workSummary;
                this.appendWorkSummary(plan, healResult.workSummary);
              }
              // Store agent metrics from heal attempt so AI Usage section renders
              if (healResult.metrics) {
                nodeState.metrics = healResult.metrics;
              }
              if (healResult.phaseMetrics) {
                nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...healResult.phaseMetrics };
              }
              // Fall through to RI merge handling below
            } else {
              // Auto-heal also failed — record it and transition to failed
              log.warn(`Auto-heal failed for ${node.name}`, {
                planId: plan.id,
                nodeId: node.id,
                error: healResult.error,
              });
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-HEAL: FAILED ==========', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'error', `Auto-heal could not fix the issue: ${healResult.error}`, nodeState.attempts);
              
              nodeState.error = `Auto-heal failed: ${healResult.error}`;
              
              // Store agent metrics from heal attempt
              if (healResult.metrics) {
                nodeState.metrics = healResult.metrics;
              }
              if (healResult.phaseMetrics) {
                nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...healResult.phaseMetrics };
              }
              
              // Record heal attempt in history
              const healAttempt: AttemptRecord = {
                attemptNumber: nodeState.attempts,
                triggerType: 'auto-heal',
                status: 'failed',
                startedAt: nodeState.startedAt || Date.now(),
                endedAt: Date.now(),
                failedPhase: healResult.failedPhase,
                error: healResult.error,
                exitCode: healResult.exitCode,
                copilotSessionId: nodeState.copilotSessionId,
                stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
                worktreePath: nodeState.worktreePath,
                baseCommit: nodeState.baseCommit,
                logs: this.getNodeLogsFromOffset(plan.id, node.id, healLogMemoryOffset, healLogFileOffset, nodeState.attempts),
                logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
                workUsed: healSpec,
                metrics: nodeState.metrics,
                phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
              };
              nodeState.attemptHistory = [...(nodeState.attemptHistory || []), healAttempt];
              
              // Clear process ID since execution is complete
              nodeState.pid = undefined;
              
              sm.transition(node.id, 'failed');
              this.emit('nodeCompleted', plan.id, node.id, false);
              
              log.error(`Job failed (after auto-heal): ${node.name}`, {
                planId: plan.id,
                nodeId: node.id,
                error: healResult.error,
              });
              this.persistence.save(plan);
              return;
            }
            }
          } else {
            // No auto-heal — transition to failed normally
            // Clear process ID since execution is complete
            nodeState.pid = undefined;
            
            sm.transition(node.id, 'failed');
            this.emit('nodeCompleted', plan.id, node.id, false);
            
            log.error(`Job failed: ${node.name}`, {
              planId: plan.id,
              nodeId: node.id,
              phase: result.failedPhase || 'unknown',
              error: result.error,
            });
            this.persistence.save(plan);
            return;
          }
        }
      }
      
      // At this point, executor succeeded (or was skipped for RI-only retry)
      // Handle leaf node merge to target branch (Reverse Integration)
      const isLeaf = plan.leaves.includes(node.id);
      log.debug(`Merge check: node=${node.name}, isLeaf=${isLeaf}, targetBranch=${plan.targetBranch}, completedCommit=${nodeState.completedCommit?.slice(0, 8)}`);
      
      // Track whether RI merge failed (only applies to leaf nodes with targetBranch)
      let riMergeFailed = false;
      
      if (isLeaf && plan.targetBranch && nodeState.completedCommit) {
        log.info(`Initiating merge to target: ${node.name} -> ${plan.targetBranch}`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE START ==========', nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `Merging completed commit ${nodeState.completedCommit.slice(0, 8)} to ${plan.targetBranch}`, nodeState.attempts);
        
        // Serialize RI merges via mutex to prevent:
        // 1. Git index.lock conflicts (stash/reset/checkout all acquire the lock)
        // 2. Logical races where concurrent merges read the same target tip,
        //    creating divergent commits that overwrite each other
        const mergeSuccess = await this.withRiMergeLock(() =>
          this.mergeLeafToTarget(plan, node, nodeState.completedCommit!, nodeState.attempts)
        );
        nodeState.mergedToTarget = mergeSuccess;
        
        if (mergeSuccess) {
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `Reverse integration merge succeeded`, nodeState.attempts);
          if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
          nodeState.stepStatuses['merge-ri'] = 'success';
        } else {
          riMergeFailed = true;
          if (!nodeState.stepStatuses) nodeState.stepStatuses = {};
          nodeState.stepStatuses['merge-ri'] = 'failed';
          this.execLog(plan.id, node.id, 'merge-ri', 'error', `Reverse integration merge FAILED - worktree preserved for manual retry`, nodeState.attempts);
          log.warn(`Leaf ${node.name} work succeeded but RI merge to ${plan.targetBranch} failed - treating as node failure`);
        }
        this.execLog(plan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE END ==========', nodeState.attempts);
        
        log.info(`Merge result: ${mergeSuccess ? 'success' : 'failed'}`, { mergedToTarget: nodeState.mergedToTarget });
      } else if (isLeaf && plan.targetBranch && !nodeState.completedCommit) {
        // Leaf node with no commit at all (no baseCommit either) - nothing to merge
        log.debug(`Leaf node ${node.name} has no commit to merge to ${plan.targetBranch} - marking as merged`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION ==========', nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', 'No commit to merge (validation-only root node)', nodeState.attempts);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', '==========================================', nodeState.attempts);
        nodeState.mergedToTarget = true;
      } else if (isLeaf) {
        log.debug(`Skipping merge: isLeaf=${isLeaf}, hasTargetBranch=${!!plan.targetBranch}, hasCompletedCommit=${!!nodeState.completedCommit}`);
      }
      
      // If RI merge failed, treat the node as failed (work succeeded but merge did not)
      if (riMergeFailed) {
        nodeState.error = `Reverse integration merge to ${plan.targetBranch} failed. Work completed successfully but merge could not be performed. Worktree preserved for manual retry.`;
        
        // Store lastAttempt for retry context
        nodeState.lastAttempt = {
          phase: 'merge-ri',
          startTime: nodeState.startedAt || Date.now(),
          endTime: Date.now(),
          error: nodeState.error,
        };
        
        // Record failed attempt in history
        const riFailedAttempt: AttemptRecord = {
          attemptNumber: nodeState.attempts,
          triggerType: autoHealSucceeded ? 'auto-heal' : (nodeState.attempts === 1 ? 'initial' : 'retry'),
          status: 'failed',
          startedAt: nodeState.startedAt || Date.now(),
          endedAt: Date.now(),
          failedPhase: 'merge-ri',
          error: nodeState.error,
          copilotSessionId: nodeState.copilotSessionId,
          stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
          worktreePath: nodeState.worktreePath,
          baseCommit: nodeState.baseCommit,
          completedCommit: nodeState.completedCommit, // Work was successful, so we have the commit
          logs: this.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
          logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
          workUsed: node.work,
          metrics: nodeState.metrics,
          phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
        };
        nodeState.attemptHistory = [...(nodeState.attemptHistory || []), riFailedAttempt];
        
        // Clear process ID since execution is complete
        nodeState.pid = undefined;
        
        sm.transition(node.id, 'failed');
        this.emit('nodeCompleted', plan.id, node.id, false);
        
        log.error(`Job failed (RI merge): ${node.name}`, {
          planId: plan.id,
          nodeId: node.id,
          commit: nodeState.completedCommit?.slice(0, 8),
          targetBranch: plan.targetBranch,
        });
      } else {
        // Record successful attempt in history
        const successAttempt: AttemptRecord = {
          attemptNumber: nodeState.attempts,
          triggerType: autoHealSucceeded ? 'auto-heal' : (nodeState.attempts === 1 ? 'initial' : 'retry'),
          status: 'succeeded',
          startedAt: nodeState.startedAt || Date.now(),
          endedAt: Date.now(),
          copilotSessionId: nodeState.copilotSessionId,
          stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
          worktreePath: nodeState.worktreePath,
          baseCommit: nodeState.baseCommit,
          logs: this.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
          logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
          workUsed: node.work,
          metrics: nodeState.metrics,
          phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
        };
        nodeState.attemptHistory = [...(nodeState.attemptHistory || []), successAttempt];
        
        // Clear process ID since execution is complete
        nodeState.pid = undefined;
        
        sm.transition(node.id, 'succeeded');
        this.emit('nodeCompleted', plan.id, node.id, true);
        
        // Cleanup this node's worktree if eligible
        // For leaf nodes: eligible after RI merge to targetBranch (or no targetBranch)
        // For non-leaf nodes: handled via acknowledgeConsumption when dependents FI
        if (plan.cleanUpSuccessfulWork && nodeState.worktreePath) {
          const isLeafNode = plan.leaves.includes(node.id);
          if (isLeafNode) {
            // Leaf: cleanup now if merged (or no target branch)
            if (!plan.targetBranch || nodeState.mergedToTarget) {
              await this.cleanupWorktree(nodeState.worktreePath, plan.repoPath);
              nodeState.worktreeCleanedUp = true;
              this.persistence.save(plan);
            }
          }
          // Non-leaf nodes are cleaned up via acknowledgeConsumption when dependents FI
        }
        
        log.info(`Job succeeded: ${node.name}`, {
          planId: plan.id,
          nodeId: node.id,
          commit: nodeState.completedCommit?.slice(0, 8),
        });
      }
    } catch (error: any) {
      nodeState.error = error.message;
      
      // Use failedPhase from error if set, otherwise default to 'work'
      const failedPhase = error.failedPhase || 'work';
      
      // Store lastAttempt for retry context
      nodeState.lastAttempt = {
        phase: failedPhase,
        startTime: nodeState.startedAt || Date.now(),
        endTime: Date.now(),
        error: error.message,
      };
      
      // Record failed attempt in history
      const errorAttempt: AttemptRecord = {
        attemptNumber: nodeState.attempts,
        triggerType: nodeState.attempts === 1 ? 'initial' : 'retry',
        status: 'failed',
        startedAt: nodeState.startedAt || Date.now(),
        endedAt: Date.now(),
        failedPhase: failedPhase,
        error: error.message,
        copilotSessionId: nodeState.copilotSessionId,
        stepStatuses: nodeState.stepStatuses,
        worktreePath: nodeState.worktreePath,
        baseCommit: nodeState.baseCommit,
        logs: this.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
        logFilePath: this.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
        workUsed: node.work,
        metrics: nodeState.metrics,
        phaseMetrics: nodeState.phaseMetrics,
      };
      nodeState.attemptHistory = [...(nodeState.attemptHistory || []), errorAttempt];
      
      // Clear process ID since execution is complete
      nodeState.pid = undefined;
      
      sm.transition(node.id, 'failed');
      this.emit('nodeCompleted', plan.id, node.id, false);
      
      log.error(`Job execution error: ${node.name}`, {
        planId: plan.id,
        nodeId: node.id,
        error: error.message,
      });
    }
    
    // Persist after execution
    this.persistence.save(plan);
  }
  
  // ============================================================================
  // GIT OPERATIONS
  // ============================================================================
  
  /**
   * Acquire the RI merge mutex, execute `fn`, then release.
   * 
   * Uses a promise-chain pattern: each call chains onto the previous,
   * ensuring strictly sequential execution without external dependencies.
   * If `fn` throws, the mutex is still released so subsequent merges proceed.
   */
  private async withRiMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>(resolve => { releaseLock = resolve; });
    
    // Chain onto whatever was previously running
    const previousLock = this.riMergeMutex;
    this.riMergeMutex = lockAcquired;
    
    // Wait for the previous RI merge to finish
    await previousLock;
    
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }
  
  /**
   * Merge a leaf node's commit to target branch using a temp worktree.
   * 
   * Uses the same model as planRunner/jobRunner:
   * - Create a temp detached worktree on the target branch
   * - Checkout the target branch
   * - Squash merge the source commit
   * - Commit and optionally push
   * - Clean up the temp worktree
   * 
   * @returns true if merge succeeded, false if it failed
   */
  private async mergeLeafToTarget(
    plan: PlanInstance,
    node: PlanNode,
    completedCommit: string,
    attemptNumber?: number
  ): Promise<boolean> {
    if (!plan.targetBranch) return true; // No target = nothing to merge = success
    
    log.info(`Merging leaf to target: ${node.name} -> ${plan.targetBranch}`, {
      commit: completedCommit.slice(0, 8),
    });
    
    const repoPath = plan.repoPath;
    const targetBranch = plan.targetBranch;
    
    try {
      // =========================================================================
      // FAST PATH: Use git merge-tree (no checkout needed, no worktree conflicts)
      // =========================================================================
      this.execLog(plan.id, node.id, 'merge-ri', 'info', `Using git merge-tree for conflict-free merge...`, attemptNumber);
      
      const mergeTreeResult = await git.merge.mergeWithoutCheckout({
        source: completedCommit,
        target: targetBranch,
        repoPath,
        log: s => {
          log.debug(s);
          this.execLog(plan.id, node.id, 'merge-ri', 'stdout', s, attemptNumber);
        }
      });
      
      if (mergeTreeResult.success && mergeTreeResult.treeSha) {
        log.info(`Fast path: conflict-free merge via merge-tree`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `✓ No conflicts detected`, attemptNumber);
        
        // Create the merge commit from the tree
        const targetSha = await git.repository.resolveRef(targetBranch, repoPath);
        const commitMessage = `Plan ${plan.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`;
        
        const newCommit = await git.merge.commitTree(
          mergeTreeResult.treeSha,
          [targetSha],  // Single parent for squash-style merge
          commitMessage,
          repoPath,
          s => log.debug(s)
        );
        
        log.debug(`Created merge commit: ${newCommit.slice(0, 8)}`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `Created merge commit: ${newCommit.slice(0, 8)}`, attemptNumber);
        
        // Update the target branch to point to the new commit
        // We need to handle the case where target branch is checked out elsewhere
        const branchUpdated = await this.updateBranchRef(repoPath, targetBranch, newCommit);
        if (branchUpdated) {
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `Updated ${targetBranch} to ${newCommit.slice(0, 8)}`, attemptNumber);
        } else {
          // Stash/reset failed but merge commit exists - partial success
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `⚠ Merge commit ${newCommit.slice(0, 8)} created but branch not auto-updated (stash failed)`, attemptNumber);
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `  Run 'git reset --hard ${newCommit.slice(0, 8)}' to update your local ${targetBranch}`, attemptNumber);
        }
        
        log.info(`Merged leaf ${node.name} to ${targetBranch}`, {
          commit: completedCommit.slice(0, 8),
          newCommit: newCommit.slice(0, 8),
        });
        
        // Push if configured
        const pushOnSuccess = getConfig<boolean>('copilotOrchestrator.merge', 'pushOnSuccess', false);
        
        if (pushOnSuccess) {
          try {
            this.execLog(plan.id, node.id, 'merge-ri', 'info', `Pushing ${targetBranch} to origin...`, attemptNumber);
            await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
            log.info(`Pushed ${targetBranch} to origin`);
            this.execLog(plan.id, node.id, 'merge-ri', 'info', `✓ Pushed to origin`, attemptNumber);
          } catch (pushError: any) {
            log.warn(`Push failed: ${pushError.message}`);
            this.execLog(plan.id, node.id, 'merge-ri', 'error', `Push failed: ${pushError.message}`, attemptNumber);
            // Push failure doesn't mean merge failed - the commit is local
          }
        }
        
        return true;
      }
      
      // =========================================================================
      // CONFLICT: Use Copilot CLI to resolve via main repo merge
      // =========================================================================
      if (mergeTreeResult.hasConflicts) {
        log.info(`Merge has conflicts, using Copilot CLI to resolve`, {
          conflictFiles: mergeTreeResult.conflictFiles,
        });
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `⚠ Merge has conflicts`, attemptNumber);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `  Conflicts: ${mergeTreeResult.conflictFiles?.join(', ')}`, attemptNumber);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `  Invoking Copilot CLI to resolve...`, attemptNumber);
        
        // Fall back to main repo merge with Copilot CLI resolution
        const resolved = await this.mergeWithConflictResolution(
          repoPath,
          completedCommit,
          targetBranch,
          `Plan ${plan.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`,
          { planId: plan.id, nodeId: node.id, phase: 'merge-ri', attemptNumber }
        );
        
        if (resolved.success) {
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `✓ Conflict resolved by Copilot CLI`, attemptNumber);
          
          // Aggregate CLI metrics from merge conflict resolution into node metrics
          if (resolved.metrics) {
            const nodeState = plan.nodeStates.get(node.id);
            if (nodeState) {
              nodeState.metrics = nodeState.metrics
                ? aggregateMetrics([nodeState.metrics, resolved.metrics])
                : resolved.metrics;
              // Track per-phase metrics for merge-ri
              nodeState.phaseMetrics = nodeState.phaseMetrics || {};
              nodeState.phaseMetrics['merge-ri'] = resolved.metrics;
            }
          }
        } else {
          this.execLog(plan.id, node.id, 'merge-ri', 'error', `✗ Copilot CLI failed to resolve conflict`, attemptNumber);
        }
        
        return resolved.success;
      }
      
      log.error(`Merge-tree failed: ${mergeTreeResult.error}`);
      this.execLog(plan.id, node.id, 'merge-ri', 'error', `✗ Merge-tree failed: ${mergeTreeResult.error}`, attemptNumber);
      return false;
      
    } catch (error: any) {
      log.error(`Failed to merge leaf to target`, {
        node: node.name,
        error: error.message,
      });
      this.execLog(plan.id, node.id, 'merge-ri', 'error', `✗ Exception: ${error.message}`, attemptNumber);
      return false;
    }
  }
  
  /**
   * Update a branch reference to point to a new commit.
   * Handles the case where the branch is checked out in the main repo.
   * 
   * Includes retry logic for transient index.lock failures that can occur
   * when VS Code's built-in git extension briefly holds the lock.
   * 
   * @returns true if branch was updated, false if update was skipped (e.g., stash failed)
   */
  private async updateBranchRef(
    repoPath: string,
    branchName: string,
    newCommit: string,
    retryCount = 0
  ): Promise<boolean> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;
    
    try {
      return await this.updateBranchRefCore(repoPath, branchName, newCommit);
    } catch (err: any) {
      const isLockError = err.message?.includes('index.lock') || err.message?.includes('lock');
      if (isLockError && retryCount < MAX_RETRIES) {
        log.warn(`index.lock contention on updateBranchRef, retrying (${retryCount + 1}/${MAX_RETRIES}) in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
        return this.updateBranchRef(repoPath, branchName, newCommit, retryCount + 1);
      }
      throw err;
    }
  }
  
  /**
   * Core implementation of updateBranchRef — separated for retry logic.
   * 
   * Important: This is called AFTER the merge commit is already created.
   * If we fail to update the branch pointer, the merge is still successful -
   * the commit exists in the repo. We should not fail the entire merge-ri
   * just because of a stash/reset failure.
   * 
   * @returns true if branch was updated, false if update was skipped (e.g., stash failed)
   */
  private async updateBranchRefCore(
    repoPath: string,
    branchName: string,
    newCommit: string
  ): Promise<boolean> {
    // Check if we're on this branch in the main repo
    const currentBranch = await git.branches.currentOrNull(repoPath);
    const isDirty = await git.repository.hasUncommittedChanges(repoPath);
    
    if (currentBranch === branchName) {
      // User is on the target branch - use reset --hard (with stash if dirty)
      log.debug(`User is on ${branchName}, using reset --hard to update`);
      
      if (isDirty) {
        // Check what files are dirty - if only .gitignore with only orchestrator changes, skip stash
        const dirtyFiles = await git.repository.getDirtyFiles(repoPath);
        const onlyGitignoreDirty = dirtyFiles.length === 1 && dirtyFiles[0] === '.gitignore';
        
        if (onlyGitignoreDirty) {
          // Verify the .gitignore diff only contains orchestrator-related changes
          // to avoid discarding legitimate user modifications
          const isOnlyOrchestratorChanges = await this.isGitignoreOnlyOrchestratorChanges(repoPath);
          
          if (isOnlyOrchestratorChanges) {
            // Safe to discard - these are only orchestrator changes already in merge commit
            log.debug(`Only .gitignore is dirty with orchestrator-only changes - discarding and resetting`);
            try {
              await git.repository.checkoutFile(repoPath, '.gitignore', s => log.debug(s));
              await git.repository.resetHard(repoPath, newCommit, s => log.debug(s));
              log.info(`Updated ${branchName} via reset --hard to ${newCommit.slice(0, 8)} (discarded orchestrator .gitignore)`);
              return true;
            } catch (err: any) {
              log.warn(`Failed to discard .gitignore and reset: ${err.message}`);
              // Fall through to stash approach
            }
          } else {
            log.debug(`.gitignore has non-orchestrator changes, will stash`);
          }
        }
        
        // Try stash + reset, but don't fail the merge if stash has issues
        // The merge commit already exists - worst case user needs to manually sync
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        try {
          await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
        } catch (stashErr: any) {
          // Stash failed (e.g., "could not write index") - this is non-fatal
          // The merge commit exists, user just needs to manually update their branch
          log.warn(`Stash failed during branch update: ${stashErr.message}`);
          log.warn(`Merge commit ${newCommit.slice(0, 8)} was created successfully.`);
          log.warn(`User may need to manually run: git reset --hard ${newCommit.slice(0, 8)}`);
          // Don't throw - the merge succeeded, just the local branch pointer update failed
          return false;
        }
        
        try {
          await git.repository.resetHard(repoPath, newCommit, s => log.debug(s));
          // Try to pop the stash
          try {
            await git.repository.stashPop(repoPath, s => log.debug(s));
          } catch (popErr: any) {
            // Pop failed - check if it's just orchestrator .gitignore conflict
            log.warn(`Stash pop failed: ${popErr.message}`);
            
            // Check stash contents - if only orchestrator .gitignore, drop it
            const stashOnlyOrchestratorGitignore = await this.isStashOnlyOrchestratorGitignore(repoPath);
            if (stashOnlyOrchestratorGitignore) {
              log.debug(`Stash contains only orchestrator .gitignore changes - dropping`);
              await git.repository.stashDrop(repoPath, undefined, s => log.debug(s));
            } else {
              // Stash has real user changes - leave it for user to resolve
              log.warn(`Stash contains user changes that couldn't be applied. Run 'git stash pop' to recover.`);
            }
          }
        } catch (err) {
          // Try to restore stash before re-throwing
          try {
            await git.repository.stashPop(repoPath, s => log.debug(s));
          } catch {
            log.warn(`Failed to restore stash after reset failure`);
          }
          throw err;
        }
      } else {
        await git.repository.resetHard(repoPath, newCommit, s => log.debug(s));
      }
      log.info(`Updated ${branchName} via reset --hard to ${newCommit.slice(0, 8)}`);
      return true;
    } else {
      // User is NOT on target branch - we can use update-ref
      // This is safe even if the branch is "associated" with the main repo
      log.debug(`User is on ${currentBranch || 'detached HEAD'}, using update-ref`);
      
      await git.repository.updateRef(repoPath, `refs/heads/${branchName}`, newCommit, s => log.debug(s));
      log.info(`Updated ${branchName} via update-ref to ${newCommit.slice(0, 8)}`);
      return true;
    }
  }
  
  /**
   * Check if the working tree .gitignore diff contains ONLY orchestrator-related changes.
   * Returns true only if all added/modified lines are orchestrator patterns.
   */
  private async isGitignoreOnlyOrchestratorChanges(repoPath: string): Promise<boolean> {
    try {
      // Get the diff of .gitignore (unstaged changes)
      const result = await git.executor.execAsyncOrNull(['diff', '.gitignore'], repoPath);
      
      if (!result || !result.trim()) {
        // No unstaged diff - check if staged
        const stagedResult = await git.executor.execAsyncOrNull(['diff', '--cached', '.gitignore'], repoPath);
        if (!stagedResult || !stagedResult.trim()) {
          return true; // No changes at all
        }
        return this.diffContainsOnlyOrchestratorPatterns(stagedResult);
      }
      
      return this.diffContainsOnlyOrchestratorPatterns(result);
    } catch {
      return false; // If we can't check, assume it has user changes
    }
  }
  
  /**
   * Check if a stash contains only orchestrator .gitignore changes.
   */
  private async isStashOnlyOrchestratorGitignore(repoPath: string): Promise<boolean> {
    try {
      // List files in stash
      const filesResult = await git.executor.execAsyncOrNull(['stash', 'show', '--name-only'], repoPath);
      if (!filesResult) {
        return false;
      }
      
      const files = filesResult.trim().split(/\r?\n/).filter(Boolean);
      
      if (files.length !== 1 || files[0] !== '.gitignore') {
        return false; // Stash has files other than .gitignore
      }
      
      // Check the stash diff for .gitignore
      const diffResult = await git.executor.execAsyncOrNull(['stash', 'show', '-p'], repoPath);
      if (!diffResult) {
        return false;
      }
      
      return this.diffContainsOnlyOrchestratorPatterns(diffResult);
    } catch {
      return false; // If we can't check, assume it has user changes
    }
  }
  
  /**
   * Check if a diff output contains only orchestrator-related patterns.
   * Orchestrator patterns: .orchestrator/, # Copilot Orchestrator
   */
  private diffContainsOnlyOrchestratorPatterns(diff: string): boolean {
    const lines = diff.split(/\r?\n/);
    
    // Patterns that are orchestrator-related
    const orchestratorPatterns = [
      /^[+-]\.orchestrator\/?$/,           // .orchestrator or .orchestrator/
      /^[+-]\/?\.orchestrator\/?$/,        // /.orchestrator or /.orchestrator/  
      /^[+-]#\s*[Cc]opilot [Oo]rchestrator/,  // # Copilot Orchestrator comment
      /^[+-]\s*$/,                          // Empty lines (often added with entries)
    ];
    
    for (const line of lines) {
      // Skip diff metadata lines
      if (line.startsWith('diff ') || line.startsWith('index ') || 
          line.startsWith('--- ') || line.startsWith('+++ ') ||
          line.startsWith('@@') || line.startsWith('\\')) {
        continue;
      }
      
      // Skip context lines (no + or -)
      if (!line.startsWith('+') && !line.startsWith('-')) {
        continue;
      }
      
      // Check if this added/removed line is an orchestrator pattern
      const isOrchestratorLine = orchestratorPatterns.some(pattern => pattern.test(line));
      if (!isOrchestratorLine) {
        log.debug(`Non-orchestrator .gitignore change detected: ${line}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Log the commits and file changes for a dependency node.
   * 
   * Uses the workSummary already stored on the dependency node,
   * avoiding additional git commands.
   */
  private logDependencyWorkSummary(
    planId: string,
    nodeId: string,
    workSummary: JobWorkSummary | undefined,
    attemptNumber?: number
  ): void {
    if (!workSummary) {
      this.execLog(planId, nodeId, 'merge-fi', 'info', '  (No work summary available)', attemptNumber);
      return;
    }
    
    const commitDetails = workSummary.commitDetails || [];
    if (commitDetails.length === 0) {
      // Fall back to summary counts if no commit details
      this.execLog(planId, nodeId, 'merge-fi', 'info', 
        `  Work: ${workSummary.commits} commit(s), +${workSummary.filesAdded} ~${workSummary.filesModified} -${workSummary.filesDeleted}`, attemptNumber);
      return;
    }
    
    this.execLog(planId, nodeId, 'merge-fi', 'info', `  Commits (${commitDetails.length}):`, attemptNumber);
    
    for (const commit of commitDetails) {
      this.execLog(planId, nodeId, 'merge-fi', 'info', `    ${commit.shortHash} ${commit.message}`, attemptNumber);
      
      // Show file change summary
      const summary = this.summarizeCommitFiles(commit);
      if (summary) {
        this.execLog(planId, nodeId, 'merge-fi', 'info', `           ${summary}`, attemptNumber);
      }
    }
  }
  
  /**
   * Summarize file changes from a CommitDetail into a compact string.
   */
  private summarizeCommitFiles(commit: CommitDetail): string {
    const added = commit.filesAdded.length;
    const modified = commit.filesModified.length;
    const deleted = commit.filesDeleted.length;
    
    if (added === 0 && modified === 0 && deleted === 0) {
      return '';
    }
    
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (modified > 0) parts.push(`~${modified}`);
    if (deleted > 0) parts.push(`-${deleted}`);
    
    const summary = parts.join(' ');
    
    // Show a few example files
    const allFiles = [
      ...commit.filesAdded.map(f => ({ path: f, prefix: '+' })),
      ...commit.filesModified.map(f => ({ path: f, prefix: '~' })),
      ...commit.filesDeleted.map(f => ({ path: f, prefix: '-' })),
    ];
    
    const examples = allFiles.slice(0, 3).map(f => {
      const shortPath = f.path.split('/').slice(-2).join('/');
      return `${f.prefix}${shortPath}`;
    });
    
    if (allFiles.length > 3) {
      examples.push(`... (+${allFiles.length - 3} more)`);
    }
    
    return `[${summary}] ${examples.join(', ')}`;
  }
  
  /**
   * Merge additional source commits into a worktree.
   * 
   * This is called when a job has multiple dependencies (RI/FI model).
   * The worktree is already created from the first dependency's commit,
   * and we merge in the remaining dependency commits.
   * 
   * Uses full merge (not squash) to preserve history for downstream jobs.
   * 
   * @param dependencyInfoMap - Map from commit SHA to dependency node info for logging
   */
  private async mergeSourcesIntoWorktree(
    plan: PlanInstance,
    node: JobNode,
    worktreePath: string,
    additionalSources: string[],
    dependencyInfoMap: Map<string, DependencyInfo>,
    attemptNumber?: number
  ): Promise<boolean> {
    if (additionalSources.length === 0) {
      return true;
    }
    
    log.info(`Merging ${additionalSources.length} source commits into worktree for ${node.name}`);
    
    for (const sourceCommit of additionalSources) {
      const shortSha = sourceCommit.slice(0, 8);
      const depInfo = dependencyInfoMap.get(sourceCommit);
      
      log.debug(`Merging commit ${shortSha} into worktree at ${worktreePath}`);
      
      // Log dependency info before merging
      this.execLog(plan.id, node.id, 'merge-fi', 'info', '', attemptNumber);
      if (depInfo) {
        this.execLog(plan.id, node.id, 'merge-fi', 'info', `[Merge Source] ${depInfo.nodeName}`, attemptNumber);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', `  Commit: ${shortSha} (from dependency "${depInfo.nodeName}")`, attemptNumber);
        
        // Show work summary from the dependency node
        this.logDependencyWorkSummary(plan.id, node.id, depInfo.workSummary, attemptNumber);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '  Merging into worktree...', attemptNumber);
      } else {
        this.execLog(plan.id, node.id, 'merge-fi', 'info', `Merging source commit ${shortSha}...`, attemptNumber);
      }
      
      try {
        // Merge by commit SHA directly (no branch needed)
        const mergeResult = await git.merge.merge({
          source: sourceCommit,
          target: 'HEAD',
          cwd: worktreePath,
          message: `Merge parent commit ${shortSha} for job ${node.name}`,
          fastForward: true,
        });
        
        if (mergeResult.success) {
          log.debug(`Merge of commit ${shortSha} succeeded`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `  ✓ Merged successfully`, attemptNumber);
        } else if (mergeResult.hasConflicts) {
          log.info(`Merge conflict for commit ${shortSha}, using Copilot CLI to resolve`, {
            conflicts: mergeResult.conflictFiles,
          });
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `  ⚠ Merge conflict detected`, attemptNumber);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `    Conflicts: ${mergeResult.conflictFiles?.join(', ')}`, attemptNumber);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `    Invoking Copilot CLI to resolve...`, attemptNumber);
          
          // Use Copilot CLI to resolve conflicts
          const cliResult = await this.resolveMergeConflictWithCopilot(
            worktreePath,
            sourceCommit,
            'HEAD',
            `Merge parent commit ${shortSha} for job ${node.name}`,
            { planId: plan.id, nodeId: node.id, phase: 'merge-fi', attemptNumber }
          );
          
          if (!cliResult.success) {
            log.error(`Copilot CLI failed to resolve merge conflict for commit ${shortSha}`);
            this.execLog(plan.id, node.id, 'merge-fi', 'error', `  ✗ Copilot CLI failed to resolve conflict`, attemptNumber);
            await git.merge.abort(worktreePath, s => log.debug(s));
            return false;
          }
          
          log.info(`Merge conflict resolved by Copilot CLI for commit ${shortSha}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `  ✓ Conflict resolved by Copilot CLI`, attemptNumber);
          
          // Aggregate CLI metrics from FI merge conflict resolution into node metrics
          if (cliResult.metrics) {
            const nodeState = plan.nodeStates.get(node.id);
            if (nodeState) {
              nodeState.metrics = nodeState.metrics
                ? aggregateMetrics([nodeState.metrics, cliResult.metrics])
                : cliResult.metrics;
              // Track per-phase metrics for merge-fi
              nodeState.phaseMetrics = nodeState.phaseMetrics || {};
              nodeState.phaseMetrics['merge-fi'] = nodeState.phaseMetrics['merge-fi']
                ? aggregateMetrics([nodeState.phaseMetrics['merge-fi'], cliResult.metrics])
                : cliResult.metrics;
            }
          }
        } else {
          log.error(`Merge failed for commit ${shortSha}: ${mergeResult.error}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'error', `  ✗ Merge failed: ${mergeResult.error}`, attemptNumber);
          return false;
        }
      } catch (error: any) {
        log.error(`Exception merging commit ${shortSha}: ${error.message}`);
        this.execLog(plan.id, node.id, 'merge-fi', 'error', `  ✗ Exception: ${error.message}`, attemptNumber);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Resolve merge conflicts using Copilot CLI.
   * 
   * Assumes we're in a merge conflict state in the given directory.
   * Uses Copilot CLI to resolve the conflicts, stage changes, and commit.
   */
  private async resolveMergeConflictWithCopilot(
    cwd: string,
    sourceBranch: string,
    targetBranch: string,
    commitMessage: string,
    logContext?: { planId: string; nodeId: string; phase: ExecutionPhase; attemptNumber?: number }
  ): Promise<{ success: boolean; sessionId?: string; metrics?: CopilotUsageMetrics }> {
    const prefer = getConfig<string>('copilotOrchestrator.merge', 'prefer', 'theirs');
    
    const mergeTask =
      `Resolve the current git merge conflict. ` +
      `We are merging '${sourceBranch}' into '${targetBranch}'. ` +
      `Prefer '${prefer}' changes when there are conflicts. ` +
      `Resolve all conflicts, stage the changes with 'git add', and commit with message '${commitMessage}'`;
    
    log.info(`Running Copilot CLI to resolve conflicts...`, { cwd });
    if (logContext) {
      this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'info', `  Running Copilot CLI to resolve conflicts...`, logContext.attemptNumber);
    }
    
    const cliLogger: CopilotCliLogger = {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    };
    
    const runner = new CopilotCliRunner(cliLogger);
    const result = await runner.run({
      cwd,
      task: mergeTask,
      label: 'merge-conflict',
      timeout: 300000,
      onOutput: (line) => {
        if (logContext && line.trim()) {
          this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'info', `  [copilot] ${line.trim()}`, logContext.attemptNumber);
        }
      },
    });
    
    // Log the CLI result details
    if (logContext) {
      if (result.sessionId) {
        this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'info', `  Copilot session: ${result.sessionId}`, logContext.attemptNumber);
      }
      if (!result.success) {
        this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'error', `  Copilot CLI error: ${result.error || 'unknown'}`, logContext.attemptNumber);
        if (result.exitCode !== undefined) {
          this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'error', `  Exit code: ${result.exitCode}`, logContext.attemptNumber);
        }
      }
    }
    
    return { success: result.success, sessionId: result.sessionId, metrics: result.metrics };
  }
  
  /**
   * Merge with conflict resolution using main repo merge and Copilot CLI.
   * 
   * This is used when merge-tree detects conflicts. It:
   * 1. Stashes user's uncommitted changes
   * 2. Checks out target branch
   * 3. Performs merge (conflicts occur)
   * 4. Uses Copilot CLI to resolve conflicts
   * 5. Restores user's original branch and stash
   */
  private async mergeWithConflictResolution(
    repoPath: string,
    sourceCommit: string,
    targetBranch: string,
    commitMessage: string,
    logContext?: { planId: string; nodeId: string; phase: ExecutionPhase; attemptNumber?: number }
  ): Promise<{ success: boolean; metrics?: CopilotUsageMetrics }> {
    // Capture user's current state
    const originalBranch = await git.branches.currentOrNull(repoPath);
    const isOnTargetBranch = originalBranch === targetBranch;
    const isDirty = await git.repository.hasUncommittedChanges(repoPath);
    
    let didStash = false;
    let didCheckout = false;
    
    try {
      // Step 1: Stash uncommitted changes if needed
      if (isDirty) {
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        didStash = await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
        log.debug(`Stashed user's uncommitted changes`);
      }
      
      // Step 2: Checkout targetBranch if needed
      if (!isOnTargetBranch) {
        await git.branches.checkout(repoPath, targetBranch, s => log.debug(s));
        didCheckout = true;
        log.debug(`Checked out ${targetBranch} for merge`);
      }
      
      // Step 3: Perform the merge (will have conflicts)
      await git.merge.merge({
        source: sourceCommit,
        target: targetBranch,
        cwd: repoPath,
        noCommit: true,
        log: s => log.debug(s)
      }).catch(() => {
        // Expected to fail due to conflicts
      });
      
      // Step 4: Use Copilot CLI to resolve conflicts
      const cliResult = await this.resolveMergeConflictWithCopilot(
        repoPath,
        sourceCommit,
        targetBranch,
        commitMessage,
        logContext
      );
      
      if (!cliResult.success) {
        throw new Error('Copilot CLI failed to resolve conflicts');
      }
      
      log.info(`Merge conflict resolved by Copilot CLI`);
      
      // Push if configured
      const pushOnSuccess = getConfig<boolean>('copilotOrchestrator.merge', 'pushOnSuccess', false);
      
      if (pushOnSuccess) {
        try {
          await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
          log.info(`Pushed ${targetBranch} to origin`);
        } catch (pushError: any) {
          log.warn(`Push failed: ${pushError.message}`);
        }
      }
      
      // Step 5: Restore user to original branch (if they weren't on target)
      if (didCheckout && originalBranch) {
        await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
        log.debug(`Restored user to ${originalBranch}`);
      }
      
      // Step 6: Restore user's uncommitted changes
      if (didStash) {
        await git.repository.stashPop(repoPath, s => log.debug(s));
        log.debug(`Restored user's uncommitted changes`);
      }
      
      return { success: true, metrics: cliResult.metrics };
      
    } catch (error: any) {
      log.error(`Merge with conflict resolution failed: ${error.message}`);
      
      // Try to restore user state
      try {
        await git.merge.abort(repoPath, s => log.debug(s)).catch(() => {});
        
        if (didCheckout && originalBranch) {
          const currentBranch = await git.branches.currentOrNull(repoPath);
          if (currentBranch !== originalBranch) {
            await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
          }
        }
        
        if (didStash) {
          await git.repository.stashPop(repoPath, s => log.debug(s));
        }
      } catch (restoreError: any) {
        log.error(`Failed to restore user state: ${restoreError.message}`);
      }
      
      return { success: false };
    }
  }
  
  /**
   * Clean up a worktree after successful completion (detached HEAD - no branch)
   */
  private async cleanupWorktree(
    worktreePath: string,
    repoPath: string
  ): Promise<void> {
    log.debug(`Cleaning up worktree: ${worktreePath}`);
    
    try {
      await git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
    } catch (error: any) {
      log.warn(`Failed to cleanup worktree`, {
        path: worktreePath,
        error: error.message,
      });
    }
  }
  
  /**
   * Acknowledge that a consumer node has successfully consumed (FI'd from) its dependencies.
   * 
   * This is called after FI succeeds, allowing dependency worktrees to be cleaned up
   * as soon as all consumers have consumed, rather than waiting for consumers to fully succeed.
   */
  private async acknowledgeConsumption(
    plan: PlanInstance,
    sm: PlanStateMachine,
    consumerNode: PlanNode
  ): Promise<void> {
    // Mark this consumer as having consumed each of its dependencies
    for (const depId of consumerNode.dependencies) {
      const depState = plan.nodeStates.get(depId);
      if (depState) {
        if (!depState.consumedByDependents) {
          depState.consumedByDependents = [];
        }
        // Only add if not already present
        if (!depState.consumedByDependents.includes(consumerNode.id)) {
          depState.consumedByDependents.push(consumerNode.id);
        }
        
        log.debug(`Consumption acknowledged: ${consumerNode.name} consumed ${plan.nodes.get(depId)?.name}`, {
          depId,
          consumedCount: depState.consumedByDependents.length,
          dependentCount: plan.nodes.get(depId)?.dependents.length,
        });
      }
    }
    
    // Check if any dependencies are now eligible for cleanup
    if (plan.cleanUpSuccessfulWork) {
      await this.cleanupEligibleWorktrees(plan, sm);
    }
  }
  
  /**
   * Clean up worktrees for non-leaf nodes that are safe to clean up.
   * 
   * Called from acknowledgeConsumption() when a dependent finishes FI.
   * Checks all dependencies of the consumer to see if any are now fully
   * consumed (all their dependents have FI'd from them).
   * 
   * Leaf nodes are cleaned up directly after RI merge - see executeJobNode.
   */
  private async cleanupEligibleWorktrees(
    plan: PlanInstance,
    sm: PlanStateMachine
  ): Promise<void> {
    const eligibleNodes: string[] = [];
    
    for (const [nodeId, state] of plan.nodeStates) {
      // Skip if not succeeded or no worktree or already cleaned
      if (state.status !== 'succeeded' || !state.worktreePath) {
        continue;
      }
      
      // Check if worktree still exists
      const fs = require('fs');
      if (!fs.existsSync(state.worktreePath)) {
        continue; // Already cleaned up
      }
      
      const node = plan.nodes.get(nodeId);
      if (!node) continue;
      
      // Check if all consumers have consumed this node's output
      const consumersReady = this.allConsumersConsumed(plan, node, state);
      if (consumersReady) {
        eligibleNodes.push(nodeId);
      }
    }
    
    // Clean up eligible worktrees
    if (eligibleNodes.length > 0) {
      log.debug(`Cleaning up ${eligibleNodes.length} eligible worktrees`, {
        planId: plan.id,
        nodes: eligibleNodes.map(id => plan.nodes.get(id)?.name || id),
      });
      
      for (const nodeId of eligibleNodes) {
        const state = plan.nodeStates.get(nodeId);
        if (state?.worktreePath) {
          await this.cleanupWorktree(state.worktreePath, plan.repoPath);
          state.worktreeCleanedUp = true;
        }
      }
      
      // Persist the updated state with worktreeCleanedUp flags
      this.persistence.save(plan);
    }
  }
  
  /**
   * Check if all consumers of a node have consumed its output.
   * 
   * A node's output (commit) can be consumed by:
   * - DAG dependents (for non-leaf nodes)
   * - The target branch merge (for leaf nodes)
   * 
   * Once all consumers have consumed, the worktree is safe to remove.
   */
  private allConsumersConsumed(plan: PlanInstance, node: PlanNode, state: NodeExecutionState): boolean {
    // Leaf nodes (no DAG dependents) - consumer is the targetBranch
    if (node.dependents.length === 0) {
      // No target branch = no consumer = safe to cleanup
      if (!plan.targetBranch) {
        return true;
      }
      // Has target branch - check if merge succeeded
      return state.mergedToTarget === true;
    }
    
    // Non-leaf nodes - consumers are dependents
    // Check if all dependents have acknowledged consumption (completed FI)
    const consumedBy = state.consumedByDependents || [];
    return node.dependents.every(depId => consumedBy.includes(depId));
  }
  
  // ============================================================================
  // FORCE FAIL STUCK NODES
  // ============================================================================
  
  /**
   * Force a node to fail immediately, enabling retry.
   * This must ALWAYS work regardless of current state.
   */
  public async forceFailNode(planId: string, nodeId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Plan ${planId} not found`);
    }
    
    const node = plan.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found in plan ${planId}`);
    }
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {
      throw new Error(`Node state ${nodeId} not found in plan ${planId}`);
    }
    
    log.info(`Force failing node ${nodeId} (current status: ${nodeState.status}, attempts: ${nodeState.attempts}, pid: ${nodeState.pid})`);
    
    // First, cancel the executor's execution state so it knows to abort
    // This sets the aborted flag and kills the process via the executor's method
    if (this.executor && 'cancel' in this.executor) {
      try {
        (this.executor as any).cancel(planId, nodeId);
        log.info(`Cancelled executor for node ${nodeId}`);
      } catch (e) {
        log.debug(`Could not cancel executor: ${e}`);
      }
    }
    
    // Also kill any running process using ProcessMonitor for cross-platform support
    // This is a backup in case the executor doesn't have the process tracked
    if (nodeState.pid) {
      try {
        // Use ProcessMonitor.terminate for proper cross-platform process tree killing
        // force=true ensures the process is killed even if it doesn't respond to SIGTERM
        await this.processMonitor.terminate(nodeState.pid, true);
        log.info(`Killed process tree ${nodeState.pid} for node ${nodeId}`);
      } catch (e) {
        // Process may already be dead - that's fine
        log.debug(`Could not kill process ${nodeState.pid}: ${e}`);
      }
    }
    
    // Update node state - ALWAYS force to failed
    const previousStatus = nodeState.status;
    nodeState.status = 'failed';
    nodeState.error = 'Manually failed by user (Force Fail)';
    nodeState.forceFailed = true;  // Flag for UI to show differently
    nodeState.pid = undefined;  // Clear PID
    
    // Increment attempts if it was running (counts as a failed attempt)
    if (previousStatus === 'running') {
      nodeState.attempts = (nodeState.attempts || 0) + 1;
    }
    
    // Set end time
    nodeState.endedAt = Date.now();
    nodeState.version = (nodeState.version || 0) + 1;
    plan.stateVersion = (plan.stateVersion || 0) + 1;
    
    // CRITICAL: Persist immediately
    await this.savePlan(planId);
    
    // CRITICAL: Emit event for UI update
    this.emitNodeTransition({
      planId,
      nodeId,
      previousStatus,
      newStatus: 'failed',
      reason: 'force-failed'
    });
    
    log.info(`Node ${nodeId} force failed successfully. New status: ${nodeState.status}`);
  }

  /**
   * Save plan state to persistence layer.
   */
  private async savePlan(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (plan) {
      this.persistence.save(plan);
    }
  }

  /**
   * Emit node transition event for UI updates.
   */
  private emitNodeTransition(event: {
    planId: string;
    nodeId: string;
    previousStatus: NodeStatus;
    newStatus: NodeStatus;
    reason: string;
  }): void {
    this.emit('nodeTransition', event.planId, event.nodeId, event.previousStatus, event.newStatus);
    this.emit('nodeUpdated', event.planId, event.nodeId);
    this.emit('planUpdated', event.planId);
  }

  // ============================================================================
  // RETRY FAILED NODES
  // ============================================================================
  
  /**
   * Retry a failed node.
   *
   * Resets the node's execution state, optionally replaces its work spec,
   * and re-queues it for scheduling on the next pump cycle. The existing
   * worktree is reused unless `options.clearWorktree` is `true`.
   *
   * @param planId  - Plan ID.
   * @param nodeId  - Node ID to retry.
   * @param options - Optional overrides (new work spec, worktree reset).
   * @returns `{ success: true }` if retry was initiated, or `{ success: false, error }`.
   */
  async retryNode(planId: string, nodeId: string, options?: RetryNodeOptions): Promise<{ success: boolean; error?: string }> {
    const plan = this.plans.get(planId);
    if (!plan) {
      return { success: false, error: `Plan not found: ${planId}` };
    }
    
    const node = plan.nodes.get(nodeId);
    if (!node) {
      return { success: false, error: `Node not found: ${nodeId}` };
    }
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {
      return { success: false, error: `Node state not found: ${nodeId}` };
    }
    
    if (nodeState.status !== 'failed') {
      return { success: false, error: `Node is not in failed state: ${nodeState.status}` };
    }
    
    const sm = this.stateMachines.get(planId);
    if (!sm) {
      return { success: false, error: `State machine not found for Plan: ${planId}` };
    }
    
    log.info(`Retrying failed node: ${node.name}`, {
      planId,
      nodeId,
      hasNewWork: !!options?.newWork,
      clearWorktree: options?.clearWorktree ?? false,
    });
    
    // Handle new work spec if provided
    if (options?.newWork && node.type === 'job') {
      const jobNode = node as JobNode;
      const newWork = options.newWork;
      
      if (typeof newWork === 'string') {
        // String work spec - could be shell command or @agent
        if (newWork.startsWith('@agent')) {
          // Agent work - preserve existing session by default
          jobNode.work = newWork;
        } else {
          // Shell command
          jobNode.work = newWork;
          // Clear session since this is not agent work
          nodeState.copilotSessionId = undefined;
        }
      } else if (newWork.type === 'agent') {
        // Agent spec with explicit options
        // If instructions are empty, this is a "session control only" spec - don't replace work
        if (newWork.instructions) {
          jobNode.work = newWork;
        }
        if (newWork.resumeSession === false) {
          nodeState.copilotSessionId = undefined;
        }
      } else {
        // Process or shell spec - not agent work
        jobNode.work = newWork;
        nodeState.copilotSessionId = undefined;
      }
    }
    
    // Handle new prechecks/postchecks if provided
    if (node.type === 'job') {
      const jobNode = node as JobNode;
      if (options?.newPrechecks !== undefined) {
        // null means remove prechecks entirely
        jobNode.prechecks = options.newPrechecks === null ? undefined : options.newPrechecks;
        log.info(`Updated prechecks for retry: ${node.name}`);
      }
      if (options?.newPostchecks !== undefined) {
        // null means remove postchecks entirely
        jobNode.postchecks = options.newPostchecks === null ? undefined : options.newPostchecks;
        log.info(`Updated postchecks for retry: ${node.name}`);
      }
    }
    
    if (!options?.newWork && node.type === 'job') {
      // No new work provided - auto-generate failure-fixing instructions for agent jobs
      const jobNode = node as JobNode;
      const isAgentWork = typeof jobNode.work === 'string' 
        ? jobNode.work.startsWith('@agent')
        : (jobNode.work && 'type' in jobNode.work && jobNode.work.type === 'agent');
      
      if (isAgentWork && nodeState.copilotSessionId) {
        // This is an agent job with an existing session - generate fix instructions
        const failureContext = this.getNodeFailureContext(planId, nodeId);
        
        if (!('error' in failureContext)) {
          // Build retry instructions that ask AI to fix the issue
          const truncatedLogs = failureContext.logs.length > 2000 
            ? '...' + failureContext.logs.slice(-2000) 
            : failureContext.logs;
          
          const retryInstructions = `@agent The previous attempt at this task failed. Please analyze the error and fix it, then continue the original work.

## Previous Error
Phase: ${failureContext.phase}
Error: ${failureContext.errorMessage}

## Recent Logs
\`\`\`
${truncatedLogs}
\`\`\`

## Instructions
1. Analyze what went wrong in the previous attempt
2. Fix the root cause of the failure
3. Complete the original task: ${(node as JobNode).task || node.name}

Resume working in the existing worktree and session context.`;

          jobNode.work = retryInstructions;
          log.info(`Auto-generated retry instructions for agent job: ${node.name}`);
        }
      }
    }
    
    // Reset node state for retry
    // Note: We do NOT increment nodeState.attempts here - that happens in executeJobNode
    // when the job actually starts running. Incrementing here would cause double-counting.
    nodeState.status = 'pending';
    nodeState.error = undefined;
    nodeState.endedAt = undefined;
    nodeState.startedAt = undefined;
    
    // Determine if we should resume from the failed phase or start fresh.
    //
    // Rules:
    //   - newWork or clearWorktree → always start fresh (work output changed)
    //   - newPrechecks → start fresh (prechecks run before work)
    //   - newPostchecks ONLY, failure was at postchecks → resume from postchecks
    //   - nothing changed → resume from whichever phase failed
    const hasNewWork = !!options?.newWork;
    const hasNewPrechecks = options?.newPrechecks !== undefined;
    const hasNewPostchecks = options?.newPostchecks !== undefined;
    const failedPhase = nodeState.lastAttempt?.phase;
    const shouldResetPhases = hasNewWork || hasNewPrechecks || options?.clearWorktree;
    
    if (shouldResetPhases) {
      // Starting fresh - clear all phase progress
      nodeState.stepStatuses = undefined;
      nodeState.resumeFromPhase = undefined;
      log.info(`Retry with fresh state (hasNewWork=${hasNewWork}, hasNewPrechecks=${hasNewPrechecks}, clearWorktree=${options?.clearWorktree})`);
    } else if (hasNewPostchecks && failedPhase === 'postchecks') {
      // Only postchecks changed and failure was at postchecks - resume from postchecks
      nodeState.resumeFromPhase = 'postchecks' as any;
      log.info(`Retry resuming from postchecks (postchecks updated, failed phase was postchecks)`);
    } else {
      // Resuming - preserve step statuses and set resume point
      if (failedPhase) {
        nodeState.resumeFromPhase = failedPhase as any;
        log.info(`Retry resuming from phase: ${failedPhase}`);
      }
      // stepStatuses are preserved - completed phases will be skipped
    }
    
    // Note: We preserve worktreePath and baseCommit so the work can continue in the same worktree
    // If clearWorktree is true, we'll need to reset git state
    if (options?.clearWorktree && nodeState.worktreePath) {
      // Check if this node has consumed from upstream dependencies
      // If so, clearing the worktree would lose those merged commits
      const upstreamWithCommits: string[] = [];
      for (const depId of node.dependencies) {
        const depState = plan.nodeStates.get(depId);
        if (depState?.completedCommit) {
          const depNode = plan.nodes.get(depId);
          upstreamWithCommits.push(depNode?.name || depId);
        }
      }
      
      if (upstreamWithCommits.length > 0) {
        // Don't allow clearing - would lose upstream merges
        return { 
          success: false, 
          error: `Cannot clear worktree: would lose merged commits from upstream dependencies (${upstreamWithCommits.join(', ')}). ` +
                 `Retry without clearWorktree to preserve upstream work, or manually merge upstream commits after reset.`
        };
      }
      
      // Fetch latest refs so the cleared worktree can be re-based on current branch state
      try {
        await git.repository.fetch(plan.repoPath, { all: true });
        log.info(`Fetched latest refs before clearing worktree for node: ${node.name}`);
      } catch (e: any) {
        log.warn(`Git fetch failed before worktree clear (continuing anyway): ${e.message}`);
      }
      
      // Reset detached HEAD to base commit
      try {
        if (nodeState.baseCommit && nodeState.worktreePath) {
          log.info(`Resetting worktree to base commit: ${nodeState.baseCommit.slice(0, 8)}`);
          await git.executor.execAsync(['reset', '--hard', nodeState.baseCommit], { cwd: nodeState.worktreePath });
          await git.executor.execAsync(['clean', '-fd'], { cwd: nodeState.worktreePath });
        }
      } catch (e: any) {
        log.warn(`Failed to reset worktree: ${e.message}`);
      }
    }
    
    // Clear plan.endedAt so it gets recalculated when the plan completes
    // This handles the case where the plan was previously marked complete
    if (plan.endedAt) {
      plan.endedAt = undefined;
    }
    
    // Check if ready to run (all dependencies succeeded)
    const readyNodes = sm.getReadyNodes();
    if (!readyNodes.includes(nodeId)) {
      // Transition to ready/pending based on dependency state
      sm.resetNodeToPending(nodeId);
    }
    
    // Persist AFTER state transition so the saved status is 'ready' not 'pending'.
    // This prevents a bug where extension reload between save and transition
    // would leave the node stuck in 'pending' forever.
    this.persistence.save(plan);
    
    // Ensure pump is running to process the node
    this.startPump();
    
    this.emit('nodeRetry', planId, nodeId);
    
    return { success: true };
  }
  
  /**
   * Get failure context for a node — useful for AI-assisted retry analysis.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns Logs, phase, error details, and worktree path; or `{ error }` if not found.
   */
  getNodeFailureContext(planId: string, nodeId: string): {
    logs: string;
    phase: string;
    errorMessage: string;
    sessionId?: string;
    lastAttempt?: NodeExecutionState['lastAttempt'];
    worktreePath?: string;
  } | { error: string } {
    const plan = this.plans.get(planId);
    if (!plan) {
      return { error: `Plan not found: ${planId}` };
    }
    
    const node = plan.nodes.get(nodeId);
    if (!node) {
      return { error: `Node not found: ${nodeId}` };
    }
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {
      return { error: `Node state not found: ${nodeId}` };
    }
    
    // Get logs for this node
    const logsText = this.getNodeLogs(planId, nodeId);
    
    return {
      logs: logsText,
      phase: nodeState.lastAttempt?.phase || 'unknown',
      errorMessage: nodeState.error || 'Unknown error',
      sessionId: nodeState.copilotSessionId,
      lastAttempt: nodeState.lastAttempt,
      worktreePath: nodeState.worktreePath,
    };
  }
  
  // ============================================================================
  // WORK SUMMARY
  // ============================================================================
  
  /**
   * Append a job's work summary to the Plan's aggregated summary
   */
  private appendWorkSummary(plan: PlanInstance, jobSummary: JobWorkSummary): void {
    plan.workSummary = appendWorkSummaryHelper(plan.workSummary, jobSummary);
  }
  
  // ============================================================================
  // EVENT WIRING
  // ============================================================================
  
  /**
   * Setup listeners on a state machine
   */
  private setupStateMachineListeners(sm: PlanStateMachine): void {
    sm.on('transition', (event: NodeTransitionEvent) => {
      this.emit('nodeTransition', event);
    });
    
    sm.on('planComplete', (event: PlanCompletionEvent) => {
      const plan = this.plans.get(event.planId);
      if (plan) {
        this.emit('planCompleted', plan, event.status);
        // Update wake lock in case this was the last running plan
        this.updateWakeLock().catch(err => log.warn('Failed to update wake lock', { error: err }));
      }
    });
  }
}
