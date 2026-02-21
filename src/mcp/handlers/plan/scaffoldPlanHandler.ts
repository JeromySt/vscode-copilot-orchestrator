/**
 * @fileoverview Scaffold Plan MCP Tool Handler
 * 
 * Implements handler for scaffolding empty plans that can be built incrementally.
 * 
 * @module mcp/handlers/plan/scaffoldPlanHandler
 */

import { validateInput } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
  resolveBaseBranch,
  resolveTargetBranch,
} from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle scaffold_copilot_plan MCP tool call.
 * 
 * Creates an empty plan scaffold in 'scaffolding' status. Nodes can then be added
 * incrementally using add_copilot_plan_node before finalizing with finalize_copilot_plan.
 * 
 * @param args - Tool arguments containing name and optional configuration
 * @param ctx - Handler context with PlanRepository access
 * @returns On success: { success: true, planId, specsDir, message }
 */
export async function handleScaffoldPlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('scaffold_copilot_plan', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  const { name, baseBranch, targetBranch, maxParallel, startPaused, cleanUpSuccessfulWork, additionalSymlinkDirs, verifyRi, env } = args;

  try {
    const repoPath = ctx.workspacePath;
    const resolvedBaseBranch = await resolveBaseBranch(repoPath, ctx.git, baseBranch);
    
    // Protect default branch — generate a feature branch if targetBranch is main/master/etc.
    const resolvedTargetBranch = await resolveTargetBranch(
      resolvedBaseBranch, repoPath, ctx.git, targetBranch, name, ctx.configProvider
    );
    
    // Use the worktree root from the PlanRunner or default
    const worktreeRoot = repoPath ? `${repoPath}/.worktrees` : '';

    const scaffoldOptions = {
      baseBranch: resolvedBaseBranch,
      targetBranch: resolvedTargetBranch,
      maxParallel,
      repoPath,
      worktreeRoot,
      env,
      // Add other scaffold options as needed
    };

    const plan = await ctx.PlanRepository.scaffold(name, scaffoldOptions);
    const planId = plan.id;

    // Register with PlanRunner — emits planCreated, sidebar renders it with SCAFFOLDING badge
    ctx.PlanRunner.registerPlan(plan);
    log.info('Plan scaffolded', { planId, name });

    return {
      success: true,
      planId,
      specsDir: `${worktreeRoot}/${planId}/specs`,
      message: `Plan scaffold '${name}' created with ID '${planId}'. Use add_copilot_plan_node to add nodes, then finalize_copilot_plan to start.`
    };

  } catch (error: any) {
    log.error('Failed to scaffold plan', { error: error.message, name });
    return errorResult(`Failed to scaffold plan: ${error.message}`);
  }
}