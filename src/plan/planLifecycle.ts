/**
 * @fileoverview Plan Lifecycle Manager
 * Handles Plan CRUD operations and lifecycle transitions.
 * @module plan/planLifecycle
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ILogger } from '../interfaces/ILogger';
import type { IProcessMonitor } from '../interfaces/IProcessMonitor';
import type {
  PlanSpec, PlanInstance, PlanStatus, NodeStatus,
  NodeTransitionEvent, PlanCompletionEvent,
} from './types';
import { nodePerformsWork } from './types';
import { buildPlan, buildSingleJobPlan } from './builder';
import type { PlanStateMachine } from './stateMachine';
import { PlanScheduler } from './scheduler';
import { PlanPersistence } from './persistence';
import { PlanEventEmitter } from './planEvents';
import { PlanConfigManager } from './configManager';
import { OrchestratorFileWatcher } from '../core';
import { computeProgress } from './helpers';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { JobExecutor, PlanRunnerConfig } from './runner';
import type { GlobalCapacityManager, GlobalCapacityStats } from '../core/globalCapacity';
import type { PowerManager } from '../core/powerManager';

// Conditionally import vscode for UI notifications
let vscode: typeof import('vscode') | undefined;
try { vscode = require('vscode'); } catch { vscode = undefined; }

/**
 * Internal state shared between the PlanRunner sub-systems.
 */
export interface PlanRunnerState {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, PlanStateMachine>;
  scheduler: PlanScheduler;
  persistence: PlanPersistence;
  executor?: JobExecutor;
  config: PlanRunnerConfig;
  globalCapacity?: GlobalCapacityManager;
  processMonitor: IProcessMonitor;
  events: PlanEventEmitter;
  configManager: PlanConfigManager;
  stateMachineFactory: (plan: PlanInstance) => PlanStateMachine;
  copilotRunner?: import('../interfaces/ICopilotRunner').ICopilotRunner;
  powerManager?: PowerManager;
}

  /** Manages Plan CRUD operations and lifecycle transitions. */
export class PlanLifecycleManager {
  private readonly state: PlanRunnerState;
  private readonly log: ILogger;
  private readonly _fileWatcher: OrchestratorFileWatcher;
  private readonly git: IGitOperations;

  constructor(state: PlanRunnerState, log: ILogger, git: IGitOperations) {
    this.state = state;
    this.log = log;
    this.git = git;
    const workspacePath = state.config.storagePath.endsWith('plans')
      ? path.dirname(state.config.storagePath) : state.config.storagePath;
    this._fileWatcher = new OrchestratorFileWatcher(
      workspacePath,
      (planId) => this.handleExternalPlanDeletion(planId)
    );
  }

  // ── Initialization ─────────────────────────────────────────────────

  /** Load persisted plans and recover running nodes. */
  async initialize(): Promise<void> {
    this.log.info('Initializing Plan Runner');

    const loadedPlans = this.state.persistence.loadAll();
    for (const plan of loadedPlans) {
      await this.recoverRunningNodes(plan);
      this.state.plans.set(plan.id, plan);
      const sm = this.state.stateMachineFactory(plan);
      this.setupStateMachineListeners(sm);
      this.state.stateMachines.set(plan.id, sm);
    }

    this.log.info(`Loaded ${loadedPlans.length} Plans from persistence`);

    for (const plan of this.state.plans.values()) {
      this.state.persistence.save(plan);
    }
  }

  /** Persist all plans and dispose file watcher. */
  async shutdown(): Promise<void> {
    this.log.info('Shutting down Plan Runner');
    for (const plan of this.state.plans.values()) {
      this.state.persistence.save(plan);
    }
    this._fileWatcher.dispose();
  }

  /** Persist all plan state synchronously (emergency / process-exit). */
  persistSync(): void {
    for (const plan of this.state.plans.values()) {
      this.state.persistence.saveSync(plan);
    }
  }

  // ── Creation ───────────────────────────────────────────────────────

