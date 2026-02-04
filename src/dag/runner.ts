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

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
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
  getNodeLogs(dagId: string, nodeId: string, phase?: 'all' | 'prechecks' | 'work' | 'postchecks' | 'commit'): string {
    if (!this.executor) return '';
    
    let logs: LogEntry[] = [];
    if (phase && phase !== 'all' && this.executor.getLogsForPhase) {
      logs = this.executor.getLogsForPhase(dagId, nodeId, phase);
    } else if (this.executor.getLogs) {
      logs = this.executor.getLogs(dagId, nodeId);
    }
    
    if (logs.length === 0) return 'No logs available.';
    
    return logs.map((entry: LogEntry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const prefix = entry.type === 'stderr' ? '[ERR]' : 
                     entry.type === 'info' ? '[INFO]' : '';
      return `[${time}] ${prefix} ${entry.message}`;
    }).join('\n');
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
    
    // Remove from memory
    this.dags.delete(dagId);
    this.stateMachines.delete(dagId);
    
    // Remove from persistence
    this.persistence.delete(dagId);
    
    return true;
  }
  
  /**
   * Retry failed nodes in a DAG
   */
  retry(dagId: string): boolean {
    const dag = this.dags.get(dagId);
    const sm = this.stateMachines.get(dagId);
    if (!dag || !sm) return false;
    
    log.info(`Retrying DAG: ${dagId}`);
    
    // This is a simplified retry - in practice, we might need to:
    // 1. Reset failed nodes to pending/ready
    // 2. Clear blocked nodes that could now proceed
    // For now, just log - actual retry logic needs more thought
    
    return false; // TODO: Implement proper retry
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
    
    // Count total running jobs across all DAGs
    let globalRunning = 0;
    for (const sm of this.stateMachines.values()) {
      const counts = sm.getStatusCounts();
      globalRunning += counts.running + counts.scheduled;
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
      
      // Get nodes to schedule
      const nodesToSchedule = this.scheduler.selectNodes(dag, sm, globalRunning);
      
      // Schedule each node
      for (const nodeId of nodesToSchedule) {
        const node = dag.nodes.get(nodeId);
        if (!node) continue;
        
        // Mark as scheduled
        sm.transition(nodeId, 'scheduled');
        globalRunning++;
        
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
      
      // Determine base commit
      const baseCommit = sm.getBaseCommitForNode(node.id);
      
      // Create worktree
      const branchName = `dag-${dag.id.slice(0, 8)}/${node.producerId}`;
      const worktreePath = `${dag.worktreeRoot}/${node.producerId}`;
      
      // Store in state
      nodeState.branchName = branchName;
      nodeState.worktreePath = worktreePath;
      
      // Setup worktree
      await this.setupWorktree(dag, node, baseCommit, branchName, worktreePath);
      
      // Build execution context
      const context: ExecutionContext = {
        dag,
        node,
        baseCommit: baseCommit || dag.baseBranch,
        worktreePath,
        branchName,
        onProgress: (step) => {
          log.debug(`Job progress: ${node.name} - ${step}`);
        },
      };
      
      // Execute
      const result = await this.executor!.execute(context);
      
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
        
        // Handle leaf node merge
        if (dag.leaves.includes(node.id) && dag.targetBranch) {
          await this.mergeLeafToTarget(dag, node, nodeState.completedCommit!);
        }
        
        // Cleanup worktree if enabled
        if (dag.cleanUpSuccessfulWork && dag.leaves.includes(node.id)) {
          await this.cleanupWorktree(worktreePath, branchName, dag.repoPath);
        }
        
        sm.transition(node.id, 'succeeded');
        this.emit('nodeCompleted', dag.id, node.id, true);
        
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
        this.handleChildDagComplete(parentDag, sm, node, event);
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
  private handleChildDagComplete(
    parentDag: DagInstance,
    parentSm: DagStateMachine,
    node: SubDagNode,
    event: DagCompletionEvent
  ): void {
    log.info(`Child DAG completed: ${event.dagId}`, {
      parentDagId: parentDag.id,
      parentNodeId: node.id,
      status: event.status,
    });
    
    const nodeState = parentDag.nodeStates.get(node.id);
    
    if (event.status === 'succeeded') {
      // Get the final commit from the child DAG's leaf nodes
      const childDag = this.dags.get(event.dagId);
      if (childDag && nodeState) {
        // Find a completed commit from leaf nodes
        for (const leafId of childDag.leaves) {
          const leafState = childDag.nodeStates.get(leafId);
          if (leafState?.completedCommit) {
            nodeState.completedCommit = leafState.completedCommit;
            break;
          }
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
   * Setup worktree for a job
   */
  private async setupWorktree(
    dag: DagInstance,
    node: JobNode,
    baseCommit: string | undefined,
    branchName: string,
    worktreePath: string
  ): Promise<void> {
    const repoPath = dag.repoPath;
    const base = baseCommit || dag.baseBranch;
    
    log.debug(`Setting up worktree: ${worktreePath}`, {
      branch: branchName,
      base,
    });
    
    await git.worktrees.create({
      repoPath,
      worktreePath,
      branchName,
      fromRef: base,
    });
  }
  
  /**
   * Merge a leaf node's commit to target branch
   */
  private async mergeLeafToTarget(
    dag: DagInstance,
    node: JobNode,
    completedCommit: string
  ): Promise<void> {
    if (!dag.targetBranch) return;
    
    log.info(`Merging leaf to target: ${node.name} -> ${dag.targetBranch}`, {
      commit: completedCommit.slice(0, 8),
    });
    
    try {
      // First checkout the target branch, then merge
      await git.branches.checkout(dag.repoPath, dag.targetBranch);
      await git.merge.merge({
        source: completedCommit,
        target: dag.targetBranch,
        cwd: dag.repoPath,
        message: `Merge ${node.name} from DAG ${dag.spec.name}`
      });
    } catch (error: any) {
      log.error(`Failed to merge leaf to target`, {
        node: node.name,
        error: error.message,
      });
      // Don't fail the node for merge failures - it succeeded, just merge failed
    }
  }
  
  /**
   * Clean up a worktree after successful completion
   */
  private async cleanupWorktree(
    worktreePath: string,
    branchName: string,
    repoPath: string
  ): Promise<void> {
    log.debug(`Cleaning up worktree: ${worktreePath}`);
    
    try {
      await git.worktrees.remove(repoPath, worktreePath);
      await git.branches.remove(branchName, repoPath, { force: true });
    } catch (error: any) {
      log.warn(`Failed to cleanup worktree`, {
        path: worktreePath,
        error: error.message,
      });
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
