/**
 * @fileoverview Job Executor — slim orchestrator delegating phases to `./phases/`.
 * @module plan/executor
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProcessNode } from '../types';
import type { IProcessSpawner, ChildProcessLike } from '../interfaces/IProcessSpawner';
import type { IProcessMonitor } from '../interfaces/IProcessMonitor';
import { killProcessTree } from '../process/processHelpers';
import {
  JobNode, ExecutionContext, JobExecutionResult,
  JobWorkSummary, CommitDetail, ExecutionPhase, LogEntry, CopilotUsageMetrics,
} from './types';
import { JobExecutor } from './runner';
import { Logger } from '../core/logger';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import { aggregateMetrics } from './metricsAggregator';
import type { IEvidenceValidator } from '../interfaces';
import type { PhaseContext } from '../interfaces/IPhaseExecutor';
import { ensureOrchestratorDirs } from '../core';
import {
  SetupPhaseExecutor,
  PrecheckPhaseExecutor, WorkPhaseExecutor,
  PostcheckPhaseExecutor, CommitPhaseExecutor,
  MergeFiPhaseExecutor, MergeRiPhaseExecutor,
} from './phases';
import type { CommitPhaseContext } from './phases';
import {
  computeWorkSummary, computeAggregatedWorkSummary,
} from './workSummaryHelper';
import {
  getLogFilePathByKey, appendToLogFile, readLogsFromFile, readLogsFromFileOffset,
} from './logFileHelper';

const log = Logger.for('job-executor');

interface ActiveExecution {
  planId: string;
  nodeId: string;
  process?: ChildProcessLike;
  aborted: boolean;
  startTime?: number;
  isAgentWork?: boolean;
}

/**
 * Default {@link JobExecutor} implementation.
 * Orchestrates phase pipeline and delegates each phase to specialised executors.
 */
export class DefaultJobExecutor implements JobExecutor {
  private activeExecutions = new Map<string, ActiveExecution>();
  private activeExecutionsByNode = new Map<string, string>();
  private executionLogs = new Map<string, LogEntry[]>();
  private logFiles = new Map<string, string>();
  private agentDelegator?: any;
  private storagePath?: string;
  private processMonitor: IProcessMonitor;
  private evidenceValidator: IEvidenceValidator;
  private spawner: IProcessSpawner;
  private git: IGitOperations;
  private copilotRunner: ICopilotRunner;

  constructor(spawner: IProcessSpawner, evidenceValidator: IEvidenceValidator, processMonitor: IProcessMonitor, git: IGitOperations, copilotRunner: ICopilotRunner) {
    this.spawner = spawner;
    this.evidenceValidator = evidenceValidator;
    this.processMonitor = processMonitor;
    this.git = git;
    this.copilotRunner = copilotRunner;
  }

  setStoragePath(storagePath: string): void {
    this.storagePath = storagePath;
    const logsDir = path.join(storagePath, 'logs');
    if (!fs.existsSync(logsDir)) {fs.mkdirSync(logsDir, { recursive: true });}
  }

  setAgentDelegator(delegator: any): void { this.agentDelegator = delegator; }
  setEvidenceValidator(validator: IEvidenceValidator): void { this.evidenceValidator = validator; }

  private getCopilotConfigDir(worktreePath: string): string {
    // Store Copilot CLI config inside the worktree so session state is
    // isolated per node and cleaned up when the worktree is removed.
    const configDir = path.join(worktreePath, '.orchestrator', '.copilot-cli');
    if (!fs.existsSync(configDir)) {fs.mkdirSync(configDir, { recursive: true });}
    return configDir;
  }

  // ===========================================================================
  // EXECUTE — Phase pipeline
  // ===========================================================================

