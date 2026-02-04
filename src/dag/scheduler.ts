/**
 * @fileoverview DAG Scheduler
 * 
 * Decides which ready nodes to execute based on:
 * - Available capacity (maxParallel)
 * - Node priority (optional)
 * - Current running count
 * 
 * The scheduler is stateless - it just picks nodes based on current state.
 * 
 * @module dag/scheduler
 */

import { DagInstance, DagNode } from './types';
import { DagStateMachine } from './stateMachine';

/**
 * Scheduler options
 */
export interface SchedulerOptions {
  /** Global max concurrent jobs */
  globalMaxParallel?: number;
}

/**
 * DAG Scheduler - picks which nodes to execute
 */
export class DagScheduler {
  private globalMaxParallel: number;
  
  constructor(options: SchedulerOptions = {}) {
    this.globalMaxParallel = options.globalMaxParallel || 8;
  }
  
  /**
   * Select nodes to schedule from a DAG.
   * 
   * @param dag - The DAG instance
   * @param stateMachine - The state machine for the DAG
   * @param currentGlobalRunning - Current number of globally running jobs
   * @returns Array of node IDs to schedule
   */
  selectNodes(
    dag: DagInstance,
    stateMachine: DagStateMachine,
    currentGlobalRunning: number = 0
  ): string[] {
    // Get ready nodes
    const readyNodes = stateMachine.getReadyNodes();
    if (readyNodes.length === 0) {
      return [];
    }
    
    // Get counts
    const counts = stateMachine.getStatusCounts();
    const currentDagRunning = counts.running + counts.scheduled;
    
    // Calculate available slots
    const dagAvailable = dag.maxParallel - currentDagRunning;
    const globalAvailable = this.globalMaxParallel - currentGlobalRunning;
    const available = Math.min(dagAvailable, globalAvailable);
    
    if (available <= 0) {
      return [];
    }
    
    // Sort by priority (optional - for now, just take first N)
    // Future: Could add priority based on:
    // - Number of dependents (more dependents = higher priority)
    // - Estimated duration
    // - User-specified priority
    const sortedNodes = this.prioritizeNodes(dag, readyNodes);
    
    // Take up to available slots
    return sortedNodes.slice(0, available);
  }
  
  /**
   * Prioritize nodes for scheduling.
   * Current strategy: Prefer nodes with more dependents (unlocks more work).
   */
  private prioritizeNodes(dag: DagInstance, nodeIds: string[]): string[] {
    return nodeIds.sort((a, b) => {
      const nodeA = dag.nodes.get(a);
      const nodeB = dag.nodes.get(b);
      
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
