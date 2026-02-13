/**
 * @fileoverview Plan Module Exports
 * 
 * The Plan Module provides a unified orchestration system where
 * everything is a Plan - even a single job is a Plan with one node.
 * 
 * @module plan
 */

// Types
export * from './types';

// Builder
export { buildPlan, buildSingleJobPlan, buildNodes, PlanValidationError } from './builder';

// State Machine
export { PlanStateMachine, StateMachineEvents } from './stateMachine';

// Scheduler
export { PlanScheduler, SchedulerOptions } from './scheduler';

// Persistence
export { PlanPersistence } from './persistence';

// Runner
export { PlanRunner, PlanRunnerConfig, PlanRunnerEvents, JobExecutor, RetryNodeOptions } from './runner';

// Sub-modules
export { PlanLifecycleManager, PlanRunnerState } from './planLifecycle';
export { NodeManager } from './nodeManager';
export { ExecutionPump } from './executionPump';
export { PlanEventEmitter } from './planEvents';
export { PlanConfigManager } from './configManager';
export { JobExecutionEngine } from './executionEngine';

// Helpers
export {
  formatLogEntry,
  formatLogEntries,
  computeStatusCounts,
  computeProgress,
  computePlanStatus,
  computeEffectiveEndedAt,
  createEmptyWorkSummary,
  appendWorkSummary,
  computeMergedLeafWorkSummary,
} from './helpers';

// Executor
export { DefaultJobExecutor } from './executor';

// Evidence Validator
export { DefaultEvidenceValidator } from './evidenceValidator';
