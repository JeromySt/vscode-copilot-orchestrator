/**
 * @fileoverview Plan Runner
 * 
 * Main orchestrator for Plan execution. Combines:
 * - Plan building
 * - State machine management
 * - Scheduling
 * - Execution delegation
 * - Persistence
 * 
 * This is the primary interface for creating and running Plans.
 * 
 * @module plan/runner
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  PlanSpec,
  PlanInstance,
  PlanNode,
  JobNode,
  SubPlanNode,
  NodeStatus,
  PlanStatus,
  JobExecutionResult,
  ExecutionContext,
  NodeTransitionEvent,
  PlanCompletionEvent,
  WorkSummary,
  JobWorkSummary,
  LogEntry,
  ExecutionPhase,
  NodeExecutionState,
  nodePerformsWork,
  AttemptRecord,
  WorkSpec,
} from './types';
import { buildPlan, buildSingleJobPlan, PlanValidationError } from './builder';
import { PlanStateMachine } from './stateMachine';
import { PlanScheduler } from './scheduler';
import { PlanPersistence } from './persistence';
import { Logger } from '../core/logger';
import * as git from '../git';

const log = Logger.for('plan-runner');

/**
 * Events emitted by the Plan Runner
 */
export interface PlanRunnerEvents {
  'planCreated': (plan: PlanInstance) => void;
  'planStarted': (plan: PlanInstance) => void;
  'planCompleted': (plan: PlanInstance, status: PlanStatus) => void;
  'planDeleted': (planId: string) => void;
  'nodeTransition': (event: NodeTransitionEvent) => void;
  'nodeStarted': (planId: string, nodeId: string) => void;
  'nodeCompleted': (planId: string, nodeId: string, success: boolean) => void;
  'nodeRetry': (planId: string, nodeId: string) => void;
}

/**
 * Job executor interface - implemented separately for actual execution
 */
export interface JobExecutor {
  execute(context: ExecutionContext): Promise<JobExecutionResult>;
  cancel(planId: string, nodeId: string): void;
  getLogs?(planId: string, nodeId: string): LogEntry[];
  getLogsForPhase?(planId: string, nodeId: string, phase: ExecutionPhase): LogEntry[];
  log?(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void;
}

/**
 * Plan Runner configuration
 */
export interface PlanRunnerConfig {
  /** Storage path for persistence */
  storagePath: string;
  
  /** Default repository path */
  defaultRepoPath?: string;
  
  /** Global max parallel jobs */
  maxParallel?: number;
  
  /** Pump interval in ms */
  pumpInterval?: number;
}

/**
 * Options for retrying a failed node
 */
export interface RetryNodeOptions {
  /** New work spec to replace/augment original. Can be string, process, shell, or agent spec */
  newWork?: WorkSpec;
  /** Reset worktree to base commit (default: false) */
  clearWorktree?: boolean;
}

/**
 * Plan Runner - orchestrates Plan execution
 */
export class PlanRunner extends EventEmitter {
  private plans = new Map<string, PlanInstance>();
  private stateMachines = new Map<string, PlanStateMachine>();
  private scheduler: PlanScheduler;
  private persistence: PlanPersistence;
  private executor?: JobExecutor;
  private pumpTimer?: NodeJS.Timeout;
  private config: PlanRunnerConfig;
  private isRunning = false;
  
  constructor(config: PlanRunnerConfig) {
    super();
    this.config = config;
    this.scheduler = new PlanScheduler({
      globalMaxParallel: config.maxParallel || 8,
    });
    this.persistence = new PlanPersistence(config.storagePath);
  }
  
  /**
   * Set the job executor (injected dependency)
   */
  setExecutor(executor: JobExecutor): void {
    this.executor = executor;
  }
  
  /**
   * Log a message to the executor (helper for merge operations)
   */
  private execLog(planId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void {
    if (this.executor?.log) {
      this.executor.log(planId, nodeId, phase, type, message);
    }
  }
  
  /**
   * Initialize the runner - load persisted Plans and start pump
   */
  async initialize(): Promise<void> {
    log.info('Initializing Plan Runner');
    
    // Load persisted Plans
    const loadedPlans = this.persistence.loadAll();
    for (const plan of loadedPlans) {
      this.plans.set(plan.id, plan);
      const sm = new PlanStateMachine(plan);
      this.setupStateMachineListeners(sm);
      this.stateMachines.set(plan.id, sm);
    }
    
    log.info(`Loaded ${loadedPlans.length} Plans from persistence`);
    
    // Start the pump
    this.startPump();
    this.isRunning = true;
  }
  
  /**
   * Shutdown the runner - persist state and stop pump
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down Plan Runner');
    this.stopPump();
    
    // Persist all Plans
    for (const plan of this.plans.values()) {
      this.persistence.save(plan);
    }
    
    this.isRunning = false;
  }
  
  /**
   * Persist all Plans synchronously (for emergency shutdown)
   */
  persistSync(): void {
    for (const plan of this.plans.values()) {
      this.persistence.saveSync(plan);
    }
  }
  
  // ============================================================================
  // Plan CREATION
  // ============================================================================
  
  /**
   * Create and enqueue a Plan from a specification.
   * 
   * @param spec - The Plan specification
   * @returns The created Plan instance
   * @throws PlanValidationError if the spec is invalid
   */
  enqueue(spec: PlanSpec): PlanInstance {
    log.info(`Creating Plan: ${spec.name}`, {
      jobs: spec.jobs.length,
      subPlans: spec.subPlans?.length || 0,
    });
    
    // Build the Plan
    const plan = buildPlan(spec, {
      repoPath: spec.repoPath || this.config.defaultRepoPath,
    });
    
    // Store the Plan
    this.plans.set(plan.id, plan);
    
    // Create state machine
    const sm = new PlanStateMachine(plan);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(plan.id, sm);
    
    // Persist
    this.persistence.save(plan);
    
    // Emit event
    this.emit('planCreated', plan);
    
    log.info(`Plan created: ${plan.id}`, {
      name: spec.name,
      nodes: plan.nodes.size,
      roots: plan.roots.length,
      leaves: plan.leaves.length,
    });
    
    return plan;
  }
  
  /**
   * Create a simple single-job plan.
   * Convenience method for backwards compatibility with job-only workflows.
   */
  enqueueJob(jobSpec: {
    name: string;
    task: string;
    work?: string;
    prechecks?: string;
    postchecks?: string;
    instructions?: string;
    baseBranch?: string;
    targetBranch?: string;
  }): PlanInstance {
    const plan = buildSingleJobPlan(jobSpec, {
      repoPath: this.config.defaultRepoPath,
    });
    
    // Store and setup
    this.plans.set(plan.id, plan);
    const sm = new PlanStateMachine(plan);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(plan.id, sm);
    
    // Persist
    this.persistence.save(plan);
    
    // Emit event
    this.emit('planCreated', plan);
    
    log.info(`Single-job Plan created: ${plan.id}`, { name: jobSpec.name });
    
    return plan;
  }
  
  // ============================================================================
  // Plan QUERIES
  // ============================================================================
  
  /**
   * Get a Plan by ID
   */
  get(planId: string): PlanInstance | undefined {
    return this.plans.get(planId);
  }
  
  /**
   * Get all Plans
   */
  getAll(): PlanInstance[] {
    return Array.from(this.plans.values());
  }
  
  /**
   * Get Plans by status
   */
  getByStatus(status: PlanStatus): PlanInstance[] {
    return Array.from(this.plans.values()).filter(plan => {
      const sm = this.stateMachines.get(plan.id);
      return sm?.computePlanStatus() === status;
    });
  }
  
  /**
   * Get the state machine for a Plan
   */
  getStateMachine(planId: string): PlanStateMachine | undefined {
    return this.stateMachines.get(planId);
  }
  
  /**
   * Get Plan status with computed fields
   */
  getStatus(planId: string): {
    plan: PlanInstance;
    status: PlanStatus;
    counts: Record<NodeStatus, number>;
    progress: number;
  } | undefined {
    const plan = this.plans.get(planId);
    const sm = this.stateMachines.get(planId);
    if (!plan || !sm) return undefined;
    
    const counts = sm.getStatusCounts();
    const total = plan.nodes.size;
    const completed = counts.succeeded + counts.failed + counts.blocked + counts.canceled;
    const progress = total > 0 ? completed / total : 0;
    
    return {
      plan,
      status: sm.computePlanStatus(),
      counts,
      progress,
    };
  }
  
  /**
   * Get execution logs for a node
   */
  getNodeLogs(planId: string, nodeId: string, phase?: 'all' | ExecutionPhase): string {
    if (!this.executor) return 'No executor available.';
    
    // First try memory logs
    let logs: LogEntry[] = [];
    if (phase && phase !== 'all' && this.executor.getLogsForPhase) {
      logs = this.executor.getLogsForPhase(planId, nodeId, phase);
    } else if (this.executor.getLogs) {
      logs = this.executor.getLogs(planId, nodeId);
    }
    
    if (logs.length > 0) {
      return logs.map((entry: LogEntry) => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const prefix = entry.type === 'stderr' ? '[ERR]' : 
                       entry.type === 'error' ? '[ERROR]' :
                       entry.type === 'info' ? '[INFO]' : '';
        // For stdout, just show the raw output without prefix
        if (entry.type === 'stdout') {
          return entry.message;
        }
        return `[${time}] ${prefix} ${entry.message}`;
      }).join('\n');
    }
    
    // Try reading from log file
    if ('readLogsFromFile' in this.executor && typeof (this.executor as any).readLogsFromFile === 'function') {
      const fileContent = (this.executor as any).readLogsFromFile(planId, nodeId);
      if (fileContent && !fileContent.startsWith('No log file')) {
        // Filter by phase if requested
        if (phase && phase !== 'all') {
          const phaseMarker = `[${phase.toUpperCase()}]`;
          const lines = fileContent.split('\n').filter((line: string) => line.includes(phaseMarker));
          return lines.length > 0 ? lines.join('\n') : `No logs for ${phase} phase.`;
        }
        return fileContent;
      }
    }
    
    return 'No logs available.';
  }
  
