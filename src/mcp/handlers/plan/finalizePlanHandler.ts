/**
 * @fileoverview Finalize Plan MCP Tool Handler
 * 
 * Implements handler for finalizing scaffolded plans and transitioning them to execution.
 * 
 * @module mcp/handlers/plan/finalizePlanHandler
 */

import { validateInput } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
} from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle finalize_copilot_plan MCP tool call.
 * 
 * Validates and finalizes a scaffolded plan, resolving dependencies and checking for cycles.
 * Transitions the plan from 'scaffolding' status to execution state.
 * 
 * @param args - Tool arguments containing planId and optional startPaused flag
 * @param ctx - Handler context with PlanRepository and PlanRunner access
 * @returns Same shape as handleCreatePlan: { success: true, planId, jobMapping, status, ... }
 */
export async function handleFinalizePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('finalize_copilot_plan', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  const { planId, startPaused } = args;

  try {
    // Finalize the plan through the repository (validates DAG, resolves deps)
    const finalizedPlan = await ctx.PlanRepository.finalize(planId);

    // TODO: Replace (ctx.PlanRunner as any) access with a typed finalizeScaffoldPlan() method on IPlanRunner
    // Update the existing in-memory plan with finalized state
    const existingPlan = ctx.PlanRunner.get(planId);
    if (existingPlan) {
      // Transition from scaffolding to real plan
      (existingPlan.spec as any).status = 'pending';
      existingPlan.jobs = finalizedPlan.jobs;
      existingPlan.nodeStates = finalizedPlan.nodeStates;
      existingPlan.producerIdToNodeId = finalizedPlan.producerIdToNodeId;
      existingPlan.roots = finalizedPlan.roots;
      existingPlan.leaves = finalizedPlan.leaves;
      existingPlan.groups = finalizedPlan.groups || new Map();
      existingPlan.groupStates = finalizedPlan.groupStates || new Map();
      existingPlan.groupPathToId = finalizedPlan.groupPathToId || new Map();
      existingPlan.targetBranch = finalizedPlan.targetBranch;
      existingPlan.stateVersion = (existingPlan.stateVersion || 0) + 1;
      
      // Respect startPaused — default to paused so user can review before running
      const shouldPause = startPaused !== false; // Default true
      existingPlan.isPaused = shouldPause;
      
      // Recreate state machine with the now-populated nodes
      const sm = (ctx.PlanRunner as any)._state?.stateMachineFactory?.(existingPlan);
      if (sm) {
        (ctx.PlanRunner as any)._lifecycle?.setupStateMachineListeners?.(sm);
        (ctx.PlanRunner as any)._state?.stateMachines?.set(planId, sm);
      }
    } else {
      // Fallback — register as new (shouldn't happen if scaffold registered it)
      finalizedPlan.isPaused = startPaused !== false;
      ctx.PlanRunner.registerPlan(finalizedPlan);
    }

    // Emit planUpdated (not planCreated — the plan already exists in the sidebar)
    (ctx.PlanRunner as any)._state?.events?.emitPlanUpdated?.(planId);
    log.info('Plan finalized', { planId, name: finalizedPlan.spec.name });

    // Build job mapping for response (maps producerId → internal jobId)
    const plan = ctx.PlanRunner.get(planId) || finalizedPlan;
    const jobMapping: Record<string, string> = {};
    for (const [producerId, nodeId] of plan.producerIdToNodeId) {
      jobMapping[producerId] = nodeId;
    }

    const isPaused = plan.isPaused === true;
    const pauseNote = isPaused
      ? ' Plan is PAUSED. Use resume_copilot_plan to start execution.'
      : '';

    return {
      success: true,
      planId: plan.id,
      name: plan.spec.name,
      baseBranch: plan.baseBranch,
      targetBranch: plan.targetBranch,
      paused: isPaused,
      message: `Plan '${plan.spec.name}' finalized with ${plan.jobs.size} jobs. ` +
               `Base: ${plan.baseBranch}, Target: ${plan.targetBranch}.${pauseNote} ` +
               `Use planId '${plan.id}' to monitor progress.`,
      jobMapping,
      status: {
        status: isPaused ? 'paused' : 'pending',
        nodes: plan.jobs.size,
        roots: plan.roots.length,
        leaves: plan.leaves.length,
      },
    };

  } catch (error: any) {
    log.error('Failed to finalize scaffolded plan', { error: error.message, planId });
    return errorResult(`Failed to finalize plan: ${error.message}`);
  }
}