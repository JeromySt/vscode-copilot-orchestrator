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

  if (updated.length === 0) {
    return { success: true, planId: args.planId, message: 'No changes specified' };
  }

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
