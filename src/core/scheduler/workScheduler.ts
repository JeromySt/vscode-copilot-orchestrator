/**
 * @fileoverview Unified Work Scheduler with Global Concurrency Control.
 *
 * The WorkScheduler manages all job execution with extension-level
 * concurrency control via `copilotOrchestrator.maxConcurrentJobs`.
 *
 * Key design decisions:
 * - Jobs are queued globally and executed FIFO up to maxConcurrentJobs
 * - Plans do NOT count against concurrency (they just schedule jobs)
 * - Concurrency is configured at extension level, not per-plan/per-API
 * - Configuration changes are applied immediately
 *
 * @module core/scheduler/workScheduler
 */

import * as vscode from 'vscode';
import { JobRunner, Job, JobSpec } from '../jobRunner';
import { PlanRunner, PlanSpec, PlanState as RunnerPlanState } from '../planRunner';
import { WorkUnitStatus, isTerminalStatus } from './types';
import { cpuCountMinusOne } from '../utils';

// Re-export PlanState with a distinct name to avoid collision
export type PlanStateInfo = RunnerPlanState;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration section name. */
const CONFIG_SECTION = 'copilotOrchestrator';

/** Configuration key for max concurrent jobs. */
const CONFIG_MAX_CONCURRENT_JOBS = 'maxConcurrentJobs';

/**
 * Get the configured maximum concurrent jobs.
 * Returns cpuCount - 1 if set to 0 (auto) or not configured.
 */
function getMaxConcurrentJobs(): number {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const value = config.get<number>(CONFIG_MAX_CONCURRENT_JOBS, 0);
  
  // 0 or unset = auto (CPU count - 1)
  if (!value || value <= 0) {
    return cpuCountMinusOne();
  }
  
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Work unit types supported by the scheduler.
 */
export type WorkUnitType = 'job' | 'plan';

/**
 * Unified work unit representation.
 */
export interface UnifiedWorkUnit {
  /** Unique identifier. */
  id: string;

  /** Type of work unit. */
  type: WorkUnitType;

  /** Human-readable name. */
  name: string;

  /** Current execution status. */
  status: WorkUnitStatus;

  /** Timestamp when work started (ms since epoch). */
  startedAt?: number;

  /** Timestamp when work ended (ms since epoch). */
  endedAt?: number;

  /** Progress percentage (0-100) or -1 if not applicable. */
  progress: number;

  /** Type-specific details. */
  details: Job | RunnerPlanState;
}

/**
 * Events emitted by the work scheduler.
 */
export interface WorkSchedulerEvents {
  /** Fired when any work unit changes state. */
  onDidChange: vscode.Event<UnifiedWorkUnit>;

  /** Fired when a work unit completes (success, failure, or cancel). */
  onDidComplete: vscode.Event<UnifiedWorkUnit>;

  /** Fired when concurrency configuration changes. */
  onDidChangeConcurrency: vscode.Event<number>;
}

/**
 * Statistics about the scheduler state.
 */
export interface SchedulerStats {
  /** Number of jobs currently running. */
  runningJobs: number;

  /** Number of jobs waiting in queue. */
  queuedJobs: number;

  /** Maximum concurrent jobs allowed. */
  maxConcurrentJobs: number;

  /** Number of plans currently active (not counting against concurrency). */
  activePlans: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map legacy runner status to unified status.
 */
function mapJobStatus(status: Job['status']): WorkUnitStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'queued';
  }
}

/**
 * Map plan status to unified status.
 */
function mapPlanStatus(status: RunnerPlanState['status']): WorkUnitStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'partial':
      return 'partial';
    default:
      return 'queued';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Scheduler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified scheduler managing jobs and plans with global concurrency control.
 *
 * ## Concurrency Model
 *
 * - **Jobs** are the unit of work that consumes concurrency slots
 * - **Plans** orchestrate jobs but do NOT consume concurrency slots
 * - Global `maxConcurrentJobs` from extension settings controls parallelism
 * - Jobs are executed FIFO (first-in, first-out)
 *
 * ## Configuration
 *
 * Set `copilotOrchestrator.maxConcurrentJobs` in VS Code settings:
 * - `0` (default): Auto-detect based on CPU count - 1
 * - `1-N`: Fixed concurrency limit
 *
 * @example
 * ```typescript
 * const scheduler = new WorkScheduler(ctx);
 *
 * // Check current state
 * const stats = scheduler.getStats();
 * console.log(`Running: ${stats.runningJobs}/${stats.maxConcurrentJobs}`);
 *
 * // Schedule jobs (queued until slot available)
 * scheduler.enqueueJob(jobSpec1);
 * scheduler.enqueueJob(jobSpec2);
 *
 * // Plans schedule jobs internally
 * scheduler.enqueuePlan(planSpec);
 *
 * // React to concurrency changes
 * scheduler.events.onDidChangeConcurrency(max => {
 *   console.log(`New max concurrent jobs: ${max}`);
 * });
 * ```
 */
