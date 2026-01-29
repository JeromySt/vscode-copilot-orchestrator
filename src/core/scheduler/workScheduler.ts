/**
 * @fileoverview Unified Work Scheduler Facade.
 *
 * Provides a single entry point for scheduling both jobs and plans,
 * wrapping the existing JobRunner and PlanRunner implementations.
 *
 * This facade:
 * - Abstracts the difference between jobs and plans
 * - Provides a unified event model
 * - Enables future migration to the full scheduler abstraction
 *
 * @module core/scheduler/workScheduler
 */

import * as vscode from 'vscode';
import { JobRunner, Job, JobSpec } from '../jobRunner';
import { PlanRunner, PlanSpec, PlanState as RunnerPlanState } from '../planRunner';
import { WorkUnitStatus, isTerminalStatus } from './types';

// Re-export PlanState with a distinct name to avoid collision
export type PlanStateInfo = RunnerPlanState;

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
// Work Scheduler Facade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified facade for scheduling jobs and plans.
 *
 * Wraps the existing JobRunner and PlanRunner to provide a consistent
 * interface while maintaining backward compatibility.
 *
 * @example
 * ```typescript
 * const scheduler = new WorkScheduler(ctx);
 *
 * // Schedule a job
 * scheduler.enqueueJob(jobSpec);
 *
 * // Schedule a plan
 * scheduler.enqueuePlan(planSpec);
 *
 * // List all work
 * const all = scheduler.list();
 *
 * // React to changes
 * scheduler.events.onDidChange(unit => {
 *   console.log(`${unit.name} is now ${unit.status}`);
 * });
 * ```
 */
export class WorkScheduler {
  private readonly jobRunner: JobRunner;
  private readonly planRunner: PlanRunner;

  private readonly _onDidChange = new vscode.EventEmitter<UnifiedWorkUnit>();
  private readonly _onDidComplete = new vscode.EventEmitter<UnifiedWorkUnit>();

  private pollInterval?: ReturnType<typeof setInterval>;
  private previousStates = new Map<string, WorkUnitStatus>();

  /**
   * Events emitted by the scheduler.
   */
  public readonly events: WorkSchedulerEvents = {
    onDidChange: this._onDidChange.event,
    onDidComplete: this._onDidComplete.event,
  };

  constructor(ctx: vscode.ExtensionContext) {
    this.jobRunner = new JobRunner(ctx);
    this.planRunner = new PlanRunner(this.jobRunner);

    // Start polling for state changes
    this.startPolling();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Job Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue a job for execution.
   */
  enqueueJob(spec: JobSpec): void {
    this.jobRunner.enqueue(spec);
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
   * Cancel a running job.
   */
  cancelJob(jobId: string): void {
    this.jobRunner.cancel(jobId);
  }

  /**
   * Delete a job and its resources.
   */
  deleteJob(jobId: string): boolean {
    return this.jobRunner.delete(jobId);
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
   */
  enqueuePlan(spec: PlanSpec): void {
    this.planRunner.enqueue(spec);
  }

  /**
   * Cancel a running plan.
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
  delete(id: string): boolean {
    // Try job first
    const job = this.jobRunner.list().find((j: Job) => j.id === id);
    if (job) {
      return this.deleteJob(id);
    }

    // Plans don't support delete currently
    return false;
  }

  /**
   * Get maximum concurrent workers.
   */
  get maxWorkers(): number {
    return this.jobRunner.maxWorkers;
  }

  /**
   * Set maximum concurrent workers.
   */
  set maxWorkers(value: number) {
    this.jobRunner.maxWorkers = value;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
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
      const stepStatus =
        stepStatuses[phase as keyof typeof stepStatuses];
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
    this._onDidChange.dispose();
    this._onDidComplete.dispose();
  }
}
