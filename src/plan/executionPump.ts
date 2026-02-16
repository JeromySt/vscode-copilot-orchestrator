/**
 * @fileoverview Execution Pump
 *
 * The main loop that checks for ready nodes and dispatches work.
 * Handles pump start/stop, wake lock management, and node scheduling.
 *
 * @module plan/executionPump
 */

import type { ILogger } from '../interfaces/ILogger';
import type { IProcessMonitor } from '../interfaces/IProcessMonitor';
import type {
  PlanInstance,
  JobNode,
  NodeStatus,
} from './types';
import { nodePerformsWork } from './types';
import { PlanStateMachine } from './stateMachine';
import { PlanScheduler } from './scheduler';
import { PlanPersistence } from './persistence';
import { PlanEventEmitter } from './planEvents';
import type { PowerManager } from '../core/powerManager';
import type { JobExecutor, PlanRunnerConfig } from './runner';
import type { GlobalCapacityManager } from '../core/globalCapacity';

/**
 * Shared state needed by the execution pump.
 */
export interface ExecutionPumpState {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, PlanStateMachine>;
  scheduler: PlanScheduler;
  persistence: PlanPersistence;
  executor?: JobExecutor;
  config: PlanRunnerConfig;
  globalCapacity?: GlobalCapacityManager;
  events: PlanEventEmitter;
  processMonitor?: IProcessMonitor;
  powerManager?: PowerManager;
}

/**
 * Callback invoked when a node is selected for execution.
 */
export type ExecuteNodeCallback = (
  plan: PlanInstance,
  sm: PlanStateMachine,
  node: JobNode
) => void;

/**
 * Manages the periodic pump loop that advances plan execution.
 */
export class ExecutionPump {
  private readonly state: ExecutionPumpState;
  private readonly log: ILogger;
  private readonly executeNode: ExecuteNodeCallback;
  private pumpTimer?: NodeJS.Timeout;
  private wakeLockCleanup?: () => void;
  private _acquiringWakeLock = false;
  /** Tracks how many pump cycles since last liveness check (check every ~10 seconds) */
  private _livenessCheckCounter = 0;

  constructor(state: ExecutionPumpState, log: ILogger, executeNode: ExecuteNodeCallback) {
    this.state = state;
    this.log = log;
    this.executeNode = executeNode;
  }

  /**
   * Start the pump loop.
   */
  startPump(): void {
    if (this.pumpTimer) {return;}
    this.schedulePump();
    this.log.debug('Pump started', { interval: this.state.config.pumpInterval || 1000 });
  }

  /** Schedule the next pump tick using setTimeout (avoids stacking). */
  private schedulePump(): void {
    const interval = this.state.config.pumpInterval || 1000;
    this.pumpTimer = setTimeout(() => {
      this.pump().finally(() => {
        if (this.pumpTimer !== undefined) {
          this.schedulePump();
        }
      });
    }, interval);
  }

