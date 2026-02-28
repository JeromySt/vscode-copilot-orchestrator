/**
 * @fileoverview Job Execution Engine
 *
 * Handles the end-to-end execution of job nodes including:
 * - Forward Integration (FI) merges from dependencies
 * - Executor invocation (prechecks, work, postchecks, commit)
 * - Auto-heal (AI-assisted retry)
 * - Reverse Integration (RI) merges to target branch
 * - Worktree cleanup and consumption tracking
 *
 * @module plan/executionEngine
 */

import * as path from 'path';
import * as fs from 'fs';
import type { ILogger } from '../interfaces/ILogger';
import type {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  ExecutionContext,
  JobExecutionResult,
  JobWorkSummary,
  CommitDetail,
  ExecutionPhase,
  AttemptRecord,
  WorkSpec,
  CopilotUsageMetrics,
  NodeTransitionEvent,
  PlanCompletionEvent,
} from './types';
import { normalizeWorkSpec } from './types';
import { PlanStateMachine } from './stateMachine';
import { PlanPersistence } from './persistence';
import { PlanEventEmitter } from './planEvents';
import { PlanConfigManager } from './configManager';
import {
  appendWorkSummary as appendWorkSummaryHelper,
} from './helpers';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import type { JobExecutor } from './runner';
import { NodeManager } from './nodeManager';

/**
 * Info about a dependency node, used for FI merge logging.
 */
interface DependencyInfo {
  nodeId: string;
  nodeName: string;
  commit: string;
  workSummary?: JobWorkSummary;
}

/**
 * Shared state passed to the execution engine from PlanRunner.
 */
export interface ExecutionEngineState {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, PlanStateMachine>;
  persistence: PlanPersistence;
  executor?: JobExecutor;
  events: PlanEventEmitter;
  configManager: PlanConfigManager;
  copilotRunner?: ICopilotRunner;
  planRepository?: import('../interfaces/IPlanRepository').IPlanRepository;
}

/**
 * Handles end-to-end execution of job nodes including FI/RI merges,
 * executor invocation, auto-heal, worktree cleanup, and work summary
 * accumulation.
 */
export class JobExecutionEngine {
  private readonly state: ExecutionEngineState;
  private readonly nodeManager: NodeManager;
  private readonly log: ILogger;
  private readonly git: IGitOperations;

  /**
   * Mutex for serializing Reverse Integration (RI) merges.
   *
   * RI merges MUST be serialized because:
   * 1. Git's index lock prevents concurrent operations on the same repo
   *    (stash, reset --hard, checkout all acquire .git/index.lock)
   * 2. Concurrent merges that read the same target branch tip would create
   *    divergent merge commits -- the second updateBranchRef would overwrite
   *    the first, silently losing its changes.
   *
   * By serializing, each RI merge sees the latest target branch state
   * (including all prior RI merges) and creates its commit on top.
   */
  private riMergeMutex: Promise<void> = Promise.resolve();

  constructor(state: ExecutionEngineState, nodeManager: NodeManager, log: ILogger, git: IGitOperations) {
    this.state = state;
    this.nodeManager = nodeManager;
    this.log = log;
    this.git = git;
  }

  /**
   * Log a message to the executor (helper for merge operations)
   */
  private execLog(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string, attemptNumber?: number): void {
    if (this.state.executor?.log) {
      this.state.executor.log(planId, nodeId, phase, type, message, attemptNumber);
    }
  }

  /**
   * Convert inline attempt data to file refs for memory efficiency.
   * Replaces workUsed/logs with refs pointing to the attempt directory.
   */
  private toRefAttempt(attempt: AttemptRecord, nodeId: string): AttemptRecord {
    const n = attempt.attemptNumber;
    const dir = `specs/${nodeId}/attempts/${n}`;
    // Replace inline work spec with ref
    if (attempt.workUsed) {
      attempt.workRef = `${dir}/work.json`;
      delete attempt.workUsed;
    }
    // Replace inline logs with ref
    if (attempt.logs) {
      attempt.logsRef = `${dir}/execution.log`;
      delete attempt.logs;
    }
    // Always set logFilePath to the attempt-specific path (not /current/ symlink)
    attempt.logFilePath = `${dir}/execution.log`;
    attempt.logsRef = `${dir}/execution.log`;
    // Set attempt directory ref
    attempt.attemptDir = dir;
    // Set prechecks/postchecks refs (they're in the attempt dir too)
    attempt.prechecksRef = `${dir}/prechecks.json`;
    attempt.postchecksRef = `${dir}/postchecks.json`;
    // Add stateHistory if not already present (skip for running placeholders)
    if (!attempt.stateHistory && attempt.startedAt && attempt.endedAt && attempt.status !== 'running') {
      attempt.stateHistory = this.buildAttemptStateHistory(
        attempt.startedAt, attempt.endedAt, attempt.status, attempt.triggerType
      );
    }
    return attempt;
  }

  /**
   * Build stateHistory for an AttemptRecord from its timing and status.
   * Tracks: scheduled → running → succeeded/failed
   */
  private buildAttemptStateHistory(startedAt: number, endedAt: number, status: 'succeeded' | 'failed' | 'canceled', triggerType?: string): import('../plan/types').StateTransition[] {
    const history: import('../plan/types').StateTransition[] = [];
    history.push({ from: '', to: 'scheduled', timestamp: startedAt, reason: triggerType || 'initial' });
    history.push({ from: 'scheduled', to: 'running', timestamp: startedAt });
    history.push({ from: 'running', to: status, timestamp: endedAt });
    return history;
  }

  /**
   * Record a completed attempt — replaces the "running" placeholder that was
   * inserted at attempt start. If no placeholder exists, appends normally.
   */
  private recordCompletedAttempt(nodeState: NodeExecutionState, attempt: AttemptRecord, nodeId: string): void {
    const ref = this.toRefAttempt(attempt, nodeId);
    const history = nodeState.attemptHistory || [];
    // Replace the last entry if it matches this attempt number (the running placeholder)
    if (history.length > 0 && history[history.length - 1].attemptNumber === attempt.attemptNumber) {
      history[history.length - 1] = ref;
    } else {
      history.push(ref);
    }
    nodeState.attemptHistory = history;
  }

  /**
   * Record a running attempt placeholder in attemptHistory.
   * Called after incrementAttempt() so attemptHistory[last] always reflects the current attempt.
   */
  private recordRunningAttempt(nodeState: NodeExecutionState, attemptStartedAt: number, triggerType?: string): void {
    const placeholder: AttemptRecord = {
      attemptNumber: nodeState.attempts,
      triggerType: (triggerType || (nodeState.attempts === 1 ? 'initial' : 'retry')) as any,
      status: 'running',
      startedAt: attemptStartedAt,
      endedAt: 0, // not ended yet
      copilotSessionId: nodeState.copilotSessionId,
      worktreePath: nodeState.worktreePath,
      baseCommit: nodeState.baseCommit,
    };
    nodeState.attemptHistory = [...(nodeState.attemptHistory || []), placeholder];
  }

  /**
   * Increment attempt counter and snapshot specs for the new attempt.
   * Every attempt gets its own directory under specs/<nodeId>/attempts/<N>/.
   */
  private async incrementAttempt(plan: PlanInstance, nodeId: string, nodeState: NodeExecutionState): Promise<void> {
    nodeState.attempts++;
    if (this.state.planRepository) {
      try {
        await this.state.planRepository.snapshotSpecsForAttempt(plan.id, nodeId, nodeState.attempts);
      } catch (err: any) {
        this.log.warn(`Failed to snapshot specs for attempt ${nodeState.attempts}`, { planId: plan.id, nodeId, error: err.message });
      }
    }
  }

  /**
   * Save plan state using planRepository if available, falling back to persistence
   */
  private async savePlanState(plan: PlanInstance): Promise<void> {
    if (this.state.planRepository) {
      await this.state.planRepository.saveState(plan);
    } else {
      this.state.persistence.save(plan);
    }
  }

