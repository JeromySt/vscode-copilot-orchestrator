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
 * @module dag/executor
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import {
  JobNode,
  ExecutionContext,
  JobExecutionResult,
  JobWorkSummary,
  CommitDetail,
  ExecutionPhase,
  LogEntry,
} from './types';
import { JobExecutor } from './runner';
import { Logger } from '../core/logger';
import * as git from '../git';

const log = Logger.for('job-executor');

/**
 * Active execution tracking
 */
interface ActiveExecution {
  dagId: string;
  nodeId: string;
  process?: ChildProcess;
  aborted: boolean;
}

/**
 * Default Job Executor implementation
 */
export class DefaultJobExecutor implements JobExecutor {
  private activeExecutions = new Map<string, ActiveExecution>();
  private executionLogs = new Map<string, LogEntry[]>();
  private agentDelegator?: any; // IAgentDelegator interface
  
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
    const { dag, node, worktreePath } = context;
    const executionKey = `${dag.id}:${node.id}`;
    
    // Track this execution
    const execution: ActiveExecution = {
      dagId: dag.id,
      nodeId: node.id,
      aborted: false,
    };
    this.activeExecutions.set(executionKey, execution);
    this.executionLogs.set(executionKey, []);
    
    try {
      // Ensure worktree exists
      if (!fs.existsSync(worktreePath)) {
        return {
          success: false,
          error: `Worktree does not exist: ${worktreePath}`,
        };
      }
      
      // Run prechecks
      if (node.prechecks) {
        context.onProgress?.('Running prechecks');
        this.logInfo(executionKey, 'prechecks', `Running: ${node.prechecks}`);
        
        const precheckResult = await this.runCommand(
          node.prechecks,
          worktreePath,
          execution,
          executionKey,
          'prechecks'
        );
        
        if (!precheckResult.success) {
          return {
            success: false,
            error: `Prechecks failed: ${precheckResult.error}`,
          };
        }
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled' };
      }
      
      // Run main work
      if (node.work) {
        context.onProgress?.('Running work');
        
        if (node.work.startsWith('@agent')) {
          // Delegate to agent
          const agentResult = await this.runAgentWork(
            node,
            worktreePath,
            execution,
            executionKey
          );
          
          if (!agentResult.success) {
            return agentResult;
          }
        } else {
          // Run shell command
          this.logInfo(executionKey, 'work', `Running: ${node.work}`);
          
          const workResult = await this.runCommand(
            node.work,
            worktreePath,
            execution,
            executionKey,
            'work'
          );
          
          if (!workResult.success) {
            return {
              success: false,
              error: `Work failed: ${workResult.error}`,
            };
          }
        }
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled' };
      }
      
      // Run postchecks
      if (node.postchecks) {
        context.onProgress?.('Running postchecks');
        this.logInfo(executionKey, 'postchecks', `Running: ${node.postchecks}`);
        
        const postcheckResult = await this.runCommand(
          node.postchecks,
          worktreePath,
          execution,
          executionKey,
          'postchecks'
        );
        
        if (!postcheckResult.success) {
          return {
            success: false,
            error: `Postchecks failed: ${postcheckResult.error}`,
          };
        }
      }
      
      // Check if aborted
      if (execution.aborted) {
        return { success: false, error: 'Execution canceled' };
      }
      
      // Commit changes
      context.onProgress?.('Committing changes');
      const commitResult = await this.commitChanges(
        node,
        worktreePath,
        executionKey
      );
      
      if (!commitResult.success) {
        return {
          success: false,
          error: `Commit failed: ${commitResult.error}`,
        };
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
      };
      
    } catch (error: any) {
      log.error(`Execution error: ${node.name}`, { error: error.message });
      return {
        success: false,
        error: error.message,
      };
    } finally {
      this.activeExecutions.delete(executionKey);
    }
  }
  
  /**
   * Cancel an execution
   */
  cancel(dagId: string, nodeId: string): void {
    const executionKey = `${dagId}:${nodeId}`;
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
  getLogs(dagId: string, nodeId: string): LogEntry[] {
    const executionKey = `${dagId}:${nodeId}`;
    return this.executionLogs.get(executionKey) || [];
  }
  
  /**
   * Get logs for a specific phase
   */
  getLogsForPhase(dagId: string, nodeId: string, phase: ExecutionPhase): LogEntry[] {
    return this.getLogs(dagId, nodeId).filter(entry => entry.phase === phase);
  }
  
  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================
  
  /**
   * Run a shell command
   */
  private async runCommand(
    command: string,
    cwd: string,
    execution: ActiveExecution,
    executionKey: string,
    phase: ExecutionPhase
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      // Determine shell based on platform
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];
      
      const proc = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      execution.process = proc;
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        this.logOutput(executionKey, phase, 'stdout', text);
      });
      
      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        this.logOutput(executionKey, phase, 'stderr', text);
      });
      
      proc.on('close', (code) => {
        execution.process = undefined;
        
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
        execution.process = undefined;
        resolve({ success: false, error: err.message });
      });
    });
  }
  
  /**
   * Run @agent work
   */
  private async runAgentWork(
    node: JobNode,
    worktreePath: string,
    execution: ActiveExecution,
    executionKey: string
  ): Promise<JobExecutionResult> {
    if (!this.agentDelegator) {
      return {
        success: false,
        error: '@agent work requires an agent delegator to be configured',
      };
    }
    
    // Extract the task from "@agent <task>"
    const agentTask = node.work!.replace(/^@agent\s*/i, '').trim() || node.task;
    
    this.logInfo(executionKey, 'work', `Delegating to agent: ${agentTask}`);
    
    try {
      const result = await this.agentDelegator.delegate({
        task: agentTask,
        instructions: node.instructions,
        worktreePath,
      });
      
      if (result.success) {
        this.logInfo(executionKey, 'work', 'Agent completed successfully');
        return { success: true };
      } else {
        this.logError(executionKey, 'work', `Agent failed: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (error: any) {
      this.logError(executionKey, 'work', `Agent error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Commit changes in the worktree
   */
  private async commitChanges(
    node: JobNode,
    worktreePath: string,
    executionKey: string
  ): Promise<{ success: boolean; commit?: string; error?: string }> {
    try {
      // Check if there are changes to commit
      const hasChanges = await git.repository.hasUncommittedChanges(worktreePath);
      
      if (!hasChanges) {
        // No changes - get current HEAD
        const head = await git.worktrees.getHeadCommit(worktreePath);
        this.logInfo(executionKey, 'commit', 'No changes to commit');
        return { success: true, commit: head || undefined };
      }
      
      // Stage all changes
      await git.repository.stageAll(worktreePath);
      
      // Commit
      const message = `[DAG] ${node.task}`;
      await git.repository.commit(worktreePath, message);
      
      // Get the new commit SHA
      const commit = await git.worktrees.getHeadCommit(worktreePath);
      
      this.logInfo(executionKey, 'commit', `Committed: ${commit?.slice(0, 8)}`);
      
      return { success: true, commit: commit || undefined };
    } catch (error: any) {
      this.logError(executionKey, 'commit', `Commit error: ${error.message}`);
      return { success: false, error: error.message };
    }
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
          author: 'DAG Runner',
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
  
  private logOutput(
    executionKey: string,
    phase: ExecutionPhase,
    type: 'stdout' | 'stderr',
    message: string
  ): void {
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push({
        timestamp: Date.now(),
        phase,
        type,
        message,
      });
    }
  }
  
  private logInfo(executionKey: string, phase: ExecutionPhase, message: string): void {
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push({
        timestamp: Date.now(),
        phase,
        type: 'info',
        message,
      });
    }
  }
  
  private logError(executionKey: string, phase: ExecutionPhase, message: string): void {
    const logs = this.executionLogs.get(executionKey);
    if (logs) {
      logs.push({
        timestamp: Date.now(),
        phase,
        type: 'error',
        message,
      });
    }
  }
}