  /**
   * Get details for a specific attempt
   */
  getNodeAttempt(planId: string, nodeId: string, attemptNumber: number): AttemptRecord | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    
    const state = plan.nodeStates.get(nodeId);
    if (!state || !state.attemptHistory) return null;
    
    return state.attemptHistory.find(a => a.attemptNumber === attemptNumber) || null;
  }
  
  /**
   * Get all attempts for a node
   */
  getNodeAttempts(planId: string, nodeId: string): AttemptRecord[] {
    const plan = this.plans.get(planId);
    if (!plan) return [];
    
    const state = plan.nodeStates.get(nodeId);
    return state?.attemptHistory || [];
  }
  
  /**
   * Get process stats for a running node
   */
  async getProcessStats(planId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: any[];
    duration: number | null;
  }> {
    if (!this.executor) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    
    if ('getProcessStats' in this.executor && typeof (this.executor as any).getProcessStats === 'function') {
      return (this.executor as any).getProcessStats(planId, nodeId);
    }
    
    return { pid: null, running: false, tree: [], duration: null };
  }
  
  /**
   * Get process stats for all running nodes in a Plan (including sub-plans).
   * Returns a hierarchical structure: Plan → Jobs → Processes
   * Uses batch method for efficiency - single process snapshot for all nodes.
   */
  async getAllProcessStats(planId: string): Promise<{
    flat: Array<{
      nodeId: string;
      nodeName: string;
      planId?: string;
      planName?: string;
      pid: number | null;
      running: boolean;
      tree: any[];
      duration: number | null;
    }>;
    hierarchy: Array<{
      planId: string;
      planName: string;
      status: string;
      jobs: Array<{
        nodeId: string;
        nodeName: string;
        status: string;
        pid: number | null;
        running: boolean;
        tree: any[];
        duration: number | null;
      }>;
      children: any[]; // Nested sub-plans
    }>;
  }> {
    const plan = this.plans.get(planId);
    if (!plan || !this.executor) return { flat: [], hierarchy: [] };
    
    // Collect all running/scheduled job node keys for batch process fetch
    const nodeKeys: Array<{ planId: string; nodeId: string; nodeName: string; planName?: string }> = [];
    
    // Build hierarchical structure recursively
    const buildHierarchy = (d: PlanInstance, parentPath?: string): any => {
      const sm = this.stateMachines.get(d.id);
      const planStatus = sm?.computePlanStatus() || 'pending';
      
      const planPath = parentPath ? `${parentPath} → ${d.spec.name}` : d.spec.name;
      
      const jobs: any[] = [];
      const children: any[] = [];
      
      for (const [nodeId, state] of d.nodeStates) {
        const node = d.nodes.get(nodeId);
        if (!node) continue;
        
        // For job nodes that are running/scheduled
        if (node.type === 'job' && (state.status === 'running' || state.status === 'scheduled')) {
          nodeKeys.push({
            planId: d.id,
            nodeId,
            nodeName: node.name || nodeId.slice(0, 8),
            planName: parentPath ? planPath : undefined
          });
          
          jobs.push({
            nodeId,
            nodeName: node.name || nodeId.slice(0, 8),
            status: state.status,
            pid: null, // Will be filled after batch fetch
            running: false,
            tree: [],
            duration: null
          });
        }
        
        // For subPlan nodes, recurse into child Plan
        if (node.type === 'subPlan' && state.childPlanId) {
          const childPlan = this.plans.get(state.childPlanId);
          if (childPlan) {
            const childHierarchy = buildHierarchy(childPlan, planPath);
            if (childHierarchy) {
              children.push(childHierarchy);
            }
          }
        }
      }
      
      // Return if there are jobs or active children (don't skip parent just because it has no running jobs)
      if (jobs.length === 0 && children.length === 0) {
        return null;
      }
      
      return {
        planId: d.id,
        planName: d.spec.name,
        parentPath: parentPath, // Include parent path for context
        status: planStatus,
        jobs,
        children
      };
    };
    
    // Build hierarchy starting from root Plan (but only include sub-plans in the output)
    const rootHierarchy: any[] = [];
    
    // For root Plan, collect jobs directly (not wrapped in a sub-plan node)
    const rootJobs: any[] = [];
    for (const [nodeId, state] of plan.nodeStates) {
      const node = plan.nodes.get(nodeId);
      if (!node) continue;
      
      if (node.type === 'job' && (state.status === 'running' || state.status === 'scheduled')) {
        nodeKeys.push({
          planId: plan.id,
          nodeId,
          nodeName: node.name || nodeId.slice(0, 8),
          planName: undefined
        });
        
        rootJobs.push({
          nodeId,
          nodeName: node.name || nodeId.slice(0, 8),
          status: state.status,
          pid: null,
          running: false,
          tree: [],
          duration: null
        });
      }
      
      // For subPlan nodes, recurse
      if (node.type === 'subPlan' && state.childPlanId) {
        const childPlan = this.plans.get(state.childPlanId);
        if (childPlan) {
          const childHierarchy = buildHierarchy(childPlan, undefined);
          if (childHierarchy) {
            rootHierarchy.push(childHierarchy);
          }
        }
      }
    }
    
    // Fetch process stats in batch
    let processStats: Map<string, any> = new Map();
    if (nodeKeys.length > 0 && 'getAllProcessStats' in this.executor) {
      try {
        const stats = await (this.executor as any).getAllProcessStats(nodeKeys);
        for (let i = 0; i < stats.length; i++) {
          const key = `${nodeKeys[i].planId}:${nodeKeys[i].nodeId}`;
          processStats.set(key, stats[i]);
        }
      } catch {
        // Fallback: individual fetches
      }
    }
    
    // Fill in process stats for root jobs
    for (const job of rootJobs) {
      const key = `${plan.id}:${job.nodeId}`;
      const stats = processStats.get(key);
      if (stats) {
        job.pid = stats.pid;
        job.running = stats.running;
        job.tree = stats.tree;
        job.duration = stats.duration;
      }
    }
    
    // Fill in process stats for hierarchy (recursive)
    const fillStats = (h: any) => {
      for (const job of h.jobs) {
        const key = `${h.planId}:${job.nodeId}`;
        const stats = processStats.get(key);
        if (stats) {
          job.pid = stats.pid;
          job.running = stats.running;
          job.tree = stats.tree;
          job.duration = stats.duration;
        }
      }
      for (const child of h.children) {
        fillStats(child);
      }
    };
    
    for (const h of rootHierarchy) {
      fillStats(h);
    }
    
    // Build flat list for backwards compatibility
    const flat: any[] = [];
    for (const job of rootJobs) {
      if (job.running || job.pid) {
        flat.push({
          nodeId: job.nodeId,
          nodeName: job.nodeName,
          planId: plan.id,
          planName: undefined,
          pid: job.pid,
          running: job.running,
          tree: job.tree,
          duration: job.duration
        });
      }
    }
    
    const collectFlat = (h: any, path?: string) => {
      const planPath = path ? `${path} → ${h.planName}` : h.planName;
      for (const job of h.jobs) {
        if (job.running || job.pid) {
          flat.push({
            nodeId: job.nodeId,
            nodeName: job.nodeName,
            planId: h.planId,
            planName: planPath,
            pid: job.pid,
            running: job.running,
            tree: job.tree,
            duration: job.duration
          });
        }
      }
      for (const child of h.children) {
        collectFlat(child, planPath);
      }
    };
    
    for (const h of rootHierarchy) {
      collectFlat(h);
    }
    
    return {
      flat,
      hierarchy: rootHierarchy,
      // Include root jobs separately for display
      rootJobs
    } as any;
  }
  
