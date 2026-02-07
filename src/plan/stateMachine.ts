/**
 * @fileoverview Plan State Machine
 * 
 * The single source of truth for Plan execution state.
 * Enforces valid state transitions and emits events.
 * 
 * Key Principles:
 * - State is stored in a Map<nodeId, NodeExecutionState>
 * - All transitions go through the state machine
 * - Invalid transitions are rejected (not silently ignored)
 * - Events are emitted for all state changes
 * 
 * @module plan/stateMachine
 */

import { EventEmitter } from 'events';
import {
  PlanInstance,
  NodeStatus,
  NodeExecutionState,
  PlanStatus,
  NodeTransitionEvent,
  PlanCompletionEvent,
  isValidTransition,
  isTerminal,
  TERMINAL_STATES,
} from './types';
import { Logger } from '../core/logger';
import {
  computeStatusCounts,
  computePlanStatus as computePlanStatusHelper,
  computeEffectiveEndedAt as computeEffectiveEndedAtHelper,
} from './helpers';

const log = Logger.for('plan-state');

/**
 * Events emitted by the state machine
 */
export interface StateMachineEvents {
  'transition': (event: NodeTransitionEvent) => void;
  'planComplete': (event: PlanCompletionEvent) => void;
  'nodeReady': (planId: string, nodeId: string) => void;
}

/**
 * Plan State Machine — manages execution state for a single Plan.
 *
 * Every node status change must flow through {@link transition}, which
 * validates the transition, sets timestamps, and emits events.
 * Side effects (blocking downstream, checking completion) are handled
 * automatically.
 *
 * @example
 * ```typescript
 * const sm = new PlanStateMachine(plan);
 * sm.on('transition', (evt) => console.log(`${evt.nodeId}: ${evt.from} → ${evt.to}`));
 * sm.transition(nodeId, 'running');
 * ```
 */
export class PlanStateMachine extends EventEmitter {
  /**
   * @param plan - The plan instance whose state this machine manages.
   */
  constructor(private plan: PlanInstance) {
    super();
  }
  
  /**
   * Get the current status of a node.
   *
   * @param nodeId - The node identifier.
   * @returns The node's current status, or `undefined` if the node is unknown.
   */
  getNodeStatus(nodeId: string): NodeStatus | undefined {
    return this.plan.nodeStates.get(nodeId)?.status;
  }
  
