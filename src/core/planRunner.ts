/**
 * @fileoverview Plan Runner - Orchestrates multi-job execution plans with worktree management.
 * 
 * ## Worktree Ownership Model
 * 
 * Plans own and manage all worktrees for their jobs:
 * - Plan creates worktrees before scheduling jobs
 * - Jobs execute in pre-created worktrees (isPlanManaged = true)
 * - Jobs do NOT perform branch creation or mergeback
 * - Plan handles merging completed job branches
 * - Plan cleans up all worktrees at completion
 * 
 * ## Branch Origin Rules
 * 
 * - Default branch (main, master) → Plan creates feature branch as targetBranchRoot
 * - Non-default branch → Plan uses baseBranch as targetBranchRoot
 * 
 * ## Execution Flow
 * 
 * 1. Plan enqueued with baseBranch
 * 2. Plan resolves targetBranchRoot (create if default branch)
 * 3. For each job ready to run:
 *    a. Compute job's source branch (targetBranchRoot or parent's completed branch)
 *    b. Create worktree for job
 *    c. Submit job with isPlanManaged=true, worktreePath=<path>
 * 4. When job completes:
 *    a. Record completed branch
 *    b. If downstream jobs depend on it, they can now run
 * 5. When all jobs complete:
 *    a. Merge leaf branches back to targetBranchRoot
 *    b. Clean up all worktrees
 * 
 * @module core/planRunner
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JobRunner, JobSpec, Job } from './jobRunner';
import { randomUUID } from 'crypto';
import { Logger, ComponentLogger } from './logger';
import * as git from '../git';

// Import from plan modules
import {
  PlanJob,
  SubPlanJob,
  SubPlanSpec,
  PlanSpec,
  PlanState,
  InternalPlanState,
  toPublicState,
  createInternalState,
  isCompletedStatus,
} from './plan/types';
import { PlanPersistence } from './plan/persistence';
import * as mergeManager from './plan/mergeManager';
import * as cleanupManager from './plan/cleanupManager';

// Re-export types for external consumers
export type { PlanJob, SubPlanJob, SubPlanSpec, PlanSpec, PlanState };

/** Plan runner component logger */
const log: ComponentLogger = Logger.for('plans');

// ============================================================================
// PLAN RUNNER
// ============================================================================

/**
 * Plan Runner - orchestrates multi-job execution plans.
 * 
 * Key features:
 * - Dependency-aware scheduling (DAG execution)
 * - Automatic branch chaining (child branches from parent's result)
 * - Worktree isolation per plan
 * - Parallel execution up to maxParallel limit
 */
export class PlanRunner {
  private plans = new Map<string, InternalPlanState>();
  private specs = new Map<string, PlanSpec>();
  private interval?: NodeJS.Timeout;
  private persistence: PlanPersistence;
  private isPumping = false; // Guard against overlapping pump cycles
  private lastStateHash = ''; // Track state changes to avoid unnecessary notifications
  
  /** Cached public states - updated when plans change, returned instantly on list() */
  private cachedPublicStates: PlanState[] = [];
  private publicStateCacheValid = false;
  
  /** Event emitter for plan changes */
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(private runner: JobRunner) {
    // Initialize persistence
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.persistence = new PlanPersistence(workspacePath);
    
    // Load persisted plans on startup
    this.loadFromDisk();
  }

  /**
   * Notify listeners that plans have changed.
   * Only fires if state has actually changed since last notification.
   */
  private notifyChange(): void {
    // Invalidate public state cache
    this.publicStateCacheValid = false;
    
    // Create a lightweight hash of the current state to detect changes
    const stateHash = this.computeStateHash();
    if (stateHash !== this.lastStateHash) {
      this.lastStateHash = stateHash;
      this._onDidChange.fire();
    }
  }
  
  /**
   * Compute a lightweight hash of plan state for change detection.
   */
  private computeStateHash(): string {
    const parts: string[] = [];
    for (const [id, plan] of this.plans) {
      parts.push(`${id}:${plan.status}:${plan.queued.length}:${plan.preparing.length}:${plan.running.length}:${plan.done.length}:${plan.failed.length}`);
    }
    return parts.join('|');
  }

  // ============================================================================
  // PERSISTENCE
  // ============================================================================

  /**
   * Persist plans state to disk (debounced, async).
   */
  private persist(): void {
    this.persistence.save(this.plans, this.specs);
  }

  /**
   * Force synchronous persist (for shutdown).
   */
  persistSync(): void {
    this.persistence.saveSync(this.plans, this.specs);
  }

  /**
   * Load plans from disk.
   */
  private loadFromDisk(): void {
    const { plans, specs } = this.persistence.load();
    this.plans = plans;
    this.specs = specs;
    
    if (plans.size > 0) {
      log.info('Plans loaded from disk', { 
        planCount: plans.size,
        specCount: specs.size
      });
      
      // Resume any plans that were running
      this.resumeIncompletePlans();
    }
  }

  /**
   * Resume plans that were in progress when extension was unloaded.
   */
  private resumeIncompletePlans(): void {
    let resumed = 0;
    for (const [id, plan] of this.plans) {
      // Only resume plans that were actively running
      if (plan.status === 'running' || plan.status === 'queued') {
        // Check if there's work to do
        if (plan.queued.length > 0 || plan.running.length > 0) {
          log.info(`Resuming plan: ${id}`, {
            status: plan.status,
            queued: plan.queued.length,
            running: plan.running.length
          });
          resumed++;
        }
      }
    }
    
    // Start the pump loop if we have incomplete plans
    if (resumed > 0 && !this.interval) {
      this.interval = setInterval(() => this.pumpAll(), 1500);
      log.info(`Pump loop started for ${resumed} resumed plans`);
    }
  }

  /**
   * Get all plans (returns public PlanState without internal maps).
   * Uses cached states for instant response - cache is invalidated when state changes.
   */
  list(): PlanState[] {
    if (!this.publicStateCacheValid) {
      this.cachedPublicStates = Array.from(this.plans.values()).map(p => toPublicState(p));
      this.publicStateCacheValid = true;
    }
    return this.cachedPublicStates;
  }

  /**
   * Get all plan specifications.
   */
  listSpecs(): PlanSpec[] {
    return Array.from(this.specs.values());
  }

  /**
   * Get a specific plan specification.
   */
  getSpec(id: string): PlanSpec | undefined {
    return this.specs.get(id);
  }

  /**
   * Get the job ID mapping for a plan.
   * Returns a map of plan job ID -> runner job ID.
   */
  getJobIdMap(planId: string): Map<string, string> | undefined {
    const plan = this.plans.get(planId);
    return plan?.jobIdMap;
  }

  /**
   * Get a specific plan.
   */
  get(id: string): PlanState | undefined {
    const plan = this.plans.get(id);
    if (!plan) return undefined;
    return toPublicState(plan);
  }
  
  /**
   * Append a completed job's work summary to the plan's aggregated summary.
   * Called once when a leaf job is merged - no need to recompute later.
   * 
   * @param plan - Internal plan state
   * @param planJobId - Plan job ID (not runner job ID)
   * @param jobName - Human-readable job name
   */
  private appendJobWorkSummary(
    plan: InternalPlanState, 
    planJobId: string, 
    jobName: string
  ): void {
    const runnerJobId = plan.jobIdMap.get(planJobId);
    if (!runnerJobId) return;
    
    const job = this.runner.list().find(j => j.id === runnerJobId);
    if (!job?.workSummary) return;
    
    const ws = job.workSummary;
    
    // Initialize aggregatedWorkSummary if needed
    if (!plan.aggregatedWorkSummary) {
      plan.aggregatedWorkSummary = {
        totalCommits: 0,
        totalFilesAdded: 0,
        totalFilesModified: 0,
        totalFilesDeleted: 0,
        jobSummaries: []
      };
    }
    
    // Add to totals
    plan.aggregatedWorkSummary.totalCommits += ws.commits || 0;
    plan.aggregatedWorkSummary.totalFilesAdded += ws.filesAdded || 0;
    plan.aggregatedWorkSummary.totalFilesModified += ws.filesModified || 0;
    plan.aggregatedWorkSummary.totalFilesDeleted += ws.filesDeleted || 0;
    
    // Append job summary
    plan.aggregatedWorkSummary.jobSummaries.push({
      jobId: planJobId,
      jobName: jobName,
      commits: ws.commits || 0,
      filesAdded: ws.filesAdded || 0,
      filesModified: ws.filesModified || 0,
      filesDeleted: ws.filesDeleted || 0,
      description: ws.description || '',
      commitDetails: ws.commitDetails
    });
    
    log.debug(`Appended work summary for job ${planJobId}`, {
      planId: plan.id,
      commits: ws.commits,
      totalJobs: plan.aggregatedWorkSummary.jobSummaries.length
    });
  }
  
