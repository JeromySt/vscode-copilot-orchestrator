/**
 * @fileoverview DAG State Machine
 * 
 * The single source of truth for DAG execution state.
 * Enforces valid state transitions and emits events.
 * 
 * Key Principles:
 * - State is stored in a Map<nodeId, NodeExecutionState>
 * - All transitions go through the state machine
 * - Invalid transitions are rejected (not silently ignored)
 * - Events are emitted for all state changes
 * 
 * @module dag/stateMachine
 */

import { EventEmitter } from 'events';
import {
  DagInstance,
  NodeStatus,
  NodeExecutionState,
  DagStatus,
  NodeTransitionEvent,
  DagCompletionEvent,
  isValidTransition,
  isTerminal,
  TERMINAL_STATES,
} from './types';
import { Logger } from '../core/logger';

const log = Logger.for('dag-state');

/**
 * Events emitted by the state machine
 */
export interface StateMachineEvents {
  'transition': (event: NodeTransitionEvent) => void;
  'dagComplete': (event: DagCompletionEvent) => void;
  'nodeReady': (dagId: string, nodeId: string) => void;
}

/**
 * DAG State Machine - manages execution state for a DAG
 */
export class DagStateMachine extends EventEmitter {
  constructor(private dag: DagInstance) {
    super();
  }
  
  /**
   * Get the current status of a node
   */
  getNodeStatus(nodeId: string): NodeStatus | undefined {
    return this.dag.nodeStates.get(nodeId)?.status;
  }
  
  /**
   * Get the full execution state of a node
   */
  getNodeState(nodeId: string): NodeExecutionState | undefined {
    return this.dag.nodeStates.get(nodeId);
  }
  
  /**
   * Transition a node to a new status.
   * 
   * @param nodeId - The node to transition
   * @param newStatus - The target status
   * @param updates - Optional additional state updates
   * @returns true if transition succeeded, false if invalid
   */
  transition(
    nodeId: string,
    newStatus: NodeStatus,
    updates?: Partial<NodeExecutionState>
  ): boolean {
    const state = this.dag.nodeStates.get(nodeId);
    if (!state) {
      log.error(`Cannot transition unknown node: ${nodeId}`);
      return false;
    }
    
    const currentStatus = state.status;
    
    // Check if transition is valid
    if (!isValidTransition(currentStatus, newStatus)) {
      log.warn(`Invalid transition rejected: ${nodeId} ${currentStatus} -> ${newStatus}`, {
        dagId: this.dag.id,
      });
      return false;
    }
    
    // Apply the transition
    const oldState = { ...state };
    state.status = newStatus;
    
    // Apply additional updates
    if (updates) {
      Object.assign(state, updates);
    }
    
    // Set timestamps based on status
    const now = Date.now();
    if (newStatus === 'scheduled' && !state.scheduledAt) {
      state.scheduledAt = now;
    }
    if (newStatus === 'running' && !state.startedAt) {
      state.startedAt = now;
    }
    if (isTerminal(newStatus) && !state.endedAt) {
      state.endedAt = now;
    }
    
    log.debug(`Node transition: ${nodeId} ${currentStatus} -> ${newStatus}`, {
      dagId: this.dag.id,
      nodeName: this.dag.nodes.get(nodeId)?.name,
    });
    
    // Emit transition event
    const event: NodeTransitionEvent = {
      dagId: this.dag.id,
      nodeId,
      from: currentStatus,
      to: newStatus,
      timestamp: now,
    };
    this.emit('transition', event);
    
    // Handle state-specific side effects
    this.handleTransitionSideEffects(nodeId, currentStatus, newStatus);
    
    return true;
  }
  
  /**
   * Handle side effects of state transitions
   */
  private handleTransitionSideEffects(
    nodeId: string,
    from: NodeStatus,
    to: NodeStatus
  ): void {
    // When a node succeeds, check if dependents are now ready
    if (to === 'succeeded') {
      this.checkDependentsReady(nodeId);
    }
    
    // When a node fails, mark downstream nodes as blocked
    if (to === 'failed') {
      this.propagateBlocked(nodeId);
    }
    
    // Check if DAG is complete after any terminal transition
    if (isTerminal(to)) {
      this.checkDagCompletion();
    }
  }
  
  /**
   * Check if dependents of a succeeded node are now ready
   */
  private checkDependentsReady(succeededNodeId: string): void {
    const node = this.dag.nodes.get(succeededNodeId);
    if (!node) return;
    
    for (const dependentId of node.dependents) {
      if (this.areDependenciesMet(dependentId)) {
        const dependentState = this.dag.nodeStates.get(dependentId);
        if (dependentState?.status === 'pending') {
          this.transition(dependentId, 'ready');
          this.emit('nodeReady', this.dag.id, dependentId);
        }
      }
    }
  }
  
