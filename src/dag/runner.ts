/**
 * @fileoverview DAG Runner
 * 
 * Main orchestrator for DAG execution. Combines:
 * - DAG building
 * - State machine management
 * - Scheduling
 * - Execution delegation
 * - Persistence
 * 
 * This is the primary interface for creating and running DAGs.
 * 
 * @module dag/runner
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  DagSpec,
  DagInstance,
  DagNode,
  JobNode,
  SubDagNode,
  NodeStatus,
  DagStatus,
  JobExecutionResult,
  ExecutionContext,
  NodeTransitionEvent,
  DagCompletionEvent,
  WorkSummary,
  JobWorkSummary,
  LogEntry,
  ExecutionPhase,
  nodePerformsWork,
} from './types';
import { buildDag, buildSingleJobDag, DagValidationError } from './builder';
import { DagStateMachine } from './stateMachine';
import { DagScheduler } from './scheduler';
import { DagPersistence } from './persistence';
import { Logger } from '../core/logger';
import * as git from '../git';

const log = Logger.for('dag-runner');

/**
 * Events emitted by the DAG runner
 */
export interface DagRunnerEvents {
  'dagCreated': (dag: DagInstance) => void;
  'dagStarted': (dag: DagInstance) => void;
  'dagCompleted': (dag: DagInstance, status: DagStatus) => void;
  'dagDeleted': (dagId: string) => void;
  'nodeTransition': (event: NodeTransitionEvent) => void;
  'nodeStarted': (dagId: string, nodeId: string) => void;
  'nodeCompleted': (dagId: string, nodeId: string, success: boolean) => void;
}

/**
 * Job executor interface - implemented separately for actual execution
 */
export interface JobExecutor {
  execute(context: ExecutionContext): Promise<JobExecutionResult>;
  cancel(dagId: string, nodeId: string): void;
  getLogs?(dagId: string, nodeId: string): LogEntry[];
  getLogsForPhase?(dagId: string, nodeId: string, phase: ExecutionPhase): LogEntry[];
  log?(dagId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void;
}

/**
 * DAG Runner configuration
 */
export interface DagRunnerConfig {
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
 * DAG Runner - orchestrates DAG execution
 */
export class DagRunner extends EventEmitter {
  private dags = new Map<string, DagInstance>();
  private stateMachines = new Map<string, DagStateMachine>();
  private scheduler: DagScheduler;
  private persistence: DagPersistence;
  private executor?: JobExecutor;
  private pumpTimer?: NodeJS.Timeout;
  private config: DagRunnerConfig;
  private isRunning = false;
  