  /**
   * Append a completed sub-plan's aggregated work summary to the parent plan.
   * Called once when a sub-plan completes - no need to recompute later.
   */
  private appendSubPlanWorkSummary(
    parentPlan: InternalPlanState,
    subPlanId: string,
    childPlanId: string
  ): void {
    const childPlan = this.plans.get(childPlanId);
    if (!childPlan?.aggregatedWorkSummary) return;
    
    const childWs = childPlan.aggregatedWorkSummary;
    
    // Initialize aggregatedWorkSummary if needed
    if (!parentPlan.aggregatedWorkSummary) {
      parentPlan.aggregatedWorkSummary = {
        totalCommits: 0,
        totalFilesAdded: 0,
        totalFilesModified: 0,
        totalFilesDeleted: 0,
        jobSummaries: []
      };
    }
    
    // Add to totals
    parentPlan.aggregatedWorkSummary.totalCommits += childWs.totalCommits;
    parentPlan.aggregatedWorkSummary.totalFilesAdded += childWs.totalFilesAdded;
    parentPlan.aggregatedWorkSummary.totalFilesModified += childWs.totalFilesModified;
    parentPlan.aggregatedWorkSummary.totalFilesDeleted += childWs.totalFilesDeleted;
    
    // Append child job summaries with sub-plan prefix
    for (const childJobSummary of childWs.jobSummaries) {
      parentPlan.aggregatedWorkSummary.jobSummaries.push({
        ...childJobSummary,
        jobId: `${subPlanId}/${childJobSummary.jobId}`,
        jobName: `${subPlanId}: ${childJobSummary.jobName}`
      });
    }
    
    log.debug(`Appended sub-plan work summary`, {
      parentPlanId: parentPlan.id,
      subPlanId,
      childJobs: childWs.jobSummaries.length
    });
  }

  /**
   * Enqueue a new plan for execution.
   */
  enqueue(spec: PlanSpec): void {
    const id = spec.id || `plan-${Date.now()}`;
    spec.id = id;
    
    log.info(`Enqueueing plan: ${id}`, { 
      name: spec.name,
      jobCount: spec.jobs.length,
      baseBranch: spec.baseBranch,
      maxParallel: spec.maxParallel
    });
    
    // Ensure unique worktree root for this plan
    if (!spec.worktreeRoot) {
      spec.worktreeRoot = `.worktrees/${id}`;
    }
    
    // Default base branch
    if (!spec.baseBranch) {
      spec.baseBranch = 'main';
    }
    
    // Pre-compute runner job IDs (GUIDs) for all jobs
    // This ensures targetBranch names are unique and won't conflict if not cleaned up
    for (const job of spec.jobs) {
      if (!job.runnerJobId) {
        job.runnerJobId = randomUUID();
      }
      // Also pre-compute targetBranch using the GUID
      if (!job.inputs.targetBranch) {
        job.inputs.targetBranch = `copilot_jobs/${id}/${job.runnerJobId}`;
      }
      // Pre-compute nestedPlanId if this job has a nested plan
      if (job.plan && !job.nestedPlanId) {
        job.nestedPlanId = `${id}/${job.id}-${randomUUID().substring(0, 8)}`;
      }
    }
    
    log.debug(`Pre-computed runner job IDs for plan ${id}:`);
    for (const job of spec.jobs) {
      log.debug(`  ${job.id} -> ${job.runnerJobId} (target: ${job.inputs.targetBranch})${job.nestedPlanId ? ` [nested: ${job.nestedPlanId}]` : ''}`);
    }
    
    // Store spec for later reference
    this.specs.set(id, spec);
    
    // Initialize plan state
    const state: InternalPlanState = {
      id,
      status: 'queued',
      queued: [],
      preparing: [],
      running: [],
      done: [],
      failed: [],
      canceled: [],
      submitted: [],
      jobIdMap: new Map(),
      completedBranches: new Map(),
      worktreePaths: new Map(),
      worktreePromises: new Map(),
      // Sub-plan tracking
      pendingSubPlans: new Set(spec.subPlans?.map(sp => sp.id) || []),
      runningSubPlans: new Map(),
      completedSubPlans: new Map(),
      failedSubPlans: new Set(),
      // Incremental delivery tracking
      mergedLeaves: new Set(),
      cleanedWorkUnits: new Set()
    };
    
    // Queue jobs with no consumesFrom (roots of the DAG)
    const rootJobs = spec.jobs.filter(j => j.consumesFrom.length === 0);
    state.queued = rootJobs.map(j => j.id);
    
    log.debug(`Plan ${id} initialized`, {
      rootJobs: rootJobs.map(j => j.id),
      worktreeRoot: spec.worktreeRoot,
      baseBranch: spec.baseBranch,
      subPlanCount: spec.subPlans?.length || 0
    });
    
    // Log the DAG structure
    for (const job of spec.jobs) {
      log.debug(`  Job ${job.id}`, {
        consumesFrom: job.consumesFrom,
        task: job.task?.substring(0, 50)
      });
    }
    
    this.plans.set(id, state);
    
    // Persist and notify listeners of the new plan
    this.persist();
    this.notifyChange();
    
    // Start the pump loop if not already running
    if (!this.interval) {
      this.interval = setInterval(() => this.pumpAll(), 1500);
    }
    
    log.info(`Plan ${id} queued with ${rootJobs.length} root jobs ready`);
  }

  /**
   * Cancel a running plan.
   */
  cancel(id: string): void {
    const plan = this.plans.get(id);
    if (!plan) {
      log.warn(`Cancel requested for unknown plan: ${id}`);
      return;
    }
    
    log.info(`Canceling plan: ${id}`, {
      runningJobs: plan.running,
      status: plan.status
    });
    
    // Cancel all running jobs
    for (const jobId of plan.running) {
      const runnerId = plan.jobIdMap.get(jobId);
      if (runnerId) {
        log.debug(`Canceling job ${jobId} (runner: ${runnerId})`);
        this.runner.cancel(runnerId);
      }
    }
    
    plan.status = 'canceled';
    plan.endedAt = Date.now();
    
    // Persist and notify listeners of the cancellation
    this.persist();
    this.notifyChange();
    
    log.info(`Plan ${id} canceled`);
  }

