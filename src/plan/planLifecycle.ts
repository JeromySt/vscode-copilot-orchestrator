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
  planRepository?: import('../interfaces/IPlanRepository').IPlanRepository;
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
      // Legacy migration: if repository store is available, migrate legacy plan-{id}.json to new directory format
      if (this.state.planRepository) {
        try {
          const legacyFile = path.join(this.state.persistence.getStoragePath(), `plan-${plan.id}.json`);
          const newPlanDir = path.join(this.state.persistence.getStoragePath(), plan.id);
          const newPlanFile = path.join(newPlanDir, 'plan.json');
          
          // Check if legacy file exists but new structure doesn't
          if (fs.existsSync(legacyFile) && !fs.existsSync(newPlanFile)) {
            this.log.info(`Migrating legacy plan format for ${plan.id}`);
            await this.state.planRepository.migrateLegacy(plan.id);
          }
          // Remove legacy file if new format now exists (migration succeeded or was already done)
          if (fs.existsSync(legacyFile) && fs.existsSync(newPlanFile)) {
            fs.unlinkSync(legacyFile);
            this.log.info(`Removed legacy plan file for ${plan.id}`);
          }
        } catch (err) {
          this.log.warn(`Failed to migrate legacy format for plan ${plan.id}, continuing with existing format`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      
      await this.recoverRunningNodes(plan);
      this.state.plans.set(plan.id, plan);
      const sm = this.state.stateMachineFactory(plan);
      this.setupStateMachineListeners(sm);
      this.state.stateMachines.set(plan.id, sm);
    }

    this.log.info(`Loaded ${loadedPlans.length} Plans from legacy persistence`);

    // Load plans from new directory format (<planId>/plan.json) that aren't already loaded
    if (this.state.planRepository) {
      try {
        const repoPlans = await this.state.planRepository.list();
        for (const summary of repoPlans) {
          if (this.state.plans.has(summary.id)) { continue; } // Already loaded from legacy
          try {
            const plan = await this.state.planRepository.loadState(summary.id);
            if (plan) {
              await this.recoverRunningNodes(plan);
              this.state.plans.set(plan.id, plan);
              const sm = this.state.stateMachineFactory(plan);
              this.setupStateMachineListeners(sm);
              this.state.stateMachines.set(plan.id, sm);
              this.log.info(`Loaded plan from repository: ${plan.id} (${plan.spec.name})`);
            }
          } catch (err) {
            this.log.warn(`Failed to load plan ${summary.id} from repository`, { error: err instanceof Error ? err.message : String(err) });
          }
        }
      } catch (err) {
        this.log.warn('Failed to list plans from repository', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.log.info(`Total plans loaded: ${this.state.plans.size}`);

    // Disable legacy persistence saves now that migration is complete
    if (this.state.planRepository) {
      this.state.persistence.disableSaves();
    }

    // Re-persist plans after recovery (use new repository format if available, skip legacy)
    for (const plan of this.state.plans.values()) {
      if (this.state.planRepository) {
        try {
          this.state.planRepository.saveStateSync(plan);
        } catch {
          // Fallback to legacy persistence if repository save fails
          this.state.persistence.save(plan);
        }
      } else {
        this.state.persistence.save(plan);
      }
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
      nodes: plan.jobs.size,
      roots: plan.roots.length,
      leaves: plan.leaves.length,
      paused: shouldPause,
    });

    return plan;
  }

  /** Register an already-built PlanInstance (from IPlanRepository) with the runner. */
  registerPlan(plan: PlanInstance): void {
    this.log.info(`Registering existing plan: ${plan.id}`, { name: plan.spec.name });

    // Scaffolding plans must always be paused — they're not ready to execute
    if ((plan.spec as any)?.status === 'scaffolding') {
      plan.isPaused = true;
    }

    this.state.plans.set(plan.id, plan);

    const sm = this.state.stateMachineFactory(plan);
    this.setupStateMachineListeners(sm);
    this.state.stateMachines.set(plan.id, sm);

    // Save via repository (not legacy persistence)
    if (this.state.planRepository) {
      try { this.state.planRepository.saveStateSync(plan); } catch { /* ignore */ }
    }

    this.state.events.emitPlanCreated(plan);

    this.log.info(`Plan registered: ${plan.id}`, {
      name: plan.spec.name,
      nodes: plan.jobs.size,
      paused: plan.isPaused,
    });
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
    if (!plan || !sm) {return undefined;}

    const counts = sm.getStatusCounts();
    const progress = computeProgress(counts, plan.jobs.size);

    return { plan, status: sm.computePlanStatus(), counts, progress };
  }

  getGlobalStats(): { running: number; maxParallel: number; queued: number } {
    let running = 0;
    let queued = 0;

    for (const [planId, plan] of this.state.plans) {
      const sm = this.state.stateMachines.get(planId);
      if (!sm) {continue;}
      for (const [nodeId, state] of plan.nodeStates) {
        const node = plan.jobs.get(nodeId);
        if (!node) {continue;}
        if (nodePerformsWork(node)) {
          if (state.status === 'running' || state.status === 'scheduled') {running++;}
          else if (state.status === 'ready') {queued++;}
        }
      }
    }

    return { running, maxParallel: this.state.scheduler.getGlobalMaxParallel(), queued };
  }

  getEffectiveEndedAt(planId: string): number | undefined {
    const plan = this.state.plans.get(planId);
    if (!plan) {return undefined;}
    let max: number | undefined;
    for (const [, state] of plan.nodeStates) {
      if (state.endedAt && (!max || state.endedAt > max)) {max = state.endedAt;}
    }
    return max;
  }

  getEffectiveStartedAt(planId: string): number | undefined {
    const plan = this.state.plans.get(planId);
    if (!plan) {return undefined;}
    let min: number | undefined;
    for (const [, state] of plan.nodeStates) {
      if (state.startedAt && (!min || state.startedAt < min)) {min = state.startedAt;}
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
    if (!plan) {return result;}
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
    if (!plan) {return false;}
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
    if (!plan || !sm) {return false;}

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
      // Persist via plan repository (the authoritative store)
      if (this.state.planRepository) {
        try { this.state.planRepository.saveStateSync(plan); } catch { /* ignore */ }
      }
      this.state.persistence.save(plan);
    }

    updateWakeLock?.().catch(err => this.log.warn('Failed to update wake lock', { error: err }));
    return true;
  }

  delete(planId: string): boolean {
    const hadPlan = this.state.plans.has(planId);
    if (!hadPlan) {return false;}

    const plan = this.state.plans.get(planId)!;
    this.log.info(`Deleting Plan: ${planId}`);

    this.cancel(planId);

    this.state.plans.delete(planId);
    this.state.stateMachines.delete(planId);
    this.state.events.emitPlanDeleted(planId);

    // Delete plan data — use new repository (handles plans/<uuid>/ directory + index)
    if (this.state.planRepository) {
      // Write tombstone SYNCHRONOUSLY so the plan won't be rehydrated even if
      // the extension reloads before the async physical cleanup finishes.
      try {
        this.state.planRepository.markDeletedSync(planId);
      } catch (err) {
        this.log.warn(`Failed to write sync delete tombstone: ${err}`);
      }
      // Physical cleanup is async (directory removal, index update).
      this.state.planRepository.delete(planId).catch(err => {
        this.log.warn(`Failed to delete plan via repository: ${err}`);
      });
    }
    // Also try legacy persistence for old-format files
    try {
      this.state.persistence.delete(planId);
    } catch (err) {
      this.log.warn(`Failed to delete legacy plan file: ${err}`);
    }

    this.cleanupPlanResources(plan).catch(err => {
      this.log.error(`Failed to cleanup Plan resources`, { planId, error: err.message });
    });

    return true;
  }

  async resume(planId: string, startPump: () => void): Promise<boolean> {
    const plan = this.state.plans.get(planId);
    if (!plan) {return false;}

    // Scaffolding plans cannot be resumed — they must be finalized first
    if ((plan.spec as any)?.status === 'scaffolding') {
      this.log.warn(`Cannot resume scaffolding plan ${planId} — use finalize_copilot_plan first`);
      return false;
    }

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

    if (plan.endedAt) {plan.endedAt = undefined;}

    startPump();
    this.state.persistence.save(plan);
    return true;
  }

  /**
   * Ensure the target branch ref exists locally.
   * Called by the pump's ensureBranchReady callback before any nodes execute.
   * Subsequent calls are no-ops if the branch already exists.
   * Throws on failure — the plan must not proceed without a valid target ref.
   */
  async ensureTargetBranch(plan: PlanInstance): Promise<void> {
    const { repoPath } = plan;
    const targetBranch = plan.spec.targetBranch!;
    const baseBranch = plan.spec.baseBranch!;

    const exists = await this.git.branches.exists(targetBranch, repoPath);
    if (!exists) {
      await this.git.branches.create(targetBranch, baseBranch, repoPath);
      this.log.info(`Created target branch '${targetBranch}' from '${baseBranch}'`);
    }
  }

  /**
   * Checkout the target branch and commit orchestrator .gitignore entries
   * if they are missing. If the repository was on a different named branch
   * before this call (i.e., currentBranch is non-null and not the target),
   * that original branch is restored afterward.
   */
  async commitGitignoreEntries(plan: PlanInstance): Promise<void> {
    const { repoPath } = plan;
    const targetBranch = plan.spec.targetBranch!;

    const currentBranch = await this.git.branches.currentOrNull(repoPath);
    try {
      await this.git.branches.checkout(repoPath, targetBranch);

      const modified = await this.git.gitignore.ensureGitignoreEntries(repoPath);
      if (modified) {
        await this.git.repository.stageFile(repoPath, '.gitignore');
        await this.git.repository.commit(
          repoPath,
          'chore: add orchestrator .gitignore entries',
          { allowEmpty: false },
        );
        this.log.info(`Committed .gitignore orchestrator entries to '${targetBranch}'`);
      }
    } finally {
      if (currentBranch && currentBranch !== targetBranch) {
        await this.git.branches.checkout(repoPath, currentBranch);
      }
    }
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
      if (nodeState.status !== 'running') {continue;}
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

    sm.on('planComplete', async (event: PlanCompletionEvent) => {
      const plan = this.state.plans.get(event.planId);
      if (!plan) { return; }

      // On success, clean up the snapshot branch + worktree.
      // The SV node already handled the actual merge-RI to targetBranch —
      // FinalMergeExecutor was a redundant second merge that served no purpose.
      if (event.status === 'succeeded' && plan.snapshot) {
        this.log.info(`Plan succeeded — cleaning up snapshot branch and worktree`);
        try {
          const { SnapshotManager } = await import('./phases/snapshotManager');
          const snapshotMgr = new SnapshotManager(this.git);
          await snapshotMgr.cleanupSnapshot(plan.snapshot, plan.repoPath, s => this.log.debug(s));
          plan.snapshot = undefined;
          this.log.info('Snapshot cleanup complete');
        } catch (e: any) {
          this.log.warn(`Snapshot cleanup failed (non-fatal): ${e.message}`);
        }
        // Save state regardless of cleanup success
        this.state.persistence.save(plan);
      }

      this.state.events.emitPlanCompleted(plan, event.status);
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

    const snapshotWorktreePath = plan.snapshot?.worktreePath;
    for (const [, state] of plan.nodeStates) {
      if (state.worktreePath && state.worktreePath !== snapshotWorktreePath) {
        worktreePaths.push(state.worktreePath);
      }
    }

    this.log.info(`Cleaning up Plan resources`, { planId: plan.id, worktrees: worktreePaths.length });

    // Clean up the snapshot worktree + branch first (if present).
    if (plan.snapshot) {
      try {
        const { SnapshotManager } = await import('./phases/snapshotManager');
        const snapshotMgr = new SnapshotManager(this.git);
        await snapshotMgr.cleanupSnapshot(plan.snapshot, repoPath, s => this.log.debug(s));
        plan.snapshot = undefined;
      } catch (error: any) {
        cleanupErrors.push(`snapshot: ${error.message}`);
      }
    }

    for (const worktreePath of worktreePaths) {
      try {
        await this.git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
        this.log.debug(`Removed worktree: ${worktreePath}`);
      } catch (error: any) {
        cleanupErrors.push(`worktree ${worktreePath}: ${error.message}`);
      }
    }

    // Defensive: delete the orchestrator/snapshot/<planId> branch even if
    // plan.snapshot was never set (race: cancel during snapshot creation).
    if (!plan.snapshot) {
      const orphanBranch = `orchestrator/snapshot/${plan.id}`;
      try {
        await this.git.branches.deleteLocal(repoPath, orphanBranch, { force: true });
        this.log.debug(`Cleaned up orphan snapshot branch: ${orphanBranch}`);
      } catch {
        // Branch didn't exist — expected in the common case.
      }
    }

    // Note: Log files are now stored under plans/<planId>/specs/<nodeId>/attempts/<n>/execution.log
    // and are deleted when the plan directory is removed by planRepository.delete().
    // Legacy log file cleanup (from .orchestrator/logs/) is handled below for backward compat.
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
                try { fs.unlinkSync(path.join(logsDir, file)); removedCount++; } catch { /* ignore */ }
              }
            }
            if (removedCount > 0) {this.log.debug(`Removed ${removedCount} legacy log files for plan ${plan.id}`);}
          }
        }
      } catch { /* ignore legacy log cleanup errors */ }
    }

    if (cleanupErrors.length > 0) {
      this.log.warn(`Some cleanup operations failed`, { errors: cleanupErrors });
    } else {
      this.log.info(`Plan cleanup completed successfully`, { planId: plan.id });
    }
  }
}
