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

    // Normalize persisted specs/state so UI + DAG logic stays consistent across reloads.
    // This is intentionally forgiving: older persisted shapes may have missing names
    // or may have stored sub-plan/job keys by id rather than name.
    this.normalizeLoadedData();
    
    if (plans.size > 0) {
      log.info('Plans loaded from disk', { 
        planCount: plans.size,
        specCount: specs.size
      });
      
      // Resume any plans that were running
      this.resumeIncompletePlans();
    }
  }

  private normalizeLoadedData(): void {
    if (!this.specs || this.specs.size === 0) return;

    // First normalize specs in-place (migrates legacy data to have producerId)
    for (const [planId, spec] of this.specs.entries()) {
      this.normalizeSpecInPlace(spec as any);
    }

    // Then migrate internal state keys/arrays to use producerId
    for (const [planId, plan] of this.plans.entries()) {
      const spec = this.specs.get(planId);
      if (!spec) continue;
      this.migrateInternalStateKeysInPlace(plan, spec as any);
    }
  }

  /**
   * Normalize a spec in-place, ensuring UUIDs for id, and migrating legacy data.
   * 
   * Lookup Key Strategy:
   * - producerId: The canonical DAG reference key (required for new plans, migrated for legacy)
   * - id: Always a UUID for internal use (worktrees, branches)
   * - name: Human-friendly display name (defaults to producerId)
   * 
   * For legacy persisted data without producerId:
   * - If `name` exists, derive producerId from it (sanitized to valid format)
   * - Otherwise, use the UUID id as producerId
   * This allows the extension to load and display legacy plans so users can clean them up.
   */
  private normalizeSpecInPlace(spec: any): Map<string, string> {
    // Map from producerId -> producerId (identity map, kept for interface consistency)
    const producerIdMap = new Map<string, string>();

    if (!spec) return producerIdMap;

    // Plan name is user-friendly; keep id as the stable UUID.
    if (typeof spec.name !== 'string' || spec.name.trim() === '') {
      spec.name = String(spec.id || 'Plan');
    }
    if (!spec.id) {
      spec.id = randomUUID();
    }

    /**
     * Derive a valid producerId from a legacy name or id.
     * Sanitizes to match the required format: [a-z0-9-]{5,64}
     */
    const deriveProducerId = (name: string | undefined, id: string): string => {
      const source = (typeof name === 'string' && name.trim()) ? name : id;
      // Sanitize: lowercase, replace invalid chars with hyphen, trim to 64 chars
      let sanitized = source.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      // Ensure minimum length of 5
      if (sanitized.length < 5) {
        sanitized = sanitized + '-' + id.slice(0, 8);
      }
      // Truncate to max 64 chars
      return sanitized.slice(0, 64);
    };

    const allJobs: any[] = Array.isArray(spec.jobs) ? spec.jobs : [];

    // Ensure each job has UUID id, producerId, and name
    for (const job of allJobs) {
      if (!job) continue;
      
      // Ensure UUID for id
      if (!job.id) {
        job.id = randomUUID();
      }
      
      // Migrate legacy data: derive producerId if missing
      if (!job.producerId || typeof job.producerId !== 'string') {
        job.producerId = deriveProducerId(job.name, job.id);
        log.debug(`Migrated legacy job: derived producerId '${job.producerId}' from name/id`);
      }
      
      // Default name to producerId
      if (typeof job.name !== 'string' || job.name.trim() === '') {
        job.name = job.producerId;
      }
      
      // Record the producerId (identity mapping)
      producerIdMap.set(job.producerId, job.producerId);
    }

    const normalizeSubPlans = (subPlans: any[] | undefined): void => {
      if (!Array.isArray(subPlans)) return;
      for (const sp of subPlans) {
        if (!sp) continue;

        // Ensure UUID for id
        if (!sp.id) sp.id = randomUUID();
        
        // Migrate legacy data: derive producerId if missing
        if (!sp.producerId || typeof sp.producerId !== 'string') {
          sp.producerId = deriveProducerId(sp.name, sp.id);
          log.debug(`Migrated legacy sub-plan: derived producerId '${sp.producerId}' from name/id`);
        }

        // Default name to producerId
        if (typeof sp.name !== 'string' || sp.name.trim() === '') {
          sp.name = sp.producerId;
        }

        // Record the producerId
        producerIdMap.set(sp.producerId, sp.producerId);

        // Normalize jobs within the sub-plan
        if (Array.isArray(sp.jobs)) {
          for (const job of sp.jobs) {
            if (!job) continue;
            if (!job.id) job.id = randomUUID();
            
            // Migrate legacy data
            if (!job.producerId || typeof job.producerId !== 'string') {
              job.producerId = deriveProducerId(job.name, job.id);
              log.debug(`Migrated legacy sub-plan job: derived producerId '${job.producerId}'`);
            }
            
            if (typeof job.name !== 'string' || job.name.trim() === '') {
              job.name = job.producerId;
            }
            
            // Sub-plan job producerIds are scoped to the sub-plan
            // (not added to plan-level map)
          }
        }

        // Recurse into nested sub-plans
        normalizeSubPlans(sp.subPlans);
      }
    };

    normalizeSubPlans(spec.subPlans);

    return producerIdMap;
  }

  /**
   * Migrate internal state keys to use producerId.
   * 
   * Legacy state may be keyed by name or UUID. This function builds a mapping
   * from old keys to new producerId keys and updates all state arrays/maps.
   */
  private migrateInternalStateKeysInPlace(plan: InternalPlanState, spec: any): void {
    // Build a map from any old key (name, id) to the new producerId
    const oldKeyToProducerId = new Map<string, string>();
    
    const allJobs: any[] = Array.isArray(spec?.jobs) ? spec.jobs : [];
    for (const job of allJobs) {
      if (!job || !job.producerId) continue;
      // Map old keys (name, id) to the new producerId
      if (job.name && job.name !== job.producerId) {
        oldKeyToProducerId.set(job.name, job.producerId);
      }
      if (job.id && job.id !== job.producerId) {
        oldKeyToProducerId.set(job.id, job.producerId);
      }
      // Identity mapping
      oldKeyToProducerId.set(job.producerId, job.producerId);
    }
    
    // Also handle sub-plans
    const processSubPlans = (subPlans: any[] | undefined): void => {
      if (!Array.isArray(subPlans)) return;
      for (const sp of subPlans) {
        if (!sp || !sp.producerId) continue;
        if (sp.name && sp.name !== sp.producerId) {
          oldKeyToProducerId.set(sp.name, sp.producerId);
        }
        if (sp.id && sp.id !== sp.producerId) {
          oldKeyToProducerId.set(sp.id, sp.producerId);
        }
        oldKeyToProducerId.set(sp.producerId, sp.producerId);
        processSubPlans(sp.subPlans);
      }
    };
    processSubPlans(spec?.subPlans);
    
    // Helper functions
    const remap = (value: string): string => oldKeyToProducerId.get(value) || value;
    const remapArray = (arr: string[] | undefined): string[] =>
      (arr || []).map(remap);
    const remapSet = (set: Set<string> | undefined): Set<string> =>
      new Set(Array.from(set || []).map(remap));
    const remapMapKeys = <T>(m: Map<string, T> | undefined): Map<string, T> => {
      const out = new Map<string, T>();
      for (const [k, v] of (m || new Map<string, T>()).entries()) {
        const nk = remap(k);
        if (!out.has(nk)) out.set(nk, v);
      }
      return out;
    };

    // Migrate state arrays
    plan.queued = remapArray(plan.queued);
    plan.preparing = remapArray(plan.preparing);
    plan.running = remapArray(plan.running);
    plan.done = remapArray(plan.done);
    plan.failed = remapArray(plan.failed);
    plan.canceled = remapArray(plan.canceled);
    plan.submitted = remapArray(plan.submitted);

    // Migrate state maps
    plan.jobIdMap = remapMapKeys(plan.jobIdMap);
    plan.completedCommits = remapMapKeys(plan.completedCommits);
    plan.baseCommits = remapMapKeys(plan.baseCommits);
    plan.worktreePaths = remapMapKeys(plan.worktreePaths);
    plan.worktreePromises = remapMapKeys(plan.worktreePromises);
    plan.worktreeResults = remapMapKeys(plan.worktreeResults);

    // Migrate sub-plan tracking
    plan.pendingSubPlans = remapSet(plan.pendingSubPlans);
    plan.runningSubPlans = remapMapKeys(plan.runningSubPlans);
    plan.completedSubPlans = remapMapKeys(plan.completedSubPlans);
    plan.failedSubPlans = remapMapKeys(plan.failedSubPlans);

    plan.mergedLeaves = remapSet(plan.mergedLeaves);
    plan.cleanedWorkUnits = remapSet(plan.cleanedWorkUnits);
  }

  /**
   * Resume plans that were in progress when extension was unloaded.
   */
  private resumeIncompletePlans(): void {
    let resumed = 0;
    for (const [id, plan] of this.plans) {
      // Only resume plans that were actively running
      if (plan.status === 'running' || plan.status === 'queued') {
        // Check if there's work to do (jobs OR sub-plans)
        const hasJobWork = plan.queued.length > 0 || plan.running.length > 0 || plan.preparing.length > 0;
        const hasSubPlanWork = (plan.runningSubPlans?.size || 0) > 0 || (plan.pendingSubPlans?.size || 0) > 0;
        if (hasJobWork || hasSubPlanWork) {
          log.info(`Resuming plan: ${id}`, {
            status: plan.status,
            queued: plan.queued.length,
            running: plan.running.length,
            preparing: plan.preparing.length,
            runningSubPlans: plan.runningSubPlans?.size || 0,
            pendingSubPlans: plan.pendingSubPlans?.size || 0
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
   * @param jobName - Job name (user-friendly identifier used for state tracking)
   */
  private appendJobWorkSummary(
    plan: InternalPlanState, 
    jobName: string
  ): void {
    const runnerJobId = plan.jobIdMap.get(jobName);
    if (!runnerJobId) {
      log.warn(`Cannot append work summary: no runner job ID for job ${jobName}`, { planId: plan.id });
      return;
    }
    
    const job = this.runner.list().find(j => j.id === runnerJobId);
    if (!job) {
      log.warn(`Cannot append work summary: job ${runnerJobId} not found in runner`, { planId: plan.id, jobName });
      return;
    }
    if (!job.workSummary) {
      log.warn(`Cannot append work summary: job ${runnerJobId} has no workSummary`, { planId: plan.id, jobName, jobStatus: job.status });
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
      jobId: jobName,  // jobName is the user-friendly identifier for state tracking
      jobName: jobName,
      commits: ws.commits || 0,
      filesAdded: ws.filesAdded || 0,
      filesModified: ws.filesModified || 0,
      filesDeleted: ws.filesDeleted || 0,
      description: ws.description || '',
      commitDetails: ws.commitDetails
    });
    
    log.debug(`Appended work summary for job ${jobName}`, {
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
   * Get the canonical key for a job or sub-plan.
   * Uses producerId if available, otherwise falls back to name.
   */
  private getProducerId(unit: { producerId?: string; name: string }): string {
    return unit.producerId || unit.name;
  }

  /**
   * Find a job by its canonical key (producerId or name).
   */
  private findJobByProducerId(spec: PlanSpec, key: string): PlanJob | undefined {
    return spec.jobs.find(j => (j.producerId || j.name) === key);
  }

  /**
   * Find a sub-plan by its canonical key (producerId or name).
   */
  private findSubPlanByProducerId(spec: PlanSpec, key: string): SubPlanSpec | undefined {
    if (!spec.subPlans) return undefined;
    return spec.subPlans.find(sp => (sp.producerId || sp.name) === key);
  }
  
  /**
   * Recursively assign UUIDs to sub-plans that don't have them.
   */
  private assignSubPlanIds(subPlans?: SubPlanSpec[]): void {
    if (!subPlans) return;
    
    for (const sp of subPlans) {
      if (!sp.id) {
        sp.id = randomUUID();
      }
      // Recurse into nested sub-plans
      this.assignSubPlanIds(sp.subPlans);
    }
  }

  /**
   * Enqueue a new plan for execution.
   */
  enqueue(spec: PlanSpec): void {
    // Generate UUID for plan if not provided
    if (!spec.id) {
      spec.id = randomUUID();
    }
    const id = spec.id;
    
    log.info(`Enqueueing plan: ${spec.name}`, { 
      id,
      jobCount: spec.jobs.length,
      baseBranch: spec.baseBranch,
      maxParallel: spec.maxParallel
    });
    
    // Ensure unique worktree root for this plan (use id which is UUID)
    if (!spec.worktreeRoot) {
      spec.worktreeRoot = `.worktrees/${id}`;
    }
    
    // Default base branch
    if (!spec.baseBranch) {
      spec.baseBranch = 'main';
    }
    
    // Assign UUIDs to all sub-plans (recursive)
    this.assignSubPlanIds(spec.subPlans);
    
    // Assign UUIDs to all jobs that don't have them
    // Job.id is the UUID, job.name is user-friendly
    for (const job of spec.jobs) {
      if (!job.id) {
        job.id = randomUUID();
      }
      // Use plan id and job id (both UUIDs) for branch naming
      if (!job.inputs.targetBranch) {
        job.inputs.targetBranch = `copilot_jobs/${id}/${job.id}`;
      }
      // Pre-compute nestedPlanId if this job has a nested plan
      if (job.plan && !job.nestedPlanId) {
        job.nestedPlanId = `${id}/${job.name}-${randomUUID().substring(0, 8)}`;
      }
    }
    
    log.debug(`Pre-computed job IDs for plan ${spec.name} (${id}):`);
    for (const job of spec.jobs) {
      log.debug(`  ${job.name} -> ${job.id} (target: ${job.inputs.targetBranch})${job.nestedPlanId ? ` [nested: ${job.nestedPlanId}]` : ''}`);
    }
    
    // Store spec for later reference
    this.specs.set(id, spec);
    
    // Initialize plan state
    // Note: All state arrays (queued, running, etc.) are indexed by canonical key.
    // Canonical key = producerId (if set) or name (fallback for legacy).
    // consumesFrom references are resolved to canonical keys during normalization.
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
      jobIdMap: new Map(),  // Maps canonical key -> job.id (UUID)
      completedCommits: new Map(),
      baseCommits: new Map(),
      worktreePaths: new Map(),
      worktreePromises: new Map(),
      worktreeResults: new Map(),
      // Sub-plan tracking (keyed by canonical key)
      pendingSubPlans: new Set(spec.subPlans?.map(sp => this.getProducerId(sp)) || []),
      runningSubPlans: new Map(),
      completedSubPlans: new Map(),
      failedSubPlans: new Map(),
      // Incremental delivery tracking
      mergedLeaves: new Set(),
      cleanedWorkUnits: new Set()
    };
    
    // Queue jobs with no consumesFrom (roots of the DAG)
    // Use canonical key (producerId or name) for state tracking
    const rootJobs = spec.jobs.filter(j => j.consumesFrom.length === 0);
    state.queued = rootJobs.map(j => this.getProducerId(j));
    
    log.debug(`Plan ${spec.name} (${id}) initialized`, {
      rootJobs: rootJobs.map(j => this.getProducerId(j)),
      worktreeRoot: spec.worktreeRoot,
      baseBranch: spec.baseBranch,
      subPlanCount: spec.subPlans?.length || 0
    });
    
    // Log the DAG structure
    for (const job of spec.jobs) {
      log.debug(`  Job ${job.name} (${job.id})`, {
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
   * Re-queues failed jobs for execution and retries failed sub-plans.
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
      failedSubPlans: Array.from(plan.failedSubPlans || []),
      previousStatus: plan.status
    });
    
    // First, retry any failed sub-plans (so their jobs get re-queued)
    const failedSubPlanKeys = Array.from(plan.failedSubPlans?.keys() || []);
    for (const spKey of failedSubPlanKeys) {
      // Get the child plan ID directly from the Map
      const childPlanId = plan.failedSubPlans.get(spKey);
      if (childPlanId) {
        // Recursively retry the sub-plan
        const retried = this.retry(childPlanId);
        if (retried) {
          // Move from failed back to running
          plan.failedSubPlans.delete(spKey);
          plan.runningSubPlans.set(spKey, childPlanId);
          log.info(`Sub-plan ${spKey} retry initiated, child plan: ${childPlanId}`);
        }
      } else {
        // No child plan ID stored (sub-plan was blocked, never launched) - move back to pending
        plan.failedSubPlans.delete(spKey);
        plan.pendingSubPlans.add(spKey);
        log.info(`Sub-plan ${spKey} moved to pending for re-launch`);
      }
    }
    
    // Re-queue failed jobs
    const failedJobs = [...plan.failed];
    plan.failed = [];
    
    // Move failed jobs back to queued if their dependencies are satisfied
    for (const jobKey of failedJobs) {
      // Find job by canonical key (state arrays use canonical keys)
      const planJob = this.findJobByProducerId(spec, jobKey);
      if (!planJob) continue;
      
      // Check if consumesFrom sources are satisfied (consumesFrom uses canonical keys)
      // Note: for sub-plan deps, we now need to check if sub-plan is running (being retried) or completed
      const depsOk = planJob.consumesFrom.every(depKey => 
        plan.done.includes(depKey) || 
        plan.completedSubPlans?.has(depKey) ||
        plan.runningSubPlans?.has(depKey)  // Sub-plan being retried
      );
      
      if (depsOk) {
        plan.queued.push(jobKey);
        // Remove from submitted so it can be scheduled again
        plan.submitted = plan.submitted.filter(j => j !== jobKey);
        log.debug(`Job ${jobKey} re-queued for retry`);
      } else {
        // Can't retry this job yet - its sources not satisfied
        // Leave it in a limbo state - it will be picked up when deps complete
        plan.queued.push(jobKey);
        log.debug(`Job ${jobKey} queued - waiting for dependencies to complete`);
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
    
    log.info(`Plan ${id} retry started`, { 
      requeuedJobs: plan.queued.length,
      retriedSubPlans: failedSubPlanKeys.length
    });
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
        const { targetBranchRoot, needsCreation } = await git.orchestrator.resolveTargetBranchRoot(
          baseBranch,
          repoPath,
          `copilot_jobs/${spec.id}`
        );
        timings['resolveTargetBranchRoot'] = Date.now() - stepStart;
        
        if (needsCreation) {
          stepStart = Date.now();
          log.info(`Plan ${spec.name}: baseBranch '${baseBranch}' is a default branch, creating feature branch`);
          await git.branches.create(targetBranchRoot, baseBranch, repoPath, s => log.debug(s));
          plan.targetBranchRootCreated = true;
          timings['createBranch'] = Date.now() - stepStart;
        } else {
          log.info(`Plan ${spec.name}: using non-default baseBranch '${baseBranch}' as targetBranchRoot`);
          plan.targetBranchRootCreated = false;
        }
        
        plan.targetBranchRoot = targetBranchRoot;
        log.info(`Plan ${spec.name}: targetBranchRoot = ${targetBranchRoot}`);
      }

      // Sub-plans should merge into their OWN integration branch (spec.targetBranch),
      // not directly into the parent's target branch. Ensure that branch exists.
      stepStart = Date.now();
      await this.ensurePlanTargetBranchExists(spec, plan, repoPath);
      timings['ensurePlanTargetBranchExists'] = Date.now() - stepStart;
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

      // Launch any sub-plans that are now ready (important after reload)
      stepStart = Date.now();
      await this.launchReadySubPlans(spec, plan, repoPath);
      timings['launchReadySubPlans'] = Date.now() - stepStart;
      
      // Check status of running sub-plans
      stepStart = Date.now();
      await this.updateSubPlanStatuses(spec, plan, repoPath);
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
   * Ensure that a plan's merge target branch exists.
   *
   * For top-level plans, targetBranch is typically user-provided and exists already.
   * For sub-plans, we create an integration branch (e.g. copilot_subplans/<id>)
   * so the sub-plan can merge its own leaf outputs without touching the parent branch.
   */
  private async ensurePlanTargetBranchExists(spec: PlanSpec, plan: InternalPlanState, repoPath: string): Promise<void> {
    if (!spec.isSubPlan) return;
    const targetBranch = spec.targetBranch;
    if (!targetBranch) return;

    try {
      const exists = await git.branches.exists(targetBranch, repoPath);
      if (exists) return;

      const fromRef = spec.baseBranch || plan.targetBranchRoot || 'main';
      log.info(`Creating sub-plan integration branch ${targetBranch}`, {
        planId: spec.id,
        fromRef
      });
      await git.branches.create(targetBranch, fromRef, repoPath, s => log.debug(s));
    } catch (e: any) {
      log.warn(`Failed to ensure plan targetBranch exists`, {
        planId: spec.id,
        targetBranch,
        error: e?.message
      });
    }
  }

  /**
   * Start worktree preparation for a job (fire-and-forget).
   * 
   * This kicks off worktree creation asynchronously and stores a Promise
   * in plan.worktreePromises. The pump will check these promises on subsequent
   * cycles and submit jobs to the runner once their worktrees are ready.
   * 
   * Note: jobKey is the canonical key (producerId or name) used for DAG tracking.
   * job.id is the UUID used for worktree paths and branch naming.
   */
  private startWorktreePreparation(spec: PlanSpec, plan: InternalPlanState, jobKey: string, repoPath: string): void {
    const planJob = this.findJobByProducerId(spec, jobKey);
    if (!planJob) {
      log.error(`Job ${jobKey} not found in plan spec`);
      return;
    }

    // Move to preparing state
    plan.preparing.push(jobKey);
    
    // Compute base commit/branch for worktree (can be a branch name or commit SHA)
    const { baseBranch: baseCommitish, additionalSources } = this.computeBaseBranch(spec, plan, planJob, repoPath);
    const jobId = planJob.id;  // UUID for worktree path
    
    // Map canonical key to job id (UUID)
    plan.jobIdMap.set(jobKey, jobId);
    
    const wtRootAbs = path.join(repoPath, spec.worktreeRoot || '.worktrees');
    const worktreePath = path.join(wtRootAbs, jobId);
    
    log.debug(`Starting async worktree preparation for job ${planJob.name} (key=${jobKey}, id=${jobId})`);
    
    // Fire-and-forget worktree creation - store the promise for later checking
    // Uses detached HEAD mode - no branches created
    const worktreePromise = this.prepareWorktreeAsync(
      spec, plan, planJob, jobKey, repoPath, worktreePath, baseCommitish, additionalSources
    );
    
    plan.worktreePromises.set(jobKey, worktreePromise);
  }

  /**
   * Async worktree creation - runs in background without blocking the pump.
   * Sets result in plan.worktreeResults when complete (for non-blocking check).
   * 
   * Uses detached HEAD mode - no branches created. Commits are tracked by SHA.
   * 
   * @param jobKey - Canonical key (producerId or name) used for state tracking
   */
  private async prepareWorktreeAsync(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    planJob: PlanJob, 
    jobName: string, 
    repoPath: string, 
    worktreePath: string, 
    baseCommitish: string, 
    additionalSources: string[]
  ): Promise<boolean> {
    try {
      log.debug(`Creating detached worktree for job ${jobName} at ${worktreePath} from ${baseCommitish}`);
      
      // Create detached worktree (no branch) - returns base commit SHA
      const timing = await git.worktrees.createDetachedWithTiming(
        repoPath,
        worktreePath,
        baseCommitish,
        s => log.debug(s)
      );
      
      if (timing.totalMs > 500) {
        log.warn(`Slow worktree creation for ${jobName} took ${timing.totalMs}ms (worktree: ${timing.worktreeMs}ms, submodules: ${timing.submoduleMs}ms)`);
      }
      
      // Track worktree path and base commit for cleanup/merge (keyed by name)
      plan.worktreePaths.set(jobName, worktreePath);
      plan.baseCommits.set(jobName, timing.baseCommit);
      
      log.info(`Created detached worktree for job ${jobName}: ${worktreePath} (base: ${timing.baseCommit.slice(0, 8)})`);
      
      // If job has multiple sources, merge the additional sources (by commit SHA)
      if (additionalSources.length > 0) {
        const mergeSuccess = await this.mergeSourcesIntoWorktree(planJob, worktreePath, additionalSources);
        if (!mergeSuccess) {
          log.error(`Failed to merge sources into worktree for job ${jobName}`);
          // Set result for non-blocking check
          plan.worktreeResults.set(jobName, { success: false, error: 'Failed to merge sources' });
          return false;
        }
      }
      
      // Set result for non-blocking check
      plan.worktreeResults.set(jobName, { success: true });
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to create worktree for job ${jobName}: ${errorMsg}`);
      // Set result for non-blocking check
      plan.worktreeResults.set(jobName, { success: false, error: errorMsg });
      return false;
    }
  }

  /**
   * Check preparing jobs and submit them to runner once their worktrees are ready.
   * Uses a settled flag approach to check completion without blocking.
   * 
   * Note: jobName is used for state tracking (keyed by user-friendly name).
   */
  private async checkPreparingJobs(spec: PlanSpec, plan: InternalPlanState, repoPath: string): Promise<void> {
    if (plan.preparing.length === 0) return;
    
    const jobsToSubmit: string[] = [];
    const jobsFailed: string[] = [];
    
    // Check each preparing job's settled flag - TRUE non-blocking
    // Note: State arrays use job.name for DAG compatibility
    for (const jobName of [...plan.preparing]) {
      const result = plan.worktreeResults.get(jobName);
      
      // If no result yet, worktree is still being created - skip
      if (result === undefined) {
        continue;
      }
      
      // Result is set - worktree creation completed (or failed)
      plan.worktreeResults.delete(jobName);
      
      if (result.success) {
        jobsToSubmit.push(jobName);
        log.debug(`Worktree ready for job ${jobName}`);
      } else {
        jobsFailed.push(jobName);
        log.warn(`Worktree creation failed for job ${jobName}: ${result.error}`);
      }
    }
    
    // Submit ready jobs to runner
    const submitStart = Date.now();
    for (const jobName of jobsToSubmit) {
      plan.preparing = plan.preparing.filter(n => n !== jobName);
      await this.submitJobToRunner(spec, plan, jobName, repoPath);
    }
    const submitTime = Date.now() - submitStart;
    if (submitTime > 50) {
      log.warn(`checkPreparingJobs: submitting ${jobsToSubmit.length} jobs took ${submitTime}ms`);
    }
    
    // Mark failed jobs
    for (const jobName of jobsFailed) {
      plan.preparing = plan.preparing.filter(n => n !== jobName);
      plan.failed.push(jobName);
      this.publicStateCacheValid = false;
    }
  }

  /**
   * Submit a job to the runner (worktree already created).
   * 
   * @param jobKey - Canonical key (producerId or name) used for state tracking
   */
  private async submitJobToRunner(spec: PlanSpec, plan: InternalPlanState, jobKey: string, repoPath: string): Promise<void> {
    const planJob = this.findJobByProducerId(spec, jobKey);
    if (!planJob) {
      log.error(`Job ${jobKey} not found in plan spec`);
      return;
    }
    
    const { baseBranch } = this.computeBaseBranch(spec, plan, planJob, repoPath);
    const jobId = planJob.id;  // UUID for runner
    const targetBranch = planJob.inputs.targetBranch!;
    const worktreePath = plan.worktreePaths.get(jobKey)!;
    
    log.info(`Submitting job: ${planJob.name} (key=${jobKey})`, {
      planId: spec.id,
      jobId,
      baseBranch,
      targetBranch,
      worktreePath
    });
    
    // Create job spec for the runner - marked as plan-managed
    // Note: JobRunner uses job.id as UUID, job.name for display
    const jobSpec: JobSpec = {
      id: jobId,
      name: planJob.name,
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
    
    // Update plan state (using jobKey for state tracking)
    plan.submitted.push(jobKey);
    plan.running.push(jobKey);
    
    log.debug(`Job ${planJob.name} (key=${jobKey}) submitted to runner`, {
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
   * consumesFrom references use job.name (user-friendly) for DAG compatibility.
   * 
   * For multiple sources, the additionalSources (commit SHAs) are merged into the
   * worktree after creation, combining all parent work before the job starts.
   * 
   * Returns: { baseBranch: branch|SHA, additionalSources: SHA[] }
   */
  private computeBaseBranch(spec: PlanSpec, plan: InternalPlanState, job: PlanJob, repoPath: string): { baseBranch: string; additionalSources: string[] } {
    // Gather commit SHAs from all consumesFrom sources (jobs and sub-plans)
    // consumesFrom uses names (user-friendly identifiers)
    const sourceCommits: string[] = [];
    const missingCommits: string[] = [];
    
    log.debug(`Job ${job.name}: computing base from consumesFrom: [${job.consumesFrom.join(', ')}]`);
    
    for (const sourceName of job.consumesFrom) {
      // Check if source is a completed job (stored by name -> commit SHA)
      const jobCommit = plan.completedCommits.get(sourceName);
      if (jobCommit) {
        log.debug(`Job ${job.name}: found source ${sourceName} in completedCommits: ${jobCommit.slice(0, 8)}`);
        sourceCommits.push(jobCommit);
        continue;
      }
      
      // Source not found - track for error reporting
      missingCommits.push(sourceName);
      log.warn(`Job ${job.name}: source ${sourceName} not found in completedCommits`, {
        completedCommitsKeys: [...plan.completedCommits.keys()],
        completedSubPlansKeys: [...plan.completedSubPlans.keys()],
        doneJobs: plan.done
      });
    }
    
    // Check if job explicitly specifies a baseBranch (override for root jobs)
    if (job.inputs.baseBranch && job.inputs.baseBranch !== '') {
      // Only use explicit baseBranch if no consumesFrom
      if (job.consumesFrom.length === 0) {
        log.debug(`Job ${job.name}: using explicit baseBranch: ${job.inputs.baseBranch}`);
        return { baseBranch: job.inputs.baseBranch, additionalSources: [] };
      }
    }
    
    // No consumesFrom - use plan's targetBranchRoot (root job)
    if (job.consumesFrom.length === 0) {
      const targetBranchRoot = plan.targetBranchRoot || spec.baseBranch || 'main';
      log.debug(`Job ${job.name}: root job (no consumesFrom), using targetBranchRoot: ${targetBranchRoot}`);
      return { baseBranch: targetBranchRoot, additionalSources: [] };
    }
    
    // Single source - use that commit directly
    if (sourceCommits.length === 1) {
      log.info(`Job ${job.name}: chaining from single source, base commit: ${sourceCommits[0].slice(0, 8)}`);
      return { baseBranch: sourceCommits[0], additionalSources: [] };
    }
    
    // No commits found despite having consumesFrom - this is an error!
    // Should NOT happen if scheduling is correct (consumesFrom jobs should complete first)
    if (sourceCommits.length === 0) {
      const targetBranchRoot = plan.targetBranchRoot || spec.baseBranch || 'main';
      log.error(`Job ${job.name}: BUG - consumesFrom has entries [${job.consumesFrom.join(', ')}] but no commits found!`, {
        missingCommits,
        completedCommitsKeys: [...plan.completedCommits.keys()],
        completedSubPlansKeys: [...plan.completedSubPlans.keys()],
        doneJobs: plan.done
      });
      log.warn(`Job ${job.name}: falling back to targetBranchRoot: ${targetBranchRoot} (FORWARD MERGE WILL BE MISSING!)`);
      return { baseBranch: targetBranchRoot, additionalSources: [] };
    }
    
    // Multiple sources - use first as base, return others for direct worktree merge
    log.info(`Job ${job.name}: multiple sources, base: ${sourceCommits[0].slice(0, 8)}, will merge ${sourceCommits.length - 1} additional: [${sourceCommits.slice(1).map(s => s.slice(0, 8)).join(', ')}]`);
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
    
    log.info(`Merging ${additionalSources.length} additional source commits into worktree for job ${job.name}`, {
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
        message: `Merge parent commit ${shortSha} for job ${job.name}`,
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
          `We are merging commit '${shortSha}' into the current working directory for job '${job.name}'. ` +
          `Prefer '${prefer}' changes when there are conflicts. ` +
          `Resolve all conflicts, stage the changes with 'git add', and commit with message 'orchestrator: merge commit ${shortSha} for job ${job.name}'`;
        
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
    
    log.info(`Successfully merged all source commits into worktree for job ${job.name}`);
    return true;
  }

  /**
   * Update job statuses from the runner.
   * 
   * Note: State tracking uses job names, jobIdMap maps name → UUID.
   */
  private async updateJobStatuses(spec: PlanSpec, plan: InternalPlanState): Promise<void> {
    const runnerJobs = this.runner.list();
    
    for (const jobName of [...plan.running]) {
      const jobId = plan.jobIdMap.get(jobName);
      if (!jobId) continue;
      
      const runnerJob = runnerJobs.find(j => j.id === jobId);
      if (!runnerJob) continue;
      
      switch (runnerJob.status) {
        case 'succeeded':
          await this.handleJobSuccess(spec, plan, jobName, runnerJob);
          break;
        case 'failed':
          this.handleJobFailure(plan, jobName);
          break;
        case 'canceled':
          this.handleJobCanceled(plan, jobName);
          break;
        // 'running' and 'queued' - no action needed
      }
    }
  }
  
  /**
   * Update sub-plan statuses by checking their nested plan state.
   * Note: State tracking uses sub-plan names, runningSubPlans maps name → child plan ID.
   */
  private async updateSubPlanStatuses(spec: PlanSpec, plan: InternalPlanState, repoPath: string): Promise<void> {
    if (!plan.runningSubPlans || plan.runningSubPlans.size === 0) {
      return;
    }
    
    for (const [subPlanName, childPlanId] of plan.runningSubPlans.entries()) {
      const childPlan = this.plans.get(childPlanId);
      if (!childPlan) continue;
      
      const childSpec = this.specs.get(childPlanId);
      
      // Wait for the child plan's merges to complete so consumers get the fully integrated result.
      if (childPlan.status === 'succeeded' && !childPlan.riMergeCompleted) {
        continue;
      }

      if (childPlan.status === 'succeeded') {
        log.info(`Sub-plan ${subPlanName} (${childPlanId}) completed successfully`, {
          parentPlan: spec.id
        });
        
        // Get the completed commit for this sub-plan from its integration branch.
        // Sub-plans merge their leaves into their OWN target branch; the parent consumes the resulting commit SHA.
        let completedCommit: string | undefined;
        if (childSpec?.targetBranch) {
          try {
            completedCommit = await git.repository.resolveRef(childSpec.targetBranch, repoPath);
          } catch (e: any) {
            log.warn(`Could not resolve sub-plan targetBranch for ${subPlanName}`, {
              childPlanId,
              targetBranch: childSpec.targetBranch,
              error: e?.message
            });
          }
        }

        // Fallback: if we can't resolve the branch, pick any completed commit from the child.
        if (!completedCommit && childPlan.completedCommits.size > 0) {
          for (const commit of childPlan.completedCommits.values()) {
            completedCommit = commit;
          }
        }
        
        // Record the completed commit so consumers can use it
        if (completedCommit) {
          // Add entry to completedCommits using the sub-plan name
          // Jobs can consume from the sub-plan name to receive its completed commit
          plan.completedCommits.set(subPlanName, completedCommit);
          log.debug(`Sub-plan ${subPlanName} completed commit: ${completedCommit.slice(0, 8)}`);
        }
        
        plan.runningSubPlans.delete(subPlanName);
        // Store childPlanId (not commit) so UI can navigate to sub-plan detail view
        plan.completedSubPlans.set(subPlanName, childPlanId);
        this.persist();  // Persist sub-plan completion immediately
        
        // Append sub-plan's aggregated work summary to parent - computed once at completion
        this.appendSubPlanWorkSummary(plan, subPlanName, childPlanId);
        
        // Check if this sub-plan is a leaf (nothing consumes from it)
        // If so, immediately merge to targetBranch - user gets value right away!
        // Await the merge to ensure it completes before moving on
        const isLeaf = mergeManager.isLeafWorkUnit(spec, subPlanName);
        if (isLeaf && completedCommit) {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          const repoPath = spec.repoPath || ws;
          const shouldCleanup = spec.cleanUpSuccessfulWork !== false;
          // Note: For sub-plans, we DON'T call appendJobWorkSummary in mergeLeafToTarget
          // because we already appended the sub-plan's aggregate above
          try {
            log.info(`Merging and cleaning up sub-plan ${subPlanName}`);
            await mergeManager.mergeLeafToTarget(spec, plan, subPlanName, completedCommit, repoPath);
            if (shouldCleanup) {
              await cleanupManager.cleanupWorkUnit(spec, plan, subPlanName, repoPath);
            }
            this.persist();
            log.info(`Completed merge/cleanup for sub-plan ${subPlanName}`);
          } catch (err: any) {
            log.error(`Merge/cleanup failed for sub-plan ${subPlanName}`, { error: err.message });
          }
        }
        
        // Check if this completion unblocks any jobs or other sub-plans
        // This is fast (just state updates) so we can await it
        await this.queueReadyDependentsForSubPlan(spec, plan, subPlanName);
        
      } else if (childPlan.status === 'failed' || childPlan.status === 'partial') {
        log.error(`Sub-plan ${subPlanName} (${childPlanId}) failed`, {
          parentPlan: spec.id,
          childStatus: childPlan.status
        });
        
        plan.runningSubPlans.delete(subPlanName);
        plan.failedSubPlans.set(subPlanName, childPlanId);
        this.persist();  // Persist the failure state immediately
        
        // Check if this failure should fail the parent plan
        this.checkPlanCompletion(spec, plan);
        
      } else if (childPlan.status === 'canceled') {
        log.warn(`Sub-plan ${subPlanName} (${childPlanId}) was canceled`, {
          parentPlan: spec.id
        });
        
        plan.runningSubPlans.delete(subPlanName);
        plan.failedSubPlans.set(subPlanName, childPlanId);
        this.persist();  // Persist the canceled state immediately
        
        // Check if this cancellation should affect parent plan status
        this.checkPlanCompletion(spec, plan);
      }
      // Running/queued - no action needed
    }
  }
  
  /**
   * Queue jobs that were waiting for a sub-plan to complete.
   * Jobs can list sub-plan names in their consumesFrom to wait for sub-plan completion.
   */
  private async queueReadyDependentsForSubPlan(spec: PlanSpec, plan: InternalPlanState, completedSubPlanName: string): Promise<void> {
    // Check all jobs that might be consuming from this sub-plan
    for (const job of spec.jobs) {
      const jobKey = this.getProducerId(job);
      // Skip if already processed (state tracking uses canonical key)
      if (plan.submitted.includes(jobKey) || plan.queued.includes(jobKey)) {
        continue;
      }
      
      // Check if this job consumes from the completed sub-plan (consumesFrom uses canonical keys)
      if (!job.consumesFrom.includes(completedSubPlanName)) {
        continue;
      }
      
      // Check if ALL consumesFrom sources are complete (jobs and sub-plans)
      const allSourcesComplete = job.consumesFrom.every(sourceName => 
        plan.done.includes(sourceName) || plan.completedSubPlans.has(sourceName)
      );
      
      if (allSourcesComplete) {
        log.info(`Job ${job.name} consumesFrom satisfied after sub-plan ${completedSubPlanName} completed, queuing`, {
          planId: spec.id,
          consumesFrom: job.consumesFrom
        });
        plan.queued.push(jobKey);
      } else {
        const pendingSources = job.consumesFrom.filter(sourceName => 
          !plan.done.includes(sourceName) && !plan.completedSubPlans.has(sourceName)
        );
        log.debug(`Job ${job.name} still waiting after sub-plan ${completedSubPlanName} completed`, {
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
   * 
   * @param jobName - User-friendly job name (used for state tracking)
   */
  private async handleJobSuccess(spec: PlanSpec, plan: InternalPlanState, jobName: string, runnerJob: Job): Promise<void> {
    // Guard: if already processed, skip
    if (plan.done.includes(jobName)) {
      log.debug(`Job ${jobName} already in done - skipping handleJobSuccess`, { planId: spec.id });
      return;
    }
    
    // Guard: if already in failed, something is very wrong - log but don't add to done
    if (plan.failed.includes(jobName)) {
      log.warn(`Job ${jobName} was in failed but now succeeded - this indicates a state bug`, { planId: spec.id });
      // Remove from failed and proceed
      plan.failed = plan.failed.filter(n => n !== jobName);
    }
    
    // Remove from running, add to done (using jobName for state tracking)
    plan.running = plan.running.filter(n => n !== jobName);
    plan.done.push(jobName);
    
    // Get the final commit SHA from the worktree
    // This is the KEY for commit chaining - dependent jobs will use this commit as their base
    const worktreePath = plan.worktreePaths.get(jobName);
    let completedCommit: string | null = null;
    
    if (worktreePath) {
      completedCommit = await git.worktrees.getHeadCommit(worktreePath);
    }
    
    if (!completedCommit) {
      // Fallback: this shouldn't happen but handle gracefully
      log.warn(`Could not get HEAD commit for job ${jobName}, using base commit as fallback`);
      completedCommit = plan.baseCommits.get(jobName) || 'HEAD';
    }
    
    plan.completedCommits.set(jobName, completedCommit);
    
    log.info(`Job ${jobName} succeeded`, {
      planId: spec.id,
      completedCommit: completedCommit.slice(0, 8),
      duration: runnerJob.endedAt && runnerJob.startedAt 
        ? `${Math.round((runnerJob.endedAt - runnerJob.startedAt) / 1000)}s` 
        : 'unknown'
    });
    
    log.debug(`Plan ${spec.name} progress`, {
      done: plan.done,
      running: plan.running,
      queued: plan.queued,
      failed: plan.failed
    });
    
    // Check if this is a leaf job (nothing consumes from it)
    // If so, immediately merge to targetBranch - user gets value right away!
    // Await the merge to ensure it completes before moving on
    // NOTE: Sub-plan leaf jobs merge to the sub-plan's OWN targetBranch (integration branch).
    //       When the sub-plan itself completes (as a leaf in the parent), the parent merges
    //       the sub-plan's integration branch to the parent's targetBranch.
    const isLeaf = mergeManager.isLeafWorkUnit(spec, jobName);
    log.info(`Job ${jobName} completion: isLeaf=${isLeaf}, isSubPlan=${spec.isSubPlan}`, {
      completedCommit: completedCommit.slice(0, 8),
      cleanUpEnabled: spec.cleanUpSuccessfulWork !== false,
      targetBranch: spec.targetBranch,
    });
    if (isLeaf) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const repoPath = spec.repoPath || ws;
      log.info(`Merging leaf job ${jobName} to ${spec.targetBranch || 'targetBranch'}`);
      try {
        await this.mergeLeafToTarget(spec, plan, jobName, completedCommit, repoPath);
        log.info(`Completed merge/cleanup for leaf job ${jobName}`);
      } catch (err: any) {
        log.error(`Merge/cleanup failed for leaf job ${jobName}`, { error: err.message });
      }
    } else {
      log.info(`Job ${jobName} is not a leaf - cleanup will be triggered by consumer cleanup`);
    }
    
    // Check for jobs that depended on this one and are now ready
    // This is fast (just state updates) so we can await it
    await this.queueReadyDependents(spec, plan, jobName);
  }
  
  /**
   * Immediately merge a completed leaf job's commit to targetBranch.
   * Delegates to mergeManager module.
   * 
   * After successful merge, appends the job's work summary to the plan's
   * aggregated summary - this is computed ONCE at merge time, not on every enumeration.
   * 
   * @param jobName - User-friendly job name (used for state tracking)
   */
  private async mergeLeafToTarget(
    spec: PlanSpec, 
    plan: InternalPlanState, 
    jobName: string, 
    completedCommit: string,
    repoPath: string
  ): Promise<void> {
    const planJob = this.findJobByProducerId(spec, jobName);
    const success = await mergeManager.mergeLeafToTarget(spec, plan, jobName, completedCommit, repoPath);
    
    if (success) {
      // Append work summary to plan's aggregate - computed once at merge time
      this.appendJobWorkSummary(plan, jobName);
      
      if (spec.cleanUpSuccessfulWork !== false) {
        // Clean up worktree/branch if enabled (default behavior)
        await cleanupManager.cleanupWorkUnit(spec, plan, jobName, repoPath);
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
   * @param jobKey - Canonical key (producerId or name) used for state tracking
   */
  private handleJobFailure(plan: InternalPlanState, jobName: string): void {
    // Guard: don't mark as failed if already succeeded
    if (plan.done.includes(jobName)) {
      log.warn(`Job ${jobName} already in done - NOT marking as failed`, {
        planId: plan.id,
        done: plan.done,
        failed: plan.failed
      });
      return;
    }
    
    // Guard: don't double-add to failed
    if (plan.failed.includes(jobName)) {
      log.debug(`Job ${jobName} already in failed - skipping`, { planId: plan.id });
      return;
    }
    
    plan.running = plan.running.filter(n => n !== jobName);
    plan.failed.push(jobName);
    
    log.error(`Job ${jobName} failed`, {
      planId: plan.id,
      failedJobs: plan.failed,
      runningJobs: plan.running
    });
  }

  /**
   * Handle a canceled job.
   * @param jobName - User-friendly job name (used for state tracking)
   */
  private handleJobCanceled(plan: InternalPlanState, jobName: string): void {
    plan.running = plan.running.filter(n => n !== jobName);
    plan.canceled.push(jobName);
    
    log.warn(`Job ${jobName} canceled`, {
      planId: plan.id
    });
  }

  /**
   * Queue jobs and sub-plans whose consumesFrom sources are now satisfied.
   * @param completedJobName - Canonical key (producerId or name) of the job that just completed
   */
  private async queueReadyDependents(spec: PlanSpec, plan: InternalPlanState, completedJobName: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const repoPath = spec.repoPath || ws;
    
    log.debug(`queueReadyDependents called for ${completedJobName}`, {
      planId: spec.id,
      totalJobs: spec.jobs.length,
      done: plan.done,
      submitted: plan.submitted,
      queued: plan.queued
    });
    
    // Check regular jobs
    for (const job of spec.jobs) {
      const jobKey = this.getProducerId(job);
      // Skip if already processed (state tracking uses canonical key)
      if (plan.submitted.includes(jobKey) || plan.queued.includes(jobKey)) {
        log.debug(`Skipping ${job.name} (key=${jobKey}): already submitted or queued`);
        continue;
      }
      
      // Check if this job consumes from the completed job (consumesFrom uses canonical keys)
      if (!job.consumesFrom.includes(completedJobName)) {
        continue;
      }
      
      log.debug(`Job ${job.name} (key=${jobKey}) consumes from ${completedJobName}, checking all deps`, {
        consumesFrom: job.consumesFrom
      });
      
      // Check if ALL consumesFrom sources are complete (jobs and sub-plans)
      const depStatus = job.consumesFrom.map(sourceName => ({
        source: sourceName,
        inDone: plan.done.includes(sourceName),
        inCompletedSubPlans: plan.completedSubPlans.has(sourceName),
        complete: plan.done.includes(sourceName) || plan.completedSubPlans.has(sourceName)
      }));
      const allSourcesComplete = depStatus.every(d => d.complete);
      
      log.debug(`Job ${job.name} (key=${jobKey}) dependency status`, {
        depStatus,
        allSourcesComplete
      });
      
      if (allSourcesComplete) {
        log.info(`Job ${job.name} (key=${jobKey}) consumesFrom satisfied, queuing`, {
          planId: spec.id,
          consumesFrom: job.consumesFrom,
          completedTrigger: completedJobName
        });
        plan.queued.push(jobKey);
      } else {
        const pendingSources = job.consumesFrom.filter(sourceName => 
          !plan.done.includes(sourceName) && !plan.completedSubPlans.has(sourceName)
        );
        log.debug(`Job ${job.name} (key=${jobKey}) still waiting for sources`, {
          pendingSources,
          completedSources: job.consumesFrom.filter(sourceName => 
            plan.done.includes(sourceName) || plan.completedSubPlans.has(sourceName)
          )
        });
      }
    }
    
    // Check sub-plans
    if (spec.subPlans) {
      for (const subPlanSpec of spec.subPlans) {
        const subPlanKey = this.getProducerId(subPlanSpec);
        // Skip if not pending (state tracking uses canonical key)
        if (!plan.pendingSubPlans.has(subPlanKey)) {
          continue;
        }
        
        // Check if this sub-plan consumes from the completed job (consumesFrom uses canonical keys)
        if (!subPlanSpec.consumesFrom.includes(completedJobName)) {
          continue;
        }
        
        // Check if ALL consumesFrom sources are complete
        const allSourcesComplete = subPlanSpec.consumesFrom.every(sourceName => 
          plan.done.includes(sourceName) || plan.completedSubPlans.has(sourceName)
        );
        
        if (allSourcesComplete) {
          log.info(`Sub-plan ${subPlanSpec.name} (key=${subPlanKey}) consumesFrom satisfied, launching`, {
            planId: spec.id,
            consumesFrom: subPlanSpec.consumesFrom,
            completedTrigger: completedJobName
          });
          
          // Launch the sub-plan
          await this.launchSubPlan(spec, plan, subPlanSpec, repoPath);
        } else {
          const pendingSources = subPlanSpec.consumesFrom.filter(sourceName => 
            !plan.done.includes(sourceName) && !plan.completedSubPlans.has(sourceName)
          );
          log.debug(`Sub-plan ${subPlanSpec.name} (key=${subPlanKey}) still waiting for sources`, {
            pendingSources,
            completedSources: subPlanSpec.consumesFrom.filter(sourceName => 
              plan.done.includes(sourceName) || plan.completedSubPlans.has(sourceName)
            )
          });
        }
      }
    }
  }

  /**
   * Launch any pending sub-plans whose consumesFrom dependencies are already satisfied.
   *
   * This is required for restart/reload scenarios:
   * the original trigger for launching sub-plans is job completion, but after a reload
   * jobs may already be complete so no completion event fires.
   */
  private async launchReadySubPlans(spec: PlanSpec, plan: InternalPlanState, repoPath: string): Promise<void> {
    if (!spec.subPlans || spec.subPlans.length === 0) return;
    if (!plan.pendingSubPlans || plan.pendingSubPlans.size === 0) return;

    for (const subPlanSpec of spec.subPlans) {
      const subPlanKey = this.getProducerId(subPlanSpec);

      // Reconcile state: a sub-plan can't be pending and also running/completed/failed.
      if (
        plan.completedSubPlans.has(subPlanKey) ||
        plan.runningSubPlans.has(subPlanKey) ||
        plan.failedSubPlans.has(subPlanKey)
      ) {
        plan.pendingSubPlans.delete(subPlanKey);
        continue;
      }

      if (!plan.pendingSubPlans.has(subPlanKey)) continue;

      const deps = Array.isArray(subPlanSpec.consumesFrom) ? subPlanSpec.consumesFrom : [];
      const allSourcesComplete = deps.every(sourceName =>
        plan.done.includes(sourceName) || plan.completedSubPlans.has(sourceName)
      );

      if (!allSourcesComplete) continue;

      log.info(`Sub-plan ${subPlanSpec.name} (key: ${subPlanKey}) dependencies satisfied (scan), launching`, {
        planId: spec.id,
        consumesFrom: deps
      });

      await this.launchSubPlan(spec, plan, subPlanSpec, repoPath);
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
    
    // Generate a unique ID for the child plan using parent's id (UUID) and sub-plan's id (UUID)
    const childPlanId = `${parentSpec.id}/${subPlanSpec.id}`;
    
    log.info(`Launching sub-plan: ${subPlanSpec.name}`, {
      parentPlan: parentSpec.name,
      childPlanId,
      consumesFrom: subPlanSpec.consumesFrom
    });
    
    // Determine the source commit/branch for the sub-plan (from consumesFrom sources)
    // consumesFrom uses names for references
    let sourceCommitish: string;
    if (subPlanSpec.consumesFrom.length === 0) {
      // Root sub-plan - uses parent's targetBranchRoot
      sourceCommitish = parentState.targetBranchRoot || parentSpec.baseBranch || 'main';
    } else if (subPlanSpec.consumesFrom.length === 1) {
      // Single source - use its completed commit (keyed by name)
      const sourceName = subPlanSpec.consumesFrom[0];
      sourceCommitish = parentState.completedCommits.get(sourceName)
        || parentState.targetBranchRoot
        || 'main';
    } else {
      // Multiple sources - need to merge them
      const sourceCommits = subPlanSpec.consumesFrom
        .map(name => parentState.completedCommits.get(name))
        .filter((c): c is string => !!c);
      
      if (sourceCommits.length === 0) {
        sourceCommitish = parentState.targetBranchRoot || 'main';
      } else if (sourceCommits.length === 1) {
        sourceCommitish = sourceCommits[0];
      } else {
        // For multiple sources, use the first (merge should be handled by parent)
        sourceCommitish = sourceCommits[0];
        log.warn(`Sub-plan ${subPlanSpec.name} has multiple sources, using first: ${sourceCommitish.slice(0, 8)}`);
      }
    }
    
    log.info(`Sub-plan ${subPlanSpec.name} will start from: ${sourceCommitish.length > 20 ? sourceCommitish.slice(0, 8) : sourceCommitish}`);
    
    // Convert sub-plan jobs to PlanJob format
    // Jobs will create detached worktrees from the source commit
    // Assign UUIDs if not present
    const jobs: PlanJob[] = subPlanSpec.jobs.map(j => ({
      id: j.id || randomUUID(),
      name: j.name,
      producerId: j.producerId,  // REQUIRED - user-controlled DAG reference
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
    
    // Create the nested plan spec
    // Use the sub-plan's id (UUID) for the child plan id
    // With detached HEAD worktrees, there are no integration branches
    // The sub-plan's work is tracked by commit SHAs
    const nestedPlanSpec: PlanSpec = {
      id: childPlanId,
      name: subPlanSpec.name || `${parentSpec.name} / ${subPlanSpec.name}`,
      repoPath: parentSpec.repoPath,
      worktreeRoot: `${parentSpec.worktreeRoot}/${subPlanSpec.id}`,  // Use sub-plan's UUID for path uniqueness
      baseBranch: sourceCommitish,  // Start from the source commit/branch
      // Sub-plan merges to its own integration branch. Parent merges the resulting commit to its target.
      targetBranch: `copilot_subplans/${childPlanId}`,
      maxParallel: subPlanSpec.maxParallel || parentSpec.maxParallel,
      jobs: jobs,
      // Mark this as a sub-plan so it knows to skip certain cleanup
      isSubPlan: true,
      parentPlanId: parentSpec.id,
      // Inherit cleanup setting from parent
      cleanUpSuccessfulWork: parentSpec.cleanUpSuccessfulWork
    };
    
    // Move from pending to running (state tracking uses canonical key - producerId)
    const subPlanKey = this.getProducerId(subPlanSpec);
    parentState.pendingSubPlans.delete(subPlanKey);
    parentState.runningSubPlans.set(subPlanKey, childPlanId);
    
    // Enqueue the nested plan
    this.enqueue(nestedPlanSpec);
    
    log.info(`Sub-plan ${subPlanSpec.name} (key: ${subPlanKey}) enqueued with ${jobs.length} jobs, source: ${sourceCommitish.length > 20 ? sourceCommitish.slice(0, 8) : sourceCommitish}`);
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
    
    log.debug(`Checking plan completion: ${spec.name}`, {
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
    
    // Not done if there are running jobs or running sub-plans
    if (plan.running.length > 0) {
      log.debug(`Plan ${spec.name} still in progress (jobs running)`, { running: plan.running });
      return;
    }
    
    if (runningSubPlans > 0) {
      log.debug(`Plan ${spec.name} still in progress (sub-plans running)`, { 
        runningSubPlans: Array.from(plan.runningSubPlans.entries())
      });
      return;
    }
    
    // Recovery: Check for jobs that should be queued but aren't
    // This can happen if a sub-plan completion didn't trigger queueing due to key mismatch
    const notProcessedJobs = spec.jobs.filter(j => {
      const jobKey = this.getProducerId(j);
      return !plan.done.includes(jobKey) && 
             !plan.failed.includes(jobKey) && 
             !plan.canceled.includes(jobKey) &&
             !plan.queued.includes(jobKey) &&
             !plan.running.includes(jobKey) &&
             !plan.submitted.includes(jobKey);
    });
    
    if (notProcessedJobs.length > 0) {
      for (const job of notProcessedJobs) {
        const jobKey = this.getProducerId(job);
        // Check if all dependencies are satisfied
        const allDepsSatisfied = job.consumesFrom.every(source => 
          plan.done.includes(source) || plan.completedSubPlans.has(source)
        );
        
        if (allDepsSatisfied) {
          log.info(`Recovery: queuing job ${job.name} that was missed`, {
            planId: spec.id,
            consumesFrom: job.consumesFrom
          });
          plan.queued.push(jobKey);
        }
      }
      
      // If we queued any jobs, persist and return to let them run
      if (plan.queued.length > 0) {
        this.persist();
        return;
      }
    }
    
    // Helper to check if a dependency source has failed (job or sub-plan)
    const isSourceFailed = (source: string): boolean => {
      return plan.failed.includes(source) || plan.failedSubPlans.has(source);
    };
    
    // Helper to check if a dependency source has succeeded
    const isSourceSucceeded = (source: string): boolean => {
      return plan.done.includes(source) || plan.completedSubPlans.has(source);
    };
    
    // Helper to check if a job is blocked (any dependency failed)
    const isJobBlocked = (jobSpec: { consumesFrom?: string[] }): boolean => {
      return (jobSpec.consumesFrom || []).some(isSourceFailed);
    };
    
    // Check if any queued jobs are blocked (dependencies failed)
    if (plan.queued.length > 0) {
      const blockedJobs: string[] = [];
      const canProgressJobs: string[] = [];
      
      for (const jobName of plan.queued) {
        // Guard: skip if already processed
        if (plan.done.includes(jobName) || plan.failed.includes(jobName)) {
          log.warn(`Job ${jobName} in queued but also in done/failed - removing from queued`, { planId: spec.id });
          continue;
        }
        
        const jobSpec = spec.jobs.find(j => j.name === jobName || this.getProducerId(j) === jobName);
        if (jobSpec && isJobBlocked(jobSpec)) {
          blockedJobs.push(jobName);
        } else {
          canProgressJobs.push(jobName);
        }
      }
      
      // Clean up queued array (remove already-processed jobs)
      plan.queued = plan.queued.filter(j => !plan.done.includes(j) && !plan.failed.includes(j));
      
      if (blockedJobs.length > 0) {
        // Move blocked jobs to failed
        log.warn(`Plan ${spec.name} has blocked jobs (dependencies failed)`, { blockedJobs });
        plan.queued = canProgressJobs;
        plan.failed.push(...blockedJobs);
      }
      
      // If there are still jobs that can progress, wait
      if (canProgressJobs.length > 0) {
        log.debug(`Plan ${spec.name} still has jobs that can progress`, { canProgressJobs });
        return;
      }
    }
    
    // Check if there are pending sub-plans that should have been launched but haven't
    // This can happen if their consumesFrom sources failed
    if (pendingSubPlans > 0) {
      const blockedSubPlans: string[] = [];
      const canTriggerSubPlans: string[] = [];
      
      for (const spKey of plan.pendingSubPlans) {
        const spSpec = spec.subPlans?.find(sp => this.getProducerId(sp) === spKey);
        if (!spSpec) continue;
        
        // Check if any dependency has failed
        const hasFailedDep = spSpec.consumesFrom.some(isSourceFailed);
        // Check if all dependencies are satisfied
        const allDepsSatisfied = spSpec.consumesFrom.every(isSourceSucceeded);
        
        if (hasFailedDep) {
          blockedSubPlans.push(spKey);
        } else if (allDepsSatisfied) {
          canTriggerSubPlans.push(spKey);
        }
        // Else: waiting for deps to complete
      }
      
      if (blockedSubPlans.length > 0) {
        // Move blocked sub-plans to failed (no childPlanId since never launched)
        log.warn(`Plan ${spec.name} has blocked sub-plans (dependencies failed)`, { blockedSubPlans });
        for (const spKey of blockedSubPlans) {
          plan.pendingSubPlans.delete(spKey);
          plan.failedSubPlans.set(spKey, '');  // Empty string = never launched
        }
      }
      
      if (canTriggerSubPlans.length > 0) {
        log.debug(`Plan ${spec.name} has triggerable sub-plans, waiting for next pump`);
        return;
      }
      
      // If there are still pending sub-plans waiting for deps, wait
      if (plan.pendingSubPlans.size > blockedSubPlans.length) {
        log.debug(`Plan ${spec.name} has sub-plans waiting for dependencies`);
        return;
      }
    }
    
    // Recalculate finished counts after potentially moving blocked items
    const updatedFinishedJobs = plan.done.length + plan.failed.length + plan.canceled.length;
    const updatedFinishedSubPlans = plan.completedSubPlans.size + plan.failedSubPlans.size;
    
    // All jobs finished
    if (updatedFinishedJobs === totalJobs && updatedFinishedSubPlans === totalSubPlans) {
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
      
      // State arrays use job.name for tracking
      const unscheduledJobs = spec.jobs
        .filter(j => !plan.done.includes(j.name) && !plan.failed.includes(j.name) && !plan.canceled.includes(j.name))
        .map(j => j.name);
      
      const unstartedSubPlans = Array.from(plan.pendingSubPlans);
      
      log.error(`Plan ${spec.name} stuck - jobs/sub-plans could not be scheduled`, {
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
    
    log.info(`Deleting plan: ${spec?.name || id}`, {
      status: plan.status,
      jobCount: plan.jobIdMap.size
    });
    
    // Cancel if running
    if (!['succeeded', 'failed', 'canceled', 'partial'].includes(plan.status)) {
      this.cancel(id);
    }
    
    // Delete all associated jobs from the JobRunner
    // jobIdMap maps job.name -> job.id (UUID)
    for (const [jobName, jobId] of plan.jobIdMap.entries()) {
      log.debug(`Deleting job ${jobId} (plan job: ${jobName})`);
      try {
        (this.runner as any).delete(jobId);
      } catch (e: any) {
        log.warn(`Failed to delete job ${jobId}: ${e.message}`);
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
      // spec.worktreeRoot uses the plan's UUID (spec.id) for consistency
      const worktreeRoot = path.join(repoPath, spec.worktreeRoot || `.worktrees/${spec.id}`);
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
    
    log.info(`Plan ${spec?.name || id} deleted successfully`);
    return true;
  }
}
