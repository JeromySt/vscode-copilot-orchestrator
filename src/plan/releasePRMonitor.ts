/**
 * @fileoverview Release PR Monitor Implementation
 *
 * Monitors pull requests for releases, tracking CI checks, reviews, comments,
 * and security alerts. Autonomously addresses findings using Copilot CLI agents.
 *
 * All PR operations are performed through IRemotePRService (ZERO direct gh/az CLI calls).
 * All paths are .orchestrator/release/<branch>/ clones.
 *
 * @module plan/releasePRMonitor
 */

import type { IReleasePRMonitor } from '../interfaces/IReleasePRMonitor';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { IRemotePRServiceFactory } from '../interfaces/IRemotePRServiceFactory';
import type { IRemotePRService } from '../interfaces/IRemotePRService';
import type {
  PRMonitorCycle,
  PRCheckResult,
  PRCommentResult,
  PRSecurityAlert,
  PRActionTaken,
  PRActionType,
} from './types/release';
import type { PRCheck, PRComment, PRSecurityAlert as RemotePRSecurityAlert } from './types/remotePR';
import { Logger } from '../core/logger';

const log = Logger.for('plan');

// Poll every 2 minutes
const POLL_INTERVAL_MS = 120000;

// Stop monitoring after 40 minutes since last push
const MAX_MONITORING_MS = 2400000;

/**
 * Internal state for a single release PR monitoring session.
 */
interface MonitorState {
  /** Release ID */
  releaseId: string;

  /** PR number being monitored */
  prNumber: number;

  /** Repository path (.orchestrator/release/<branch>/) */
  repoPath: string;

  /** Release branch name */
  releaseBranch: string;

  /** Resolved PR service for this repository (cached at start) */
  prService: IRemotePRService;

  /** Interval timer handle */
  timer: ReturnType<typeof setInterval> | undefined;

  /** Timestamp of the last push (resets the 40-minute timer) */
  lastPushTime: number;

  /** All monitoring cycles executed */
  cycles: PRMonitorCycle[];

  /** Whether monitoring is currently active */
  isActive: boolean;
}

/**
 * Default implementation of IReleasePRMonitor.
 *
 * Monitors a release PR by:
 * 1. Polling every 2 minutes for CI checks, comments, and security alerts
 * 2. Addressing findings via Copilot CLI agents in the isolated clone
 * 3. Replying to comments and resolving threads via IRemotePRService
 * 4. Stopping after 40 minutes since the last push
 *
 * Timer resets on every push, allowing extended monitoring for active fixes.
 */
export class DefaultReleasePRMonitor implements IReleasePRMonitor {
  private readonly monitors = new Map<string, MonitorState>();

  constructor(
    private readonly copilotRunner: ICopilotRunner,
    private readonly spawner: IProcessSpawner,
    private readonly git: IGitOperations,
    private readonly prServiceFactory: IRemotePRServiceFactory,
  ) {}

