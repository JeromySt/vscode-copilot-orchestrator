/**
 * @fileoverview Default ReleaseManager implementation.
 *
 * Orchestrates multi-plan releases by:
 * 1. Creating isolated repository clones under .orchestrator/release/
 * 2. Merging plan commits into a release branch
 * 3. Creating pull requests via IRemotePRService abstraction
 * 4. Monitoring PRs for feedback and autonomously addressing issues
 *
 * All state is persisted to .orchestrator/release/<sanitized-branch>/.
 * ZERO direct gh/az calls - all PR operations go through IRemotePRService.
 *
 * @module plan/releaseManager
 */

import { EventEmitter } from 'events';
import type {
  ReleaseDefinition,
  ReleaseStatus,
  ReleaseProgress,
  ReleaseMergeResult,
  MergeProgress,
  PRMonitoringProgress,
} from './types/release';
import type {
  IReleaseManager,
  CreateReleaseOptions,
} from '../interfaces/IReleaseManager';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import type { IIsolatedRepoManager } from '../interfaces/IIsolatedRepoManager';
import type { IReleasePRMonitor } from '../interfaces/IReleasePRMonitor';
import type { IRemotePRServiceFactory } from '../interfaces/IRemotePRServiceFactory';
import type { IReleaseStore } from '../interfaces/IReleaseStore';
import { Logger } from '../core/logger';
import { ReleaseEventEmitter } from './releaseEvents';
import { ReleaseStateMachine } from './releaseStateMachine';

const log = Logger.for('plan');
const gitLog = (msg: string) => log.info(msg);

/**
 * Default implementation of IReleaseManager.
 *
 * Manages release lifecycle including isolated repo creation, branch merging,
 * PR creation/monitoring, and autonomous feedback resolution.
 */
export class DefaultReleaseManager extends EventEmitter implements IReleaseManager {
  private readonly releases = new Map<string, ReleaseDefinition>();
  private readonly stateMachines = new Map<string, ReleaseStateMachine>();
  private readonly events = new ReleaseEventEmitter();

  constructor(
    private readonly planRunner: IPlanRunner,
    private readonly git: IGitOperations,
    private readonly copilot: ICopilotRunner,
    private readonly isolatedRepos: IIsolatedRepoManager,
    private readonly prMonitor: IReleasePRMonitor,
    private readonly prServiceFactory: IRemotePRServiceFactory,
    private readonly store: IReleaseStore,
  ) {
    super();

    // Forward events from typed emitter to this EventEmitter
    this.events.on('release:created', (release) => this.emit('releaseCreated', release));
    this.events.on('release:statusChanged', (releaseId, oldStatus, newStatus) => {
      const release = this.releases.get(releaseId);
      if (release) {
        this.emit('releaseStatusChanged', release);
      }
    });
    this.events.on('release:progress', (releaseId, progress) => {
      this.emit('releaseProgress', releaseId, progress);
    });
    this.events.on('release:prCycle', (releaseId, cycle) => {
      this.emit('releasePRCycle', releaseId, cycle);
    });
    this.events.on('release:completed', (release) => this.emit('releaseCompleted', release));

    this._loadPersistedReleases().catch((error) => {
      log.error('Failed to load persisted releases on startup', { error: (error as Error).message });
    });
  }

  // ── Release Lifecycle ──────────────────────────────────────────────────

