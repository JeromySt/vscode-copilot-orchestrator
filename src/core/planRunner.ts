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
import * as branchUtils from '../git/branchUtils';

/** Plan runner component logger */
const log: ComponentLogger = Logger.for('plans');

// ============================================================================
// TYPES
// ============================================================================

/**
 * A job within a plan, with dependency and branching information.
 */
export interface PlanJob {
  /** Unique job ID within the plan */
  id: string;
  /** Pre-computed runner job ID (GUID) - assigned when plan is enqueued */
  runnerJobId?: string;
  /** Pre-computed nested plan ID (if this job creates a sub-plan) - assigned when plan is enqueued */
  nestedPlanId?: string;
  /** Human-readable name */
  name?: string;
  /** Task description */
  task?: string;
  /** IDs of work units (jobs or sub-plans) this job consumes from (producer→consumer). */
  consumesFrom: string[];
  /** Nested plan specification (if this job is a sub-plan) */
  plan?: Omit<PlanSpec, 'id' | 'repoPath' | 'worktreeRoot'>;
  /** Job inputs */
  inputs: {
    /** Base branch - auto-computed from parent jobs when dependencies exist */
    baseBranch: string;
    /** Target branch for this job (auto-generated if empty) */
    targetBranch: string;
    /** Additional instructions */
    instructions?: string;
  };
  /** Execution policy */
  policy?: {
    useJust?: boolean;
    steps?: {
      prechecks?: string;
      work?: string;
      postchecks?: string;
    };
  };
}

/**
 * A sub-plan that runs as part of a parent plan.
 * Sub-plans trigger after certain jobs complete and merge their results
 * back into the parent plan's flow.
 */
/**
 * Job definition within a sub-plan.
 */
export interface SubPlanJob {
  id: string;
  name?: string;
  task: string;
  work?: string;
  /** IDs of jobs within the sub-plan this job consumes from (producer→consumer). */
  consumesFrom: string[];
  prechecks?: string;
  postchecks?: string;
  instructions?: string;
}

/**
 * A sub-plan that runs as part of a parent plan.
 * Sub-plans trigger after their consumesFrom work units complete.
 * Downstream work units that list this sub-plan in their consumesFrom
 * will wait for it and receive its completed branch.
 * 
 * Sub-plans can themselves have sub-plans, enabling arbitrary nesting.
 */
export interface SubPlanSpec {
  /** Unique sub-plan ID within the parent plan */
  id: string;
  /** Human-readable name */
  name?: string;
  /** IDs of work units (jobs or sub-plans) that must complete before this sub-plan starts. */
  consumesFrom: string[];
  /** Maximum parallel jobs in the sub-plan */
  maxParallel?: number;
  /** Jobs within this sub-plan */
  jobs: SubPlanJob[];
  /** Nested sub-plans within this sub-plan (recursive) */
  subPlans?: SubPlanSpec[];
}

/**
 * Plan specification defining the execution DAG.
 */
export interface PlanSpec {
  /** Unique plan ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Repository path (defaults to workspace) */
  repoPath?: string;
  /** Worktree root for this plan (defaults to .worktrees/<planId>) */
  worktreeRoot?: string;
  /** Base branch the plan starts from */
  baseBranch?: string;
  /** Target branch to merge final results (defaults to baseBranch) */
  targetBranch?: string;
  /** Maximum parallel jobs (0 = auto based on CPU) */
  maxParallel?: number;
  /** Jobs in this plan */
  jobs: PlanJob[];
  /** Sub-plans that trigger after certain jobs complete */
  subPlans?: SubPlanSpec[];
  /** Whether this plan is a sub-plan (launched by a parent plan) */
  isSubPlan?: boolean;
  /** Parent plan ID if this is a sub-plan */
  parentPlanId?: string;
  /** 
   * Whether to clean up worktrees/branches for successfully merged work units.
   * When true (default), worktrees and branches are deleted after a leaf merges to targetBranch.
   * This keeps local git state minimal during plan execution.
   * When false, cleanup only happens when the plan is deleted.
   */
  cleanUpSuccessfulWork?: boolean;
}

/**
 * Runtime state of a plan.
 */
export interface PlanState {
  /** Plan ID */
  id: string;
  /** Current status */
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'partial';
  /** Jobs waiting to be scheduled */
  queued: string[];
  /** Currently running jobs */
  running: string[];
  /** Successfully completed jobs */
  done: string[];
  /** Failed jobs */
  failed: string[];
  /** Canceled jobs */
  canceled: string[];
  /** Jobs that have been submitted to the runner */
  submitted: string[];
  /** Plan start time */
  startedAt?: number;
  /** Plan end time */
  endedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Whether the final RI merge to targetBranch completed successfully */
  riMergeCompleted?: boolean;
  /** Work units that have been merged to targetBranch (incremental delivery) */
  mergedLeaves?: string[];
  
  // Sub-plan status (optional, only present if plan has sub-plans)
  /** Sub-plans that have not yet been triggered */
  pendingSubPlans?: string[];
  /** Sub-plans currently running (map of sub-plan ID -> child plan ID) */
  runningSubPlans?: Record<string, string>;
  /** Sub-plans that have completed */
  completedSubPlans?: string[];
  /** Sub-plans that have failed */
  failedSubPlans?: string[];
  