  /** Create and enqueue a Plan from a specification. */
  enqueue(spec: PlanSpec): PlanInstance {
    this.log.info(`Creating Plan: ${spec.name}`, { jobs: spec.jobs.length });

    const plan = buildPlan(spec, {
      repoPath: spec.repoPath || this.state.config.defaultRepoPath,
    });

    this.git.gitignore.ensureGitignoreEntries(plan.repoPath).catch((err: any) => {
      this.log.warn(`Failed to update main repo .gitignore: ${err.message}`);
    });

    this.state.plans.set(plan.id, plan);

    const shouldPause = spec.startPaused !== undefined ? spec.startPaused : true;
    if (shouldPause) {
      plan.isPaused = true;
    }

    const sm = this.state.stateMachineFactory(plan);
    this.setupStateMachineListeners(sm);
    this.state.stateMachines.set(plan.id, sm);

    this.state.persistence.save(plan);
    this.state.events.emitPlanCreated(plan);

    this.log.info(`Plan created: ${plan.id}`, {
      name: spec.name,
      nodes: plan.nodes.size,
      roots: plan.roots.length,
      leaves: plan.leaves.length,
      paused: shouldPause,
    });

    return plan;
  }

  /** Create a simple single-job plan. */
  enqueueJob(jobSpec: {
    name: string;
    task: string;
    work?: string;
    prechecks?: string;
    postchecks?: string;
    instructions?: string;
    baseBranch?: string;
    targetBranch?: string;
    expectsNoChanges?: boolean;
    autoHeal?: boolean;
    startPaused?: boolean;
  }): PlanInstance {
    const plan = buildSingleJobPlan(jobSpec, {
      repoPath: this.state.config.defaultRepoPath,
    });

    if (jobSpec.startPaused === true) {
      plan.isPaused = true;
    }

    this.state.plans.set(plan.id, plan);
    const sm = this.state.stateMachineFactory(plan);
    this.setupStateMachineListeners(sm);
    this.state.stateMachines.set(plan.id, sm);

    this.state.persistence.save(plan);
    this.state.events.emitPlanCreated(plan);

    this.log.info(`Single-job Plan created: ${plan.id}`, { name: jobSpec.name });
    return plan;
  }

  get(planId: string): PlanInstance | undefined {
    return this.state.plans.get(planId);
  }

  getAll(): PlanInstance[] {
    return Array.from(this.state.plans.values());
  }

  getByStatus(status: PlanStatus): PlanInstance[] {
    return Array.from(this.state.plans.values()).filter(plan => {
      const sm = this.state.stateMachines.get(plan.id);
      return sm?.computePlanStatus() === status;
    });
  }

  getStateMachine(planId: string): PlanStateMachine | undefined {
    return this.state.stateMachines.get(planId);
  }

  getStatus(planId: string): {
    plan: PlanInstance;
    status: PlanStatus;
    counts: Record<NodeStatus, number>;
    progress: number;
  } | undefined {
    const plan = this.state.plans.get(planId);
    const sm = this.state.stateMachines.get(planId);
    if (!plan || !sm) return undefined;

    const counts = sm.getStatusCounts();
    const progress = computeProgress(counts, plan.nodes.size);

    return { plan, status: sm.computePlanStatus(), counts, progress };
  }

  getGlobalStats(): { running: number; maxParallel: number; queued: number } {
    let running = 0;
    let queued = 0;

    for (const [planId, plan] of this.state.plans) {
      const sm = this.state.stateMachines.get(planId);
      if (!sm) continue;
      for (const [nodeId, state] of plan.nodeStates) {
        const node = plan.nodes.get(nodeId);
        if (!node) continue;
        if (nodePerformsWork(node)) {
          if (state.status === 'running' || state.status === 'scheduled') running++;
          else if (state.status === 'ready') queued++;
        }
      }
    }

    return { running, maxParallel: this.state.scheduler.getGlobalMaxParallel(), queued };
  }

  getEffectiveEndedAt(planId: string): number | undefined {
    const plan = this.state.plans.get(planId);
    if (!plan) return undefined;
    let max: number | undefined;
    for (const [, state] of plan.nodeStates) {
      if (state.endedAt && (!max || state.endedAt > max)) max = state.endedAt;
    }
    return max;
  }