export class WorkScheduler {
  private readonly ctx: vscode.ExtensionContext;
  private readonly jobRunner: JobRunner;
  private readonly planRunner: PlanRunner;

  // Event emitters
  private readonly _onDidChange = new vscode.EventEmitter<UnifiedWorkUnit>();
  private readonly _onDidComplete = new vscode.EventEmitter<UnifiedWorkUnit>();
  private readonly _onDidChangeConcurrency = new vscode.EventEmitter<number>();

  private pollInterval?: ReturnType<typeof setInterval>;
  private previousStates = new Map<string, WorkUnitStatus>();
  private configDisposable?: vscode.Disposable;

  /**
   * Events emitted by the scheduler.
   */
  public readonly events: WorkSchedulerEvents = {
    onDidChange: this._onDidChange.event,
    onDidComplete: this._onDidComplete.event,
    onDidChangeConcurrency: this._onDidChangeConcurrency.event,
  };

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    this.jobRunner = new JobRunner(ctx);
    this.planRunner = new PlanRunner(this.jobRunner);

    // Sync JobRunner's maxWorkers with our config
    this.syncJobRunnerMaxWorkers();

    // Watch for configuration changes
    this.configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_MAX_CONCURRENT_JOBS}`)) {
        const newMax = getMaxConcurrentJobs();
        this.syncJobRunnerMaxWorkers();
        this._onDidChangeConcurrency.fire(newMax);
      }
    });

    // Start polling for state changes
    this.startPolling();
  }

  /**
   * Keep JobRunner's maxWorkers in sync with extension config.
   */
  private syncJobRunnerMaxWorkers(): void {
    this.jobRunner.maxWorkers = getMaxConcurrentJobs();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Configuration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get maximum concurrent jobs from extension configuration.
   */
  get maxConcurrentJobs(): number {
    return getMaxConcurrentJobs();
  }

  /**
   * Get scheduler statistics.
   */
  getStats(): SchedulerStats {
    const jobs = this.jobRunner.list();
    const plans = this.planRunner.list();

    return {
      runningJobs: jobs.filter(j => j.status === 'running').length,
      queuedJobs: jobs.filter(j => j.status === 'queued').length,
      maxConcurrentJobs: this.maxConcurrentJobs,
      activePlans: plans.filter(p => p.status === 'running' || p.status === 'queued').length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Job Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue a job for execution.
   * Jobs are queued globally and executed FIFO up to maxConcurrentJobs.
   */
  enqueueJob(spec: JobSpec): string {
    // Delegate to JobRunner which handles ID generation and persistence
    this.jobRunner.enqueue(spec);
    return spec.id;
  }

  /**
   * Retry a failed job.
   */
  retryJob(jobId: string, updatedContext?: string): void {
    this.jobRunner.retry(jobId, updatedContext);
  }

  /**
   * Continue a job with new instructions.
   */
  continueJob(jobId: string, newInstructions: string): boolean {
    return this.jobRunner.continueWork(jobId, newInstructions);
  }

  /**
   * Cancel a running or queued job.
   */
  cancelJob(jobId: string): void {
    this.jobRunner.cancel(jobId);
  }

  /**
   * Delete a job and its resources.
   */
  async deleteJob(jobId: string): Promise<boolean> {
    return this.jobRunner.delete(jobId);
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): Job | undefined {
    return this.jobRunner.list().find(j => j.id === jobId);
  }

  /**
   * Get all jobs.
   */
  listJobs(): Job[] {
    return this.jobRunner.list();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plan Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue a plan for execution.
   * Plans orchestrate jobs but do NOT count against concurrency.
   */
  enqueuePlan(spec: PlanSpec): void {
    this.planRunner.enqueue(spec);
  }

  /**
   * Cancel a running plan and all its pending jobs.
   */
  cancelPlan(planId: string): void {
    this.planRunner.cancel(planId);
  }

  /**
   * Get a specific plan.
   */
  getPlan(planId: string): RunnerPlanState | undefined {
    return this.planRunner.get(planId);
  }

  /**
   * Get all plans.
   */
  listPlans(): RunnerPlanState[] {
    return this.planRunner.list();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Unified Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all work units (jobs and plans).
   */
  list(): UnifiedWorkUnit[] {
    const jobs = this.jobRunner.list().map((j: Job) => this.jobToUnified(j));
    const plans = this.planRunner.list().map((p: RunnerPlanState) => this.planToUnified(p));
    return [...jobs, ...plans];
  }

  /**
   * Get a work unit by ID.
   */
  get(id: string): UnifiedWorkUnit | undefined {
    // Check jobs first
    const job = this.jobRunner.list().find((j: Job) => j.id === id);
    if (job) {
      return this.jobToUnified(job);
    }

    // Check plans
    const plan = this.planRunner.get(id);
    if (plan) {
      return this.planToUnified(plan);
    }

    return undefined;
  }

  /**
   * Cancel any work unit by ID.
   */
  cancel(id: string): void {
    // Try job first
    const job = this.jobRunner.list().find((j: Job) => j.id === id);
    if (job) {
      this.cancelJob(id);
      return;
    }

    // Try plan
    const plan = this.planRunner.get(id);
    if (plan) {
      this.cancelPlan(id);
    }
  }

  /**
   * Delete any work unit by ID.
   */
  async delete(id: string): Promise<boolean> {
    // Try job first
    const job = this.jobRunner.list().find((j: Job) => j.id === id);
    if (job) {
      return this.deleteJob(id);
    }

    // Plans don't support delete currently
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Convert a Job to UnifiedWorkUnit.
   */
  private jobToUnified(job: Job): UnifiedWorkUnit {
    return {
      id: job.id,
      type: 'job',
      name: job.name,
      status: mapJobStatus(job.status),
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      progress: this.calculateJobProgress(job),
      details: job,
    };
  }

  /**
   * Convert a PlanState to UnifiedWorkUnit.
   */
  private planToUnified(plan: RunnerPlanState): UnifiedWorkUnit {
    return {
      id: plan.id,
      type: 'plan',
      name: plan.id, // Plans use ID as name
      status: mapPlanStatus(plan.status),
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
      progress: this.calculatePlanProgress(plan),
      details: plan,
    };
  }

  /**
   * Calculate job progress percentage.
   */
  private calculateJobProgress(job: Job): number {
    const phaseWeights: Record<string, number> = {
      prechecks: 10,
      work: 70,
      postchecks: 85,
      mergeback: 95,
      cleanup: 100,
    };

    if (job.status === 'succeeded') return 100;
    if (job.status === 'failed' || job.status === 'canceled') return -1;
    if (job.status === 'queued') return 0;

    const currentStep = job.currentStep;
    if (!currentStep) return 5;

    const stepStatuses = job.stepStatuses || {};
    const phases = ['prechecks', 'work', 'postchecks', 'mergeback', 'cleanup'];
    let progress = 0;

    for (const phase of phases) {
      const stepStatus = stepStatuses[phase as keyof typeof stepStatuses];
      if (stepStatus === 'success' || stepStatus === 'skipped') {
        progress = phaseWeights[phase];
      } else if (phase === currentStep) {
        const prevPhase = phases[phases.indexOf(phase) - 1];
        const prevProgress = prevPhase ? phaseWeights[prevPhase] : 0;
        progress = prevProgress + (phaseWeights[phase] - prevProgress) / 2;
        break;
      }
    }

    return Math.round(progress);
  }

  /**
   * Calculate plan progress percentage.
   */
  private calculatePlanProgress(plan: RunnerPlanState): number {
    const total =
      plan.queued.length +
      plan.running.length +
      plan.done.length +
      plan.failed.length +
      plan.canceled.length;

    if (total === 0) return 0;
    if (plan.status === 'succeeded') return 100;
    if (plan.status === 'failed' || plan.status === 'partial') return -1;
    if (plan.status === 'canceled') return -1;

    const completed = plan.done.length + plan.failed.length + plan.canceled.length;
    return Math.round((completed / total) * 100);
  }

  /**
   * Start polling for state changes.
   */
  private startPolling(): void {
    this.pollInterval = setInterval(() => this.checkForChanges(), 500);
  }

  /**
   * Stop polling.
   */
  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  /**
   * Check for state changes and emit events.
   */
  private checkForChanges(): void {
    const units = this.list();

    for (const unit of units) {
      const previousStatus = this.previousStates.get(unit.id);

      if (previousStatus !== unit.status) {
        // Status changed
        this._onDidChange.fire(unit);

        // Check if completed
        if (isTerminalStatus(unit.status)) {
          this._onDidComplete.fire(unit);
        }

        // Update tracked state
        this.previousStates.set(unit.id, unit.status);
      }
    }

    // Clean up old entries for deleted work units
    const currentIds = new Set(units.map(u => u.id));
    for (const id of this.previousStates.keys()) {
      if (!currentIds.has(id)) {
        this.previousStates.delete(id);
      }
    }
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.stopPolling();
    this.configDisposable?.dispose();
    this._onDidChange.dispose();
    this._onDidComplete.dispose();
    this._onDidChangeConcurrency.dispose();
  }
}