  async executeJobNode(
    plan: PlanInstance,
    sm: PlanStateMachine,
    node: JobNode
  ): Promise<void> {
    const nodeState = plan.nodeStates.get(node.id);
    if (!nodeState) {return;}
    
    this.log.info(`Executing job node: ${node.name}`, {
      planId: plan.id,
      nodeId: node.id,
    });
    
    // Capture log offsets before this attempt starts so we can extract
    // only the logs produced during this attempt when creating AttemptRecord.
    let logMemoryOffset = this.state.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
    let logFileOffset = this.state.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;
    
    // Track when the current attempt started (updated on each incrementAttempt).
    // Used for AttemptRecord.startedAt — each attempt has its own start time,
    // independent of nodeState.startedAt (which is the first-ever start).
    let attemptStartedAt = Date.now();
    
    try {
      // Transition to running
      sm.transition(node.id, 'running');
      await this.incrementAttempt(plan, node.id, nodeState);
      attemptStartedAt = Date.now();
      
      // Record a "running" attempt in history immediately.
      // attemptHistory[last] always reflects the current attempt for timeline rendering.
      this.recordRunningAttempt(nodeState, attemptStartedAt);
      
      // Notify UI that plan state changed (timeline needs the new attempt entry
      // which was added AFTER the running transition that triggered _update).
      this.state.events.emitPlanUpdated(plan.id);
      
      this.state.events.emit('nodeStarted', plan.id, node.id);
      
      // Determine base commits from dependencies (RI/FI model)
      // First commit is the base, additional commits are merged in
      const baseCommits = sm.getBaseCommitsForNode(node.id);
      // Root nodes (no deps) use the snapshot's pinned commit so every root
      // starts from the same codebase even if targetBranch moves during execution.
      let baseCommitish = baseCommits.length > 0
        ? baseCommits[0]
        : (plan.snapshot?.baseCommit ?? plan.baseBranch);
      let additionalSources = baseCommits.slice(1);
      
      // SV node uses a pre-assigned snapshot worktree. Its deps' commits
      // must ALL be forward-integrated (merge-fi) into that worktree — none
      // of them served as the worktree's creation base. Treat every dep
      // commit as an additional source so merge-fi brings them all in.
      const isSvNode = node.assignedWorktreePath
        && plan.snapshot
        && node.assignedWorktreePath === plan.snapshot.worktreePath;
      if (isSvNode && baseCommits.length > 0) {
        additionalSources = baseCommits; // ALL deps go through merge-fi
        baseCommitish = plan.snapshot!.baseCommit; // worktree was created from snapshot base
      }

      
      // Build dependency info map for enhanced logging
      const dependencyInfoMap = new Map<string, DependencyInfo>();
      for (const depId of node.dependencies) {
        const depNode = plan.jobs.get(depId);
        const depState = plan.nodeStates.get(depId);
        if (depNode && depState?.completedCommit) {
          dependencyInfoMap.set(depState.completedCommit, {
            nodeId: depId,
            nodeName: depNode.name,
            commit: depState.completedCommit,
            workSummary: depState.workSummary,
          });
        }
      }
      
      // Use pre-assigned worktree if set (e.g., snapshot worktree), otherwise
      // create a worktree path using first 8 chars of node UUID (flat structure)
      const worktreePath = node.assignedWorktreePath || path.join(plan.worktreeRoot, node.id.slice(0, 8));
      
      // Store in state (no branchName since we use detached HEAD)
      nodeState.worktreePath = worktreePath;
      
      // Setup detached worktree (or reuse existing one for retries)
      // This is part of Forward Integration (merge-fi) phase
      this.log.debug(`Setting up worktree for job ${node.name} at ${worktreePath} from ${baseCommitish}`);
      let timing: Awaited<ReturnType<typeof this.git.worktrees.createOrReuseDetached>>;
      try {
        timing = await this.git.worktrees.createOrReuseDetached(
          plan.repoPath,
          worktreePath,
          baseCommitish,
          s => this.log.debug(s),
          plan.spec.additionalSymlinkDirs
        );
      } catch (wtError: any) {
        // Worktree creation is part of FI phase - log and set correct phase
        this.execLog(plan.id, node.id, 'merge-fi', 'error', `Failed to create worktree: ${wtError.message}`, nodeState.attempts);
        if (!nodeState.stepStatuses) {nodeState.stepStatuses = {};}
        nodeState.stepStatuses['merge-fi'] = 'failed';
        const fiError = new Error(wtError.message) as Error & { failedPhase: string };
        fiError.failedPhase = 'merge-fi';
        throw fiError;
      }
      
      if (timing.reused) {
        this.log.info(`Reusing existing worktree for ${node.name} (retry)`);
        // On retry, preserve the original base commit for validation
        // Don't overwrite with current HEAD which includes prior work
        // But if baseCommit is somehow missing, fall back to timing.baseCommit
        if (!nodeState.baseCommit) {
          nodeState.baseCommit = timing.baseCommit;
        }
      } else {
        // Only set baseCommit on fresh worktree creation
        nodeState.baseCommit = timing.baseCommit;
        
        // Capture the resolved base branch SHA on the plan (once).
        // This ensures RI merge diffs are computed against the original
        // starting point even if the base branch moves forward later.
        if (!plan.baseCommitAtStart) {
          plan.baseCommitAtStart = timing.baseCommit;
          this.log.info(`Captured plan baseCommitAtStart: ${timing.baseCommit.slice(0, 8)}`);
        }
        
        if (timing.totalMs > 500) {
          this.log.warn(`Slow worktree creation for ${node.name} took ${timing.totalMs}ms`);
        }
        
        // Note: .gitignore management is handled at the repo level (planInitialization.ts),
        // not per-worktree. Modifying .gitignore here would block FI merges when
        // dependency commits also touch .gitignore.
      }
      
      // Acknowledge consumption to all dependencies
      // This allows dependency worktrees to be cleaned up as soon as all consumers have FI'd
      await this.acknowledgeConsumption(plan, sm, node);
      
      let autoHealSucceeded = false; // Track if success came from auto-heal
      
      // Build execution context
      // Use nodeState.baseCommit which is preserved across retries
      
      // Prepare dependency commits for forward integration
        const dependencyCommits = additionalSources.map(commit => {
          const depInfo = dependencyInfoMap.get(commit);
          return {
            commit,
            nodeId: depInfo?.nodeId || 'unknown',
            nodeName: depInfo?.nodeName || 'unknown'
          };
        });
        
        // Helper to read a phase spec from disk at point of use.
        // Specs are always stored on disk; never cached in memory.
        const resolveSpec = async (phase: 'work' | 'prechecks' | 'postchecks'): Promise<WorkSpec | undefined> => {
          const inline = phase === 'work' ? node.work : phase === 'prechecks' ? node.prechecks : node.postchecks;
          if (inline) { return inline; }
          if (!plan.definition) { return undefined; }
          if (phase === 'work') { return plan.definition.getWorkSpec(node.id); }
          if (phase === 'prechecks') { return plan.definition.getPrechecksSpec(node.id); }
          return plan.definition.getPostchecksSpec(node.id);
        };
        
        const context: ExecutionContext = {
          plan,
          node,
          baseCommit: nodeState.baseCommit!,
          worktreePath,
          attemptNumber: nodeState.attempts,
          copilotSessionId: nodeState.copilotSessionId, // Pass existing session for resumption
          resumeFromPhase: nodeState.resumeFromPhase, // Resume from failed phase
          previousStepStatuses: nodeState.stepStatuses, // Preserve completed phase statuses
          // Merge-specific fields
          dependencyCommits: dependencyCommits.length > 0 ? dependencyCommits : undefined,
          repoPath: plan.repoPath,
          // RI merge only applies to leaf nodes (nodes with no dependents).
          // Non-leaf nodes' commits are forward-integrated into children instead.
          targetBranch: plan.leaves.includes(node.id) ? plan.targetBranch : undefined,
          baseCommitAtStart: plan.baseCommitAtStart,
          // Snapshot branch for leaf RI merges (merges go here instead of targetBranch).
          // The SV node itself merges FROM snapshot INTO targetBranch, so it doesn't
          // redirect — its merge-ri targets plan.targetBranch directly.
          snapshotBranch: (node.assignedWorktreePath === plan.snapshot?.worktreePath) ? undefined : plan.snapshot?.branch,
          snapshotWorktreePath: plan.snapshot?.worktreePath,
          onProgress: (step) => {
            this.log.debug(`Job progress: ${node.name} - ${step}`);
          },
          onStepStatusChange: (phase, status) => {
            if (!nodeState.stepStatuses) {nodeState.stepStatuses = {};}
            (nodeState.stepStatuses as any)[phase] = status;
            // Sync to running attempt in attemptHistory so timeline renders phase colors live
            if (nodeState.attemptHistory && nodeState.attemptHistory.length > 0) {
              const last = nodeState.attemptHistory[nodeState.attemptHistory.length - 1];
              if (last.status === 'running') {
                last.stepStatuses = { ...nodeState.stepStatuses };
              }
            }
          },
        };
        
        // Execute
        this.log.info(`[executeNode] Starting executor.execute for ${node.name}`, { planId: plan.id, nodeId: node.id });
        const result = await this.state.executor!.execute(context);
        this.log.info(`[executeNode] Executor returned: success=${result.success}, error=${result.error?.slice(0, 100) || 'none'}`, { planId: plan.id, nodeId: node.id });
        
        // Store step statuses for UI display
        if (result.stepStatuses) {
          nodeState.stepStatuses = result.stepStatuses;
        }
        
        // Store captured Copilot session ID for future resumption
        if (result.copilotSessionId) {
          nodeState.copilotSessionId = result.copilotSessionId;
        }
        
        // Store agent execution metrics
        if (result.metrics) {
          nodeState.metrics = result.metrics;
        }
        
        // Store per-phase metrics breakdown
        if (result.phaseMetrics) {
          nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...result.phaseMetrics };
        }
        
        // Store process ID for crash detection
        if (result.pid) {
          nodeState.pid = result.pid;
        }
        
        // Clear resumeFromPhase after execution (success or failure)
        nodeState.resumeFromPhase = undefined;
        
        if (result.success) {
          this.log.info(`[executeNode] Executor succeeded for ${node.name}`, { planId: plan.id, nodeId: node.id });
          // Store completed commit.
          // If the executor produced no commit (e.g., expectsNoChanges validation
          // node), carry forward the baseCommit so downstream nodes in the FI
          // chain still receive the correct parent commit.
          if (result.completedCommit) {
            nodeState.completedCommit = result.completedCommit;
          } else if (!nodeState.completedCommit && nodeState.baseCommit) {
            nodeState.completedCommit = nodeState.baseCommit;
          }
          
          // Store work summary on node state and aggregate to Plan
          if (result.workSummary) {
            nodeState.workSummary = result.workSummary;
            this.appendWorkSummary(plan, result.workSummary);
          }
          
          // For leaf nodes, also compute aggregated work summary
          // This shows total diff from baseBranch to completedCommit
          const isLeaf = plan.leaves.includes(node.id);
          if (isLeaf && nodeState.worktreePath && nodeState.completedCommit && this.state.executor) {
            const worktreePath = nodeState.worktreePath;
            const executor = this.state.executor;
            const method = executor.computeAggregatedWorkSummary;
            if (method) {
              try {
                const aggregated = await method.call(executor, node, worktreePath, plan.baseBranch, plan.repoPath);
                nodeState.aggregatedWorkSummary = aggregated;
                this.log.info(`Computed aggregated work summary for leaf node ${node.name}`, {
                  commits: aggregated.commits,
                  filesAdded: aggregated.filesAdded,
                  filesModified: aggregated.filesModified,
                  filesDeleted: aggregated.filesDeleted,
                });
              } catch (error: any) {
                this.log.warn(`Failed to compute aggregated work summary for ${node.name}: ${error.message}`);
              }
            }
          }
        } else {
          // Executor failed - handle the failure
          this.log.info(`[executeNode] Executor FAILED for ${node.name}, entering failure path`, { planId: plan.id, nodeId: node.id, error: result.error });
          nodeState.error = result.error;
          
          // Store lastAttempt for retry context
          nodeState.lastAttempt = {
            phase: result.failedPhase || 'work',
            startTime: attemptStartedAt,
            endTime: Date.now(),
            error: result.error,
            exitCode: result.exitCode,
          };
          
          // Update stepStatuses from executor result (has proper success/failed values)
          if (result.stepStatuses) {
            nodeState.stepStatuses = result.stepStatuses;
          }

          // Record failed attempt in history (spread to snapshot — avoid mutation by auto-heal)
          const failedAttempt: AttemptRecord = {
            attemptNumber: nodeState.attempts,
            triggerType: nodeState.attempts === 1 ? 'initial' : 'retry',
            status: 'failed',
            startedAt: attemptStartedAt,
            endedAt: Date.now(),
            failedPhase: result.failedPhase,
            error: result.error,
            exitCode: result.exitCode,
            copilotSessionId: nodeState.copilotSessionId,
            stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
            phaseTiming: result.phaseTiming,
            worktreePath: nodeState.worktreePath,
            baseCommit: nodeState.baseCommit,
            logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
            logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
            workUsed: await resolveSpec('work'),
            metrics: nodeState.metrics,
            phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
          };
          this.recordCompletedAttempt(nodeState, failedAttempt, node.id);
          
          // ============================================================
          // AUTO-HEAL: Automatic AI-assisted retry for process/shell failures
          // ============================================================
          // If a process/shell phase failed and auto-heal is enabled,
          // retry once by swapping ONLY the failed phase to a Copilot agent
          // and resuming from that phase. Earlier phases that passed are
          // skipped; later phases (including commit) run normally.
          const failedPhase = result.failedPhase || 'work';
          const isHealablePhase = ['prechecks', 'work', 'postchecks'].includes(failedPhase);
          // Resolve the failed phase's work spec: prefer inline, fall back to disk (finalized plans)
          const failedWorkSpecInline = failedPhase === 'prechecks' ? node.prechecks
            : failedPhase === 'postchecks' ? node.postchecks
            : node.work;
          let failedWorkSpec = failedWorkSpecInline;
          if (!failedWorkSpec && plan.definition) {
            try {
              failedWorkSpec = failedPhase === 'prechecks'
                ? await plan.definition.getPrechecksSpec(node.id)
                : failedPhase === 'postchecks'
                  ? await plan.definition.getPostchecksSpec(node.id)
                  : await plan.definition.getWorkSpec(node.id);
              this.log.debug(`Loaded ${failedPhase} spec from disk for auto-heal decision`, { planId: plan.id, nodeId: node.id });
            } catch { /* best-effort */ }
          }
          const normalizedFailedSpec = normalizeWorkSpec(failedWorkSpec);
          const isAgentWork = normalizedFailedSpec?.type === 'agent';
          const isNonAgentWork = normalizedFailedSpec && normalizedFailedSpec.type !== 'agent';
          const autoHealEnabled = node.autoHeal !== false; // default true
          
          // Phase-level noAutoHeal overrides node-level autoHeal
          const phaseNoAutoHeal = result.noAutoHeal === true;
          
          // Detect external interruption (SIGTERM, SIGKILL, etc.) or runtime crash
          // Windows crash codes: 0xC0000005 (ACCESS_VIOLATION), 0xC00000FD (STACK_OVERFLOW),
          // 0xC0000374 (HEAP_CORRUPTION). These indicate the CLI crashed, not a task failure.
          const WINDOWS_CRASH_CODES = [3221226505, 3221225725, 3221226356]; // 0xC0000005, 0xC00000FD, 0xC0000374
          const wasExternallyKilled = result.error?.includes('killed by signal')
            || (result.exitCode !== undefined && WINDOWS_CRASH_CODES.includes(result.exitCode));
          
          // INFO logging for auto-retry decision (visible in logs)
          this.log.info(`Auto-retry decision for ${node.name}: phase=${failedPhase}, isHealable=${isHealablePhase}, isAgentWork=${isAgentWork}, wasExternallyKilled=${wasExternallyKilled}, autoHealEnabled=${autoHealEnabled}, phaseNoAutoHeal=${phaseNoAutoHeal}`, {
            planId: plan.id,
            nodeId: node.id,
            error: result.error,
          });
          
          // Store failure message on node state for UI display
          if (result.failureMessage) {
            nodeState.forceFailMessage = result.failureMessage;
          }
          
          // Override resumeFromPhase if specified by the phase executor
          if (result.overrideResumeFromPhase) {
            nodeState.resumeFromPhase = result.overrideResumeFromPhase;
          }
          
          const healCount = (() => {
            const v = nodeState.autoHealAttempted?.[failedPhase as 'prechecks' | 'work' | 'postchecks'];
            if (v === true) {return 1;} // backward compat
            return typeof v === 'number' ? v : 0;
          })();
          const MAX_AUTO_HEAL_PER_PHASE = this.state.configManager.getConfig<number>('copilotOrchestrator.autoHeal', 'maxAttempts', 4);
          const phaseAlreadyHealed = healCount >= MAX_AUTO_HEAL_PER_PHASE;
          
          // Auto-retry is allowed if:
          // 1. Non-agent work (existing behavior - swap to agent)
          // 2. Agent work that was externally killed (retry same agent)
          // 3. NOT blocked by phase-level noAutoHeal
          // 4. Under per-phase heal budget
          const shouldAttemptAutoRetry = isHealablePhase && autoHealEnabled && !phaseAlreadyHealed && !phaseNoAutoHeal &&
            (isNonAgentWork || (isAgentWork && wasExternallyKilled));
          
          this.log.info(`Auto-retry shouldAttempt=${shouldAttemptAutoRetry}: isHealablePhase=${isHealablePhase}, autoHealEnabled=${autoHealEnabled}, phaseAlreadyHealed=${phaseAlreadyHealed}, phaseNoAutoHeal=${phaseNoAutoHeal}, isNonAgentWork=${isNonAgentWork}, isAgentWork=${isAgentWork}`, {
            planId: plan.id,
            nodeId: node.id,
          });
          
          // Persist plan state BEFORE auto-retry to capture failure record
          await this.savePlanState(plan);
          
          if (shouldAttemptAutoRetry) {
            if (!nodeState.autoHealAttempted) {nodeState.autoHealAttempted = {};}
            nodeState.autoHealAttempted[failedPhase as 'prechecks' | 'work' | 'postchecks'] = healCount + 1;
            
            if (isAgentWork && wasExternallyKilled) {
              // Agent was interrupted - retry with same spec (don't swap to different agent spec)
              this.log.info(`Auto-retry: agent was externally killed, retrying ${node.name} (phase: ${failedPhase})`, {
                planId: plan.id,
                nodeId: node.id,
                signal: result.error,
              });
              
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: AGENT INTERRUPTED, RETRYING ==========', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', `Phase "${failedPhase}" agent was externally killed. Retrying same agent.`, nodeState.attempts);
              
              // Reset state for the retry attempt (do NOT increment attempts — auto-retries
              // are sub-attempts of the current attempt, not new user-visible attempts)
              nodeState.error = undefined;
              // nodeState.startedAt is set-once — each attempt tracks its own startedAt in AttemptRecord

              // Capture log offsets for the retry attempt so its logs are isolated
              const retryLogMemoryOffset = this.state.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
              const retryLogFileOffset = this.state.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;

              // Execute with resumeFromPhase to skip already-passed phases
              // Critical: preserve merge-specific fields so RI merge runs for leaf nodes
              const retryContext: ExecutionContext = {
                plan,
                node,
                baseCommit: nodeState.baseCommit!,
                worktreePath,
                attemptNumber: nodeState.attempts,
                copilotSessionId: nodeState.copilotSessionId,
                resumeFromPhase: failedPhase as ExecutionContext['resumeFromPhase'],
                previousStepStatuses: nodeState.stepStatuses,
                phaseTiming: [], // Fresh phaseTiming for this sub-attempt
                // Merge-specific fields (must match original context)
                dependencyCommits: dependencyCommits.length > 0 ? dependencyCommits : undefined,
                repoPath: plan.repoPath,
                targetBranch: plan.leaves.includes(node.id) ? plan.targetBranch : undefined,
                baseCommitAtStart: plan.baseCommitAtStart,
                snapshotBranch: (node.assignedWorktreePath === plan.snapshot?.worktreePath) ? undefined : plan.snapshot?.branch,
                snapshotWorktreePath: plan.snapshot?.worktreePath,
                onProgress: (step) => {
                  this.log.debug(`Auto-retry progress: ${node.name} - ${step}`);
                },
                onStepStatusChange: (phase, status) => {
                  if (!nodeState.stepStatuses) {nodeState.stepStatuses = {};}
                  (nodeState.stepStatuses as any)[phase] = status;
                  if (nodeState.attemptHistory && nodeState.attemptHistory.length > 0) {
                    const last = nodeState.attemptHistory[nodeState.attemptHistory.length - 1];
                    if (last.status === 'running') { last.stepStatuses = { ...nodeState.stepStatuses }; }
                  }
                },
              };
              
              const retryResult = await this.state.executor!.execute(retryContext);
              
              // Store step statuses from retry attempt
              if (retryResult.stepStatuses) {
                nodeState.stepStatuses = retryResult.stepStatuses;
              }
              
              // Capture session ID from retry attempt
              if (retryResult.copilotSessionId) {
                nodeState.copilotSessionId = retryResult.copilotSessionId;
              }
              
              if (retryResult.success) {
                this.log.info(`Auto-retry succeeded for ${node.name}!`, {
                  planId: plan.id,
                  nodeId: node.id,
                });
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: SUCCESS ==========', nodeState.attempts);
                
                autoHealSucceeded = true;
                if (retryResult.completedCommit) {
                  nodeState.completedCommit = retryResult.completedCommit;
                } else if (!nodeState.completedCommit && nodeState.baseCommit) {
                  // CRITICAL: If auto-retry produced no new commit (e.g., expects_no_changes),
                  // fall back to baseCommit which contains all upstream work from dependencies.
                  // Without this, leaf nodes lose all upstream changes during RI merge.
                  nodeState.completedCommit = nodeState.baseCommit;
                }
                if (retryResult.workSummary) {
                  nodeState.workSummary = retryResult.workSummary;
                  this.appendWorkSummary(plan, retryResult.workSummary);
                }
                if (retryResult.metrics) {
                  nodeState.metrics = retryResult.metrics;
                }
                if (retryResult.phaseMetrics) {
                  nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...retryResult.phaseMetrics };
                }
                // Update log offsets so the success record captures only retry logs
                logMemoryOffset = retryLogMemoryOffset;
                logFileOffset = retryLogFileOffset;
                // Fall through to RI merge handling below
              } else {
                // Auto-retry also failed — record it and transition to failed
                this.log.warn(`Auto-retry failed for ${node.name}`, {
                  planId: plan.id,
                  nodeId: node.id,
                  error: retryResult.error,
                });
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: FAILED ==========', nodeState.attempts);
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'error', `Auto-retry could not complete: ${retryResult.error}`, nodeState.attempts);
                
                nodeState.error = `Auto-retry failed: ${retryResult.error}`;
                
                if (retryResult.metrics) {
                  nodeState.metrics = retryResult.metrics;
                }
                if (retryResult.phaseMetrics) {
                  nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...retryResult.phaseMetrics };
                }
                
                // Record retry attempt in history
                const retryAttempt: AttemptRecord = {
                  attemptNumber: nodeState.attempts,
                  triggerType: 'auto-heal',
                  status: 'failed',
                  startedAt: attemptStartedAt,
                  endedAt: Date.now(),
                  failedPhase: retryResult.failedPhase,
                  error: retryResult.error,
                  exitCode: retryResult.exitCode,
                  copilotSessionId: nodeState.copilotSessionId,
                  stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
                  phaseTiming: retryResult.phaseTiming,
                  worktreePath: nodeState.worktreePath,
                  baseCommit: nodeState.baseCommit,
                  logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, retryLogMemoryOffset, retryLogFileOffset, nodeState.attempts),
                  logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
                  workUsed: await resolveSpec('work'),
                  metrics: nodeState.metrics,
                  phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
                };
                this.recordCompletedAttempt(nodeState, retryAttempt, node.id);
                
