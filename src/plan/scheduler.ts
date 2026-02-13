/**
 * @fileoverview Plan Scheduler
 * 
 * Decides which ready nodes to execute based on:
 * - Available capacity (maxParallel)
 * - Node priority (optional)
 * - Current running count
 * 
 * The scheduler is stateless - it just picks nodes based on current state.
 * 
 * @module plan/scheduler
 */

import { PlanInstance, PlanNode, nodePerformsWork } from './types';
import { PlanStateMachine } from './stateMachine';

/**
 * Scheduler options
 */
export interface SchedulerOptions {
  /** Global max concurrent jobs */
  globalMaxParallel?: number;
}

/**
 * Stateless scheduler that decides which ready nodes to execute.
 *
 * Takes current capacity (plan-level and global), and returns up to
 * `available` node IDs sorted by priority (most dependents first).
 *
 * Sub-plan coordination nodes do not consume execution slots.
 */
export class PlanScheduler {
  private globalMaxParallel: number;
  
  /**
   * @param options - Scheduler configuration.
   */
  constructor(options: SchedulerOptions = {}) {
    this.globalMaxParallel = options.globalMaxParallel || 8;
  }
  
  /**
   * Select ready nodes to schedule, respecting plan-level and global capacity.
   *
   * @param plan                 - The plan instance to schedule from.
   * @param stateMachine         - State machine for querying node readiness.
   * @param currentGlobalRunning - Count of globally running job nodes (excludes sub-plan coordinators).
   * @returns Array of node IDs to schedule, sorted by priority (most dependents first).
   */
  /**
   * Select ready nodes to schedule, respecting plan-level and global capacity.
   *
   * Algorithm:
   * 1. Find all nodes with status 'ready' (dependencies satisfied)
   * 2. Count currently running/scheduled work nodes (coordination nodes don't count)
   * 3. Calculate available capacity from both plan-level and global limits
   * 4. Prioritize nodes by dependent count (nodes that unlock more work go first)
   * 5. Return the top N nodes that fit within available capacity
   *
   * @param plan                 - The plan instance to schedule from.
   * @param stateMachine         - State machine for querying node readiness.
   * @param currentGlobalRunning - Count of globally running job nodes (excludes sub-plan coordinators).
   * @returns Array of node IDs to schedule, sorted by priority (most dependents first).
   */
  selectNodes(
    plan: PlanInstance,
    stateMachine: PlanStateMachine,
    currentGlobalRunning: number = 0
  ): string[] {
    // Step 1: Get all nodes that are ready to execute
    // Ready = all dependencies are satisfied (succeeded or skipped)
    const readyNodes = stateMachine.getReadyNodes();
    if (readyNodes.length === 0) {
      return []; // No work to schedule
    }
    
    // Step 2: Count currently executing work nodes in this plan
    // Only nodes that perform actual work (have a 'work' spec) count against limits
    // Coordination nodes (sub-plans, merge nodes) don't consume execution resources
    let currentPlanRunning = 0;
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'running' || state.status === 'scheduled') {
        const node = plan.nodes.get(nodeId);
        if (node && nodePerformsWork(node)) {
          currentPlanRunning++;
        }
      }
    }
    
    // Step 3: Calculate available execution slots
    // Must respect both plan-level limits and global system limits
    const planAvailable = plan.maxParallel - currentPlanRunning;
    const globalAvailable = this.globalMaxParallel - currentGlobalRunning;
    const available = Math.min(planAvailable, globalAvailable);
    
    if (available <= 0) {
      return []; // No capacity available
    }
    
    // Step 4: Prioritize nodes for optimal scheduling
    // Strategy: Schedule nodes that unlock the most downstream work first
    // This maximizes parallelism potential for subsequent scheduling rounds
    const sortedNodes = this.prioritizeNodes(plan, readyNodes);
    
    // Step 5: Take up to available slots
    return sortedNodes.slice(0, available);
  }
  
  /**
   * Prioritize nodes for scheduling.
   * 
   * Current strategy: Prefer nodes with more dependents to maximize parallelism.
   * 
   * Rationale:
   * - Nodes with many dependents are "bottlenecks" in the dependency graph
   * - Completing them first unlocks the most downstream work
   * - This leads to better overall parallelism and shorter total execution time
   * 
   * Future enhancements could consider:
   * - Estimated execution time (shorter tasks first for quick wins)
   * - User-specified priority weights
   * - Resource requirements (CPU vs memory intensive tasks)
   * - Critical path analysis (longest path to completion)
   * 
   * @param plan - The plan containing dependency information
   * @param nodeIds - Node IDs to prioritize
   * @returns Node IDs sorted by priority (highest priority first)
   */
  private prioritizeNodes(plan: PlanInstance, nodeIds: string[]): string[] {
    return nodeIds.sort((a, b) => {
      const nodeA = plan.nodes.get(a);
      const nodeB = plan.nodes.get(b);
      
      if (!nodeA || !nodeB) return 0;
      
      // Primary sort: More dependents = higher priority
      // Nodes with more dependents appear first in the returned array
      const dependentDiff = nodeB.dependents.length - nodeA.dependents.length;
      
      if (dependentDiff !== 0) {
        return dependentDiff;
      }
      
      // Secondary sort (tie-breaker): Alphabetical by name for deterministic ordering
      // This ensures consistent scheduling behavior across runs
      return (nodeA.name || nodeA.id).localeCompare(nodeB.name || nodeB.id);
    });
  }
  
  /**
   * Update the global maximum number of parallel jobs.
   *
   * @param max - New limit.
   */
  setGlobalMaxParallel(max: number): void {
    this.globalMaxParallel = max;
  }
  
  /**
   * Get the current global maximum parallel jobs setting.
   *
   * @returns The current limit.
   */
  getGlobalMaxParallel(): number {
    return this.globalMaxParallel;
  }
}
