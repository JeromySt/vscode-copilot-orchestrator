/**
 * @fileoverview Scheduler Types - Shared abstractions for work unit orchestration.
 * 
 * This module defines the common patterns shared between JobRunner and PlanRunner:
 * - Work unit lifecycle states
 * - Scheduler interface for queue management
 * - Execution strategy interface for pluggable "how" implementations
 * 
 * @module core/scheduler/types
 */

import * as vscode from 'vscode';

// ============================================================================
// WORK UNIT STATUS
// ============================================================================

/**
 * Status of a work unit (job or plan).
 */
export type WorkUnitStatus = 
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'partial';  // Plans only: some jobs succeeded, some failed

/**
 * Check if a status represents a terminal (completed) state.
 */
export function isTerminalStatus(status: WorkUnitStatus): boolean {
  return ['succeeded', 'failed', 'canceled', 'partial'].includes(status);
}

/**
 * Check if a status represents an active (in-progress) state.
 */
export function isActiveStatus(status: WorkUnitStatus): boolean {
  return status === 'queued' || status === 'running';
}

// ============================================================================
// WORK UNIT INTERFACE
// ============================================================================

/**
 * Base interface for any schedulable work unit.
 * Both Job and Plan implement this.
 */
export interface WorkUnit {
  /** Unique identifier */
  id: string;
  /** Current status */
  status: WorkUnitStatus;
  /** When the work unit was queued */
  queuedAt?: number;
  /** When execution started */
  startedAt?: number;
  /** When execution ended */
  endedAt?: number;
}

/**
 * Base interface for work unit specifications (input to scheduler).
 */
export interface WorkUnitSpec {
  /** Unique identifier (auto-generated if not provided) */
  id?: string;
}

// ============================================================================
// SCHEDULER INTERFACE
// ============================================================================

/**
 * Configuration for a scheduler instance.
 */
export interface SchedulerConfig {
  /** Maximum concurrent work units */
  maxConcurrency: number;
  /** Path for persistence file */
  persistPath: string;
  /** Pump interval in milliseconds (0 = manual pump only) */
  pumpIntervalMs?: number;
}

/**
 * Events emitted by a scheduler.
 */
export interface SchedulerEvents<TState extends WorkUnit> {
  /** Fired when any work unit state changes */
  onDidChange: vscode.Event<void>;
  /** Fired when a work unit completes (success or failure) */
  onDidComplete: vscode.Event<TState>;
}

/**
 * Core scheduler interface for managing work unit queues.
 * 
 * @template TSpec - Work unit specification type (input)
 * @template TState - Work unit state type (runtime)
 */
export interface IScheduler<TSpec extends WorkUnitSpec, TState extends WorkUnit> 
  extends SchedulerEvents<TState> {
  
  // ---- Queue Management ----
  
  /** Add a work unit to the queue */
  enqueue(spec: TSpec): string;
  
  /** List all work units */
  list(): TState[];
  
  /** Get a specific work unit by ID */
  get(id: string): TState | undefined;
  
  // ---- Lifecycle Control ----
  
  /** Cancel a work unit */
  cancel(id: string): boolean;
  
  /** Retry a failed/canceled work unit */
  retry(id: string, context?: string): boolean;
  
  /** Delete a work unit (must be in terminal state or will be canceled first) */
  delete(id: string): boolean;
  
  // ---- Scheduler Control ----
  
  /** Start the scheduler pump loop */
  start(): void;
  
  /** Stop the scheduler pump loop */
  stop(): void;
  
  /** Manually trigger a pump cycle */
  pump(): void;
  
  /** Dispose of resources */
  dispose(): void;
}

// ============================================================================
// EXECUTION STRATEGY
// ============================================================================

/**
 * Strategy interface for executing work units.
 * 
 * This is the "how" that differs between JobRunner and PlanRunner:
 * - JobRunner: Spawns CLI processes
 * - PlanRunner: Manages DAG dependencies and delegates to JobRunner
 * 
 * @template TSpec - Work unit specification type
 * @template TState - Work unit state type
 */
export interface ExecutionStrategy<TSpec extends WorkUnitSpec, TState extends WorkUnit> {
  /**
   * Initialize state from a specification.
   * Called when a new work unit is enqueued.
   */
  createState(spec: TSpec): TState;
  
  /**
   * Get IDs of work units ready to execute.
   * For jobs: returns queued job IDs up to available capacity
   * For plans: returns jobs whose dependencies are satisfied
   */
  getReady(state: TState, maxCount: number): string[];
  
  /**
   * Execute a work unit (or start its execution).
   * Called by the scheduler when capacity is available.
   */
  execute(id: string, state: TState): Promise<void>;
  
  /**
   * Check and update status of running work units.
   * Called periodically by the pump loop.
   */
  updateStatus(state: TState): void;
  
  /**
   * Handle retry of a work unit.
   * Returns true if retry was initiated.
   */
  retry(id: string, state: TState, context?: string): boolean;
  
  /**
   * Handle cancellation of a work unit.
   */
  cancel(id: string, state: TState): void;
  
  /**
   * Clean up resources for a work unit.
   * Called when deleting or after completion.
   */
  cleanup(id: string, state: TState): Promise<void>;
  
  /**
   * Serialize state for persistence.
   */
  serialize(state: TState): object;
  
  /**
   * Deserialize state from persistence.
   */
  deserialize(data: object): TState;
}

// ============================================================================
// PERSISTENCE
// ============================================================================

/**
 * Interface for work unit persistence.
 */
export interface SchedulerPersistence<TState extends WorkUnit> {
  /** Load all persisted work units */
  load(): Map<string, TState>;
  
  /** Save all work units */
  save(items: Map<string, TState>): void;
  
  /** Path to persistence file */
  readonly path: string;
}
