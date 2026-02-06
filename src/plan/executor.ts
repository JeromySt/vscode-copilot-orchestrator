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
  normalizeWorkSpec,
} from './types';
import { JobExecutor } from './runner';
import { Logger } from '../core/logger';
import * as git from '../git';

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
}

/**
 * Default Job Executor implementation
 */
export class DefaultJobExecutor implements JobExecutor {
  private activeExecutions = new Map<string, ActiveExecution>();
  private executionLogs = new Map<string, LogEntry[]>();
  private logFiles = new Map<string, string>(); // execution key -> log file path
  private agentDelegator?: any; // IAgentDelegator interface
  private storagePath?: string;
  private processMonitor = new ProcessMonitor();
  
  /**
   * Set storage path for log files
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
   * Set the agent delegator for @agent tasks
   */
  setAgentDelegator(delegator: any): void {
    this.agentDelegator = delegator;
  }
  
  /**
   * Execute a job
   */
  async execute(context: ExecutionContext): Promise<JobExecutionResult> {
    const { plan, node, worktreePath } = context;
    const executionKey = `${plan.id}:${node.id}`;
    
    // Track this execution
    const execution: ActiveExecution = {
      planId: plan.id,
      nodeId: node.id,
      aborted: false,
    };
    this.activeExecutions.set(executionKey, execution);
    this.executionLogs.set(executionKey, []);
    
    // Track per-phase statuses and captured session ID
    const stepStatuses: JobExecutionResult['stepStatuses'] = {};
    let capturedSessionId: string | undefined = context.copilotSessionId;
    
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
      
      // Run prechecks
      if (node.prechecks) {
        context.onProgress?.('Running prechecks');
        this.logInfo(executionKey, 'prechecks', '========== PRECHECKS SECTION START ==========');
        
        const precheckResult = await this.runWorkSpec(
          node.prechecks,
          worktreePath,
          execution,
          executionKey,
          'prechecks',
          node
        );
        
        this.logInfo(executionKey, 'prechecks', '========== PRECHECKS SECTION END ==========');
        
        if (!precheckResult.success) {
          stepStatuses.prechecks = 'failed';
          return {
            success: false,
            error: `Prechecks failed: ${precheckResult.error}`,
            stepStatuses,
            failedPhase: 'prechecks',
            exitCode: precheckResult.exitCode,
          };
        }
        stepStatuses.prechecks = 'success';
      } else {
        stepStatuses.prechecks = 'skipped';
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled', stepStatuses };
      }
      
      // Run main work
      if (node.work) {
        context.onProgress?.('Running work');
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
        
        this.logInfo(executionKey, 'work', '========== WORK SECTION END ==========');
        
        if (!workResult.success) {
          stepStatuses.work = 'failed';
          return {
            success: false,
            error: `Work failed: ${workResult.error}`,
            stepStatuses,
            copilotSessionId: capturedSessionId,
            failedPhase: 'work',
            exitCode: workResult.exitCode,
          };
        }
        stepStatuses.work = 'success';
      } else {
        // No work command - this is unusual but not an error
        this.logInfo(executionKey, 'work', '========== WORK SECTION START ==========');
        this.logInfo(executionKey, 'work', 'No work specified - skipping');
        this.logInfo(executionKey, 'work', '========== WORK SECTION END ==========');
        log.warn(`Job ${node.name} has no work specified`);
        stepStatuses.work = 'skipped';
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId };
      }
      
      // Run postchecks
      if (node.postchecks) {
        context.onProgress?.('Running postchecks');
        this.logInfo(executionKey, 'postchecks', '========== POSTCHECKS SECTION START ==========');
        
        const postcheckResult = await this.runWorkSpec(
          node.postchecks,
          worktreePath,
          execution,
          executionKey,
          'postchecks',
          node
        );
        
        this.logInfo(executionKey, 'postchecks', '========== POSTCHECKS SECTION END ==========');
        
        if (!postcheckResult.success) {
          stepStatuses.postchecks = 'failed';
          return {
            success: false,
            error: `Postchecks failed: ${postcheckResult.error}`,
            stepStatuses,
            copilotSessionId: capturedSessionId,
            failedPhase: 'postchecks',
            exitCode: postcheckResult.exitCode,
          };
        }
        stepStatuses.postchecks = 'success';
      } else {
        stepStatuses.postchecks = 'skipped';
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled', stepStatuses, copilotSessionId: capturedSessionId };
      }
      