  async createRelease(options: CreateReleaseOptions): Promise<ReleaseDefinition> {
    log.info('Creating release', { name: options.name, planIds: options.planIds });

    // Validate all plan IDs exist and are in terminal states
    for (const planId of options.planIds) {
      const plan = this.planRunner.get(planId);
      if (!plan) {
        throw new Error(`Plan not found: ${planId}`);
      }
      const sm = this.planRunner.getStateMachine(planId);
      const planStatus = sm?.computePlanStatus();
      if (planStatus !== 'succeeded' && planStatus !== 'partial') {
        throw new Error(`Plan ${planId} must be succeeded or partial, but is ${planStatus}`);
      }
    }

    // Get repository path: from options (from-branch flow) or from first plan
    let repoPath: string;
    if (options.planIds.length > 0) {
      const firstPlan = this.planRunner.get(options.planIds[0])!;
      repoPath = firstPlan.spec.repoPath ?? firstPlan.repoPath;
    } else if (options.repoPath) {
      repoPath = options.repoPath;
    } else {
      throw new Error('repoPath is required when planIds is empty');
    }

    // Resolve target branch (default to main if not specified)
    let targetBranch = options.targetBranch;
    if (!targetBranch) {
      // Try to get default branch from git
      try {
        const currentBranch = await this.git.branches.current(repoPath);
        targetBranch = currentBranch || 'main';
      } catch (error) {
        log.warn('Failed to detect current branch, defaulting to main', {
          error: (error as Error).message,
        });
        targetBranch = 'main';
      }
    }

    // Determine source flow type
    const source: 'from-plans' | 'from-branch' = options.planIds.length > 0 ? 'from-plans' : 'from-branch';

    // Build release definition
    const releaseId = this._generateReleaseId();
    const now = Date.now();
    const release: ReleaseDefinition = {
      id: releaseId,
      name: options.name,
      planIds: options.planIds,
      releaseBranch: options.releaseBranch,
      targetBranch,
      repoPath,
      status: 'drafting',
      source,
      stateHistory: [
        {
          from: 'drafting',
          to: 'drafting',
          timestamp: now,
          reason: 'Release created',
        },
      ],
      createdAt: now,
    };

    // Create state machine for this release
    const stateMachine = new ReleaseStateMachine(release);
    
    // Forward state machine events to release events
    stateMachine.on('transition', (event) => {
      this.events.emitReleaseStatusChanged(event.releaseId, event.from, event.to);
    });
    stateMachine.on('completed', (releaseId, finalStatus) => {
      if (finalStatus === 'succeeded') {
        this.events.emitReleaseCompleted(release);
      } else if (finalStatus === 'failed') {
        this.events.emitReleaseFailed(release, release.error || 'Unknown error');
      } else if (finalStatus === 'canceled') {
        this.events.emitReleaseCanceled(releaseId);
      }
    });

    // Persist and track
    this.releases.set(releaseId, release);
    this.stateMachines.set(releaseId, stateMachine);
    await this.store.saveRelease(release);
    this.events.emitReleaseCreated(release);

    log.info('Release created', { releaseId, name: release.name });
    return release;
  }

  async startRelease(releaseId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }
    if (release.status !== 'drafting' && release.status !== 'preparing') {
      throw new Error(`Release ${releaseId} already started (status: ${release.status})`);
    }

    log.info('Starting release', { releaseId, name: release.name, source: release.source });

