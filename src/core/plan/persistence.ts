/**
 * @fileoverview Plan Persistence - Save and load plan state to/from disk.
 * 
 * Single responsibility: Persist and restore plan state for extension restarts.
 * Uses debounced async writes to avoid blocking the event loop.
 * 
 * @module core/plan/persistence
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger, ComponentLogger } from '../logger';
import {
  PlanSpec,
  InternalPlanState,
  PlanState,
  toPublicState,
} from './types';

const log: ComponentLogger = Logger.for('plans');

/**
 * Serialized plan state format for disk persistence.
 */
interface SerializedPlanState extends PlanState {
  _jobIdMap: [string, string][];
  _completedCommits: [string, string][];
  _baseCommits: [string, string][];
  _completedBranches?: [string, string][];  // Legacy - for backwards compatibility
  _worktreePaths: [string, string][];
  _targetBranchRoot?: string;
  _targetBranchRootCreated?: boolean;
  _pendingSubPlans: string[];
  _runningSubPlans: [string, string][];
  _completedSubPlans: [string, string][];
  _failedSubPlans: [string, string][];
  _mergedLeaves: string[];
  _cleanedWorkUnits: string[];
}

/**
 * Persisted data format.
 */
interface PersistedData {
  plans: SerializedPlanState[];
  specs: PlanSpec[];
}

/**
 * Plan persistence manager.
 */
export class PlanPersistence {
  private filePath: string;
  private saveTimer: NodeJS.Timeout | undefined;
  private pendingSave: { plans: Map<string, InternalPlanState>; specs: Map<string, PlanSpec> } | undefined;
  private isSaving = false;
  
  /** Debounce delay for saves (ms) */
  private static readonly SAVE_DEBOUNCE_MS = 500;

  constructor(workspacePath: string) {
    this.filePath = workspacePath
      ? path.join(workspacePath, '.orchestrator', 'jobs', 'plans.json')
      : '';
  }

  /**
   * Check if persistence is available.
   */
  isAvailable(): boolean {
    return !!this.filePath;
  }