  /**
   * Get the full execution state of a node.
   *
   * @param nodeId - The node identifier.
   * @returns The mutable execution state, or `undefined` if the node is unknown.
   */
  getNodeState(nodeId: string): NodeExecutionState | undefined {
    return this.plan.nodeStates.get(nodeId);
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
    const state = this.plan.nodeStates.get(nodeId);
    if (!state) {
      log.error(`Cannot transition unknown node: ${nodeId}`);
      return false;
    }
    
    const currentStatus = state.status;
    
    // Check if transition is valid
    if (!isValidTransition(currentStatus, newStatus)) {
      log.warn(`Invalid transition rejected: ${nodeId} ${currentStatus} -> ${newStatus}`, {
        planId: this.plan.id,
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
      planId: this.plan.id,
      nodeName: this.plan.nodes.get(nodeId)?.name,
    });
    
    // Emit transition event
    const event: NodeTransitionEvent = {
      planId: this.plan.id,
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
    
    // Check if Plan is complete after any terminal transition
    if (isTerminal(to)) {
      this.checkPlanCompletion();
    }
  }
  
  /**
   * Check if dependents of a succeeded node are now ready
   */
  private checkDependentsReady(succeededNodeId: string): void {
    const node = this.plan.nodes.get(succeededNodeId);
    if (!node) return;
    
    for (const dependentId of node.dependents) {
      if (this.areDependenciesMet(dependentId)) {
        const dependentState = this.plan.nodeStates.get(dependentId);
        if (dependentState?.status === 'pending') {
          this.transition(dependentId, 'ready');
          this.emit('nodeReady', this.plan.id, dependentId);
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
      const node = this.plan.nodes.get(nodeId);
      if (!node) continue;
      
      for (const dependentId of node.dependents) {
        if (visited.has(dependentId)) continue;
        visited.add(dependentId);
        
        const dependentState = this.plan.nodeStates.get(dependentId);
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
   * Check if all dependencies of a node have succeeded.
   *
   * @param nodeId - The node to check.
   * @returns `true` if every dependency is in `'succeeded'` status, `false` otherwise.
   */
  areDependenciesMet(nodeId: string): boolean {
    const node = this.plan.nodes.get(nodeId);
    if (!node) return false;
    
    for (const depId of node.dependencies) {
      const depState = this.plan.nodeStates.get(depId);
      if (depState?.status !== 'succeeded') {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Check if any dependency of a node has failed or been blocked.
   *
   * @param nodeId - The node to check.
   * @returns `true` if at least one dependency is in `'failed'` or `'blocked'` status.
   */
  hasDependencyFailed(nodeId: string): boolean {
    const node = this.plan.nodes.get(nodeId);
    if (!node) return false;
    
    for (const depId of node.dependencies) {
      const depState = this.plan.nodeStates.get(depId);
      if (depState?.status === 'failed' || depState?.status === 'blocked') {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Check if the Plan has completed and emit event if so
   */
  private checkPlanCompletion(): void {
    const status = this.computePlanStatus();
    
    // Plan is complete if status is not pending or running
    if (status !== 'pending' && status !== 'running') {
      // Update Plan end time - compute from node endedAt values for accuracy
      if (!this.plan.endedAt) {
        this.plan.endedAt = this.computeEffectiveEndedAt() || Date.now();
      }
      
      const event: PlanCompletionEvent = {
        planId: this.plan.id,
        status,
        timestamp: Date.now(),
      };
      
      log.info(`Plan completed: ${this.plan.spec.name}`, {
        planId: this.plan.id,
        status,
        duration: this.plan.endedAt - (this.plan.startedAt || this.plan.createdAt),
      });
      
      this.emit('planComplete', event);
    }
  }
  
  /**
   * Compute the effective endedAt time from node data.
   * This returns the maximum endedAt across all nodes, which is the true
   * completion time even if child plans took longer than originally recorded.
   * 
   * @returns The computed endedAt timestamp, or undefined if no nodes have ended
   */
  computeEffectiveEndedAt(): number | undefined {
    return computeEffectiveEndedAtHelper(this.plan.nodeStates.values());
  }
  
  /**
   * Compute the overall Plan status from all node states.
   *
   * @returns Derived {@link PlanStatus} (`'pending'`, `'running'`, `'succeeded'`, etc.).
   */
  computePlanStatus(): PlanStatus {
    return computePlanStatusHelper(this.plan.nodeStates.values(), !!this.plan.startedAt);
  }
  
  /**
   * Get all node IDs currently in the given status.
   *
   * @param status - The status to filter by.
   * @returns Array of matching node IDs.
   */
  getNodesByStatus(status: NodeStatus): string[] {
    const result: string[] = [];
    for (const [nodeId, state] of this.plan.nodeStates) {
      if (state.status === status) {
        result.push(nodeId);
      }
    }
    return result;
  }
  
  /**
   * Get all node IDs that are ready to be scheduled (dependencies met).
   *
   * @returns Array of `'ready'` node IDs.
   */
  getReadyNodes(): string[] {
    return this.getNodesByStatus('ready');
  }
  
  /**
   * Reset a node to pending/ready state for retry.
   * This bypasses normal transition validation since it's a retry scenario.
   * Also unblocks any downstream nodes that were blocked due to this node's failure.
   * 
   * @param nodeId - The node to reset
   * @returns true if reset succeeded
   */
  resetNodeToPending(nodeId: string): boolean {
    const state = this.plan.nodeStates.get(nodeId);
    if (!state) {
      log.error(`Cannot reset unknown node: ${nodeId}`);
      return false;
    }
    
    const oldStatus = state.status;
    
    // Check if dependencies are met to determine if we go to 'pending' or 'ready'
    const newStatus = this.areDependenciesMet(nodeId) ? 'ready' : 'pending';
    
    state.status = newStatus;
    
    log.info(`Node reset for retry: ${nodeId} ${oldStatus} -> ${newStatus}`, {
      planId: this.plan.id,
      nodeName: this.plan.nodes.get(nodeId)?.name,
    });
    
    // Emit transition event
    const event: NodeTransitionEvent = {
      planId: this.plan.id,
      nodeId,
      from: oldStatus,
      to: newStatus,
      timestamp: Date.now(),
    };
    this.emit('transition', event);
    
    // If we're ready, emit nodeReady
    if (newStatus === 'ready') {
      this.emit('nodeReady', this.plan.id, nodeId);
    }
    
    // Unblock any downstream nodes that were blocked due to this node
    this.unblockDownstream(nodeId);
    
    return true;
  }
  
  /**
   * Unblock downstream nodes that were blocked due to a node's failure.
   * Called when a failed node is being retried.
   */
  private unblockDownstream(nodeId: string): void {
    const node = this.plan.nodes.get(nodeId);
    if (!node) return;
    
    for (const dependentId of node.dependents) {
      const dependentState = this.plan.nodeStates.get(dependentId);
      if (dependentState?.status === 'blocked') {
        // Check if this is the only failed/blocked dependency
        if (!this.hasDependencyFailed(dependentId)) {
          // Reset to pending (it will become ready when this node succeeds)
          dependentState.status = 'pending';
          dependentState.error = undefined;
          
          log.debug(`Unblocked downstream node: ${dependentId}`, {
            planId: this.plan.id,
            nodeName: this.plan.nodes.get(dependentId)?.name,
          });
          
          // Recursively unblock further downstream
          this.unblockDownstream(dependentId);
        }
      }
    }
  }
  
  /**
   * Get count of nodes in each status (for progress tracking).
   *
   * @returns Record keyed by {@link NodeStatus} with integer counts.
   */
  getStatusCounts(): Record<NodeStatus, number> {
    return computeStatusCounts(this.plan.nodeStates.values());
  }
  
  /**
   * Cancel all non-terminal nodes by transitioning them to `'canceled'`.
   */
  cancelAll(): void {
    for (const [nodeId, state] of this.plan.nodeStates) {
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
    const node = this.plan.nodes.get(nodeId);
    if (!node) return [];
    
    // If no dependencies, use the Plan's base branch (caller handles this)
    if (node.dependencies.length === 0) {
      return [];
    }
    
    // Gather commits from all completed dependencies
    const commits: string[] = [];
    for (const depId of node.dependencies) {
      const depState = this.plan.nodeStates.get(depId);
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
  
  /**
   * Get the effective plan end time, falling back to the stored value.
   *
   * More accurate than `plan.endedAt` when child plans ran asynchronously.
   *
   * @returns Timestamp in ms, or `undefined` if the plan hasn't ended.
   */
  getEffectiveEndedAt(): number | undefined {
    // First try the computed value from node data
    const computed = this.computeEffectiveEndedAt();
    if (computed) return computed;
    
    // Fall back to stored value
    return this.plan.endedAt;
  }
}