  /**
   * Retry a failed or partial plan.
   * Re-queues failed jobs for execution.
   */
  retry(id: string): boolean {
    const plan = this.plans.get(id);
    const spec = this.specs.get(id);
    if (!plan || !spec) {
      log.warn(`Retry requested for unknown plan: ${id}`);
      return false;
    }
    
    // Only retry failed or partial plans
    if (!['failed', 'partial'].includes(plan.status)) {
      log.warn(`Cannot retry plan ${id} - status is ${plan.status}`);
      return false;
    }
    
    log.info(`Retrying plan: ${id}`, {
      failedJobs: plan.failed,
      previousStatus: plan.status
    });
    
    // Re-queue failed jobs
    const failedJobs = [...plan.failed];
    plan.failed = [];
    
    // Move failed jobs back to queued if their dependencies are satisfied
    for (const jobId of failedJobs) {
      const planJob = spec.jobs.find(j => j.id === jobId);
      if (!planJob) continue;
      
      // Check if consumesFrom sources are satisfied (either done jobs or completed sub-plans)
      const depsOk = planJob.consumesFrom.every(depId => 
        plan.done.includes(depId) || plan.completedSubPlans?.has(depId)
      );
      
      if (depsOk) {
        plan.queued.push(jobId);
        // Remove from submitted so it can be scheduled again
        plan.submitted = plan.submitted.filter(j => j !== jobId);
        log.debug(`Job ${jobId} re-queued for retry`);
      } else {
        // Can't retry this job yet - its sources failed
        plan.failed.push(jobId);
        log.debug(`Job ${jobId} cannot be retried - consumesFrom sources not satisfied`);
      }
    }
    
    // Reset plan status
    plan.status = 'running';
    plan.endedAt = undefined;
    plan.error = undefined;
    
    // Persist and notify
    this.persist();
    this.notifyChange();
    
    // Start pump loop if needed
    if (!this.interval) {
      this.interval = setInterval(() => this.pumpAll(), 1500);
    }
    
    log.info(`Plan ${id} retry started`, { requeuedJobs: plan.queued.length });
    return true;
  }

  /**
   * Pump all plans.
   * 
   * Note: Plans are pumped sequentially to avoid git operation conflicts.
   * Each plan may modify the repo, so we wait for each to complete.
   * The isPumping guard prevents overlapping pump cycles if async ops take long.
   */
  private async pumpAll(): Promise<void> {
    // Guard against overlapping pump cycles
    if (this.isPumping) {
      return;
    }
    this.isPumping = true;
    
    const pumpStart = Date.now();
    try {
      for (const [id, _] of this.plans) {
        const spec = this.specs.get(id);
        if (spec) {
          const planStart = Date.now();
          await this.pump(spec);
          const planTime = Date.now() - planStart;
          if (planTime > 100) {
            log.warn(`Slow pump for plan ${id} took ${planTime}ms`);
          }
        }
      }
      // Persist and notify listeners of any changes
      this.persist();
      this.notifyChange();
    } finally {
      this.isPumping = false;
      const totalTime = Date.now() - pumpStart;
      if (totalTime > 200) {
        log.warn(`Slow pumpAll cycle took ${totalTime}ms`);
      }
    }
  }

  /**
   * Main scheduling loop for a plan.
   */
  private async pump(spec: PlanSpec): Promise<void> {
    const plan = this.plans.get(spec.id);
    if (!plan) return;
    
    // Skip if plan is in terminal state
    if (['canceled', 'succeeded', 'failed', 'partial'].includes(plan.status)) {
      return;
    }
    
    try {
      // Mark as running if not already
      if (!plan.startedAt) {
        plan.startedAt = Date.now();
      }
      plan.status = 'running';
      
      // Get workspace and config
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const repoPath = spec.repoPath || ws;
      
      // Resolve targetBranchRoot on first pump (lazy initialization)
      if (!plan.targetBranchRoot) {
        const baseBranch = spec.baseBranch || 'main';
        const { targetBranchRoot, needsCreation } = await git.orchestrator.resolveTargetBranchRoot(
          baseBranch,
          repoPath,
          `copilot_jobs/${spec.id}`
        );
        
        if (needsCreation) {
          log.info(`Plan ${spec.id}: baseBranch '${baseBranch}' is a default branch, creating feature branch`);
          await git.branches.create(targetBranchRoot, baseBranch, repoPath, s => log.debug(s));
          plan.targetBranchRootCreated = true;
        } else {
          log.info(`Plan ${spec.id}: using non-default baseBranch '${baseBranch}' as targetBranchRoot`);
          plan.targetBranchRootCreated = false;
        }
        
        plan.targetBranchRoot = targetBranchRoot;
        log.info(`Plan ${spec.id}: targetBranchRoot = ${targetBranchRoot}`);
      }
      const maxParallel = spec.maxParallel && spec.maxParallel > 0 
        ? spec.maxParallel 
        : (this.runner as any).maxWorkers || 1;
      
      // Check preparing jobs (worktree creation completed?) - non-blocking
      await this.checkPreparingJobs(spec, plan, repoPath);
      
      // Collect jobs to start preparing (up to maxParallel - running - preparing)
      const slotsAvailable = maxParallel - plan.running.length - plan.preparing.length;
      const jobsToPrepare: string[] = [];
      while (jobsToPrepare.length < slotsAvailable && plan.queued.length > 0) {
        jobsToPrepare.push(plan.queued.shift()!);
      }
      
      // Start worktree preparation for new jobs (fire-and-forget, non-blocking)
      for (const jobId of jobsToPrepare) {
        this.startWorktreePreparation(spec, plan, jobId, repoPath);
      }
      
      // Check status of running jobs
      await this.updateJobStatuses(spec, plan);
      
      // Check status of running sub-plans
      await this.updateSubPlanStatuses(spec, plan);
      
      // Check if plan is complete
      this.checkPlanCompletion(spec, plan);
    } catch (error: any) {
      log.error(`Error pumping plan ${spec.id}`, { error: error.message, stack: error.stack });
      // Don't fail the plan on pump errors - just log and continue
      // The plan will be retried on the next pump cycle
    }
  }

  /**
   * Start worktree preparation for a job (fire-and-forget).
   * 
   * This kicks off worktree creation asynchronously and stores a Promise
   * in plan.worktreePromises. The pump will check these promises on subsequent
   * cycles and submit jobs to the runner once their worktrees are ready.
   */
  private startWorktreePreparation(spec: PlanSpec, plan: InternalPlanState, jobId: string, repoPath: string): void {
    const planJob = spec.jobs.find(j => j.id === jobId);
    if (!planJob) {
      log.error(`Job ${jobId} not found in plan spec`);
      return;
    }

    // Move to preparing state
    plan.preparing.push(jobId);
    
    // Compute branch info needed for worktree
    const { baseBranch, additionalSources } = this.computeBaseBranch(spec, plan, planJob, repoPath);
    const runnerJobId = planJob.runnerJobId!;
    const targetBranch = planJob.inputs.targetBranch!;
    
    // Map plan job ID to runner job ID early
    plan.jobIdMap.set(jobId, runnerJobId);
    
    const wtRootAbs = path.join(repoPath, spec.worktreeRoot || '.worktrees');
    const worktreePath = path.join(wtRootAbs, runnerJobId);
    
    log.debug(`Starting async worktree preparation for job ${jobId}`);
    
    // Fire-and-forget worktree creation - store the promise for later checking
    const worktreePromise = this.prepareWorktreeAsync(
      spec, plan, planJob, jobId, repoPath, worktreePath, targetBranch, baseBranch, additionalSources
    );
    
    plan.worktreePromises.set(jobId, worktreePromise);
  }

  /**
   * Async worktree creation - runs in background without blocking the pump.
   * Returns true if worktree was created successfully, false on failure.
   */
  private async prepareWorktreeAsync(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    planJob: PlanJob, 
    jobId: string, 
    repoPath: string, 
    worktreePath: string, 
    targetBranch: string, 
    baseBranch: string, 
    additionalSources: string[]
  ): Promise<boolean> {
    try {
      const wtStart = Date.now();
      log.debug(`Creating worktree for job ${jobId} at ${worktreePath}`);
      
      await git.worktrees.create({
        repoPath,
        worktreePath,
        branchName: targetBranch,
        fromRef: baseBranch,
        log: s => log.debug(s)
      });
      
      const wtTime = Date.now() - wtStart;
      if (wtTime > 500) {
        log.warn(`Slow worktree creation for ${jobId} took ${wtTime}ms`);
      }
      
      // Track worktree path for cleanup
      plan.worktreePaths.set(jobId, worktreePath);
      
      log.info(`Created worktree for job ${jobId}: ${worktreePath} on branch ${targetBranch}`);
      
      // If job has multiple sources, merge the additional sources
      if (additionalSources.length > 0) {
        const mergeSuccess = await this.mergeSourcesIntoWorktree(planJob, worktreePath, additionalSources);
        if (!mergeSuccess) {
          log.error(`Failed to merge sources into worktree for job ${jobId}`);
          return false;
        }
      }
      
      return true;
    } catch (err) {
      log.error(`Failed to create worktree for job ${jobId}: ${err}`);
      return false;
    }
  }