  /** Aggregated work summary across all completed jobs in the plan */
  aggregatedWorkSummary?: {
    totalCommits: number;
    totalFilesAdded: number;
    totalFilesModified: number;
    totalFilesDeleted: number;
    jobSummaries: Array<{
      jobId: string;
      jobName: string;
      commits: number;
      filesAdded: number;
      filesModified: number;
      filesDeleted: number;
      description: string;
      /** Detailed commit information */
      commitDetails?: Array<{
        hash: string;
        shortHash: string;
        message: string;
        author: string;
        date: string;
        filesAdded: string[];
        filesModified: string[];
        filesDeleted: string[];
      }>;
    }>;
  };
}

// ============================================================================
// INTERNAL STATE (not exported, but used for branch tracking)
// ============================================================================

interface InternalPlanState extends Omit<PlanState, 'pendingSubPlans' | 'runningSubPlans' | 'completedSubPlans' | 'failedSubPlans' | 'mergedLeaves'> {
  /** Map of plan job ID -> actual JobRunner job ID (GUID) */
  jobIdMap: Map<string, string>;
  /** Map of plan job ID -> completed branch name */
  completedBranches: Map<string, string>;
  /** Map of plan job ID -> worktree path */
  worktreePaths: Map<string, string>;
  /** 
   * The targetBranchRoot for this plan.
   * - If baseBranch was a default branch, this is a new feature branch
   * - Otherwise, this equals baseBranch
   */
  targetBranchRoot?: string;
  /** Whether targetBranchRoot was created by the plan (vs using existing branch) */
  targetBranchRootCreated?: boolean;
  
