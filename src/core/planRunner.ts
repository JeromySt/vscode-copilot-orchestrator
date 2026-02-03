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
import { spawn } from 'child_process';
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
  
  /** File watcher for branch changes */
  private branchWatcher?: vscode.FileSystemWatcher;
  private lastKnownBranch?: string;
  private branchWarningShown = false;

  constructor(private runner: JobRunner) {
    // Initialize persistence
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.persistence = new PlanPersistence(workspacePath);
    
    // Load persisted plans on startup
    this.loadFromDisk();
    
    // Setup branch change monitoring
    this.setupBranchWatcher();
  }
  
  /**
   * Setup file watcher to detect branch changes in the main repo.
   * Warns user if they switch away from target branch while plans are running.
   */
  private setupBranchWatcher(): void {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) return;
    
    const gitHeadPath = path.join(workspacePath, '.git', 'HEAD');
    
    // Watch for changes to .git/HEAD (branch indicator)
    this.branchWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspacePath, '.git/HEAD')
    );
    
    this.branchWatcher.onDidChange(async () => {
      await this.checkBranchChange(workspacePath);
    });
    
    // Also check immediately on startup
    this.checkBranchChange(workspacePath).catch(() => {});
  }
  
  /**
   * Check if user has switched away from expected target branch.
   */
  private async checkBranchChange(repoPath: string): Promise<void> {
    // Only check if there are running plans
    const runningPlans = Array.from(this.plans.values())
      .filter(p => p.status === 'running' || p.status === 'queued');
    
    if (runningPlans.length === 0) {
      this.branchWarningShown = false;
      return;
    }
    
    try {
      const currentBranch = await git.branches.current(repoPath);
      
      // Get expected target branches from running plans
      const expectedBranches = new Set<string>();
      for (const plan of runningPlans) {
        const spec = this.specs.get(plan.id);
        if (spec?.targetBranch) expectedBranches.add(spec.targetBranch);
        if (spec?.baseBranch) expectedBranches.add(spec.baseBranch);
        if (plan.targetBranchRoot) expectedBranches.add(plan.targetBranchRoot);
      }
      
      // Warn if user switched away from an expected branch
      if (expectedBranches.size > 0 && 
          !expectedBranches.has(currentBranch) && 
          this.lastKnownBranch && 
          expectedBranches.has(this.lastKnownBranch) &&
          !this.branchWarningShown) {
        
        this.branchWarningShown = true;
        const branchList = Array.from(expectedBranches).join(', ');
        
        vscode.window.showWarningMessage(
          `You switched away from branch '${this.lastKnownBranch}' while plans are running. ` +
          `When jobs complete, merges will temporarily checkout the target branch (${branchList}), ` +
          `which may interrupt your current work.`,
          'Understood',
          'Stay on Target Branch'
        ).then(choice => {
          if (choice === 'Stay on Target Branch' && this.lastKnownBranch) {
            git.branches.checkout(repoPath, this.lastKnownBranch).catch(err => {
              vscode.window.showErrorMessage(`Failed to checkout ${this.lastKnownBranch}: ${err.message}`);
            });
          }
        });
      }
      
      this.lastKnownBranch = currentBranch;
    } catch {
      // Ignore errors reading branch
    }
  }
  
  /**
   * Dispose resources (call on extension deactivation).
   */
  dispose(): void {
    this.branchWatcher?.dispose();
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
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
    if (!runnerJobId) {
      log.warn(`Cannot append work summary: no runner job ID for plan job ${planJobId}`, { planId: plan.id });
      return;
    }
    
    const job = this.runner.list().find(j => j.id === runnerJobId);
    if (!job) {
      log.warn(`Cannot append work summary: job ${runnerJobId} not found in runner`, { planId: plan.id, planJobId });
      return;
    }
    if (!job.workSummary) {
      log.warn(`Cannot append work summary: job ${runnerJobId} has no workSummary`, { planId: plan.id, planJobId, jobStatus: job.status });
      return;
    }
    
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
   * Recursively assign internal UUIDs to sub-plans for consistent branch naming.
   */
  private assignSubPlanInternalIds(subPlans?: SubPlanSpec[]): void {
    if (!subPlans) return;
    
    for (const sp of subPlans) {
      if (!sp._internalId) {
        sp._internalId = randomUUID();
      }
      // Recurse into nested sub-plans
      this.assignSubPlanInternalIds(sp.subPlans);
    }
  }

  /**
   * Enqueue a new plan for execution.
   */
  enqueue(spec: PlanSpec): void {
    const id = spec.id || `plan-${Date.now()}`;
    spec.id = id;
    
    // Generate internal UUID for branch naming (avoids collisions with user-friendly IDs)
    if (!spec._internalId) {
      spec._internalId = randomUUID();
    }
    const internalId = spec._internalId;
    
    log.info(`Enqueueing plan: ${id}`, { 
      name: spec.name,
      internalId,
      jobCount: spec.jobs.length,
      baseBranch: spec.baseBranch,
      maxParallel: spec.maxParallel
    });
    
    // Ensure unique worktree root for this plan (use internal ID for uniqueness)
    if (!spec.worktreeRoot) {
      spec.worktreeRoot = `.worktrees/${internalId}`;
    }
    
    // Default base branch
    if (!spec.baseBranch) {
      spec.baseBranch = 'main';
    }
    
    // Pre-compute internal IDs for all sub-plans (recursive)
    this.assignSubPlanInternalIds(spec.subPlans);
    
    // Pre-compute runner job IDs (GUIDs) for all jobs
    // This ensures targetBranch names are unique and won't conflict if not cleaned up
    for (const job of spec.jobs) {
      if (!job.runnerJobId) {
        job.runnerJobId = randomUUID();
      }
      // Use internal ID for branch naming (all UUIDs = no collisions)
      if (!job.inputs.targetBranch) {
        job.inputs.targetBranch = `copilot_jobs/${internalId}/${job.runnerJobId}`;
      }
      // Pre-compute nestedPlanId if this job has a nested plan
      if (job.plan && !job.nestedPlanId) {
        job.nestedPlanId = `${internalId}/${job.id}-${randomUUID().substring(0, 8)}`;
      }
    }
    
    log.debug(`Pre-computed runner job IDs for plan ${id} (internal: ${internalId}):`);
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
      completedCommits: new Map(),
      baseCommits: new Map(),
      worktreePaths: new Map(),
      worktreePromises: new Map(),
      worktreeResults: new Map(),
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
    
    const timings: Record<string, number> = {};
    let stepStart = Date.now();
    
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
        stepStart = Date.now();
        const baseBranch = spec.baseBranch || 'main';
        const internalId = spec._internalId || spec.id;
        const { targetBranchRoot, needsCreation } = await git.orchestrator.resolveTargetBranchRoot(
          baseBranch,
          repoPath,
          `copilot_jobs/${internalId}`
        );
        timings['resolveTargetBranchRoot'] = Date.now() - stepStart;
        
        if (needsCreation) {
          stepStart = Date.now();
          log.info(`Plan ${spec.id}: baseBranch '${baseBranch}' is a default branch, creating feature branch`);
          await git.branches.create(targetBranchRoot, baseBranch, repoPath, s => log.debug(s));
          plan.targetBranchRootCreated = true;
          timings['createBranch'] = Date.now() - stepStart;
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
      stepStart = Date.now();
      await this.checkPreparingJobs(spec, plan, repoPath);
      timings['checkPreparingJobs'] = Date.now() - stepStart;
      
      // Collect jobs to start preparing (up to maxParallel - running - preparing)
      const slotsAvailable = maxParallel - plan.running.length - plan.preparing.length;
      const jobsToPrepare: string[] = [];
      while (jobsToPrepare.length < slotsAvailable && plan.queued.length > 0) {
        jobsToPrepare.push(plan.queued.shift()!);
      }
      
      // Start worktree preparation for new jobs (fire-and-forget, non-blocking)
      stepStart = Date.now();
      for (const jobId of jobsToPrepare) {
        this.startWorktreePreparation(spec, plan, jobId, repoPath);
      }
      timings['startWorktreePrep'] = Date.now() - stepStart;
      
      // Check status of running jobs
      stepStart = Date.now();
      await this.updateJobStatuses(spec, plan);
      timings['updateJobStatuses'] = Date.now() - stepStart;
      
      // Check status of running sub-plans
      stepStart = Date.now();
      await this.updateSubPlanStatuses(spec, plan);
      timings['updateSubPlanStatuses'] = Date.now() - stepStart;
      
      // Check if plan is complete
      stepStart = Date.now();
      this.checkPlanCompletion(spec, plan);
      timings['checkPlanCompletion'] = Date.now() - stepStart;
      
      // Log slow operations
      const slowOps = Object.entries(timings).filter(([_, ms]) => ms > 50);
      if (slowOps.length > 0) {
        log.warn(`Slow pump operations for ${spec.id}`, Object.fromEntries(slowOps));
      }
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
    
    // Compute base commit/branch for worktree (can be a branch name or commit SHA)
    const { baseBranch: baseCommitish, additionalSources } = this.computeBaseBranch(spec, plan, planJob, repoPath);
    const runnerJobId = planJob.runnerJobId!;
    
    // Map plan job ID to runner job ID early
    plan.jobIdMap.set(jobId, runnerJobId);
    
    const wtRootAbs = path.join(repoPath, spec.worktreeRoot || '.worktrees');
    const worktreePath = path.join(wtRootAbs, runnerJobId);
    
    log.debug(`Starting async worktree preparation for job ${jobId}`);
    
    // Fire-and-forget worktree creation - store the promise for later checking
    // Uses detached HEAD mode - no branches created
    const worktreePromise = this.prepareWorktreeAsync(
      spec, plan, planJob, jobId, repoPath, worktreePath, baseCommitish, additionalSources
    );
    
    plan.worktreePromises.set(jobId, worktreePromise);
  }

  /**
   * Async worktree creation - runs in background without blocking the pump.
   * Sets result in plan.worktreeResults when complete (for non-blocking check).
   * 
   * Uses detached HEAD mode - no branches created. Commits are tracked by SHA.
   */
  private async prepareWorktreeAsync(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    planJob: PlanJob, 
    jobId: string, 
    repoPath: string, 
    worktreePath: string, 
    baseCommitish: string, 
    additionalSources: string[]
  ): Promise<boolean> {
    try {
      log.debug(`Creating detached worktree for job ${jobId} at ${worktreePath} from ${baseCommitish}`);
      
      // Create detached worktree (no branch) - returns base commit SHA
      const timing = await git.worktrees.createDetachedWithTiming(
        repoPath,
        worktreePath,
        baseCommitish,
        s => log.debug(s)
      );
      
      if (timing.totalMs > 500) {
        log.warn(`Slow worktree creation for ${jobId} took ${timing.totalMs}ms (worktree: ${timing.worktreeMs}ms, submodules: ${timing.submoduleMs}ms)`);
      }
      
      // Track worktree path and base commit for cleanup/merge
      plan.worktreePaths.set(jobId, worktreePath);
      plan.baseCommits.set(jobId, timing.baseCommit);
      
      log.info(`Created detached worktree for job ${jobId}: ${worktreePath} (base: ${timing.baseCommit.slice(0, 8)})`);
      
      // If job has multiple sources, merge the additional sources (by commit SHA)
      if (additionalSources.length > 0) {
        const mergeSuccess = await this.mergeSourcesIntoWorktree(planJob, worktreePath, additionalSources);
        if (!mergeSuccess) {
          log.error(`Failed to merge sources into worktree for job ${jobId}`);
          // Set result for non-blocking check
          plan.worktreeResults.set(jobId, { success: false, error: 'Failed to merge sources' });
          return false;
        }
      }
      
      // Set result for non-blocking check
      plan.worktreeResults.set(jobId, { success: true });
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to create worktree for job ${jobId}: ${errorMsg}`);
      // Set result for non-blocking check
      plan.worktreeResults.set(jobId, { success: false, error: errorMsg });
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
    
    // Check each preparing job's settled flag - TRUE non-blocking
    for (const jobId of [...plan.preparing]) {
      const result = plan.worktreeResults.get(jobId);
      
      // If no result yet, worktree is still being created - skip
      if (result === undefined) {
        continue;
      }
      
      // Result is set - worktree creation completed (or failed)
      plan.worktreeResults.delete(jobId);
      
      if (result.success) {
        jobsToSubmit.push(jobId);
        log.debug(`Worktree ready for job ${jobId}`);
      } else {
        jobsFailed.push(jobId);
        log.warn(`Worktree creation failed for job ${jobId}: ${result.error}`);
      }
    }
    
    // Submit ready jobs to runner
    const submitStart = Date.now();
    for (const jobId of jobsToSubmit) {
      plan.preparing = plan.preparing.filter(id => id !== jobId);
      await this.submitJobToRunner(spec, plan, jobId, repoPath);
    }
    const submitTime = Date.now() - submitStart;
    if (submitTime > 50) {
      log.warn(`checkPreparingJobs: submitting ${jobsToSubmit.length} jobs took ${submitTime}ms`);
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
   * Compute the base commitish for a job based on its dependencies.
   * 
   * The "baseBranch" value can be:
   * - A branch name (for root jobs with no consumesFrom)
   * - A commit SHA (for jobs that depend on other jobs/sub-plans)
   * 
   * Chaining logic:
   * - If job has no consumesFrom: use plan's targetBranchRoot (branch name)
   * - If job has one source: use that source's completed commit SHA
   * - If job has multiple sources: use first as base, return others as additionalSources
   * 
   * For multiple sources, the additionalSources (commit SHAs) are merged into the
   * worktree after creation, combining all parent work before the job starts.
   * 
   * Returns: { baseBranch: branch|SHA, additionalSources: SHA[] }
   */
  private computeBaseBranch(spec: PlanSpec, plan: InternalPlanState, job: PlanJob, repoPath: string): { baseBranch: string; additionalSources: string[] } {
    // Gather commit SHAs from all consumesFrom sources (jobs and sub-plans)
    const sourceCommits: string[] = [];
    const missingCommits: string[] = [];
    
    log.debug(`Job ${job.id}: computing base from consumesFrom: [${job.consumesFrom.join(', ')}]`);
    
    for (const sourceId of job.consumesFrom) {
      // Check if source is a completed job (stored by commit SHA)
      const jobCommit = plan.completedCommits.get(sourceId);
      if (jobCommit) {
        log.debug(`Job ${job.id}: found source ${sourceId} in completedCommits: ${jobCommit.slice(0, 8)}`);
        sourceCommits.push(jobCommit);
        continue;
      }
      
      // Check if source is a completed sub-plan (stored by commit SHA)
      const subPlanCommit = plan.completedSubPlans.get(sourceId);
      if (subPlanCommit) {
        sourceCommits.push(subPlanCommit);
        log.debug(`Job ${job.id}: found source ${sourceId} in completedSubPlans: ${subPlanCommit.slice(0, 8)}`);
        continue;
      }
      
      // Source not found - track for error reporting
      missingCommits.push(sourceId);
      log.warn(`Job ${job.id}: source ${sourceId} not found in completedCommits or completedSubPlans`, {
        completedCommitsKeys: [...plan.completedCommits.keys()],
        completedSubPlansKeys: [...plan.completedSubPlans.keys()],
        doneJobs: plan.done
      });
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
      log.debug(`Job ${job.id}: root job (no consumesFrom), using targetBranchRoot: ${targetBranchRoot}`);
      return { baseBranch: targetBranchRoot, additionalSources: [] };
    }
    
    // Single source - use that commit directly
    if (sourceCommits.length === 1) {
      log.info(`Job ${job.id}: chaining from single source, base commit: ${sourceCommits[0].slice(0, 8)}`);
      return { baseBranch: sourceCommits[0], additionalSources: [] };
    }
    
    // No commits found despite having consumesFrom - this is an error!
    // Should NOT happen if scheduling is correct (consumesFrom jobs should complete first)
    if (sourceCommits.length === 0) {
      const targetBranchRoot = plan.targetBranchRoot || spec.baseBranch || 'main';
      log.error(`Job ${job.id}: BUG - consumesFrom has entries [${job.consumesFrom.join(', ')}] but no commits found!`, {
        missingCommits,
        completedCommitsKeys: [...plan.completedCommits.keys()],
        completedSubPlansKeys: [...plan.completedSubPlans.keys()],
        doneJobs: plan.done
      });
      log.warn(`Job ${job.id}: falling back to targetBranchRoot: ${targetBranchRoot} (FORWARD MERGE WILL BE MISSING!)`);
      return { baseBranch: targetBranchRoot, additionalSources: [] };
    }
    
    // Multiple sources - use first as base, return others for direct worktree merge
    log.info(`Job ${job.id}: multiple sources, base: ${sourceCommits[0].slice(0, 8)}, will merge ${sourceCommits.length - 1} additional: [${sourceCommits.slice(1).map(s => s.slice(0, 8)).join(', ')}]`);
    return { baseBranch: sourceCommits[0], additionalSources: sourceCommits.slice(1) };
  }
  
  /**
   * Merge additional source commits directly into a job's worktree.
   * This is called after worktree creation when a job consumes from multiple sources.
   * 
   * The sources are commit SHAs from completed jobs/sub-plans.
   * We merge them into the worktree so the job has all parent work combined.
   * 
   * NOTE: We do NOT use squash merge here - we want the full commit history
   * preserved so that downstream jobs can see all the work from their ancestors.
   * Squash merge is only used for leaf-to-target merges (in mergeManager).
   * 
   * Uses Copilot CLI for intelligent conflict resolution if needed.
   */
  private async mergeSourcesIntoWorktree(
    job: PlanJob,
    worktreePath: string,
    additionalSources: string[]
  ): Promise<boolean> {
    if (additionalSources.length === 0) {
      return true;
    }
    
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const prefer = mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs');
    
    log.info(`Merging ${additionalSources.length} additional source commits into worktree for job ${job.id}`, {
      additionalSources: additionalSources.map(s => s.slice(0, 8)),
      worktreePath
    });
    
    for (const sourceCommit of additionalSources) {
      const shortSha = sourceCommit.slice(0, 8);
      log.debug(`Merging commit ${shortSha} into worktree at ${worktreePath}`);
      
      // Merge by commit SHA directly (no branch needed)
      // Do NOT squash - we want full history preserved for downstream jobs
      const mergeResult = await git.merge.merge({
        source: sourceCommit,  // Use commit SHA directly
        target: 'HEAD',        // Current detached HEAD
        cwd: worktreePath,
        message: `Merge parent commit ${shortSha} for job ${job.id}`,
        squash: false,         // Keep full history for dependency chain
        log: (msg: string) => log.debug(msg)
      });
      
      if (mergeResult.success) {
        log.debug(`Merge of commit ${shortSha} succeeded (no conflicts)`);
        continue;
      }
      
      // Handle merge conflict with Copilot CLI
      if (mergeResult.hasConflicts) {
        log.info(`Merge conflict detected for commit ${shortSha}, using Copilot CLI to resolve...`);
        
        const mergeInstruction = `@agent Resolve the current git merge conflict. ` +
          `We are merging commit '${shortSha}' into the current working directory for job '${job.id}'. ` +
          `Prefer '${prefer}' changes when there are conflicts. ` +
          `Resolve all conflicts, stage the changes with 'git add', and commit with message 'orchestrator: merge commit ${shortSha} for job ${job.id}'`;
        
        // Use string command with JSON.stringify to handle spaces in prompt
        const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
        
        // Run async to avoid blocking the event loop
        const result = await new Promise<{ status: number | null }>((resolve) => {
          const child = spawn(copilotCmd, [], {
            cwd: worktreePath,
            shell: true,
            timeout: 300000, // 5 minute timeout
          });
          
          child.on('close', (code) => {
            resolve({ status: code });
          });
          
          child.on('error', (err) => {
            log.error('Copilot CLI spawn error', { error: err.message });
            resolve({ status: 1 });
          });
        });
        
        if (result.status !== 0) {
          log.error(`Copilot CLI failed to resolve merge conflict for commit ${shortSha}`, { 
            exitCode: result.status
          });
          // Abort the merge
          try {
            await git.merge.abort(worktreePath);
          } catch {}
          return false;
        }
        
        log.info(`Copilot CLI resolved merge conflict for commit ${shortSha}`);
      } else {
        // Non-conflict failure
        log.error(`Merge failed for commit ${shortSha}: ${mergeResult.error}`);
        return false;
      }
    }
    
    log.info(`Successfully merged all source commits into worktree for job ${job.id}`);
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
        
        // Get the completed commit for this sub-plan
        // Try to find the final commit from the child plan's completed work
        let completedCommit: string | undefined;
        
        // Look for leaf jobs in the child plan and get their commits
        if (childSpec) {
          const leafJobs = childSpec.jobs.filter(j => {
            return !childSpec.jobs.some(other => other.consumesFrom.includes(j.id));
          });
          
          if (leafJobs.length === 1) {
            completedCommit = childPlan.completedCommits.get(leafJobs[0].id);
          } else if (leafJobs.length > 1) {
            // Multiple leaf jobs - use the last completed leaf's commit
            // (In practice, RI merge would have combined them into targetBranch)
            for (const leaf of leafJobs) {
              const commit = childPlan.completedCommits.get(leaf.id);
              if (commit) completedCommit = commit;
            }
          }
        }
        
        // Record the completed commit so consumers can use it
        if (completedCommit) {
          // Add entry to completedCommits using the sub-plan ID
          // Jobs can consume from the sub-plan ID to receive its completed commit
          plan.completedCommits.set(subPlanId, completedCommit);
          log.debug(`Sub-plan ${subPlanId} completed commit: ${completedCommit.slice(0, 8)}`);
        }
        
        plan.runningSubPlans.delete(subPlanId);
        // Store childPlanId (not commit) so UI can navigate to sub-plan detail view
        plan.completedSubPlans.set(subPlanId, childPlanId);
        this.persist();  // Persist sub-plan completion immediately
        
        // Append sub-plan's aggregated work summary to parent - computed once at completion
        this.appendSubPlanWorkSummary(plan, subPlanId, childPlanId);
        
        // Check if this sub-plan is a leaf (nothing consumes from it)
        // If so, immediately merge to targetBranch - user gets value right away!
        // Await the merge to ensure it completes before moving on
        const isLeaf = mergeManager.isLeafWorkUnit(spec, subPlanId);
        if (isLeaf && completedCommit) {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          const repoPath = spec.repoPath || ws;
          const shouldCleanup = spec.cleanUpSuccessfulWork !== false;
          // Note: For sub-plans, we DON'T call appendJobWorkSummary in mergeLeafToTarget
          // because we already appended the sub-plan's aggregate above
          try {
            log.info(`Merging and cleaning up sub-plan ${subPlanId}`);
            await mergeManager.mergeLeafToTarget(spec, plan, subPlanId, completedCommit, repoPath);
            if (shouldCleanup) {
              await cleanupManager.cleanupWorkUnit(spec, plan, subPlanId, repoPath);
            }
            this.persist();
            log.info(`Completed merge/cleanup for sub-plan ${subPlanId}`);
          } catch (err: any) {
            log.error(`Merge/cleanup failed for sub-plan ${subPlanId}`, { error: err.message });
          }
        }
        
        // Check if this completion unblocks any jobs or other sub-plans
        // This is fast (just state updates) so we can await it
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
   * Records the completed commit SHA for dependency chaining.
   * 
   * NOTE: Merge and cleanup operations are fire-and-forget to avoid blocking the pump.
   */
  private async handleJobSuccess(spec: PlanSpec, plan: InternalPlanState, jobId: string, runnerJob: Job): Promise<void> {
    // Remove from running, add to done
    plan.running = plan.running.filter(id => id !== jobId);
    plan.done.push(jobId);
    
    // Get the final commit SHA from the worktree
    // This is the KEY for commit chaining - dependent jobs will use this commit as their base
    const worktreePath = plan.worktreePaths.get(jobId);
    let completedCommit: string | null = null;
    
    if (worktreePath) {
      completedCommit = await git.worktrees.getHeadCommit(worktreePath);
    }
    
    if (!completedCommit) {
      // Fallback: this shouldn't happen but handle gracefully
      log.warn(`Could not get HEAD commit for job ${jobId}, using base commit as fallback`);
      completedCommit = plan.baseCommits.get(jobId) || 'HEAD';
    }
    
    plan.completedCommits.set(jobId, completedCommit);
    
    log.info(`Job ${jobId} succeeded`, {
      planId: spec.id,
      completedCommit: completedCommit.slice(0, 8),
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
    // Await the merge to ensure it completes before moving on
    const isLeaf = mergeManager.isLeafWorkUnit(spec, jobId);
    log.info(`Job ${jobId} completion: isLeaf=${isLeaf}, isSubPlan=${spec.isSubPlan}`, {
      completedCommit: completedCommit.slice(0, 8),
      cleanUpEnabled: spec.cleanUpSuccessfulWork !== false,
    });
    if (isLeaf && !spec.isSubPlan) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const repoPath = spec.repoPath || ws;
      log.info(`Merging and cleaning up leaf job ${jobId}`);
      try {
        await this.mergeLeafToTarget(spec, plan, jobId, completedCommit, repoPath);
        log.info(`Completed merge/cleanup for leaf job ${jobId}`);
      } catch (err: any) {
        log.error(`Merge/cleanup failed for leaf job ${jobId}`, { error: err.message });
      }
    } else {
      log.info(`Job ${jobId} is not a leaf or is part of sub-plan - cleanup will be triggered by consumer cleanup`);
    }
    
    // Check for jobs that depended on this one and are now ready
    // This is fast (just state updates) so we can await it
    await this.queueReadyDependents(spec, plan, jobId);
  }
  
  /**
   * Immediately merge a completed leaf job's commit to targetBranch.
   * Delegates to mergeManager module.
   * 
   * After successful merge, appends the job's work summary to the plan's
   * aggregated summary - this is computed ONCE at merge time, not on every enumeration.
   */
  private async mergeLeafToTarget(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    jobId: string, 
    completedCommit: string,
    repoPath: string
  ): Promise<void> {
    const planJob = spec.jobs.find(j => j.id === jobId);
    const success = await mergeManager.mergeLeafToTarget(spec, plan, jobId, completedCommit, repoPath);
    
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
    
    // Determine the source commit/branch for the sub-plan (from consumesFrom sources)
    let sourceCommitish: string;
    if (subPlanSpec.consumesFrom.length === 0) {
      // Root sub-plan - uses parent's targetBranchRoot
      sourceCommitish = parentState.targetBranchRoot || parentSpec.baseBranch || 'main';
    } else if (subPlanSpec.consumesFrom.length === 1) {
      // Single source - use its completed commit
      const sourceId = subPlanSpec.consumesFrom[0];
      sourceCommitish = parentState.completedCommits.get(sourceId) 
        || parentState.completedSubPlans.get(sourceId) 
        || parentState.targetBranchRoot 
        || 'main';
    } else {
      // Multiple sources - need to merge them
      const sourceCommits = subPlanSpec.consumesFrom
        .map(id => parentState.completedCommits.get(id) || parentState.completedSubPlans.get(id))
        .filter((c): c is string => !!c);
      
      if (sourceCommits.length === 0) {
        sourceCommitish = parentState.targetBranchRoot || 'main';
      } else if (sourceCommits.length === 1) {
        sourceCommitish = sourceCommits[0];
      } else {
        // For multiple sources, use the first (merge should be handled by parent)
        sourceCommitish = sourceCommits[0];
        log.warn(`Sub-plan ${childPlanId} has multiple sources, using first: ${sourceCommitish.slice(0, 8)}`);
      }
    }
    
    log.info(`Sub-plan ${childPlanId} will start from: ${sourceCommitish.length > 20 ? sourceCommitish.slice(0, 8) : sourceCommitish}`);
    
    // Convert sub-plan jobs to PlanJob format
    // Jobs will create detached worktrees from the source commit
    const jobs: PlanJob[] = subPlanSpec.jobs.map(j => ({
      id: j.id,
      name: j.name,
      task: j.task,
      consumesFrom: j.consumesFrom,
      inputs: {
        baseBranch: sourceCommitish,  // Can be branch name or commit SHA
        targetBranch: '',  // Not used for detached worktrees
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
    
    // Generate internal ID for the sub-plan
    const subPlanInternalId = subPlanSpec._internalId || randomUUID();
    
    // Create the nested plan spec
    // With detached HEAD worktrees, there are no integration branches
    // The sub-plan's work is tracked by commit SHAs
    const nestedPlanSpec: PlanSpec = {
      id: childPlanId,
      _internalId: subPlanInternalId,  // Internal ID for worktree path uniqueness
      name: subPlanSpec.name || `${parentSpec.name || parentSpec.id} / ${subPlanSpec.id}`,
      repoPath: parentSpec.repoPath,
      worktreeRoot: `${parentSpec.worktreeRoot}/${subPlanInternalId}`,  // Use internal ID for path uniqueness
      baseBranch: sourceCommitish,  // Start from the source commit/branch
      targetBranch: parentState.targetBranchRoot || parentSpec.baseBranch || 'main',  // Sub-plan merges to parent's target
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
    
    // Enqueue the nested plan
    this.enqueue(nestedPlanSpec);
    
    log.info(`Sub-plan ${childPlanId} enqueued with ${jobs.length} jobs, source: ${sourceCommitish.length > 20 ? sourceCommitish.slice(0, 8) : sourceCommitish}`);
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
    // Fire-and-forget with error logging
    mergeManager.performFinalMerge(spec, plan, repoPath)
      .then(() => {
        log.info(`Final merge completed for plan ${spec.id}`);
        this.persist();
      })
      .catch(err => {
        log.error(`Final merge failed for plan ${spec.id}`, { error: err.message });
        plan.error = `Final merge failed: ${err.message}`;
        this.persist();
      });
  }

  /**
   * Clean up integration branches created for sub-plans.
   * Delegates to mergeManager module.
   */
  private cleanupIntegrationBranches(plan: InternalPlanState, repoPath: string): void {
    // Fire-and-forget with error logging
    mergeManager.cleanupIntegrationBranches(plan, repoPath)
      .then(() => log.debug(`Integration branches cleanup completed for plan ${plan.id}`))
      .catch(err => log.error(`Integration branches cleanup failed for plan ${plan.id}`, { error: err.message }));
    this.persist();
  }

  /**
   * Clean up all worktrees and branches for a completed plan.
   * Delegates to cleanupManager module.
   */
  private cleanupAllPlanResources(spec: PlanSpec, plan: InternalPlanState, repoPath: string): void {
    // Fire-and-forget with error logging
    cleanupManager.cleanupAllPlanResources(spec, plan, repoPath)
      .then(() => log.info(`All resources cleaned up for plan ${spec.id}`))
      .catch(err => log.error(`Resource cleanup failed for plan ${spec.id}`, { error: err.message }));
    
    // Also clean up any nested sub-plans
    for (const [subPlanId, childPlanId] of plan.completedSubPlans) {
      const childPlan = this.plans.get(childPlanId);
      const childSpec = this.specs.get(childPlanId);
      if (childPlan && childSpec) {
        cleanupManager.cleanupAllPlanResources(childSpec, childPlan, repoPath)
          .then(() => log.debug(`Nested plan ${childPlanId} resources cleaned up`))
          .catch(err => log.error(`Nested plan ${childPlanId} cleanup failed`, { error: err.message }));
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
      // Note: spec.worktreeRoot uses internal UUID for consistency
      const internalId = spec._internalId || id;
      const worktreeRoot = path.join(repoPath, spec.worktreeRoot || `.worktrees/${internalId}`);
      log.debug(`Cleaning up worktree root on delete: ${worktreeRoot}`);
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