  /**
   * Starts monitoring a release PR.
   *
   * Resolves the PR service once at start, then polls every 2 minutes
   * for up to 40 minutes since the last push.
   */
  async startMonitoring(
    releaseId: string,
    prNumber: number,
    repoPath: string,
    releaseBranch: string,
  ): Promise<void> {
    // Check if already monitoring
    if (this.monitors.has(releaseId)) {
      log.warn('Already monitoring release PR', { releaseId, prNumber });
      return;
    }

    log.info('Starting release PR monitoring', {
      releaseId,
      prNumber,
      repoPath,
      releaseBranch,
    });

    // Resolve PR service for this repository (cached by factory)
    const prService = await this.prServiceFactory.getServiceForRepo(repoPath);

    // Initialize monitoring state
    const state: MonitorState = {
      releaseId,
      prNumber,
      repoPath,
      releaseBranch,
      prService,
      timer: undefined,
      lastPushTime: Date.now(),
      cycles: [],
      isActive: true,
    };

    this.monitors.set(releaseId, state);

    // Run the first cycle immediately
    await this._runCycle(state);

    // Schedule periodic polling
    state.timer = setInterval(async () => {
      try {
        await this._runCycle(state);
      } catch (err) {
        log.error('Monitoring cycle failed', {
          releaseId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, POLL_INTERVAL_MS);

    log.info('PR monitoring scheduled', {
      releaseId,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMonitoringMs: MAX_MONITORING_MS,
    });
  }

  /**
   * Stops monitoring a release PR.
   */
  stopMonitoring(releaseId: string): void {
    const state = this.monitors.get(releaseId);
    if (!state) {
      log.warn('No active monitoring session for release', { releaseId });
      return;
    }

    log.info('Stopping PR monitoring', { releaseId });

    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }

    state.isActive = false;
    this.monitors.delete(releaseId);

    log.info('PR monitoring stopped', { releaseId, totalCycles: state.cycles.length });
  }

  /**
   * Checks if a release PR is currently being monitored.
   */
  isMonitoring(releaseId: string): boolean {
    const state = this.monitors.get(releaseId);
    return state?.isActive ?? false;
  }

  /**
   * Gets all monitoring cycles for a release.
   */
  getMonitorCycles(releaseId: string): PRMonitorCycle[] {
    const state = this.monitors.get(releaseId);
    return state?.cycles ?? [];
  }

  /**
   * Runs a single monitoring cycle.
   *
   * 1. Fetches PR checks, comments, and security alerts via prService
   * 2. If findings detected, addresses them via Copilot CLI
   * 3. Commits and pushes fixes (resets the 40-minute timer)
   * 4. Replies to comments and resolves threads via prService
   * 5. Stops monitoring if 40 minutes elapsed since last push
   */
  private async _runCycle(state: MonitorState): Promise<void> {
    const cycleNumber = state.cycles.length + 1;
    const timestamp = Date.now();

    log.info('Running monitoring cycle', {
      releaseId: state.releaseId,
      cycleNumber,
      prNumber: state.prNumber,
    });

    // Check if we've exceeded the max monitoring time since last push
    const elapsedSinceLastPush = timestamp - state.lastPushTime;
    if (elapsedSinceLastPush > MAX_MONITORING_MS) {
      log.info('Max monitoring time exceeded, stopping', {
        releaseId: state.releaseId,
        elapsedMs: elapsedSinceLastPush,
        maxMs: MAX_MONITORING_MS,
      });
      this.stopMonitoring(state.releaseId);
      return;
    }

    // Fetch current PR status via prService
    let checks: PRCheck[] = [];
    let comments: PRComment[] = [];
    let alerts: RemotePRSecurityAlert[] = [];

    try {
      checks = await state.prService.getPRChecks(state.prNumber, state.repoPath);
      comments = await state.prService.getPRComments(state.prNumber, state.repoPath);
      alerts = await state.prService.getSecurityAlerts(state.releaseBranch, state.repoPath);
    } catch (err) {
      log.error('Failed to fetch PR status', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Record empty cycle on error
      state.cycles.push({
        cycleNumber,
        timestamp,
        checks: [],
        comments: [],
        securityAlerts: [],
        actions: [],
      });
      return;
    }

    // Convert to cycle format
    const cycleChecks: PRCheckResult[] = checks.map((c) => ({
      name: c.name,
      status: c.status,
      url: c.url,
    }));

    const cycleComments: PRCommentResult[] = comments.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      path: c.path,
      line: c.line,
      isResolved: c.isResolved,
      source: c.source,
      threadId: c.threadId,
    }));

    const cycleAlerts: PRSecurityAlert[] = alerts.map((a) => ({
      id: a.id,
      severity: a.severity,
      description: a.description,
      file: a.file,
      resolved: a.resolved,
    }));

    log.debug('Cycle status fetched', {
      releaseId: state.releaseId,
      checks: cycleChecks.length,
      comments: cycleComments.length,
      alerts: cycleAlerts.length,
    });

    // Determine if we have findings to address
    const hasFailingChecks = cycleChecks.some((c) => c.status === 'failing');
    const hasUnresolvedComments = cycleComments.some((c) => !c.isResolved);
    const hasUnresolvedAlerts = cycleAlerts.some((a) => !a.resolved);
    const hasFindings = hasFailingChecks || hasUnresolvedComments || hasUnresolvedAlerts;

    let actions: PRActionTaken[] = [];

    if (hasFindings) {
      log.info('Findings detected, addressing', {
        releaseId: state.releaseId,
        failingChecks: cycleChecks.filter((c) => c.status === 'failing').length,
        unresolvedComments: cycleComments.filter((c) => !c.isResolved).length,
        unresolvedAlerts: cycleAlerts.filter((a) => !a.resolved).length,
      });

      actions = await this._addressFindings(state, {
        cycleNumber,
        timestamp,
        checks: cycleChecks,
        comments: cycleComments,
        securityAlerts: cycleAlerts,
        actions: [],
      });

      // If we made changes and pushed, reset the timer
      const hasPush = actions.some((a) => a.commitHash);
      if (hasPush) {
        state.lastPushTime = Date.now();
        log.info('Push detected, timer reset', {
          releaseId: state.releaseId,
          newLastPushTime: state.lastPushTime,
        });
      }
    } else {
      log.info('No findings detected', { releaseId: state.releaseId });
    }

    // Record the cycle
    state.cycles.push({
      cycleNumber,
      timestamp,
      checks: cycleChecks,
      comments: cycleComments,
      securityAlerts: cycleAlerts,
      actions,
    });

    log.info('Monitoring cycle complete', {
      releaseId: state.releaseId,
      cycleNumber,
      actionsCount: actions.length,
    });
  }

  /**
   * Addresses findings from a monitoring cycle.
   *
   * Strategy:
   * 1. CI failures: invoke Copilot CLI to read logs + fix code
   * 2. Comments: invoke Copilot CLI to understand feedback + fix code
   * 3. Security alerts: invoke Copilot CLI to fix + document
   * 4. Commit + push all fixes in a single commit
   * 5. Reply to comments and resolve threads via prService
   *
   * @returns Array of actions taken
   */
  private async _addressFindings(
    state: MonitorState,
    cycle: PRMonitorCycle,
  ): Promise<PRActionTaken[]> {
    const actions: PRActionTaken[] = [];

    // Build a comprehensive task description for the Copilot CLI agent
    const taskParts: string[] = [];

    // Failing checks
    const failingChecks = cycle.checks.filter((c) => c.status === 'failing');
    if (failingChecks.length > 0) {
      taskParts.push('### CI/CD Check Failures\n');
      for (const check of failingChecks) {
        taskParts.push(`- **${check.name}**: FAILING`);
        if (check.url) {
          taskParts.push(`  URL: ${check.url}`);
        }
      }
      taskParts.push('\nInvestigate and fix all failing checks.\n');
    }

    // Unresolved comments
    const unresolvedComments = cycle.comments.filter((c) => !c.isResolved);
    if (unresolvedComments.length > 0) {
      taskParts.push('### PR Comments to Address\n');
      for (const comment of unresolvedComments) {
        taskParts.push(`- **${comment.author}** (${comment.source}):`);
        taskParts.push(`  ${comment.body}`);
        if (comment.path) {
          taskParts.push(`  File: ${comment.path}${comment.line ? `:${comment.line}` : ''}`);
        }
        taskParts.push('');
      }
      taskParts.push('Address all review feedback.\n');
    }

    // Unresolved security alerts
    const unresolvedAlerts = cycle.securityAlerts.filter((a) => !a.resolved);
    if (unresolvedAlerts.length > 0) {
      taskParts.push('### Security Alerts\n');
      for (const alert of unresolvedAlerts) {
        taskParts.push(`- **[${alert.severity.toUpperCase()}]** ${alert.description}`);
        if (alert.file) {
          taskParts.push(`  File: ${alert.file}`);
        }
        taskParts.push('');
      }
      taskParts.push('Fix all security issues.\n');
    }

    if (taskParts.length === 0) {
      return actions;
    }

    const taskDescription = taskParts.join('\n');

    log.info('Invoking Copilot CLI to address findings', {
      releaseId: state.releaseId,
      repoPath: state.repoPath,
    });

    // Invoke Copilot CLI agent in the isolated clone
    let copilotResult;
    try {
      copilotResult = await this.copilotRunner.run({
        cwd: state.repoPath,
        task: taskDescription,
        sessionId: `pr-monitor-${state.releaseId}-cycle-${cycle.cycleNumber}`,
      });
    } catch (err) {
      log.error('Copilot CLI invocation failed', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
      actions.push({
        type: 'fix-code',
        description: 'Failed to invoke Copilot CLI for automated fixes',
        success: false,
      });
      return actions;
    }

    if (!copilotResult.success) {
      log.warn('Copilot CLI reported failure', {
        releaseId: state.releaseId,
        output: copilotResult.error?.substring(0, 500),
      });
      actions.push({
        type: 'fix-code',
        description: 'Copilot CLI failed to apply fixes',
        success: false,
      });
      return actions;
    }

    log.info('Copilot CLI completed', {
      releaseId: state.releaseId,
      success: copilotResult.success,
    });

    // Check if there are changes to commit
    let hasChanges = false;
    try {
      hasChanges = await this.git.repository.hasChanges(state.repoPath);
    } catch (err) {
      log.error('Failed to check git status', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let commitHash: string | undefined;

    if (hasChanges) {
      // Commit all changes
      try {
        // Stage all changes
        await this.git.repository.stageAll(state.repoPath);

        // Commit with descriptive message
        const commitMessage = `Address PR feedback (cycle ${cycle.cycleNumber})

Automated fixes for:
${failingChecks.length > 0 ? `- ${failingChecks.length} failing CI check(s)\n` : ''}${unresolvedComments.length > 0 ? `- ${unresolvedComments.length} PR comment(s)\n` : ''}${unresolvedAlerts.length > 0 ? `- ${unresolvedAlerts.length} security alert(s)\n` : ''}
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;

        await this.git.repository.commit(state.repoPath, commitMessage);

        // Get the commit hash
        const headRef = await this.git.repository.getHead(state.repoPath);
        commitHash = headRef || undefined;

        // Push to remote
        await this.git.repository.push(state.repoPath, { branch: state.releaseBranch });

        log.info('Changes committed and pushed', {
          releaseId: state.releaseId,
          commitHash,
          branch: state.releaseBranch,
        });

        actions.push({
          type: 'fix-code',
          description: `Committed and pushed fixes for ${failingChecks.length + unresolvedComments.length + unresolvedAlerts.length} finding(s)`,
          success: true,
          commitHash,
        });
      } catch (err) {
        log.error('Failed to commit/push changes', {
          releaseId: state.releaseId,
          error: err instanceof Error ? err.message : String(err),
        });
        actions.push({
          type: 'fix-code',
          description: 'Failed to commit/push fixes',
          success: false,
        });
      }
    } else {
      log.info('No changes to commit', { releaseId: state.releaseId });
    }

    // Reply to comments and resolve threads
    for (const comment of unresolvedComments) {
      try {
        const replyText = `✅ Addressed in automated fix ${commitHash ? `(${commitHash.substring(0, 7)})` : ''}`;

        await state.prService.replyToComment(
          state.prNumber,
          comment.id,
          replyText,
          state.repoPath,
        );

        // Mark thread as resolved if we have a threadId
        if (comment.threadId) {
          await state.prService.resolveThread(
            state.prNumber,
            comment.threadId,
            state.repoPath,
          );
        }

        actions.push({
          type: 'respond-comment',
          description: `Replied to comment from ${comment.author}`,
          success: true,
        });

        log.debug('Comment addressed', {
          releaseId: state.releaseId,
          commentId: comment.id,
          author: comment.author,
        });
      } catch (err) {
        log.error('Failed to reply to comment', {
          releaseId: state.releaseId,
          commentId: comment.id,
          error: err instanceof Error ? err.message : String(err),
        });
        actions.push({
          type: 'respond-comment',
          description: `Failed to reply to comment from ${comment.author}`,
          success: false,
        });
      }
    }

    return actions;
  }
}
