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
import { finalizePlanInRunner } from '../../../plan/finalizePlanHelper';

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
    const result = await finalizePlanInRunner(planId, ctx.PlanRunner, ctx.PlanRepository, { startPaused });
    if (!result.success) {
      return errorResult(result.error || 'Finalize failed');
    }

    const plan = result.plan!;
    
    // Build job mapping for response (maps producerId → internal jobId)
    const jobMapping: Record<string, string> = {};
    for (const [producerId, nodeId] of plan.producerIdToNodeId) {
      jobMapping[producerId] = nodeId;
    }

    const isPaused = plan.isPaused === true;
    const chainedNote = plan.resumeAfterPlan
      ? ` Waiting for plan '${plan.resumeAfterPlan}' to complete before auto-resuming.`
      : '';
    const pauseNote = isPaused
      ? ` Plan is PAUSED.${chainedNote || ' Use resume_copilot_plan to start execution.'}`
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
        status: isPaused ? 'pending-start' : 'pending',
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