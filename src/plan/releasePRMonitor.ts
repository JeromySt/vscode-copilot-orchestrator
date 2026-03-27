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
import { EventEmitter } from 'events';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../interfaces/IPulseEmitter';
import { Logger } from '../core/logger';

const log = Logger.for('plan');

// Poll every 2 minutes (120 pulse ticks at ~1s each)
const POLL_INTERVAL_TICKS = 120;

// Maximum backoff: 30 minutes (1800 ticks)
const MAX_POLL_INTERVAL_TICKS = 1800;

// Stop monitoring after 40 minutes since last push
const MAX_MONITORING_MS = 2400000;

// Maximum cycles to keep in memory (older ones are discarded)
const MAX_CYCLES_IN_MEMORY = 100;

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

  /** Pulse subscription handle (replaces setInterval) */
  pulseSubscription: PulseDisposable | undefined;

  /** Tick counter for pulse-based polling */
  tickCount: number;

  /** Current poll interval in ticks (increases via exponential backoff) */
  currentPollTicks: number;

  /** Number of consecutive green (no-findings) cycles */
  consecutiveGreenCycles: number;

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
export class DefaultReleasePRMonitor extends EventEmitter implements IReleasePRMonitor {
  private readonly monitors = new Map<string, MonitorState>();

  constructor(
    private readonly copilotRunner: ICopilotRunner,
    private readonly spawner: IProcessSpawner,
    private readonly git: IGitOperations,
    private readonly prServiceFactory: IRemotePRServiceFactory,
    private readonly pulse: IPulseEmitter,
  ) {
    super();
  }

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
      pulseSubscription: undefined,
      tickCount: 0,
      currentPollTicks: POLL_INTERVAL_TICKS,
      consecutiveGreenCycles: 0,
      lastPushTime: Date.now(),
      cycles: [],
      isActive: true,
    };

    this.monitors.set(releaseId, state);

    // Run the first cycle immediately
    await this._runCycle(state);

    // Subscribe to pulse for periodic polling (every POLL_INTERVAL_TICKS ticks)
    let isRunningCycle = false;
    state.pulseSubscription = this.pulse.onPulse(() => {
      if (!state.isActive || isRunningCycle) return;
      state.tickCount++;
      if (state.tickCount >= state.currentPollTicks) {
        state.tickCount = 0;
        isRunningCycle = true;
        this._runCycle(state).catch((err) => {
          log.error('Monitoring cycle failed', {
            releaseId,
            error: err instanceof Error ? err.message : String(err),
          });
        }).finally(() => { isRunningCycle = false; });
      }
    });

    log.info('PR monitoring scheduled via pulse', {
      releaseId,
      pollIntervalTicks: state.currentPollTicks,
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

    if (state.pulseSubscription) {
      state.pulseSubscription.dispose();
      state.pulseSubscription = undefined;
    }

    state.isActive = false;
    this.monitors.delete(releaseId);

    // Notify listeners that monitoring has stopped
    this.emit('monitoringStopped', releaseId, state.cycles.length);

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
   * Resets the polling interval back to the base rate (2 minutes).
   * Called when the user wants to force a fresh check.
   */
  resetPolling(releaseId: string): void {
    const state = this.monitors.get(releaseId);
    if (!state) return;
    state.consecutiveGreenCycles = 0;
    state.currentPollTicks = POLL_INTERVAL_TICKS;
    state.tickCount = 0;
    log.info('Polling interval reset to base rate', { releaseId, pollIntervalTicks: POLL_INTERVAL_TICKS });
    // Run a cycle immediately
    this._runCycle(state).catch((err) => {
      log.error('Immediate cycle after polling reset failed', {
        releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Gets the current polling interval in seconds for a release.
   */
  getPollingIntervalSeconds(releaseId: string): number {
    const state = this.monitors.get(releaseId);
    return state ? Math.round(state.currentPollTicks) : POLL_INTERVAL_TICKS;
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

    // Check if we've exceeded the max monitoring time since last push.
    // Only stop if there are no outstanding findings — if there are still
    // unresolved comments/checks/alerts, keep monitoring so the user
    // can see them and trigger AI fixes.
    const elapsedSinceLastPush = timestamp - state.lastPushTime;
    if (elapsedSinceLastPush > MAX_MONITORING_MS) {
      // We'll check findings after fetching status below.
      // For now, just log and continue — the actual stop decision
      // happens after we know the current findings state.
    }

    // Fetch current PR status via prService — each call is independent
    // so a failure in one (e.g., 403 on security alerts) doesn't prevent
    // processing of the others (checks and comments).
    let checks: PRCheck[] = [];
    let comments: PRComment[] = [];
    let alerts: RemotePRSecurityAlert[] = [];

    try {
      checks = await state.prService.getPRChecks(state.prNumber, state.repoPath);
    } catch (err) {
      log.warn('Failed to fetch PR checks (continuing with empty)', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      comments = await state.prService.getPRComments(state.prNumber, state.repoPath);
    } catch (err) {
      log.warn('Failed to fetch PR comments (continuing with empty)', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      alerts = await state.prService.getSecurityAlerts(state.releaseBranch, state.repoPath);
    } catch (err) {
      log.warn('Failed to fetch security alerts (continuing with empty)', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Convert to cycle format
    const headSha = checks.find(c => c.headSha)?.headSha;
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
      isResolved: c.isResolved || this._isAlreadyAddressedByAutomatedFix(c),
      source: c.source,
      threadId: c.threadId,
      url: c.url,
      nodeId: c.nodeId,
      parentReviewId: c.parentReviewId,
      replies: c.replies,
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
      log.info('Findings detected (auto-fix disabled, awaiting user action)', {
        releaseId: state.releaseId,
        failingChecks: cycleChecks.filter((c) => c.status === 'failing').length,
        unresolvedComments: cycleComments.filter((c) => !c.isResolved).length,
        unresolvedAlerts: cycleAlerts.filter((a) => !a.resolved).length,
      });

      // Auto-fix is disabled. Findings are emitted via the cycleComplete event
      // so the UI can display them in the Pending Actions panel. The user
      // selects which findings to address and triggers AI fixes from there.
    } else {
      log.info('No findings detected', { releaseId: state.releaseId });

      // Exponential backoff removed: keep constant 2-minute polling interval.
      // The stop-after-40-minutes check relies on cycles running at a predictable
      // rate; backoff caused cycles to fire too infrequently for the timeout to
      // trigger within the monitoring window.

      // Only stop on timeout when everything is green (no findings)
      if (elapsedSinceLastPush > MAX_MONITORING_MS) {
        log.info('All green and max monitoring time exceeded, stopping', {
          releaseId: state.releaseId,
          elapsedMs: elapsedSinceLastPush,
          maxMs: MAX_MONITORING_MS,
        });
        // Still record and emit this cycle before stopping
        const cycle: PRMonitorCycle = {
          cycleNumber,
          timestamp,
          headSha,
          checks: cycleChecks,
          comments: cycleComments,
          securityAlerts: cycleAlerts,
          actions,
        };
        state.cycles.push(cycle);
        this.emit('cycleComplete', state.releaseId, cycle, state.currentPollTicks);
        this.stopMonitoring(state.releaseId);
        return;
      }
    }

    // Record the cycle
    const cycle: PRMonitorCycle = {
      cycleNumber,
      timestamp,
      headSha,
      checks: cycleChecks,
      comments: cycleComments,
      securityAlerts: cycleAlerts,
      actions,
    };
    state.cycles.push(cycle);

    // Cap cycles in memory to avoid unbounded growth
    if (state.cycles.length > MAX_CYCLES_IN_MEMORY) {
      state.cycles = state.cycles.slice(-MAX_CYCLES_IN_MEMORY);
    }

    // Emit cycle event so release manager can update the release and UI
    this.emit('cycleComplete', state.releaseId, cycle, state.currentPollTicks);

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
    const outputLines: string[] = [];
    try {
      copilotResult = await this.copilotRunner.run({
        cwd: state.repoPath,
        task: taskDescription,
        timeout: 0, // No timeout for PR monitoring actions
        onOutput: (line: string) => {
          outputLines.push(line);
        },
      });
    } catch (err) {
      log.error('Copilot CLI invocation failed', {
        releaseId: state.releaseId,
        error: err instanceof Error ? err.message : String(err),
        lastOutput: outputLines.slice(-10).join('\n'),
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
        error: copilotResult.error,
        lastOutput: outputLines.slice(-20).join('\n'),
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

        if (comment.threadId) {
          // Threaded review comment: reply inline and resolve the thread
          await state.prService.replyToComment(
            state.prNumber,
            comment.id,
            replyText,
            state.repoPath,
          );
          await state.prService.resolveThread(
            state.prNumber,
            comment.threadId,
            state.repoPath,
          );
        } else if (comment.path) {
          // Inline file comment without a thread: reply to the comment directly
          await state.prService.replyToComment(
            state.prNumber,
            comment.id,
            replyText,
            state.repoPath,
          );
        } else {
          // Top-level issue comment (no path, no threadId): post a quoted reply
          const quotedReply = `> ${comment.body}\n\n${replyText}`;
          await state.prService.addIssueComment(
            state.prNumber,
            quotedReply,
            state.repoPath,
          );
          // Minimize the original comment if we have its GraphQL node ID
          if (comment.nodeId && state.prService.minimizeComment) {
            await state.prService.minimizeComment(comment.nodeId, 'RESOLVED', state.repoPath);
          }
        }

        actions.push({
          type: 'respond-comment',
          description: `Replied to comment from ${comment.author}`,
          success: true,
          commentUrl: comment.url,
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
          commentUrl: comment.url,
        });
      }
    }

    return actions;
  }

  /**
   * Detects whether a comment has already been addressed by an automated fix,
   * even if the platform hasn't marked it as resolved yet.
   *
   * Three patterns indicate a comment is already handled:
   * 1. A human relayed the bot's feedback with the standard fix marker
   *    ("Re: bot's feedback — ✅ Addressed in automated fix")
   * 2. The comment body is a quoted reply that ends with the fix marker
   *    ("> Original text\n\n✅ Addressed in automated fix")
   * 3. A reply in the thread already contains the fix marker
   */
  private _isAlreadyAddressedByAutomatedFix(comment: { body: string; replies?: Array<{ body: string }> }): boolean {
    const MARKER = '✅ Addressed in automated fix';

    // Pattern 1: human relay comment ("Re: …bot… — ✅ Addressed in automated fix …")
    if (/^Re:.*—\s*✅ Addressed in automated fix/.test(comment.body)) {
      return true;
    }

    // Pattern 2: quoted reply (">" prefix + marker somewhere in the body)
    if (comment.body.startsWith('>') && comment.body.includes(MARKER)) {
      return true;
    }

    // Pattern 3: a thread reply contains the marker
    if (comment.replies?.some((r) => r.body.includes(MARKER))) {
      return true;
    }

    return false;
  }
}