  /**
   * Check preparing jobs and submit them to runner once their worktrees are ready.
   * Uses a settled flag approach to check completion without blocking.
   */
  private async checkPreparingJobs(spec: PlanSpec, plan: InternalPlanState, repoPath: string): Promise<void> {
    if (plan.preparing.length === 0) return;
    
    const jobsToSubmit: string[] = [];
    const jobsFailed: string[] = [];
    
    // Check each preparing job's promise
    for (const jobId of [...plan.preparing]) {
      const promise = plan.worktreePromises.get(jobId);
      if (!promise) {
        log.warn(`No worktree promise found for preparing job ${jobId}`);
        continue;
      }
      
      // Check if promise has settled by racing with a timeout
      // Use a minimal timeout (0ms) to just check if already resolved
      const NOT_SETTLED = Symbol('not-settled');
      const result = await Promise.race([
        promise.then(
          success => ({ settled: true as const, success }),
          () => ({ settled: true as const, success: false })
        ),
        new Promise<typeof NOT_SETTLED>(resolve => setImmediate(() => resolve(NOT_SETTLED)))
      ]);
      
      if (result !== NOT_SETTLED) {
        // Worktree creation completed (or failed)
        plan.worktreePromises.delete(jobId);
        if (result.success) {
          jobsToSubmit.push(jobId);
          log.debug(`Worktree ready for job ${jobId}`);
        } else {
          jobsFailed.push(jobId);
          log.warn(`Worktree creation failed for job ${jobId}`);
        }
      }
      // If NOT_SETTLED, job stays in preparing state
    }
    
    // Submit ready jobs to runner
    for (const jobId of jobsToSubmit) {
      plan.preparing = plan.preparing.filter(id => id !== jobId);
      await this.submitJobToRunner(spec, plan, jobId, repoPath);
    }
    
    // Mark failed jobs
    for (const jobId of jobsFailed) {
      plan.preparing = plan.preparing.filter(id => id !== jobId);
      plan.failed.push(jobId);
      this.publicStateCacheValid = false;
    }
  }

  /**
   * Submit a job to the runner (worktree already created).
   */
  private async submitJobToRunner(spec: PlanSpec, plan: InternalPlanState, jobId: string, repoPath: string): Promise<void> {
    const planJob = spec.jobs.find(j => j.id === jobId);
    if (!planJob) {
      log.error(`Job ${jobId} not found in plan spec`);
      return;
    }
    
    const { baseBranch } = this.computeBaseBranch(spec, plan, planJob, repoPath);
    const runnerJobId = planJob.runnerJobId!;
    const targetBranch = planJob.inputs.targetBranch!;
    const worktreePath = plan.worktreePaths.get(jobId)!;
    
    log.info(`Submitting job: ${jobId}`, {
      planId: spec.id,
      runnerJobId,
      baseBranch,
      targetBranch,
      worktreePath
    });
    
    // Create job spec for the runner - marked as plan-managed
    const jobSpec: JobSpec = {
      id: runnerJobId,
      name: planJob.name || planJob.id,
      task: planJob.task || 'plan-job',
      inputs: {
        repoPath,
        baseBranch,
        targetBranch,
        worktreeRoot: spec.worktreeRoot || '.worktrees',
        instructions: planJob.inputs?.instructions || '',
        isPlanManaged: true,
        worktreePath: worktreePath,
        planId: spec.id
      },
      policy: {
        useJust: planJob.policy?.useJust ?? false,
        steps: {
          prechecks: planJob.policy?.steps?.prechecks || '',
          work: planJob.policy?.steps?.work || `@agent ${planJob.task || 'complete the task'}`,
          postchecks: planJob.policy?.steps?.postchecks || ''
        }
      }
    };
    
    // Submit to runner
    this.runner.enqueue(jobSpec);
    
    // Update plan state
    plan.submitted.push(jobId);
    plan.running.push(jobId);
    
    log.debug(`Job ${jobId} submitted to runner`, {
      planId: spec.id,
      queued: plan.queued.length,
      preparing: plan.preparing.length,
      running: plan.running.length,
      done: plan.done.length
    });
  }

  /**
   * Compute the base branch for a job based on its dependencies.
   * 
   * Branch chaining logic:
   * - If job has no consumesFrom: use plan's targetBranchRoot
   * - If job has one source: use that source's completed branch
   * - If job has multiple sources: use the first source (others merged into worktree later)
   * 
   * Returns: { baseBranch, additionalSources } where additionalSources are branches
   * that need to be merged into the worktree after creation.
   */
  private computeBaseBranch(spec: PlanSpec, plan: InternalPlanState, job: PlanJob, repoPath: string): { baseBranch: string; additionalSources: string[] } {
    // Gather branches from all consumesFrom sources (jobs and sub-plans)
    const sourceBranches: string[] = [];
    
    for (const sourceId of job.consumesFrom) {
      // Check if source is a completed job
      const jobBranch = plan.completedBranches.get(sourceId);
      if (jobBranch) {
        sourceBranches.push(jobBranch);
        continue;
      }
      
      // Check if source is a completed sub-plan
      const subPlanBranch = plan.completedSubPlans.get(sourceId);
      if (subPlanBranch) {
        sourceBranches.push(subPlanBranch);
        log.debug(`Job ${job.id}: will use sub-plan ${sourceId} completed branch: ${subPlanBranch}`);
        continue;
      }
      
      // Source not found - this shouldn't happen if scheduling is correct
      log.warn(`Job ${job.id}: source ${sourceId} not found in completedBranches or completedSubPlans`);
    }
    
    // Check if job explicitly specifies a baseBranch (override for root jobs)
    if (job.inputs.baseBranch && job.inputs.baseBranch !== '') {
      // Only use explicit baseBranch if no consumesFrom
      if (job.consumesFrom.length === 0) {
        log.debug(`Job ${job.id}: using explicit baseBranch: ${job.inputs.baseBranch}`);
        return { baseBranch: job.inputs.baseBranch, additionalSources: [] };
      }
    }
    
    // No consumesFrom - use plan's targetBranchRoot (root job)
    if (job.consumesFrom.length === 0) {
      const targetBranchRoot = plan.targetBranchRoot || spec.baseBranch || 'main';
      log.debug(`Job ${job.id}: root job, using targetBranchRoot: ${targetBranchRoot}`);
      return { baseBranch: targetBranchRoot, additionalSources: [] };
    }
    
    // Single source - use that branch directly
    if (sourceBranches.length === 1) {
      log.debug(`Job ${job.id}: chaining from single source, baseBranch: ${sourceBranches[0]}`);
      return { baseBranch: sourceBranches[0], additionalSources: [] };
    }
    
    // No branches found - fallback
    if (sourceBranches.length === 0) {
      const targetBranchRoot = plan.targetBranchRoot || spec.baseBranch || 'main';
      log.warn(`Job ${job.id}: no source branches found, falling back to targetBranchRoot: ${targetBranchRoot}`);
      return { baseBranch: targetBranchRoot, additionalSources: [] };
    }
    
    // Multiple sources - use first as base, return others for direct worktree merge
    log.debug(`Job ${job.id}: multiple sources, using ${sourceBranches[0]} as base, will merge ${sourceBranches.slice(1).join(', ')} into worktree`);
    return { baseBranch: sourceBranches[0], additionalSources: sourceBranches.slice(1) };
  }
  
