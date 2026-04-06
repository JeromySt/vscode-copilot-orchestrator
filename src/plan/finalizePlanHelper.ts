/**
 * @fileoverview Shared finalize logic for transitioning a scaffolded plan to execution.
 *
 * Used by both the MCP `finalize_copilot_plan` handler and the UI "Finalize & Start" button.
 * Ensures a single code path for:
 *   1. Calling IPlanRepository.finalize() to validate DAG and write specs
 *   2. Syncing the in-memory PlanInstance with finalized state
 *   3. Recreating the state machine for the new nodes
 *   4. Optionally resuming execution
 *
 * @module plan/finalizePlanHelper
 */

import { Logger } from '../core/logger';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type { IPlanRepository } from '../interfaces/IPlanRepository';
import type { PlanInstance } from './types';

const log = Logger.for('plan');

export interface FinalizePlanOptions {
  /** Whether to start the plan paused (default: true for MCP, false for UI button) */
  startPaused?: boolean;
}

export interface FinalizePlanResult {
  success: boolean;
  plan?: PlanInstance;
  error?: string;
}

/**
 * Finalize a scaffolded plan and sync it into the PlanRunner.
 *
 * This is the single code path for plan finalization — called by both
 * the MCP handler and the UI bulk action.
 */
export async function finalizePlanInRunner(
  planId: string,
  planRunner: IPlanRunner,
  planRepository: IPlanRepository,
  options: FinalizePlanOptions = {},
): Promise<FinalizePlanResult> {
  const existingPlan = planRunner.get(planId);
  if (!existingPlan) {
    return { success: false, error: 'Plan not found' };
  }
  if ((existingPlan.spec as any)?.status !== 'scaffolding') {
    return { success: false, error: `Cannot finalize plan in status '${(existingPlan.spec as any)?.status}'. Plan must be in 'scaffolding' status.` };
  }

  // 1. Finalize via repository (validates DAG, writes specs to disk, resolves deps)
  const finalized = await planRepository.finalize(planId);

  // 2. Sync in-memory plan with finalized state
  (existingPlan.spec as any).status = 'pending';
  existingPlan.jobs = finalized.jobs;
  existingPlan.nodeStates = finalized.nodeStates;
  existingPlan.producerIdToNodeId = finalized.producerIdToNodeId;
  existingPlan.roots = finalized.roots;
  existingPlan.leaves = finalized.leaves;
  existingPlan.groups = finalized.groups || new Map();
  existingPlan.groupStates = finalized.groupStates || new Map();
  existingPlan.groupPathToId = finalized.groupPathToId || new Map();
  existingPlan.targetBranch = finalized.targetBranch;
  existingPlan.definition = finalized.definition;
  existingPlan.stateVersion = (existingPlan.stateVersion || 0) + 1;

  // 3. Determine pause state
  const hasResumeAfterPlan = !!existingPlan.resumeAfterPlan;
  const shouldPause = hasResumeAfterPlan || options.startPaused !== false;
  existingPlan.isPaused = shouldPause;
  if (hasResumeAfterPlan && options.startPaused === false) {
    log.info('Plan has resumeAfterPlan — overriding startPaused=false to keep paused until dependency completes', {
      planId, resumeAfterPlan: existingPlan.resumeAfterPlan,
    });
  }

  // 4. Remove old registration (without canceling/deleting!) and re-register
  //    to rebuild the state machine with the finalized nodes.
  //    IMPORTANT: Do NOT call planRunner.delete() — that cancels all nodes and
  //    writes a tombstone. Instead, remove from internal maps directly.
  const runner = planRunner as any;
  if (runner._state?.plans) { runner._state.plans.delete(planId); }
  if (runner._state?.stateMachines) { runner._state.stateMachines.delete(planId); }
  if (runner._lifecycle?.state?.plans) { runner._lifecycle.state.plans.delete(planId); }
  if (runner._lifecycle?.state?.stateMachines) { runner._lifecycle.state.stateMachines.delete(planId); }
  runner.registerPlan(existingPlan);

  // 5. If not paused, resume to kick off execution
  if (!shouldPause) {
    await planRunner.resume(planId);
  }

  const plan = planRunner.get(planId) || existingPlan;
  log.info('Plan finalized', { planId, name: plan.spec.name, paused: plan.isPaused, nodes: plan.jobs.size });
  return { success: true, plan };
}
