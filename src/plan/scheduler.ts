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
  selectNodes(
    plan: PlanInstance,
    stateMachine: PlanStateMachine,
    currentGlobalRunning: number = 0
  ): string[] {
    // Get ready nodes
    const readyNodes = stateMachine.getReadyNodes();
    if (readyNodes.length === 0) {
      return [];
    }
    
    // Count only nodes that perform work (have a 'work' spec)
    // sub-plans and other coordination nodes don't consume execution resources
    let currentPlanRunning = 0;
    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'running' || state.status === 'scheduled') {
        const node = plan.nodes.get(nodeId);
        if (node && nodePerformsWork(node)) {
          currentPlanRunning++;
        }
      }
    }
    
    // Calculate available slots
    const planAvailable = plan.maxParallel - currentPlanRunning;
    const globalAvailable = this.globalMaxParallel - currentGlobalRunning;
    const available = Math.min(planAvailable, globalAvailable);
    
    if (available <= 0) {
      return [];
    }
    
    // Sort by priority (optional - for now, just take first N)
    // Future: Could add priority based on:
    // - Number of dependents (more dependents = higher priority)
    // - Estimated duration
    // - User-specified priority
    const sortedNodes = this.prioritizeNodes(plan, readyNodes);
    
    // Take up to available slots
    return sortedNodes.slice(0, available);
  }
  
  /**
   * Prioritize nodes for scheduling.
   * Current strategy: Prefer nodes with more dependents (unlocks more work).
   */
  private prioritizeNodes(plan: PlanInstance, nodeIds: string[]): string[] {
    return nodeIds.sort((a, b) => {
      const nodeA = plan.nodes.get(a);
      const nodeB = plan.nodes.get(b);
      
      if (!nodeA || !nodeB) return 0;
      
      // More dependents = higher priority (appears first)
      return nodeB.dependents.length - nodeA.dependents.length;
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
