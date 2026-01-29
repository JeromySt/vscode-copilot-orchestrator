/**
 * @fileoverview Plan Module - Multi-job execution plan orchestration.
 * 
 * This module provides:
 * - Plan types (PlanSpec, PlanState, PlanJob, etc.)
 * - Plan persistence (save/load to disk)
 * - Merge management (incremental leaf merging, final RI merge)
 * - Cleanup management (worktree and branch cleanup)
 * 
 * @module core/plan
 */

// Types
export {
  PlanJob,
  SubPlanJob,
  SubPlanSpec,
  PlanSpec,
  PlanState,
  PlanStatus,
  InternalPlanState,
  JobSummary,
  CommitDetail,
  AggregatedWorkSummary,
  createInternalState,
  toPublicState,
  isCompletedStatus,
  isActiveStatus,
} from './types';

// Persistence
export { PlanPersistence } from './persistence';

// Merge operations
export {
  isLeafWorkUnit,
  mergeLeafToTarget,
  performFinalMerge,
  cleanupIntegrationBranches,
} from './mergeManager';

// Cleanup operations
export {
  cleanupWorkUnit,
  canCleanupProducer,
  cleanupAllPlanResources,
  cleanupWorktreeRoot,
} from './cleanupManager';