  /**
   * Propagate blocked status to downstream nodes
   */
  private propagateBlocked(failedNodeId: string): void {
    const visited = new Set<string>();
    const queue = [failedNodeId];
    
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const node = this.dag.nodes.get(nodeId);
      if (!node) continue;
      
      for (const dependentId of node.dependents) {
        if (visited.has(dependentId)) continue;
        visited.add(dependentId);
        
        const dependentState = this.dag.nodeStates.get(dependentId);
        if (dependentState && !isTerminal(dependentState.status)) {
          this.transition(dependentId, 'blocked', {
            error: `Blocked: dependency '${node.name}' failed`,
          });
          queue.push(dependentId);
        }
      }
    }
  }
  
  /**
   * Check if all dependencies of a node are satisfied
   */
  areDependenciesMet(nodeId: string): boolean {
    const node = this.dag.nodes.get(nodeId);
    if (!node) return false;
    
    for (const depId of node.dependencies) {
      const depState = this.dag.nodeStates.get(depId);
      if (depState?.status !== 'succeeded') {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Check if any dependency has failed
   */
  hasDependencyFailed(nodeId: string): boolean {
    const node = this.dag.nodes.get(nodeId);
    if (!node) return false;
    
    for (const depId of node.dependencies) {
      const depState = this.dag.nodeStates.get(depId);
      if (depState?.status === 'failed' || depState?.status === 'blocked') {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Check if the DAG has completed and emit event if so
   */
  private checkDagCompletion(): void {
    const status = this.computeDagStatus();
    
    // DAG is complete if status is not pending or running
    if (status !== 'pending' && status !== 'running') {
      // Update DAG end time if not set
      if (!this.dag.endedAt) {
        this.dag.endedAt = Date.now();
      }
      
      const event: DagCompletionEvent = {
        dagId: this.dag.id,
        status,
        timestamp: Date.now(),
      };
      
      log.info(`DAG completed: ${this.dag.spec.name}`, {
        dagId: this.dag.id,
        status,
        duration: this.dag.endedAt - (this.dag.startedAt || this.dag.createdAt),
      });
      
      this.emit('dagComplete', event);
    }
  }
  
  /**
   * Compute the overall DAG status from node states
   */
  computeDagStatus(): DagStatus {
    let hasRunning = false;
    let hasPending = false;
    let hasReady = false;
    let hasScheduled = false;
    let hasFailed = false;
    let hasSucceeded = false;
    let hasCanceled = false;
    
    for (const state of this.dag.nodeStates.values()) {
      switch (state.status) {
        case 'running':
          hasRunning = true;
          break;
        case 'pending':
          hasPending = true;
          break;
        case 'ready':
          hasReady = true;
          break;
        case 'scheduled':
          hasScheduled = true;
          break;
        case 'failed':
          hasFailed = true;
          break;
        case 'succeeded':
          hasSucceeded = true;
          break;
        case 'canceled':
          hasCanceled = true;
          break;
        case 'blocked':
          // Blocked nodes don't affect status directly
          break;
      }
    }
    
    // If anything is still in progress
    if (hasRunning || hasScheduled) {
      return 'running';
    }
    
    // If there are ready or pending nodes (and no running), we're still going
    if (hasReady || hasPending) {
      // Check if all pending/ready nodes are actually blocked
      const activeNonTerminal = Array.from(this.dag.nodeStates.values())
        .filter(s => s.status === 'pending' || s.status === 'ready')
        .length;
      
      if (activeNonTerminal > 0) {
        // If we have the start time, we're running
        if (this.dag.startedAt) {
          return 'running';
        }
        return 'pending';
      }
    }
    
    // All nodes are terminal - determine final status
    if (hasCanceled) {
      return 'canceled';
    }
    
    if (hasFailed && hasSucceeded) {
      return 'partial';
    }
    
    if (hasFailed) {
      return 'failed';
    }
    
    if (hasSucceeded) {
      return 'succeeded';
    }
    
    // Edge case: all blocked (no successes or failures directly)
    return 'failed';
  }
  
  /**
   * Get all nodes in a specific status
   */
  getNodesByStatus(status: NodeStatus): string[] {
    const result: string[] = [];
    for (const [nodeId, state] of this.dag.nodeStates) {
      if (state.status === status) {
        result.push(nodeId);
      }
    }
    return result;
  }
  
  /**
   * Get all nodes that are ready to be scheduled
   */
  getReadyNodes(): string[] {
    return this.getNodesByStatus('ready');
  }
  
  /**
   * Get count of nodes in each status (for progress tracking)
   */
  getStatusCounts(): Record<NodeStatus, number> {
    const counts: Record<NodeStatus, number> = {
      pending: 0,
      ready: 0,
      scheduled: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      canceled: 0,
    };
    
    for (const state of this.dag.nodeStates.values()) {
      counts[state.status]++;
    }
    
    return counts;
  }
  
  /**
   * Cancel all non-terminal nodes
   */
  cancelAll(): void {
    for (const [nodeId, state] of this.dag.nodeStates) {
      if (!isTerminal(state.status)) {
        this.transition(nodeId, 'canceled');
      }
    }
  }
  
  /**
   * Get the base commits for a node from its dependencies.
   * 
   * For RI/FI (Reverse Integration / Forward Integration) model:
   * - Root nodes (no dependencies): return empty array, caller uses baseBranch
   * - Single dependency: return that commit as the base
   * - Multiple dependencies: return all commits - first is base, rest are merged in
   * 
   * @returns Array of commit SHAs from completed dependencies
   */
  getBaseCommitsForNode(nodeId: string): string[] {
    const node = this.dag.nodes.get(nodeId);
    if (!node) return [];
    
    // If no dependencies, use the DAG's base branch (caller handles this)
    if (node.dependencies.length === 0) {
      return [];
    }
    
    // Gather commits from all completed dependencies
    const commits: string[] = [];
    for (const depId of node.dependencies) {
      const depState = this.dag.nodeStates.get(depId);
      if (depState?.completedCommit) {
        commits.push(depState.completedCommit);
      }
    }
    
    return commits;
  }
  
  /**
   * Get the base commit for a node (from its dependencies)
   * @deprecated Use getBaseCommitsForNode() for proper multi-dependency support
   */
  getBaseCommitForNode(nodeId: string): string | undefined {
    const commits = this.getBaseCommitsForNode(nodeId);
    return commits.length > 0 ? commits[0] : undefined;
  }
}