  // ============================================================================
  // Plan CONTROL
  // ============================================================================
  
  /**
   * Cancel a Plan
   */
  cancel(planId: string): boolean {
    const plan = this.plans.get(planId);
    const sm = this.stateMachines.get(planId);
    if (!plan || !sm) return false;
    
    log.info(`Canceling Plan: ${planId}`);
    
    // Cancel all running jobs in executor
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'running' || state.status === 'scheduled') {
        this.executor?.cancel(planId, nodeId);
      }
    }
    
    // Cancel all non-terminal nodes
    sm.cancelAll();
    
    // Persist
    this.persistence.save(plan);
    
    return true;
  }
  
  /**
   * Delete a Plan
   */
  delete(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;
    
    log.info(`Deleting Plan: ${planId}`);
    
    // First, recursively delete any child sub-plans
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.childPlanId) {
        log.debug(`Deleting child plan: ${state.childPlanId}`);
        this.delete(state.childPlanId);
      }
    }
    
    // Cancel if running
    this.cancel(planId);
    
    // Clean up worktrees and branches in background
    this.cleanupPlanResources(plan).catch(err => {
      log.error(`Failed to cleanup Plan resources`, { planId, error: err.message });
    });
    
    // Remove from memory
    this.plans.delete(planId);
    this.stateMachines.delete(planId);
    
    // Remove from persistence
    this.persistence.delete(planId);
    
    // Notify listeners
    this.emit('planDeleted', planId);
    
    return true;
  }
  
  /**
   * Clean up all resources associated with a Plan (worktrees, logs)
   * 
   * NOTE: With detached HEAD worktrees, there are no branches to clean up.
   * We only remove worktrees and log files.
   */
  private async cleanupPlanResources(plan: PlanInstance): Promise<void> {
    const repoPath = plan.repoPath;
    const cleanupErrors: string[] = [];
    
    // Collect all worktree paths from node states
    const worktreePaths: string[] = [];
    
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.worktreePath) {
        worktreePaths.push(state.worktreePath);
      }
    }
    
    log.info(`Cleaning up Plan resources`, {
      planId: plan.id,
      worktrees: worktreePaths.length,
    });
    
    // Remove worktrees (detached HEAD - no branches to clean up)
    for (const worktreePath of worktreePaths) {
      try {
        await git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
        log.debug(`Removed worktree: ${worktreePath}`);
      } catch (error: any) {
        cleanupErrors.push(`worktree ${worktreePath}: ${error.message}`);
      }
    }
    
    // Try to clean up the worktree root directory if it exists and is empty
    if (plan.worktreeRoot) {
      try {
        const fs = require('fs');
        const entries = fs.readdirSync(plan.worktreeRoot);
        if (entries.length === 0) {
          fs.rmdirSync(plan.worktreeRoot);
          log.debug(`Removed empty worktree root: ${plan.worktreeRoot}`);
        }
      } catch (error: any) {
        // Directory might not exist or not be empty - that's fine
      }
    }
    
    // Clean up log files
    if (this.executor) {
      try {
        const fs = require('fs');
        const path = require('path');
        const storagePath = (this.executor as any).storagePath;
        if (storagePath) {
          const planLogsDir = path.join(storagePath, plan.id);
          if (fs.existsSync(planLogsDir)) {
            fs.rmSync(planLogsDir, { recursive: true, force: true });
            log.debug(`Removed log directory: ${planLogsDir}`);
          }
        }
      } catch (error: any) {
        cleanupErrors.push(`logs: ${error.message}`);
      }
    }
    
    if (cleanupErrors.length > 0) {
      log.warn(`Some cleanup operations failed`, { errors: cleanupErrors });
    } else {
      log.info(`Plan cleanup completed successfully`, { planId: plan.id });
    }
  }
  
  /**
   * Resume a Plan that may have been paused or completed with failures.
   * This ensures the pump is running to process any ready nodes.
   */
  resume(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;
    
    log.info(`Resuming Plan: ${planId}`);
    
    // Ensure pump is running
    this.startPump();
    
    // Persist the current state
    this.persistence.save(plan);
    
    return true;
  }
  
  /**
   * Get a Plan by ID (for external access)
   */
  getPlan(planId: string): PlanInstance | undefined {
    return this.plans.get(planId);
  }
  
  // ============================================================================
  // PUMP LOOP
  // ============================================================================
  
  /**
   * Start the pump loop
   */
  private startPump(): void {
    if (this.pumpTimer) return;
    
    const interval = this.config.pumpInterval || 1000;
    this.pumpTimer = setInterval(() => this.pump(), interval);
    log.debug('Pump started', { interval });
  }
  
  /**
   * Stop the pump loop
   */
  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
      log.debug('Pump stopped');
    }
  }
  
  /**
   * Main pump loop - called periodically to advance Plan execution
   */
  private async pump(): Promise<void> {
    if (!this.executor) {
      return; // Can't do anything without an executor
    }
    
    // Count total running jobs across all Plans (only count actual job nodes, not sub-plan coordination nodes)
    let globalRunning = 0;
    let globalsubPlansRunning = 0;
    for (const [planId, plan] of this.plans) {
      const sm = this.stateMachines.get(planId);
      if (!sm) continue;
      
      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'running' || state.status === 'scheduled') {
          const node = plan.nodes.get(nodeId);
          if (node && nodePerformsWork(node)) {
            globalRunning++;
          } else {
            globalsubPlansRunning++;
          }
        }
      }
    }
    
    // Log overall status periodically (only if there are active Plans)
    const totalPlans = this.plans.size;
    if (totalPlans > 0) {
      log.debug(`Pump: ${totalPlans} Plans, ${globalRunning} jobs running, ${globalsubPlansRunning} sub-plans coordinating`);
    }
    
    // Process each Plan
    for (const [planId, plan] of this.plans) {
      const sm = this.stateMachines.get(planId);
      if (!sm) continue;
      
      const status = sm.computePlanStatus();
      
      // Skip completed Plans
      if (status !== 'pending' && status !== 'running') {
        continue;
      }
      
      // Mark Plan as started if not already
      if (!plan.startedAt && status === 'running') {
        plan.startedAt = Date.now();
        this.emit('planStarted', plan);
      }
      
      // Get nodes to schedule - pass only actual job running count (sub-plans don't consume job slots)
      const nodesToSchedule = this.scheduler.selectNodes(plan, sm, globalRunning);
      
      // Log if there are ready nodes but none scheduled (potential bottleneck)
      const readyNodes = sm.getReadyNodes();
      if (readyNodes.length > 0 && nodesToSchedule.length === 0) {
        const counts = sm.getStatusCounts();
        log.debug(`Plan ${plan.spec.name} (${planId.slice(0, 8)}): ${readyNodes.length} ready but 0 scheduled`, {
          globalRunning,
          planRunning: counts.running + counts.scheduled,
          planMaxParallel: plan.maxParallel,
        });
      }
      
      // Schedule each node
      for (const nodeId of nodesToSchedule) {
        const node = plan.nodes.get(nodeId);
        if (!node) continue;
        
        // Mark as scheduled
        sm.transition(nodeId, 'scheduled');
        
        // Only count nodes with work against global limit (sub-plans are coordination nodes)
        if (nodePerformsWork(node)) {
          globalRunning++;
        } else {
          globalsubPlansRunning++;
        }
        
        // Execute based on node type
        if (node.type === 'job') {
          this.executeJobNode(plan, sm, node as JobNode);
        } else if (node.type === 'subPlan') {
          this.executeSubPlanNode(plan, sm, node as SubPlanNode);
        }
      }
      
      // Persist after scheduling
      if (nodesToSchedule.length > 0) {
        this.persistence.save(plan);
      }
    }
  }
  
  /**
   * Execute a job node
   */
  private async executeJobNode(
    plan: PlanInstance,
    sm: PlanStateMachine,
    node: JobNode
  ): Promise<void> {
    const nodeState = plan.nodeStates.get(node.id);
    if (!nodeState) return;
    
    log.info(`Executing job node: ${node.name}`, {
      planId: plan.id,
      nodeId: node.id,
    });
    
    try {
      // Transition to running
      sm.transition(node.id, 'running');
      nodeState.attempts++;
      this.emit('nodeStarted', plan.id, node.id);
      
      // Determine base commits from dependencies (RI/FI model)
      // First commit is the base, additional commits are merged in
      const baseCommits = sm.getBaseCommitsForNode(node.id);
      const baseCommitish = baseCommits.length > 0 ? baseCommits[0] : plan.baseBranch;
      const additionalSources = baseCommits.slice(1);
      
      // Create worktree path (use path.join for cross-platform compatibility)
      const worktreePath = path.join(plan.worktreeRoot, node.producerId);
      
      // Store in state (no branchName since we use detached HEAD)
      nodeState.worktreePath = worktreePath;
      
      // Setup detached worktree (or reuse existing one for retries)
      log.debug(`Setting up worktree for job ${node.name} at ${worktreePath} from ${baseCommitish}`);
      const timing = await git.worktrees.createOrReuseDetached(
        plan.repoPath,
        worktreePath,
        baseCommitish,
        s => log.debug(s)
      );
      
      if (timing.reused) {
        log.info(`Reusing existing worktree for ${node.name} (retry)`);
        // On retry, preserve the original base commit for validation
        // Don't overwrite with current HEAD which includes prior work
        // But if baseCommit is somehow missing, fall back to timing.baseCommit
        if (!nodeState.baseCommit) {
          nodeState.baseCommit = timing.baseCommit;
        }
      } else {
        // Only set baseCommit on fresh worktree creation
        nodeState.baseCommit = timing.baseCommit;
        if (timing.totalMs > 500) {
          log.warn(`Slow worktree creation for ${node.name} took ${timing.totalMs}ms`);
        }
      }
      
      // If job has multiple dependencies, merge the additional commits into the worktree (Forward Integration)
      if (additionalSources.length > 0) {
        log.info(`Merging ${additionalSources.length} additional source commits for job ${node.name}`);
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE START ==========');
        this.execLog(plan.id, node.id, 'merge-fi', 'info', `Merging ${additionalSources.length} source commit(s) into worktree`);
        
        const mergeSuccess = await this.mergeSourcesIntoWorktree(plan, node, worktreePath, additionalSources);
        
        if (!mergeSuccess) {
          this.execLog(plan.id, node.id, 'merge-fi', 'error', 'Forward integration merge FAILED');
          this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE END ==========');
          nodeState.error = 'Failed to merge sources from dependencies';
          sm.transition(node.id, 'failed');
          this.emit('nodeCompleted', plan.id, node.id, false);
          return;
        }
        
        this.execLog(plan.id, node.id, 'merge-fi', 'info', 'Forward integration merge succeeded');
        this.execLog(plan.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE END ==========');
      }
      
      // Build execution context
      // Use nodeState.baseCommit which is preserved across retries
      const context: ExecutionContext = {
        plan,
        node,
        baseCommit: nodeState.baseCommit!,
        worktreePath,
        copilotSessionId: nodeState.copilotSessionId, // Pass existing session for resumption
        onProgress: (step) => {
          log.debug(`Job progress: ${node.name} - ${step}`);
        },
      };
      
      // Execute
      const result = await this.executor!.execute(context);
      
      // Store step statuses for UI display
      if (result.stepStatuses) {
        nodeState.stepStatuses = result.stepStatuses;
      }
      
      // Store captured Copilot session ID for future resumption
      if (result.copilotSessionId) {
        nodeState.copilotSessionId = result.copilotSessionId;
      }
      
      if (result.success) {
        // Store completed commit
        if (result.completedCommit) {
          nodeState.completedCommit = result.completedCommit;
        }
        
        // Store work summary on node state and aggregate to Plan
        if (result.workSummary) {
          nodeState.workSummary = result.workSummary;
          this.appendWorkSummary(plan, result.workSummary);
        }
        
        // Handle leaf node merge to target branch (Reverse Integration)
        const isLeaf = plan.leaves.includes(node.id);
        log.debug(`Merge check: node=${node.name}, isLeaf=${isLeaf}, targetBranch=${plan.targetBranch}, completedCommit=${nodeState.completedCommit?.slice(0, 8)}`);
        
        if (isLeaf && plan.targetBranch && nodeState.completedCommit) {
          log.info(`Initiating merge to target: ${node.name} -> ${plan.targetBranch}`);
          this.execLog(plan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE START ==========');
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `Merging completed commit ${nodeState.completedCommit.slice(0, 8)} to ${plan.targetBranch}`);
          
          const mergeSuccess = await this.mergeLeafToTarget(plan, node, nodeState.completedCommit);
          nodeState.mergedToTarget = mergeSuccess;
          
          if (mergeSuccess) {
            this.execLog(plan.id, node.id, 'merge-ri', 'info', `Reverse integration merge succeeded`);
          } else {
            this.execLog(plan.id, node.id, 'merge-ri', 'error', `Reverse integration merge FAILED - worktree preserved for manual retry`);
            log.warn(`Leaf ${node.name} succeeded but merge to ${plan.targetBranch} failed - worktree preserved for manual retry`);
          }
          this.execLog(plan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE END ==========');
          
          log.info(`Merge result: ${mergeSuccess ? 'success' : 'failed'}`, { mergedToTarget: nodeState.mergedToTarget });
        } else if (isLeaf) {
          log.debug(`Skipping merge: isLeaf=${isLeaf}, hasTargetBranch=${!!plan.targetBranch}, hasCompletedCommit=${!!nodeState.completedCommit}`);
        }
        
        // Record successful attempt in history
        const successAttempt: AttemptRecord = {
          attemptNumber: nodeState.attempts,
          status: 'succeeded',
          startedAt: nodeState.startedAt || Date.now(),
          endedAt: Date.now(),
          copilotSessionId: nodeState.copilotSessionId,
          stepStatuses: nodeState.stepStatuses,
          worktreePath: nodeState.worktreePath,
          baseCommit: nodeState.baseCommit,
          logs: this.getNodeLogs(plan.id, node.id),
          workUsed: node.work,
        };
        nodeState.attemptHistory = [...(nodeState.attemptHistory || []), successAttempt];
        
        sm.transition(node.id, 'succeeded');
        this.emit('nodeCompleted', plan.id, node.id, true);
        
        // Try to cleanup eligible worktrees (this node and any ancestors that are now safe)
        if (plan.cleanUpSuccessfulWork) {
          await this.cleanupEligibleWorktrees(plan, sm);
        }
        
        log.info(`Job succeeded: ${node.name}`, {
          planId: plan.id,
          nodeId: node.id,
          commit: nodeState.completedCommit?.slice(0, 8),
        });
      } else {
        nodeState.error = result.error;
        
        // Store lastAttempt for retry context
        nodeState.lastAttempt = {
          phase: result.failedPhase || 'work',
          startTime: nodeState.startedAt || Date.now(),
          endTime: Date.now(),
          error: result.error,
          exitCode: result.exitCode,
        };
        
        // Record failed attempt in history
        const failedAttempt: AttemptRecord = {
          attemptNumber: nodeState.attempts,
          status: 'failed',
          startedAt: nodeState.startedAt || Date.now(),
          endedAt: Date.now(),
          failedPhase: result.failedPhase || 'work',
          error: result.error,
          exitCode: result.exitCode,
          copilotSessionId: nodeState.copilotSessionId,
          stepStatuses: nodeState.stepStatuses,
          worktreePath: nodeState.worktreePath,
          baseCommit: nodeState.baseCommit,
          logs: this.getNodeLogs(plan.id, node.id),
          workUsed: node.work,
        };
        nodeState.attemptHistory = [...(nodeState.attemptHistory || []), failedAttempt];
        
        sm.transition(node.id, 'failed');
        this.emit('nodeCompleted', plan.id, node.id, false);
        
        log.error(`Job failed: ${node.name}`, {
          planId: plan.id,
          nodeId: node.id,
          error: result.error,
          failedPhase: result.failedPhase,
        });
      }
    } catch (error: any) {
      nodeState.error = error.message;
      
      // Store lastAttempt for retry context
      nodeState.lastAttempt = {
        phase: 'work',
        startTime: nodeState.startedAt || Date.now(),
        endTime: Date.now(),
        error: error.message,
      };
      
      // Record failed attempt in history
      const errorAttempt: AttemptRecord = {
        attemptNumber: nodeState.attempts,
        status: 'failed',
        startedAt: nodeState.startedAt || Date.now(),
        endedAt: Date.now(),
        failedPhase: 'work',
        error: error.message,
        copilotSessionId: nodeState.copilotSessionId,
        stepStatuses: nodeState.stepStatuses,
        worktreePath: nodeState.worktreePath,
        baseCommit: nodeState.baseCommit,
        logs: this.getNodeLogs(plan.id, node.id),
        workUsed: node.work,
      };
      nodeState.attemptHistory = [...(nodeState.attemptHistory || []), errorAttempt];
      
      sm.transition(node.id, 'failed');
      this.emit('nodeCompleted', plan.id, node.id, false);
      
      log.error(`Job execution error: ${node.name}`, {
        planId: plan.id,
        nodeId: node.id,
        error: error.message,
      });
    }
    
    // Persist after execution
    this.persistence.save(plan);
  }
  
  /**
   * Execute a sub-plan node
   */
  private async executeSubPlanNode(
    parentPlan: PlanInstance,
    sm: PlanStateMachine,
    node: SubPlanNode
  ): Promise<void> {
    log.info(`Executing sub-plan node: ${node.name}`, {
      planId: parentPlan.id,
      nodeId: node.id,
    });
    
    try {
      // Transition to running
      sm.transition(node.id, 'running');
      this.emit('nodeStarted', parentPlan.id, node.id);
      
      // Determine base branch for sub-plan (from parent's dependencies)
      const baseCommit = sm.getBaseCommitForNode(node.id);
      
      // Build the child Plan
      const childSpec = {
        ...node.childSpec,
        baseBranch: baseCommit || parentPlan.baseBranch,
        repoPath: parentPlan.repoPath,
      };
      
      const childPlan = buildPlan(childSpec, {
        parentPlanId: parentPlan.id,
        parentNodeId: node.id,
        repoPath: parentPlan.repoPath,
        worktreeRoot: `${parentPlan.worktreeRoot}/${node.producerId}`,
      });
      
      // Store child Plan reference
      node.childPlanId = childPlan.id;
      const nodeState = parentPlan.nodeStates.get(node.id);
      if (nodeState) {
        nodeState.childPlanId = childPlan.id;
      }
      
      // Register the child Plan
      this.plans.set(childPlan.id, childPlan);
      const childSm = new PlanStateMachine(childPlan);
      this.setupStateMachineListeners(childSm);
      this.stateMachines.set(childPlan.id, childSm);
      
      // Listen for child completion
      childSm.on('planComplete', (event: PlanCompletionEvent) => {
        this.handlechildPlanComplete(parentPlan, sm, node, event).catch(err => {
          log.error(`Error in child Plan completion handler: ${err.message}`);
        });
      });
      
      // Persist both
      this.persistence.save(parentPlan);
      this.persistence.save(childPlan);
      
      log.info(`sub-plan created: ${childPlan.id}`, {
        parentPlanId: parentPlan.id,
        parentNodeId: node.id,
        childNodes: childPlan.nodes.size,
      });
      
    } catch (error: any) {
      const nodeState = parentPlan.nodeStates.get(node.id);
      if (nodeState) {
        nodeState.error = error.message;
      }
      sm.transition(node.id, 'failed');
      this.emit('nodeCompleted', parentPlan.id, node.id, false);
      
      log.error(`sub-plan creation failed: ${node.name}`, {
        planId: parentPlan.id,
        nodeId: node.id,
        error: error.message,
      });
      
      this.persistence.save(parentPlan);
    }
  }
  
  /**
   * Handle child Plan completion
   */
  private async handlechildPlanComplete(
    parentPlan: PlanInstance,
    parentSm: PlanStateMachine,
    node: SubPlanNode,
    event: PlanCompletionEvent
  ): Promise<void> {
    log.info(`Child Plan completed: ${event.planId}`, {
      parentPlanId: parentPlan.id,
      parentNodeId: node.id,
      status: event.status,
    });
    
    const nodeState = parentPlan.nodeStates.get(node.id);
    const childPlan = this.plans.get(event.planId);
    
    // Log child Plan completion details to the parent's subPlan node
    this.execLog(parentPlan.id, node.id, 'work', 'info', '========== sub-plan EXECUTION COMPLETE ==========');
    this.execLog(parentPlan.id, node.id, 'work', 'info', `child Plan: ${event.planId}`);
    this.execLog(parentPlan.id, node.id, 'work', 'info', `Status: ${event.status.toUpperCase()}`);
    
    if (childPlan) {
      // Log summary of child Plan jobs
      const jobCount = childPlan.nodes.size;
      let succeeded = 0, failed = 0, blocked = 0;
      
      for (const [nodeId, childState] of childPlan.nodeStates) {
        const childNode = childPlan.nodes.get(nodeId);
        if (childState.status === 'succeeded') succeeded++;
        else if (childState.status === 'failed') failed++;
        else if (childState.status === 'blocked') blocked++;
        
        // Log each job's status
        const statusIcon = childState.status === 'succeeded' ? '✓' : 
                          childState.status === 'failed' ? '✗' : 
                          childState.status === 'blocked' ? '⊘' : '?';
        this.execLog(parentPlan.id, node.id, 'work', 'info', 
          `  ${statusIcon} ${childNode?.name || nodeId}: ${childState.status}`);
        
        if (childState.error) {
          this.execLog(parentPlan.id, node.id, 'work', 'error', `    Error: ${childState.error}`);
        }
        if (childState.completedCommit) {
          this.execLog(parentPlan.id, node.id, 'work', 'info', `    Commit: ${childState.completedCommit.slice(0, 8)}`);
        }
      }
      
      this.execLog(parentPlan.id, node.id, 'work', 'info', '');
      this.execLog(parentPlan.id, node.id, 'work', 'info', `Summary: ${succeeded}/${jobCount} succeeded, ${failed} failed, ${blocked} blocked`);
      
      // Log work summary if available
      if (childPlan.workSummary) {
        const ws = childPlan.workSummary;
        this.execLog(parentPlan.id, node.id, 'work', 'info', 
          `Work: ${ws.totalCommits} commits, +${ws.totalFilesAdded} ~${ws.totalFilesModified} -${ws.totalFilesDeleted} files`);
      }
    }
    
    this.execLog(parentPlan.id, node.id, 'work', 'info', '========== sub-plan EXECUTION COMPLETE ==========');
    
    if (event.status === 'succeeded') {
      // Get the final commit from the child Plan's leaf nodes
      if (childPlan && nodeState) {
        // Find a completed commit from leaf nodes
        for (const leafId of childPlan.leaves) {
          const leafState = childPlan.nodeStates.get(leafId);
          if (leafState?.completedCommit) {
            nodeState.completedCommit = leafState.completedCommit;
            break;
          }
        }
        
        // Handle leaf node merge to target branch (Reverse Integration) for sub-plan nodes
        const isLeaf = parentPlan.leaves.includes(node.id);
        log.debug(`sub-plan merge check: node=${node.name}, isLeaf=${isLeaf}, targetBranch=${parentPlan.targetBranch}, completedCommit=${nodeState.completedCommit?.slice(0, 8)}`);
        
        if (isLeaf && parentPlan.targetBranch && nodeState.completedCommit) {
          log.info(`Initiating merge to target for sub-plan: ${node.name} -> ${parentPlan.targetBranch}`);
          this.execLog(parentPlan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE START ==========');
          this.execLog(parentPlan.id, node.id, 'merge-ri', 'info', `Merging sub-plan completed commit ${nodeState.completedCommit.slice(0, 8)} to ${parentPlan.targetBranch}`);
          
          const mergeSuccess = await this.mergeLeafToTarget(parentPlan, node, nodeState.completedCommit);
          nodeState.mergedToTarget = mergeSuccess;
          
          if (mergeSuccess) {
            this.execLog(parentPlan.id, node.id, 'merge-ri', 'info', `Reverse integration merge succeeded`);
          } else {
            this.execLog(parentPlan.id, node.id, 'merge-ri', 'error', `Reverse integration merge FAILED`);
            log.warn(`sub-plan leaf ${node.name} succeeded but merge to ${parentPlan.targetBranch} failed`);
          }
          this.execLog(parentPlan.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE END ==========');
          
          log.info(`sub-plan merge result: ${mergeSuccess ? 'success' : 'failed'}`, { mergedToTarget: nodeState.mergedToTarget });
        }
      }
      
      parentSm.transition(node.id, 'succeeded');
      this.emit('nodeCompleted', parentPlan.id, node.id, true);
    } else {
      if (nodeState) {
        nodeState.error = `Child Plan ${event.status}`;
      }
      parentSm.transition(node.id, 'failed');
      this.emit('nodeCompleted', parentPlan.id, node.id, false);
    }
    
    this.persistence.save(parentPlan);
  }
  
  // ============================================================================
  // GIT OPERATIONS
  // ============================================================================
  
  /**
   * Merge a leaf node's commit to target branch using a temp worktree.
   * 
   * Uses the same model as planRunner/jobRunner:
   * - Create a temp detached worktree on the target branch
   * - Checkout the target branch
   * - Squash merge the source commit
   * - Commit and optionally push
   * - Clean up the temp worktree
   * 
   * @returns true if merge succeeded, false if it failed
   */
  private async mergeLeafToTarget(
    plan: PlanInstance,
    node: PlanNode,
    completedCommit: string
  ): Promise<boolean> {
    if (!plan.targetBranch) return true; // No target = nothing to merge = success
    
    log.info(`Merging leaf to target: ${node.name} -> ${plan.targetBranch}`, {
      commit: completedCommit.slice(0, 8),
    });
    
    const repoPath = plan.repoPath;
    const targetBranch = plan.targetBranch;
    
    try {
      // =========================================================================
      // FAST PATH: Use git merge-tree (no checkout needed, no worktree conflicts)
      // =========================================================================
      this.execLog(plan.id, node.id, 'merge-ri', 'info', `Using git merge-tree for conflict-free merge...`);
      
      const mergeTreeResult = await git.merge.mergeWithoutCheckout({
        source: completedCommit,
        target: targetBranch,
        repoPath,
        log: s => {
          log.debug(s);
          this.execLog(plan.id, node.id, 'merge-ri', 'stdout', s);
        }
      });
      
      if (mergeTreeResult.success && mergeTreeResult.treeSha) {
        log.info(`Fast path: conflict-free merge via merge-tree`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `✓ No conflicts detected`);
        
        // Create the merge commit from the tree
        const targetSha = await git.repository.resolveRef(targetBranch, repoPath);
        const commitMessage = `Plan ${plan.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`;
        
        const newCommit = await git.merge.commitTree(
          mergeTreeResult.treeSha,
          [targetSha],  // Single parent for squash-style merge
          commitMessage,
          repoPath,
          s => log.debug(s)
        );
        
        log.debug(`Created merge commit: ${newCommit.slice(0, 8)}`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `Created merge commit: ${newCommit.slice(0, 8)}`);
        
        // Update the target branch to point to the new commit
        // We need to handle the case where target branch is checked out elsewhere
        await this.updateBranchRef(repoPath, targetBranch, newCommit);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `Updated ${targetBranch} to ${newCommit.slice(0, 8)}`);
        
        log.info(`Merged leaf ${node.name} to ${targetBranch}`, {
          commit: completedCommit.slice(0, 8),
          newCommit: newCommit.slice(0, 8),
        });
        
        // Push if configured
        const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
        const pushOnSuccess = mergeCfg.get<boolean>('pushOnSuccess', false);
        
        if (pushOnSuccess) {
          try {
            this.execLog(plan.id, node.id, 'merge-ri', 'info', `Pushing ${targetBranch} to origin...`);
            await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
            log.info(`Pushed ${targetBranch} to origin`);
            this.execLog(plan.id, node.id, 'merge-ri', 'info', `✓ Pushed to origin`);
          } catch (pushError: any) {
            log.warn(`Push failed: ${pushError.message}`);
            this.execLog(plan.id, node.id, 'merge-ri', 'error', `Push failed: ${pushError.message}`);
            // Push failure doesn't mean merge failed - the commit is local
          }
        }
        
        return true;
      }
      
      // =========================================================================
      // CONFLICT: Use Copilot CLI to resolve via main repo merge
      // =========================================================================
      if (mergeTreeResult.hasConflicts) {
        log.info(`Merge has conflicts, using Copilot CLI to resolve`, {
          conflictFiles: mergeTreeResult.conflictFiles,
        });
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `⚠ Merge has conflicts`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `  Conflicts: ${mergeTreeResult.conflictFiles?.join(', ')}`);
        this.execLog(plan.id, node.id, 'merge-ri', 'info', `  Invoking Copilot CLI to resolve...`);
        
        // Fall back to main repo merge with Copilot CLI resolution
        const resolved = await this.mergeWithConflictResolution(
          repoPath,
          completedCommit,
          targetBranch,
          `Plan ${plan.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`,
          { planId: plan.id, nodeId: node.id, phase: 'merge-ri' }
        );
        
        if (resolved) {
          this.execLog(plan.id, node.id, 'merge-ri', 'info', `✓ Conflict resolved by Copilot CLI`);
        } else {
          this.execLog(plan.id, node.id, 'merge-ri', 'error', `✗ Copilot CLI failed to resolve conflict`);
        }
        
        return resolved;
      }
      
      log.error(`Merge-tree failed: ${mergeTreeResult.error}`);
      this.execLog(plan.id, node.id, 'merge-ri', 'error', `✗ Merge-tree failed: ${mergeTreeResult.error}`);
      return false;
      
    } catch (error: any) {
      log.error(`Failed to merge leaf to target`, {
        node: node.name,
        error: error.message,
      });
      this.execLog(plan.id, node.id, 'merge-ri', 'error', `✗ Exception: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Update a branch reference to point to a new commit.
   * Handles the case where the branch is checked out in the main repo.
   */
  private async updateBranchRef(
    repoPath: string,
    branchName: string,
    newCommit: string
  ): Promise<void> {
    // Check if we're on this branch in the main repo
    const currentBranch = await git.branches.currentOrNull(repoPath);
    const isDirty = await git.repository.hasUncommittedChanges(repoPath);
    
    if (currentBranch === branchName) {
      // User is on the target branch - use reset --hard (with stash if dirty)
      log.debug(`User is on ${branchName}, using reset --hard to update`);
      
      if (isDirty) {
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
        try {
          await this.runGitCommand(repoPath, `git reset --hard ${newCommit}`);
          await git.repository.stashPop(repoPath, s => log.debug(s));
        } catch (err) {
          await git.repository.stashPop(repoPath, s => log.debug(s));
          throw err;
        }
      } else {
        await this.runGitCommand(repoPath, `git reset --hard ${newCommit}`);
      }
      log.info(`Updated ${branchName} via reset --hard to ${newCommit.slice(0, 8)}`);
    } else {
      // User is NOT on target branch - we can use update-ref
      // This is safe even if the branch is "associated" with the main repo
      log.debug(`User is on ${currentBranch || 'detached HEAD'}, using update-ref`);
      
      await this.runGitCommand(repoPath, `git update-ref refs/heads/${branchName} ${newCommit}`);
      log.info(`Updated ${branchName} via update-ref to ${newCommit.slice(0, 8)}`);
    }
  }
  
  /**
   * Merge additional source commits into a worktree.
   * 
   * This is called when a job has multiple dependencies (RI/FI model).
   * The worktree is already created from the first dependency's commit,
   * and we merge in the remaining dependency commits.
   * 
   * Uses full merge (not squash) to preserve history for downstream jobs.
   */
  private async mergeSourcesIntoWorktree(
    plan: PlanInstance,
    node: JobNode,
    worktreePath: string,
    additionalSources: string[]
  ): Promise<boolean> {
    if (additionalSources.length === 0) {
      return true;
    }
    
    log.info(`Merging ${additionalSources.length} source commits into worktree for ${node.name}`);
    
    for (const sourceCommit of additionalSources) {
      const shortSha = sourceCommit.slice(0, 8);
      log.debug(`Merging commit ${shortSha} into worktree at ${worktreePath}`);
      this.execLog(plan.id, node.id, 'merge-fi', 'info', `Merging source commit ${shortSha}...`);
      
      try {
        // Merge by commit SHA directly (no branch needed)
        const mergeResult = await git.merge.merge({
          source: sourceCommit,
          target: 'HEAD',
          cwd: worktreePath,
          message: `Merge parent commit ${shortSha} for job ${node.name}`,
          fastForward: true,
        });
        
        if (mergeResult.success) {
          log.debug(`Merge of commit ${shortSha} succeeded`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `✓ Merged commit ${shortSha} successfully`);
        } else if (mergeResult.hasConflicts) {
          log.info(`Merge conflict for commit ${shortSha}, using Copilot CLI to resolve`, {
            conflicts: mergeResult.conflictFiles,
          });
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `⚠ Merge conflict for commit ${shortSha}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `  Conflicts: ${mergeResult.conflictFiles?.join(', ')}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `  Invoking Copilot CLI to resolve...`);
          
          // Use Copilot CLI to resolve conflicts
          const resolved = await this.resolveMergeConflictWithCopilot(
            worktreePath,
            sourceCommit,
            'HEAD',
            `Merge parent commit ${shortSha} for job ${node.name}`,
            { planId: plan.id, nodeId: node.id, phase: 'merge-fi' }
          );
          
          if (!resolved) {
            log.error(`Copilot CLI failed to resolve merge conflict for commit ${shortSha}`);
            this.execLog(plan.id, node.id, 'merge-fi', 'error', `✗ Copilot CLI failed to resolve conflict`);
            await git.merge.abort(worktreePath, s => log.debug(s));
            return false;
          }
          
          log.info(`Merge conflict resolved by Copilot CLI for commit ${shortSha}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'info', `✓ Conflict resolved by Copilot CLI`);
        } else {
          log.error(`Merge failed for commit ${shortSha}: ${mergeResult.error}`);
          this.execLog(plan.id, node.id, 'merge-fi', 'error', `✗ Merge failed: ${mergeResult.error}`);
          return false;
        }
      } catch (error: any) {
        log.error(`Exception merging commit ${shortSha}: ${error.message}`);
        this.execLog(plan.id, node.id, 'merge-fi', 'error', `✗ Exception: ${error.message}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Run a git command in a directory
   */
  private async runGitCommand(cwd: string, command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = require('child_process');
      const p = cp.spawn(command, { cwd, shell: true });
      let stderr = '';
      p.stderr?.on('data', (d: any) => stderr += d.toString());
      p.on('exit', (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} failed with exit code ${code}: ${stderr}`));
        }
      });
    });
  }
  
  /**
   * Resolve merge conflicts using Copilot CLI.
   * 
   * Assumes we're in a merge conflict state in the given directory.
   * Uses Copilot CLI to resolve the conflicts, stage changes, and commit.
   */
  private async resolveMergeConflictWithCopilot(
    cwd: string,
    sourceBranch: string,
    targetBranch: string,
    commitMessage: string,
    logContext?: { planId: string; nodeId: string; phase: ExecutionPhase }
  ): Promise<boolean> {
    const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
    const prefer = mergeCfg.get<string>('prefer', 'theirs');
    
    const mergeInstruction =
      `@agent Resolve the current git merge conflict. ` +
      `We are merging '${sourceBranch}' into '${targetBranch}'. ` +
      `Prefer '${prefer}' changes when there are conflicts. ` +
      `Resolve all conflicts, stage the changes with 'git add', and commit with message '${commitMessage}'`;
    
    const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
    
    log.info(`Running Copilot CLI to resolve conflicts...`, { cwd });
    
    // Helper to log CLI output to execution logs
    const logOutput = (line: string) => {
      if (logContext && line.trim()) {
        this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'info', `  [copilot] ${line.trim()}`);
      }
    };
    
    const result = await new Promise<{ status: number | null }>((resolve) => {
      const child = spawn(copilotCmd, [], {
        cwd,
        shell: true,
        timeout: 300000, // 5 minute timeout
      });
      
      // Capture stdout
      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          log.debug(`[copilot] ${line}`);
          logOutput(line);
        });
      });
      
      // Capture stderr
      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          log.debug(`[copilot] ${line}`);
          logOutput(line);
        });
      });
      
      child.on('close', (code) => {
        resolve({ status: code });
      });
      
      child.on('error', (err) => {
        log.error('Copilot CLI spawn error', { error: err.message });
        if (logContext) {
          this.execLog(logContext.planId, logContext.nodeId, logContext.phase, 'error', `  [copilot] Error: ${err.message}`);
        }
        resolve({ status: 1 });
      });
    });
    
    return result.status === 0;
  }
  
  /**
   * Merge with conflict resolution using main repo merge and Copilot CLI.
   * 
   * This is used when merge-tree detects conflicts. It:
   * 1. Stashes user's uncommitted changes
   * 2. Checks out target branch
   * 3. Performs merge (conflicts occur)
   * 4. Uses Copilot CLI to resolve conflicts
   * 5. Restores user's original branch and stash
   */
  private async mergeWithConflictResolution(
    repoPath: string,
    sourceCommit: string,
    targetBranch: string,
    commitMessage: string,
    logContext?: { planId: string; nodeId: string; phase: ExecutionPhase }
  ): Promise<boolean> {
    // Capture user's current state
    const originalBranch = await git.branches.currentOrNull(repoPath);
    const isOnTargetBranch = originalBranch === targetBranch;
    const isDirty = await git.repository.hasUncommittedChanges(repoPath);
    
    let didStash = false;
    let didCheckout = false;
    
    try {
      // Step 1: Stash uncommitted changes if needed
      if (isDirty) {
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        didStash = await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
        log.debug(`Stashed user's uncommitted changes`);
      }
      
      // Step 2: Checkout targetBranch if needed
      if (!isOnTargetBranch) {
        await git.branches.checkout(repoPath, targetBranch, s => log.debug(s));
        didCheckout = true;
        log.debug(`Checked out ${targetBranch} for merge`);
      }
      
      // Step 3: Perform the merge (will have conflicts)
      await this.runGitCommand(repoPath, `git merge --no-commit ${sourceCommit}`).catch(() => {
        // Expected to fail due to conflicts
      });
      
      // Step 4: Use Copilot CLI to resolve conflicts
      const resolved = await this.resolveMergeConflictWithCopilot(
        repoPath,
        sourceCommit,
        targetBranch,
        commitMessage,
        logContext
      );
      
      if (!resolved) {
        throw new Error('Copilot CLI failed to resolve conflicts');
      }
      
      log.info(`Merge conflict resolved by Copilot CLI`);
      
      // Push if configured
      const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
      const pushOnSuccess = mergeCfg.get<boolean>('pushOnSuccess', false);
      
      if (pushOnSuccess) {
        try {
          await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
          log.info(`Pushed ${targetBranch} to origin`);
        } catch (pushError: any) {
          log.warn(`Push failed: ${pushError.message}`);
        }
      }
      
      // Step 5: Restore user to original branch (if they weren't on target)
      if (didCheckout && originalBranch) {
        await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
        log.debug(`Restored user to ${originalBranch}`);
      }
      
      // Step 6: Restore user's uncommitted changes
      if (didStash) {
        await git.repository.stashPop(repoPath, s => log.debug(s));
        log.debug(`Restored user's uncommitted changes`);
      }
      
      return true;
      
    } catch (error: any) {
      log.error(`Merge with conflict resolution failed: ${error.message}`);
      
      // Try to restore user state
      try {
        await git.merge.abort(repoPath, s => log.debug(s)).catch(() => {});
        
        if (didCheckout && originalBranch) {
          const currentBranch = await git.branches.currentOrNull(repoPath);
          if (currentBranch !== originalBranch) {
            await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
          }
        }
        
        if (didStash) {
          await git.repository.stashPop(repoPath, s => log.debug(s));
        }
      } catch (restoreError: any) {
        log.error(`Failed to restore user state: ${restoreError.message}`);
      }
      
      return false;
    }
  }
  
  /**
   * Clean up a worktree after successful completion (detached HEAD - no branch)
   */
  private async cleanupWorktree(
    worktreePath: string,
    repoPath: string
  ): Promise<void> {
    log.debug(`Cleaning up worktree: ${worktreePath}`);
    
    try {
      await git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
    } catch (error: any) {
      log.warn(`Failed to cleanup worktree`, {
        path: worktreePath,
        error: error.message,
      });
    }
  }
  
  /**
   * Clean up worktrees for nodes that are safe to clean up.
   * 
   * A node's worktree is safe to clean up when:
   * 1. The node itself has succeeded (has a completedCommit)
   * 2. ALL of its dependents have succeeded (they've consumed our commit)
   * 3. The worktree hasn't already been cleaned up
   * 
   * This ensures we don't lose state that downstream nodes might need.
   * For leaf nodes (no dependents), they can be cleaned up immediately after success.
   * For intermediate nodes, we wait until all children have completed.
   */
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
      const fs = require('fs');
      if (!fs.existsSync(state.worktreePath)) {
        continue; // Already cleaned up
      }
      
      const node = plan.nodes.get(nodeId);
      if (!node) continue;
      
      // Leaf nodes (no dependents) - can only be cleaned up after successful merge to target
      if (node.dependents.length === 0) {
        // If there's a targetBranch, we need mergedToTarget to be true
        // If no targetBranch, there's nothing to merge so it's safe to clean up
        if (plan.targetBranch) {
          if (state.mergedToTarget === true) {
            eligibleNodes.push(nodeId);
          }
          // If mergedToTarget is false or undefined, keep the worktree for manual retry
        } else {
          // No targetBranch = no merge needed = safe to cleanup
          eligibleNodes.push(nodeId);
        }
        continue;
      }
      
      // For non-leaf nodes, check if ALL dependents have succeeded
      // This means they've all had a chance to consume our commit
      let allDependentsSucceeded = true;
      for (const depId of node.dependents) {
        const depState = plan.nodeStates.get(depId);
        if (!depState || depState.status !== 'succeeded') {
          allDependentsSucceeded = false;
          break;
        }
      }
      
      if (allDependentsSucceeded) {
        eligibleNodes.push(nodeId);
      }
    }
    
    // Clean up eligible worktrees
    if (eligibleNodes.length > 0) {
      log.debug(`Cleaning up ${eligibleNodes.length} eligible worktrees`, {
        planId: plan.id,
        nodes: eligibleNodes.map(id => plan.nodes.get(id)?.name || id),
      });
      
      for (const nodeId of eligibleNodes) {
        const state = plan.nodeStates.get(nodeId);
        if (state?.worktreePath) {
          await this.cleanupWorktree(state.worktreePath, plan.repoPath);
          state.worktreeCleanedUp = true;
        }
      }
      
      // Persist the updated state with worktreeCleanedUp flags
      this.persistence.save(plan);
    }
  }
  
  // ============================================================================
  // RETRY FAILED NODES
  // ============================================================================
  
  /**
   * Retry a failed node.
   * Resets the node state and re-queues it for execution.
   * 
   * @param planId - Plan ID
   * @param nodeId - Node ID to retry
   * @param options - Retry options
   * @returns true if retry was initiated, error message otherwise
   */
  retryNode(planId: string, nodeId: string, options?: RetryNodeOptions): { success: boolean; error?: string } {
    const plan = this.plans.get(planId);
    if (!plan) {
      return { success: false, error: `Plan not found: ${planId}` };
    }
    
    const node = plan.nodes.get(nodeId);
    if (!node) {
      return { success: false, error: `Node not found: ${nodeId}` };
    }
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {
      return { success: false, error: `Node state not found: ${nodeId}` };
    }
    
    if (nodeState.status !== 'failed') {
      return { success: false, error: `Node is not in failed state: ${nodeState.status}` };
    }
    
    const sm = this.stateMachines.get(planId);
    if (!sm) {
      return { success: false, error: `State machine not found for Plan: ${planId}` };
    }
    
    log.info(`Retrying failed node: ${node.name}`, {
      planId,
      nodeId,
      hasNewWork: !!options?.newWork,
      clearWorktree: options?.clearWorktree ?? false,
    });
    
    // Handle new work spec if provided
    if (options?.newWork && node.type === 'job') {
      const jobNode = node as JobNode;
      const newWork = options.newWork;
      
      if (typeof newWork === 'string') {
        // String work spec - could be shell command or @agent
        if (newWork.startsWith('@agent')) {
          // Agent work - preserve existing session by default
          jobNode.work = newWork;
        } else {
          // Shell command
          jobNode.work = newWork;
          // Clear session since this is not agent work
          nodeState.copilotSessionId = undefined;
        }
      } else if (newWork.type === 'agent') {
        // Agent spec with explicit options
        // If instructions are empty, this is a "session control only" spec - don't replace work
        if (newWork.instructions) {
          jobNode.work = newWork;
        }
        if (newWork.resumeSession === false) {
          nodeState.copilotSessionId = undefined;
        }
      } else {
        // Process or shell spec - not agent work
        jobNode.work = newWork;
        nodeState.copilotSessionId = undefined;
      }
    }
    
    // Reset node state for retry
    // Note: We do NOT increment nodeState.attempts here - that happens in executeJobNode
    // when the job actually starts running. Incrementing here would cause double-counting.
    nodeState.status = 'pending';
    nodeState.error = undefined;
    nodeState.endedAt = undefined;
    nodeState.startedAt = undefined;
    nodeState.stepStatuses = undefined;
    
    // Note: We preserve worktreePath and baseCommit so the work can continue in the same worktree
    // If clearWorktree is true, we'll need to reset git state
    if (options?.clearWorktree && nodeState.worktreePath) {
      // Reset detached HEAD to base commit
      const resetWorktree = async () => {
        try {
          if (nodeState.baseCommit && nodeState.worktreePath) {
            log.info(`Resetting worktree to base commit: ${nodeState.baseCommit.slice(0, 8)}`);
            await git.executor.execAsync(['reset', '--hard', nodeState.baseCommit], { cwd: nodeState.worktreePath });
            await git.executor.execAsync(['clean', '-fd'], { cwd: nodeState.worktreePath });
          }
        } catch (e: any) {
          log.warn(`Failed to reset worktree: ${e.message}`);
        }
      };
      resetWorktree(); // Fire and forget
    }
    
    // Persist the reset state
    this.persistence.save(plan);
    
    // Check if ready to run (all dependencies succeeded)
    const readyNodes = sm.getReadyNodes();
    if (!readyNodes.includes(nodeId)) {
      // Need to manually transition to ready since we reset
      sm.resetNodeToPending(nodeId);
    }
    
    // Ensure pump is running to process the node
    this.startPump();
    
    this.emit('nodeRetry', planId, nodeId);
    
    return { success: true };
  }
  
  /**
   * Get failure context for a node (for AI analysis before retry)
   */
  getNodeFailureContext(planId: string, nodeId: string): {
    logs: string;
    phase: string;
    errorMessage: string;
    sessionId?: string;
    lastAttempt?: NodeExecutionState['lastAttempt'];
    worktreePath?: string;
  } | { error: string } {
    const plan = this.plans.get(planId);
    if (!plan) {
      return { error: `Plan not found: ${planId}` };
    }
    
    const node = plan.nodes.get(nodeId);
    if (!node) {
      return { error: `Node not found: ${nodeId}` };
    }
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {
      return { error: `Node state not found: ${nodeId}` };
    }
    
    // Get logs for this node
    const logsText = this.getNodeLogs(planId, nodeId);
    
    return {
      logs: logsText,
      phase: nodeState.lastAttempt?.phase || 'unknown',
      errorMessage: nodeState.error || 'Unknown error',
      sessionId: nodeState.copilotSessionId,
      lastAttempt: nodeState.lastAttempt,
      worktreePath: nodeState.worktreePath,
    };
  }
  
  // ============================================================================
  // WORK SUMMARY
  // ============================================================================
  
  /**
   * Append a job's work summary to the Plan's aggregated summary
   */
  private appendWorkSummary(plan: PlanInstance, jobSummary: JobWorkSummary): void {
    if (!plan.workSummary) {
      plan.workSummary = {
        totalCommits: 0,
        totalFilesAdded: 0,
        totalFilesModified: 0,
        totalFilesDeleted: 0,
        jobSummaries: [],
      };
    }
    
    plan.workSummary.totalCommits += jobSummary.commits;
    plan.workSummary.totalFilesAdded += jobSummary.filesAdded;
    plan.workSummary.totalFilesModified += jobSummary.filesModified;
    plan.workSummary.totalFilesDeleted += jobSummary.filesDeleted;
    plan.workSummary.jobSummaries.push(jobSummary);
  }
  
  // ============================================================================
  // EVENT WIRING
  // ============================================================================
  
  /**
   * Setup listeners on a state machine
   */
  private setupStateMachineListeners(sm: PlanStateMachine): void {
    sm.on('transition', (event: NodeTransitionEvent) => {
      this.emit('nodeTransition', event);
    });
    
    sm.on('planComplete', (event: PlanCompletionEvent) => {
      const plan = this.plans.get(event.planId);
      if (plan) {
        this.emit('planCompleted', plan, event.status);
      }
    });
  }
}