                // Clear process ID since execution is complete
                nodeState.pid = undefined;
                
                sm.transition(node.id, 'failed');
                this.state.events.emit('nodeCompleted', plan.id, node.id, false);
                
                this.log.error(`Job failed (after auto-retry): ${node.name}`, {
                  planId: plan.id,
                  nodeId: node.id,
                  error: retryResult.error,
                });
                await this.savePlanState(plan);
                return;
              }
            } else {
            // Non-agent work failed — existing auto-heal logic (swap to agent)
            this.log.info(`Auto-heal: attempting AI-assisted fix for ${node.name} (phase: ${failedPhase})`, {
              planId: plan.id,
              nodeId: node.id,
              exitCode: result.exitCode,
            });
            
            // Log the auto-heal attempt in the failed phase's log stream
            this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '', nodeState.attempts);
            this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-HEAL: AI-ASSISTED FIX ATTEMPT ==========', nodeState.attempts);
            this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', `Phase "${failedPhase}" failed. Delegating to Copilot agent to diagnose and fix.`, nodeState.attempts);
            
            // Gather context the agent needs to diagnose and fix the failure:
            // 1. The original command that was run
            // 2. The full execution logs (stdout/stderr) from the failed phase
            const originalCommand = (() => {
              const spec = normalizeWorkSpec(failedWorkSpec);
              if (!spec) {return 'Unknown command';}
              if (spec.type === 'shell') {return spec.command;}
              if (spec.type === 'process') {return `${spec.executable} ${(spec.args || []).join(' ')}`;}
              return 'Unknown command';
            })();
            
            // Get the execution logs for the failed phase — these contain
            // the full stdout/stderr streams plus timing info
            // Truncate to last ~200 lines to avoid overwhelming the agent
            // Get the log file path so the agent can read it directly
            const failedLogFilePath = this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts);

            // Replace the original instructions file with a heal-specific one.
            // This prevents the copilot CLI from re-reading and re-executing the
            // original task. The heal instructions point the agent at the log file.
            try {
              const instrDir = path.join(worktreePath, '.github', 'instructions');
              
              // Remove original instructions
              if (fs.existsSync(instrDir)) {
                const files = fs.readdirSync(instrDir) as string[];
                for (const f of files) {
                  if (f.startsWith('orchestrator-job')) {
                    fs.unlinkSync(path.join(instrDir, f));
                  }
                }
              } else {
                fs.mkdirSync(instrDir, { recursive: true });
              }
              
              // Write heal instructions file
              const isPostchecksHeal = failedPhase === 'postchecks';
              const healInstructions = isPostchecksHeal
                ? [
                    `# Auto-Heal: Diagnose Failed postchecks Phase`,
                    '',
                    `## IMPORTANT: Do NOT fix anything. Diagnosis ONLY.`,
                    '',
                    `The postchecks phase failed. Your job is to DIAGNOSE why, NOT to fix it.`,
                    `Postchecks validate that previous phases produced correct results.`,
                    `If the check command itself is wrong (wrong path, wrong logic, etc.),`,
                    `you MUST exit with failure — this is unrecoverable and needs human attention.`,
                    '',
                    `## Log File`,
                    failedLogFilePath
                      ? `Read: \`${failedLogFilePath}\``
                      : 'No log file available.',
                    '',
                    `## Postchecks Command That Failed`,
                    '```',
                    originalCommand,
                    '```',
                    '',
                    `## What To Do`,
                    `1. Read the log file to understand what the postchecks command checked`,
                    `2. Determine if the failure is because:`,
                    `   a) The work phase didn't produce expected output → try to fix the work output, then re-run the command`,
                    `   b) The postchecks command itself is wrong (wrong path, wrong assertion) → EXIT WITH FAILURE`,
                    `3. If (a): fix the work output and re-run the command to verify`,
                    `4. If (b): do NOT attempt to fix the command. Just exit with failure.`,
                  ].join('\n')
                : [
                    `# Auto-Heal: Fix Failed ${failedPhase} Phase`,
                    '',
                    `Do NOT re-execute the original task. Your only job is to fix the error.`,
                    '',
                    `## Log File`,
                    failedLogFilePath
                      ? `Read: \`${failedLogFilePath}\``
                      : 'No log file available.',
                    '',
                    `## Command to Fix and Re-run`,
                    '```',
                    originalCommand,
                    '```',
                    '',
                    `Read the log file, find the error, fix it, then re-run the command above.`,
                  ].join('\n');
              
              const healFile = path.join(instrDir, `orchestrator-heal-${node.id.slice(0, 8)}.instructions.md`);
              fs.writeFileSync(healFile, healInstructions, 'utf8');
              this.log.debug(`Wrote heal instructions to: ${healFile}`);
            } catch (e: any) {
              this.log.debug(`Could not write heal instructions file: ${e.message}`);
            }

            // Build comprehensive allowedFolders for the heal agent:
            // 1. Always include the worktree (required for file access and shell commands)
            // 2. Collect allowedFolders from ALL agent phase specs (prechecks, work, postchecks)
            //    so the heal agent can access the same directories as any agent phase
            // 3. Include the entire specs directory so the agent can read ANY attempt's logs
            const specsDir = path.join(this.state.persistence.getStoragePath(), plan.id, 'specs', node.id);
            const healAllowedFolders: string[] = [worktreePath];
            if (!healAllowedFolders.includes(specsDir)) { healAllowedFolders.push(specsDir); }
            // Collect from failed spec and from all agent phase specs (read from disk)
            const allPhaseSpecs = await Promise.all([resolveSpec('prechecks'), resolveSpec('work'), resolveSpec('postchecks')]);
            for (const phaseSpec of [...allPhaseSpecs, failedWorkSpec]) {
              const normalized = normalizeWorkSpec(phaseSpec);
              if (normalized?.type === 'agent' && normalized.allowedFolders) {
                for (const f of normalized.allowedFolders) {
                  if (!healAllowedFolders.includes(f)) { healAllowedFolders.push(f); }
                }
              }
            }
            // Collect allowedUrls from all agent phase specs
            const healAllowedUrls: string[] = [];
            for (const phaseSpec of [...allPhaseSpecs, failedWorkSpec]) {
              const normalized = normalizeWorkSpec(phaseSpec);
              if (normalized?.type === 'agent' && normalized.allowedUrls) {
                for (const u of normalized.allowedUrls) {
                  if (!healAllowedUrls.includes(u)) { healAllowedUrls.push(u); }
                }
              }
            }
            const healSpec: WorkSpec = {
              type: 'agent',
              instructions: 'Fix the error described in the heal instructions file. Read the log file, diagnose the failure, fix it, and re-run the command.',
              allowedFolders: healAllowedFolders,
              allowedUrls: healAllowedUrls.length > 0 ? healAllowedUrls : undefined,
            };
            
            // Place heal agent as work, preserve original prechecks/postchecks
            node.work = healSpec;
            
            // Increment attempts for auto-heal — swapping from shell/process to agent
            // is a distinct execution attempt visible in attempt history
            await this.incrementAttempt(plan, node.id, nodeState);
            nodeState.error = undefined;
            attemptStartedAt = Date.now();
            this.recordRunningAttempt(nodeState, attemptStartedAt, 'auto-heal');
            
            // Capture HEAD before heal so we can detect if the agent made changes
            let preHealHead: string | undefined;
            try {
              preHealHead = (await this.git.repository.getHead(worktreePath)) || undefined;
            } catch { /* best-effort */ }
            
            // Capture log offsets for the auto-heal attempt
            const healLogMemoryOffset = this.state.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
            const healLogFileOffset = this.state.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;
            
            // Execute with resumeFromPhase to skip already-passed phases
            // Critical: preserve merge-specific fields so RI merge runs for leaf nodes
            const healContext: ExecutionContext = {
              plan,
              node,
              baseCommit: nodeState.baseCommit!,
              worktreePath,
              attemptNumber: nodeState.attempts,
              copilotSessionId: nodeState.copilotSessionId,
              resumeFromPhase: 'work', // Always resume from work — heal agent IS the work phase
              previousStepStatuses: nodeState.stepStatuses,
              phaseTiming: [], // Fresh phaseTiming for this attempt — must not inherit from prior attempt
              // Merge-specific fields (must match original context)
              dependencyCommits: dependencyCommits.length > 0 ? dependencyCommits : undefined,
              repoPath: plan.repoPath,
              targetBranch: plan.leaves.includes(node.id) ? plan.targetBranch : undefined,
              baseCommitAtStart: plan.baseCommitAtStart,
              snapshotBranch: (node.assignedWorktreePath === plan.snapshot?.worktreePath) ? undefined : plan.snapshot?.branch,
              snapshotWorktreePath: plan.snapshot?.worktreePath,
              onProgress: (step) => {
                this.log.debug(`Auto-heal progress: ${node.name} - ${step}`);
              },
              onStepStatusChange: (phase, status) => {
                if (!nodeState.stepStatuses) {nodeState.stepStatuses = {};}
                (nodeState.stepStatuses as any)[phase] = status;
                if (nodeState.attemptHistory && nodeState.attemptHistory.length > 0) {
                  const last = nodeState.attemptHistory[nodeState.attemptHistory.length - 1];
                  if (last.status === 'running') { last.stepStatuses = { ...nodeState.stepStatuses }; }
                }
              },
            };
            
            const healResult = await this.state.executor!.execute(healContext);
            
            // NOTE: No spec restore — in the new auto-heal model, each heal builds
            // on the last. node.work stays as healSpec. If the heal succeeds and the
            // pipeline runs postchecks (which pass), the node succeeds. If postchecks
            // fail again, the next auto-heal cycle will create a new healSpec referencing
            // the latest failure log.
            
            // Store step statuses from heal attempt
            if (healResult.stepStatuses) {
              nodeState.stepStatuses = healResult.stepStatuses;
            }
            
            // Capture session ID from heal attempt
            if (healResult.copilotSessionId) {
              nodeState.copilotSessionId = healResult.copilotSessionId;
            }
            
            if (healResult.success) {
              // Verify the heal agent actually made changes.
              // The Copilot CLI exits 0 even when the agent diagnoses a problem
              // without fixing it. If HEAD hasn't moved AND there are no uncommitted
              // changes, the agent didn't produce a real fix — treat as failure.
              let healMadeChanges = true;
              if (preHealHead) {
                try {
                  const postHealHead = (await this.git.repository.getHead(worktreePath)) || undefined;
                  const hasUncommitted = await this.git.repository.hasUncommittedChanges(worktreePath);
                  if (postHealHead === preHealHead && !hasUncommitted) {
                    healMadeChanges = false;
                    this.log.warn(`Auto-heal agent made no code changes for ${node.name}`, { planId: plan.id, nodeId: node.id });
                    this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info',
                      '========== AUTO-HEAL: NO CHANGES DETECTED ==========', nodeState.attempts);
                    this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info',
                      'The heal agent completed without making any code changes. This typically means the agent diagnosed the issue but could not fix it.', nodeState.attempts);
                  }
                } catch { /* best-effort — if git check fails, assume changes were made */ }
              }
              
              if (!healMadeChanges) {
                // Treat as failure — the agent didn't actually fix anything
                healResult.success = false;
                healResult.error = 'Auto-heal agent completed without making code changes (diagnosis only, no fix applied)';
                healResult.noAutoHeal = true; // Don't re-heal a no-op heal
              }
            }
            
            if (healResult.success) {
              this.log.info(`Auto-heal succeeded for ${node.name}!`, {
                planId: plan.id,
                nodeId: node.id,
              });
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-HEAL: SUCCESS ==========', nodeState.attempts);
              
              autoHealSucceeded = true;
              if (healResult.completedCommit) {
                nodeState.completedCommit = healResult.completedCommit;
              } else if (!nodeState.completedCommit && nodeState.baseCommit) {
                // CRITICAL: If auto-heal produced no new commit (e.g., expects_no_changes),
                // fall back to baseCommit which contains all upstream work from dependencies.
                // Without this, leaf nodes lose all upstream changes during RI merge.
                nodeState.completedCommit = nodeState.baseCommit;
              }
              if (healResult.workSummary) {
                nodeState.workSummary = healResult.workSummary;
                this.appendWorkSummary(plan, healResult.workSummary);
              }
              // Store agent metrics from heal attempt so AI Usage section renders
              if (healResult.metrics) {
                nodeState.metrics = healResult.metrics;
              }
              if (healResult.phaseMetrics) {
                nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...healResult.phaseMetrics };
              }
              
              // In the new auto-heal model, no separate re-validation is needed.
              // The heal agent runs as WORK, then the pipeline naturally runs commit
              // and the original postchecks. If postchecks fail again, a new auto-heal
              // cycle starts (up to MAX_AUTO_HEAL_PER_PHASE budget).
              
              // Fall through to RI merge handling below
            } else {
              // Auto-heal also failed — record it and transition to failed
              this.log.warn(`Auto-heal failed for ${node.name}`, {
                planId: plan.id,
                nodeId: node.id,
                error: healResult.error,
              });
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-HEAL: FAILED ==========', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'error', `Auto-heal could not fix the issue: ${healResult.error}`, nodeState.attempts);
              
              nodeState.error = `Auto-heal failed: ${healResult.error}`;
              
              // Store agent metrics from heal attempt
              if (healResult.metrics) {
                nodeState.metrics = healResult.metrics;
              }
              if (healResult.phaseMetrics) {
                nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...healResult.phaseMetrics };
              }
              
              // Record heal attempt in history
              const healAttempt: AttemptRecord = {
                attemptNumber: nodeState.attempts,
                triggerType: 'auto-heal',
                status: 'failed',
                startedAt: attemptStartedAt,
                endedAt: Date.now(),
                failedPhase: healResult.failedPhase,
                error: healResult.error,
                exitCode: healResult.exitCode,
                copilotSessionId: nodeState.copilotSessionId,
                stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
                phaseTiming: healResult.phaseTiming,
                worktreePath: nodeState.worktreePath,
                baseCommit: nodeState.baseCommit,
                logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, healLogMemoryOffset, healLogFileOffset, nodeState.attempts),
                logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
                workUsed: healSpec,
                metrics: nodeState.metrics,
                phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
              };
              this.recordCompletedAttempt(nodeState, healAttempt, node.id);
              
              // Clear process ID since execution is complete
              nodeState.pid = undefined;
              
              sm.transition(node.id, 'failed');
              this.state.events.emit('nodeCompleted', plan.id, node.id, false);
              
              this.log.error(`Job failed (after auto-heal): ${node.name}`, {
                planId: plan.id,
                nodeId: node.id,
                error: healResult.error,
              });
              await this.savePlanState(plan);
              return;
            }
            }
          } else {
            // No AI auto-heal — check if the failure has a resumeFromPhase directive
            // (e.g., SV postchecks wants to retry from prechecks to rebase the snapshot)
            if (result.overrideResumeFromPhase && !phaseAlreadyHealed) {
              this.log.info(`Auto-retry from phase '${result.overrideResumeFromPhase}' (no AI heal): ${node.name}`, {
                planId: plan.id, nodeId: node.id,
              });

              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '', nodeState.attempts);
              this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', `========== AUTO-RETRY: RESUMING FROM ${result.overrideResumeFromPhase.toUpperCase()} ==========`, nodeState.attempts);

              // NOTE: The failed attempt was ALREADY recorded in attemptHistory
              // by the top-level failure handler (line ~456). Do NOT record again.

              // Track as a heal attempt for the budget
              if (!nodeState.autoHealAttempted) { nodeState.autoHealAttempted = {}; }
              nodeState.autoHealAttempted[failedPhase as 'prechecks' | 'work' | 'postchecks'] = healCount + 1;

              // Reset state for retry
              nodeState.error = undefined;
              await this.incrementAttempt(plan, node.id, nodeState);
              attemptStartedAt = Date.now();
              this.recordRunningAttempt(nodeState, attemptStartedAt, 'auto-heal');
              nodeState.resumeFromPhase = result.overrideResumeFromPhase;

              // Capture log offsets for the retry
              const retryLogMemoryOffset = this.state.executor?.getLogs?.(plan.id, node.id)?.length ?? 0;
              const retryLogFileOffset = this.state.executor?.getLogFileSize?.(plan.id, node.id) ?? 0;

              // Re-run the executor from the specified phase
              const retryCtx: ExecutionContext = {
                plan, node, baseCommit: nodeState.baseCommit!, worktreePath,
                attemptNumber: nodeState.attempts,
                copilotSessionId: nodeState.copilotSessionId,
                resumeFromPhase: result.overrideResumeFromPhase as ExecutionContext['resumeFromPhase'],
                previousStepStatuses: nodeState.stepStatuses,
                phaseTiming: [], // Fresh phaseTiming for this retry attempt
                dependencyCommits: dependencyCommits.length > 0 ? dependencyCommits : undefined,
                repoPath: plan.repoPath,
                targetBranch: plan.leaves.includes(node.id) ? plan.targetBranch : undefined,
                baseCommitAtStart: plan.baseCommitAtStart,
                snapshotBranch: (node.assignedWorktreePath === plan.snapshot?.worktreePath) ? undefined : plan.snapshot?.branch,
                snapshotWorktreePath: plan.snapshot?.worktreePath,
                onProgress: (s) => { this.log.debug(`Auto-retry: ${node.name} - ${s}`); },
                onStepStatusChange: (p, s) => {
                  if (!nodeState.stepStatuses) {nodeState.stepStatuses = {};}
                  (nodeState.stepStatuses as any)[p] = s;
                  if (nodeState.attemptHistory?.length) { const last = nodeState.attemptHistory[nodeState.attemptHistory.length - 1]; if (last.status === 'running') { last.stepStatuses = { ...nodeState.stepStatuses }; } }
                },
              };

              const retryResult = await this.state.executor!.execute(retryCtx);

              if (retryResult.stepStatuses) { nodeState.stepStatuses = retryResult.stepStatuses; }
              if (retryResult.copilotSessionId) { nodeState.copilotSessionId = retryResult.copilotSessionId; }

              if (retryResult.success) {
                this.log.info(`Auto-retry from ${result.overrideResumeFromPhase} succeeded for ${node.name}`, { planId: plan.id, nodeId: node.id });
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: SUCCESS ==========', nodeState.attempts);
                autoHealSucceeded = true;
                if (retryResult.completedCommit) {
                  nodeState.completedCommit = retryResult.completedCommit;
                } else if (!nodeState.completedCommit && nodeState.baseCommit) {
                  nodeState.completedCommit = nodeState.baseCommit;
                }
                if (retryResult.workSummary) { nodeState.workSummary = retryResult.workSummary; this.appendWorkSummary(plan, retryResult.workSummary); }
                if (retryResult.metrics) { nodeState.metrics = retryResult.metrics; }
                if (retryResult.phaseMetrics) { nodeState.phaseMetrics = { ...nodeState.phaseMetrics, ...retryResult.phaseMetrics }; }
                logMemoryOffset = retryLogMemoryOffset;
                logFileOffset = retryLogFileOffset;
                // Fall through to success path
              } else {
                this.log.warn(`Auto-retry from ${result.overrideResumeFromPhase} failed for ${node.name}`, { planId: plan.id, nodeId: node.id, error: retryResult.error });
                this.execLog(plan.id, node.id, failedPhase as ExecutionPhase, 'info', '========== AUTO-RETRY: FAILED ==========', nodeState.attempts);

                // Record the retry failure in attempt history
                const retryFailedAttempt: AttemptRecord = {
                  attemptNumber: nodeState.attempts,
                  triggerType: 'retry',
                  status: 'failed',
                  startedAt: attemptStartedAt,
                  endedAt: Date.now(),
                  failedPhase: retryResult.failedPhase || failedPhase,
                  error: retryResult.error,
                  exitCode: retryResult.exitCode,
                  copilotSessionId: nodeState.copilotSessionId,
                  stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
                  phaseTiming: retryResult.phaseTiming,
                  worktreePath: nodeState.worktreePath,
                  baseCommit: nodeState.baseCommit,
                  logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, retryLogMemoryOffset, retryLogFileOffset, nodeState.attempts),
                  logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
                  workUsed: await resolveSpec('work'),
                  metrics: retryResult.metrics,
                  phaseMetrics: retryResult.phaseMetrics ? { ...retryResult.phaseMetrics } : undefined,
                };
                this.recordCompletedAttempt(nodeState, retryFailedAttempt, node.id);

                nodeState.error = retryResult.error;
                nodeState.pid = undefined;
                sm.transition(node.id, 'failed');
                this.state.events.emit('nodeCompleted', plan.id, node.id, false);
                await this.savePlanState(plan);
                return;
              }
            } else {
              // No auto-heal AND no resumeFromPhase — transition to failed normally
              nodeState.pid = undefined;
              sm.transition(node.id, 'failed');
              this.state.events.emit('nodeCompleted', plan.id, node.id, false);
              this.log.error(`Job failed: ${node.name}`, {
                planId: plan.id,
                nodeId: node.id,
                phase: nodeState.lastAttempt?.phase || 'unknown',
                error: nodeState.error,
              });
              await this.savePlanState(plan);
              return;
            }
          }
        }
      
      // At this point, executor succeeded (or was skipped for RI-only retry)
      // Leaf node tracking - merge phases handled by executor pipeline
      const isLeaf = plan.leaves.includes(node.id);
      this.log.debug(`Node completion: node=${node.name}, isLeaf=${isLeaf}, targetBranch=${plan.targetBranch}, completedCommit=${nodeState.completedCommit?.slice(0, 8)}`);
      
      // For leaf nodes, assume merge will be handled by executor's merge-ri phase
      if (isLeaf && plan.targetBranch) {
        // The executor's merge-ri phase will handle reverse integration
        // We'll check the nodeState step status to determine if RI succeeded
        const riStatus = nodeState.stepStatuses?.['merge-ri'];
        const riSuccess = riStatus === 'success';
        nodeState.mergedToTarget = riSuccess;
        
        // Detect when RI merge was unexpectedly skipped for a leaf node
        if (riStatus === 'skipped' || !riStatus) {
          this.log.warn(`RI merge was ${riStatus || 'missing'} for leaf node ${node.name} — expected success or failure`);
        }
      } else {
        nodeState.mergedToTarget = true; // No merge needed
      }
      
      // Check if RI merge failed or was unexpectedly skipped
      const riMergeFailed = isLeaf && plan.targetBranch && 
        (nodeState.stepStatuses?.['merge-ri'] === 'failed' || nodeState.stepStatuses?.['merge-ri'] === 'skipped');
      
      // If RI merge failed, treat the node as failed (work succeeded but merge did not)
      if (riMergeFailed) {
        nodeState.error = `Reverse integration merge to ${plan.targetBranch} failed. Work completed successfully but merge could not be performed. Worktree preserved for manual retry.`;
        
        // Store lastAttempt for retry context
        nodeState.lastAttempt = {
          phase: 'merge-ri',
          startTime: attemptStartedAt,
          endTime: Date.now(),
          error: nodeState.error,
        };
        
        // Record failed attempt in history
        const riFailedAttempt: AttemptRecord = {
          attemptNumber: nodeState.attempts,
          triggerType: autoHealSucceeded ? 'auto-heal' : (nodeState.attempts === 1 ? 'initial' : 'retry'),
          status: 'failed',
          startedAt: attemptStartedAt,
          endedAt: Date.now(),
          failedPhase: 'merge-ri',
          error: nodeState.error,
          copilotSessionId: nodeState.copilotSessionId,
          stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
          phaseTiming: result.phaseTiming,
          worktreePath: nodeState.worktreePath,
          baseCommit: nodeState.baseCommit,
          completedCommit: nodeState.completedCommit, // Work was successful, so we have the commit
          logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
          logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
          workUsed: await resolveSpec('work'),
          metrics: nodeState.metrics,
          phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
        };
        this.recordCompletedAttempt(nodeState, riFailedAttempt, node.id);
        
        // Clear process ID since execution is complete
        nodeState.pid = undefined;
        
        sm.transition(node.id, 'failed');
        this.state.events.emit('nodeCompleted', plan.id, node.id, false);
        
        this.log.error(`Job failed (RI merge): ${node.name}`, {
          planId: plan.id,
          nodeId: node.id,
          commit: nodeState.completedCommit?.slice(0, 8),
          targetBranch: plan.targetBranch,
        });
      } else {
        // Record successful attempt in history
        const successAttempt: AttemptRecord = {
          attemptNumber: nodeState.attempts,
          triggerType: autoHealSucceeded ? 'auto-heal' : (nodeState.attempts === 1 ? 'initial' : 'retry'),
          status: 'succeeded',
          startedAt: attemptStartedAt,
          endedAt: Date.now(),
          copilotSessionId: nodeState.copilotSessionId,
          stepStatuses: nodeState.stepStatuses ? { ...nodeState.stepStatuses } : undefined,
          phaseTiming: result.phaseTiming,
          worktreePath: nodeState.worktreePath,
          baseCommit: nodeState.baseCommit,
          logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
          logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
          workUsed: await resolveSpec('work'),
          metrics: nodeState.metrics,
          phaseMetrics: nodeState.phaseMetrics ? { ...nodeState.phaseMetrics } : undefined,
        };
        this.recordCompletedAttempt(nodeState, successAttempt, node.id);
        
        // Clear process ID since execution is complete
        nodeState.pid = undefined;
        
        sm.transition(node.id, 'succeeded');
        this.state.events.emit('nodeCompleted', plan.id, node.id, true);
        
        // Cleanup this node's worktree if eligible
        // For leaf nodes: eligible after RI merge to targetBranch (or no targetBranch)
        // For non-leaf nodes: handled via acknowledgeConsumption when dependents FI
        if (plan.cleanUpSuccessfulWork && nodeState.worktreePath) {
          const isLeafNode = plan.leaves.includes(node.id);
          if (isLeafNode) {
            // Leaf: cleanup now if merged (or no target branch)
            if (!plan.targetBranch || nodeState.mergedToTarget) {
              await this.cleanupWorktree(nodeState.worktreePath, plan.repoPath);
              nodeState.worktreeCleanedUp = true;
              await this.savePlanState(plan);
            }
          }
          // Non-leaf nodes are cleaned up via acknowledgeConsumption when dependents FI
        }
        
        this.log.info(`Job succeeded: ${node.name}`, {
          planId: plan.id,
          nodeId: node.id,
          commit: nodeState.completedCommit?.slice(0, 8),
        });
      }
    } catch (error: any) {
      nodeState.error = error.message;
      
      // Use failedPhase from error if set, otherwise default to 'work'
      const failedPhase = error.failedPhase || 'work';
      
      // Store lastAttempt for retry context
      nodeState.lastAttempt = {
        phase: failedPhase,
        startTime: attemptStartedAt,
        endTime: Date.now(),
        error: error.message,
      };
      
      // Record failed attempt in history
      const errorAttempt: AttemptRecord = {
        attemptNumber: nodeState.attempts,
        triggerType: nodeState.attempts === 1 ? 'initial' : 'retry',
        status: 'failed',
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        failedPhase: failedPhase,
        error: error.message,
        copilotSessionId: nodeState.copilotSessionId,
        stepStatuses: nodeState.stepStatuses,
        phaseTiming: undefined, // Error path - no result.phaseTiming available
        worktreePath: nodeState.worktreePath,
        baseCommit: nodeState.baseCommit,
        logs: this.nodeManager.getNodeLogsFromOffset(plan.id, node.id, logMemoryOffset, logFileOffset, nodeState.attempts),
        logFilePath: this.nodeManager.getNodeLogFilePath(plan.id, node.id, nodeState.attempts),
        workUsed: node.work, // Best-effort: may be undefined for finalized plans in error path
        metrics: nodeState.metrics,
        phaseMetrics: nodeState.phaseMetrics,
      };
      this.recordCompletedAttempt(nodeState, errorAttempt, node.id);
      
      // Clear process ID since execution is complete
      nodeState.pid = undefined;
      
      sm.transition(node.id, 'failed');
      this.state.events.emit('nodeCompleted', plan.id, node.id, false);
      
      this.log.error(`Job execution error: ${node.name}`, {
        planId: plan.id,
        nodeId: node.id,
        error: error.message,
      });
    }
    
    // Persist after execution
    await this.savePlanState(plan);
  }

  // ============================================================================
  // GIT OPERATIONS
  // ============================================================================
  
  /**
   * Acquire the RI merge mutex, execute `fn`, then release.
   * 
   * Uses a promise-chain pattern: each call chains onto the previous,
   * ensuring strictly sequential execution without external dependencies.
   * If `fn` throws, the mutex is still released so subsequent merges proceed.
   */
  private async withRiMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>(resolve => { releaseLock = resolve; });
    
    // Chain onto whatever was previously running
    const previousLock = this.riMergeMutex;
    this.riMergeMutex = lockAcquired;
    
    // Wait for the previous RI merge to finish
    await previousLock;
    
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  // ============================================================================
  // MERGE METHODS (moved to executor phases)
  // ============================================================================
  // The merge logic has been moved to MergeFiPhaseExecutor and MergeRiPhaseExecutor
  // to integrate with the executor's phase pipeline system.

  /**
   * Update a branch reference to point to a new commit.
   * Handles the case where the branch is checked out in the main repo.
   * 
   * Includes retry logic for transient index.lock failures that can occur
   * when VS Code's built-in git extension briefly holds the lock.
   * 
   * @returns true if branch was updated, false if update was skipped (e.g., stash failed)
   */
  private async updateBranchRef(
    repoPath: string,
    branchName: string,
    newCommit: string,
    retryCount = 0
  ): Promise<boolean> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;
    
    try {
      return await this.updateBranchRefCore(repoPath, branchName, newCommit);
    } catch (err: any) {
      const isLockError = err.message?.includes('index.lock') || err.message?.includes('lock');
      if (isLockError && retryCount < MAX_RETRIES) {
        this.log.warn(`index.lock contention on updateBranchRef, retrying (${retryCount + 1}/${MAX_RETRIES}) in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
        return this.updateBranchRef(repoPath, branchName, newCommit, retryCount + 1);
      }
      throw err;
    }
  }
  
  /**
   * Core implementation of updateBranchRef — separated for retry logic.
   * 
   * Important: This is called AFTER the merge commit is already created.
   * If we fail to update the branch pointer, the merge is still successful -
   * the commit exists in the repo. We should not fail the entire merge-ri
   * just because of a stash/reset failure.
   * 
   * @returns true if branch was updated, false if update was skipped (e.g., stash failed)
   */
  private async updateBranchRefCore(
    repoPath: string,
    branchName: string,
    newCommit: string
  ): Promise<boolean> {
    // Check if we're on this branch in the main repo
    const currentBranch = await this.git.branches.currentOrNull(repoPath);
    const isDirty = await this.git.repository.hasUncommittedChanges(repoPath);
    
    if (currentBranch === branchName) {
      // User is on the target branch - use reset --hard (with stash if dirty)
      this.log.debug(`User is on ${branchName}, using reset --hard to update`);
      
      if (isDirty) {
        // Check what files are dirty - if only .gitignore with only orchestrator changes, skip stash
        const dirtyFiles = await this.git.repository.getDirtyFiles(repoPath);
        const onlyGitignoreDirty = dirtyFiles.length === 1 && dirtyFiles[0] === '.gitignore';
        
        if (onlyGitignoreDirty) {
          // Verify the .gitignore diff only contains orchestrator-related changes
          // to avoid discarding legitimate user modifications
          const isOnlyOrchestratorChanges = await this.isGitignoreOnlyOrchestratorChanges(repoPath);
          
          if (isOnlyOrchestratorChanges) {
            // Safe to discard - these are only orchestrator changes already in merge commit
            this.log.debug(`Only .gitignore is dirty with orchestrator-only changes - discarding and resetting`);
            try {
              await this.git.repository.checkoutFile(repoPath, '.gitignore', s => this.log.debug(s));
              await this.git.repository.resetHard(repoPath, newCommit, s => this.log.debug(s));
              this.log.info(`Updated ${branchName} via reset --hard to ${newCommit.slice(0, 8)} (discarded orchestrator .gitignore)`);
              return true;
            } catch (err: any) {
              this.log.warn(`Failed to discard .gitignore and reset: ${err.message}`);
              // Fall through to stash approach
            }
          } else {
            this.log.debug(`.gitignore has non-orchestrator changes, will stash`);
          }
        }
        
        // Try stash + reset, but don't fail the merge if stash has issues
        // The merge commit already exists - worst case user needs to manually sync
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        try {
          await this.git.repository.stashPush(repoPath, stashMsg, s => this.log.debug(s));
        } catch (stashErr: any) {
          // Stash failed (e.g., "could not write index") - this is non-fatal
          // The merge commit exists, user just needs to manually update their branch
          this.log.warn(`Stash failed during branch update: ${stashErr.message}`);
          this.log.warn(`Merge commit ${newCommit.slice(0, 8)} was created successfully.`);
          this.log.warn(`User may need to manually run: git reset --hard ${newCommit.slice(0, 8)}`);
          // Don't throw - the merge succeeded, just the local branch pointer update failed
          return false;
        }
        
        try {
          await this.git.repository.resetHard(repoPath, newCommit, s => this.log.debug(s));
          // Try to pop the stash
          try {
            await this.git.repository.stashPop(repoPath, s => this.log.debug(s));
          } catch (popErr: any) {
            this.log.warn(`Stash pop failed: ${popErr.message}`);
            
            // Check if stash is only orchestrator changes (safe to drop)
            const stashOnlyOrchestrator = await this.isStashOnlyOrchestratorGitignore(repoPath);
            if (stashOnlyOrchestrator) {
              this.log.debug(`Stash contains only orchestrator changes - dropping`);
              await this.git.repository.stashDrop(repoPath, undefined, s => this.log.debug(s));
            } else {
              // Stash has real user changes - attempt to resolve conflicts
              const conflicts = await this.git.merge.listConflicts(repoPath).catch(() => []);
              if (conflicts.length > 0) {
                this.log.info(`Stash pop has ${conflicts.length} conflict(s), leaving for user to resolve`);
                this.log.warn(`User changes stashed before RI merge could not be auto-restored.`);
                this.log.warn(`Run 'git checkout --theirs . && git add .' to keep merged state, or 'git stash pop' to retry.`);
              } else {
                this.log.warn(`Stash pop failed but no conflicts detected. Run 'git stash pop' to recover.`);
              }
            }
          }
        } catch (err) {
          // Try to restore stash before re-throwing
          try {
            await this.git.repository.stashPop(repoPath, s => this.log.debug(s));
          } catch {
            this.log.warn(`Failed to restore stash after reset failure`);
          }
          throw err;
        }
      } else {
        await this.git.repository.resetHard(repoPath, newCommit, s => this.log.debug(s));
      }
      this.log.info(`Updated ${branchName} via reset --hard to ${newCommit.slice(0, 8)}`);
      return true;
    } else {
      // User is NOT on target branch - we can use update-ref
      // This is safe even if the branch is "associated" with the main repo
      this.log.debug(`User is on ${currentBranch || 'detached HEAD'}, using update-ref`);
      
      await this.git.repository.updateRef(repoPath, `refs/heads/${branchName}`, newCommit, s => this.log.debug(s));
      this.log.info(`Updated ${branchName} via update-ref to ${newCommit.slice(0, 8)}`);
      return true;
    }
  }

  /**
   * Check if the working tree .gitignore diff contains ONLY orchestrator-related changes.
   * Delegates to IGitGitignore.isDiffOnlyOrchestratorChanges (single source of truth).
   */
  private async isGitignoreOnlyOrchestratorChanges(repoPath: string): Promise<boolean> {
    try {
      const result = await this.git.repository.getFileDiff(repoPath, '.gitignore');
      if (!result || !result.trim()) {
        const stagedResult = await this.git.repository.getStagedFileDiff(repoPath, '.gitignore');
        if (!stagedResult || !stagedResult.trim()) {return true;}
        return this.git.gitignore.isDiffOnlyOrchestratorChanges(stagedResult);
      }
      return this.git.gitignore.isDiffOnlyOrchestratorChanges(result);
    } catch {
      return false;
    }
  }
  
  /**
   * Check if a stash contains only orchestrator .gitignore changes.
   */
  private async isStashOnlyOrchestratorGitignore(repoPath: string): Promise<boolean> {
    try {
      const files = await this.git.repository.stashShowFiles(repoPath);
      if (files.length !== 1 || files[0] !== '.gitignore') {return false;}
      const diffResult = await this.git.repository.stashShowPatch(repoPath);
      if (!diffResult) {return false;}
      return this.git.gitignore.isDiffOnlyOrchestratorChanges(diffResult);
    } catch {
      return false;
    }
  }

  /**
   * Log the commits and file changes for a dependency node.
   * 
   * Uses the workSummary already stored on the dependency node,
   * avoiding additional git commands.
   */
  private logDependencyWorkSummary(
    planId: string,
    nodeId: string,
    workSummary: JobWorkSummary | undefined,
    attemptNumber?: number
  ): void {
    if (!workSummary) {
      this.execLog(planId, nodeId, 'merge-fi', 'info', '  (No work summary available)', attemptNumber);
      return;
    }
    
    const commitDetails = workSummary.commitDetails || [];
    if (commitDetails.length === 0) {
      // Fall back to summary counts if no commit details
      this.execLog(planId, nodeId, 'merge-fi', 'info', 
        `  Work: ${workSummary.commits} commit(s), +${workSummary.filesAdded} ~${workSummary.filesModified} -${workSummary.filesDeleted}`, attemptNumber);
      return;
    }
    
    this.execLog(planId, nodeId, 'merge-fi', 'info', `  Commits (${commitDetails.length}):`, attemptNumber);
    
    for (const commit of commitDetails) {
      this.execLog(planId, nodeId, 'merge-fi', 'info', `    ${commit.shortHash} ${commit.message}`, attemptNumber);
      
      // Show file change summary
      const summary = this.summarizeCommitFiles(commit);
      if (summary) {
        this.execLog(planId, nodeId, 'merge-fi', 'info', `           ${summary}`, attemptNumber);
      }
    }
  }
  
  /**
   * Summarize file changes from a CommitDetail into a compact string.
   */
  private summarizeCommitFiles(commit: CommitDetail): string {
    const added = commit.filesAdded.length;
    const modified = commit.filesModified.length;
    const deleted = commit.filesDeleted.length;
    
    if (added === 0 && modified === 0 && deleted === 0) {
      return '';
    }
    
    const parts: string[] = [];
    if (added > 0) {parts.push(`+${added}`);}
    if (modified > 0) {parts.push(`~${modified}`);}
    if (deleted > 0) {parts.push(`-${deleted}`);}
    
    const summary = parts.join(' ');
    
    // Show a few example files
    const allFiles = [
      ...commit.filesAdded.map(f => ({ path: f, prefix: '+' })),
      ...commit.filesModified.map(f => ({ path: f, prefix: '~' })),
      ...commit.filesDeleted.map(f => ({ path: f, prefix: '-' })),
    ];
    
    const examples = allFiles.slice(0, 3).map(f => {
      const shortPath = f.path.split('/').slice(-2).join('/');
      return `${f.prefix}${shortPath}`;
    });
    
    if (allFiles.length > 3) {
      examples.push(`... (+${allFiles.length - 3} more)`);
    }
    
    return `[${summary}] ${examples.join(', ')}`;
  }

  // ============================================================================
  // WORKTREE CLEANUP
  // ============================================================================

  /**
   * Clean up a worktree after successful completion (detached HEAD - no branch)
   */
  private async cleanupWorktree(
    worktreePath: string,
    repoPath: string
  ): Promise<void> {
    this.log.debug(`Cleaning up worktree: ${worktreePath}`);
    
    try {
      await this.git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
    } catch (error: any) {
      this.log.warn(`Failed to cleanup worktree`, {
        path: worktreePath,
        error: error.message,
      });
    }
  }

  /**
   * Acknowledge that a consumer node has successfully consumed (FI'd from) its dependencies.
   * 
   * This is called after FI succeeds, allowing dependency worktrees to be cleaned up
   * as soon as all consumers have consumed, rather than waiting for consumers to fully succeed.
   */
  private async acknowledgeConsumption(
    plan: PlanInstance,
    sm: PlanStateMachine,
    consumerNode: PlanNode
  ): Promise<void> {
    // Mark this consumer as having consumed each of its dependencies
    for (const depId of consumerNode.dependencies) {
      const depState = plan.nodeStates.get(depId);
      if (depState) {
        if (!depState.consumedByDependents) {
          depState.consumedByDependents = [];
        }
        // Only add if not already present
        if (!depState.consumedByDependents.includes(consumerNode.id)) {
          depState.consumedByDependents.push(consumerNode.id);
        }
        
        this.log.debug(`Consumption acknowledged: ${consumerNode.name} consumed ${plan.jobs.get(depId)?.name}`, {
          depId,
          consumedCount: depState.consumedByDependents.length,
          dependentCount: plan.jobs.get(depId)?.dependents.length,
        });
      }
    }
    
    // Check if any dependencies are now eligible for cleanup
    if (plan.cleanUpSuccessfulWork) {
      await this.cleanupEligibleWorktrees(plan, sm);
    }
  }

  private async cleanupEligibleWorktrees(
    plan: PlanInstance,
    sm: PlanStateMachine
  ): Promise<void> {
    const eligibleNodes: string[] = [];
    
    for (const [nodeId, state] of plan.nodeStates) {
      // Skip if not succeeded or no worktree or already cleaned
      if (state.status !== 'succeeded' || !state.worktreePath) {
        continue;
      }
      
      // Check if worktree still exists
      if (!fs.existsSync(state.worktreePath)) {
        continue; // Already cleaned up
      }
      
      const node = plan.jobs.get(nodeId);
      if (!node) {continue;}
      
      // Check if all consumers have consumed this node's output
      const consumersReady = this.allConsumersConsumed(plan, node, state);
      if (consumersReady) {
        eligibleNodes.push(nodeId);
      }
    }
    
    // Clean up eligible worktrees
    if (eligibleNodes.length > 0) {
      this.log.debug(`Cleaning up ${eligibleNodes.length} eligible worktrees`, {
        planId: plan.id,
        nodes: eligibleNodes.map(id => plan.jobs.get(id)?.name || id),
      });
      
      for (const nodeId of eligibleNodes) {
        const state = plan.nodeStates.get(nodeId);
        if (state?.worktreePath) {
          await this.cleanupWorktree(state.worktreePath, plan.repoPath);
          state.worktreeCleanedUp = true;
        }
      }
      
      // Persist the updated state with worktreeCleanedUp flags
      await this.savePlanState(plan);
    }
  }

  /**
   * Check if all consumers of a node have consumed its output.
   * 
   * A node's output (commit) can be consumed by:
   * - DAG dependents (for non-leaf nodes)
   * - The target branch merge (for leaf nodes)
   * 
   * Once all consumers have consumed, the worktree is safe to remove.
   */
  private allConsumersConsumed(plan: PlanInstance, node: PlanNode, state: NodeExecutionState): boolean {
    // Leaf nodes (no DAG dependents) - consumer is the targetBranch
    if (node.dependents.length === 0) {
      // No target branch = no consumer = safe to cleanup
      if (!plan.targetBranch) {
        return true;
      }
      // Has target branch - check if merge succeeded
      return state.mergedToTarget === true;
    }
    
    // Non-leaf nodes - consumers are dependents
    // Check if all dependents have acknowledged consumption (completed FI)
    const consumedBy = state.consumedByDependents || [];
    return node.dependents.every(depId => consumedBy.includes(depId));
  }

  private appendWorkSummary(plan: PlanInstance, jobSummary: JobWorkSummary): void {
    plan.workSummary = appendWorkSummaryHelper(plan.workSummary, jobSummary);
  }
}
