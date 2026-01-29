/**
 * @fileoverview Job Execution Strategy - Adapts JobRunner to Scheduler pattern.
 * 
 * This strategy wraps the existing JobRunner execution logic to work with
 * the generic Scheduler interface. Rather than rewriting JobRunner, we
 * compose with it.
 * 
 * @module core/scheduler/jobStrategy
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ExecutionStrategy, WorkUnit, WorkUnitSpec, WorkUnitStatus } from './types';
import { Logger } from '../logger';
import type { Job, JobSpec } from '../job/types';

const log = Logger.for('jobs');

// ============================================================================
// JOB-SPECIFIC TYPES
// ============================================================================

/**
 * Job state extends WorkUnit with job-specific fields.
 */
export interface JobState extends WorkUnit {
  /** Job specification */
  spec: JobSpec;
  /** Current execution step */
  currentStep?: string;
  /** Log file path */
  logFile?: string;
  /** Process IDs for running processes */
  processIds?: number[];
}

// ============================================================================
// JOB EXECUTION STRATEGY
// ============================================================================

/**
 * Execution strategy for individual jobs.
 * 
 * Jobs are simple work units that:
 * - Have no dependencies (independent)
 * - Execute a CLI process directly
 * - Track step progression (prechecks → work → postchecks)
 */
export class JobExecutionStrategy implements ExecutionStrategy<JobSpec, JobState> {
  private ctx: vscode.ExtensionContext;
  private runningJobs = new Map<string, JobState>();
  private runningProcesses = new Map<string, Set<any>>();
  
  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
  }
  
  /**
   * Create initial state from a job specification.
   */
  createState(spec: JobSpec): JobState {
    const logDir = path.join(this.ctx.globalStorageUri.fsPath, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    return {
      id: spec.id || randomUUID(),
      status: 'queued',
      spec,
      logFile: path.join(logDir, `${spec.id}.log`),
      processIds: []
    };
  }
  
  /**
   * Get ready job IDs.
   * For jobs, if status is 'queued', the job itself is ready.
   */
  getReady(state: JobState, maxCount: number): string[] {
    if (state.status === 'queued' && maxCount > 0) {
      return [state.id];
    }
    return [];
  }
  
  /**
   * Execute a job.
   * This is where the actual CLI spawning happens.
   */
  async execute(id: string, state: JobState): Promise<void> {
    if (state.id !== id || state.status !== 'queued') {
      return;
    }
    
    log.info(`Starting job execution: ${id}`);
    state.status = 'running';
    state.startedAt = Date.now();
    this.runningJobs.set(id, state);
    
    // The actual execution logic would be implemented here
    // For now, this is a placeholder - the real implementation
    // would spawn the CLI process and track it
    
    // TODO: Implement actual CLI execution
    // This would involve:
    // 1. Setting up worktree
    // 2. Running prechecks
    // 3. Running work (copilot CLI)
    // 4. Running postchecks
    // 5. Handling commit/merge
  }
  
  /**
   * Update status of a running job.
   */
  updateStatus(state: JobState): void {
    // Check if processes are still running
    if (state.processIds && state.processIds.length > 0) {
      const stillRunning = state.processIds.filter(pid => this.isProcessRunning(pid));
      state.processIds = stillRunning;
      
      if (stillRunning.length === 0 && state.status === 'running') {
        // All processes completed - check final status
        // In real implementation, we'd check exit codes
        state.status = 'succeeded';
        state.endedAt = Date.now();
        this.runningJobs.delete(state.id);
      }
    }
  }
  
  /**
   * Handle retry of a job.
   */
  retry(id: string, state: JobState, context?: string): boolean {
    if (!['failed', 'canceled'].includes(state.status)) {
      return false;
    }
    
    log.info(`Retrying job: ${id}`);
    state.status = 'queued';
    state.startedAt = undefined;
    state.endedAt = undefined;
    state.currentStep = undefined;
    
    // If context provided, update work instructions
    if (context && state.spec.policy?.steps) {
      state.spec.policy.steps.work = context;
    }
    
    return true;
  }
  
  /**
   * Cancel a job.
   */
  cancel(id: string, state: JobState): void {
    log.info(`Canceling job: ${id}`);
    
    // Kill running processes
    const processes = this.runningProcesses.get(id);
    if (processes) {
      processes.forEach(proc => {
        try {
          proc.kill('SIGKILL');
        } catch (e) {
          log.error('Failed to kill process', { error: e });
        }
      });
      this.runningProcesses.delete(id);
    }
    
    // Kill by PID
    if (state.processIds && state.processIds.length > 0) {
      state.processIds.forEach(pid => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          // Process may have exited
        }
      });
      state.processIds = [];
    }
    
    this.runningJobs.delete(id);
  }
  
  /**
   * Clean up resources for a job.
   */
  async cleanup(id: string, state: JobState): Promise<void> {
    log.info(`Cleaning up job: ${id}`);
    
    // Delete log file
    if (state.logFile && fs.existsSync(state.logFile)) {
      try {
        fs.unlinkSync(state.logFile);
      } catch (e) {
        log.error('Failed to delete log file', { error: e });
      }
    }
    
    // Delete worktree if exists
    // This would use git module in real implementation
  }
  
  /**
   * Serialize state for persistence.
   */
  serialize(state: JobState): object {
    return {
      id: state.id,
      status: state.status,
      spec: state.spec,
      currentStep: state.currentStep,
      logFile: state.logFile,
      queuedAt: state.queuedAt,
      startedAt: state.startedAt,
      endedAt: state.endedAt
    };
  }
  
  /**
   * Deserialize state from persistence.
   */
  deserialize(data: object): JobState {
    const d = data as any;
    return {
      id: d.id,
      status: d.status as WorkUnitStatus,
      spec: d.spec,
      currentStep: d.currentStep,
      logFile: d.logFile,
      processIds: [],
      queuedAt: d.queuedAt,
      startedAt: d.startedAt,
      endedAt: d.endedAt
    };
  }
  
  // ---- Helper Methods ----
  
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