  /**
   * Merge additional source branches directly into a job's worktree.
   * This is called after worktree creation when a job consumes from multiple sources.
   * Uses Copilot CLI for intelligent conflict resolution.
   */
  private async mergeSourcesIntoWorktree(
    job: PlanJob,
    worktreePath: string,
    additionalSources: string[]
  ): Promise<boolean> {
    if (additionalSources.length === 0) {
      return true;
    }
    
    const { spawnSync } = require('child_process');
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const prefer = mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs');
    
    log.info(`Merging ${additionalSources.length} additional sources into worktree for job ${job.id}`, {
      additionalSources,
      worktreePath
    });
    
    for (const sourceBranch of additionalSources) {
      log.debug(`Merging ${sourceBranch} into worktree at ${worktreePath}`);
      
      // First try with origin/ prefix
      let mergeResult = await git.merge.merge({
        source: `origin/${sourceBranch}`,
        target: await git.branches.current(worktreePath),
        cwd: worktreePath,
        message: `Merge ${sourceBranch} for job ${job.id}`,
        log: (msg: string) => log.debug(msg)
      });
      
      if (mergeResult.success) {
        log.debug(`Simple merge of ${sourceBranch} succeeded (no conflicts)`);
        continue;
      }
      
      // If conflict, try without origin/ prefix
      if (!mergeResult.hasConflicts) {
        await git.merge.abort(worktreePath);
        mergeResult = await git.merge.merge({
          source: sourceBranch,
          target: await git.branches.current(worktreePath),
          cwd: worktreePath,
          message: `Merge ${sourceBranch} for job ${job.id}`,
          log: (msg: string) => log.debug(msg)
        });
        
        if (mergeResult.success) {
          log.debug(`Simple merge of ${sourceBranch} (local) succeeded (no conflicts)`);
          continue;
        }
      }
      
      // Handle merge conflict with Copilot CLI
      if (mergeResult.hasConflicts) {
        log.info(`Merge conflict detected for ${sourceBranch}, using Copilot CLI to resolve...`);
        
        const mergeInstruction = `@agent Resolve the current git merge conflict. ` +
          `We are merging branch '${sourceBranch}' into the current working directory. ` +
          `Prefer '${prefer}' changes when there are conflicts. ` +
          `Complete the merge and commit with message 'orchestrator: merge ${sourceBranch} for job ${job.id}'`;
        
        // Use string command with JSON.stringify to handle spaces in prompt
        const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
        const result = spawnSync(copilotCmd, [], {
          cwd: worktreePath,
          shell: true,
          encoding: 'utf-8',
          timeout: 300000 // 5 minute timeout
        });
        
        if (result.status !== 0) {
          log.error(`Copilot CLI failed to resolve merge conflict for ${sourceBranch}`, { 
            exitCode: result.status
          });
          // Abort the merge
          try {
            await git.merge.abort(worktreePath);
          } catch {}
          return false;
        }
        
        log.info(`Copilot CLI resolved merge conflict for ${sourceBranch}`);
      } else {
        // Non-conflict failure
        log.error(`Merge failed for ${sourceBranch}: ${mergeResult.error}`);
        return false;
      }
    }
    
    log.info(`Successfully merged all sources into worktree for job ${job.id}`);
    return true;
  }

  /**
   * Update job statuses from the runner.
   */
  private async updateJobStatuses(spec: PlanSpec, plan: InternalPlanState): Promise<void> {
    const runnerJobs = this.runner.list();
    
    for (const planJobId of [...plan.running]) {
      const runnerJobId = plan.jobIdMap.get(planJobId);
      if (!runnerJobId) continue;
      
      const runnerJob = runnerJobs.find(j => j.id === runnerJobId);
      if (!runnerJob) continue;
      
      switch (runnerJob.status) {
        case 'succeeded':
          await this.handleJobSuccess(spec, plan, planJobId, runnerJob);
          break;
        case 'failed':
          this.handleJobFailure(plan, planJobId);
          break;
        case 'canceled':
          this.handleJobCanceled(plan, planJobId);
          break;
        // 'running' and 'queued' - no action needed
      }
    }
  }
  
  /**
   * Update sub-plan statuses by checking their nested plan state.
   */
  private async updateSubPlanStatuses(spec: PlanSpec, plan: InternalPlanState): Promise<void> {
    if (!plan.runningSubPlans || plan.runningSubPlans.size === 0) {
      return;
    }
    
    for (const [subPlanId, childPlanId] of plan.runningSubPlans.entries()) {
      const childPlan = this.plans.get(childPlanId);
      if (!childPlan) continue;
      
      const subPlanSpec = spec.subPlans?.find(sp => sp.id === subPlanId);
      const childSpec = this.specs.get(childPlanId);
      
      if (childPlan.status === 'succeeded') {
        log.info(`Sub-plan ${subPlanId} (${childPlanId}) completed successfully`, {
          parentPlan: spec.id
        });
        
        // Get the integration branch that was created for this sub-plan
        // The sub-plan's RI merge goes to this branch, so it contains all the work
        const integrationBranch = plan.subPlanIntegrationBranches?.get(subPlanId);
        
        // Use the integration branch as the completed branch
        // This is where the parent should flow code from
        let completedBranch = integrationBranch;
        
        // Fallback: if no integration branch (shouldn't happen), try to find leaf branch
        if (!completedBranch && childSpec) {
          const leafJobs = childSpec.jobs.filter(j => {
            return !childSpec.jobs.some(other => other.consumesFrom.includes(j.id));
          });
          
          if (leafJobs.length === 1) {
            completedBranch = childPlan.completedBranches.get(leafJobs[0].id);
          } else if (leafJobs.length > 1) {
            // Multiple leaf jobs - use targetBranch if RI merge completed
            if (childPlan.riMergeCompleted && childSpec.targetBranch) {
              completedBranch = childSpec.targetBranch;
            } else {
              // Fallback to last completed leaf
              for (const leaf of leafJobs) {
                const branch = childPlan.completedBranches.get(leaf.id);
                if (branch) completedBranch = branch;
              }
            }
          }
        }
        
        // Record the completed branch so consumers can use it
        if (completedBranch) {
          // Add a synthetic entry to completedSubPlans using the sub-plan ID
          // Jobs can consume from the sub-plan ID to receive its completed branch
          plan.completedBranches.set(subPlanId, completedBranch);
          log.debug(`Sub-plan ${subPlanId} completed branch: ${completedBranch}`);
        }
        
        plan.runningSubPlans.delete(subPlanId);
        plan.completedSubPlans.set(subPlanId, completedBranch || 'unknown');
        
        // Append sub-plan's aggregated work summary to parent - computed once at completion
        this.appendSubPlanWorkSummary(plan, subPlanId, childPlanId);
        
        // Check if this sub-plan is a leaf (nothing consumes from it)
        // If so, immediately merge to targetBranch - user gets value right away!
        const isLeaf = mergeManager.isLeafWorkUnit(spec, subPlanId);
        if (isLeaf && completedBranch) {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          const repoPath = spec.repoPath || ws;
          // Note: For sub-plans, we DON'T call appendJobWorkSummary in mergeLeafToTarget
          // because we already appended the sub-plan's aggregate above
          await mergeManager.mergeLeafToTarget(spec, plan, subPlanId, completedBranch, repoPath);
          // Clean up after merge if enabled
          if (spec.cleanUpSuccessfulWork !== false) {
            await cleanupManager.cleanupWorkUnit(spec, plan, subPlanId, repoPath);
          }
          this.persist();
        }
        
        // Check if this completion unblocks any jobs or other sub-plans
        // Use a synthetic job ID that represents the sub-plan completion
        await this.queueReadyDependentsForSubPlan(spec, plan, subPlanId);
        
      } else if (childPlan.status === 'failed' || childPlan.status === 'partial') {
        log.error(`Sub-plan ${subPlanId} (${childPlanId}) failed`, {
          parentPlan: spec.id,
          childStatus: childPlan.status
        });
        
        plan.runningSubPlans.delete(subPlanId);
        plan.failedSubPlans.add(subPlanId);
        
      } else if (childPlan.status === 'canceled') {
        log.warn(`Sub-plan ${subPlanId} (${childPlanId}) was canceled`, {
          parentPlan: spec.id
        });
        
        plan.runningSubPlans.delete(subPlanId);
        plan.failedSubPlans.add(subPlanId);
      }
      // Running/queued - no action needed
    }
  }
  
