/**
 * @fileoverview Phase module barrel exports.
 *
 * @module plan/phases
 */

export { PrecheckPhaseExecutor } from './precheckPhase';
export { WorkPhaseExecutor, runProcess, runShell, runAgent, adaptCommandForPowerShell } from './workPhase';
export { PostcheckPhaseExecutor } from './postcheckPhase';
export { CommitPhaseExecutor } from './commitPhase';
export type { CommitPhaseContext } from './commitPhase';
export { MergeFiPhaseExecutor } from './mergeFiPhase';
export { MergeRiPhaseExecutor } from './mergeRiPhase';
export { resolveMergeConflictWithCopilot } from './mergeHelper';
