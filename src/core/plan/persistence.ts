/**
 * @fileoverview Plan Persistence - Save and load plan state to/from disk.
 * 
 * Single responsibility: Persist and restore plan state for extension restarts.
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
  _completedBranches: [string, string][];
  _worktreePaths: [string, string][];
  _targetBranchRoot?: string;
  _targetBranchRootCreated?: boolean;
  _pendingSubPlans: string[];
  _runningSubPlans: [string, string][];
  _completedSubPlans: [string, string][];
  _failedSubPlans: string[];
  _subPlanIntegrationBranches: [string, string][];
  _mergedLeaves: string[];
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
   * Persist plans and specs to disk.
   */
  save(
    plans: Map<string, InternalPlanState>,
    specs: Map<string, PlanSpec>
  ): void {
    if (!this.filePath) return;

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
      log.debug('Plans persisted', { planCount: data.plans.length });
    } catch (error: any) {
      log.error('Failed to persist plans', { error: error.message });
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
          const state = this.deserializeState(planData);
          plans.set(state.id, state);
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
      _completedBranches: Array.from(state.completedBranches.entries()),
      _worktreePaths: Array.from(state.worktreePaths.entries()),
      _targetBranchRoot: state.targetBranchRoot,
      _targetBranchRootCreated: state.targetBranchRootCreated,
      _pendingSubPlans: Array.from(state.pendingSubPlans || []),
      _runningSubPlans: Array.from(state.runningSubPlans?.entries() || []),
      _completedSubPlans: Array.from(state.completedSubPlans?.entries() || []),
      _failedSubPlans: Array.from(state.failedSubPlans || []),
      _subPlanIntegrationBranches: Array.from(
        state.subPlanIntegrationBranches?.entries() || []
      ),
      _mergedLeaves: Array.from(state.mergedLeaves || []),
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
      completedBranches: new Map(data._completedBranches || []),
      worktreePaths: new Map(data._worktreePaths || []),
      targetBranchRoot: data._targetBranchRoot,
      targetBranchRootCreated: data._targetBranchRootCreated,
      // Restore sub-plan state
      pendingSubPlans: new Set(data._pendingSubPlans || []),
      runningSubPlans: new Map(data._runningSubPlans || []),
      completedSubPlans: new Map(data._completedSubPlans || []),
      failedSubPlans: new Set(data._failedSubPlans || []),
      subPlanIntegrationBranches: new Map(
        data._subPlanIntegrationBranches || []
      ),
      // Restore incremental delivery tracking
      mergedLeaves: new Set(data._mergedLeaves || []),
    };
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
