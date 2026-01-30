/**
 * @fileoverview Scheduler Module - Shared orchestration abstractions.
 * 
 * This module provides the common scheduling infrastructure used by
 * both JobRunner and PlanRunner:
 * 
 * - Work unit lifecycle management (queued → running → completed)
 * - Queue management with concurrency control
 * - Persistence (save/load state)
 * - Event emission for UI updates
 * 
 * ## Architecture
 * 
 * ```
 * ┌─────────────────────────────────────────────────┐
 * │                  Scheduler<T>                   │
 * │  - Queue management                             │
 * │  - Concurrency control                          │
 * │  - Persistence                                  │
 * │  - Event emission                               │
 * └─────────────────────────────────────────────────┘
 *                        │
 *                        │ delegates "how"
 *                        ▼
 * ┌─────────────────────────────────────────────────┐
 * │            ExecutionStrategy<T>                 │
 * │  - createState()    - execute()                 │
 * │  - getReady()       - updateStatus()            │
 * │  - retry()          - cancel()                  │
 * │  - cleanup()        - serialize/deserialize()   │
 * └─────────────────────────────────────────────────┘
 *           │                          │
 *           ▼                          ▼
 * ┌──────────────────┐      ┌──────────────────┐
 * │  JobStrategy     │      │  PlanStrategy    │
 * │  - Spawn CLI     │      │  - DAG deps      │
 * │  - Single unit   │      │  - Delegate to   │
 * │  - Direct exec   │      │    JobRunner     │
 * └──────────────────┘      └──────────────────┘
 * ```
 * 
 * @module core/scheduler
 */

// Types
export {
  WorkUnitStatus,
  WorkUnit,
  WorkUnitSpec,
  IScheduler,
  SchedulerConfig,
  SchedulerEvents,
  ExecutionStrategy,
  SchedulerPersistence,
  isTerminalStatus,
  isActiveStatus,
} from './types';

// Base implementation
export { Scheduler } from './scheduler';

// Strategies
export { JobExecutionStrategy, JobState } from './jobStrategy';
export { PlanExecutionStrategy, PlanState } from './planStrategy';

// Unified facade with global concurrency control
export {
  WorkScheduler,
  UnifiedWorkUnit,
  WorkUnitType,
  WorkSchedulerEvents,
  SchedulerStats,
  PlanStateInfo,
} from './workScheduler';
