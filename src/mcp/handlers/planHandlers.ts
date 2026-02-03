/**
 * @fileoverview Plan-related MCP tool handlers.
 * 
 * Implements the business logic for all plan-related MCP tools.
 * 
 * Branch Chaining Logic:
 * - Plan starts from a baseBranch (default: main)
 * - Each job in the plan gets its own worktree
 * - Jobs with consumesFrom dependencies branch from their source's completed branch
 * - This creates a chain: main -> job1 -> job2 -> job3
 * 
 * Sub-Plan Support:
 * - Sub-plans are work units that can consume from other work units (consumesFrom)
 * - Sub-plans support recursive nesting
 * 
 * @module mcp/handlers/planHandlers
 */

import { ToolHandlerContext } from '../types';
import { PlanSpec, PlanJob, SubPlanSpec } from '../../core/planRunner';

/**
 * Map sub-plan args to SubPlanSpec recursively.
 */
function mapSubPlans(subPlans: any[] | undefined): SubPlanSpec[] | undefined {
  if (!subPlans || subPlans.length === 0) return undefined;
  
  return subPlans.map((sp: any): SubPlanSpec => ({
    id: sp.id,
    name: sp.name,
    consumesFrom: sp.consumesFrom || [],
    maxParallel: sp.maxParallel,
    jobs: (sp.jobs || []).map((j: any) => ({
      id: j.id,
      name: j.name || j.id,
      task: j.task,
      work: j.work,
      consumesFrom: j.consumesFrom || [],
      prechecks: j.prechecks,
      postchecks: j.postchecks,
      instructions: j.instructions
    })),
    subPlans: mapSubPlans(sp.subPlans)  // Recursive!
  }));
}

/**
 * Validate plan input strictly according to schema.
 * - Validates required fields
 * - Rejects invalid structures with clear error messages
 */
function validateAndTransformPlanInput(args: any): { valid: boolean; error?: string; transformed: any } {
  // Must have jobs array
  if (!args.jobs || !Array.isArray(args.jobs) || args.jobs.length === 0) {
    return { valid: false, error: 'Plan must have at least one job in the jobs array', transformed: args };
  }
  
  // Validate each job has required fields
  for (let i = 0; i < args.jobs.length; i++) {
    const job = args.jobs[i];
    if (!job.id) {
      return { valid: false, error: `Job at index ${i} is missing required 'id' field`, transformed: args };
    }
    if (!job.task) {
      return { valid: false, error: `Job '${job.id}' is missing required 'task' field`, transformed: args };
    }
    // consumesFrom is now required
    if (!job.consumesFrom || !Array.isArray(job.consumesFrom)) {
      return { valid: false, error: `Job '${job.id}' is missing required 'consumesFrom' array (use [] for root jobs)`, transformed: args };
    }
    // Reject inline subPlan on jobs - must use top-level subPlans array
    if (job.subPlan) {
      return { 
        valid: false, 
        error: `Job '${job.id}' has inline 'subPlan' property which is not supported. ` +
               `Sub-plans must be defined in the top-level 'subPlans' array with 'consumesFrom' referencing the parent job. ` +
               `Example: { "subPlans": [{ "id": "sub1", "consumesFrom": ["${job.id}"], "jobs": [...] }] }`,
        transformed: args 
      };
    }
  }
  
  // Validate subPlans if present
  if (args.subPlans) {
    if (!Array.isArray(args.subPlans)) {
      return { valid: false, error: `'subPlans' must be an array`, transformed: args };
    }
    for (let i = 0; i < args.subPlans.length; i++) {
      const sp = args.subPlans[i];
      if (!sp.id) {
        return { valid: false, error: `SubPlan at index ${i} is missing required 'id' field`, transformed: args };
      }
      if (!sp.jobs || !Array.isArray(sp.jobs) || sp.jobs.length === 0) {
        return { valid: false, error: `SubPlan '${sp.id}' must have at least one job`, transformed: args };
      }
      // consumesFrom is required for sub-plans to establish dependencies
      if (!sp.consumesFrom || !Array.isArray(sp.consumesFrom)) {
        return { valid: false, error: `SubPlan '${sp.id}' is missing required 'consumesFrom' array`, transformed: args };
      }
    }
  }
  
  return { valid: true, transformed: args };
}

/**
 * Create a new plan with proper branch chaining.
 * 
 * The key insight: jobs with dependencies don't specify their own baseBranch.
 * Instead, the PlanRunner automatically sets baseBranch from the completed
 * dependency's branch. This ensures proper code flow through the DAG.
 */