      // Commit changes
      context.onProgress?.('Committing changes');
      this.logInfo(executionKey, 'commit', '========== COMMIT SECTION START ==========');
      const commitResult = await this.commitChanges(
        node,
        worktreePath,
        executionKey,
        context.baseCommit
      );
      this.logInfo(executionKey, 'commit', '========== COMMIT SECTION END ==========');
      
      if (!commitResult.success) {
        stepStatuses.commit = 'failed';
        return {
          success: false,
          error: `Commit failed: ${commitResult.error}`,
          stepStatuses,
          copilotSessionId: capturedSessionId,
          failedPhase: 'commit',
        };
      }
      stepStatuses.commit = 'success';
      
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
      };
      
    } catch (error: any) {
      log.error(`Execution error: ${node.name}`, { error: error.message });
      return {
        success: false,
        error: error.message,
        stepStatuses,
        copilotSessionId: capturedSessionId,
      };
    } finally {
      this.activeExecutions.delete(executionKey);
    }
  }
  
  /**
   * Cancel an execution
   */
  cancel(planId: string, nodeId: string): void {
    const executionKey = `${planId}:${nodeId}`;
    const execution = this.activeExecutions.get(executionKey);
    
    if (execution) {
      execution.aborted = true;
      if (execution.process) {
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
   * Get execution logs for a job
   */
  getLogs(planId: string, nodeId: string): LogEntry[] {
    const executionKey = `${planId}:${nodeId}`;
    return this.executionLogs.get(executionKey) || [];
  }
  
  /**
   * Get logs for a specific phase
   */
  getLogsForPhase(planId: string, nodeId: string, phase: ExecutionPhase): LogEntry[] {
    return this.getLogs(planId, nodeId).filter(entry => entry.phase === phase);
  }
  
  /**
   * Get process stats for a running execution
   */
  async getProcessStats(planId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: ProcessNode[];
    duration: number | null;
  }> {
    const executionKey = `${planId}:${nodeId}`;
    const execution = this.activeExecutions.get(executionKey);
    
    if (!execution || !execution.process?.pid) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    
    const pid = execution.process.pid;
    const running = this.processMonitor.isRunning(pid);
    const duration = execution.startTime ? Date.now() - execution.startTime : null;
    
    // Build process tree
    let tree: ProcessNode[] = [];
    try {
      const snapshot = await this.processMonitor.getSnapshot();
      tree = this.processMonitor.buildTree([pid], snapshot);
    } catch {
      // Ignore process tree errors
    }
    
    return { pid, running, tree, duration };
  }
  
  /**
   * Get process stats for multiple running executions (more efficient than calling getProcessStats multiple times)
   * Fetches snapshot once and builds trees for all.
   */
  async getAllProcessStats(nodeKeys: Array<{ planId: string; nodeId: string; nodeName: string }>): Promise<Array<{
    nodeId: string;
    nodeName: string;
    pid: number | null;
    running: boolean;
    tree: ProcessNode[];
    duration: number | null;
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
    }> = [];
    
    for (const { planId, nodeId, nodeName } of nodeKeys) {
      const executionKey = `${planId}:${nodeId}`;
      const execution = this.activeExecutions.get(executionKey);
      
      if (!execution || !execution.process?.pid) {
        continue;
      }
      
      const pid = execution.process.pid;
      const running = this.processMonitor.isRunning(pid);
      const duration = execution.startTime ? Date.now() - execution.startTime : null;
      
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
        results.push({ nodeId, nodeName, pid, running, tree, duration });
      }
    }
    
    return results;
  }

  /**
   * Check if an execution is active
   */
  isActive(planId: string, nodeId: string): boolean {
    const executionKey = `${planId}:${nodeId}`;
    return this.activeExecutions.has(executionKey);
  }
  
  /**
   * Log a message for a node execution (public API for runner to log merge operations)
   */
  log(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void {
    const executionKey = `${planId}:${nodeId}`;
    
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
  ): Promise<{ success: boolean; error?: string; isAgent?: boolean; copilotSessionId?: string; exitCode?: number }> {
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
        const result = await this.runAgent(normalized, worktreePath, execution, executionKey, node, sessionId);
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
      
      // Set timeout if specified
      if (spec.timeout) {
        timeoutHandle = setTimeout(() => {
          this.logError(executionKey, phase, `Process timed out after ${spec.timeout}ms (PID: ${proc.pid})`);
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
            } else {
              proc.kill('SIGTERM');
            }
          } catch (e) { /* ignore */ }
        }, spec.timeout);
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
          // Platform default
          shell = isWindows ? 'cmd.exe' : '/bin/sh';
          shellArgs = isWindows ? ['/c', spec.command] : ['-c', spec.command];
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
      
      // Set timeout if specified
      if (spec.timeout) {
        timeoutHandle = setTimeout(() => {
          this.logError(executionKey, phase, `Shell command timed out after ${spec.timeout}ms (PID: ${proc.pid})`);
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
            } else {
              proc.kill('SIGTERM');
            }
          } catch (e) { /* ignore */ }
        }, spec.timeout);
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
    sessionId?: string
  ): Promise<{ success: boolean; error?: string; copilotSessionId?: string; exitCode?: number }> {
    if (!this.agentDelegator) {
      return {
        success: false,
        error: 'Agent work requires an agent delegator to be configured',
      };
    }
    
    this.logInfo(executionKey, 'work', `Agent instructions: ${spec.instructions}`);
    if (spec.model) {
      this.logInfo(executionKey, 'work', `Agent model: ${spec.model}`);
    }
    if (spec.contextFiles?.length) {
      this.logInfo(executionKey, 'work', `Agent context files: ${spec.contextFiles.join(', ')}`);
    }
    if (spec.maxTurns) {
      this.logInfo(executionKey, 'work', `Agent max turns: ${spec.maxTurns}`);
    }
    if (spec.context) {
      this.logInfo(executionKey, 'work', `Agent context: ${spec.context}`);
    }
    if (sessionId) {
      this.logInfo(executionKey, 'work', `Resuming Copilot session: ${sessionId}`);
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
      });
      
      if (result.success) {
        this.logInfo(executionKey, 'work', 'Agent completed successfully');
        if (result.sessionId) {
          this.logInfo(executionKey, 'work', `Captured session ID: ${result.sessionId}`);
        }
        return { success: true, copilotSessionId: result.sessionId };
      } else {
        this.logError(executionKey, 'work', `Agent failed: ${result.error}`);
        return { 
          success: false, 
          error: result.error, 
          copilotSessionId: result.sessionId,
          exitCode: result.exitCode 
        };
      }
    } catch (error: any) {
      this.logError(executionKey, 'work', `Agent error: ${error.message}`);
      return { success: false, error: error.message };
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
  ): Promise<{ success: boolean; commit?: string; error?: string }> {
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
        
        // No commits and no uncommitted changes = no work produced
        const error = 'No commits made and no uncommitted changes found. The job produced no work.';
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
      if (!head) {
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
   * Get or create log file path for an execution
   */
  private getLogFilePath(executionKey: string): string | undefined {
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
    const logFile = this.getLogFilePath(executionKey);
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
  readLogsFromFile(planId: string, nodeId: string): string {
    const executionKey = `${planId}:${nodeId}`;
    const logFile = this.getLogFilePath(executionKey);
    
    if (!logFile || !fs.existsSync(logFile)) {
      return 'No log file found.';
    }
    
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch (err) {
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
