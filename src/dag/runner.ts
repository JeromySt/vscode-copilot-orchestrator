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
                       entry.type === 'info' ? '[INFO]' : '';
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
      
      // Determine base commits from dependencies (RI/FI model)
      // First commit is the base, additional commits are merged in
      const baseCommits = sm.getBaseCommitsForNode(node.id);
      const baseCommitish = baseCommits.length > 0 ? baseCommits[0] : dag.baseBranch;
      const additionalSources = baseCommits.slice(1);
      
      // Create worktree path (no branch name - detached HEAD mode)
      const worktreePath = `${dag.worktreeRoot}/${node.producerId}`;
      
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
      
      // If job has multiple dependencies, merge the additional commits into the worktree
      if (additionalSources.length > 0) {
        log.info(`Merging ${additionalSources.length} additional source commits for job ${node.name}`);
        const mergeSuccess = await this.mergeSourcesIntoWorktree(node, worktreePath, additionalSources);
        if (!mergeSuccess) {
          nodeState.error = 'Failed to merge sources from dependencies';
          sm.transition(node.id, 'failed');
          this.emit('nodeCompleted', dag.id, node.id, false);
          return;
        }
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
        
        // Handle leaf node merge to target branch
        if (dag.leaves.includes(node.id) && dag.targetBranch && nodeState.completedCommit) {
          await this.mergeLeafToTarget(dag, node, nodeState.completedCommit);
        }
        
        // Cleanup worktree if enabled (for ALL successful nodes, not just leaves)
        if (dag.cleanUpSuccessfulWork) {
          await this.cleanupWorktree(worktreePath, dag.repoPath);
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
   * Merge a leaf node's commit to target branch using a temp worktree.
   * 
   * Uses the same model as planRunner/jobRunner:
   * - Create a temp detached worktree on the target branch
   * - Checkout the target branch
   * - Squash merge the source commit
   * - Commit and optionally push
   * - Clean up the temp worktree
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
    
    const repoPath = dag.repoPath;
    const mergeWorktreePath = `${dag.worktreeRoot}/_merge_${node.id.slice(0, 8)}_${Date.now()}`;
    
    try {
      // Create a temp detached worktree on target branch
      log.debug(`Creating temp merge worktree at ${mergeWorktreePath}`);
      await git.worktrees.createDetached(
        repoPath,
        mergeWorktreePath,
        dag.targetBranch,
        s => log.debug(s)
      );
      
      // Checkout target branch in the merge worktree (we're currently detached)
      await this.runGitCommand(mergeWorktreePath, `git checkout "${dag.targetBranch}"`);
      
      // Squash merge the source commit into target
      await this.runGitCommand(mergeWorktreePath, `git merge --squash "${completedCommit}"`);
      
      // Commit the squash merge
      const commitMessage = `DAG ${dag.spec.name}: merge ${node.name} (commit ${completedCommit.slice(0, 8)})`;
      await this.runGitCommand(mergeWorktreePath, `git commit -m "${commitMessage}" || echo "no changes to commit"`);
      
      log.info(`Merged leaf ${node.name} to ${dag.targetBranch}`, {
        commit: completedCommit.slice(0, 8),
      });
      
      // Push if configured
      const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
      const pushOnSuccess = mergeCfg.get<boolean>('pushOnSuccess', false);
      
      if (pushOnSuccess) {
        try {
          await this.runGitCommand(mergeWorktreePath, `git push origin ${dag.targetBranch}`);
          log.info(`Pushed ${dag.targetBranch} to origin`);
        } catch (pushError: any) {
          log.warn(`Push failed: ${pushError.message}`);
        }
      }
      
    } catch (error: any) {
      log.error(`Failed to merge leaf to target`, {
        node: node.name,
        error: error.message,
      });
      // Don't fail the node for merge failures - it succeeded, just merge failed
    } finally {
      // Clean up the temp merge worktree
      try {
        await git.worktrees.removeSafe(repoPath, mergeWorktreePath, { force: true });
      } catch {
        try {
          const fs = require('fs');
          fs.rmSync(mergeWorktreePath, { recursive: true, force: true });
        } catch {}
      }
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
        } else if (mergeResult.hasConflicts) {
          log.error(`Merge conflict for commit ${shortSha}`, {
            conflicts: mergeResult.conflictFiles,
          });
          // TODO: Use Copilot CLI to resolve conflicts (like planRunner does)
          return false;
        } else {
          log.error(`Merge failed for commit ${shortSha}: ${mergeResult.error}`);
          return false;
        }
      } catch (error: any) {
        log.error(`Exception merging commit ${shortSha}: ${error.message}`);
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
