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
import { parseReviewFindings } from './reviewFindingParser';
import type { ReviewFindingStatus } from './types/release';

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
    private readonly providerDetector?: import('../interfaces/IRemoteProviderDetector').IRemoteProviderDetector,
    private readonly dialogService?: import('../interfaces/IDialogService').IDialogService,
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

    // Listen for fix plan completions to run post-fix PR actions (push, reply, resolve)
    this.planRunner.on('planCompleted', (plan: any, status: string) => {
      this._onFixPlanCompleted(plan, status).catch((err) => {
        log.error('Fix plan post-completion failed', { planId: plan?.id, error: (err as Error).message });
      });
    });

    // Listen for PR monitor cycle completions and forward to release events + panel refresh
    if (typeof (this.prMonitor as any).on === 'function') {
      (this.prMonitor as any).on('cycleComplete', (releaseId: string, cycle: any) => {
        // Update monitoring stats on the release for panel rendering
        const rel = this.releases.get(releaseId);
        if (rel) {
          const checks = cycle.checks || [];
          const comments = cycle.comments || [];
          const alerts = cycle.securityAlerts || [];

          // Mark previously-addressed comments as resolved.
          // Issue comments and top-level reviews lack GitHub thread resolution,
          // so we track which ones we've replied to and treat them as resolved.
          const addressed = new Set(rel.addressedCommentIds || []);
          for (const c of comments) {
            if (c.isResolved) continue;
            // Mark if we previously addressed this comment
            if (addressed.has(c.id)) {
              c.isResolved = true;
              continue;
            }
            // Filter out our own automated reply comments so they don't appear as new findings,
            // including replies captured within a comment thread.
            const hasAutomatedFixReply = (
              (typeof c.body === 'string' && c.body.includes('\u2705 Addressed in automated fix'))
              || c.replies?.some((reply: any) => (
                typeof reply.body === 'string' && reply.body.includes('\u2705 Addressed in automated fix')
              ))
            );
            if (hasAutomatedFixReply) {
              c.isResolved = true;
            }
          }

          rel.monitoringStats = {
            checksPass: checks.filter((c: any) => c.status === 'passing' || c.status === 'skipped').length,
            checksFail: checks.filter((c: any) => c.status === 'failing').length,
            checksPending: checks.filter((c: any) => c.status === 'pending').length,
            unresolvedThreads: comments.filter((c: any) => !c.isResolved).length,
            unresolvedAlerts: alerts.filter((a: any) => !a.resolved).length,
            cycleCount: (rel.monitoringStats?.cycleCount || 0) + 1,
            lastCycleAt: Date.now(),
          };
          // Store the full cycle so the panel can seed Pending Actions on open
          rel.lastCycle = cycle;
          this.store.saveRelease(rel).catch(() => {});

          // ── Auto-fix: if enabled, automatically address new unresolved findings ──
          if (rel.autoFixEnabled) {
            const autoFixedSet = new Set(rel.autoFixedFindingIds || []);
            const newFindings: any[] = [];

            for (const c of comments) {
              if (!c.isResolved) {
                const findingId = 'comment-' + c.id;
                if (!autoFixedSet.has(findingId)) {
                  newFindings.push({
                    type: 'comment', id: findingId,
                    commentId: c.id, author: c.author, body: c.body,
                    path: c.path, line: c.line, source: c.source,
                    threadId: c.threadId, url: c.url, nodeId: c.nodeId,
                  });
                }
              }
            }
            for (const ch of checks) {
              if (ch.status === 'failing') {
                const findingId = 'check-' + (ch.name || '').replace(/[^a-zA-Z0-9]/g, '-');
                if (!autoFixedSet.has(findingId)) {
                  newFindings.push({
                    type: 'check', id: findingId,
                    name: ch.name, status: ch.status, url: ch.url,
                  });
                }
              }
            }
            for (const a of alerts) {
              if (!a.resolved) {
                const findingId = 'alert-' + a.id;
                if (!autoFixedSet.has(findingId)) {
                  newFindings.push({
                    type: 'alert', id: findingId,
                    alertId: a.id, severity: a.severity,
                    description: a.description, file: a.file,
                  });
                }
              }
            }

            if (newFindings.length > 0) {
              log.info('Auto-fix: addressing new findings', {
                releaseId, count: newFindings.length,
              });
              if (!rel.autoFixedFindingIds) rel.autoFixedFindingIds = [];
              for (const f of newFindings) rel.autoFixedFindingIds.push(f.id);
              if (rel.autoFixedFindingIds.length > 500) {
                rel.autoFixedFindingIds = rel.autoFixedFindingIds.slice(-500);
              }
              this.store.saveRelease(rel).catch(() => {});
              this.emit('findingsProcessing', releaseId, newFindings.map((f: any) => f.id), 'queued');
              this.addressFindings(releaseId, newFindings).catch((err) => {
                log.error('Auto-fix failed', { releaseId, error: (err as Error).message });
              });
            }
          }
        }
        this.events.emitReleasePrCycle(releaseId, cycle);
        this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
      });

      // Forward monitoring stopped events
      (this.prMonitor as any).on('monitoringStopped', (releaseId: string, totalCycles: number) => {
        this.emit('monitoringStopped', releaseId, totalCycles);
      });
    }

    // Persist action log entries on the release so they survive webview re-renders.
    // The webview seeds ActionLogControl from releaseData.actionLog on initial render.
    this.on('releaseActionTaken', (releaseId: string, action: any) => {
      const rel = this.releases.get(releaseId);
      if (rel) {
        if (!rel.actionLog) { rel.actionLog = []; }
        rel.actionLog.unshift(action);
        // Cap at 100 entries to avoid bloating serialization
        if (rel.actionLog.length > 100) { rel.actionLog.length = 100; }
      }
    });

    // Persist CLI sessions so they survive webview re-renders/reopens.
    // Buffer output lines during active sessions, then store on the release when complete.
    const activeSessions = new Map<string, { releaseId: string; id: string; label: string; lines: string[]; startTime: number }>();

    this.on('cliSessionStart', (releaseId: string, sessionId: string, label: string) => {
      activeSessions.set(sessionId, { releaseId, id: sessionId, label, lines: [], startTime: Date.now() });
    });
    this.on('cliSessionOutput', (_releaseId: string, sessionId: string, line: string) => {
      const s = activeSessions.get(sessionId);
      if (s) s.lines.push(line);
    });
    this.on('cliSessionEnd', (releaseId: string, sessionId: string, success: boolean) => {
      const s = activeSessions.get(sessionId);
      activeSessions.delete(sessionId);
      const rel = this.releases.get(releaseId);
      if (rel && s) {
        if (!rel.cliSessions) rel.cliSessions = [];
        // Keep last 500 lines per session to avoid storage bloat
        const maxLines = 500;
        const trimmedLines = s.lines.length > maxLines ? s.lines.slice(-maxLines) : s.lines;
        rel.cliSessions.unshift({
          id: s.id,
          label: s.label,
          lines: trimmedLines,
          success,
          startTime: s.startTime,
          endTime: Date.now(),
        });
        // Cap at 10 stored sessions
        if (rel.cliSessions.length > 10) rel.cliSessions.length = 10;
        this.store.saveRelease(rel).catch(() => {});
      }
    });

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
      await this._transitionStatus(release, 'ready-for-pr');
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
      await this._transitionStatus(release, 'pr-active');
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

      const unresolvedThreads = lastCycle?.comments.filter((c) => !c.isResolved).length || 0;
      const failingChecks = lastCycle?.checks.filter((c) => c.status === 'failing').length || 0;
      const unresolvedAlerts = lastCycle?.securityAlerts.filter((a) => !a.resolved).length || 0;

      progress.prMonitoring = {
        cyclesCompleted: cycles.length,
        lastCycle,
        unresolvedThreads,
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
      // Initialize tasks when entering the preparing state
      if (newStatus === 'preparing') {
        if (!release.preparationTasks || release.preparationTasks.length === 0) {
          const { getDefaultPrepTasks } = await import('./releasePreparation');
          release.preparationTasks = getDefaultPrepTasks(release);
        }
        if (!release.prepTasks || release.prepTasks.length === 0) {
          const { loadReleaseTasks, getDefaultReleaseTasks } = await import('./releaseTaskLoader');
          const loadedTasks = await loadReleaseTasks(release.repoPath);
          release.prepTasks = loadedTasks.length > 0 ? loadedTasks : getDefaultReleaseTasks();
        }
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

    // Buffer to collect all output for finding parsing
    const outputBuffer: string[] = [];

    try {
      // Execute task using Copilot CLI
      const cwd = release.isolatedRepoPath || release.repoPath;
      let taskDescription = task.description || task.title;
      
      // Add structured output instructions for review tasks
      if (task.id === 'ai-review' || task.id.includes('review')) {
        taskDescription += '\n\nIMPORTANT: After completing your review, output your findings in this exact format:\n' +
          '<!-- FINDINGS_START -->\n' +
          '[{"severity":"warning|error|info|suggestion","title":"Short title","description":"Detailed explanation","filePath":"relative/path.ts","line":42,"category":"security|performance|style|bug|architecture"}]\n' +
          '<!-- FINDINGS_END -->\n' +
          'Output the findings as a valid JSON array between the markers. Include ALL findings you discovered.';
      }
      
      if (this.copilot) {
        const result = await this.copilot.run({
          cwd,
          task: taskDescription,
          timeout: 0, // No timeout for release prep tasks
          onOutput: async (line: string) => {
            // Collect output for finding parsing
            outputBuffer.push(line);
            
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
      
      // Parse findings from collected output (try buffer first, then log file)
      let fullOutput = outputBuffer.join('\n');
      if (!fullOutput.includes('FINDINGS_START') && logFilePath) {
        try {
          fullOutput = await fs.readFile(logFilePath, 'utf-8');
        } catch { /* ignore read errors */ }
      }
      const findings = parseReviewFindings(fullOutput);
      if (findings.length > 0) {
        task.findings = findings;
        log.info('Parsed review findings', { releaseId, taskId, count: findings.length });
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

  async updateFindingStatus(
    releaseId: string,
    taskId: string,
    findingId: string,
    status: ReviewFindingStatus,
    note?: string
  ): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    const task = release.prepTasks?.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Preparation task not found: ${taskId}`);
    }

    if (!task.findings || task.findings.length === 0) {
      throw new Error(`No findings found for task: ${taskId}`);
    }

    const finding = task.findings.find((f) => f.id === findingId);
    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }

    log.info('Updating finding status', { releaseId, taskId, findingId, status });

    finding.status = status;
    if (note !== undefined) {
      finding.note = note;
    }

    await this.store.saveRelease(release);
    this.events.emitReleaseProgress(releaseId, this.getReleaseProgress(releaseId)!);
  }

  getAllFindings(releaseId: string): import('./types/release').ReviewFinding[] {
    const release = this.releases.get(releaseId);
    if (!release) {
      return [];
    }

    const allFindings: import('./types/release').ReviewFinding[] = [];
    
    if (release.prepTasks) {
      for (const task of release.prepTasks) {
        if (task.findings && task.findings.length > 0) {
          allFindings.push(...task.findings);
        }
      }
    }

    return allFindings;
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
        await this._mergeAllPlans(release);
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
      // For from-branch releases, always use repoPath (not isolatedRepoPath which may not exist)
      const cwd = release.repoPath;
      
      // Ensure credentials are configured before creating PR
      if (this.providerDetector) {
        try {
          const provider = await this.providerDetector.detect(cwd);
          await this.providerDetector.ensureCredentials(cwd, provider, this.dialogService);
          log.debug('Credentials ensured for PR creation', { releaseId });
        } catch (err) {
          log.warn('Failed to ensure credentials', { releaseId, error: (err as Error).message });
          // Continue anyway - the PR service will attempt its own credential acquisition
        }
      }
      
      const prService = await this.prServiceFactory.getServiceForRepo(cwd);
      
      // Push the release branch to the remote before creating the PR
      log.info('Pushing release branch to remote', { releaseId, branch: release.releaseBranch, cwd });
      try {
        const { execSync } = require('child_process');
        execSync(`git push -u origin ${release.releaseBranch}`, { cwd, stdio: 'pipe' });
        log.info('Release branch pushed', { releaseId, branch: release.releaseBranch });
      } catch (pushErr) {
        log.warn('git push failed, PR creation may fail', { releaseId, error: (pushErr as Error).message });
      }
      
      const prResult = await prService.createPR({
        baseBranch: release.targetBranch,
        headBranch: release.releaseBranch,
        title: release.name,
        body: this._buildPRBody(release, []),
        cwd,
        draft: asDraft,
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
    // Transition through valid states: drafting -> ready-for-pr -> creating-pr -> pr-active
    await this._transitionStatus(release, 'ready-for-pr', 'Adopting existing PR');
    await this._transitionStatus(release, 'creating-pr', 'Adopting existing PR');
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

    // Only transition if not already in monitoring state
    if (release.status !== 'monitoring') {
      await this._transitionStatus(release, 'monitoring');
    }

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

  /**
   * Toggle auto-fix mode for a release.
   * When enabled, new findings from monitoring cycles are automatically sent to AI.
   */
  setAutoFix(releaseId: string, enabled: boolean): void {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }
    release.autoFixEnabled = enabled;
    if (!enabled) {
      // Clear the auto-fixed tracking when disabling so re-enabling starts fresh
      release.autoFixedFindingIds = [];
    }
    log.info('Auto-fix toggled', { releaseId, enabled });
    this.store.saveRelease(release).catch(() => {});
  }

  /**
   * Address selected findings using AI-assisted fixing.
   *
   * 1. Creates one agent job per finding (parallel execution in worktrees)
   * 2. Adds a final verification job that depends on all fix jobs
   * 3. On plan completion, pushes changes and replies to PR comments
   * 4. Each finding links to its specific job's node detail panel
   */
  async addressFindings(releaseId: string, findings: any[]): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`);
    }

    if (findings.length === 0) {
      return;
    }

    log.info('Address findings requested', {
      releaseId,
      findingCount: findings.length,
      types: findings.map((f: any) => f.type),
    });

    const findingIds = findings.map((f: any) => f.id);
    this.emit('findingsProcessing', releaseId, findingIds, 'queued');

    const cwd = release.isolatedRepoPath || release.repoPath;

    // ── 1. Build jobs from findings ──────────────────────────────────
    const jobs: any[] = [];
    const findingJobMap: Record<string, string> = {}; // findingId → producerId
    const producerIds: string[] = [];
    const ts = Date.now();

    // Group check findings by base name (strip matrix params like "(os, node)")
    const checkFindings = findings.filter((f: any) => f.type === 'check');
    const checkGroups = new Map<string, any[]>();
    for (const f of checkFindings) {
      // "build (ubuntu-latest, 20.x)" → "build"
      const baseName = (f.name || 'CI check').replace(/\s*\(.*\)\s*$/, '').trim();
      if (!checkGroups.has(baseName)) checkGroups.set(baseName, []);
      checkGroups.get(baseName)!.push(f);
    }

    // Create one job per check group
    for (const [baseName, checks] of checkGroups) {
      const producerId = 'fix-check-' + baseName.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40) + '-' + ts;
      producerIds.push(producerId);
      for (const f of checks) findingJobMap[f.id] = producerId;

      const checkNames = checks.map((c: any) => c.name).join(', ');
      const checkUrls = checks.filter((c: any) => c.url).map((c: any) => `  URL: ${c.url}`).join('\n');
      const taskDesc = `Fix these failing CI/CD checks (all related to "${baseName}"):\n\n`
        + checks.map((c: any) => `- **${c.name}**: FAILING`).join('\n') + '\n'
        + (checkUrls ? `\n${checkUrls}\n` : '')
        + `\nThese are likely caused by the same root issue. Investigate and fix the common cause.`;

      jobs.push({
        producerId,
        name: `Fix CI: ${baseName}` + (checks.length > 1 ? ` (${checks.length} variants)` : ''),
        task: taskDesc,
        work: `@agent ${taskDesc}`,
        dependencies: [],
        autoHeal: true,
      });
    }

    // One job per comment finding
    for (const f of findings) {
      if (f.type !== 'comment') continue;
      let jobName: string;
      let taskDesc: string;

      const file = f.path ? f.path.split('/').pop() : '';
      const line = f.line ? `:${f.line}` : '';
      jobName = f.path ? `Fix: ${file}${line}` : `Fix: ${f.author || 'review'} comment`;
      taskDesc = `Address this PR review comment:\n\n`
        + `**${f.author || 'Reviewer'}** (${f.source || 'review'}):\n`
        + `${f.body || f.text || ''}\n`
        + (f.path ? `\nFile: ${f.path}${line}\n` : '')
        + `\nFix ONLY this specific issue. Make minimal, targeted changes.`;

      const producerId = 'fix-' + f.id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 50) + '-' + ts;
      producerIds.push(producerId);
      findingJobMap[f.id] = producerId;

      jobs.push({
        producerId,
        name: jobName,
        task: taskDesc,
        work: `@agent ${taskDesc}`,
        dependencies: [],
        autoHeal: true,
      });
    }

    // One job per alert finding
    for (const f of findings) {
      if (f.type !== 'alert') continue;

      const jobName = `Fix: ${(f.description || 'alert').substring(0, 40)}`;
      const taskDesc = `Fix this security alert:\n\n`
        + `**[${(f.severity || 'medium').toUpperCase()}]** ${f.description || ''}\n`
        + (f.file ? `File: ${f.file}\n` : '')
        + `\nFix the security issue.`;

      const producerId = 'fix-' + f.id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 50) + '-' + ts;
      producerIds.push(producerId);
      findingJobMap[f.id] = producerId;

      jobs.push({
        producerId,
        name: jobName,
        task: taskDesc,
        work: `@agent ${taskDesc}`,
        dependencies: [],
        autoHeal: true,
      });
    }

    // ── 2. Add verification job (depends on all fix jobs) ────────────
    const allFindingsSummary = findings.map((f: any) => {
      if (f.type === 'comment') return `- ${f.path || 'general'}: ${(f.body || '').substring(0, 80)}`;
      if (f.type === 'check') return `- CI: ${f.name}`;
      return `- Alert: ${(f.description || '').substring(0, 80)}`;
    }).join('\n');

    jobs.push({
      producerId: 'verify-' + ts,
      name: 'Verify: Review all fixes',
      task: `Review all the fixes made by previous jobs and ensure they are correct.\n\nFindings addressed:\n${allFindingsSummary}\n\nCheck that all issues are fixed, no regressions introduced, and code style is consistent.`,
      work: `@agent Review all fixes for correctness and completeness`,
      dependencies: producerIds,
      autoHeal: false,
      expectsNoChanges: false,
    });

    // ── 3. Create the plan ───────────────────────────────────────────
    const planName = `Fix PR #${release.prNumber || '?'}: ${findings.length} finding(s)`;

    const plan = this.planRunner.enqueue({
      name: planName,
      repoPath: cwd,
      baseBranch: release.releaseBranch,
      targetBranch: release.releaseBranch,
      startPaused: false,
      maxParallel: 4,
      jobs,
    });

    log.info('Fix plan created', {
      releaseId,
      planId: plan.id,
      planName,
      findingCount: findings.length,
      jobCount: jobs.length,
    });

    // ── 4. Associate plan with the release ───────────────────────────
    if (!release.fixPlanIds) release.fixPlanIds = [];
    release.fixPlanIds.push(plan.id);

    if (!release.fixPlanFindings) release.fixPlanFindings = {};
    release.fixPlanFindings[plan.id] = findings;

    if (!release.fixPlanJobMap) release.fixPlanJobMap = {};
    release.fixPlanJobMap[plan.id] = findingJobMap;

    this.store.saveRelease(release).catch(() => {});

    // Signal to UI with plan ID so activity log can link to plan detail
    this.emit('releaseActionTaken', releaseId, {
      type: 'fix-code',
      description: `Created fix plan: ${planName} (${jobs.length} jobs)`,
      success: true,
      planId: plan.id,
      timestamp: Date.now(),
    });
    this.emit('findingsProcessing', releaseId, findingIds, 'processing');
  }

  /**
   * Post-completion handler for fix plans.
   *
   * When a fix plan succeeds: push changes to the release branch, reply to
   * PR comments, resolve threads, and minimize parent reviews.
   */
  private async _onFixPlanCompleted(plan: any, status: string): Promise<void> {
    // Find the release that owns this fix plan
    let release: ReleaseDefinition | undefined;
    let releaseId = '';
    for (const [id, rel] of this.releases) {
      if (rel.fixPlanIds?.includes(plan.id)) {
        release = rel;
        releaseId = id;
        break;
      }
    }
    if (!release) return; // Not a fix plan — ignore

    const findings = release.fixPlanFindings?.[plan.id];
    if (!findings?.length) return;

    const cwd = release.isolatedRepoPath || release.repoPath;

    if (status !== 'succeeded') {
      log.warn('Fix plan did not succeed', { releaseId, planId: plan.id, status });
      const findingIds = findings.map((f: any) => f.id);
      this.emit('findingsProcessing', releaseId, findingIds, 'failed');
      this.emit('releaseActionTaken', releaseId, {
        type: 'fix-code',
        description: `Fix plan failed: ${plan.spec?.name || plan.id}`,
        success: false,
        timestamp: Date.now(),
      });
      return;
    }

    log.info('Fix plan succeeded, running post-fix PR actions', {
      releaseId, planId: plan.id,
    });

    const commentFindings = findings.filter((f: any) => f.type === 'comment');

    // ── 1. Push the fix plan's changes to the release branch ─────────
    let commitHash: string | undefined;
    try {
      // The plan's worktree committed changes — get the commit hash
      const headRef = await this.git.repository.getHead(cwd);
      commitHash = headRef || undefined;

      await this.git.repository.push(cwd, { branch: release.releaseBranch });

      log.info('Fix plan changes pushed', { releaseId, commitHash, branch: release.releaseBranch });

      this.emit('releaseActionTaken', releaseId, {
        type: 'fix-code',
        description: `Pushed fixes for ${findings.length} finding(s)`,
        success: true,
        commitHash,
        timestamp: Date.now(),
      });
    } catch (err) {
      log.error('Failed to push fix plan changes', {
        releaseId, error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 2. Reply to PR comments and resolve threads ──────────────────
    if (release.prNumber && commentFindings.length > 0) {
      let prService;
      try {
        prService = await this.prServiceFactory.getServiceForRepo(cwd);
      } catch { /* logged below */ }

      if (prService) {
        for (const comment of commentFindings) {
          const commentId = comment.commentId || comment.id?.replace('comment-', '');
          if (!commentId) continue;

          try {
            const replyText = `✅ Addressed in automated fix${commitHash ? ` (${commitHash.substring(0, 7)})` : ''}`;

            if (comment.path || comment.threadId) {
              await prService.replyToComment(release.prNumber, commentId, replyText, cwd);
            } else {
              const quotedBody = (comment.body || '').split('\n').map((l: string) => `> ${l}`).join('\n');
              await prService.addIssueComment(release.prNumber, `${quotedBody}\n\n${replyText}`, cwd);
            }

            if (comment.threadId) {
              try { await prService.resolveThread(release.prNumber, comment.threadId, cwd); } catch { /* non-fatal */ }
            }

            if (!comment.path && comment.nodeId && typeof prService.minimizeComment === 'function') {
              try { await prService.minimizeComment(comment.nodeId, 'RESOLVED', cwd); } catch { /* non-fatal */ }
            }

            this.emit('releaseActionTaken', releaseId, {
              type: 'respond-comment',
              description: `Replied to ${comment.author || 'reviewer'}'s comment`,
              success: true,
              commentUrl: comment.url,
              timestamp: Date.now(),
            });
          } catch (err) {
            log.error('Failed to reply to comment', {
              releaseId, commentId, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // ── 3. Track addressed comments ──────────────────────────────────
    const addressedIds = commentFindings
      .map((f: any) => f.commentId || f.id?.replace('comment-', ''))
      .filter(Boolean) as string[];
    if (addressedIds.length > 0) {
      if (!release.addressedCommentIds) release.addressedCommentIds = [];
      for (const id of addressedIds) {
        if (!release.addressedCommentIds.includes(id)) release.addressedCommentIds.push(id);
      }
    }

    // ── 4. Auto-minimize parent reviews if all children resolved ─────
    if (release.prNumber && release.lastCycle) {
      let prSvc;
      try { prSvc = await this.prServiceFactory.getServiceForRepo(cwd); } catch { /* */ }
      if (prSvc && typeof prSvc.minimizeComment === 'function') {
        const allComments = release.lastCycle.comments || [];
        const reviewChildThreads = new Map<string, any[]>();
        for (const c of allComments) {
          if (c.parentReviewId) {
            if (!reviewChildThreads.has(c.parentReviewId)) reviewChildThreads.set(c.parentReviewId, []);
            reviewChildThreads.get(c.parentReviewId)!.push(c);
          }
        }
        const addressedSet = new Set(release.addressedCommentIds || []);
        for (const [parentId, children] of reviewChildThreads) {
          if (!children.every((c: any) => c.isResolved || addressedSet.has(c.id))) continue;
          const parentReview = allComments.find((c: any) => c.id === parentId);
          if (!parentReview?.nodeId) continue;
          try {
            await prSvc.minimizeComment(parentReview.nodeId, 'RESOLVED', cwd);
            log.info('Auto-minimized parent review', { releaseId, parentReviewId: parentId });
          } catch { /* non-fatal */ }
        }
      }
    }

    // ── 5. Emit resolved and clean up ────────────────────────────────
    const resolvedIds = findings.map((f: any) => f.id);
    this.emit('findingsResolved', releaseId, resolvedIds, !!commitHash);

    // Clean up findings metadata (no longer needed)
    if (release.fixPlanFindings) {
      delete release.fixPlanFindings[plan.id];
    }
    this.store.saveRelease(release).catch(() => {});
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
  on(event: 'releaseActionTaken', handler: (releaseId: string, action: import('./types/release').PRActionTaken & { timestamp?: number }) => void): this;
  on(event: 'findingsResolved', handler: (releaseId: string, findingIds: string[], hasCommit: boolean) => void): this;
  on(event: 'findingsProcessing', handler: (releaseId: string, findingIds: string[], status: string) => void): this;
  on(event: 'cliSessionStart', handler: (releaseId: string, sessionId: string, label: string) => void): this;
  on(event: 'cliSessionOutput', handler: (releaseId: string, sessionId: string, line: string) => void): this;
  on(event: 'cliSessionEnd', handler: (releaseId: string, sessionId: string, success: boolean) => void): this;
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

      // Notify the sidebar that releases are available now
      // (the sidebar may have already done its initial refresh before loading completed)
      if (releases.length > 0) {
        for (const release of releases) {
          this.emit('releaseCreated', release);
        }
      }
      
      // Restore monitoring for any releases in monitoring state (delay to ensure all services are ready)
      const releasesToRestore = releases.filter(r => r.status === 'monitoring' && r.prNumber);
      if (releasesToRestore.length > 0) {
        setTimeout(() => {
          for (const release of releasesToRestore) {
            log.info('Restoring PR monitoring after reload', { releaseId: release.id, prNumber: release.prNumber });
            this.startMonitoring(release.id).catch((err) => {
              log.warn('Failed to restore monitoring', { releaseId: release.id, error: (err as Error).message });
            });
          }
        }, 5000); // 5 second delay to ensure extension is fully activated
      }
    } catch (error) {
      log.error('Failed to load persisted releases', { error: (error as Error).message });
    }
  }
}
