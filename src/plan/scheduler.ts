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
 * Plan Scheduler - picks which nodes to execute
 */
export class PlanScheduler {
  private globalMaxParallel: number;
  
  constructor(options: SchedulerOptions = {}) {
    this.globalMaxParallel = options.globalMaxParallel || 8;
  }
  
  /**
   * Select nodes to schedule from a Plan.
   * 
   * @param Plan - The Plan instance
   * @param stateMachine - The state machine for the Plan
   * @param currentGlobalRunning - Current number of globally running jobs (excluding sub-plan coordination nodes)
   * @returns Array of node IDs to schedule
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
   * Update global max parallel setting
   */
  setGlobalMaxParallel(max: number): void {
    this.globalMaxParallel = max;
  }
  
  /**
   * Get current global max parallel setting
   */
  getGlobalMaxParallel(): number {
    return this.globalMaxParallel;
  }
}
