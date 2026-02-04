/**
 * @fileoverview Plan Execution Strategy - Adapts PlanRunner to Scheduler pattern.
 * 
 * Plans are complex work units that:
 * - Manage a DAG of dependent jobs
 * - Delegate actual execution to JobRunner
 * - Handle branch merging and cleanup
 * 
 * @module core/scheduler/planStrategy
 */

import * as vscode from 'vscode';
import { ExecutionStrategy, WorkUnit, WorkUnitSpec, WorkUnitStatus, IScheduler } from './types';
import { Logger } from '../logger';
import type { PlanSpec, PlanJob, InternalPlanState } from '../plan/types';
import type { Job } from '../job/types';

const log = Logger.for('plans');

// ============================================================================
// PLAN-SPECIFIC TYPES
// ============================================================================

/**
 * Plan state extends WorkUnit with plan-specific fields.
 */
export interface PlanState extends WorkUnit {
  /** Plan specification */
  spec: PlanSpec;
  /** IDs of jobs waiting to run */
  queued: string[];
  /** IDs of jobs currently running */
  running: string[];
  /** IDs of completed jobs */
  completed: string[];
  /** IDs of failed jobs */
  failed: string[];
  /** IDs of canceled jobs */
  canceled: string[];
  /** Map of plan job ID to runner job ID */
  jobIdMap: Map<string, string>;
  /** Map of completed job ID to its commit SHA */
  completedCommits: Map<string, string>;
  /** Target branch root for this plan */
  targetBranchRoot?: string;
}

// ============================================================================
// PLAN EXECUTION STRATEGY
// ============================================================================

/**
 * Execution strategy for plans (DAGs of jobs).
 * 
 * Plans orchestrate multiple jobs with dependencies:
 * - Track dependency graph (consumesFrom)
 * - Delegate job execution to a JobScheduler
 * - Handle branch chaining between jobs
 * - Merge leaf branches at completion
 */
export class PlanExecutionStrategy implements ExecutionStrategy<PlanSpec, PlanState> {
  constructor(
    private jobScheduler: IScheduler<any, Job>
  ) {}
  
  /**
   * Create initial state from a plan specification.
   */
  createState(spec: PlanSpec): PlanState {
    // Find root jobs (no dependencies)
    const rootJobs = spec.jobs.filter(j => j.consumesFrom.length === 0);
    
    return {
      id: spec.id || `plan-${Date.now()}`,
      status: 'queued',
      spec,
      // Queue by job name (used for state tracking and consumesFrom references)
      queued: rootJobs.map(j => j.name),
      running: [],
      completed: [],
      failed: [],
      canceled: [],
      jobIdMap: new Map(),
      completedCommits: new Map()
    };
  }
  
  /**
   * Get ready job IDs from the plan.
   * A job is ready when all its dependencies (consumesFrom) are completed.
   */
  getReady(state: PlanState, maxCount: number): string[] {
    if (state.status !== 'running' && state.status !== 'queued') {
      return [];
    }
    
    const ready: string[] = [];
    const currentlyRunning = state.running.length;
    const maxParallel = state.spec.maxParallel || 4;
    const available = Math.min(maxCount, maxParallel - currentlyRunning);
    
    // state.queued contains job names
    for (const jobName of state.queued) {
      if (ready.length >= available) break;
      
      // Find job by name
      const job = state.spec.jobs.find(j => j.name === jobName);
      if (!job) continue;
      
      // Check if all dependencies are satisfied (consumesFrom uses names)
      const depsCompleted = job.consumesFrom.every(
        depName => state.completed.includes(depName)
      );
      
      if (depsCompleted) {
        ready.push(jobName);
      }
    }
    
    return ready;
  }
  
  /**
   * Execute a job within the plan.
   * This delegates to the JobScheduler.
   */
  async execute(jobName: string, state: PlanState): Promise<void> {
    // Find job by name (state arrays use names)
    const planJob = state.spec.jobs.find(j => j.name === jobName);
    if (!planJob) {
      log.error(`Job ${jobName} not found in plan ${state.id}`);
      return;
    }
    
    log.info(`Scheduling job ${jobName} for plan ${state.id}`);
    
    // Mark as running in plan state (by name)
    state.queued = state.queued.filter(name => name !== jobName);
    state.running.push(jobName);
    
    if (state.status === 'queued') {
      state.status = 'running';
      state.startedAt = Date.now();
    }
    
    // Compute base branch from completed dependencies
    const baseBranch = this.computeBaseBranch(planJob, state);
    
    // Create job spec for the JobScheduler
    // Note: planJob.id is already the UUID, planJob.name is user-friendly
    const runnerJobId = this.jobScheduler.enqueue({
      id: planJob.id,
      name: planJob.name,
      task: planJob.task || 'plan-job',
      inputs: {
        ...planJob.inputs,
        baseBranch,
        isPlanManaged: true
      },
      policy: planJob.policy || {
        useJust: true,
        steps: {
          prechecks: 'just pre',
          work: planJob.inputs.instructions || '@agent Complete the assigned task',
          postchecks: 'just post'
        }
      }
    });
    
    // Track the mapping (jobName -> runnerJobId)
    state.jobIdMap.set(jobName, runnerJobId);
  }
  