  constructor(config: DagRunnerConfig) {
    super();
    this.config = config;
    this.scheduler = new DagScheduler({
      globalMaxParallel: config.maxParallel || 8,
    });
    this.persistence = new DagPersistence(config.storagePath);
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
  private execLog(dagId: string, nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void {
    if (this.executor?.log) {
      this.executor.log(dagId, nodeId, phase, type, message);
    }
  }
  
  /**
   * Initialize the runner - load persisted DAGs and start pump
   */
  async initialize(): Promise<void> {
    log.info('Initializing DAG runner');
    
    // Load persisted DAGs
    const loadedDags = this.persistence.loadAll();
    for (const dag of loadedDags) {
      this.dags.set(dag.id, dag);
      const sm = new DagStateMachine(dag);
      this.setupStateMachineListeners(sm);
      this.stateMachines.set(dag.id, sm);
    }
    
    log.info(`Loaded ${loadedDags.length} DAGs from persistence`);
    
    // Start the pump
    this.startPump();
    this.isRunning = true;
  }
  
  /**
   * Shutdown the runner - persist state and stop pump
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down DAG runner');
    this.stopPump();
    
    // Persist all DAGs
    for (const dag of this.dags.values()) {
      this.persistence.save(dag);
    }
    
    this.isRunning = false;
  }
  
  /**
   * Persist all DAGs synchronously (for emergency shutdown)
   */
  persistSync(): void {
    for (const dag of this.dags.values()) {
      this.persistence.saveSync(dag);
    }
  }
  
  // ============================================================================
  // DAG CREATION
  // ============================================================================
  
  /**
   * Create and enqueue a DAG from a specification.
   * 
   * @param spec - The DAG specification
   * @returns The created DAG instance
   * @throws DagValidationError if the spec is invalid
   */
  enqueue(spec: DagSpec): DagInstance {
    log.info(`Creating DAG: ${spec.name}`, {
      jobs: spec.jobs.length,
      subDags: spec.subDags?.length || 0,
    });
    
    // Build the DAG
    const dag = buildDag(spec, {
      repoPath: spec.repoPath || this.config.defaultRepoPath,
    });
    
    // Store the DAG
    this.dags.set(dag.id, dag);
    
    // Create state machine
    const sm = new DagStateMachine(dag);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(dag.id, sm);
    
    // Persist
    this.persistence.save(dag);
    
    // Emit event
    this.emit('dagCreated', dag);
    
    log.info(`DAG created: ${dag.id}`, {
      name: spec.name,
      nodes: dag.nodes.size,
      roots: dag.roots.length,
      leaves: dag.leaves.length,
    });
    
    return dag;
  }
  
  /**
   * Create a simple single-job DAG.
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
  }): DagInstance {
    const dag = buildSingleJobDag(jobSpec, {
      repoPath: this.config.defaultRepoPath,
    });
    
    // Store and setup
    this.dags.set(dag.id, dag);
    const sm = new DagStateMachine(dag);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(dag.id, sm);
    
    // Persist
    this.persistence.save(dag);
    
    // Emit event
    this.emit('dagCreated', dag);
    
    log.info(`Single-job DAG created: ${dag.id}`, { name: jobSpec.name });
    
    return dag;
  }
  
  // ============================================================================
  // DAG QUERIES
  // ============================================================================
  
  /**
   * Get a DAG by ID
   */
  get(dagId: string): DagInstance | undefined {
    return this.dags.get(dagId);
  }
  
  /**
   * Get all DAGs
   */
  getAll(): DagInstance[] {
    return Array.from(this.dags.values());
  }
  
  /**
   * Get DAGs by status
   */
  getByStatus(status: DagStatus): DagInstance[] {
    return Array.from(this.dags.values()).filter(dag => {
      const sm = this.stateMachines.get(dag.id);
      return sm?.computeDagStatus() === status;
    });
  }
  
  /**
   * Get the state machine for a DAG
   */
  getStateMachine(dagId: string): DagStateMachine | undefined {
    return this.stateMachines.get(dagId);
  }
  
  /**
   * Get DAG status with computed fields
   */
  getStatus(dagId: string): {
    dag: DagInstance;
    status: DagStatus;
    counts: Record<NodeStatus, number>;
    progress: number;
  } | undefined {
    const dag = this.dags.get(dagId);
    const sm = this.stateMachines.get(dagId);
    if (!dag || !sm) return undefined;
    
    const counts = sm.getStatusCounts();
    const total = dag.nodes.size;
    const completed = counts.succeeded + counts.failed + counts.blocked + counts.canceled;
    const progress = total > 0 ? completed / total : 0;
    
    return {
      dag,
      status: sm.computeDagStatus(),
      counts,
      progress,
    };
  }
  
  /**
   * Get execution logs for a node
   */
  getNodeLogs(dagId: string, nodeId: string, phase?: 'all' | ExecutionPhase): string {
    if (!this.executor) return 'No executor available.';
    
    // First try memory logs
    let logs: LogEntry[] = [];
    if (phase && phase !== 'all' && this.executor.getLogsForPhase) {
      logs = this.executor.getLogsForPhase(dagId, nodeId, phase);
    } else if (this.executor.getLogs) {
      logs = this.executor.getLogs(dagId, nodeId);
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
      const fileContent = (this.executor as any).readLogsFromFile(dagId, nodeId);
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
   * Get process stats for a running node
   */
  async getProcessStats(dagId: string, nodeId: string): Promise<{
    pid: number | null;
    running: boolean;
    tree: any[];
    duration: number | null;
  }> {
    if (!this.executor) {
      return { pid: null, running: false, tree: [], duration: null };
    }
    
    if ('getProcessStats' in this.executor && typeof (this.executor as any).getProcessStats === 'function') {
      return (this.executor as any).getProcessStats(dagId, nodeId);
    }
    
    return { pid: null, running: false, tree: [], duration: null };
  }
  
  /**
   * Get process stats for all running nodes in a DAG (including sub-DAGs).
   * Returns a hierarchical structure: DAG → Jobs → Processes
   * Uses batch method for efficiency - single process snapshot for all nodes.
   */
  async getAllProcessStats(dagId: string): Promise<{
    flat: Array<{
      nodeId: string;
      nodeName: string;
      dagId?: string;
      dagName?: string;
      pid: number | null;
      running: boolean;
      tree: any[];
      duration: number | null;
    }>;
    hierarchy: Array<{
      dagId: string;
      dagName: string;
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
      children: any[]; // Nested sub-DAGs
    }>;
  }> {
    const dag = this.dags.get(dagId);
    if (!dag || !this.executor) return { flat: [], hierarchy: [] };
    
    // Collect all running/scheduled job node keys for batch process fetch
    const nodeKeys: Array<{ dagId: string; nodeId: string; nodeName: string; dagName?: string }> = [];
    
    // Build hierarchical structure recursively
    const buildHierarchy = (d: DagInstance, parentPath?: string): any => {
      const sm = this.stateMachines.get(d.id);
      const dagStatus = sm?.computeDagStatus() || 'pending';
      
      const dagPath = parentPath ? `${parentPath} → ${d.spec.name}` : d.spec.name;
      
      const jobs: any[] = [];
      const children: any[] = [];
      
      for (const [nodeId, state] of d.nodeStates) {
        const node = d.nodes.get(nodeId);
        if (!node) continue;
        
        // For job nodes that are running/scheduled
        if (node.type === 'job' && (state.status === 'running' || state.status === 'scheduled')) {
          nodeKeys.push({
            dagId: d.id,
            nodeId,
            nodeName: node.name || nodeId.slice(0, 8),
            dagName: parentPath ? dagPath : undefined
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
        
        // For subdag nodes, recurse into child DAG
        if (node.type === 'subdag' && state.childDagId) {
          const childDag = this.dags.get(state.childDagId);
          if (childDag) {
            const childHierarchy = buildHierarchy(childDag, dagPath);
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
        dagId: d.id,
        dagName: d.spec.name,
        parentPath: parentPath, // Include parent path for context
        status: dagStatus,
        jobs,
        children
      };
    };
    
    // Build hierarchy starting from root DAG (but only include sub-DAGs in the output)
    const rootHierarchy: any[] = [];
    
    // For root DAG, collect jobs directly (not wrapped in a sub-DAG node)
    const rootJobs: any[] = [];
    for (const [nodeId, state] of dag.nodeStates) {
      const node = dag.nodes.get(nodeId);
      if (!node) continue;
      
      if (node.type === 'job' && (state.status === 'running' || state.status === 'scheduled')) {
        nodeKeys.push({
          dagId: dag.id,
          nodeId,
          nodeName: node.name || nodeId.slice(0, 8),
          dagName: undefined
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
      
      // For subdag nodes, recurse
      if (node.type === 'subdag' && state.childDagId) {
        const childDag = this.dags.get(state.childDagId);
        if (childDag) {
          const childHierarchy = buildHierarchy(childDag, undefined);
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
          const key = `${nodeKeys[i].dagId}:${nodeKeys[i].nodeId}`;
          processStats.set(key, stats[i]);
        }
      } catch {
        // Fallback: individual fetches
      }
    }
    
    // Fill in process stats for root jobs
    for (const job of rootJobs) {
      const key = `${dag.id}:${job.nodeId}`;
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
        const key = `${h.dagId}:${job.nodeId}`;
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
          dagId: dag.id,
          dagName: undefined,
          pid: job.pid,
          running: job.running,
          tree: job.tree,
          duration: job.duration
        });
      }
    }
    
    const collectFlat = (h: any, path?: string) => {
      const dagPath = path ? `${path} → ${h.dagName}` : h.dagName;
      for (const job of h.jobs) {
        if (job.running || job.pid) {
          flat.push({
            nodeId: job.nodeId,
            nodeName: job.nodeName,
            dagId: h.dagId,
            dagName: dagPath,
            pid: job.pid,
            running: job.running,
            tree: job.tree,
            duration: job.duration
          });
        }
      }
      for (const child of h.children) {
        collectFlat(child, dagPath);
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
  // DAG CONTROL
  // ============================================================================
  
  /**
   * Cancel a DAG
   */
  cancel(dagId: string): boolean {
    const dag = this.dags.get(dagId);
    const sm = this.stateMachines.get(dagId);
    if (!dag || !sm) return false;
    
    log.info(`Canceling DAG: ${dagId}`);
    
    // Cancel all running jobs in executor
    for (const [nodeId, state] of dag.nodeStates) {
      if (state.status === 'running' || state.status === 'scheduled') {
        this.executor?.cancel(dagId, nodeId);
      }
    }
    
    // Cancel all non-terminal nodes
    sm.cancelAll();
    
    // Persist
    this.persistence.save(dag);
    
    return true;
  }
  
  /**
   * Delete a DAG
   */
  delete(dagId: string): boolean {
    const dag = this.dags.get(dagId);
    if (!dag) return false;
    
    log.info(`Deleting DAG: ${dagId}`);
    
    // Cancel if running
    this.cancel(dagId);
    
    // Clean up worktrees and branches in background
    this.cleanupDagResources(dag).catch(err => {
      log.error(`Failed to cleanup DAG resources`, { dagId, error: err.message });
    });
    
    // Remove from memory
    this.dags.delete(dagId);
    this.stateMachines.delete(dagId);
    
    // Remove from persistence
    this.persistence.delete(dagId);
    
    // Notify listeners
    this.emit('dagDeleted', dagId);
    
    return true;
  }
  
  /**
   * Clean up all resources associated with a DAG (worktrees, logs)
   * 
   * NOTE: With detached HEAD worktrees, there are no branches to clean up.
   * We only remove worktrees and log files.
   */
  private async cleanupDagResources(dag: DagInstance): Promise<void> {
    const repoPath = dag.repoPath;
    const cleanupErrors: string[] = [];
    
    // Collect all worktree paths from node states
    const worktreePaths: string[] = [];
    
    for (const [nodeId, state] of dag.nodeStates) {
      if (state.worktreePath) {
        worktreePaths.push(state.worktreePath);
      }
    }
    
    log.info(`Cleaning up DAG resources`, {
      dagId: dag.id,
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
    if (dag.worktreeRoot) {
      try {
        const fs = require('fs');
        const entries = fs.readdirSync(dag.worktreeRoot);
        if (entries.length === 0) {
          fs.rmdirSync(dag.worktreeRoot);
          log.debug(`Removed empty worktree root: ${dag.worktreeRoot}`);
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
          const dagLogsDir = path.join(storagePath, dag.id);
          if (fs.existsSync(dagLogsDir)) {
            fs.rmSync(dagLogsDir, { recursive: true, force: true });
            log.debug(`Removed log directory: ${dagLogsDir}`);
          }
        }
      } catch (error: any) {
        cleanupErrors.push(`logs: ${error.message}`);
      }
    }
    
    if (cleanupErrors.length > 0) {
      log.warn(`Some cleanup operations failed`, { errors: cleanupErrors });
    } else {
      log.info(`DAG cleanup completed successfully`, { dagId: dag.id });
    }
  }
  
  /**
   * Resume a DAG that may have been paused or completed with failures.
   * This ensures the pump is running to process any ready nodes.
   */
  resume(dagId: string): boolean {
    const dag = this.dags.get(dagId);
    if (!dag) return false;
    
    log.info(`Resuming DAG: ${dagId}`);
    
    // Ensure pump is running
    this.startPump();
    
    // Persist the current state
    this.persistence.save(dag);
    
    return true;
  }
  
  /**
   * Get a DAG by ID (for external access)
   */
  getDag(dagId: string): DagInstance | undefined {
    return this.dags.get(dagId);
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
   * Main pump loop - called periodically to advance DAG execution
   */
  private async pump(): Promise<void> {
    if (!this.executor) {
      return; // Can't do anything without an executor
    }
    
    // Count total running jobs across all DAGs (only count actual job nodes, not sub-DAG coordination nodes)
    let globalRunning = 0;
    let globalSubDagsRunning = 0;
    for (const [dagId, dag] of this.dags) {
      const sm = this.stateMachines.get(dagId);
      if (!sm) continue;
      
      for (const [nodeId, state] of dag.nodeStates) {
        if (state.status === 'running' || state.status === 'scheduled') {
          const node = dag.nodes.get(nodeId);
          if (node && nodePerformsWork(node)) {
            globalRunning++;
          } else {
            globalSubDagsRunning++;
          }
        }
      }
    }
    
    // Log overall status periodically (only if there are active DAGs)
    const totalDags = this.dags.size;
    if (totalDags > 0) {
      log.debug(`Pump: ${totalDags} DAGs, ${globalRunning} jobs running, ${globalSubDagsRunning} sub-DAGs coordinating`);
    }
    
    // Process each DAG
    for (const [dagId, dag] of this.dags) {
      const sm = this.stateMachines.get(dagId);
      if (!sm) continue;
      
      const status = sm.computeDagStatus();
      
      // Skip completed DAGs
      if (status !== 'pending' && status !== 'running') {
        continue;
      }
      
      // Mark DAG as started if not already
      if (!dag.startedAt && status === 'running') {
        dag.startedAt = Date.now();
        this.emit('dagStarted', dag);
      }
      
      // Get nodes to schedule - pass only actual job running count (sub-DAGs don't consume job slots)
      const nodesToSchedule = this.scheduler.selectNodes(dag, sm, globalRunning);
      
      // Log if there are ready nodes but none scheduled (potential bottleneck)
      const readyNodes = sm.getReadyNodes();
      if (readyNodes.length > 0 && nodesToSchedule.length === 0) {
        const counts = sm.getStatusCounts();
        log.debug(`DAG ${dag.spec.name} (${dagId.slice(0, 8)}): ${readyNodes.length} ready but 0 scheduled`, {
          globalRunning,
          dagRunning: counts.running + counts.scheduled,
          dagMaxParallel: dag.maxParallel,
        });
      }
      
      // Schedule each node
      for (const nodeId of nodesToSchedule) {
        const node = dag.nodes.get(nodeId);
        if (!node) continue;
        
        // Mark as scheduled
        sm.transition(nodeId, 'scheduled');
        
        // Only count nodes with work against global limit (sub-DAGs are coordination nodes)
        if (nodePerformsWork(node)) {
          globalRunning++;
        } else {
          globalSubDagsRunning++;
        }
        
        // Execute based on node type
        if (node.type === 'job') {
          this.executeJobNode(dag, sm, node as JobNode);
        } else if (node.type === 'subdag') {
          this.executeSubDagNode(dag, sm, node as SubDagNode);
        }
      }
      
      // Persist after scheduling
      if (nodesToSchedule.length > 0) {
        this.persistence.save(dag);
      }
    }
  }
  
  /**
   * Execute a job node
   */
  private async executeJobNode(
    dag: DagInstance,
    sm: DagStateMachine,
    node: JobNode
  ): Promise<void> {
    const nodeState = dag.nodeStates.get(node.id);
    if (!nodeState) return;
    
    log.info(`Executing job node: ${node.name}`, {
      dagId: dag.id,
      nodeId: node.id,
    });
    
    try {
      // Transition to running
      sm.transition(node.id, 'running');
      nodeState.attempts++;
      this.emit('nodeStarted', dag.id, node.id);
      
      // Determine base commits from dependencies (RI/FI model)
      // First commit is the base, additional commits are merged in
      const baseCommits = sm.getBaseCommitsForNode(node.id);
      const baseCommitish = baseCommits.length > 0 ? baseCommits[0] : dag.baseBranch;
      const additionalSources = baseCommits.slice(1);
      
      // Create worktree path (use path.join for cross-platform compatibility)
      const worktreePath = path.join(dag.worktreeRoot, node.producerId);
      
      // Store in state (no branchName since we use detached HEAD)
      nodeState.worktreePath = worktreePath;
      
      // Setup detached worktree
      log.debug(`Creating detached worktree for job ${node.name} at ${worktreePath} from ${baseCommitish}`);
      const timing = await git.worktrees.createDetachedWithTiming(
        dag.repoPath,
        worktreePath,
        baseCommitish,
        s => log.debug(s)
      );
      
      if (timing.totalMs > 500) {
        log.warn(`Slow worktree creation for ${node.name} took ${timing.totalMs}ms`);
      }
      
      // Store the base commit SHA for tracking
      nodeState.baseCommit = timing.baseCommit;
      
      // If job has multiple dependencies, merge the additional commits into the worktree (Forward Integration)
      if (additionalSources.length > 0) {
        log.info(`Merging ${additionalSources.length} additional source commits for job ${node.name}`);
        this.execLog(dag.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE START ==========');
        this.execLog(dag.id, node.id, 'merge-fi', 'info', `Merging ${additionalSources.length} source commit(s) into worktree`);
        
        const mergeSuccess = await this.mergeSourcesIntoWorktree(dag, node, worktreePath, additionalSources);
        
        if (!mergeSuccess) {
          this.execLog(dag.id, node.id, 'merge-fi', 'error', 'Forward integration merge FAILED');
          this.execLog(dag.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE END ==========');
          nodeState.error = 'Failed to merge sources from dependencies';
          sm.transition(node.id, 'failed');
          this.emit('nodeCompleted', dag.id, node.id, false);
          return;
        }
        
        this.execLog(dag.id, node.id, 'merge-fi', 'info', 'Forward integration merge succeeded');
        this.execLog(dag.id, node.id, 'merge-fi', 'info', '========== FORWARD INTEGRATION MERGE END ==========');
      }
      
      // Build execution context
      const context: ExecutionContext = {
        dag,
        node,
        baseCommit: timing.baseCommit,
        worktreePath,
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
      
      if (result.success) {
        // Store completed commit
        if (result.completedCommit) {
          nodeState.completedCommit = result.completedCommit;
        }
        
        // Store work summary on node state and aggregate to DAG
        if (result.workSummary) {
          nodeState.workSummary = result.workSummary;
          this.appendWorkSummary(dag, result.workSummary);
        }
        
        // Handle leaf node merge to target branch (Reverse Integration)
        const isLeaf = dag.leaves.includes(node.id);
        log.debug(`Merge check: node=${node.name}, isLeaf=${isLeaf}, targetBranch=${dag.targetBranch}, completedCommit=${nodeState.completedCommit?.slice(0, 8)}`);
        
        if (isLeaf && dag.targetBranch && nodeState.completedCommit) {
          log.info(`Initiating merge to target: ${node.name} -> ${dag.targetBranch}`);
          this.execLog(dag.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE START ==========');
          this.execLog(dag.id, node.id, 'merge-ri', 'info', `Merging completed commit ${nodeState.completedCommit.slice(0, 8)} to ${dag.targetBranch}`);
          
          const mergeSuccess = await this.mergeLeafToTarget(dag, node, nodeState.completedCommit);
          nodeState.mergedToTarget = mergeSuccess;
          
          if (mergeSuccess) {
            this.execLog(dag.id, node.id, 'merge-ri', 'info', `Reverse integration merge succeeded`);
          } else {
            this.execLog(dag.id, node.id, 'merge-ri', 'error', `Reverse integration merge FAILED - worktree preserved for manual retry`);
            log.warn(`Leaf ${node.name} succeeded but merge to ${dag.targetBranch} failed - worktree preserved for manual retry`);
          }
          this.execLog(dag.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE END ==========');
          
          log.info(`Merge result: ${mergeSuccess ? 'success' : 'failed'}`, { mergedToTarget: nodeState.mergedToTarget });
        } else if (isLeaf) {
          log.debug(`Skipping merge: isLeaf=${isLeaf}, hasTargetBranch=${!!dag.targetBranch}, hasCompletedCommit=${!!nodeState.completedCommit}`);
        }
        
        sm.transition(node.id, 'succeeded');
        this.emit('nodeCompleted', dag.id, node.id, true);
        
        // Try to cleanup eligible worktrees (this node and any ancestors that are now safe)
        if (dag.cleanUpSuccessfulWork) {
          await this.cleanupEligibleWorktrees(dag, sm);
        }
        
        log.info(`Job succeeded: ${node.name}`, {
          dagId: dag.id,
          nodeId: node.id,
          commit: nodeState.completedCommit?.slice(0, 8),
        });
      } else {
        nodeState.error = result.error;
        sm.transition(node.id, 'failed');
        this.emit('nodeCompleted', dag.id, node.id, false);
        
        log.error(`Job failed: ${node.name}`, {
          dagId: dag.id,
          nodeId: node.id,
          error: result.error,
        });
      }
    } catch (error: any) {
      nodeState.error = error.message;
      sm.transition(node.id, 'failed');
      this.emit('nodeCompleted', dag.id, node.id, false);
      
      log.error(`Job execution error: ${node.name}`, {
        dagId: dag.id,
        nodeId: node.id,
        error: error.message,
      });
    }
    
    // Persist after execution
    this.persistence.save(dag);
  }
  
  /**
   * Execute a sub-DAG node
   */
  private async executeSubDagNode(
    parentDag: DagInstance,
    sm: DagStateMachine,
    node: SubDagNode
  ): Promise<void> {
    log.info(`Executing sub-DAG node: ${node.name}`, {
      dagId: parentDag.id,
      nodeId: node.id,
    });
    
    try {
      // Transition to running
      sm.transition(node.id, 'running');
      this.emit('nodeStarted', parentDag.id, node.id);
      
      // Determine base branch for sub-DAG (from parent's dependencies)
      const baseCommit = sm.getBaseCommitForNode(node.id);
      
      // Build the child DAG
      const childSpec = {
        ...node.childSpec,
        baseBranch: baseCommit || parentDag.baseBranch,
        repoPath: parentDag.repoPath,
      };
      
      const childDag = buildDag(childSpec, {
        parentDagId: parentDag.id,
        parentNodeId: node.id,
        repoPath: parentDag.repoPath,
        worktreeRoot: `${parentDag.worktreeRoot}/${node.producerId}`,
      });
      
      // Store child DAG reference
      node.childDagId = childDag.id;
      const nodeState = parentDag.nodeStates.get(node.id);
      if (nodeState) {
        nodeState.childDagId = childDag.id;
      }
      
      // Register the child DAG
      this.dags.set(childDag.id, childDag);
      const childSm = new DagStateMachine(childDag);
      this.setupStateMachineListeners(childSm);
      this.stateMachines.set(childDag.id, childSm);
      
      // Listen for child completion
      childSm.on('dagComplete', (event: DagCompletionEvent) => {
        this.handleChildDagComplete(parentDag, sm, node, event).catch(err => {
          log.error(`Error in child DAG completion handler: ${err.message}`);
        });
      });
      
      // Persist both
      this.persistence.save(parentDag);
      this.persistence.save(childDag);
      
      log.info(`Sub-DAG created: ${childDag.id}`, {
        parentDagId: parentDag.id,
        parentNodeId: node.id,
        childNodes: childDag.nodes.size,
      });
      
    } catch (error: any) {
      const nodeState = parentDag.nodeStates.get(node.id);
      if (nodeState) {
        nodeState.error = error.message;
      }
      sm.transition(node.id, 'failed');
      this.emit('nodeCompleted', parentDag.id, node.id, false);
      
      log.error(`Sub-DAG creation failed: ${node.name}`, {
        dagId: parentDag.id,
        nodeId: node.id,
        error: error.message,
      });
      
      this.persistence.save(parentDag);
    }
  }
  
  /**
   * Handle child DAG completion
   */
  private async handleChildDagComplete(
    parentDag: DagInstance,
    parentSm: DagStateMachine,
    node: SubDagNode,
    event: DagCompletionEvent
  ): Promise<void> {
    log.info(`Child DAG completed: ${event.dagId}`, {
      parentDagId: parentDag.id,
      parentNodeId: node.id,
      status: event.status,
    });
    
    const nodeState = parentDag.nodeStates.get(node.id);
    const childDag = this.dags.get(event.dagId);
    
    // Log child DAG completion details to the parent's subdag node
    this.execLog(parentDag.id, node.id, 'work', 'info', '========== SUB-DAG EXECUTION COMPLETE ==========');
    this.execLog(parentDag.id, node.id, 'work', 'info', `Child DAG: ${event.dagId}`);
    this.execLog(parentDag.id, node.id, 'work', 'info', `Status: ${event.status.toUpperCase()}`);
    
    if (childDag) {
      // Log summary of child DAG jobs
      const jobCount = childDag.nodes.size;
      let succeeded = 0, failed = 0, blocked = 0;
      
      for (const [nodeId, childState] of childDag.nodeStates) {
        const childNode = childDag.nodes.get(nodeId);
        if (childState.status === 'succeeded') succeeded++;
        else if (childState.status === 'failed') failed++;
        else if (childState.status === 'blocked') blocked++;
        
        // Log each job's status
        const statusIcon = childState.status === 'succeeded' ? '✓' : 
                          childState.status === 'failed' ? '✗' : 
                          childState.status === 'blocked' ? '⊘' : '?';
        this.execLog(parentDag.id, node.id, 'work', 'info', 
          `  ${statusIcon} ${childNode?.name || nodeId}: ${childState.status}`);
        
        if (childState.error) {
          this.execLog(parentDag.id, node.id, 'work', 'error', `    Error: ${childState.error}`);
        }
        if (childState.completedCommit) {
          this.execLog(parentDag.id, node.id, 'work', 'info', `    Commit: ${childState.completedCommit.slice(0, 8)}`);
        }
      }
      
      this.execLog(parentDag.id, node.id, 'work', 'info', '');
      this.execLog(parentDag.id, node.id, 'work', 'info', `Summary: ${succeeded}/${jobCount} succeeded, ${failed} failed, ${blocked} blocked`);
      
      // Log work summary if available
      if (childDag.workSummary) {
        const ws = childDag.workSummary;
        this.execLog(parentDag.id, node.id, 'work', 'info', 
          `Work: ${ws.totalCommits} commits, +${ws.totalFilesAdded} ~${ws.totalFilesModified} -${ws.totalFilesDeleted} files`);
      }
    }
    
    this.execLog(parentDag.id, node.id, 'work', 'info', '========== SUB-DAG EXECUTION COMPLETE ==========');
    
    if (event.status === 'succeeded') {
      // Get the final commit from the child DAG's leaf nodes
      if (childDag && nodeState) {
        // Find a completed commit from leaf nodes
        for (const leafId of childDag.leaves) {
          const leafState = childDag.nodeStates.get(leafId);
          if (leafState?.completedCommit) {
            nodeState.completedCommit = leafState.completedCommit;
            break;
          }
        }
        
        // Handle leaf node merge to target branch (Reverse Integration) for sub-DAG nodes
        const isLeaf = parentDag.leaves.includes(node.id);
        log.debug(`Sub-DAG merge check: node=${node.name}, isLeaf=${isLeaf}, targetBranch=${parentDag.targetBranch}, completedCommit=${nodeState.completedCommit?.slice(0, 8)}`);
        
        if (isLeaf && parentDag.targetBranch && nodeState.completedCommit) {
          log.info(`Initiating merge to target for sub-DAG: ${node.name} -> ${parentDag.targetBranch}`);
          this.execLog(parentDag.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE START ==========');
          this.execLog(parentDag.id, node.id, 'merge-ri', 'info', `Merging sub-DAG completed commit ${nodeState.completedCommit.slice(0, 8)} to ${parentDag.targetBranch}`);
          
          const mergeSuccess = await this.mergeLeafToTarget(parentDag, node, nodeState.completedCommit);
          nodeState.mergedToTarget = mergeSuccess;
          
          if (mergeSuccess) {
            this.execLog(parentDag.id, node.id, 'merge-ri', 'info', `Reverse integration merge succeeded`);
          } else {
            this.execLog(parentDag.id, node.id, 'merge-ri', 'error', `Reverse integration merge FAILED`);
            log.warn(`Sub-DAG leaf ${node.name} succeeded but merge to ${parentDag.targetBranch} failed`);
          }
          this.execLog(parentDag.id, node.id, 'merge-ri', 'info', '========== REVERSE INTEGRATION MERGE END ==========');
          
          log.info(`Sub-DAG merge result: ${mergeSuccess ? 'success' : 'failed'}`, { mergedToTarget: nodeState.mergedToTarget });
        }
      }
      
      parentSm.transition(node.id, 'succeeded');
      this.emit('nodeCompleted', parentDag.id, node.id, true);
    } else {
      if (nodeState) {
        nodeState.error = `Child DAG ${event.status}`;
      }
      parentSm.transition(node.id, 'failed');
      this.emit('nodeCompleted', parentDag.id, node.id, false);
    }
    
    this.persistence.save(parentDag);
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
    dag: DagInstance,
    node: DagNode,
    completedCommit: string
  ): Promise<boolean> {
    if (!dag.targetBranch) return true; // No target = nothing to merge = success
    
    log.info(`Merging leaf to target: ${node.name} -> ${dag.targetBranch}`, {
      commit: completedCommit.slice(0, 8),
    });
    
    const repoPath = dag.repoPath;
    const targetBranch = dag.targetBranch;
    
    try {
      // =========================================================================
      // FAST PATH: Use git merge-tree (no checkout needed, no worktree conflicts)
      // =========================================================================
      this.execLog(dag.id, node.id, 'merge-ri', 'info', `Using git merge-tree for conflict-free merge...`);
      
      const mergeTreeResult = await git.merge.mergeWithoutCheckout({
        source: completedCommit,
        target: targetBranch,
        repoPath,
        log: s => {
          log.debug(s);
          this.execLog(dag.id, node.id, 'merge-ri', 'stdout', s);
        }
      });
      
      if (mergeTreeResult.success && mergeTreeResult.treeSha) {
        log.info(`Fast path: conflict-free merge via merge-tree`);
        this.execLog(dag.id, node.id, 'merge-ri', 'info', `✓ No conflicts detected`);
        
        // Create the merge commit from the tree
        const targetSha = await git.repository.resolveRef(targetBranch, repoPath);
        const commitMessage = `DAG ${dag.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`;
        
        const newCommit = await git.merge.commitTree(
          mergeTreeResult.treeSha,
          [targetSha],  // Single parent for squash-style merge
          commitMessage,
          repoPath,
          s => log.debug(s)
        );
        
        log.debug(`Created merge commit: ${newCommit.slice(0, 8)}`);
        this.execLog(dag.id, node.id, 'merge-ri', 'info', `Created merge commit: ${newCommit.slice(0, 8)}`);
        
        // Update the target branch to point to the new commit
        // We need to handle the case where target branch is checked out elsewhere
        await this.updateBranchRef(repoPath, targetBranch, newCommit);
        this.execLog(dag.id, node.id, 'merge-ri', 'info', `Updated ${targetBranch} to ${newCommit.slice(0, 8)}`);
        
        log.info(`Merged leaf ${node.name} to ${targetBranch}`, {
          commit: completedCommit.slice(0, 8),
          newCommit: newCommit.slice(0, 8),
        });
        
        // Push if configured
        const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
        const pushOnSuccess = mergeCfg.get<boolean>('pushOnSuccess', false);
        
        if (pushOnSuccess) {
          try {
            this.execLog(dag.id, node.id, 'merge-ri', 'info', `Pushing ${targetBranch} to origin...`);
            await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
            log.info(`Pushed ${targetBranch} to origin`);
            this.execLog(dag.id, node.id, 'merge-ri', 'info', `✓ Pushed to origin`);
          } catch (pushError: any) {
            log.warn(`Push failed: ${pushError.message}`);
            this.execLog(dag.id, node.id, 'merge-ri', 'error', `Push failed: ${pushError.message}`);
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
        this.execLog(dag.id, node.id, 'merge-ri', 'info', `⚠ Merge has conflicts`);
        this.execLog(dag.id, node.id, 'merge-ri', 'info', `  Conflicts: ${mergeTreeResult.conflictFiles?.join(', ')}`);
        this.execLog(dag.id, node.id, 'merge-ri', 'info', `  Invoking Copilot CLI to resolve...`);
        
        // Fall back to main repo merge with Copilot CLI resolution
        const resolved = await this.mergeWithConflictResolution(
          repoPath,
          completedCommit,
          targetBranch,
          `DAG ${dag.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`
        );
        
        if (resolved) {
          this.execLog(dag.id, node.id, 'merge-ri', 'info', `✓ Conflict resolved by Copilot CLI`);
        } else {
          this.execLog(dag.id, node.id, 'merge-ri', 'error', `✗ Copilot CLI failed to resolve conflict`);
        }
        
        return resolved;
      }
      
      log.error(`Merge-tree failed: ${mergeTreeResult.error}`);
      this.execLog(dag.id, node.id, 'merge-ri', 'error', `✗ Merge-tree failed: ${mergeTreeResult.error}`);
      return false;
      
    } catch (error: any) {
      log.error(`Failed to merge leaf to target`, {
        node: node.name,
        error: error.message,
      });
      this.execLog(dag.id, node.id, 'merge-ri', 'error', `✗ Exception: ${error.message}`);
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
    dag: DagInstance,
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
      this.execLog(dag.id, node.id, 'merge-fi', 'info', `Merging source commit ${shortSha}...`);
      
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
          this.execLog(dag.id, node.id, 'merge-fi', 'info', `✓ Merged commit ${shortSha} successfully`);
        } else if (mergeResult.hasConflicts) {
          log.info(`Merge conflict for commit ${shortSha}, using Copilot CLI to resolve`, {
            conflicts: mergeResult.conflictFiles,
          });
          this.execLog(dag.id, node.id, 'merge-fi', 'info', `⚠ Merge conflict for commit ${shortSha}`);
          this.execLog(dag.id, node.id, 'merge-fi', 'info', `  Conflicts: ${mergeResult.conflictFiles?.join(', ')}`);
          this.execLog(dag.id, node.id, 'merge-fi', 'info', `  Invoking Copilot CLI to resolve...`);
          
          // Use Copilot CLI to resolve conflicts
          const resolved = await this.resolveMergeConflictWithCopilot(
            worktreePath,
            sourceCommit,
            'HEAD',
            `Merge parent commit ${shortSha} for job ${node.name}`
          );
          
          if (!resolved) {
            log.error(`Copilot CLI failed to resolve merge conflict for commit ${shortSha}`);
            this.execLog(dag.id, node.id, 'merge-fi', 'error', `✗ Copilot CLI failed to resolve conflict`);
            await git.merge.abort(worktreePath, s => log.debug(s));
            return false;
          }
          
          log.info(`Merge conflict resolved by Copilot CLI for commit ${shortSha}`);
          this.execLog(dag.id, node.id, 'merge-fi', 'info', `✓ Conflict resolved by Copilot CLI`);
        } else {
          log.error(`Merge failed for commit ${shortSha}: ${mergeResult.error}`);
          this.execLog(dag.id, node.id, 'merge-fi', 'error', `✗ Merge failed: ${mergeResult.error}`);
          return false;
        }
      } catch (error: any) {
        log.error(`Exception merging commit ${shortSha}: ${error.message}`);
        this.execLog(dag.id, node.id, 'merge-fi', 'error', `✗ Exception: ${error.message}`);
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
    commitMessage: string
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
    
    const result = await new Promise<{ status: number | null }>((resolve) => {
      const child = spawn(copilotCmd, [], {
        cwd,
        shell: true,
        timeout: 300000, // 5 minute timeout
      });
      
      child.on('close', (code) => {
        resolve({ status: code });
      });
      
      child.on('error', (err) => {
        log.error('Copilot CLI spawn error', { error: err.message });
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
    commitMessage: string
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
        commitMessage
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
    dag: DagInstance,
    sm: DagStateMachine
  ): Promise<void> {
    const eligibleNodes: string[] = [];
    
    for (const [nodeId, state] of dag.nodeStates) {
      // Skip if not succeeded or no worktree or already cleaned
      if (state.status !== 'succeeded' || !state.worktreePath) {
        continue;
      }
      
      // Check if worktree still exists
      const fs = require('fs');
      if (!fs.existsSync(state.worktreePath)) {
        continue; // Already cleaned up
      }
      
      const node = dag.nodes.get(nodeId);
      if (!node) continue;
      
      // Leaf nodes (no dependents) - can only be cleaned up after successful merge to target
      if (node.dependents.length === 0) {
        // If there's a targetBranch, we need mergedToTarget to be true
        // If no targetBranch, there's nothing to merge so it's safe to clean up
        if (dag.targetBranch) {
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
        const depState = dag.nodeStates.get(depId);
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
        dagId: dag.id,
        nodes: eligibleNodes.map(id => dag.nodes.get(id)?.name || id),
      });
      
      for (const nodeId of eligibleNodes) {
        const state = dag.nodeStates.get(nodeId);
        if (state?.worktreePath) {
          await this.cleanupWorktree(state.worktreePath, dag.repoPath);
          state.worktreeCleanedUp = true;
        }
      }
      
      // Persist the updated state with worktreeCleanedUp flags
      this.persistence.save(dag);
    }
  }
  
  // ============================================================================
  // WORK SUMMARY
  // ============================================================================
  
  /**
   * Append a job's work summary to the DAG's aggregated summary
   */
  private appendWorkSummary(dag: DagInstance, jobSummary: JobWorkSummary): void {
    if (!dag.workSummary) {
      dag.workSummary = {
        totalCommits: 0,
        totalFilesAdded: 0,
        totalFilesModified: 0,
        totalFilesDeleted: 0,
        jobSummaries: [],
      };
    }
    
    dag.workSummary.totalCommits += jobSummary.commits;
    dag.workSummary.totalFilesAdded += jobSummary.filesAdded;
    dag.workSummary.totalFilesModified += jobSummary.filesModified;
    dag.workSummary.totalFilesDeleted += jobSummary.filesDeleted;
    dag.workSummary.jobSummaries.push(jobSummary);
  }
  
  // ============================================================================
  // EVENT WIRING
  // ============================================================================
  
  /**
   * Setup listeners on a state machine
   */
  private setupStateMachineListeners(sm: DagStateMachine): void {
    sm.on('transition', (event: NodeTransitionEvent) => {
      this.emit('nodeTransition', event);
    });
    
    sm.on('dagComplete', (event: DagCompletionEvent) => {
      const dag = this.dags.get(event.dagId);
      if (dag) {
        this.emit('dagCompleted', dag, event.status);
      }
    });
  }
}