  /**
   * Stop the pump loop.
   */
  stopPump(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
      this.log.debug('Pump stopped');
    }
  }

  /**
   * Check if any plan is currently running.
   */
  hasRunningPlans(): boolean {
    for (const plan of this.state.plans.values()) {
      const sm = this.state.stateMachines.get(plan.id);
      const status = sm?.computePlanStatus();
      if (status === 'running') {return true;}
    }
    return false;
  }

  /**
   * Update wake lock state based on running plans.
   */
  async updateWakeLock(): Promise<void> {
    const pm = this.state.powerManager;
    if (!pm) { return; }

    const hasRunning = this.hasRunningPlans();

    if (hasRunning && !this.wakeLockCleanup && !this._acquiringWakeLock) {
      this._acquiringWakeLock = true;
      try {
        this.wakeLockCleanup = await pm.acquireWakeLock('Copilot Plan execution in progress');
        this.log.info('Acquired wake lock - system sleep prevented');
      } catch (e) {
        this.log.warn('Failed to acquire wake lock', { error: e });
      } finally {
        this._acquiringWakeLock = false;
      }
    } else if (!hasRunning && this.wakeLockCleanup) {
      this.wakeLockCleanup();
      this.wakeLockCleanup = undefined;
      this.log.info('Released wake lock - system sleep allowed');
    }
  }

  /**
   * Main pump loop — called periodically to advance plan execution.
   */
  private async pump(): Promise<void> {
    if (!this.state.executor) {return;}

    // =========================================================================
    // LIVENESS WATCHDOG: Detect stale processes after hibernate/crash
    // Every ~10 pump cycles (~10s), check if any "running" node's PID is dead.
    // If dead, force-fail the node so it can be retried.
    // =========================================================================
    this._livenessCheckCounter++;
    if (this._livenessCheckCounter >= 10 && this.state.processMonitor) {
      this._livenessCheckCounter = 0;
      for (const [planId, plan] of this.state.plans) {
        const sm = this.state.stateMachines.get(planId);
        if (!sm) {continue;}
        for (const [nodeId, state] of plan.nodeStates) {
          if (state.status === 'running' && state.pid) {
            if (!this.state.processMonitor.isRunning(state.pid)) {
              const node = plan.nodes.get(nodeId);
              this.log.warn(`Watchdog: PID ${state.pid} for node "${node?.name || nodeId}" is no longer running — marking as failed (possible hibernate/crash)`);
              state.error = `Process ${state.pid} died unexpectedly (system hibernate or crash). Retry to resume.`;
              state.pid = undefined;
              state.lastAttempt = {
                phase: 'work',
                startTime: state.startedAt || Date.now(),
                endTime: Date.now(),
                error: state.error,
              };
              try {
                sm.transition(nodeId, 'failed');
                this.state.events.emit('nodeCompleted', planId, nodeId, false);
              } catch (e) {
                this.log.warn(`Watchdog: failed to transition node ${nodeId}: ${e}`);
              }
              this.state.persistence.save(plan);
            }
          }
        }
      }
    }

    // Count local running jobs and collect active plan IDs
    let localRunning = 0;
    const activePlanIds: string[] = [];

    for (const [planId, plan] of this.state.plans) {
      const sm = this.state.stateMachines.get(planId);
      if (!sm) {continue;}

      const status = sm.computePlanStatus();
      if (status === 'running') {activePlanIds.push(planId);}

      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'running' || state.status === 'scheduled') {
          const node = plan.nodes.get(nodeId);
          if (node && nodePerformsWork(node)) {localRunning++;}
        }
      }
    }

    // Update global registry
    if (this.state.globalCapacity) {
      await this.state.globalCapacity.updateRunningJobs(localRunning, activePlanIds);
    }

    const globalRunning = this.state.globalCapacity
      ? await this.state.globalCapacity.getTotalGlobalRunning()
      : localRunning;

    const totalPlans = this.state.plans.size;
    if (totalPlans > 0) {
      this.log.debug(`Pump: ${totalPlans} Plans, ${globalRunning} jobs running (${localRunning} local)`);
    }

    // Process each plan
    for (const [planId, plan] of this.state.plans) {
      const sm = this.state.stateMachines.get(planId);
      if (!sm) {continue;}

      const status = sm.computePlanStatus();
      if (status !== 'pending' && status !== 'running' && status !== 'paused') {continue;}
      if (plan.isPaused) {continue;}

      // Mark plan as started
      if (!plan.startedAt && status === 'running') {
        plan.startedAt = Date.now();
        this.state.events.emitPlanStarted(plan);
        this.updateWakeLock().catch(err => this.log.warn('Failed to update wake lock', { error: err }));
      }

      // Promote stuck pending nodes
      for (const [nodeId, state] of plan.nodeStates) {
        if (state.status === 'pending') {
          const node = plan.nodes.get(nodeId);
          if (node && sm.areDependenciesMet(nodeId)) {
            this.log.info(`Pump: promoting stuck pending node to ready: ${node.name}`);
            sm.resetNodeToPending(nodeId);
          }
        }
      }

      // Select nodes to schedule
      const nodesToSchedule = this.state.scheduler.selectNodes(plan, sm, globalRunning);

      // Log bottleneck info
      const readyNodes = sm.getReadyNodes();
      if (readyNodes.length > 0 && nodesToSchedule.length === 0) {
        const counts = sm.getStatusCounts();
        this.log.debug(`Plan ${plan.spec.name} (${planId.slice(0, 8)}): ${readyNodes.length} ready but 0 scheduled`, {
          globalRunning,
          planRunning: counts.running + counts.scheduled,
          planMaxParallel: plan.maxParallel,
        });
      }

      // Schedule and execute each node
      for (const nodeId of nodesToSchedule) {
        const node = plan.nodes.get(nodeId);
        if (!node) {continue;}
        sm.transition(nodeId, 'scheduled');
        this.executeNode(plan, sm, node as JobNode);
      }

      if (nodesToSchedule.length > 0) {
        this.state.persistence.save(plan);
      }
    }
  }
}