  async execute(context: ExecutionContext): Promise<JobExecutionResult> {
    const { plan, node, worktreePath, attemptNumber } = context;
    const executionKey = `${plan.id}:${node.id}:${attemptNumber}`;
    const nodeKey = `${plan.id}:${node.id}`;

    const execution: ActiveExecution = { planId: plan.id, nodeId: node.id, aborted: false };
    this.activeExecutions.set(executionKey, execution);
    this.activeExecutionsByNode.set(nodeKey, executionKey);
    this.executionLogs.set(executionKey, []);

    const stepStatuses: JobExecutionResult['stepStatuses'] = context.previousStepStatuses ? { ...context.previousStepStatuses } : {};
    let capturedSessionId: string | undefined = context.copilotSessionId;
    let capturedMetrics: CopilotUsageMetrics | undefined;
    const phaseMetrics: Record<string, CopilotUsageMetrics> = {};

    const phaseOrder = ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'] as const;
    const resumeIndex = context.resumeFromPhase ? phaseOrder.indexOf(context.resumeFromPhase as any) : 0;
    const skip = (p: typeof phaseOrder[number]) => phaseOrder.indexOf(p) < resumeIndex;
    const phaseDeps = () => ({ 
      agentDelegator: this.agentDelegator, 
      getCopilotConfigDir: (wtp: string) => this.getCopilotConfigDir(wtp),
      spawner: this.spawner,
      git: this.git,
      copilotRunner: this.copilotRunner,
      configManager: undefined, // TODO: Pass config manager if available
    });
    const makeCtx = (phase: ExecutionPhase): PhaseContext => ({
      node, worktreePath, executionKey, phase,
      logInfo: (m) => this.logEntry(executionKey, phase, 'info', m),
      logError: (m) => this.logEntry(executionKey, phase, 'error', m),
      logOutput: (t, m) => this.logEntry(executionKey, phase, t, m),
      isAborted: () => execution.aborted,
      setProcess: (p) => { execution.process = p; },
      setStartTime: (t) => { execution.startTime = t; },
      setIsAgentWork: (v) => { execution.isAgentWork = v; },
    });
    const pmk = (n: string) => Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined;

    try {
      if (!fs.existsSync(worktreePath))
        {return { success: false, error: `Worktree does not exist: ${worktreePath}`, stepStatuses, failedPhase: 'merge-fi', pid: execution.process?.pid };}

      // ---- MERGE-FI ----
      if (skip('merge-fi')) { this.logEntry(executionKey, 'merge-fi', 'info', '========== MERGE-FI SECTION (SKIPPED - RESUMING) =========='); }
      else if (context.dependencyCommits && context.dependencyCommits.length > 0) {
        context.onProgress?.('Forward integration merge'); context.onStepStatusChange?.('merge-fi', 'running');
        this.logEntry(executionKey, 'merge-fi', 'info', '========== MERGE-FI SECTION START ==========');
        const ctx = makeCtx('merge-fi'); 
        ctx.dependencyCommits = context.dependencyCommits;
        const r = await new MergeFiPhaseExecutor(phaseDeps()).execute(ctx);
        if (r.metrics) { capturedMetrics = r.metrics; phaseMetrics['merge-fi'] = r.metrics; }
        this.logEntry(executionKey, 'merge-fi', 'info', '========== MERGE-FI SECTION END ==========');
        if (!r.success) { stepStatuses['merge-fi'] = 'failed'; context.onStepStatusChange?.('merge-fi', 'failed'); return { success: false, error: `Forward integration merge failed: ${r.error}`, stepStatuses, failedPhase: 'merge-fi', metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses['merge-fi'] = 'success'; context.onStepStatusChange?.('merge-fi', 'success');
      } else { stepStatuses['merge-fi'] = 'skipped'; context.onStepStatusChange?.('merge-fi', 'skipped'); }
      if (execution.aborted) {return { success: false, error: 'Execution canceled', stepStatuses, pid: execution.process?.pid };}

      // ---- SETUP ----
      if (skip('setup')) { this.logEntry(executionKey, 'setup', 'info', '========== SETUP SECTION (SKIPPED - RESUMING) =========='); }
      else {
        context.onProgress?.('Running setup'); context.onStepStatusChange?.('setup', 'running');
        this.logEntry(executionKey, 'setup', 'info', '========== SETUP SECTION START ==========');
        const ctx = makeCtx('setup');
        const r = await new SetupPhaseExecutor(phaseDeps()).execute(ctx);
        this.logEntry(executionKey, 'setup', 'info', '========== SETUP SECTION END ==========');
        if (!r.success) { stepStatuses.setup = 'failed'; context.onStepStatusChange?.('setup', 'failed'); return { success: false, error: `Setup failed: ${r.error}`, stepStatuses, failedPhase: 'setup', metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses.setup = 'success'; context.onStepStatusChange?.('setup', 'success');
      }
      if (execution.aborted) {return { success: false, error: 'Execution canceled', stepStatuses, pid: execution.process?.pid };}

      // ---- PRECHECKS ----
      if (skip('prechecks')) { this.logEntry(executionKey, 'prechecks', 'info', '========== PRECHECKS SECTION (SKIPPED - RESUMING) =========='); }
      else if (node.prechecks) {
        context.onProgress?.('Running prechecks'); context.onStepStatusChange?.('prechecks', 'running');
        this.logEntry(executionKey, 'prechecks', 'info', '========== PRECHECKS SECTION START ==========');
        const ctx = makeCtx('prechecks'); ctx.workSpec = node.prechecks; ctx.sessionId = capturedSessionId;
        const r = await new PrecheckPhaseExecutor(phaseDeps()).execute(ctx);
        if (r.copilotSessionId) {capturedSessionId = r.copilotSessionId;}
        if (r.metrics) { capturedMetrics = r.metrics; phaseMetrics['prechecks'] = r.metrics; }
        this.logEntry(executionKey, 'prechecks', 'info', '========== PRECHECKS SECTION END ==========');
        if (!r.success) { stepStatuses.prechecks = 'failed'; context.onStepStatusChange?.('prechecks', 'failed'); return { success: false, error: `Prechecks failed: ${r.error}`, stepStatuses, copilotSessionId: capturedSessionId, failedPhase: 'prechecks', exitCode: r.exitCode, metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses.prechecks = 'success'; context.onStepStatusChange?.('prechecks', 'success');
      } else { stepStatuses.prechecks = 'skipped'; context.onStepStatusChange?.('prechecks', 'skipped'); }
      if (execution.aborted) {return { success: false, error: 'Execution canceled', stepStatuses, pid: execution.process?.pid };}

      // ---- WORK ----
      if (skip('work')) { this.logEntry(executionKey, 'work', 'info', '========== WORK SECTION (SKIPPED - RESUMING) =========='); }
      else if (node.work) {
        context.onProgress?.('Running work'); context.onStepStatusChange?.('work', 'running');
        this.logEntry(executionKey, 'work', 'info', '========== WORK SECTION START ==========');
        const ctx = makeCtx('work'); ctx.workSpec = node.work; ctx.sessionId = capturedSessionId;
        const r = await new WorkPhaseExecutor(phaseDeps()).execute(ctx);
        if (r.copilotSessionId) {capturedSessionId = r.copilotSessionId;}
        if (r.metrics) { capturedMetrics = capturedMetrics ? aggregateMetrics([capturedMetrics, r.metrics]) : r.metrics; phaseMetrics['work'] = r.metrics; }
        this.logEntry(executionKey, 'work', 'info', '========== WORK SECTION END ==========');
        if (!r.success) { stepStatuses.work = 'failed'; context.onStepStatusChange?.('work', 'failed'); log.info(`[executor.execute] Returning failure: ${r.error}`, { planId: plan.id, nodeId: node.id }); return { success: false, error: `Work failed: ${r.error}`, stepStatuses, copilotSessionId: capturedSessionId, failedPhase: 'work', exitCode: r.exitCode, metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses.work = 'success'; context.onStepStatusChange?.('work', 'success');
      } else {
        this.logEntry(executionKey, 'work', 'info', '========== WORK SECTION START ==========');
        this.logEntry(executionKey, 'work', 'info', 'No work specified - skipping');
        this.logEntry(executionKey, 'work', 'info', '========== WORK SECTION END ==========');
        log.warn(`Job ${node.name} has no work specified`); stepStatuses.work = 'skipped'; context.onStepStatusChange?.('work', 'skipped');
      }
      if (execution.aborted) {return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId, pid: execution.process?.pid };}

      // ---- POSTCHECKS ----
      if (skip('postchecks')) { this.logEntry(executionKey, 'postchecks', 'info', '========== POSTCHECKS SECTION (SKIPPED - RESUMING) =========='); }
      else if (node.postchecks) {
        context.onProgress?.('Running postchecks'); context.onStepStatusChange?.('postchecks', 'running');
        this.logEntry(executionKey, 'postchecks', 'info', '========== POSTCHECKS SECTION START ==========');
        const ctx = makeCtx('postchecks'); ctx.workSpec = node.postchecks; ctx.sessionId = capturedSessionId;
        const r = await new PostcheckPhaseExecutor(phaseDeps()).execute(ctx);
        if (r.copilotSessionId) {capturedSessionId = r.copilotSessionId;}
        if (r.metrics) { capturedMetrics = capturedMetrics ? aggregateMetrics([capturedMetrics, r.metrics]) : r.metrics; phaseMetrics['postchecks'] = r.metrics; }
        this.logEntry(executionKey, 'postchecks', 'info', '========== POSTCHECKS SECTION END ==========');
        if (!r.success) { stepStatuses.postchecks = 'failed'; context.onStepStatusChange?.('postchecks', 'failed'); return { success: false, error: `Postchecks failed: ${r.error}`, stepStatuses, copilotSessionId: capturedSessionId, failedPhase: 'postchecks', exitCode: r.exitCode, metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses.postchecks = 'success'; context.onStepStatusChange?.('postchecks', 'success');
      } else { stepStatuses.postchecks = 'skipped'; context.onStepStatusChange?.('postchecks', 'skipped'); }
      if (execution.aborted) {return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId };}

      // ---- COMMIT ----
      const workWasSkipped = skip('work');
      context.onProgress?.('Committing changes'); context.onStepStatusChange?.('commit', 'running');
      this.logEntry(executionKey, 'commit', 'info', '========== COMMIT SECTION START ==========');
      const commitCtx: CommitPhaseContext = { ...makeCtx('commit'), baseCommit: context.baseCommit, getExecutionLogs: () => this.executionLogs.get(executionKey) || [] };
      const cr = await new CommitPhaseExecutor({ evidenceValidator: this.evidenceValidator, ...phaseDeps() }).execute(commitCtx);
      this.logEntry(executionKey, 'commit', 'info', '========== COMMIT SECTION END ==========');
      if (cr.reviewMetrics) { phaseMetrics['commit'] = cr.reviewMetrics; capturedMetrics = capturedMetrics ? aggregateMetrics([capturedMetrics, cr.reviewMetrics]) : cr.reviewMetrics; }
      if (!cr.success) {
        if (workWasSkipped) { this.logEntry(executionKey, 'commit', 'info', 'Commit found no evidence, but work was skipped (resuming). Succeeding without commit.'); stepStatuses.commit = 'success'; context.onStepStatusChange?.('commit', 'success'); }
        else { stepStatuses.commit = 'failed'; context.onStepStatusChange?.('commit', 'failed'); return { success: false, error: `Commit failed: ${cr.error}`, stepStatuses, copilotSessionId: capturedSessionId, failedPhase: 'commit', metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
      } else { stepStatuses.commit = 'success'; context.onStepStatusChange?.('commit', 'success'); }

      // ---- POSTCHECKS ----
      if (skip('postchecks')) { this.logEntry(executionKey, 'postchecks', 'info', '========== POSTCHECKS SECTION (SKIPPED - RESUMING) =========='); }
      else if (node.postchecks) {
        context.onProgress?.('Running postchecks'); context.onStepStatusChange?.('postchecks', 'running');
        this.logEntry(executionKey, 'postchecks', 'info', '========== POSTCHECKS SECTION START ==========');
        const ctx = makeCtx('postchecks'); ctx.workSpec = node.postchecks; ctx.sessionId = capturedSessionId;
        const r = await new PostcheckPhaseExecutor(phaseDeps()).execute(ctx);
        if (r.copilotSessionId) {capturedSessionId = r.copilotSessionId;}
        if (r.metrics) { capturedMetrics = capturedMetrics ? aggregateMetrics([capturedMetrics, r.metrics]) : r.metrics; phaseMetrics['postchecks'] = r.metrics; }
        this.logEntry(executionKey, 'postchecks', 'info', '========== POSTCHECKS SECTION END ==========');
        if (!r.success) { stepStatuses.postchecks = 'failed'; context.onStepStatusChange?.('postchecks', 'failed'); return { success: false, error: `Postchecks failed: ${r.error}`, stepStatuses, copilotSessionId: capturedSessionId, failedPhase: 'postchecks', exitCode: r.exitCode, metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses.postchecks = 'success'; context.onStepStatusChange?.('postchecks', 'success');
      } else { stepStatuses.postchecks = 'skipped'; context.onStepStatusChange?.('postchecks', 'skipped'); }
      if (execution.aborted) {return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId };}

      // ---- MERGE-RI ----
      if (skip('merge-ri')) { this.logEntry(executionKey, 'merge-ri', 'info', '========== MERGE-RI SECTION (SKIPPED - RESUMING) =========='); }
      else if (context.targetBranch && context.repoPath) {
        context.onProgress?.('Reverse integration merge'); context.onStepStatusChange?.('merge-ri', 'running');
        this.logEntry(executionKey, 'merge-ri', 'info', '========== MERGE-RI SECTION START ==========');
        const ctx = makeCtx('merge-ri'); 
        ctx.repoPath = context.repoPath;
        ctx.targetBranch = context.targetBranch;
        ctx.baseCommitAtStart = context.baseCommitAtStart;
        ctx.completedCommit = cr.commit;
        ctx.baseCommit = context.baseCommit;
        const r = await new MergeRiPhaseExecutor(phaseDeps()).execute(ctx);
        if (r.metrics) { capturedMetrics = capturedMetrics ? aggregateMetrics([capturedMetrics, r.metrics]) : r.metrics; phaseMetrics['merge-ri'] = r.metrics; }
        this.logEntry(executionKey, 'merge-ri', 'info', '========== MERGE-RI SECTION END ==========');
        if (!r.success) { stepStatuses['merge-ri'] = 'failed'; context.onStepStatusChange?.('merge-ri', 'failed'); return { success: false, error: `Reverse integration merge failed: ${r.error}`, stepStatuses, copilotSessionId: capturedSessionId, failedPhase: 'merge-ri', metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid }; }
        stepStatuses['merge-ri'] = 'success'; context.onStepStatusChange?.('merge-ri', 'success');
      } else { stepStatuses['merge-ri'] = 'skipped'; context.onStepStatusChange?.('merge-ri', 'skipped'); }

      const ws = await computeWorkSummary(node, worktreePath, context.baseCommit, this.git);
      return { success: true, completedCommit: cr.commit, workSummary: ws, stepStatuses, copilotSessionId: capturedSessionId, metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid };
    } catch (error: any) {
      log.error(`Execution error: ${node.name}`, { error: error.message });
      return { success: false, error: error.message, stepStatuses, copilotSessionId: capturedSessionId, metrics: capturedMetrics, phaseMetrics: pmk(''), pid: execution.process?.pid };
    } finally {
      this.activeExecutions.delete(executionKey);
      this.activeExecutionsByNode.delete(nodeKey);
    }
  }

  // ===========================================================================
  // CANCEL / QUERY
  // ===========================================================================

  async cancel(planId: string, nodeId: string): Promise<void> {
    const nodeKey = `${planId}:${nodeId}`;
    const executionKey = this.activeExecutionsByNode.get(nodeKey);
    if (!executionKey) {return;}
    const execution = this.activeExecutions.get(executionKey);
    if (execution) {
      const stack = new Error().stack;
      log.warn(`Executor.cancel() called`, { planId, nodeId, pid: execution.process?.pid, stack: stack?.split('\n').slice(1, 5).join('\n') });
      execution.aborted = true;
      if (execution.process?.pid) {
        log.info(`Killing process PID ${execution.process.pid} for execution: ${executionKey}`);
        try { 
          await killProcessTree(this.spawner, execution.process.pid, true);
        } catch { /* ignore */ }
      }
    }
  }

  getLogs(planId: string, nodeId: string): LogEntry[] { return this.executionLogs.get(`${planId}:${nodeId}`) || []; }
  getLogsForPhase(planId: string, nodeId: string, phase: ExecutionPhase): LogEntry[] { return this.getLogs(planId, nodeId).filter(e => e.phase === phase); }
  getLogFileSize(planId: string, nodeId: string): number { const f = getLogFilePathByKey(`${planId}:${nodeId}`, this.storagePath, this.logFiles); if (!f || !fs.existsSync(f)) {return 0;} try { return fs.statSync(f).size; } catch { return 0; } }
  isActive(planId: string, nodeId: string): boolean { return this.activeExecutionsByNode.has(`${planId}:${nodeId}`); }

  log(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string, attemptNumber?: number): void {
    const executionKey = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    if (!this.executionLogs.has(executionKey)) {this.executionLogs.set(executionKey, []);}
    this.logEntry(executionKey, phase, type, message);
  }

  // ===========================================================================
  // PROCESS STATS
  // ===========================================================================

  async getProcessStats(planId: string, nodeId: string): Promise<{ pid: number | null; running: boolean; tree: ProcessNode[]; duration: number | null; isAgentWork?: boolean }> {
    const ek = this.activeExecutionsByNode.get(`${planId}:${nodeId}`);
    if (!ek) {return { pid: null, running: false, tree: [], duration: null };}
    const ex = this.activeExecutions.get(ek);
    if (!ex) {return { pid: null, running: false, tree: [], duration: null };}
    const duration = ex.startTime ? Date.now() - ex.startTime : null;
    if (ex.isAgentWork && !ex.process?.pid) {return { pid: null, running: true, tree: [], duration, isAgentWork: true };}
    if (!ex.process?.pid) {return { pid: null, running: false, tree: [], duration: null };}
    const pid = ex.process.pid, running = this.processMonitor.isRunning(pid);
    let tree: ProcessNode[] = [];
    try { const snap = await this.processMonitor.getSnapshot(); tree = this.processMonitor.buildTree([pid], snap); } catch { /* ignore */ }
    return { pid, running, tree, duration, isAgentWork: ex.isAgentWork };
  }

  async getAllProcessStats(nodeKeys: Array<{ planId: string; nodeId: string; nodeName: string }>): Promise<Array<{ planId: string; nodeId: string; nodeName: string; pid: number | null; running: boolean; tree: ProcessNode[]; duration: number | null; isAgentWork?: boolean }>> {
    if (nodeKeys.length === 0) {return [];}
    let snapshot: any[] = []; try { snapshot = await this.processMonitor.getSnapshot(); } catch { /* ignore */ }
    const results: Array<{ planId: string; nodeId: string; nodeName: string; pid: number | null; running: boolean; tree: ProcessNode[]; duration: number | null; isAgentWork?: boolean }> = [];
    for (const { planId, nodeId, nodeName } of nodeKeys) {
      const ek = this.activeExecutionsByNode.get(`${planId}:${nodeId}`);
      if (!ek) {continue;}
      const ex = this.activeExecutions.get(ek);
      if (!ex) {continue;}
      const duration = ex.startTime ? Date.now() - ex.startTime : null;
      if (ex.isAgentWork && !ex.process?.pid) { results.push({ planId, nodeId, nodeName, pid: null, running: true, tree: [], duration, isAgentWork: true }); continue; }
      if (!ex.process?.pid) {continue;}
      const pid = ex.process.pid, running = this.processMonitor.isRunning(pid);
      let tree: ProcessNode[] = [];
      if (running && snapshot.length > 0) { try { tree = this.processMonitor.buildTree([pid], snapshot); } catch { /* ignore */ } }
      if (running || pid) {results.push({ planId, nodeId, nodeName, pid, running, tree, duration, isAgentWork: ex.isAgentWork });}
    }
    return results;
  }

  // ===========================================================================
  // WORK SUMMARY (delegates to helper)
  // ===========================================================================

  async computeAggregatedWorkSummary(node: JobNode, worktreePath: string, baseBranch: string, repoPath: string): Promise<JobWorkSummary> {
    return computeAggregatedWorkSummary(node, worktreePath, baseBranch, repoPath, this.git);
  }

  // ===========================================================================
  // LOG FILE MANAGEMENT (delegates to helper)
  // ===========================================================================

  getLogFilePath(planId: string, nodeId: string, attemptNumber?: number): string | undefined {
    const ek = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    return getLogFilePathByKey(ek, this.storagePath, this.logFiles);
  }

  readLogsFromFile(planId: string, nodeId: string, attemptNumber?: number): string {
    const ek = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    return readLogsFromFile(ek, this.storagePath, this.logFiles);
  }

  readLogsFromFileOffset(planId: string, nodeId: string, byteOffset: number, attemptNumber?: number): string {
    const ek = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    return readLogsFromFileOffset(ek, byteOffset, this.storagePath, this.logFiles);
  }

  // ===========================================================================
  // INTERNAL LOGGING
  // ===========================================================================

  private logEntry(executionKey: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void {
    const timestamp = Date.now();
    const logs = this.executionLogs.get(executionKey);
    for (const line of String(message).split('\n')) {
      const entry: LogEntry = { timestamp, phase, type, message: line };
      if (logs) {logs.push(entry);}
      appendToLogFile(executionKey, entry, this.storagePath, this.logFiles);
    }
  }
}