  /**
   * Persist plans and specs to disk (debounced, async).
   * Multiple rapid calls will be coalesced into a single write.
   */
  save(
    plans: Map<string, InternalPlanState>,
    specs: Map<string, PlanSpec>
  ): void {
    if (!this.filePath) return;

    // Store the latest state to save
    this.pendingSave = { plans, specs };
    
    // If already scheduled, let the existing timer handle it
    if (this.saveTimer) return;
    
    // Schedule a save
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.doSaveAsync();
    }, PlanPersistence.SAVE_DEBOUNCE_MS);
  }
  
  /**
   * Force an immediate synchronous save (for shutdown).
   */
  saveSync(
    plans: Map<string, InternalPlanState>,
    specs: Map<string, PlanSpec>
  ): void {
    if (!this.filePath) return;
    
    // Clear any pending async save
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.pendingSave = undefined;
    
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: PersistedData = {
        plans: Array.from(plans.entries()).map(([id, state]) =>
          this.serializeState(state)
        ),
        specs: Array.from(specs.values()),
      };

      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      log.debug('Plans persisted (sync)', { planCount: data.plans.length });
    } catch (error: any) {
      log.error('Failed to persist plans', { error: error.message });
    }
  }
  
  /**
   * Perform the actual async save.
   */
  private async doSaveAsync(): Promise<void> {
    if (!this.pendingSave || this.isSaving) return;
    
    const { plans, specs } = this.pendingSave;
    this.pendingSave = undefined;
    this.isSaving = true;
    
    try {
      const dir = path.dirname(this.filePath);
      try {
        await fs.promises.access(dir);
      } catch {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      const data: PersistedData = {
        plans: Array.from(plans.entries()).map(([id, state]) =>
          this.serializeState(state)
        ),
        specs: Array.from(specs.values()),
      };

      await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      log.debug('Plans persisted (async)', { planCount: data.plans.length });
    } catch (error: any) {
      log.error('Failed to persist plans', { error: error.message });
    } finally {
      this.isSaving = false;
      
      // If another save was requested while we were saving, do it now
      if (this.pendingSave) {
        this.doSaveAsync();
      }
    }
  }

  /**
   * Load plans and specs from disk.
   */
  load(): {
    plans: Map<string, InternalPlanState>;
    specs: Map<string, PlanSpec>;
  } {
    const plans = new Map<string, InternalPlanState>();
    const specs = new Map<string, PlanSpec>();

    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return { plans, specs };
    }

    try {
      const data: PersistedData = JSON.parse(
        fs.readFileSync(this.filePath, 'utf-8')
      );

      // Restore specs
      if (data.specs) {
        for (const spec of data.specs) {
          specs.set(spec.id, spec);
        }
      }

      // Restore plan states
      if (data.plans) {
        for (const planData of data.plans) {
          try {
            const state = this.deserializeState(planData);
            plans.set(state.id, state);
          } catch (planError: any) {
            log.error('Failed to deserialize plan, skipping', { 
              planId: planData?.id, 
              error: planError.message,
              stack: planError.stack
            });
            // Continue loading other plans
          }
        }
      }

      log.info('Plans loaded', {
        planCount: plans.size,
        specCount: specs.size,
      });
    } catch (error: any) {
      log.error('Failed to load plans', { error: error.message });
    }

    return { plans, specs };
  }

  /**
   * Serialize internal state for disk storage.
   */
  private serializeState(state: InternalPlanState): SerializedPlanState {
    return {
      ...toPublicState(state),
      _jobIdMap: Array.from(state.jobIdMap.entries()),
      _completedCommits: Array.from(state.completedCommits.entries()),
      _baseCommits: Array.from(state.baseCommits.entries()),
      _worktreePaths: Array.from(state.worktreePaths.entries()),
      _targetBranchRoot: state.targetBranchRoot,
      _targetBranchRootCreated: state.targetBranchRootCreated,
      _pendingSubPlans: Array.from(state.pendingSubPlans || []),
      _runningSubPlans: Array.from(state.runningSubPlans?.entries() || []),
      _completedSubPlans: Array.from(state.completedSubPlans?.entries() || []),
      _failedSubPlans: Array.from(state.failedSubPlans?.entries() || []),
      _mergedLeaves: Array.from(state.mergedLeaves || []),
      _cleanedWorkUnits: Array.from(state.cleanedWorkUnits || []),
    };
  }

  /**
   * Deserialize persisted data back to internal state.
   */
  private deserializeState(data: SerializedPlanState): InternalPlanState {
    return {
      id: data.id,
      status: data.status,
      queued: data.queued || [],
      preparing: [],  // Preparing jobs are not persisted (they'll be re-queued)
      running: data.running || [],
      done: data.done || [],
      failed: data.failed || [],
      canceled: data.canceled || [],
      submitted: data.submitted || [],
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      error: data.error,
      riMergeCompleted: data.riMergeCompleted,
      aggregatedWorkSummary: data.aggregatedWorkSummary,
      // Restore Maps from arrays
      jobIdMap: new Map(data._jobIdMap || []),
      completedCommits: new Map(data._completedCommits || data._completedBranches || []),
      baseCommits: new Map(data._baseCommits || []),
      worktreePaths: new Map(data._worktreePaths || []),
      worktreePromises: new Map(),  // Promises are not persisted (async in-flight state)
      targetBranchRoot: data._targetBranchRoot,
      targetBranchRootCreated: data._targetBranchRootCreated,
      // Restore sub-plan state
      // Note: Old format stored these without _ prefix, new format uses _ prefix for internal arrays
      pendingSubPlans: new Set(data._pendingSubPlans || data.pendingSubPlans || []),
      runningSubPlans: this.deserializeSubPlanMap(data._runningSubPlans, data.runningSubPlans),
      completedSubPlans: this.deserializeSubPlanMap(data._completedSubPlans, data.completedSubPlans),
      // Handle backwards compatibility: old format was string[], new format is [string, string][]
      failedSubPlans: this.deserializeFailedSubPlans(data._failedSubPlans || data.failedSubPlans),
      // Restore incremental delivery tracking
      mergedLeaves: new Set(data._mergedLeaves || []),
      cleanedWorkUnits: new Set(data._cleanedWorkUnits || []),
      // Runtime state - not persisted
      worktreeResults: new Map(),
    };
  }
  
  /**
   * Deserialize failedSubPlans with backwards compatibility.
   * Old format: string[] (just keys)
   * New format: [string, string][] (key -> childPlanId pairs)
   */
  private deserializeFailedSubPlans(data: any): Map<string, string> {
    if (!data || !Array.isArray(data)) {
      return new Map();
    }
    
    // Check if it's the old format (array of strings) or new format (array of pairs)
    if (data.length === 0) {
      return new Map();
    }
    
    // If first element is a string, it's old format
    if (typeof data[0] === 'string') {
      // Old format: convert string[] to Map<string, string> with empty child plan IDs
      return new Map(data.map((key: string) => [key, '']));
    }
    
    // New format: array of [key, value] pairs
    return new Map(data);
  }
  
  /**
   * Deserialize sub-plan Map with backwards compatibility.
   * Old format: Record<string, string> (object from PlanState)
   * New format: [string, string][] (array of pairs)
   */
  private deserializeSubPlanMap(
    arrayData: [string, string][] | undefined, 
    objectData: Record<string, string> | undefined
  ): Map<string, string> {
    // Prefer the array format if available
    if (arrayData && Array.isArray(arrayData) && arrayData.length > 0) {
      return new Map(arrayData);
    }
    
    // Fall back to object format (from old PlanState spread)
    if (objectData && typeof objectData === 'object' && !Array.isArray(objectData)) {
      return new Map(Object.entries(objectData));
    }
    
    return new Map();
  }

  /**
   * Delete persistence file.
   */
  clear(): void {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        log.info('Plans persistence cleared');
      }
    } catch (error: any) {
      log.error('Failed to clear plans persistence', { error: error.message });
    }
  }
}