export async function handleCreatePlan(args: any, ctx: ToolHandlerContext): Promise<any> {
  // Validate and transform input
  const { valid, error, transformed } = validateAndTransformPlanInput(args);
  if (!valid) {
    return {
      success: false,
      error: `Invalid plan specification: ${error}`
    };
  }
  
  const planId = transformed.id || `plan-${Date.now()}`;
  
  // Map sub-plans recursively
  const subPlans = mapSubPlans(args.subPlans);
  
  // Build the plan spec with proper structure
  const planSpec: PlanSpec = {
    id: planId,
    name: args.name || `Plan ${planId}`,
    repoPath: ctx.workspacePath,
    // worktreeRoot is NOT set here - enqueue() will set it using internal UUID for consistency
    baseBranch: args.baseBranch || 'main',  // Plan's starting point
    targetBranch: args.targetBranch,         // Optional: where to merge final results
    maxParallel: args.maxParallel,
    jobs: args.jobs.map((j: any): PlanJob => ({
      id: j.id,
      name: j.name || j.id,
      task: j.task,
      consumesFrom: j.consumesFrom || [],
      inputs: {
        // For root jobs (no consumesFrom): use plan's baseBranch
        // For dependent jobs: leave empty - PlanRunner will compute from source
        baseBranch: (!j.consumesFrom || j.consumesFrom.length === 0) 
          ? (j.baseBranch || args.baseBranch || 'main')
          : '',  // PlanRunner computes this from consumesFrom sources
        targetBranch: '',  // Auto-generated: copilot_jobs/<planId>/<jobId>
        instructions: j.instructions
      },
      policy: {
        useJust: false,
        steps: {
          prechecks: j.prechecks || '',
          work: j.work || `@agent ${j.task}`,
          postchecks: j.postchecks || ''
        }
      }
    })),
    subPlans  // Include sub-plans!
  };
  
  ctx.plans.enqueue(planSpec);
  const plan = ctx.plans.get(planSpec.id);
  
  // Count sub-plans recursively for message
  const countSubPlans = (sps: SubPlanSpec[] | undefined): number => {
    if (!sps) return 0;
    return sps.reduce((sum, sp) => sum + 1 + countSubPlans(sp.subPlans), 0);
  };
  const totalSubPlans = countSubPlans(subPlans);
  
  return {
    success: true,
    planId: planSpec.id,
    message: `Plan ${planSpec.id} created with ${args.jobs.length} jobs${totalSubPlans > 0 ? ` and ${totalSubPlans} sub-plan(s)` : ''}`,
    branchFlow: describeBranchFlow(planSpec),
    status: plan
  };
}

/**
 * Describe the branch flow for documentation/debugging.
 */
function describeBranchFlow(spec: PlanSpec): string {
  const lines = [`Plan starts from: ${spec.baseBranch}`];
  
  // Simple topological description
  for (const job of spec.jobs) {
    const consumesFrom = job.consumesFrom || [];
    if (consumesFrom.length === 0) {
      lines.push(`  ${job.id}: branches from ${spec.baseBranch}`);
    } else {
      lines.push(`  ${job.id}: consumes from ${consumesFrom.join(', ')}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Get status of a plan.
 */
export async function handleGetPlanStatus(args: any, ctx: ToolHandlerContext): Promise<any> {
  const plan = ctx.plans.get(args.id);
  if (!plan) {
    return { error: `Plan ${args.id} not found` };
  }
  return plan;
}

/**
 * List all plans.
 */
export async function handleListPlans(args: any, ctx: ToolHandlerContext): Promise<any> {
  const allPlans = ctx.plans.list();
  return { plans: allPlans, count: allPlans.length };
}

/**
 * Cancel a plan.
 */
export async function handleCancelPlan(args: any, ctx: ToolHandlerContext): Promise<any> {
  ctx.plans.cancel(args.id);
  return { success: true, message: `Plan ${args.id} canceled` };
}

/**
 * Delete a plan.
 */
export async function handleDeletePlan(args: any, ctx: ToolHandlerContext): Promise<any> {
  const plan = ctx.plans.get(args.id);
  if (!plan) {
    return { error: `Plan ${args.id} not found` };
  }
  
  // Delete the plan (this also cancels if running and cleans up resources)
  const deleted = ctx.plans.delete(args.id);
  
  if (deleted) {
    return { 
      success: true, 
      planId: args.id,
      message: `Plan ${args.id} deleted`
    };
  } else {
    return {
      error: `Failed to delete plan ${args.id}`
    };
  }
}

/**
 * Retry a failed plan.
 */
export async function handleRetryPlan(args: any, ctx: ToolHandlerContext): Promise<any> {
  const plan = ctx.plans.get(args.id);
  if (!plan) {
    return { error: `Plan ${args.id} not found` };
  }
  
  if (!['failed', 'partial'].includes(plan.status)) {
    return { 
      error: `Cannot retry plan ${args.id} - status is ${plan.status}. Only failed or partial plans can be retried.` 
    };
  }
  
  const success = ctx.plans.retry(args.id);
  if (success) {
    const updatedPlan = ctx.plans.get(args.id);
    return { 
      success: true, 
      planId: args.id,
      message: `Plan ${args.id} retry started`,
      status: updatedPlan?.status,
      queuedJobs: updatedPlan?.queued.length || 0
    };
  } else {
    return { 
      error: `Failed to retry plan ${args.id}`
    };
  }
}