  /**
   * Queue jobs that were waiting for a sub-plan to complete.
   * Jobs can list sub-plan IDs in their consumesFrom to wait for sub-plan completion.
   */
  private async queueReadyDependentsForSubPlan(spec: PlanSpec, plan: InternalPlanState, completedSubPlanId: string): Promise<void> {
    // Check all jobs that might be consuming from this sub-plan
    for (const job of spec.jobs) {
      // Skip if already processed
      if (plan.submitted.includes(job.id) || plan.queued.includes(job.id)) {
        continue;
      }
      
      // Check if this job consumes from the completed sub-plan
      if (!job.consumesFrom.includes(completedSubPlanId)) {
        continue;
      }
      
      // Check if ALL consumesFrom sources are complete (jobs and sub-plans)
      const allSourcesComplete = job.consumesFrom.every(sourceId => 
        plan.done.includes(sourceId) || plan.completedSubPlans.has(sourceId)
      );
      
      if (allSourcesComplete) {
        log.info(`Job ${job.id} consumesFrom satisfied after sub-plan ${completedSubPlanId} completed, queuing`, {
          planId: spec.id,
          consumesFrom: job.consumesFrom
        });
        plan.queued.push(job.id);
      } else {
        const pendingSources = job.consumesFrom.filter(sourceId => 
          !plan.done.includes(sourceId) && !plan.completedSubPlans.has(sourceId)
        );
        log.debug(`Job ${job.id} still waiting after sub-plan ${completedSubPlanId} completed`, {
          pendingSources
        });
      }
    }
  }

  /**
   * Handle a successful job completion.
   * Records the completed branch for dependency chaining.
   */
  private async handleJobSuccess(spec: PlanSpec, plan: InternalPlanState, jobId: string, runnerJob: Job): Promise<void> {
    // Remove from running, add to done
    plan.running = plan.running.filter(id => id !== jobId);
    plan.done.push(jobId);
    
    // Record the completed branch for this job
    // This is the KEY for branch chaining - dependent jobs will use this
    // The targetBranch was pre-computed when the plan was enqueued
    const completedBranch = runnerJob.inputs.targetBranch;
    plan.completedBranches.set(jobId, completedBranch);
    
    log.info(`Job ${jobId} succeeded`, {
      planId: spec.id,
      completedBranch,
      duration: runnerJob.endedAt && runnerJob.startedAt 
        ? `${Math.round((runnerJob.endedAt - runnerJob.startedAt) / 1000)}s` 
        : 'unknown'
    });
    
    log.debug(`Plan ${spec.id} progress`, {
      done: plan.done,
      running: plan.running,
      queued: plan.queued,
      failed: plan.failed
    });
    
    // Check if this is a leaf job (nothing consumes from it)
    // If so, immediately merge to targetBranch - user gets value right away!
    const isLeaf = mergeManager.isLeafWorkUnit(spec, jobId);
    if (isLeaf && !spec.isSubPlan) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const repoPath = spec.repoPath || ws;
      await this.mergeLeafToTarget(spec, plan, jobId, completedBranch, repoPath);
    }
    