  /**
   * Update status of running jobs in the plan.
   */
  updateStatus(state: PlanState): void {
    if (state.status !== 'running') return;
    
    // Check status of each running job (running array contains names)
    for (const jobName of [...state.running]) {
      const runnerJobId = state.jobIdMap.get(jobName);
      if (!runnerJobId) continue;
      
      const job = this.jobScheduler.get(runnerJobId);
      if (!job) continue;
      
      switch (job.status) {
        case 'succeeded':
          state.running = state.running.filter(name => name !== jobName);
          state.completed.push(jobName);
          // Record the completed commit (if available)
          if ((job as any).completedCommit) {
            state.completedCommits.set(jobName, (job as any).completedCommit);
          }
          // Queue dependent jobs
          this.queueDependentJobs(jobName, state);
          break;
          
        case 'failed':
          state.running = state.running.filter(name => name !== jobName);
          state.failed.push(jobName);
          break;
          
        case 'canceled':
          state.running = state.running.filter(name => name !== jobName);
          state.canceled.push(jobName);
          break;
      }
    }
    
    // Check if plan is complete
    this.checkCompletion(state);
  }
  
  /**
   * Retry failed jobs in a plan.
   */
  retry(id: string, state: PlanState, context?: string): boolean {
    if (!['failed', 'partial'].includes(state.status)) {
      return false;
    }
    
    log.info(`Retrying plan: ${id}`);
    
    // Re-queue failed jobs
    state.queued.push(...state.failed);
    state.failed = [];
    state.status = 'running';
    
    return true;
  }
  
  /**
   * Cancel a plan and all its running jobs.
   */
  cancel(id: string, state: PlanState): void {
    log.info(`Canceling plan: ${id}`);
    
    // Cancel all running jobs (running array contains names)
    for (const jobName of state.running) {
      const runnerJobId = state.jobIdMap.get(jobName);
      if (runnerJobId) {
        this.jobScheduler.cancel(runnerJobId);
      }
    }
    
    state.canceled.push(...state.running, ...state.queued);
    state.running = [];
    state.queued = [];
  }
  
  /**
   * Clean up plan resources.
   */
  async cleanup(id: string, state: PlanState): Promise<void> {
    log.info(`Cleaning up plan: ${id}`);
    
    // Delete all jobs in the plan
    for (const [_, runnerJobId] of state.jobIdMap) {
      this.jobScheduler.delete(runnerJobId);
    }
    
    // Clean up worktrees, branches, etc.
    // This would use the cleanupManager in real implementation
  }
  
  /**
   * Serialize state for persistence.
   */
  serialize(state: PlanState): object {
    return {
      id: state.id,
      status: state.status,
      spec: state.spec,
      queued: state.queued,
      running: state.running,
      completed: state.completed,
      failed: state.failed,
      canceled: state.canceled,
      jobIdMap: Object.fromEntries(state.jobIdMap),
      completedCommits: Object.fromEntries(state.completedCommits),
      targetBranchRoot: state.targetBranchRoot,
      queuedAt: state.queuedAt,
      startedAt: state.startedAt,
      endedAt: state.endedAt
    };
  }
  
  /**
   * Deserialize state from persistence.
   */
  deserialize(data: object): PlanState {
    const d = data as any;
    return {
      id: d.id,
      status: d.status as WorkUnitStatus,
      spec: d.spec,
      queued: d.queued || [],
      running: d.running || [],
      completed: d.completed || [],
      failed: d.failed || [],
      canceled: d.canceled || [],
      jobIdMap: new Map(Object.entries(d.jobIdMap || {})),
      completedCommits: new Map(Object.entries(d.completedCommits || {})),
      targetBranchRoot: d.targetBranchRoot,
      queuedAt: d.queuedAt,
      startedAt: d.startedAt,
      endedAt: d.endedAt
    };
  }
  
  // ---- Helper Methods ----
  
  private computeBaseBranch(job: PlanJob, state: PlanState): string {
    if (job.consumesFrom.length === 0) {
      // Root job - use target branch root
      return state.targetBranchRoot || state.spec.baseBranch || 'main';
    }
    
    if (job.consumesFrom.length === 1) {
      // Single dependency - use its completed commit
      const depCommit = state.completedCommits.get(job.consumesFrom[0]);
      return depCommit || state.targetBranchRoot || 'main';
    }
    
    // Multiple dependencies - would need merge branch
    // For now, use first dependency's commit
    const firstDepCommit = state.completedCommits.get(job.consumesFrom[0]);
    return firstDepCommit || state.targetBranchRoot || 'main';
  }
  
  private queueDependentJobs(completedJobName: string, state: PlanState): void {
    // Find jobs that depend on the completed job (consumesFrom uses names)
    for (const job of state.spec.jobs) {
      if (job.consumesFrom.includes(completedJobName)) {
        // Check if all dependencies are now complete (by name)
        const allDepsComplete = job.consumesFrom.every(
          depName => state.completed.includes(depName)
        );
        
        // Queue by name, check against name
        if (allDepsComplete && !state.queued.includes(job.name) && 
            !state.running.includes(job.name) && !state.completed.includes(job.name)) {
          state.queued.push(job.name);
        }
      }
    }
  }
  
  private checkCompletion(state: PlanState): void {
    const totalJobs = state.spec.jobs.length;
    const completedCount = state.completed.length;
    const failedCount = state.failed.length;
    const canceledCount = state.canceled.length;
    
    if (completedCount + failedCount + canceledCount === totalJobs) {
      // All jobs finished
      state.endedAt = Date.now();
      
      if (failedCount > 0 && completedCount > 0) {
        state.status = 'partial';
      } else if (failedCount > 0 || canceledCount === totalJobs) {
        state.status = 'failed';
      } else if (canceledCount > 0) {
        state.status = 'canceled';
      } else {
        state.status = 'succeeded';
      }
      
      log.info(`Plan ${state.id} completed with status: ${state.status}`);
    }
  }
}
