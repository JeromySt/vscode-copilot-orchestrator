/**
 * @fileoverview Job Executor
 * 
 * Handles the actual execution of job nodes:
 * - Running shell commands (prechecks, work, postchecks)
 * - Delegating to @agent for AI tasks
 * - Tracking process trees
 * - Committing changes
 * - Computing work summaries
 * 
 * @module plan/executor
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ProcessMonitor } from '../process';
import { ProcessNode } from '../types';
import {
  JobNode,
  ExecutionContext,
  JobExecutionResult,
  JobWorkSummary,
  CommitDetail,
  ExecutionPhase,
  LogEntry,
  WorkSpec,
  ProcessSpec,
  ShellSpec,
  AgentSpec,
  AgentExecutionMetrics,
  CopilotUsageMetrics,
  normalizeWorkSpec,
} from './types';
import { JobExecutor } from './runner';
import { Logger } from '../core/logger';
import * as git from '../git';
import { DefaultEvidenceValidator } from './evidenceValidator';
import { aggregateMetrics } from './metricsAggregator';
import type { IEvidenceValidator } from '../interfaces';

const log = Logger.for('job-executor');

/**
 * Active execution tracking
 */
interface ActiveExecution {
  planId: string;
  nodeId: string;
  process?: ChildProcess;
  aborted: boolean;
  startTime?: number;
  isAgentWork?: boolean; // true when running @agent work
}

/**
 * Adapt a shell command for Windows PowerShell 5.x compatibility.
 * Converts bash-style `&&` chains to PowerShell semicolons with
 * `$?` error-propagation guards, and rewrites common Unix commands.
 */
function adaptCommandForPowerShell(command: string): string {
  // Replace '&&' with '; if (!$?) { exit 1 }; ' for error-propagation semantics
  let adapted = command.replace(/\s*&&\s*/g, '; if (!$?) { exit 1 }; ');

  // Rewrite common Unix-style commands that don't work in PowerShell
  adapted = adapted.replace(/\bls\s+-la\b/g, 'Get-ChildItem');

  return adapted;
}

/**
 * Default {@link JobExecutor} implementation.
 *
 * Handles:
 * - Running prechecks, work, and postchecks as process/shell/agent specs
 * - Tracking child process trees for monitoring
 * - Committing changes and computing work summaries
 * - Persisting execution logs to disk
 *
 * Processes are killed on cancellation, and logs are stored both in memory
 * and on disk (under `{storagePath}/logs/`).
 */
export class DefaultJobExecutor implements JobExecutor {
  private activeExecutions = new Map<string, ActiveExecution>();
  private executionLogs = new Map<string, LogEntry[]>();
  private logFiles = new Map<string, string>(); // execution key -> log file path
  private agentDelegator?: any; // IAgentDelegator interface
  private storagePath?: string;
  private processMonitor = new ProcessMonitor();
  private evidenceValidator: IEvidenceValidator = new DefaultEvidenceValidator();
  