    try {
      // If not already in preparing state, transition there
      if (release.status === 'drafting') {
        await this.prepareRelease(releaseId);
      }

      // Wait for required tasks to be complete
      if (!this.areRequiredTasksComplete(releaseId)) {
        log.info('Waiting for required preparation tasks to complete', { releaseId });
        // Stay in preparing state - user must complete tasks
        return;
      }

      // Determine the flow based on source
      if (release.source === 'from-plans') {
        await this._executeFromPlansFlow(release);
      } else {
        await this._executeFromBranchFlow(release);
      }

      release.startedAt = Date.now();
      await this.store.saveRelease(release);
    } catch (error) {
      log.error('Release failed', { releaseId, error: (error as Error).message });
      release.error = (error as Error).message;
      await this._transitionStatus(release, 'failed');
      release.endedAt = Date.now();
      await this.store.saveRelease(release);
      this.events.emitReleaseFailed(release, release.error);
      throw error;
    }
  }

  /**
   * Execute the from-plans flow: preparing -> merging -> ready-for-pr -> creating-pr -> monitoring
   */
  private async _executeFromPlansFlow(release: ReleaseDefinition): Promise<void> {
    const isolatedPath = release.isolatedRepoPath!;

    // Transition to ready-for-pr (preparation is complete)
    await this._transitionStatus(release, 'ready-for-pr', 'All required preparation tasks complete');

    // Phase 1: Merge all plan branches
    await this._transitionStatus(release, 'merging');
    const mergeResults = await this._mergeAllPlans(release);
    log.info('All plans merged', { releaseId: release.id, succeeded: mergeResults.filter((r) => r.success).length });

    // Phase 2: Push release branch
    const pushSuccess = await this.git.repository.push(isolatedPath, {
      remote: 'origin',
      branch: release.releaseBranch,
      log: gitLog,
    });
    if (!pushSuccess) {
      throw new Error('Failed to push release branch to origin');
    }
    log.info('Release branch pushed', { releaseId: release.id, branch: release.releaseBranch });

    await this._transitionStatus(release, 'ready-for-pr');

    // Phase 3: Create pull request
    await this._createPRAndStartMonitoring(release, mergeResults);
  }

  /**
   * Execute the from-branch flow: preparing -> ready-for-pr -> creating-pr -> monitoring
   */
  private async _executeFromBranchFlow(release: ReleaseDefinition): Promise<void> {
    const isolatedPath = release.isolatedRepoPath!;

    // Transition to ready-for-pr (preparation is complete, no merging needed)
    await this._transitionStatus(release, 'ready-for-pr', 'All required preparation tasks complete');

    // Ensure the release branch is pushed
    const pushSuccess = await this.git.repository.push(isolatedPath, {
      remote: 'origin',
      branch: release.releaseBranch,
      log: gitLog,
    });
    if (!pushSuccess) {
      throw new Error('Failed to push release branch to origin');
    }
    log.info('Release branch pushed', { releaseId: release.id, branch: release.releaseBranch });

    // Create pull request
    await this._createPRAndStartMonitoring(release, []);
  }

  /**
   * Create PR and start monitoring (common to both flows).
   */
  private async _createPRAndStartMonitoring(
    release: ReleaseDefinition,
    mergeResults: import('./types/release').ReleaseMergeResult[],
  ): Promise<void> {
    const isolatedPath = release.isolatedRepoPath!;

    await this._transitionStatus(release, 'creating-pr');
    const prService = await this.prServiceFactory.getServiceForRepo(isolatedPath);
    const prResult = await prService.createPR({
      baseBranch: release.targetBranch,
      headBranch: release.releaseBranch,
      title: release.name,
      body: this._buildPRBody(release, mergeResults),
      cwd: isolatedPath,
    });

    release.prNumber = prResult.prNumber;
    release.prUrl = prResult.prUrl;
    await this.store.saveRelease(release);
    log.info('PR created', { releaseId: release.id, prNumber: prResult.prNumber, prUrl: prResult.prUrl });

    // Start PR monitoring
    await this._transitionStatus(release, 'monitoring');
    await this.prMonitor.startMonitoring(
      release.id,
      prResult.prNumber,
      isolatedPath,
      release.releaseBranch,
    );
  }

  async cancelRelease(releaseId: string): Promise<boolean> {
    const release = this.releases.get(releaseId);
    if (!release) {
      return false;
    }

    // Can only cancel non-terminal releases
    if (release.status === 'succeeded' || release.status === 'failed' || release.status === 'canceled') {
      return false;
    }

    log.info('Canceling release', { releaseId });

    // Stop monitoring if active
    if (this.prMonitor.isMonitoring(releaseId)) {
      this.prMonitor.stopMonitoring(releaseId);
    }

    await this._transitionStatus(release, 'canceled');
    release.endedAt = Date.now();
    await this.store.saveRelease(release);
    this.events.emitReleaseCanceled(releaseId);

    return true;
  }

  // ── Release Queries ────────────────────────────────────────────────────

  getRelease(releaseId: string): ReleaseDefinition | undefined {
    return this.releases.get(releaseId);
  }

  getAllReleases(): ReleaseDefinition[] {
    return Array.from(this.releases.values());
  }

  getReleasesByStatus(status: ReleaseStatus): ReleaseDefinition[] {
    return Array.from(this.releases.values()).filter((r) => r.status === status);
  }

  getReleaseProgress(releaseId: string): ReleaseProgress | undefined {
    const release = this.releases.get(releaseId);
    if (!release) {
      return undefined;
    }

    const progress: ReleaseProgress = {
      status: release.status,
      currentStep: this._getCurrentStep(release),
    };

    // Add merge progress if in merging phase (not implemented in this basic version)
    // Add PR monitoring progress if monitoring
    if (release.status === 'monitoring' || release.status === 'addressing') {
      const cycles = this.prMonitor.getMonitorCycles(releaseId);
      const lastCycle = cycles[cycles.length - 1];

      const unresolvedComments = lastCycle?.comments.filter((c) => !c.isResolved).length || 0;
      const failingChecks = lastCycle?.checks.filter((c) => c.status === 'failing').length || 0;
      const unresolvedAlerts = lastCycle?.securityAlerts.filter((a) => !a.resolved).length || 0;

      progress.prMonitoring = {
        cyclesCompleted: cycles.length,
        lastCycle,
        unresolvedComments,
        failingChecks,
        unresolvedAlerts,
      };
    }

    return progress;
  }

  // ── Release Management ─────────────────────────────────────────────────

  deleteRelease(releaseId: string): boolean {
    const release = this.releases.get(releaseId);
    if (!release) {
      return false;
    }

    // Can only delete terminal releases
    if (release.status !== 'succeeded' && release.status !== 'failed' && release.status !== 'canceled') {
      return false;
    }

    log.info('Deleting release', { releaseId });

    this.releases.delete(releaseId);
    this.stateMachines.delete(releaseId);
    this.store.deleteRelease(releaseId).catch((error) => {
      log.error('Failed to delete release from store', { releaseId, error: (error as Error).message });
    });
    this.events.emitReleaseDeleted(releaseId);

    return true;
  }

  async cleanupIsolatedRepos(): Promise<void> {
    log.info('Cleaning up isolated repos for terminal releases');

    const terminalReleases = Array.from(this.releases.values()).filter(
      (r) => r.status === 'succeeded' || r.status === 'failed' || r.status === 'canceled',
    );

    for (const release of terminalReleases) {
      try {
        await this.isolatedRepos.removeIsolatedRepo(release.id);
        log.debug('Removed isolated repo', { releaseId: release.id });
      } catch (error) {
        log.error('Failed to remove isolated repo', {
          releaseId: release.id,
          error: (error as Error).message,
        });
      }
    }

    log.info('Isolated repo cleanup complete', { cleaned: terminalReleases.length });
  }

  // ── Preparation Tasks ──────────────────────────────────────────────────

  getPrepTasks(releaseId: string): import('./types/releasePrep').PreparationTask[] | undefined {
    const release = this.releases.get(releaseId);
    return release?.preparationTasks;
  }

  async executeTask(releaseId: string, taskId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    if (!release.preparationTasks) {
      throw new Error(`Release ${releaseId} has no preparation tasks`);
    }

    const taskIndex = release.preparationTasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const task = release.preparationTasks[taskIndex];
    if (!task.automatable) {
      throw new Error(`Task ${taskId} is not automatable`);
    }

    // Execute the task
    const { executeTask } = await import('./releasePreparation');
    const repoPath = release.isolatedRepoPath || release.repoPath;
    const updatedTask = await executeTask(task, release, this.copilot, repoPath);

    // Update task in the release
    release.preparationTasks[taskIndex] = updatedTask;
    await this.store.saveRelease(release);

    // Emit event for task status change
    this.events.emitReleaseTaskStatusChanged(releaseId, taskId, updatedTask.status);

    log.info('Preparation task executed', { releaseId, taskId, status: updatedTask.status });
  }

  completeTask(releaseId: string, taskId: string, result?: string): boolean {
    const release = this.releases.get(releaseId);
    if (!release?.preparationTasks) {
      return false;
    }

    const taskIndex = release.preparationTasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return false;
    }

    const { completeTask } = require('./releasePreparation');
    release.preparationTasks[taskIndex] = completeTask(release.preparationTasks[taskIndex], result);
    
    this.store.saveRelease(release).catch((error) => {
      log.error('Failed to save release after completing task', { 
        releaseId, 
        taskId, 
        error: (error as Error).message 
      });
    });

    // Emit event for task status change
    this.events.emitReleaseTaskStatusChanged(releaseId, taskId, 'completed');

    log.info('Task marked complete', { releaseId, taskId });
    return true;
  }

  skipTask(releaseId: string, taskId: string): boolean {
    const release = this.releases.get(releaseId);
    if (!release?.preparationTasks) {
      return false;
    }

    const taskIndex = release.preparationTasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return false;
    }

    const task = release.preparationTasks[taskIndex];
    if (task.required) {
      log.warn('Cannot skip required task', { releaseId, taskId });
      return false;
    }

    const { skipTask } = require('./releasePreparation');
    release.preparationTasks[taskIndex] = skipTask(task);
    
    this.store.saveRelease(release).catch((error) => {
      log.error('Failed to save release after skipping task', { 
        releaseId, 
        taskId, 
        error: (error as Error).message 
      });
    });

    // Emit event for task status change
    this.events.emitReleaseTaskStatusChanged(releaseId, taskId, 'skipped');

    log.info('Task skipped', { releaseId, taskId });
    return true;
  }

  areRequiredTasksComplete(releaseId: string): boolean {
    const release = this.releases.get(releaseId);
    if (!release?.preparationTasks) {
      return true; // No tasks means nothing to complete
    }

    const { areRequiredTasksComplete } = require('./releasePreparation');
    return areRequiredTasksComplete(release.preparationTasks);
  }

  // ── Plan Management ────────────────────────────────────────────────

  async prepareRelease(releaseId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    if (release.status !== 'drafting') {
      throw new Error(`Release ${releaseId} must be in drafting state to prepare (current: ${release.status})`);
    }

    log.info('Preparing release', { releaseId, name: release.name });

    // Transition to preparing state
    await this._transitionStatus(release, 'preparing', 'User initiated preparation');

    // Import preparation functions
    const { getDefaultPrepTasks, getOrCreateReleaseInstructions } = await import('./releasePreparation');

    // Generate default prep tasks based on release type
    release.preparationTasks = getDefaultPrepTasks(release);
    await this.store.saveRelease(release);
    log.info('Preparation tasks initialized', { releaseId, taskCount: release.preparationTasks.length });

    // Create isolated repo if not already created
    if (!release.isolatedRepoPath) {
      const isolatedRepo = await this.isolatedRepos.createIsolatedRepo(
        releaseId,
        release.repoPath,
        release.targetBranch,
      );
      release.isolatedRepoPath = isolatedRepo.clonePath;
      await this.store.saveRelease(release);
      log.info('Isolated repo created for preparation', { releaseId, path: isolatedRepo.clonePath });
    }

    // Create release branch in isolated clone if not already created
    const isolatedPath = release.isolatedRepoPath;
    const branches = await this.git.branches.list(isolatedPath);
    if (!branches.includes(release.releaseBranch)) {
      await this.git.branches.checkout(isolatedPath, release.targetBranch);
      await this.git.branches.create(
        release.releaseBranch,
        release.targetBranch,
        isolatedPath,
        gitLog,
      );
      await this.git.branches.checkout(isolatedPath, release.releaseBranch);
      log.info('Release branch created', { releaseId, branch: release.releaseBranch });
    }

    // Get or create release instructions
    try {
      release.releaseInstructions = await getOrCreateReleaseInstructions(
        isolatedPath,
        this.copilot,
      );
      await this.store.saveRelease(release);
      log.info('Release instructions ready', {
        releaseId,
        source: release.releaseInstructions.source,
      });
    } catch (error) {
      log.warn('Failed to create release instructions, continuing without them', {
        releaseId,
        error: (error as Error).message,
      });
    }

    log.info('Release prepared', { releaseId });
  }

  async addPlansToRelease(releaseId: string, planIds: string[]): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    log.info('Adding plans to release', { releaseId, planIds, currentStatus: release.status });

    // Validate all plan IDs exist and are in terminal states
    for (const planId of planIds) {
      const plan = this.planRunner.get(planId);
      if (!plan) {
        throw new Error(`Plan not found: ${planId}`);
      }
      const sm = this.planRunner.getStateMachine(planId);
      const planStatus = sm?.computePlanStatus();
      if (planStatus !== 'succeeded' && planStatus !== 'partial') {
        throw new Error(`Plan ${planId} must be succeeded or partial, but is ${planStatus}`);
      }
    }

    // Add to planIds list
    release.planIds.push(...planIds);
    await this.store.saveRelease(release);

    // If we're in a state where we can merge, merge the new plans
    if (release.status === 'merging' || release.status === 'pr-active' || release.status === 'monitoring') {
      const isolatedPath = release.isolatedRepoPath!;
      
      // Merge the new plans
      const mergeResults: import('./types/release').ReleaseMergeResult[] = [];
      for (const planId of planIds) {
        const plan = this.planRunner.get(planId)!;
        const sourceBranch = plan.spec.targetBranch ?? plan.targetBranch ?? 'main';
        
        try {
          await this.git.repository.fetch(isolatedPath, {
            remote: 'origin',
            log: gitLog,
          });

          const mergeResult = await this.git.merge.merge({
            cwd: isolatedPath,
            source: `origin/${sourceBranch}`,
            target: release.releaseBranch,
            message: `Merge plan '${plan.spec.name}' (${planId}) from ${sourceBranch}`,
            fastForward: false,
            log: gitLog,
          });

          if (mergeResult.success) {
            mergeResults.push({
              planId,
              planName: plan.spec.name,
              sourceBranch,
              success: true,
              conflictsResolved: mergeResult.hasConflicts,
            });
          } else {
            // Try to resolve conflicts
            const conflictResult = await this._resolveConflictsWithCopilot(
              release,
              isolatedPath,
              sourceBranch,
              plan.spec.name,
            );
            mergeResults.push({
              planId,
              planName: plan.spec.name,
              sourceBranch,
              success: conflictResult.success,
              conflictsResolved: conflictResult.success,
              error: conflictResult.error,
            });
          }
        } catch (error) {
          log.error('Failed to merge newly added plan', {
            releaseId,
            planId,
            error: (error as Error).message,
          });
          mergeResults.push({
            planId,
            planName: plan.spec.name,
            sourceBranch,
            success: false,
            error: (error as Error).message,
          });
        }
      }

      // If PR is active, push the changes
      if (release.status === 'pr-active' || release.status === 'monitoring') {
        const pushSuccess = await this.git.repository.push(isolatedPath, {
          remote: 'origin',
          branch: release.releaseBranch,
          log: gitLog,
        });
        if (!pushSuccess) {
          log.error('Failed to push added plans to PR', { releaseId });
        } else {
          log.info('Added plans pushed to PR', { releaseId, planIds });
        }
      }
    }

    this.events.emitReleasePlansAdded(releaseId, planIds);
    log.info('Plans added to release', { releaseId, planIds });
  }

  async adoptExistingPR(releaseId: string, prNumber: number): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    if (release.status !== 'drafting' && release.status !== 'ready-for-pr') {
      throw new Error(`Release ${releaseId} must be in drafting or ready-for-pr state to adopt PR (current: ${release.status})`);
    }

    log.info('Adopting existing PR for release', { releaseId, prNumber });

    // Get PR URL from the PR service
    const isolatedPath = release.isolatedRepoPath || release.repoPath;
    const prService = await this.prServiceFactory.getServiceForRepo(isolatedPath);
    
    // TODO: Add getPRUrl method to IRemotePRService interface
    // For now, construct a generic URL
    const prUrl = `https://github.com/owner/repo/pull/${prNumber}`;

    release.prNumber = prNumber;
    release.prUrl = prUrl;
    await this.store.saveRelease(release);

    // Transition to pr-active state
    await this._transitionStatus(release, 'pr-active', `Adopted existing PR #${prNumber}`);

    this.events.emitReleasePrAdopted(releaseId, prNumber);
    log.info('Existing PR adopted', { releaseId, prNumber, prUrl });
  }

  getFlowType(releaseId: string): 'from-plans' | 'from-branch' | undefined {
    const release = this.releases.get(releaseId);
    return release?.source;
  }

  // ── EventEmitter Typed Overloads ───────────────────────────────────────

  on(event: 'releaseCreated', handler: (release: ReleaseDefinition) => void): this;
  on(event: 'releaseStatusChanged', handler: (release: ReleaseDefinition) => void): this;
  on(event: 'releaseProgress', handler: (releaseId: string, progress: ReleaseProgress) => void): this;
  on(event: 'releasePRCycle', handler: (releaseId: string, cycle: import('./types/release').PRMonitorCycle) => void): this;
  on(event: 'releaseCompleted', handler: (release: ReleaseDefinition) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  /**
   * Merge all plan commits into the release branch.
   * For each plan, fetch its target branch and merge --no-ff.
   */
  private async _mergeAllPlans(release: ReleaseDefinition): Promise<ReleaseMergeResult[]> {
    const results: ReleaseMergeResult[] = [];
    const isolatedPath = release.isolatedRepoPath!;

    for (let i = 0; i < release.planIds.length; i++) {
      const planId = release.planIds[i];
      const plan = this.planRunner.get(planId);
      if (!plan) {
        log.error('Plan not found during merge', { releaseId: release.id, planId });
        results.push({
          planId,
          planName: planId,
          sourceBranch: 'unknown',
          success: false,
          error: 'Plan not found',
        });
        continue;
      }

      const sourceBranch = plan.spec.targetBranch ?? plan.targetBranch ?? 'main';
      log.info('Merging plan into release branch', {
        releaseId: release.id,
        planId,
        sourceBranch,
        progress: `${i + 1}/${release.planIds.length}`,
      });

      try {
        // Fetch the plan's target branch from origin
        await this.git.repository.fetch(isolatedPath, {
          remote: 'origin',
          log: gitLog,
        });

        // Merge with --no-ff to preserve plan boundary commits
        const mergeResult = await this.git.merge.merge({
          cwd: isolatedPath,
          source: `origin/${sourceBranch}`,
          target: release.releaseBranch,
          message: `Merge plan '${plan.spec.name}' (${planId}) from ${sourceBranch}`,
          fastForward: false,
          log: gitLog,
        });

        if (mergeResult.success) {
          results.push({
            planId,
            planName: plan.spec.name,
            sourceBranch,
            success: true,
            conflictsResolved: mergeResult.hasConflicts,
          });
          log.info('Plan merged successfully', { releaseId: release.id, planId });
        } else {
          // Handle conflicts via Copilot CLI
          log.warn('Merge conflicts detected, attempting auto-resolution', {
            releaseId: release.id,
            planId,
          });

          const conflictResult = await this._resolveConflictsWithCopilot(
            release,
            isolatedPath,
            sourceBranch,
            plan.spec.name,
          );

          results.push({
            planId,
            planName: plan.spec.name,
            sourceBranch,
            success: conflictResult.success,
            conflictsResolved: conflictResult.success,
            error: conflictResult.error,
          });
        }

        // Emit progress
        this.events.emitReleaseProgress(release.id, {
          status: release.status,
          currentStep: `Merging plan ${i + 1}/${release.planIds.length}`,
          mergeProgress: {
            merged: i + 1,
            total: release.planIds.length,
            results,
          },
        });
      } catch (error) {
        log.error('Failed to merge plan', {
          releaseId: release.id,
          planId,
          error: (error as Error).message,
        });
        results.push({
          planId,
          planName: plan.spec.name,
          sourceBranch,
          success: false,
          error: (error as Error).message,
        });
      }
    }

    return results;
  }

  /**
   * Resolve merge conflicts using Copilot CLI.
   */
  private async _resolveConflictsWithCopilot(
    release: ReleaseDefinition,
    cwd: string,
    sourceBranch: string,
    planName: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conflicts = await this.git.merge.listConflicts(cwd);
      log.info('Attempting to resolve conflicts with Copilot', {
        releaseId: release.id,
        conflictCount: conflicts.length,
      });

      const task = `Resolve merge conflicts in the following files: ${conflicts.join(', ')}. Accept changes from ${sourceBranch} (plan: ${planName}) where appropriate, maintaining code integrity.`;

      const result = await this.copilot.run({
        cwd,
        task,
        sessionId: `release-${release.id}-conflict`,
      });

      if (result.success) {
        // Continue the merge
        const continueSuccess = await this.git.merge.continueAfterResolve(
          cwd,
          `Merge plan '${planName}' from ${sourceBranch} (conflicts auto-resolved)`,
          gitLog,
        );
        return { success: continueSuccess };
      } else {
        // Abort the merge
        await this.git.merge.abort(cwd, gitLog);
        return { success: false, error: 'Copilot failed to resolve conflicts' };
      }
    } catch (error) {
      log.error('Conflict resolution failed', {
        releaseId: release.id,
        error: (error as Error).message,
      });
      try {
        await this.git.merge.abort(cwd, gitLog);
      } catch {
        // Ignore abort errors
      }
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Execute a git command in the isolated repository for a release.
   */
  private async _execGitInIsolated(releaseId: string, args: string[]): Promise<void> {
    const path = await this.isolatedRepos.getRepoPath(releaseId);
    if (!path) {
      throw new Error(`No isolated repo found for release: ${releaseId}`);
    }

    // Git operations are executed via IGitOperations interface, not direct exec
    // This helper would be used if we needed raw git commands, but IGitOperations covers our needs
    log.debug('Git operation in isolated repo', { releaseId, path, args });
  }

  /**
   * Build PR body text from release metadata and merge results.
   */
  private _buildPRBody(release: ReleaseDefinition, mergeResults: ReleaseMergeResult[]): string {
    const lines: string[] = [];
    lines.push(`# Release: ${release.name}`);
    lines.push('');
    lines.push('This release combines the following plans:');
    lines.push('');

    for (const result of mergeResults) {
      const status = result.success ? '✅' : '❌';
      const conflicts = result.conflictsResolved ? ' (conflicts resolved)' : '';
      lines.push(`- ${status} **${result.planName}** from \`${result.sourceBranch}\`${conflicts}`);
      if (result.error) {
        lines.push(`  - Error: ${result.error}`);
      }
    }

    lines.push('');
    lines.push(`**Target Branch:** \`${release.targetBranch}\``);
    lines.push(`**Release Branch:** \`${release.releaseBranch}\``);

    return lines.join('\n');
  }

  /**
   * Transition release to a new status using the state machine.
   * 
   * @param release - The release to transition
   * @param newStatus - The target status
   * @param reason - Optional reason for the transition
   * @throws If transition is invalid
   */
  private async _transitionStatus(
    release: ReleaseDefinition,
    newStatus: ReleaseStatus,
    reason?: string
  ): Promise<void> {
    const stateMachine = this.stateMachines.get(release.id);
    if (!stateMachine) {
      throw new Error(`State machine not found for release ${release.id}`);
    }

    const result = stateMachine.transition(newStatus, reason);
    if (!result.success) {
      throw new Error(`Invalid transition for release ${release.id}: ${result.error}`);
    }

    // Persist the updated release state
    await this.store.saveRelease(release);
  }

  /**
   * Get human-readable description of current step based on status.
   */
  private _getCurrentStep(release: ReleaseDefinition): string {
    switch (release.status) {
      case 'drafting':
        return 'Configuring release';
      case 'preparing':
        return 'Executing preparation tasks';
      case 'ready-for-pr':
        return 'Ready to create PR';
      case 'merging':
        return 'Merging plan commits';
      case 'ready-for-pr':
        return 'Ready to create pull request';
      case 'creating-pr':
        return 'Creating pull request';
      case 'pr-active':
        return 'Pull request created';
      case 'monitoring':
        return 'Monitoring PR for feedback';
      case 'addressing':
        return 'Addressing PR feedback';
      case 'succeeded':
        return 'Release completed';
      case 'failed':
        return 'Release failed';
      case 'canceled':
        return 'Release canceled';
      default:
        return 'Unknown';
    }
  }

  /**
   * Generate a unique release ID.
   */
  private _generateReleaseId(): string {
    return `rel-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Load persisted releases from storage on startup.
   */
  private async _loadPersistedReleases(): Promise<void> {
    try {
      const releases = await this.store.loadAllReleases();
      for (const release of releases) {
        // Ensure required fields exist for backward compatibility
        if (!release.stateHistory) {
          release.stateHistory = [
            {
              from: release.status,
              to: release.status,
              timestamp: release.createdAt,
              reason: 'Loaded from persisted state',
            },
          ];
        }
        if (!release.source) {
          release.source = release.planIds.length > 0 ? 'from-plans' : 'from-branch';
        }

        // Create state machine for this release
        const stateMachine = new ReleaseStateMachine(release);
        
        // Forward state machine events to release events
        stateMachine.on('transition', (event) => {
          this.events.emitReleaseStatusChanged(event.releaseId, event.from, event.to);
        });
        stateMachine.on('completed', (releaseId, finalStatus) => {
          if (finalStatus === 'succeeded') {
            this.events.emitReleaseCompleted(release);
          } else if (finalStatus === 'failed') {
            this.events.emitReleaseFailed(release, release.error || 'Unknown error');
          } else if (finalStatus === 'canceled') {
            this.events.emitReleaseCanceled(releaseId);
          }
        });

        this.releases.set(release.id, release);
        this.stateMachines.set(release.id, stateMachine);
      }
      log.info('Loaded persisted releases', { count: releases.length });
    } catch (error) {
      log.error('Failed to load persisted releases', { error: (error as Error).message });
    }
  }
}