    // Check for jobs that depended on this one and are now ready
    await this.queueReadyDependents(spec, plan, jobId);
  }
  
  /**
   * Immediately merge a completed leaf job's branch to targetBranch.
   * Delegates to mergeManager module.
   * 
   * After successful merge, appends the job's work summary to the plan's
   * aggregated summary - this is computed ONCE at merge time, not on every enumeration.
   */
  private async mergeLeafToTarget(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    jobId: string, 
    completedBranch: string,
    repoPath: string
  ): Promise<void> {
    const planJob = spec.jobs.find(j => j.id === jobId);
    const success = await mergeManager.mergeLeafToTarget(spec, plan, jobId, completedBranch, repoPath);
    
    if (success) {
      // Append work summary to plan's aggregate - computed once at merge time
      this.appendJobWorkSummary(plan, jobId, planJob?.name || jobId);
      
      if (spec.cleanUpSuccessfulWork !== false) {
        // Clean up worktree/branch if enabled (default behavior)
        await cleanupManager.cleanupWorkUnit(spec, plan, jobId, repoPath);
      }
      this.persist();
    }
  }
  
  /**
   * Clean up worktree and branch for a successfully merged work unit.
   * Delegates to cleanupManager module.
   */
  private cleanupWorkUnit(
    spec: PlanSpec,
    plan: InternalPlanState,
    workUnitId: string,
    repoPath: string
  ): void {
    cleanupManager.cleanupWorkUnit(spec, plan, workUnitId, repoPath);
    this.persist();
  }

  /**
   * Handle a failed job.
   */
  private handleJobFailure(plan: InternalPlanState, jobId: string): void {
    plan.running = plan.running.filter(id => id !== jobId);
    plan.failed.push(jobId);
    
    log.error(`Job ${jobId} failed`, {
      planId: plan.id,
      failedJobs: plan.failed,
      runningJobs: plan.running
    });
  }

  /**
   * Handle a canceled job.
   */
  private handleJobCanceled(plan: InternalPlanState, jobId: string): void {
    plan.running = plan.running.filter(id => id !== jobId);
    plan.canceled.push(jobId);
    
    log.warn(`Job ${jobId} canceled`, {
      planId: plan.id
    });
  }

  /**
   * Queue jobs and sub-plans whose consumesFrom sources are now satisfied.
   */
  private async queueReadyDependents(spec: PlanSpec, plan: InternalPlanState, completedJobId: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const repoPath = spec.repoPath || ws;
    
    // Check regular jobs
    for (const job of spec.jobs) {
      // Skip if already processed
      if (plan.submitted.includes(job.id) || plan.queued.includes(job.id)) {
        continue;
      }
      
      // Check if this job consumes from the completed job
      if (!job.consumesFrom.includes(completedJobId)) {
        continue;
      }
      
      // Check if ALL consumesFrom sources are complete (jobs and sub-plans)
      const allSourcesComplete = job.consumesFrom.every(sourceId => 
        plan.done.includes(sourceId) || plan.completedSubPlans.has(sourceId)
      );
      
      if (allSourcesComplete) {
        log.info(`Job ${job.id} consumesFrom satisfied, queuing`, {
          planId: spec.id,
          consumesFrom: job.consumesFrom,
          completedTrigger: completedJobId
        });
        plan.queued.push(job.id);
      } else {
        const pendingSources = job.consumesFrom.filter(sourceId => 
          !plan.done.includes(sourceId) && !plan.completedSubPlans.has(sourceId)
        );
        log.debug(`Job ${job.id} still waiting for sources`, {
          pendingSources,
          completedSources: job.consumesFrom.filter(sourceId => 
            plan.done.includes(sourceId) || plan.completedSubPlans.has(sourceId)
          )
        });
      }
    }
    
    // Check sub-plans
    if (spec.subPlans) {
      for (const subPlanSpec of spec.subPlans) {
        // Skip if not pending
        if (!plan.pendingSubPlans.has(subPlanSpec.id)) {
          continue;
        }
        
        // Check if this sub-plan consumes from the completed job
        if (!subPlanSpec.consumesFrom.includes(completedJobId)) {
          continue;
        }
        
        // Check if ALL consumesFrom sources are complete
        const allSourcesComplete = subPlanSpec.consumesFrom.every(sourceId => 
          plan.done.includes(sourceId) || plan.completedSubPlans.has(sourceId)
        );
        
        if (allSourcesComplete) {
          log.info(`Sub-plan ${subPlanSpec.id} consumesFrom satisfied, launching`, {
            planId: spec.id,
            consumesFrom: subPlanSpec.consumesFrom,
            completedTrigger: completedJobId
          });
          
          // Launch the sub-plan
          await this.launchSubPlan(spec, plan, subPlanSpec, repoPath);
        } else {
          const pendingSources = subPlanSpec.consumesFrom.filter(sourceId => 
            !plan.done.includes(sourceId) && !plan.completedSubPlans.has(sourceId)
          );
          log.debug(`Sub-plan ${subPlanSpec.id} still waiting for sources`, {
            pendingSources,
            completedSources: subPlanSpec.consumesFrom.filter(sourceId => 
              plan.done.includes(sourceId) || plan.completedSubPlans.has(sourceId)
            )
          });
        }
      }
    }
  }
  
  /**
   * Launch a sub-plan as a nested plan.
   * 
   * The parent plan is responsible for:
   * 1. Creating an integration branch/worktree for the sub-plan
   * 2. The sub-plan's jobs merge back to this integration branch
   * 3. When complete, consumers can receive the sub-plan's completed branch
   */
  private async launchSubPlan(
    parentSpec: PlanSpec, 
    parentState: InternalPlanState, 
    subPlanSpec: SubPlanSpec,
    repoPath: string
  ): Promise<void> {
    const path = require('path');
    
    // Generate a unique ID for the child plan
    const childPlanId = `${parentSpec.id}/${subPlanSpec.id}`;
    
    log.info(`Launching sub-plan: ${childPlanId}`, {
      parentPlan: parentSpec.id,
      subPlanId: subPlanSpec.id,
      consumesFrom: subPlanSpec.consumesFrom
    });
    
    // Determine the source branch for the sub-plan (from consumesFrom sources)
    let sourceBranch: string;
    if (subPlanSpec.consumesFrom.length === 0) {
      // Root sub-plan - uses parent's targetBranchRoot
      sourceBranch = parentState.targetBranchRoot || parentSpec.baseBranch || 'main';
    } else if (subPlanSpec.consumesFrom.length === 1) {
      // Single source - use its completed branch
      const sourceId = subPlanSpec.consumesFrom[0];
      sourceBranch = parentState.completedBranches.get(sourceId) 
        || parentState.completedSubPlans.get(sourceId) 
        || parentState.targetBranchRoot 
        || 'main';
    } else {
      // Multiple sources - need to merge them
      const sourceBranches = subPlanSpec.consumesFrom
        .map(id => parentState.completedBranches.get(id) || parentState.completedSubPlans.get(id))
        .filter((b): b is string => !!b);
      
      if (sourceBranches.length === 0) {
        sourceBranch = parentState.targetBranchRoot || 'main';
      } else if (sourceBranches.length === 1) {
        sourceBranch = sourceBranches[0];
      } else {
        // For multiple sources, use the first (merge should be handled by parent)
        sourceBranch = sourceBranches[0];
        log.warn(`Sub-plan ${childPlanId} has multiple sources, using first: ${sourceBranch}`);
      }
    }
    
    // Create a dedicated integration branch for this sub-plan
    // This branch will receive all sub-plan job merges
    const integrationBranchName = `copilot_jobs/${parentSpec.id}/subplan-${subPlanSpec.id}-integration`;
    
    try {
      // Create the integration branch from the source branch
      // First, try to delete if it already exists
      await git.branches.deleteLocal(repoPath, integrationBranchName, { force: true });
      
      // Create branch from source
      await git.branches.create(integrationBranchName, sourceBranch, repoPath, 
        (msg: string) => log.debug(msg));
      
      // Only push if pushOnSuccess is enabled
      const pushEnabled = vscode.workspace.getConfiguration('copilotOrchestrator.merge').get<boolean>('pushOnSuccess', false);
      if (pushEnabled) {
        await git.repository.push(repoPath, { 
          branch: integrationBranchName, 
          log: (msg: string) => log.debug(msg) 
        });
      }
      
      log.info(`Created integration branch for sub-plan: ${integrationBranchName} from ${sourceBranch}`);
      
    } catch (error: any) {
      log.error(`Failed to create integration branch for sub-plan ${childPlanId}`, { error: error.message });
      parentState.failedSubPlans.add(subPlanSpec.id);
      parentState.pendingSubPlans.delete(subPlanSpec.id);
      return;
    }
    
    log.debug(`Sub-plan ${childPlanId} integration branch: ${integrationBranchName}`);
    
    // Convert sub-plan jobs to PlanJob format
    // Jobs branch from the integration branch
    const jobs: PlanJob[] = subPlanSpec.jobs.map(j => ({
      id: j.id,
      name: j.name,
      task: j.task,
      consumesFrom: j.consumesFrom,
      inputs: {
        baseBranch: integrationBranchName,
        targetBranch: '',  // Will be computed during enqueue
        instructions: j.instructions
      },
      policy: {
        steps: {
          prechecks: j.prechecks || '',
          work: j.work || `@agent ${j.task}`,
          postchecks: j.postchecks || ''
        }
      }
    }));
    
    // Create the nested plan spec
    // targetBranch is the integration branch - this is where the final RI merge goes
    const nestedPlanSpec: PlanSpec = {
      id: childPlanId,
      name: subPlanSpec.name || `${parentSpec.name || parentSpec.id} / ${subPlanSpec.id}`,
      repoPath: parentSpec.repoPath,
      worktreeRoot: `${parentSpec.worktreeRoot}/${subPlanSpec.id}`,
      baseBranch: integrationBranchName,
      targetBranch: integrationBranchName,  // Sub-plan merges back to integration branch
      maxParallel: subPlanSpec.maxParallel || parentSpec.maxParallel,
      jobs: jobs,
      // Mark this as a sub-plan so it knows to skip certain cleanup
      isSubPlan: true,
      parentPlanId: parentSpec.id,
      // Inherit cleanup setting from parent
      cleanUpSuccessfulWork: parentSpec.cleanUpSuccessfulWork
    };
    
    // Move from pending to running
    parentState.pendingSubPlans.delete(subPlanSpec.id);
    parentState.runningSubPlans.set(subPlanSpec.id, childPlanId);
    
    // Store the integration branch so we can flow it when sub-plan completes
    parentState.subPlanIntegrationBranches = parentState.subPlanIntegrationBranches || new Map();
    parentState.subPlanIntegrationBranches.set(subPlanSpec.id, integrationBranchName);
    
    // Enqueue the nested plan
    this.enqueue(nestedPlanSpec);
    
    log.info(`Sub-plan ${childPlanId} enqueued with ${jobs.length} jobs, integration branch: ${integrationBranchName}`);
  }

  /**
   * Check if the plan has completed (success, failure, or partial).
   */
  private checkPlanCompletion(spec: PlanSpec, plan: InternalPlanState): void {
    const totalJobs = spec.jobs.length;
    const finishedJobs = plan.done.length + plan.failed.length + plan.canceled.length;
    const totalSubPlans = spec.subPlans?.length || 0;
    const finishedSubPlans = plan.completedSubPlans.size + plan.failedSubPlans.size;
    const runningSubPlans = plan.runningSubPlans?.size || 0;
    const pendingSubPlans = plan.pendingSubPlans?.size || 0;
    
    log.debug(`Checking plan completion: ${spec.id}`, {
      totalJobs,
      finishedJobs,
      done: plan.done.length,
      failed: plan.failed.length,
      canceled: plan.canceled.length,
      queued: plan.queued.length,
      running: plan.running.length,
      totalSubPlans,
      finishedSubPlans,
      runningSubPlans,
      pendingSubPlans
    });
    
    // Not done yet if there are queued, running jobs, or running/pending sub-plans
    if (plan.running.length > 0 || plan.queued.length > 0) {
      log.debug(`Plan ${spec.id} still in progress (jobs)`, { running: plan.running, queued: plan.queued });
      return;
    }
    
    if (runningSubPlans > 0) {
      log.debug(`Plan ${spec.id} still in progress (sub-plans running)`, { 
        runningSubPlans: Array.from(plan.runningSubPlans.entries())
      });
      return;
    }
    
    // Check if there are pending sub-plans that should have been launched but haven't
    // This can happen if their consumesFrom sources failed
    if (pendingSubPlans > 0) {
      // Check if any pending sub-plan can still be triggered
      const canTrigger = spec.subPlans?.some(sp => {
        if (!plan.pendingSubPlans.has(sp.id)) return false;
        return sp.consumesFrom.every(sourceId => 
          plan.done.includes(sourceId) || plan.completedSubPlans.has(sourceId)
        );
      });
      
      if (canTrigger) {
        log.debug(`Plan ${spec.id} has triggerable sub-plans, waiting for next pump`);
        return;
      }
    }
    
    // All jobs finished
    if (finishedJobs === totalJobs && finishedSubPlans === totalSubPlans) {
      plan.endedAt = Date.now();
      const duration = plan.startedAt ? plan.endedAt - plan.startedAt : 0;
      
      const hasFailedJobs = plan.failed.length > 0;
      const hasFailedSubPlans = plan.failedSubPlans.size > 0;
      
      if (hasFailedJobs || hasFailedSubPlans) {
        plan.status = plan.done.length > 0 || plan.completedSubPlans.size > 0 ? 'partial' : 'failed';
        log.warn(`Plan ${spec.id} completed with failures`, {
          status: plan.status,
          done: plan.done,
          failed: plan.failed,
          failedSubPlans: Array.from(plan.failedSubPlans),
          duration: `${duration}ms`
        });
      } else if (plan.canceled.length > 0) {
        plan.status = 'partial';
        log.warn(`Plan ${spec.id} completed with cancellations`, {
          status: plan.status,
          done: plan.done,
          canceled: plan.canceled,
          duration: `${duration}ms`
        });
      } else {
        plan.status = 'succeeded';
        log.info(`Plan ${spec.id} completed successfully`, {
          status: plan.status,
          completedJobs: plan.done,
          completedSubPlans: Array.from(plan.completedSubPlans.keys()),
          duration: `${duration}ms`
        });
        
        // Perform final RI (Reverse Integration) merge to targetBranch
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const repoPath = spec.repoPath || ws;
        this.performFinalMerge(spec, plan, repoPath);
        
        // Clean up all plan resources if cleanUpSuccessfulWork is enabled (default: true)
        if (spec.cleanUpSuccessfulWork !== false) {
          this.cleanupAllPlanResources(spec, plan, repoPath);
        }
      }
    } else if (finishedJobs + finishedSubPlans < totalJobs + totalSubPlans && 
               plan.queued.length === 0 && plan.preparing.length === 0 && plan.running.length === 0 && 
               runningSubPlans === 0) {
      // Stuck - some jobs/sub-plans couldn't be scheduled (broken dependencies)
      plan.status = 'partial';
      plan.error = 'Some jobs could not be scheduled due to failed dependencies';
      plan.endedAt = Date.now();
      
      const unscheduledJobs = spec.jobs
        .filter(j => !plan.done.includes(j.id) && !plan.failed.includes(j.id) && !plan.canceled.includes(j.id))
        .map(j => j.id);
      
      const unstartedSubPlans = Array.from(plan.pendingSubPlans);
      
      log.error(`Plan ${spec.id} stuck - jobs/sub-plans could not be scheduled`, {
        unscheduledJobs,
        unstartedSubPlans,
        failedDependencies: plan.failed,
        failedSubPlans: Array.from(plan.failedSubPlans),
        error: plan.error
      });
    }
  }

  /**
   * Perform the final RI (Reverse Integration) merge.
   * Merges the final job outputs back to the plan's targetBranch.
   * Delegates to mergeManager module.
   */
  private performFinalMerge(spec: PlanSpec, plan: InternalPlanState, repoPath: string): void {
    mergeManager.performFinalMerge(spec, plan, repoPath);
    this.persist();
  }

  /**
   * Clean up integration branches created for sub-plans.
   * Delegates to mergeManager module.
   */
  private cleanupIntegrationBranches(plan: InternalPlanState, repoPath: string): void {
    mergeManager.cleanupIntegrationBranches(plan, repoPath);
    this.persist();
  }

  /**
   * Clean up all worktrees and branches for a completed plan.
   * Delegates to cleanupManager module.
   */
  private cleanupAllPlanResources(spec: PlanSpec, plan: InternalPlanState, repoPath: string): void {
    cleanupManager.cleanupAllPlanResources(spec, plan, repoPath);
    
    // Also clean up any nested sub-plans
    for (const [subPlanId, childPlanId] of plan.completedSubPlans) {
      const childPlan = this.plans.get(childPlanId);
      const childSpec = this.specs.get(childPlanId);
      if (childPlan && childSpec) {
        cleanupManager.cleanupAllPlanResources(childSpec, childPlan, repoPath);
      }
    }
    
    this.persist();
  }

  /**
   * Delete a plan and clean up all associated resources.
   * This includes:
   * - Canceling the plan if running
   * - Deleting all associated jobs from the JobRunner
   * - Recursively deleting any sub-plans (nested plans)
   * - Cleaning up merge branches
   * - Cleaning up worktrees
   */
  delete(id: string): boolean {
    const plan = this.plans.get(id);
    const spec = this.specs.get(id);
    
    if (!plan) {
      log.warn(`Delete requested for unknown plan: ${id}`);
      return false;
    }
    
    log.info(`Deleting plan: ${id}`, {
      status: plan.status,
      jobCount: plan.jobIdMap.size
    });
    
    // Cancel if running
    if (!['succeeded', 'failed', 'canceled', 'partial'].includes(plan.status)) {
      this.cancel(id);
    }
    
    // Delete all associated jobs from the JobRunner
    for (const [planJobId, runnerJobId] of plan.jobIdMap.entries()) {
      log.debug(`Deleting job ${runnerJobId} (plan job: ${planJobId})`);
      try {
        (this.runner as any).delete(runnerJobId);
      } catch (e: any) {
        log.warn(`Failed to delete job ${runnerJobId}: ${e.message}`);
      }
    }
    
    // Find and delete any nested/sub-plans (plans whose ID starts with this plan's ID)
    const nestedPlanIds: string[] = [];
    for (const [planId, _] of this.plans.entries()) {
      if (planId !== id && planId.startsWith(`${id}/`)) {
        nestedPlanIds.push(planId);
      }
    }
    for (const nestedPlanId of nestedPlanIds) {
      log.debug(`Deleting nested plan: ${nestedPlanId}`);
      this.delete(nestedPlanId);
    }
    
    // Clean up integration branches
    if (spec) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const repoPath = spec.repoPath || ws;
      this.cleanupIntegrationBranches(plan, repoPath);
      
      // Clean up worktree root if it exists (async, fire-and-forget)
      const worktreeRoot = spec.worktreeRoot || path.join(repoPath, '.worktrees', id);
      fs.promises.access(worktreeRoot).then(() => {
        return fs.promises.rm(worktreeRoot, { recursive: true, force: true });
      }).then(() => {
        log.debug(`Cleaned up worktree root: ${worktreeRoot}`);
      }).catch(() => {
        // Ignore - doesn't exist or already cleaned up
      });
    }
    
    // Remove from maps
    this.plans.delete(id);
    this.specs.delete(id);
    
    // Persist and notify
    this.persist();
    this.notifyChange();
    
    log.info(`Plan ${id} deleted successfully`);
    return true;
  }
}