  /**
   * Configure the directory for persisted log files.
   * Creates the `logs/` subdirectory if it doesn't exist.
   *
   * @param storagePath - Root storage directory.
   */
  setStoragePath(storagePath: string): void {
    this.storagePath = storagePath;
    // Ensure logs directory exists
    const logsDir = path.join(storagePath, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }
  
  /**
   * Set the agent delegator used for `@agent` / {@link AgentSpec} tasks.
   *
   * @param delegator - Agent delegator implementing `delegate()`.
   */
  setAgentDelegator(delegator: any): void {
    this.agentDelegator = delegator;
  }

  /**
   * Set the evidence validator used during the commit phase.
   *
   * @param validator - Evidence validator implementing {@link IEvidenceValidator}.
   */
  setEvidenceValidator(validator: IEvidenceValidator): void {
    this.evidenceValidator = validator;
  }
  
  /**
   * Execute a job node: runs prechecks → work → postchecks → commit.
   *
   * Each phase is logged with section markers. If any phase fails, the
   * remaining phases are skipped and the failure phase is recorded.
   *
   * @param context - Execution context (plan, node, worktree path, abort signal).
   * @returns Result with success/failure, optional commit SHA, and per-phase statuses.
   */
  async execute(context: ExecutionContext): Promise<JobExecutionResult> {
    const { plan, node, worktreePath, attemptNumber } = context;
    // Include attempt number in execution key for separate log files per attempt
    const executionKey = `${plan.id}:${node.id}:${attemptNumber}`;
    
    // Track this execution
    const execution: ActiveExecution = {
      planId: plan.id,
      nodeId: node.id,
      aborted: false,
    };
    this.activeExecutions.set(executionKey, execution);
    this.executionLogs.set(executionKey, []);
    
    // Track per-phase statuses and captured session ID
    // Start with previous statuses if resuming from a failed phase
    const stepStatuses: JobExecutionResult['stepStatuses'] = context.previousStepStatuses 
      ? { ...context.previousStepStatuses } 
      : {};
    let capturedSessionId: string | undefined = context.copilotSessionId;
    let capturedMetrics: CopilotUsageMetrics | undefined;
    const phaseMetrics: Record<string, CopilotUsageMetrics> = {};
    
    // Determine which phases to skip based on resumeFromPhase
    const phaseOrder = ['prechecks', 'work', 'postchecks', 'commit'] as const;
    const resumeIndex = context.resumeFromPhase 
      ? phaseOrder.indexOf(context.resumeFromPhase as any)
      : 0;
    const shouldSkipPhase = (phase: typeof phaseOrder[number]) => {
      const phaseIndex = phaseOrder.indexOf(phase);
      return phaseIndex < resumeIndex;
    };
    
    try {
      // Ensure worktree exists
      if (!fs.existsSync(worktreePath)) {
        return {
          success: false,
          error: `Worktree does not exist: ${worktreePath}`,
          stepStatuses,
          failedPhase: 'prechecks',
        };
      }
      
      // Run prechecks (skip if resuming from later phase)
      if (shouldSkipPhase('prechecks')) {
        this.logInfo(executionKey, 'prechecks', '========== PRECHECKS SECTION (SKIPPED - RESUMING) ==========');
        // stepStatuses.prechecks already preserved from previousStepStatuses
      } else if (node.prechecks) {
        context.onProgress?.('Running prechecks');
        context.onStepStatusChange?.('prechecks', 'running');
        this.logInfo(executionKey, 'prechecks', '========== PRECHECKS SECTION START ==========');
        
        const precheckResult = await this.runWorkSpec(
          node.prechecks,
          worktreePath,
          execution,
          executionKey,
          'prechecks',
          node
        );
        
        // Capture session ID and metrics from prechecks (relevant for auto-heal agent specs)
        if (precheckResult.copilotSessionId) {
          capturedSessionId = precheckResult.copilotSessionId;
        }
        if (precheckResult.metrics) {
          capturedMetrics = precheckResult.metrics;
          phaseMetrics['prechecks'] = precheckResult.metrics;
        }
        
        this.logInfo(executionKey, 'prechecks', '========== PRECHECKS SECTION END ==========');
        
        if (!precheckResult.success) {
          stepStatuses.prechecks = 'failed';
          context.onStepStatusChange?.('prechecks', 'failed');
          return {
            success: false,
            error: `Prechecks failed: ${precheckResult.error}`,
            stepStatuses,
            copilotSessionId: capturedSessionId,
            failedPhase: 'prechecks',
            exitCode: precheckResult.exitCode,
            metrics: capturedMetrics,
            phaseMetrics: Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined,
          };
        }
        stepStatuses.prechecks = 'success';
        context.onStepStatusChange?.('prechecks', 'success');
      } else {
        stepStatuses.prechecks = 'skipped';
        context.onStepStatusChange?.('prechecks', 'skipped');
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled', stepStatuses };
      }
      
      // Run main work (skip if resuming from later phase)
      if (shouldSkipPhase('work')) {
        this.logInfo(executionKey, 'work', '========== WORK SECTION (SKIPPED - RESUMING) ==========');
        // stepStatuses.work already preserved from previousStepStatuses
      } else if (node.work) {
        context.onProgress?.('Running work');
        context.onStepStatusChange?.('work', 'running');
        this.logInfo(executionKey, 'work', '========== WORK SECTION START ==========');
        
        const workResult = await this.runWorkSpec(
          node.work,
          worktreePath,
          execution,
          executionKey,
          'work',
          node,
          capturedSessionId // Pass existing session ID for resumption
        );
        
        // Capture session ID from agent work
        if (workResult.copilotSessionId) {
          capturedSessionId = workResult.copilotSessionId;
        }
        
        // Capture agent execution metrics
        if (workResult.metrics) {
          capturedMetrics = capturedMetrics
            ? aggregateMetrics([capturedMetrics, workResult.metrics])
            : workResult.metrics;
          phaseMetrics['work'] = workResult.metrics;
        }
        
        this.logInfo(executionKey, 'work', '========== WORK SECTION END ==========');
        
        if (!workResult.success) {
          stepStatuses.work = 'failed';
          context.onStepStatusChange?.('work', 'failed');
          log.info(`[executor.execute] Returning failure: ${workResult.error}`, { planId: plan.id, nodeId: node.id });
          return {
            success: false,
            error: `Work failed: ${workResult.error}`,
            stepStatuses,
            copilotSessionId: capturedSessionId,
            failedPhase: 'work',
            exitCode: workResult.exitCode,
            metrics: capturedMetrics,
            phaseMetrics: Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined,
          };
        }
        stepStatuses.work = 'success';
        context.onStepStatusChange?.('work', 'success');
      } else {
        // No work command - this is unusual but not an error
        this.logInfo(executionKey, 'work', '========== WORK SECTION START ==========');
        this.logInfo(executionKey, 'work', 'No work specified - skipping');
        this.logInfo(executionKey, 'work', '========== WORK SECTION END ==========');
        log.warn(`Job ${node.name} has no work specified`);
        stepStatuses.work = 'skipped';
        context.onStepStatusChange?.('work', 'skipped');
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId };
      }
      
      // Run postchecks (skip if resuming from later phase)
      if (shouldSkipPhase('postchecks')) {
        this.logInfo(executionKey, 'postchecks', '========== POSTCHECKS SECTION (SKIPPED - RESUMING) ==========');
        // stepStatuses.postchecks already preserved from previousStepStatuses
      } else if (node.postchecks) {
        context.onProgress?.('Running postchecks');
        context.onStepStatusChange?.('postchecks', 'running');
        this.logInfo(executionKey, 'postchecks', '========== POSTCHECKS SECTION START ==========');
        
        const postcheckResult = await this.runWorkSpec(
          node.postchecks,
          worktreePath,
          execution,
          executionKey,
          'postchecks',
          node
        );
        
        // Capture session ID and metrics from postchecks (relevant for auto-heal agent specs)
        if (postcheckResult.copilotSessionId) {
          capturedSessionId = postcheckResult.copilotSessionId;
        }
        if (postcheckResult.metrics) {
          capturedMetrics = capturedMetrics
            ? aggregateMetrics([capturedMetrics, postcheckResult.metrics])
            : postcheckResult.metrics;
          phaseMetrics['postchecks'] = postcheckResult.metrics;
        }
        
        this.logInfo(executionKey, 'postchecks', '========== POSTCHECKS SECTION END ==========');
        
        if (!postcheckResult.success) {
          stepStatuses.postchecks = 'failed';
          context.onStepStatusChange?.('postchecks', 'failed');
          return {
            success: false,
            error: `Postchecks failed: ${postcheckResult.error}`,
            stepStatuses,
            copilotSessionId: capturedSessionId,
            failedPhase: 'postchecks',
            exitCode: postcheckResult.exitCode,
            metrics: capturedMetrics,
            phaseMetrics: Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined,
          };
        }
        stepStatuses.postchecks = 'success';
        context.onStepStatusChange?.('postchecks', 'success');
      } else {
        stepStatuses.postchecks = 'skipped';
        context.onStepStatusChange?.('postchecks', 'skipped');
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId };
      }
      
      // Commit changes
      // When resuming from postchecks or later, work was already validated
      // in a prior attempt. If commitChanges finds no evidence (work was a
      // no-op — e.g., files already committed by a dependency), that's OK.
      const workWasSkipped = shouldSkipPhase('work');
      context.onProgress?.('Committing changes');
      context.onStepStatusChange?.('commit', 'running');
      this.logInfo(executionKey, 'commit', '========== COMMIT SECTION START ==========');
      const commitResult = await this.commitChanges(
        node,
        worktreePath,
        executionKey,
        context.baseCommit
      );
      this.logInfo(executionKey, 'commit', '========== COMMIT SECTION END ==========');
      
      // Merge any AI review metrics from the commit phase into captured metrics
      if (commitResult.reviewMetrics) {
        phaseMetrics['commit'] = commitResult.reviewMetrics;
        capturedMetrics = capturedMetrics
          ? aggregateMetrics([capturedMetrics, commitResult.reviewMetrics])
          : commitResult.reviewMetrics;
      }
      
      if (!commitResult.success) {
        if (workWasSkipped) {
          // Work was skipped (resume from postchecks or later). The prior work
          // phase already validated — a no-op commit is acceptable.
          this.logInfo(executionKey, 'commit',
            'Commit found no evidence, but work was skipped (resuming). Succeeding without commit.');
          stepStatuses.commit = 'success';
          context.onStepStatusChange?.('commit', 'success');
        } else {
          stepStatuses.commit = 'failed';
          context.onStepStatusChange?.('commit', 'failed');
          return {
            success: false,
            error: `Commit failed: ${commitResult.error}`,
            stepStatuses,
            copilotSessionId: capturedSessionId,
            failedPhase: 'commit',
            metrics: capturedMetrics,
            phaseMetrics: Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined,
          };
        }
      } else {
        stepStatuses.commit = 'success';
        context.onStepStatusChange?.('commit', 'success');
      }
      
      // Get work summary
      const workSummary = await this.computeWorkSummary(
        node,
        worktreePath,
        context.baseCommit
      );
      
      return {
        success: true,
        completedCommit: commitResult.commit,
        workSummary,
        stepStatuses,
        copilotSessionId: capturedSessionId,
        metrics: capturedMetrics,
        phaseMetrics: Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined,
      };
      
    } catch (error: any) {
      log.error(`Execution error: ${node.name}`, { error: error.message });
      return {
        success: false,
        error: error.message,
        stepStatuses,
        copilotSessionId: capturedSessionId,
        metrics: capturedMetrics,
        phaseMetrics: Object.keys(phaseMetrics).length > 0 ? phaseMetrics : undefined,
      };
    } finally {
      this.activeExecutions.delete(executionKey);
    }
  }
  
  /**
   * Cancel a running execution by killing its process tree.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   */
  cancel(planId: string, nodeId: string): void {
    const executionKey = `${planId}:${nodeId}`;
    const execution = this.activeExecutions.get(executionKey);
    
    if (execution) {
      // Capture call stack for debugging
      const stack = new Error().stack;
      log.warn(`Executor.cancel() called`, {
        planId,
        nodeId,
        pid: execution.process?.pid,
        stack: stack?.split('\n').slice(1, 5).join('\n'),
      });

      execution.aborted = true;
      if (execution.process) {
        log.info(`Killing process PID ${execution.process.pid} for execution: ${executionKey}`);
        try {
          // Kill the process tree
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(execution.process.pid), '/f', '/t']);
          } else {
            execution.process.kill('SIGTERM');
          }
        } catch (e) {
          // Ignore kill errors
        }
      }
    }
  }
  
  /**
   * Get all in-memory log entries for a job execution.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns Array of log entries, empty if no logs exist.
   */
  getLogs(planId: string, nodeId: string): LogEntry[] {
    const executionKey = `${planId}:${nodeId}`;
    return this.executionLogs.get(executionKey) || [];
  }
  
  /**
   * Get log entries filtered to a specific execution phase.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @param phase  - The execution phase to filter by.
   * @returns Filtered log entries.
   */
  getLogsForPhase(planId: string, nodeId: string, phase: ExecutionPhase): LogEntry[] {
    return this.getLogs(planId, nodeId).filter(entry => entry.phase === phase);
  }
  
  /**
   * Get the current size of the log file for a job execution.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns File size in bytes, or 0 if no log file exists.
   */
  getLogFileSize(planId: string, nodeId: string): number {
    const executionKey = `${planId}:${nodeId}`;
    const logFile = this.getLogFilePathByKey(executionKey);
    if (!logFile || !fs.existsSync(logFile)) return 0;
    try {
      return fs.statSync(logFile).size;
    } catch {
      return 0;
    }
  }
  
  /**
   * Get OS-level process stats for a running execution.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns Process info; fields are `null` when the process is not tracked.
   */
  async getProcessStats(planId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: ProcessNode[];
    duration: number | null;
    isAgentWork?: boolean;
  }> {
    const executionKey = `${planId}:${nodeId}`;
    const execution = this.activeExecutions.get(executionKey);
    
    if (!execution) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    
    const duration = execution.startTime ? Date.now() - execution.startTime : null;
    
    // Agent work without a process yet
    if (execution.isAgentWork && !execution.process?.pid) {
      return { pid: null, running: true, tree: [], duration, isAgentWork: true };
    }
    
    if (!execution.process?.pid) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    
    const pid = execution.process.pid;
    const running = this.processMonitor.isRunning(pid);
    
    // Build process tree
    let tree: ProcessNode[] = [];
    try {
      const snapshot = await this.processMonitor.getSnapshot();
      tree = this.processMonitor.buildTree([pid], snapshot);
    } catch {
      // Ignore process tree errors
    }
    
    return { pid, running, tree, duration, isAgentWork: execution.isAgentWork };
  }
  
  /**
   * Get process stats for multiple executions in a single OS process snapshot.
   *
   * More efficient than individual {@link getProcessStats} calls when monitoring
   * many nodes simultaneously.
   *
   * @param nodeKeys - Array of plan/node/name tuples to query.
   * @returns Array of process stats in the same order as input (missing entries omitted).
   */
  async getAllProcessStats(nodeKeys: Array<{ planId: string; nodeId: string; nodeName: string }>): Promise<Array<{
    nodeId: string;
    nodeName: string;
    pid: number | null;
    running: boolean;
    tree: ProcessNode[];
    duration: number | null;
    isAgentWork?: boolean;
  }>> {
    if (nodeKeys.length === 0) return [];
    
    // Fetch snapshot once for all nodes
    let snapshot: any[] = [];
    try {
      snapshot = await this.processMonitor.getSnapshot();
    } catch {
      // Ignore snapshot errors
    }
    
    const results: Array<{
      nodeId: string;
      nodeName: string;
      pid: number | null;
      running: boolean;
      tree: ProcessNode[];
      duration: number | null;
      isAgentWork?: boolean;
    }> = [];
    
    for (const { planId, nodeId, nodeName } of nodeKeys) {
      const executionKey = `${planId}:${nodeId}`;
      const execution = this.activeExecutions.get(executionKey);
      
      if (!execution) {
        continue;
      }
      
      const duration = execution.startTime ? Date.now() - execution.startTime : null;
      
      // Handle agent work without a process yet
      if (execution.isAgentWork && !execution.process?.pid) {
        results.push({ nodeId, nodeName, pid: null, running: true, tree: [], duration, isAgentWork: true });
        continue;
      }
      
      if (!execution.process?.pid) {
        continue;
      }
      
      const pid = execution.process.pid;
      const running = this.processMonitor.isRunning(pid);
      
      // Build process tree from shared snapshot
      let tree: ProcessNode[] = [];
      if (running && snapshot.length > 0) {
        try {
          tree = this.processMonitor.buildTree([pid], snapshot);
        } catch {
          // Ignore tree building errors
        }
      }
      
      if (running || pid) {
        // Include isAgentWork flag for UI display hints
        results.push({ nodeId, nodeName, pid, running, tree, duration, isAgentWork: execution.isAgentWork });
      }
    }
    
    return results;
  }

  /**
   * Check whether a job execution is currently active.
   *
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @returns `true` if the execution is tracked and not yet finished.
   */
  isActive(planId: string, nodeId: string): boolean {
    const executionKey = `${planId}:${nodeId}`;
    return this.activeExecutions.has(executionKey);
  }
  
  /**
   * Append a log entry for a node execution.
   * Logs are stored both in memory and persisted to disk.
   *
   * @param planId  - Plan identifier.
   * @param nodeId  - Node identifier.
   * @param phase   - Current execution phase.
   * @param type    - Log level.
   * @param message - Log message text.
   * @param attemptNumber - Optional attempt number for per-attempt log files.
   */
  log(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string, attemptNumber?: number): void {
    const executionKey = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    
    // Ensure logs array exists
    if (!this.executionLogs.has(executionKey)) {
      this.executionLogs.set(executionKey, []);
    }
    
    const entry: LogEntry = {
      timestamp: Date.now(),
      phase,
      type,
      message,
    };
    
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push(entry);
    }
    
    this.appendToLogFile(executionKey, entry);
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================
  
  /**
   * Run a WorkSpec (dispatches to appropriate handler)
   */
  private async runWorkSpec(
    spec: WorkSpec | undefined,
    worktreePath: string,
    execution: ActiveExecution,
    executionKey: string,
    phase: ExecutionPhase,
    node: JobNode,
    sessionId?: string
  ): Promise<{ success: boolean; error?: string; isAgent?: boolean; copilotSessionId?: string; exitCode?: number; metrics?: CopilotUsageMetrics }> {
    const normalized = normalizeWorkSpec(spec);
    
    if (!normalized) {
      return { success: true }; // No work to do
    }
    
    this.logInfo(executionKey, phase, `Work type: ${normalized.type}`);
    
    switch (normalized.type) {
      case 'process':
        return this.runProcess(normalized, worktreePath, execution, executionKey, phase);
      
      case 'shell':
        return this.runShell(normalized, worktreePath, execution, executionKey, phase);
      
      case 'agent':
        const result = await this.runAgent(normalized, worktreePath, execution, executionKey, node, phase, sessionId);
        return { ...result, isAgent: true };
      
      default:
        return { success: false, error: `Unknown work type: ${(normalized as any).type}` };
    }
  }
  
  /**
   * Run a direct process (no shell)
   */
  private async runProcess(
    spec: ProcessSpec,
    worktreePath: string,
    execution: ActiveExecution,
    executionKey: string,
    phase: ExecutionPhase
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const cwd = spec.cwd ? path.resolve(worktreePath, spec.cwd) : worktreePath;
      const args = spec.args || [];
      const env = { ...process.env, ...spec.env };
      
      // Log the process being spawned
      this.logInfo(executionKey, phase, `Process: ${spec.executable}`);
      this.logInfo(executionKey, phase, `Arguments: ${JSON.stringify(args)}`);
      this.logInfo(executionKey, phase, `Working directory: ${cwd}`);
      if (spec.env) {
        this.logInfo(executionKey, phase, `Environment overrides: ${JSON.stringify(spec.env)}`);
      }
      
      const proc = spawn(spec.executable, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      
      execution.process = proc;
      
      // Log process start with PID
      const startTime = Date.now();
      execution.startTime = startTime;
      this.logInfo(executionKey, phase, `Process started: PID ${proc.pid}`);
      
      let stdout = '';
      let stderr = '';
      let timeoutHandle: NodeJS.Timeout | undefined;
      
      // Set timeout only when explicitly specified (> 0)
      // Omitting timer when no timeout prevents keeping the event loop alive unnecessarily
      const effectiveTimeout = spec.timeout && spec.timeout > 0
        ? Math.min(spec.timeout, 2147483647) : 0;
      if (effectiveTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          this.logError(executionKey, phase, `Process timed out after ${effectiveTimeout}ms (PID: ${proc.pid})`);
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
            } else {
              proc.kill('SIGTERM');
            }
          } catch (e) { /* ignore */ }
        }, effectiveTimeout);
      }
      proc.stderr?.setEncoding('utf8');
      
      proc.stdout?.on('data', (data: string) => {
        stdout += data;
        this.logOutput(executionKey, phase, 'stdout', data);
      });
      
      proc.stderr?.on('data', (data: string) => {
        stderr += data;
        this.logOutput(executionKey, phase, 'stderr', data);
      });
      
      proc.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        execution.process = undefined;
        
        const duration = Date.now() - startTime;
        this.logInfo(executionKey, phase, `Process exited: PID ${proc.pid}, code ${code}, duration ${duration}ms`);
        
        if (execution.aborted) {
          resolve({ success: false, error: 'Execution canceled' });
        } else if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: `Exit code ${code}: ${stderr || stdout}`.trim(),
          });
        }
      });
      
      proc.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        execution.process = undefined;
        const duration = Date.now() - startTime;
        this.logError(executionKey, phase, `Process error: PID ${proc.pid}, error: ${err.message}, duration ${duration}ms`);
        resolve({ success: false, error: err.message });
      });
    });
  }
  
  /**
   * Run a shell command
   */
  private async runShell(
    spec: ShellSpec,
    worktreePath: string,
    execution: ActiveExecution,
    executionKey: string,
    phase: ExecutionPhase
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const cwd = spec.cwd ? path.resolve(worktreePath, spec.cwd) : worktreePath;
      const env = { ...process.env, ...spec.env };
      
      // Determine shell based on spec or platform default
      const isWindows = process.platform === 'win32';
      let shell: string;
      let shellArgs: string[];
      
      switch (spec.shell) {
        case 'cmd':
          shell = 'cmd.exe';
          shellArgs = ['/c', spec.command];
          break;
        case 'powershell':
          shell = 'powershell.exe';
          shellArgs = ['-NoProfile', '-NonInteractive', '-Command', spec.command];
          break;
        case 'pwsh':
          shell = 'pwsh';
          shellArgs = ['-NoProfile', '-NonInteractive', '-Command', spec.command];
          break;
        case 'bash':
          shell = 'bash';
          shellArgs = ['-c', spec.command];
          break;
        case 'sh':
          shell = '/bin/sh';
          shellArgs = ['-c', spec.command];
          break;
        default:
          // Platform default - use PowerShell on Windows for better compatibility
          if (isWindows) {
            shell = 'powershell.exe';
            shellArgs = ['-NoProfile', '-NonInteractive', '-Command', adaptCommandForPowerShell(spec.command)];
          } else {
            shell = '/bin/sh';
            shellArgs = ['-c', spec.command];
          }
      }
      
      // Log the shell command being spawned
      this.logInfo(executionKey, phase, `Shell: ${shell}`);
      this.logInfo(executionKey, phase, `Command: ${spec.command}`);
      this.logInfo(executionKey, phase, `Working directory: ${cwd}`);
      if (spec.env) {
        this.logInfo(executionKey, phase, `Environment overrides: ${JSON.stringify(spec.env)}`);
      }
      
      const proc = spawn(shell, shellArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      
      execution.process = proc;
      
      // Log process start with PID
      const startTime = Date.now();
      execution.startTime = startTime;
      this.logInfo(executionKey, phase, `Shell started: PID ${proc.pid}`);
      
      let stdout = '';
      let stderr = '';
      let timeoutHandle: NodeJS.Timeout | undefined;
      
      // Set timeout only when explicitly specified (> 0)
      const effectiveTimeout = spec.timeout && spec.timeout > 0
        ? Math.min(spec.timeout, 2147483647) : 0;
      if (effectiveTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          this.logError(executionKey, phase, `Shell command timed out after ${effectiveTimeout}ms (PID: ${proc.pid})`);
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
            } else {
              proc.kill('SIGTERM');
            }
          } catch (e) { /* ignore */ }
        }, effectiveTimeout);
      }
      
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      
      proc.stdout?.on('data', (data: string) => {
        stdout += data;
        this.logOutput(executionKey, phase, 'stdout', data);
      });
      
      proc.stderr?.on('data', (data: string) => {
        stderr += data;
        this.logOutput(executionKey, phase, 'stderr', data);
      });
      
      proc.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        execution.process = undefined;
        
        const duration = Date.now() - startTime;
        this.logInfo(executionKey, phase, `Shell exited: PID ${proc.pid}, code ${code}, duration ${duration}ms`);
        
        if (execution.aborted) {
          resolve({ success: false, error: 'Execution canceled' });
        } else if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: `Exit code ${code}: ${stderr || stdout}`.trim(),
          });
        }
      });
      
      proc.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        execution.process = undefined;
        const duration = Date.now() - startTime;
        this.logError(executionKey, phase, `Shell error: PID ${proc.pid}, error: ${err.message}, duration ${duration}ms`);
        resolve({ success: false, error: err.message });
      });
    });
  }
  
  /**
   * Run agent work with rich config
   */
  private async runAgent(
    spec: AgentSpec,
    worktreePath: string,
    execution: ActiveExecution,
    executionKey: string,
    node: JobNode,
    phase: ExecutionPhase,
    sessionId?: string
  ): Promise<{ success: boolean; error?: string; copilotSessionId?: string; exitCode?: number; metrics?: CopilotUsageMetrics }> {
    if (!this.agentDelegator) {
      return {
        success: false,
        error: 'Agent work requires an agent delegator to be configured',
      };
    }
    
    // Track agent work for process stats
    execution.isAgentWork = true;
    execution.startTime = Date.now();
    
    this.logInfo(executionKey, phase, `Agent instructions: ${spec.instructions}`);
    if (spec.model) {
      this.logInfo(executionKey, phase, `Using model: ${spec.model}`);
    }
    if (spec.contextFiles?.length) {
      this.logInfo(executionKey, phase, `Agent context files: ${spec.contextFiles.join(', ')}`);
    }
    if (spec.maxTurns) {
      this.logInfo(executionKey, phase, `Agent max turns: ${spec.maxTurns}`);
    }
    if (spec.context) {
      this.logInfo(executionKey, phase, `Agent context: ${spec.context}`);
    }
    if (sessionId) {
      this.logInfo(executionKey, phase, `Resuming Copilot session: ${sessionId}`);
    }
    
    try {
      const result = await this.agentDelegator.delegate({
        task: spec.instructions,
        instructions: node.instructions || spec.context,
        worktreePath,
        model: spec.model,
        contextFiles: spec.contextFiles,
        maxTurns: spec.maxTurns,
        sessionId, // Pass session ID for resumption
        jobId: node.id,
        logOutput: (line: string) => this.logInfo(executionKey, phase, line),
        onProcess: (proc: any) => {
          // Track the Copilot CLI process for monitoring (CPU/memory/tree)
          execution.process = proc;
          execution.isAgentWork = true; // Keep both flags for UI hints
        },
      });
      
      // Build metrics from delegation result
      const durationMs = Date.now() - execution.startTime;
      let metrics: CopilotUsageMetrics;
      if (result.metrics) {
        // Use rich parsed metrics from CopilotStatsParser
        metrics = { ...result.metrics, durationMs };
      } else {
        // Fallback to legacy token usage
        metrics = { durationMs };
        if (result.tokenUsage) {
          metrics.tokenUsage = result.tokenUsage;
        }
      }
      
      if (result.success) {
        this.logInfo(executionKey, phase, 'Agent completed successfully');
        if (result.sessionId) {
          this.logInfo(executionKey, phase, `Captured session ID: ${result.sessionId}`);
        }
        return { success: true, copilotSessionId: result.sessionId, metrics };
      } else {
        this.logError(executionKey, phase, `Agent failed: ${result.error}`);
        return { 
          success: false, 
          error: result.error, 
          copilotSessionId: result.sessionId,
          exitCode: result.exitCode,
          metrics,
        };
      }
    } catch (error: any) {
      this.logError(executionKey, phase, `Agent error: ${error.message}`);
      const durationMs = Date.now() - (execution.startTime || Date.now());
      return { success: false, error: error.message, metrics: { durationMs } };
    }
  }
  
  /**
   * Commit changes in the worktree
   * 
   * VALIDATION: Either the work stage made commits, or there must be uncommitted
   * changes to commit. If neither is true, the job produced no work and we fail.
   */
  private async commitChanges(
    node: JobNode,
    worktreePath: string,
    executionKey: string,
    baseCommit: string
  ): Promise<{ success: boolean; commit?: string; error?: string; reviewMetrics?: CopilotUsageMetrics }> {
    try {
      // Log git status for debugging
      this.logInfo(executionKey, 'commit', `Checking git status in ${worktreePath}`);
      const statusOutput = await this.getGitStatus(worktreePath);
      if (statusOutput) {
        this.logInfo(executionKey, 'commit', `Git status:\n${statusOutput}`);
      } else {
        this.logInfo(executionKey, 'commit', 'Git status: clean (no changes)');
        // Show ignored files for troubleshooting when no changes detected
        const ignoredFiles = await this.getIgnoredFiles(worktreePath);
        if (ignoredFiles) {
          this.logInfo(executionKey, 'commit', `Ignored files (not tracked by git):\n${ignoredFiles}`);
        }
      }
      
      // Check if there are uncommitted changes to commit
      const hasChanges = await git.repository.hasUncommittedChanges(worktreePath);
      this.logInfo(executionKey, 'commit', `hasUncommittedChanges: ${hasChanges}`);
      
      if (!hasChanges) {
        // No uncommitted changes - check if commits were made during the work stage
        this.logInfo(executionKey, 'commit', 'No uncommitted changes, checking for commits since base...');
        
        const head = await git.worktrees.getHeadCommit(worktreePath);
        this.logInfo(executionKey, 'commit', `HEAD: ${head?.slice(0, 8) || 'unknown'}, baseCommit: ${baseCommit.slice(0, 8)}`);
        
        if (head && head !== baseCommit) {
          // Commits were made during work stage (e.g., by @agent)
          this.logInfo(executionKey, 'commit', `Work stage made commits, HEAD: ${head.slice(0, 8)}`);
          return { success: true, commit: head };
        }
        
        // Check for evidence file
        const hasEvidence = await this.evidenceValidator.hasEvidenceFile(
          worktreePath, node.id
        );
        if (hasEvidence) {
          this.logInfo(executionKey, 'commit', 'Evidence file found, staging...');
          await git.repository.stageAll(worktreePath);
          const message = `[Plan] ${node.task} (evidence only)`;
          await git.repository.commit(worktreePath, message);
          const commit = await git.worktrees.getHeadCommit(worktreePath);
          return { success: true, commit: commit || undefined };
        }
        
        // Check expectsNoChanges flag
        if (node.expectsNoChanges) {
          this.logInfo(executionKey, 'commit',
            'Node declares expectsNoChanges — succeeding without commit');
          return { success: true, commit: undefined };
        }
        
        // AI Review: Ask an agent to review the execution logs and determine
        // whether "no changes" is a legitimate outcome (e.g., work was already
        // done by a dependency, tests already pass, linter found no issues).
        if (this.agentDelegator) {
          this.logInfo(executionKey, 'commit',
            'No file changes detected. Requesting AI review of execution logs...');
          const reviewResult = await this.aiReviewNoChanges(
            node, worktreePath, executionKey
          );
          if (reviewResult.legitimate) {
            this.logInfo(executionKey, 'commit',
              `AI review: No changes needed — ${reviewResult.reason}`);
            return { success: true, commit: undefined, reviewMetrics: reviewResult.metrics };
          } else {
            this.logInfo(executionKey, 'commit',
              `AI review: Changes were expected — ${reviewResult.reason}`);
            // Fall through to failure — but preserve AI review metrics
            const error =
              'No work evidence produced. The node must either:\n' +
              '  1. Modify files (results in a commit)\n' +
              '  2. Create an evidence file at .orchestrator/evidence/<nodeId>.json\n' +
              '  3. Declare expectsNoChanges: true in the node spec';
            this.logError(executionKey, 'commit', error);
            return { success: false, error, reviewMetrics: reviewResult.metrics };
          }
        }
        
        // No evidence — fail (no AI review available)
        const error =
          'No work evidence produced. The node must either:\n' +
          '  1. Modify files (results in a commit)\n' +
          '  2. Create an evidence file at .orchestrator/evidence/<nodeId>.json\n' +
          '  3. Declare expectsNoChanges: true in the node spec';
        this.logError(executionKey, 'commit', error);
        return { success: false, error };
      }
      
      // Stage all changes
      this.logInfo(executionKey, 'commit', 'Staging all changes...');
      await git.repository.stageAll(worktreePath);
      
      // Commit
      const message = `[Plan] ${node.task}`;
      this.logInfo(executionKey, 'commit', `Creating commit: "${message}"`);
      await git.repository.commit(worktreePath, message);
      
      // Get the new commit SHA
      const commit = await git.worktrees.getHeadCommit(worktreePath);
      
      this.logInfo(executionKey, 'commit', `✓ Committed: ${commit?.slice(0, 8)}`);
      
      return { success: true, commit: commit || undefined };
    } catch (error: any) {
      this.logError(executionKey, 'commit', `Commit error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * AI Review: Determine whether "no changes" is a legitimate outcome.
   *
   * When the commit phase finds no file changes and no evidence file,
   * this method asks an AI agent to review the execution logs and judge
   * whether the absence of changes is expected (e.g., work was already
   * done by a dependency, tests passed with nothing to fix, linter found
   * no issues) or whether the work genuinely failed to produce output.
   *
   * @returns `{ legitimate: true, reason, metrics? }` if no-op is acceptable,
   *          `{ legitimate: false, reason, metrics? }` if changes were expected.
   */
  private async aiReviewNoChanges(
    node: JobNode,
    worktreePath: string,
    executionKey: string
  ): Promise<{ legitimate: boolean; reason: string; metrics?: CopilotUsageMetrics }> {
    try {
      // Gather execution logs — truncated to keep the prompt manageable
      const logs = this.executionLogs.get(executionKey) || [];
      const logText = logs
        .map(e => `[${e.phase}] [${e.type}] ${e.message}`)
        .join('\n');
      const logLines = logText.split('\n');
      const truncatedLogs = logLines.length > 150
        ? `... (${logLines.length - 150} earlier lines omitted)\n` + logLines.slice(-150).join('\n')
        : logText;

      // Describe the original work spec for context
      const workDesc = (() => {
        const spec = normalizeWorkSpec(node.work);
        if (!spec) return 'No work specified';
        if (spec.type === 'shell') return `Shell: ${spec.command}`;
        if (spec.type === 'process') return `Process: ${spec.executable} ${(spec.args || []).join(' ')}`;
        if (spec.type === 'agent') return `Agent: ${spec.instructions.slice(0, 200)}`;
        return 'Unknown work type';
      })();

      const reviewPrompt = [
        '# No-Change Review: Was This Outcome Expected?',
        '',
        '## Context',
        `A plan node completed its work phase successfully, but produced NO file changes.`,
        `The commit phase needs to determine: is this a legitimate "no-op" or a failure?`,
        '',
        '## Node Details',
        `- **Name**: ${node.name}`,
        `- **Task**: ${node.task}`,
        `- **Work**: ${workDesc}`,
        '',
        '## Execution Logs',
        '```',
        truncatedLogs,
        '```',
        '',
        '## Your Judgment',
        'Based on the logs above, determine ONE of:',
        '',
        '1. **LEGITIMATE**: The work ran correctly but no file changes were needed.',
        '   Examples: tests already pass, linter found no issues, files were already',
        '   created by a dependency, agent verified work was already done.',
        '',
        '2. **UNEXPECTED**: The work should have produced changes but didn\'t.',
        '   Examples: agent said it would write files but didn\'t, command silently',
        '   failed, work was not attempted.',
        '',
        '## CRITICAL: Response Format',
        'You MUST write your answer as a single-line JSON object on the LAST LINE',
        'of your output. No markdown fences, no extra text after it.',
        '',
        'Format: {"legitimate": true|false, "reason": "brief explanation"}',
        '',
        'Example last line:',
        '{"legitimate": true, "reason": "Tests already existed and all 24 passed — no changes needed"}',
      ].join('\n');

      this.logInfo(executionKey, 'commit', '========== AI REVIEW: NO-CHANGE ASSESSMENT ==========');

      // Use a lightweight, fast model for the review
      const result = await this.agentDelegator.delegate({
        task: reviewPrompt,
        worktreePath,
        model: 'claude-haiku-4.5',
        logOutput: (line: string) => this.logInfo(executionKey, 'commit', `[ai-review] ${line}`),
        onProcess: () => {}, // No need to track this short-lived process
      });

      this.logInfo(executionKey, 'commit', '========== AI REVIEW: COMPLETE ==========');

      // Capture metrics from the AI review delegation
      const reviewMetrics = result.metrics;

      if (!result.success) {
        // AI review itself failed — don't block on it, fall through to normal fail
        this.logInfo(executionKey, 'commit',
          `AI review could not complete: ${result.error}. Falling through to standard validation.`);
        return { legitimate: false, reason: 'AI review unavailable', metrics: reviewMetrics };
      }

      // Parse the AI's judgment from the execution logs.
      // The agent writes to stdout via logOutput — look for the JSON verdict
      // in the commit-phase logs written since we started the review.
      const reviewLogs = (this.executionLogs.get(executionKey) || [])
        .filter(e => e.phase === 'commit' && e.message.includes('[ai-review]'))
        .map(e => e.message);

      // Helper: strip HTML/markdown code fences so we can find JSON
      // that the agent may have wrapped in <pre><code> or ```json blocks.
      // Loop to handle nested/incomplete tag stripping (e.g. <scr<script>ipt>).
      const stripMarkup = (s: string) => {
        let result = s;
        let prev: string;
        do {
          prev = result;
          result = result.replace(/<\/?[^>]+>/g, '');
        } while (result !== prev);
        return result.replace(/```(?:json)?\s*/g, '');
      };

      // Search for JSON response — try each line last-to-first (most likely location)
      for (let i = reviewLogs.length - 1; i >= 0; i--) {
        const line = stripMarkup(reviewLogs[i]);
        const jsonMatch = line.match(/\{[^{}]*"legitimate"\s*:\s*(true|false)[^{}]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as { legitimate: boolean; reason: string };
            return {
              legitimate: parsed.legitimate === true,
              reason: parsed.reason || (parsed.legitimate ? 'AI review approved' : 'AI review rejected'),
              metrics: reviewMetrics,
            };
          } catch {
            // JSON parse failed, continue searching
          }
        }
      }

      // The JSON may have been split across multiple log lines (e.g., long reason text).
      // Concatenate all review lines, strip markup, and search the combined text.
      const combined = stripMarkup(reviewLogs.join(' '));
      const combinedMatch = combined.match(/\{\s*"legitimate"\s*:\s*(true|false)\s*,\s*"reason"\s*:\s*"([^"]*)"\s*\}/);
      if (combinedMatch) {
        try {
          const parsed = JSON.parse(combinedMatch[0]) as { legitimate: boolean; reason: string };
          return {
            legitimate: parsed.legitimate === true,
            reason: parsed.reason || (parsed.legitimate ? 'AI review approved' : 'AI review rejected'),
            metrics: reviewMetrics,
          };
        } catch {
          // JSON parse failed
        }
      }

      // Couldn't parse a structured response — fall through
      this.logInfo(executionKey, 'commit',
        'AI review did not return a parseable judgment. Falling through to standard validation.');
      return { legitimate: false, reason: 'AI review returned no parseable judgment', metrics: reviewMetrics };
    } catch (error: any) {
      // Don't let AI review errors block the pipeline
      this.logInfo(executionKey, 'commit',
        `AI review error: ${error.message}. Falling through to standard validation.`);
      return { legitimate: false, reason: `AI review error: ${error.message}` };
    }
  }
  
  /**
   * Get git status output for debugging
   */
  private async getGitStatus(cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('git', ['status', '--porcelain'], { cwd });
      let output = '';
      proc.stdout?.on('data', (data) => output += data.toString());
      proc.on('close', () => resolve(output.trim() || null));
      proc.on('error', () => resolve(null));
    });
  }
  
  /**
   * Get list of ignored files for troubleshooting.
   * Uses git status --ignored to show files excluded by .gitignore.
   */
  private async getIgnoredFiles(cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      // --ignored --short shows ignored files with !! prefix
      const proc = spawn('git', ['status', '--ignored', '--short'], { cwd });
      let output = '';
      proc.stdout?.on('data', (data) => output += data.toString());
      proc.on('close', () => {
        // Filter to only lines starting with !! (ignored files)
        const lines = output.split('\n')
          .filter(line => line.startsWith('!!'))
          .map(line => line.slice(3).trim()) // Remove !! prefix
          .slice(0, 50); // Limit to 50 files to avoid huge output
        if (lines.length === 0) {
          resolve(null);
        } else {
          const result = lines.join('\n');
          resolve(lines.length === 50 ? result + '\n... (truncated)' : result);
        }
      });
      proc.on('error', () => resolve(null));
    });
  }
  
  /**
   * Compute work summary for a job
   */
  private async computeWorkSummary(
    node: JobNode,
    worktreePath: string,
    baseCommit: string
  ): Promise<JobWorkSummary> {
    try {
      const head = await git.worktrees.getHeadCommit(worktreePath);
      if (!head || (head === baseCommit && node.expectsNoChanges)) {
        // expectsNoChanges nodes with no commits get a descriptive summary
        if (node.expectsNoChanges) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            commits: 0,
            filesAdded: 0,
            filesModified: 0,
            filesDeleted: 0,
            description: 'Node declared expectsNoChanges',
            commitDetails: [],
          };
        }
        return this.emptyWorkSummary(node);
      }
      
      // Get commit details
      const commitDetails = await this.getCommitDetails(worktreePath, baseCommit, head);
      
      // Aggregate counts
      let filesAdded = 0;
      let filesModified = 0;
      let filesDeleted = 0;
      
      for (const detail of commitDetails) {
        filesAdded += detail.filesAdded.length;
        filesModified += detail.filesModified.length;
        filesDeleted += detail.filesDeleted.length;
      }
      
      return {
        nodeId: node.id,
        nodeName: node.name,
        commits: commitDetails.length,
        filesAdded,
        filesModified,
        filesDeleted,
        description: node.task,
        commitDetails,
      };
    } catch (error: any) {
      log.warn(`Failed to compute work summary: ${error.message}`);
      return this.emptyWorkSummary(node);
    }
  }
  
  /**
   * Get detailed commit information
   */
  private async getCommitDetails(
    worktreePath: string,
    baseCommit: string,
    headCommit: string
  ): Promise<CommitDetail[]> {
    // Simplified implementation - in production would parse git log
    try {
      const details: CommitDetail[] = [];
      
      // Get the diff stats
      const diffResult = await git.executor.execAsync(
        ['diff', '--stat', '--name-status', `${baseCommit}..${headCommit}`],
        { cwd: worktreePath }
      );
      
      if (diffResult.success) {
        const lines = diffResult.stdout.split('\n').filter(l => l.trim());
        const filesAdded: string[] = [];
        const filesModified: string[] = [];
        const filesDeleted: string[] = [];
        
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const status = parts[0];
            const file = parts[1];
            
            if (status === 'A') filesAdded.push(file);
            else if (status === 'M') filesModified.push(file);
            else if (status === 'D') filesDeleted.push(file);
          }
        }
        
        details.push({
          hash: headCommit,
          shortHash: headCommit.slice(0, 8),
          message: 'Work completed',
          author: 'Plan Runner',
          date: new Date().toISOString(),
          filesAdded,
          filesModified,
          filesDeleted,
        });
      }
      
      return details;
    } catch (error) {
      return [];
    }
  }
  
  /**
   * Create an empty work summary
   */
  private emptyWorkSummary(node: JobNode): JobWorkSummary {
    return {
      nodeId: node.id,
      nodeName: node.name,
      commits: 0,
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      description: node.task,
    };
  }
  
  // ============================================================================
  // LOGGING
  // ============================================================================
  
  /**
   * Get or create log file path for an execution.
   * 
   * @param planId - Plan identifier.
   * @param nodeId - Node identifier.
   * @param attemptNumber - Optional 1-based attempt number. If provided, returns path for specific attempt.
   * @returns Absolute path to the log file, or undefined if no storage path.
   */
  getLogFilePath(planId: string, nodeId: string, attemptNumber?: number): string | undefined {
    if (!this.storagePath) return undefined;
    
    // Include attempt number in key if provided
    const executionKey = attemptNumber 
      ? `${planId}:${nodeId}:${attemptNumber}`
      : `${planId}:${nodeId}`;
    let logFile = this.logFiles.get(executionKey);
    if (!logFile) {
      const logsDir = path.join(this.storagePath, 'logs');
      const safeKey = executionKey.replace(/[^a-zA-Z0-9-_]/g, '_');
      logFile = path.join(logsDir, `${safeKey}.log`);
      this.logFiles.set(executionKey, logFile);
    }
    return logFile;
  }

  /**
   * Internal method to get log file path from execution key.
   */
  private getLogFilePathByKey(executionKey: string): string | undefined {
    if (!this.storagePath) return undefined;
    
    let logFile = this.logFiles.get(executionKey);
    if (!logFile) {
      const logsDir = path.join(this.storagePath, 'logs');
      const safeKey = executionKey.replace(/[^a-zA-Z0-9-_]/g, '_');
      logFile = path.join(logsDir, `${safeKey}.log`);
      this.logFiles.set(executionKey, logFile);
    }
    return logFile;
  }
  
  /**
   * Append a log entry to file
   */
  private appendToLogFile(executionKey: string, entry: LogEntry): void {
    const logFile = this.getLogFilePathByKey(executionKey);
    if (!logFile) return;
    
    try {
      const time = new Date(entry.timestamp).toISOString();
      const prefix = entry.type === 'stderr' ? '[ERR]' : 
                     entry.type === 'error' ? '[ERROR]' :
                     entry.type === 'info' ? '[INFO]' : '';
      const line = `[${time}] [${entry.phase.toUpperCase()}] ${prefix} ${entry.message}\n`;
      fs.appendFileSync(logFile, line, 'utf8');
    } catch (err) {
      // Ignore file write errors
    }
  }
  
  /**
   * Read logs from file for a completed execution
   */
  readLogsFromFile(planId: string, nodeId: string, attemptNumber?: number): string {
    const executionKey = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    const logFile = this.getLogFilePathByKey(executionKey);
    
    if (!logFile || !fs.existsSync(logFile)) {
      return 'No log file found.';
    }
    
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch (err) {
      return `Error reading log file: ${err}`;
    }
  }
  
  /**
   * Read logs from file starting at a byte offset.
   * Used to capture only the logs produced during the current attempt.
   */
  readLogsFromFileOffset(planId: string, nodeId: string, byteOffset: number, attemptNumber?: number): string {
    const executionKey = attemptNumber ? `${planId}:${nodeId}:${attemptNumber}` : `${planId}:${nodeId}`;
    const logFile = this.getLogFilePathByKey(executionKey);

    if (!logFile) {
      return 'No log file found.';
    }

    try {
      if (byteOffset <= 0) {
        return fs.readFileSync(logFile, 'utf8');
      }

      const fd = fs.openSync(logFile, 'r');
      try {
        const stats = fs.fstatSync(fd);
        const fileSize = stats.size;

        if (byteOffset >= fileSize) {
          return '';
        }

        const length = fileSize - byteOffset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, byteOffset);
        return buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') return 'No log file found.';
      return `Error reading log file: ${err}`;
    }
  }
  
  private logOutput(
    executionKey: string,
    phase: ExecutionPhase,
    type: 'stdout' | 'stderr',
    message: string
  ): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      phase,
      type,
      message,
    };
    
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push(entry);
    }
    
    this.appendToLogFile(executionKey, entry);
  }
  
  private logInfo(executionKey: string, phase: ExecutionPhase, message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      phase,
      type: 'info',
      message,
    };
    
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push(entry);
    }
    
    this.appendToLogFile(executionKey, entry);
  }
  
  private logError(executionKey: string, phase: ExecutionPhase, message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      phase,
      type: 'error',
      message,
    };
    
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push(entry);
    }
    
    this.appendToLogFile(executionKey, entry);
  }
}