  // Sub-plan tracking (using Sets/Maps internally, converted to arrays for public state)
  /** Sub-plans that haven't been triggered yet */
  pendingSubPlans: Set<string>;
  /** Sub-plans currently running (sub-plan ID -> child plan ID) */
  runningSubPlans: Map<string, string>;
  /** Sub-plans that have completed (sub-plan ID -> completed branch) */
  completedSubPlans: Map<string, string>;
  /** Sub-plans that have failed */
  failedSubPlans: Set<string>;
  /** Integration branches created for sub-plans (sub-plan ID -> branch name) */
  subPlanIntegrationBranches?: Map<string, string>;
  /** Work units (jobs/sub-plans) that have been merged to targetBranch */
  mergedLeaves: Set<string>;
}

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
  private plansFile: string;
  
  /** Event emitter for plan changes */
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(private runner: JobRunner) {
    // Determine plans file path
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.plansFile = workspacePath 
      ? path.join(workspacePath, '.orchestrator', 'jobs', 'plans.json')
      : '';
    
    // Load persisted plans on startup
    this.loadFromDisk();
  }

  /**
   * Notify listeners that plans have changed.
   */
  private notifyChange(): void {
    this._onDidChange.fire();
  }

  // ============================================================================
  // PERSISTENCE
  // ============================================================================

  /**
   * Persist plans state to disk.
   */
  private persist(): void {
    if (!this.plansFile) return;
    
    try {
      const dir = path.dirname(this.plansFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Convert Maps to plain objects for serialization
      const data = {
        plans: Array.from(this.plans.entries()).map(([id, state]) => ({
          ...this.toPublicState(state),
          // Preserve internal maps as arrays for serialization
          _jobIdMap: Array.from(state.jobIdMap.entries()),
          _completedBranches: Array.from(state.completedBranches.entries()),
          _worktreePaths: Array.from(state.worktreePaths.entries()),
          _targetBranchRoot: state.targetBranchRoot,
          _targetBranchRootCreated: state.targetBranchRootCreated,
          // Sub-plan state
          _pendingSubPlans: Array.from(state.pendingSubPlans || []),
          _runningSubPlans: Array.from(state.runningSubPlans?.entries() || []),
          _completedSubPlans: Array.from(state.completedSubPlans?.entries() || []),
          _failedSubPlans: Array.from(state.failedSubPlans || []),
          _subPlanIntegrationBranches: Array.from(state.subPlanIntegrationBranches?.entries() || []),
          // Incremental delivery tracking
          _mergedLeaves: Array.from(state.mergedLeaves || [])
        })),
        specs: Array.from(this.specs.entries()).map(([id, spec]) => spec)
      };
      
      fs.writeFileSync(this.plansFile, JSON.stringify(data, null, 2), 'utf-8');
      log.debug('Plans persisted to disk', { planCount: data.plans.length });
    } catch (error: any) {
      log.error('Failed to persist plans', { error: error.message });
    }
  }

  /**
   * Load plans from disk.
   */
  private loadFromDisk(): void {
    if (!this.plansFile || !fs.existsSync(this.plansFile)) return;
    
    try {
      const data = JSON.parse(fs.readFileSync(this.plansFile, 'utf-8'));
      
      // Restore specs
      if (data.specs) {
        for (const spec of data.specs) {
          this.specs.set(spec.id, spec);
        }
      }
      
      // Restore plan states
      if (data.plans) {
        for (const planData of data.plans) {
          const state: InternalPlanState = {
            id: planData.id,
            status: planData.status,
            queued: planData.queued || [],
            running: planData.running || [],
            done: planData.done || [],
            failed: planData.failed || [],
            canceled: planData.canceled || [],
            submitted: planData.submitted || [],
            startedAt: planData.startedAt,
            endedAt: planData.endedAt,
            error: planData.error,
            // Restore Maps from arrays
            jobIdMap: new Map(planData._jobIdMap || []),
            completedBranches: new Map(planData._completedBranches || []),
            worktreePaths: new Map(planData._worktreePaths || []),
            targetBranchRoot: planData._targetBranchRoot,
            targetBranchRootCreated: planData._targetBranchRootCreated,
            // Restore sub-plan state
            pendingSubPlans: new Set(planData._pendingSubPlans || []),
            runningSubPlans: new Map(planData._runningSubPlans || []),
            completedSubPlans: new Map(planData._completedSubPlans || []),
            failedSubPlans: new Set(planData._failedSubPlans || []),
            subPlanIntegrationBranches: new Map(planData._subPlanIntegrationBranches || []),
            // Restore incremental delivery tracking
            mergedLeaves: new Set(planData._mergedLeaves || [])
          };
          this.plans.set(state.id, state);
        }
      }
      
      log.info('Plans loaded from disk', { 
        planCount: this.plans.size,
        specCount: this.specs.size
      });
      
      // Resume any plans that were running
      this.resumeIncompletePlans();
      
    } catch (error: any) {
      log.error('Failed to load plans from disk', { error: error.message });
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
      this.interval = setInterval(() => this.pumpAll(), 500);
      log.info(`Pump loop started for ${resumed} resumed plans`);
    }
  }

  /**
   * Get all plans (returns public PlanState without internal maps).
   */
  list(): PlanState[] {
    return Array.from(this.plans.values()).map(p => this.toPublicState(p));
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
    return plan ? this.toPublicState(plan) : undefined;
  }

  /**
   * Convert internal state to public state (hide Maps).
   */
  private toPublicState(internal: InternalPlanState): PlanState {
    const state: PlanState = {
      id: internal.id,
      status: internal.status,
      queued: internal.queued,
      running: internal.running,
      done: internal.done,
      failed: internal.failed,
      canceled: internal.canceled,
      submitted: internal.submitted,
      startedAt: internal.startedAt,
      endedAt: internal.endedAt,
      error: internal.error,
      riMergeCompleted: internal.riMergeCompleted,
      mergedLeaves: internal.mergedLeaves?.size ? Array.from(internal.mergedLeaves) : undefined
    };
    
    // Include sub-plan status if there are any
    if (internal.pendingSubPlans?.size || internal.runningSubPlans?.size || 
        internal.completedSubPlans?.size || internal.failedSubPlans?.size) {
      state.pendingSubPlans = Array.from(internal.pendingSubPlans || []);
      state.runningSubPlans = Object.fromEntries(internal.runningSubPlans || []);
      state.completedSubPlans = Array.from(internal.completedSubPlans?.keys() || []);
      state.failedSubPlans = Array.from(internal.failedSubPlans || []);
    }
    
    // Aggregate work summaries from merged leaves - show as soon as any leaf is merged
    if (internal.mergedLeaves?.size > 0) {
      state.aggregatedWorkSummary = this.aggregateWorkSummaries(internal);
    }
    
    return state;
  }
  
  /**
   * Aggregate work summaries from merged leaf jobs and completed sub-plans.
   * Includes jobs merged to targetBranch and work summaries from child plans.
   */
  private aggregateWorkSummaries(internal: InternalPlanState): PlanState['aggregatedWorkSummary'] {
    const spec = this.specs.get(internal.id);
    if (!spec) return undefined;
    
    let totalCommits = 0;
    let totalFilesAdded = 0;
    let totalFilesModified = 0;
    let totalFilesDeleted = 0;
    const jobSummaries: NonNullable<PlanState['aggregatedWorkSummary']>['jobSummaries'] = [];
    
    // Include jobs that have been merged to targetBranch (from this plan)
    for (const planJobId of internal.mergedLeaves || []) {
      const runnerJobId = internal.jobIdMap.get(planJobId);
      if (!runnerJobId) continue;
      
      const job = this.runner.list().find(j => j.id === runnerJobId);
      if (!job || !job.workSummary) continue;
      
      const planJob = spec.jobs.find(j => j.id === planJobId);
      const ws = job.workSummary;
      
      totalCommits += ws.commits || 0;
      totalFilesAdded += ws.filesAdded || 0;
      totalFilesModified += ws.filesModified || 0;
      totalFilesDeleted += ws.filesDeleted || 0;
      
      jobSummaries.push({
        jobId: planJobId,
        jobName: planJob?.name || planJobId,
        commits: ws.commits || 0,
        filesAdded: ws.filesAdded || 0,
        filesModified: ws.filesModified || 0,
        filesDeleted: ws.filesDeleted || 0,
        description: ws.description || '',
        commitDetails: ws.commitDetails
      });
    }
    
    // Include work summaries from completed sub-plans (recursively)
    for (const [subPlanId, childPlanId] of internal.completedSubPlans || []) {
      const childPlanState = this.plans.get(childPlanId);
      if (!childPlanState?.aggregatedWorkSummary) continue;
      
      const childWs = childPlanState.aggregatedWorkSummary;
      totalCommits += childWs.totalCommits;
      totalFilesAdded += childWs.totalFilesAdded;
      totalFilesModified += childWs.totalFilesModified;
      totalFilesDeleted += childWs.totalFilesDeleted;
      
      // Include child plan's job summaries with sub-plan prefix
      for (const childJobSummary of childWs.jobSummaries) {
        jobSummaries.push({
          ...childJobSummary,
          jobId: `${subPlanId}/${childJobSummary.jobId}`,
          jobName: `${subPlanId}: ${childJobSummary.jobName}`
        });
      }
    }
    
    if (jobSummaries.length === 0) return undefined;
    
    return {
      totalCommits,
      totalFilesAdded,
      totalFilesModified,
      totalFilesDeleted,
      jobSummaries
    };
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
      running: [],
      done: [],
      failed: [],
      canceled: [],
      submitted: [],
      jobIdMap: new Map(),
      completedBranches: new Map(),
      worktreePaths: new Map(),
      // Sub-plan tracking
      pendingSubPlans: new Set(spec.subPlans?.map(sp => sp.id) || []),
      runningSubPlans: new Map(),
      completedSubPlans: new Map(),
      failedSubPlans: new Set(),
      // Incremental delivery tracking
      mergedLeaves: new Set()
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
      this.interval = setInterval(() => this.pumpAll(), 500);
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
      this.interval = setInterval(() => this.pumpAll(), 500);
    }
    
    log.info(`Plan ${id} retry started`, { requeuedJobs: plan.queued.length });
    return true;
  }

  /**
   * Pump all plans.
   */
  private pumpAll(): void {
    for (const [id, _] of this.plans) {
      const spec = this.specs.get(id);
      if (spec) {
        this.pump(spec);
      }
    }
    // Persist and notify listeners of any changes
    this.persist();
    this.notifyChange();
  }

  /**
   * Main scheduling loop for a plan.
   */
  private pump(spec: PlanSpec): void {
    const plan = this.plans.get(spec.id);
    if (!plan) return;
    
    // Skip if plan is in terminal state
    if (['canceled', 'succeeded', 'failed', 'partial'].includes(plan.status)) {
      return;
    }
    
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
      const { targetBranchRoot, needsCreation } = branchUtils.resolveTargetBranchRoot(
        baseBranch,
        repoPath,
        `copilot_jobs/${spec.id}`
      );
      
      if (needsCreation) {
        log.info(`Plan ${spec.id}: baseBranch '${baseBranch}' is a default branch, creating feature branch`);
        branchUtils.createBranch(targetBranchRoot, baseBranch, repoPath, s => log.debug(s));
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
    
    // Schedule new jobs while under parallel limit and queue has items
    while (plan.running.length < maxParallel && plan.queued.length > 0) {
      const jobId = plan.queued.shift()!;
      this.scheduleJob(spec, plan, jobId, repoPath);
    }
    
    // Check status of running jobs
    this.updateJobStatuses(spec, plan);
    
    // Check status of running sub-plans
    this.updateSubPlanStatuses(spec, plan);
    
    // Check if plan is complete
    this.checkPlanCompletion(spec, plan);
  }

  /**
   * Schedule a job for execution.
   * 
   * Key: The baseBranch is computed from completed dependencies,
   * ensuring proper branch chaining through the DAG.
   */
  private scheduleJob(spec: PlanSpec, plan: InternalPlanState, jobId: string, repoPath: string): void {
    const planJob = spec.jobs.find(j => j.id === jobId);
    if (!planJob) {
      log.error(`Job ${jobId} not found in plan spec`);
      return;
    }
    
    // Compute the base branch for this job (chain from parent, or first of multiple parents)
    const { baseBranch, additionalSources } = this.computeBaseBranch(spec, plan, planJob, repoPath);
    
    // Use pre-computed runner job ID (assigned when plan was enqueued)
    const runnerJobId = planJob.runnerJobId!;
    
    // Map plan job ID to runner job ID
    plan.jobIdMap.set(jobId, runnerJobId);
    
    // Use pre-computed target branch (also assigned when plan was enqueued)
    const targetBranch = planJob.inputs.targetBranch!;
    
    log.info(`Scheduling job: ${jobId}`, {
      planId: spec.id,
      runnerJobId,
      baseBranch,
      targetBranch,
      consumesFrom: planJob.consumesFrom,
      additionalSources: additionalSources.length > 0 ? additionalSources : undefined
    });
    
    // Create worktree for this job (plan manages worktrees, not the job)
    const wtRootAbs = path.join(repoPath, spec.worktreeRoot || '.worktrees');
    const worktreePath = path.join(wtRootAbs, runnerJobId);
    
    try {
      log.debug(`Creating worktree for job ${jobId} at ${worktreePath}`);
      branchUtils.createWorktree(
        worktreePath,
        targetBranch,  // The worktree branch IS the targetBranch
        baseBranch,    // Created from baseBranch (first parent's completed branch or plan's targetBranchRoot)
        repoPath,
        s => log.debug(s)
      );
      
      // Track worktree path for cleanup
      plan.worktreePaths.set(jobId, worktreePath);
      
      log.info(`Created worktree for job ${jobId}: ${worktreePath} on branch ${targetBranch}`);
      
      // If job has multiple sources, merge the additional sources directly into the worktree
      if (additionalSources.length > 0) {
        const mergeSuccess = this.mergeSourcesIntoWorktree(planJob, worktreePath, additionalSources);
        if (!mergeSuccess) {
          log.error(`Failed to merge sources into worktree for job ${jobId}`);
          plan.failed.push(jobId);
          return;
        }
      }
    } catch (err) {
      log.error(`Failed to create worktree for job ${jobId}: ${err}`);
      plan.failed.push(jobId);
      plan.queued = plan.queued.filter(id => id !== jobId);
      return;
    }
    
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
        // Plan-managed job settings
        isPlanManaged: true,
        worktreePath: worktreePath,
        // Track parent plan for UI grouping
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
  private mergeSourcesIntoWorktree(
    job: PlanJob,
    worktreePath: string,
    additionalSources: string[]
  ): boolean {
    if (additionalSources.length === 0) {
      return true;
    }
    
    const { execSync, spawnSync } = require('child_process');
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const prefer = mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs');
    
    log.info(`Merging ${additionalSources.length} additional sources into worktree for job ${job.id}`, {
      additionalSources,
      worktreePath
    });
    
    for (const sourceBranch of additionalSources) {
      log.debug(`Merging ${sourceBranch} into worktree at ${worktreePath}`);
      
      try {
        // First try a simple git merge
        execSync(`git merge --no-edit "origin/${sourceBranch}" -m "Merge ${sourceBranch} for job ${job.id}"`, { 
          cwd: worktreePath, 
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        log.debug(`Simple merge of ${sourceBranch} succeeded (no conflicts)`);
      } catch (mergeError: any) {
        // Try without origin/ prefix
        try {
          execSync(`git merge --no-edit "${sourceBranch}" -m "Merge ${sourceBranch} for job ${job.id}"`, { 
            cwd: worktreePath, 
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          log.debug(`Simple merge of ${sourceBranch} (local) succeeded (no conflicts)`);
        } catch (localMergeError: any) {
          // Merge conflict - use Copilot CLI to resolve
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
              execSync('git merge --abort', { cwd: worktreePath, stdio: 'pipe' });
            } catch {}
            return false;
          }
          
          log.info(`Copilot CLI resolved merge conflict for ${sourceBranch}`);
        }
      }
    }
    
    log.info(`Successfully merged all sources into worktree for job ${job.id}`);
    return true;
  }

  /**
   * Update job statuses from the runner.
   */
  private updateJobStatuses(spec: PlanSpec, plan: InternalPlanState): void {
    const runnerJobs = this.runner.list();
    
    for (const planJobId of [...plan.running]) {
      const runnerJobId = plan.jobIdMap.get(planJobId);
      if (!runnerJobId) continue;
      
      const runnerJob = runnerJobs.find(j => j.id === runnerJobId);
      if (!runnerJob) continue;
      
      switch (runnerJob.status) {
        case 'succeeded':
          this.handleJobSuccess(spec, plan, planJobId, runnerJob);
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
  private updateSubPlanStatuses(spec: PlanSpec, plan: InternalPlanState): void {
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
        
        // Check if this sub-plan is a leaf (nothing consumes from it)
        // If so, immediately merge to targetBranch - user gets value right away!
        const isLeaf = this.isLeafWorkUnit(spec, subPlanId);
        if (isLeaf && completedBranch) {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          const repoPath = spec.repoPath || ws;
          this.mergeLeafToTarget(spec, plan, subPlanId, completedBranch, repoPath);
        }
        
        // Check if this completion unblocks any jobs or other sub-plans
        // Use a synthetic job ID that represents the sub-plan completion
        this.queueReadyDependentsForSubPlan(spec, plan, subPlanId);
        
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
  private queueReadyDependentsForSubPlan(spec: PlanSpec, plan: InternalPlanState, completedSubPlanId: string): void {
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
  private handleJobSuccess(spec: PlanSpec, plan: InternalPlanState, jobId: string, runnerJob: Job): void {
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
    const isLeaf = this.isLeafWorkUnit(spec, jobId);
    if (isLeaf && !spec.isSubPlan) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const repoPath = spec.repoPath || ws;
      this.mergeLeafToTarget(spec, plan, jobId, completedBranch, repoPath);
    }
    
    // Check for jobs that depended on this one and are now ready
    this.queueReadyDependents(spec, plan, jobId);
  }
  
  /**
   * Check if a work unit is a leaf (nothing consumes from it).
   */
  private isLeafWorkUnit(spec: PlanSpec, workUnitId: string): boolean {
    // Check if any job consumes from this work unit
    for (const job of spec.jobs) {
      if (job.consumesFrom.includes(workUnitId)) {
        return false;
      }
    }
    // Check if any sub-plan consumes from this work unit
    for (const sp of spec.subPlans || []) {
      if (sp.consumesFrom.includes(workUnitId)) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Immediately merge a completed leaf job's branch to targetBranch.
   * This gives the user incremental value as work completes.
   */
  private mergeLeafToTarget(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    jobId: string, 
    completedBranch: string,
    repoPath: string
  ): void {
    const { execSync, spawnSync } = require('child_process');
    
    const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
    const planJob = spec.jobs.find(j => j.id === jobId);
    
    log.info(`Leaf job ${jobId} completed - merging immediately to ${targetBranch}`, {
      planId: spec.id,
      completedBranch
    });
    
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const prefer = mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs');
    
    try {
      // Checkout target branch
      execSync(`git checkout "${targetBranch}"`, { cwd: repoPath, stdio: 'pipe' });
      
      // Merge the leaf job's branch
      try {
        execSync(`git merge --no-edit "${completedBranch}" -m "Merge ${planJob?.name || jobId} from plan ${spec.name || spec.id}"`, { 
          cwd: repoPath, 
          stdio: 'pipe' 
        });
        log.info(`Leaf job ${jobId} merged to ${targetBranch} successfully`);
      } catch (mergeError: any) {
        // Merge conflict - use Copilot CLI to resolve
        log.info(`Merge conflict merging leaf ${jobId}, using Copilot CLI to resolve...`);
        
        const mergeInstruction = `@agent Resolve the current git merge conflict. ` +
          `We are merging branch '${completedBranch}' into '${targetBranch}'. ` +
          `Prefer '${prefer}' changes when there are conflicts. ` +
          `Complete the merge and commit with message 'orchestrator: merge ${planJob?.name || jobId} from plan ${spec.name || spec.id}'`;
        
        // Use string command with JSON.stringify to handle spaces in prompt
        const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
        const result = spawnSync(copilotCmd, [], {
          cwd: repoPath,
          shell: true,
          encoding: 'utf-8',
          timeout: 300000
        });
        
        if (result.status !== 0) {
          log.error(`Copilot CLI failed to resolve leaf merge conflict for ${jobId}`, { 
            exitCode: result.status
          });
          try {
            execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' });
          } catch {}
          return;
        }
        
        log.info(`Leaf job ${jobId} merge conflict resolved and merged to ${targetBranch}`);
      }
      
      // Push the updated target branch
      try {
        execSync(`git push origin "${targetBranch}"`, { cwd: repoPath, stdio: 'pipe' });
      } catch (pushError: any) {
        log.warn(`Failed to push after leaf merge: ${pushError.message}`);
      }
      
      // Track that this leaf has been merged - triggers Work Summary update
      plan.mergedLeaves.add(jobId);
      plan.riMergeCompleted = true;
      
      log.info(`Leaf ${jobId} merged and tracked for Work Summary`, {
        totalMerged: plan.mergedLeaves.size
      });
      
      // Clean up worktree/branch if enabled (default behavior)
      if (spec.cleanUpSuccessfulWork !== false) {
        this.cleanupWorkUnit(spec, plan, jobId, repoPath);
      }
      
    } catch (error: any) {
      log.error(`Failed to merge leaf job ${jobId} to ${targetBranch}`, { error: error.message });
    }
  }
  
  /**
   * Clean up worktree and branch for a successfully merged work unit.
   * Also recursively cleans up any upstream producers that have all their
   * consumers now cleaned up.
   */
  private cleanupWorkUnit(
    spec: PlanSpec,
    plan: InternalPlanState,
    workUnitId: string,
    repoPath: string,
    cleanedUp: Set<string> = new Set()
  ): void {
    // Avoid infinite recursion
    if (cleanedUp.has(workUnitId)) return;
    cleanedUp.add(workUnitId);
    
    const { execSync } = require('child_process');
    
    // Clean up the worktree
    const worktreePath = plan.worktreePaths.get(workUnitId);
    if (worktreePath && fs.existsSync(worktreePath)) {
      try {
        // Remove git worktree (this also removes the directory)
        execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' });
        plan.worktreePaths.delete(workUnitId);
        log.debug(`Cleaned up worktree for ${workUnitId}: ${worktreePath}`);
      } catch (e: any) {
        log.warn(`Failed to remove worktree for ${workUnitId}: ${e.message}`);
        // Try force delete the directory anyway
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
          plan.worktreePaths.delete(workUnitId);
        } catch {}
      }
    }
    
    // Clean up the branch (only the job-specific branch, not merge branches)
    const completedBranch = plan.completedBranches.get(workUnitId);
    if (completedBranch) {
      try {
        // Delete local branch
        execSync(`git branch -D "${completedBranch}"`, { cwd: repoPath, stdio: 'pipe' });
        log.debug(`Deleted local branch for ${workUnitId}: ${completedBranch}`);
      } catch (e: any) {
        log.debug(`Failed to delete local branch ${completedBranch}: ${e.message}`);
      }
      
      try {
        // Delete remote branch
        execSync(`git push origin --delete "${completedBranch}"`, { cwd: repoPath, stdio: 'pipe' });
        log.debug(`Deleted remote branch for ${workUnitId}: ${completedBranch}`);
      } catch (e: any) {
        log.debug(`Failed to delete remote branch ${completedBranch}: ${e.message}`);
      }
      
      plan.completedBranches.delete(workUnitId);
    }
    
    log.info(`Cleaned up work unit ${workUnitId}`, {
      worktree: !!worktreePath,
      branch: !!completedBranch
    });
    
    // Now check if any upstream producers can be cleaned up
    // A producer can be cleaned up if ALL its consumers have been cleaned up
    const job = spec.jobs.find(j => j.id === workUnitId);
    if (job) {
      for (const producerId of job.consumesFrom) {
        if (this.canCleanupProducer(spec, plan, producerId, cleanedUp)) {
          this.cleanupWorkUnit(spec, plan, producerId, repoPath, cleanedUp);
        }
      }
    }
    
    // Also check sub-plan producers
    const subPlan = spec.subPlans?.find(sp => sp.id === workUnitId);
    if (subPlan) {
      for (const producerId of subPlan.consumesFrom) {
        if (this.canCleanupProducer(spec, plan, producerId, cleanedUp)) {
          this.cleanupWorkUnit(spec, plan, producerId, repoPath, cleanedUp);
        }
      }
    }
    
    this.persist();
  }
  
  /**
   * Check if a producer can be cleaned up.
   * A producer can only be cleaned up if ALL consumers that depend on it
   * have been merged and cleaned up.
   */
  private canCleanupProducer(
    spec: PlanSpec,
    plan: InternalPlanState,
    producerId: string,
    cleanedUp: Set<string>
  ): boolean {
    // Don't cleanup if already cleaned or not merged
    if (cleanedUp.has(producerId)) return false;
    if (!plan.mergedLeaves.has(producerId) && !plan.done.includes(producerId)) {
      // Producer hasn't finished yet
      return false;
    }
    
    // Find all consumers of this producer
    const consumers: string[] = [];
    for (const job of spec.jobs) {
      if (job.consumesFrom.includes(producerId)) {
        consumers.push(job.id);
      }
    }
    for (const sp of spec.subPlans || []) {
      if (sp.consumesFrom.includes(producerId)) {
        consumers.push(sp.id);
      }
    }
    
    // Producer can be cleaned up if ALL consumers have been cleaned up
    return consumers.every(consumerId => 
      cleanedUp.has(consumerId) || 
      // A consumer counts as "cleaned up" if it was merged (for leaves)
      // and we're currently cleaning it up in this call chain
      plan.mergedLeaves.has(consumerId)
    );
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
  private queueReadyDependents(spec: PlanSpec, plan: InternalPlanState, completedJobId: string): void {
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
          this.launchSubPlan(spec, plan, subPlanSpec, repoPath);
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
  private launchSubPlan(
    parentSpec: PlanSpec, 
    parentState: InternalPlanState, 
    subPlanSpec: SubPlanSpec,
    repoPath: string
  ): void {
    const { execSync } = require('child_process');
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
      // First, ensure we're not on the source branch (might be in a worktree)
      try {
        execSync(`git branch -D "${integrationBranchName}"`, { cwd: repoPath, stdio: 'pipe' });
      } catch (e) {
        // Branch doesn't exist, that's fine
      }
      
      execSync(`git branch "${integrationBranchName}" "${sourceBranch}"`, { cwd: repoPath, stdio: 'pipe' });
      execSync(`git push origin "${integrationBranchName}"`, { cwd: repoPath, stdio: 'pipe' });
      
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
      }
    } else if (finishedJobs + finishedSubPlans < totalJobs + totalSubPlans && 
               plan.queued.length === 0 && plan.running.length === 0 && 
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
   * 
   * Note: With incremental leaf merging, leaves auto-merge when they complete.
   * This is now just a fallback/cleanup that runs on plan completion.
   */
  private performFinalMerge(spec: PlanSpec, plan: InternalPlanState, repoPath: string): void {
    const { execSync, spawnSync } = require('child_process');
    
    const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
    
    // Find "leaf" jobs - jobs that no other job or sub-plan consumes from
    const allConsumedFrom = new Set<string>();
    for (const job of spec.jobs) {
      job.consumesFrom.forEach(source => allConsumedFrom.add(source));
    }
    // Also include sub-plan consumesFrom
    for (const sp of spec.subPlans || []) {
      sp.consumesFrom.forEach(source => allConsumedFrom.add(source));
    }
    
    const allLeafIds = new Set(
      spec.jobs.filter(j => !allConsumedFrom.has(j.id) && plan.done.includes(j.id)).map(j => j.id)
    );
    
    // Check which leaves haven't been merged yet (should be none with incremental merging)
    const unmgergedLeaves = [...allLeafIds].filter(id => !plan.mergedLeaves.has(id));
    
    if (unmgergedLeaves.length === 0) {
      log.info(`Plan ${spec.id}: All ${allLeafIds.size} leaves already merged incrementally`);
      plan.riMergeCompleted = true;
      // Clean up integration branches (sub-plan integration branches)
      this.cleanupIntegrationBranches(plan, repoPath);
      return;
    }
    
    // Fallback: merge any leaves that weren't merged incrementally (shouldn't happen normally)
    log.warn(`Plan ${spec.id}: ${unmgergedLeaves.length} leaves need fallback merge`, {
      unmerged: unmgergedLeaves,
      alreadyMerged: [...plan.mergedLeaves]
    });
    
    // Load merge configuration
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const prefer = mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs');
    
    try {
      // Checkout target branch
      execSync(`git checkout "${targetBranch}"`, { cwd: repoPath, stdio: 'pipe' });
      
      // Merge each unmerged leaf job's branch
      for (const leafJobId of unmgergedLeaves) {
        const leafJob = spec.jobs.find(j => j.id === leafJobId);
        const leafBranch = plan.completedBranches.get(leafJobId);
        if (!leafBranch || !leafJob) continue;
        
        log.info(`Fallback merging ${leafBranch} into ${targetBranch}`);
        try {
          execSync(`git merge --no-edit "${leafBranch}" -m "Merge ${leafJob.name || leafJob.id} from plan ${spec.name || spec.id}"`, { 
            cwd: repoPath, 
            stdio: 'pipe' 
          });
          // Track this as merged
          plan.mergedLeaves.add(leafJobId);
        } catch (mergeError: any) {
          // Merge conflict - use Copilot CLI to resolve
          log.info(`Merge conflict merging ${leafBranch}, using Copilot CLI to resolve...`);
          
          const mergeInstruction = `@agent Resolve the current git merge conflict. ` +
            `We are merging branch '${leafBranch}' into '${targetBranch}'. ` +
            `Prefer '${prefer}' changes when there are conflicts. ` +
            `Complete the merge and commit with message 'orchestrator: merge ${leafJob.name || leafJob.id} from plan ${spec.name || spec.id}'`;
          
          // Use string command with JSON.stringify to handle spaces in prompt
          const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
          const result = spawnSync(copilotCmd, [], {
            cwd: repoPath,
            shell: true,
            encoding: 'utf-8',
            timeout: 300000 // 5 minute timeout
          });
          
          if (result.status !== 0) {
            log.error(`Copilot CLI failed to resolve RI merge conflict`, { 
              exitCode: result.status,
              leafBranch,
              targetBranch
            });
            try {
              execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' });
            } catch {}
            plan.error = `RI merge failed: conflict merging ${leafBranch}`;
            return;
          }
          
          log.info(`Copilot CLI resolved RI merge conflict for ${leafBranch}`);
          // Track this as merged
          plan.mergedLeaves.add(leafJobId);
        }
      }
      
      // Push the updated target branch
      try {
        execSync(`git push origin "${targetBranch}"`, { cwd: repoPath, stdio: 'pipe' });
        log.info(`Plan ${spec.id}: RI merge completed and pushed to ${targetBranch}`);
      } catch (pushError: any) {
        log.warn(`Failed to push ${targetBranch}: ${pushError.message}`);
      }
      
      // Mark RI merge as successful
      plan.riMergeCompleted = true;
      
      // Clean up integration branches now that RI is complete
      this.cleanupIntegrationBranches(plan, repoPath);
      
    } catch (error: any) {
      log.error(`Plan ${spec.id}: Final RI merge failed`, { error: error.message });
      plan.error = `RI merge failed: ${error.message}`;
      // Don't change status to partial for checkout errors - these are usually
      // transient worktree issues and all jobs actually succeeded
      // The error is still recorded and visible to the user
      plan.riMergeCompleted = false;
    }
  }

  /**
   * Clean up integration branches created for sub-plans.
   * Note: With the consumesFrom model, regular jobs no longer create separate merge branches.
   * This only cleans up sub-plan integration branches.
   */
  private cleanupIntegrationBranches(plan: InternalPlanState, repoPath: string): void {
    const { execSync } = require('child_process');
    
    if (!plan.subPlanIntegrationBranches || plan.subPlanIntegrationBranches.size === 0) {
      return;
    }
    
    log.info(`Cleaning up ${plan.subPlanIntegrationBranches.size} integration branches`, {
      planId: plan.id
    });
    
    for (const [subPlanId, integrationBranch] of plan.subPlanIntegrationBranches) {
      try {
        // Delete local branch
        execSync(`git branch -D "${integrationBranch}"`, { cwd: repoPath, stdio: 'pipe' });
        log.debug(`Deleted local integration branch: ${integrationBranch}`);
      } catch (e: any) {
        log.debug(`Failed to delete local branch ${integrationBranch}: ${e.message}`);
      }
      
      try {
        // Delete remote branch
        execSync(`git push origin --delete "${integrationBranch}"`, { cwd: repoPath, stdio: 'pipe' });
        log.debug(`Deleted remote integration branch: ${integrationBranch}`);
      } catch (e: any) {
        log.debug(`Failed to delete remote branch ${integrationBranch}: ${e.message}`);
      }
    }
    
    plan.subPlanIntegrationBranches.clear();
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
      
      // Clean up worktree root if it exists
      const worktreeRoot = spec.worktreeRoot || path.join(repoPath, '.worktrees', id);
      if (fs.existsSync(worktreeRoot)) {
        log.debug(`Cleaning up worktree root: ${worktreeRoot}`);
        try {
          fs.rmSync(worktreeRoot, { recursive: true, force: true });
        } catch (e: any) {
          log.warn(`Failed to clean up worktree root: ${e.message}`);
        }
      }
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
