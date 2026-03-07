/**
 * @fileoverview Release MCP Tool Handlers
 * 
 * Implements handlers for all release-related MCP tools.
 * Validates inputs and delegates to IReleaseManager for execution.
 * 
 * @module mcp/handlers/plan/releaseHandlers
 */

import { validateInput } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
} from '../utils';
import { Logger } from '../../../core/logger';
import type { ReleaseStatus } from '../../../plan/types/release';

const log = Logger.for('mcp');

/**
 * Handle create_copilot_release MCP tool call.
 * 
 * Creates a new release combining multiple plan commits into a single PR.
 * 
 * @param args - Tool arguments containing name, planIds, releaseBranch, etc.
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, releaseId, message }
 */
export async function handleCreateRelease(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('create_copilot_release', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { name, planIds, releaseBranch, targetBranch, repoPath, autoStart } = args;

  try {
    const release = await ctx.releaseManager.createRelease({
      name,
      planIds,
      releaseBranch,
      targetBranch,
      repoPath,
    });

    log.info('Release created', { releaseId: release.id, name, planIds });

    // Auto-start if requested
    if (autoStart) {
      await ctx.releaseManager.startRelease(release.id);
      log.info('Release started', { releaseId: release.id });
    }

    return {
      success: true,
      releaseId: release.id,
      status: release.status,
      message: autoStart
        ? `Release '${name}' created with ID '${release.id}' and started. Use get_copilot_release_status to monitor progress.`
        : `Release '${name}' created with ID '${release.id}'. Use start_copilot_release to begin execution.`
    };

  } catch (error: any) {
    log.error('Failed to create release', { error: error.message, name, planIds });
    return errorResult(`Failed to create release: ${error.message}`);
  }
}

/**
 * Handle start_copilot_release MCP tool call.
 * 
 * Starts executing a release, transitioning through merge → PR creation → monitoring.
 * 
 * @param args - Tool arguments containing releaseId
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, message }
 */
export async function handleStartRelease(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('start_copilot_release', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId } = args;

  try {
    await ctx.releaseManager.startRelease(releaseId);
    log.info('Release started', { releaseId });

    return {
      success: true,
      releaseId,
      message: `Release '${releaseId}' started. Use get_copilot_release_status to monitor progress.`
    };

  } catch (error: any) {
    log.error('Failed to start release', { error: error.message, releaseId });
    return errorResult(`Failed to start release: ${error.message}`);
  }
}

/**
 * Handle get_copilot_release_status MCP tool call.
 * 
 * Returns detailed status and progress information for a release.
 * 
 * @param args - Tool arguments containing releaseId
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, release, progress }
 */
export async function handleGetReleaseStatus(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('get_copilot_release_status', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId } = args;

  try {
    const release = ctx.releaseManager.getRelease(releaseId);
    if (!release) {
      return errorResult(`Release not found: ${releaseId}`);
    }

    const progress = ctx.releaseManager.getReleaseProgress(releaseId);

    // Get available transitions from state machine
    const stateMachine = (ctx.releaseManager as any).stateMachines?.get(releaseId);
    const availableTransitions = stateMachine 
      ? (stateMachine as any).release.status in { drafting: 1, preparing: 1, merging: 1, 'ready-for-pr': 1, 'creating-pr': 1, 'pr-active': 1, monitoring: 1, addressing: 1 }
        ? ['preparing', 'merging', 'ready-for-pr', 'creating-pr', 'pr-active', 'monitoring', 'addressing', 'succeeded', 'failed', 'canceled'].filter(s => {
            const canTransition = stateMachine.canTransition(s);
            return canTransition.valid;
          })
        : []
      : [];

    return {
      success: true,
      release: {
        id: release.id,
        name: release.name,
        flowType: release.flowType,
        planIds: release.planIds,
        releaseBranch: release.releaseBranch,
        targetBranch: release.targetBranch,
        status: release.status,
        preparationTasks: release.preparationTasks || [],
        stateHistory: release.stateHistory || [],
        availableTransitions,
        prNumber: release.prNumber,
        prUrl: release.prUrl,
        createdAt: release.createdAt,
        startedAt: release.startedAt,
        endedAt: release.endedAt,
        error: release.error,
      },
      progress: progress || null,
    };

  } catch (error: any) {
    log.error('Failed to get release status', { error: error.message, releaseId });
    return errorResult(`Failed to get release status: ${error.message}`);
  }
}

/**
 * Handle cancel_copilot_release MCP tool call.
 * 
 * Cancels an in-progress release.
 * 
 * @param args - Tool arguments containing releaseId
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, message }
 */
export async function handleCancelRelease(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('cancel_copilot_release', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId } = args;

  try {
    const canceled = await ctx.releaseManager.cancelRelease(releaseId);
    
    if (!canceled) {
      return errorResult(`Release '${releaseId}' not found or already in terminal status`);
    }

    log.info('Release canceled', { releaseId });

    return {
      success: true,
      releaseId,
      message: `Release '${releaseId}' canceled successfully`
    };

  } catch (error: any) {
    log.error('Failed to cancel release', { error: error.message, releaseId });
    return errorResult(`Failed to cancel release: ${error.message}`);
  }
}

/**
 * Handle list_copilot_releases MCP tool call.
 * 
 * Returns all releases, optionally filtered by status.
 * 
 * @param args - Tool arguments (optional status filter)
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, releases: [...] }
 */
export async function handleListReleases(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('list_copilot_releases', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { status } = args || {};

  try {
    let releases = status
      ? ctx.releaseManager.getReleasesByStatus(status as ReleaseStatus)
      : ctx.releaseManager.getAllReleases();

    // Map to sanitized output (exclude internal fields)
    const sanitized = releases.map(release => ({
      id: release.id,
      name: release.name,
      planIds: release.planIds,
      releaseBranch: release.releaseBranch,
      targetBranch: release.targetBranch,
      status: release.status,
      prNumber: release.prNumber,
      prUrl: release.prUrl,
      createdAt: release.createdAt,
      startedAt: release.startedAt,
      endedAt: release.endedAt,
      error: release.error,
    }));

    return {
      success: true,
      releases: sanitized,
      count: sanitized.length,
    };

  } catch (error: any) {
    log.error('Failed to list releases', { error: error.message, status });
    return errorResult(`Failed to list releases: ${error.message}`);
  }
}

/**
 * Handle prepare_copilot_release MCP tool call.
 * 
 * Transitions a release to 'preparing' status.
 * 
 * @param args - Tool arguments containing releaseId
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, message }
 */
export async function handlePrepareRelease(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('prepare_copilot_release', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId } = args;

  try {
    const success = await ctx.releaseManager.transitionToState(releaseId, 'preparing', 'User requested preparation');
    
    if (!success) {
      const release = ctx.releaseManager.getRelease(releaseId);
      return errorResult(
        release
          ? `Cannot transition release '${releaseId}' from ${release.status} to preparing`
          : `Release '${releaseId}' not found`
      );
    }

    log.info('Release entered preparation phase', { releaseId });

    return {
      success: true,
      releaseId,
      message: `Release '${releaseId}' is now in preparing status. Complete preparation tasks before creating PR.`
    };

  } catch (error: any) {
    log.error('Failed to prepare release', { error: error.message, releaseId });
    return errorResult(`Failed to prepare release: ${error.message}`);
  }
}

/**
 * Handle execute_release_task MCP tool call.
 * 
 * Auto-executes a preparation task using Copilot.
 * 
 * @param args - Tool arguments containing releaseId and taskId
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, message }
 */
export async function handleExecuteReleaseTask(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('execute_release_task', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId, taskId } = args;

  try {
    await ctx.releaseManager.executePreparationTask(releaseId, taskId);
    log.info('Preparation task executed', { releaseId, taskId });

    return {
      success: true,
      releaseId,
      taskId,
      message: `Preparation task '${taskId}' executed successfully`
    };

  } catch (error: any) {
    log.error('Failed to execute preparation task', { error: error.message, releaseId, taskId });
    return errorResult(`Failed to execute preparation task: ${error.message}`);
  }
}

/**
 * Handle skip_release_task MCP tool call.
 * 
 * Skips a preparation task.
 * 
 * @param args - Tool arguments containing releaseId and taskId
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, message }
 */
export async function handleSkipReleaseTask(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('skip_release_task', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId, taskId } = args;

  try {
    await ctx.releaseManager.skipPreparationTask(releaseId, taskId);
    log.info('Preparation task skipped', { releaseId, taskId });

    return {
      success: true,
      releaseId,
      taskId,
      message: `Preparation task '${taskId}' skipped successfully`
    };

  } catch (error: any) {
    log.error('Failed to skip preparation task', { error: error.message, releaseId, taskId });
    return errorResult(`Failed to skip preparation task: ${error.message}`);
  }
}

/**
 * Handle add_plans_to_release MCP tool call.
 * 
 * Adds plans to a release at any stage.
 * 
 * @param args - Tool arguments containing releaseId and planIds
 * @param ctx - Handler context with ReleaseManager access
 * @returns On success: { success: true, message }
 */
export async function handleAddPlansToRelease(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('add_plans_to_release', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.releaseManager) {
    return errorResult('Release manager not available');
  }

  const { releaseId, planIds } = args;

  try {
    await ctx.releaseManager.addPlansToRelease(releaseId, planIds);
    log.info('Plans added to release', { releaseId, planIds, count: planIds.length });

    return {
      success: true,
      releaseId,
      planIds,
      message: `Successfully added ${planIds.length} plan(s) to release '${releaseId}'`
    };

  } catch (error: any) {
    log.error('Failed to add plans to release', { error: error.message, releaseId, planIds });
    return errorResult(`Failed to add plans to release: ${error.message}`);
  }
}
