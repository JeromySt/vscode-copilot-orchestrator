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
import * as path from 'path';
import { promises as fs } from 'fs';
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
      flowType: options.planIds.length > 0 ? 'from-plans' : 'from-branch',
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
    if (release.status !== 'drafting') {
      throw new Error(`Release ${releaseId} already started (status: ${release.status})`);
    }

    log.info('Starting release', { releaseId, name: release.name });

    try {
      // Phase 1: Create isolated repository clone
      await this._transitionStatus(release, 'merging');
      const isolatedRepo = await this.isolatedRepos.createIsolatedRepo(
        releaseId,
        release.repoPath,
        release.targetBranch,
      );
      release.isolatedRepoPath = isolatedRepo.clonePath;
      await this.store.saveRelease(release);
      log.info('Isolated repo created', { releaseId, path: isolatedRepo.clonePath });

      // Phase 2: Create release branch in isolated clone
      await this.git.branches.checkout(isolatedRepo.clonePath, release.targetBranch);
      await this.git.branches.create(
        release.releaseBranch,
        release.targetBranch,
        isolatedRepo.clonePath,
        gitLog,
      );
      await this.git.branches.checkout(isolatedRepo.clonePath, release.releaseBranch);
      log.info('Release branch created', { releaseId, branch: release.releaseBranch });

      // Phase 3: Merge all plan branches
      const mergeResults = await this._mergeAllPlans(release);
      log.info('All plans merged', { releaseId, succeeded: mergeResults.filter((r) => r.success).length });

      // Phase 4: Push release branch
      const pushSuccess = await this.git.repository.push(isolatedRepo.clonePath, {
        remote: 'origin',
        branch: release.releaseBranch,
        log: gitLog,
      });
      if (!pushSuccess) {
        throw new Error('Failed to push release branch to origin');
      }
      log.info('Release branch pushed', { releaseId, branch: release.releaseBranch });

      // Phase 5: Create pull request
      await this._transitionStatus(release, 'creating-pr');
      const prService = await this.prServiceFactory.getServiceForRepo(isolatedRepo.clonePath);
      const prResult = await prService.createPR({
        baseBranch: release.targetBranch,
        headBranch: release.releaseBranch,
        title: release.name,
        body: this._buildPRBody(release, mergeResults),
        cwd: isolatedRepo.clonePath,
      });

      release.prNumber = prResult.prNumber;
      release.prUrl = prResult.prUrl;
      await this.store.saveRelease(release);
      log.info('PR created', { releaseId, prNumber: prResult.prNumber, prUrl: prResult.prUrl });

      // Phase 6: Start PR monitoring
      await this._transitionStatus(release, 'monitoring');
      await this.prMonitor.startMonitoring(
        releaseId,
        prResult.prNumber,
        isolatedRepo.clonePath,
        release.releaseBranch,
      );

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

  // ── State Management ───────────────────────────────────────────────────

  async transitionToState(releaseId: string, newStatus: ReleaseStatus, reason?: string): Promise<boolean> {
    const release = this.releases.get(releaseId);
    if (!release) {
      log.warn('Cannot transition: release not found', { releaseId });
      return false;
    }

    const stateMachine = this.stateMachines.get(releaseId);
    if (!stateMachine) {
      log.error('State machine not found', { releaseId });
      return false;
    }

    const result = stateMachine.transition(newStatus, reason);
    if (result.success) {
      // Initialize prep tasks when entering the preparing state
      if (newStatus === 'preparing' && (!release.prepTasks || release.prepTasks.length === 0)) {
        const { loadReleaseTasks, getDefaultReleaseTasks } = await import('./releaseTaskLoader');
        const loadedTasks = await loadReleaseTasks(release.repoPath);
        release.prepTasks = loadedTasks.length > 0 ? loadedTasks : getDefaultReleaseTasks();
      }
      await this.store.saveRelease(release);
    }
    return result.success;
  }

  // ── Preparation Tasks ──────────────────────────────────────────────────

  /**
   * Get the log directory path for task logs.
   * Path: `.orchestrator/release/<sanitized-branch>/task-logs/`
   */
  private getTaskLogDirectory(release: ReleaseDefinition): string {
    const sanitized = release.releaseBranch.replace(/[^a-zA-Z0-9._-]/g, '-');
    return path.join(release.repoPath, '.orchestrator', 'release', sanitized, 'task-logs');
  }

  async executePreparationTask(releaseId: string, taskId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    const task = release.prepTasks?.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Preparation task not found: ${taskId}`);
    }

    log.info('Executing preparation task', { releaseId, taskId, taskTitle: task.title });

    // Setup log file infrastructure
    const logDir = this.getTaskLogDirectory(release);
    await fs.mkdir(logDir, { recursive: true });
    
    const logFilePath = path.join(logDir, `${taskId}.log`);
    task.logFilePath = logFilePath;
    task.startedAt = Date.now();
    task.status = 'running';
    
    await this.store.saveRelease(release);
    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
    
    // Emit started log line
    const startedMessage = `Task started: ${task.title}\n`;
    await fs.appendFile(logFilePath, startedMessage);
    this.events.emitReleaseTaskOutput(releaseId, taskId, startedMessage);

    try {
      // Execute task using Copilot CLI
      const cwd = release.isolatedRepoPath || release.repoPath;
      const taskDescription = task.description || task.title;
      
      if (this.copilot) {
        const result = await this.copilot.run({
          cwd,
          task: taskDescription,
          onOutput: async (line: string) => {
            // Stream every CLI output line to log file AND event
            const logLine = `${line}\n`;
            try { await fs.appendFile(logFilePath, logLine); } catch { /* ignore write errors */ }
            this.events.emitReleaseTaskOutput(releaseId, taskId, line);
          },
        });

        if (result.success) {
          task.status = 'completed';
          task.completedAt = Date.now();
          const completedMessage = `Task completed successfully\n`;
          await fs.appendFile(logFilePath, completedMessage);
          this.events.emitReleaseTaskOutput(releaseId, taskId, completedMessage);
          log.info('Preparation task completed', { releaseId, taskId });
        } else {
          task.status = 'failed';
          task.completedAt = Date.now();
          task.error = result.error || 'Task execution failed';
          const failedMessage = `Task failed: ${task.error}\n`;
          await fs.appendFile(logFilePath, failedMessage);
          this.events.emitReleaseTaskOutput(releaseId, taskId, failedMessage);
          log.error('Preparation task failed', { releaseId, taskId, error: task.error });
        }
      } else {
        // No Copilot runner — mark completed immediately for manual flow
        task.status = 'completed';
        task.completedAt = Date.now();
        const completedMessage = `Task auto-completed (no runner)\n`;
        await fs.appendFile(logFilePath, completedMessage);
        this.events.emitReleaseTaskOutput(releaseId, taskId, completedMessage);
        log.info('Preparation task auto-completed (no runner)', { releaseId, taskId });
      }
    } catch (error) {
      task.status = 'failed';
      task.completedAt = Date.now();
      task.error = (error as Error).message;
      const errorMessage = `Task execution error: ${task.error}\n`;
      await fs.appendFile(logFilePath, errorMessage);
      this.events.emitReleaseTaskOutput(releaseId, taskId, errorMessage);
      log.error('Preparation task execution error', { releaseId, taskId, error: task.error });
    }

    await this.store.saveRelease(release);
    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  async completePreparationTask(releaseId: string, taskId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    const task = release.prepTasks?.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Preparation task not found: ${taskId}`);
    }

    log.info('Manually completing preparation task', { releaseId, taskId });

    task.status = 'completed';
    task.completedAt = Date.now();
    
    // Write log entry for manual completion
    if (task.logFilePath) {
      const completedMessage = `Task manually marked as completed\n`;
      await fs.appendFile(task.logFilePath, completedMessage);
      this.events.emitReleaseTaskOutput(releaseId, taskId, completedMessage);
    } else {
      // Create log file if it doesn't exist
      const logDir = this.getTaskLogDirectory(release);
      await fs.mkdir(logDir, { recursive: true });
      const logFilePath = path.join(logDir, `${taskId}.log`);
      task.logFilePath = logFilePath;
      const completedMessage = `Task manually marked as completed\n`;
      await fs.appendFile(logFilePath, completedMessage);
      this.events.emitReleaseTaskOutput(releaseId, taskId, completedMessage);
    }

    await this.store.saveRelease(release);
    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  async skipPreparationTask(releaseId: string, taskId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    const task = release.prepTasks?.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Preparation task not found: ${taskId}`);
    }

    log.info('Skipping preparation task', { releaseId, taskId });

    task.status = 'skipped';
    task.completedAt = Date.now();
    
    // Write log entry for skip
    if (task.logFilePath) {
      const skippedMessage = `Task skipped by user\n`;
      await fs.appendFile(task.logFilePath, skippedMessage);
      this.events.emitReleaseTaskOutput(releaseId, taskId, skippedMessage);
    } else {
      // Create log file if it doesn't exist
      const logDir = this.getTaskLogDirectory(release);
      await fs.mkdir(logDir, { recursive: true });
      const logFilePath = path.join(logDir, `${taskId}.log`);
      task.logFilePath = logFilePath;
      const skippedMessage = `Task skipped by user\n`;
      await fs.appendFile(logFilePath, skippedMessage);
      this.events.emitReleaseTaskOutput(releaseId, taskId, skippedMessage);
    }

    await this.store.saveRelease(release);
    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  // ── Plan Management ────────────────────────────────────────────────────

  async addPlansToRelease(releaseId: string, planIds: string[]): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    log.info('Adding plans to release', { releaseId, planIds });

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
      // Avoid duplicates
      if (release.planIds.includes(planId)) {
        log.warn('Plan already in release, skipping', { releaseId, planId });
        continue;
      }
      release.planIds.push(planId);
    }

    await this.store.saveRelease(release);

    // If in pr-active state, merge the new plans and push
    if (release.status === 'pr-active' && release.isolatedRepoPath) {
      log.info('Release is pr-active, merging new plans and pushing', { releaseId });
      try {
        const mergeResults = await this._mergeAllPlans(release);
        const pushSuccess = await this.git.repository.push(release.isolatedRepoPath, {
          remote: 'origin',
          branch: release.releaseBranch,
          log: gitLog,
        });
        if (!pushSuccess) {
          log.error('Failed to push new plan merges', { releaseId });
        }
      } catch (error) {
        log.error('Failed to merge new plans', { releaseId, error: (error as Error).message });
      }
    }

    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  // ── PR Management ──────────────────────────────────────────────────────

  async createPR(releaseId: string, asDraft?: boolean): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    if (release.status !== 'ready-for-pr') {
      throw new Error(`Cannot create PR: release status is ${release.status}, must be ready-for-pr`);
    }

    log.info('Creating PR', { releaseId, asDraft });

    await this._transitionStatus(release, 'creating-pr');

    try {
      const isolatedPath = release.isolatedRepoPath!;
      const prService = await this.prServiceFactory.getServiceForRepo(isolatedPath);
      
      const prResult = await prService.createPR({
        baseBranch: release.targetBranch,
        headBranch: release.releaseBranch,
        title: release.name,
        body: this._buildPRBody(release, []),
        cwd: isolatedPath,
      });

      release.prNumber = prResult.prNumber;
      release.prUrl = prResult.prUrl;
      await this.store.saveRelease(release);

      log.info('PR created', { releaseId, prNumber: prResult.prNumber, prUrl: prResult.prUrl });

      await this._transitionStatus(release, 'pr-active');
    } catch (error) {
      log.error('Failed to create PR', { releaseId, error: (error as Error).message });
      release.error = (error as Error).message;
      await this._transitionStatus(release, 'failed');
      throw error;
    }
  }

  async adoptPR(releaseId: string, prNumber: number): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    log.info('Adopting existing PR', { releaseId, prNumber });

    release.prNumber = prNumber;
    // PR URL can be constructed from repo info if needed
    release.prUrl = `PR #${prNumber}`;

    await this.store.saveRelease(release);
    await this._transitionStatus(release, 'pr-active', 'Adopted existing PR');

    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  async startMonitoring(releaseId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    if (!release.prNumber) {
      throw new Error('Cannot start monitoring: no PR number set');
    }

    log.info('Starting PR monitoring', { releaseId, prNumber: release.prNumber });

    await this._transitionStatus(release, 'monitoring');

    const isolatedPath = release.isolatedRepoPath || release.repoPath;
    await this.prMonitor.startMonitoring(
      releaseId,
      release.prNumber,
      isolatedPath,
      release.releaseBranch,
    );

    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  async stopMonitoring(releaseId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    log.info('Stopping PR monitoring', { releaseId });

    if (this.prMonitor.isMonitoring(releaseId)) {
      this.prMonitor.stopMonitoring(releaseId);
    }

    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  getTaskLogFilePath(releaseId: string, taskId: string): string | undefined {
    const release = this.releases.get(releaseId);
    if (!release) {
      return undefined;
    }

    const task = release.prepTasks?.find((t) => t.id === taskId);
    return task?.logFilePath;
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
        return 'Preparing release (docs, versioning, checks)';
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
   * Transition release to preparing status and initialize preparation tasks.
   * @private
   */
  private async prepareRelease(releaseId: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    log.info('Preparing release', { releaseId });

    // Transition to preparing status
    const success = await this.transitionToState(releaseId, 'preparing', 'Starting preparation phase');
    if (!success) {
      throw new Error(`Failed to transition release ${releaseId} to preparing status`);
    }

    // Initialize preparation tasks if not already set
    if (!release.prepTasks || release.prepTasks.length === 0) {
      const { loadReleaseTasks, getDefaultReleaseTasks } = await import('./releaseTaskLoader');
      const loadedTasks = await loadReleaseTasks(release.repoPath);
      release.prepTasks = loadedTasks.length > 0 ? loadedTasks : getDefaultReleaseTasks();
      await this.store.saveRelease(release);
    }
  }

  /**
   * Check if all required preparation tasks are complete.
   * @private
   */
  private areRequiredTasksComplete(releaseId: string): boolean {
    const release = this.releases.get(releaseId);
    if (!release) {
      return false;
    }

    const tasks = release.prepTasks || [];
    const requiredTasks = tasks.filter(t => t.required);
    
    // All required tasks must be either completed or skipped (though required tasks shouldn't be skipped)
    return requiredTasks.every(t => t.status === 'completed' || t.status === 'skipped');
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