  getEffectiveStartedAt(planId: string): number | undefined {
    const plan = this.state.plans.get(planId);
    if (!plan) return undefined;
    let min: number | undefined;
    for (const [, state] of plan.nodeStates) {
      if (state.startedAt && (!min || state.startedAt < min)) min = state.startedAt;
    }
    return min;
  }

  getRecursiveStatusCounts(planId: string): { totalNodes: number; counts: Record<NodeStatus, number> } {
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0,
    };
    const result = { totalNodes: 0, counts: { ...defaultCounts } };
    const plan = this.state.plans.get(planId);
    if (!plan) return result;
    for (const [, state] of plan.nodeStates) {
      result.totalNodes++;
      result.counts[state.status]++;
    }
    return result;
  }

  async getGlobalCapacityStats(): Promise<GlobalCapacityStats | null> {
    return (await this.state.globalCapacity?.getStats()) || null;
  }

  pause(planId: string, updateWakeLock: () => Promise<void>): boolean {
    const plan = this.state.plans.get(planId);
    if (!plan) return false;
    if (plan.isPaused) {
      this.log.info(`Plan already paused: ${planId}`);
      return true;
    }
    this.log.info(`Pausing Plan: ${planId}`);
    plan.isPaused = true;
    this.state.persistence.save(plan);
    this.state.events.emitPlanUpdated(planId);
    updateWakeLock().catch(err => this.log.warn('Failed to update wake lock', { error: err }));
    return true;
  }

  cancel(planId: string, options?: { skipPersist?: boolean }, updateWakeLock?: () => Promise<void>): boolean {
    const plan = this.state.plans.get(planId);
    const sm = this.state.stateMachines.get(planId);
    if (!plan || !sm) return false;

    this.log.info(`Canceling Plan: ${planId}`);

    for (const [nodeId, state] of plan.nodeStates) {
      if (state.status === 'running' || state.status === 'scheduled') {
        this.log.info(`Canceling node via executor`, { planId, nodeId, status: state.status });
        this.state.executor?.cancel(planId, nodeId);
      }
    }

    sm.cancelAll();

    this.cleanupPlanResources(plan).catch(err => {
      this.log.error(`Failed to cleanup canceled Plan resources`, { planId, error: err.message });
    });

    if (!options?.skipPersist) {
      this.state.persistence.save(plan);
    }

    updateWakeLock?.().catch(err => this.log.warn('Failed to update wake lock', { error: err }));
    return true;
  }

  delete(planId: string): boolean {
    const hadPlan = this.state.plans.has(planId);
    if (!hadPlan) return false;

    const plan = this.state.plans.get(planId)!;
    this.log.info(`Deleting Plan: ${planId}`);

    this.cancel(planId);

    this.state.plans.delete(planId);
    this.state.stateMachines.delete(planId);
    this.state.events.emitPlanDeleted(planId);

    try {
      this.state.persistence.delete(planId);
    } catch (err) {
      this.log.warn(`Failed to delete plan file: ${err}`);
    }

    this.cleanupPlanResources(plan).catch(err => {
      this.log.error(`Failed to cleanup Plan resources`, { planId, error: err.message });
    });

    return true;
  }

  async resume(planId: string, startPump: () => void): Promise<boolean> {
    const plan = this.state.plans.get(planId);
    if (!plan) return false;

    this.log.info(`Resuming Plan: ${planId}`);

    try {
      await this.git.repository.fetch(plan.repoPath, { all: true });
      this.log.info(`Fetched latest refs for plan ${planId} before resuming`);
    } catch (e: any) {
      this.log.warn(`Git fetch failed before resume (continuing anyway): ${e.message}`);
    }

    if (plan.isPaused) {
      plan.isPaused = false;
      this.state.events.emitPlanUpdated(planId);
    }

    if (plan.endedAt) plan.endedAt = undefined;

    startPump();
    this.state.persistence.save(plan);
    return true;
  }

  // ── Internal ───────────────────────────────────────────────────────
  private async recoverRunningNodes(plan: PlanInstance): Promise<void> {
    const markCrashed = (nodeId: string, nodeState: any, error: string) => {
      nodeState.status = 'failed';
      nodeState.error = error;
      nodeState.failureReason = 'crashed';
      nodeState.endedAt = Date.now();
      nodeState.pid = undefined;
      nodeState.version++;
      this.state.events.emitNodeCompleted(plan.id, nodeId, false);
    };
    for (const [nodeId, nodeState] of plan.nodeStates.entries()) {
      if (nodeState.status !== 'running') continue;
      if (nodeState.pid && !this.state.processMonitor.isRunning(nodeState.pid)) {
        this.log.warn(`Node ${nodeId} process (PID ${nodeState.pid}) not found - marking as crashed`);
        markCrashed(nodeId, nodeState, `Process crashed or was terminated unexpectedly (PID: ${nodeState.pid})`);
      } else if (!nodeState.pid) {
        this.log.warn(`Node ${nodeId} was running but has no PID - marking as crashed`);
        markCrashed(nodeId, nodeState, 'Extension reloaded while node was running (no process tracking)');
      }
    }
  }

  setupStateMachineListeners(sm: PlanStateMachine): void {
    sm.on('transition', (event: NodeTransitionEvent) => {
      this.state.events.emitNodeTransition(event);
    });

    sm.on('planComplete', (event: PlanCompletionEvent) => {
      const plan = this.state.plans.get(event.planId);
      if (plan) {
        this.state.events.emitPlanCompleted(plan, event.status);
      }
    });
  }

  private handleExternalPlanDeletion(planId: string): void {
    const plan = this.state.plans.get(planId);
    if (!plan) {
      this.log.debug(`External deletion of unknown plan: ${planId}`);
      return;
    }

    this.log.warn(`Plan ${planId} ("${plan.spec.name}") was deleted externally`);

    const sm = this.state.stateMachines.get(planId);
    if (sm && sm.computePlanStatus() === 'running') {
      this.log.warn(`Canceling running plan due to external file deletion`);
      this.cancel(planId, { skipPersist: true });
    }

    this.state.plans.delete(planId);
    this.state.stateMachines.delete(planId);
    this.state.events.emitPlanDeleted(planId);

    if (vscode) {
      vscode.window.showWarningMessage(
        `Plan "${plan.spec.name}" was deleted externally and has been removed.`
      );
    }
  }

  async cleanupPlanResources(plan: PlanInstance): Promise<void> {
    const repoPath = plan.repoPath;
    const cleanupErrors: string[] = [];
    const worktreePaths: string[] = [];

    for (const [, state] of plan.nodeStates) {
      if (state.worktreePath) worktreePaths.push(state.worktreePath);
    }

    this.log.info(`Cleaning up Plan resources`, { planId: plan.id, worktrees: worktreePaths.length });

    for (const worktreePath of worktreePaths) {
      try {
        await this.git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
        this.log.debug(`Removed worktree: ${worktreePath}`);
      } catch (error: any) {
        cleanupErrors.push(`worktree ${worktreePath}: ${error.message}`);
      }
    }

    if (this.state.executor) {
      try {
        const storagePath = (this.state.executor as any).storagePath;
        if (storagePath) {
          const logsDir = path.join(storagePath, 'logs');
          if (fs.existsSync(logsDir)) {
            const safePlanId = plan.id.replace(/[^a-zA-Z0-9-_]/g, '_');
            const files = fs.readdirSync(logsDir) as string[];
            let removedCount = 0;
            for (const file of files) {
              if (file.startsWith(safePlanId + '_') && file.endsWith('.log')) {
                try { fs.unlinkSync(path.join(logsDir, file)); removedCount++; } catch (e: any) {
                  cleanupErrors.push(`log file ${file}: ${e.message}`);
                }
              }
            }
            if (removedCount > 0) this.log.debug(`Removed ${removedCount} log files for plan ${plan.id}`);
          }
        }
      } catch (error: any) {
        cleanupErrors.push(`logs: ${error.message}`);
      }
    }

    if (cleanupErrors.length > 0) {
      this.log.warn(`Some cleanup operations failed`, { errors: cleanupErrors });
    } else {
      this.log.info(`Plan cleanup completed successfully`, { planId: plan.id });
    }
  }
}
