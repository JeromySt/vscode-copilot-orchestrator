/**
 * @fileoverview Update Plan MCP Tool Handler
 * 
 * Implements handler for updating plan-level settings (env, maxParallel).
 * 
 * @module mcp/handlers/plan/updatePlanHandler
 */

import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  isError,
} from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle the `update_copilot_plan` MCP tool call.
 *
 * Updates plan-level settings like env vars and maxParallel.
 * The plan can be in any state (scaffolding, paused, running).
 *
 * @param args - Must contain `planId`. Optional `env`, `maxParallel`.
 * @param ctx  - Handler context.
 * @returns `{ success, planId, updated }`.
 */
export async function handleUpdatePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId']);
  if (fieldError) { return fieldError; }

  const planResult = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(planResult)) { return planResult; }
  const plan = planResult;

  const updated: string[] = [];

  // Update plan-level env
  if (args.env !== undefined) {
    plan.env = args.env;
    updated.push('env');
    log.info('Updated plan env', { planId: args.planId, envKeys: Object.keys(args.env) });
  }

  // Update maxParallel
  if (args.maxParallel !== undefined) {
    plan.maxParallel = args.maxParallel;
    updated.push('maxParallel');
    log.info('Updated plan maxParallel', { planId: args.planId, maxParallel: args.maxParallel });
  }

  // Update resumeAfterPlan (plan chaining)
  if (args.resumeAfterPlan !== undefined) {
    if (args.resumeAfterPlan === '') {
      plan.resumeAfterPlan = undefined;
      updated.push('resumeAfterPlan (cleared)');
      log.info('Cleared plan resumeAfterPlan', { planId: args.planId });
    } else {
      // Validate the dependency plan exists
      const depPlan = ctx.PlanRunner.getPlan(args.resumeAfterPlan);
      if (!depPlan) {
        return errorResult(`Dependency plan not found: ${args.resumeAfterPlan}`);
      }
      plan.resumeAfterPlan = args.resumeAfterPlan;
      // Auto-pause so it waits for the dependency
      if (!plan.isPaused) {
        plan.isPaused = true;
        updated.push('isPaused (auto-set for chain)');
      }
      updated.push('resumeAfterPlan');
      log.info('Updated plan resumeAfterPlan', { planId: args.planId, resumeAfterPlan: args.resumeAfterPlan });
    }
  }

  if (updated.length === 0) {
    return { success: true, planId: args.planId, message: 'No changes specified' };
  }

  // Record plan update event in state history for timeline rendering
  if (!plan.stateHistory) plan.stateHistory = [];
  const lastStatus = plan.stateHistory?.length ? plan.stateHistory[plan.stateHistory.length - 1].to : 'running';
  plan.stateHistory.push({ from: lastStatus || 'running', to: 'plan-updated', timestamp: Date.now(), reason: `settings: ${updated.join(', ')}` });

  // Persist the updated plan
  ctx.PlanRunner.savePlan(args.planId);

  return {
    success: true,
    planId: args.planId,
    updated,
    message: `Plan updated: ${updated.join(', ')}`,
    env: plan.env,
    maxParallel: plan.maxParallel,
  };
}
