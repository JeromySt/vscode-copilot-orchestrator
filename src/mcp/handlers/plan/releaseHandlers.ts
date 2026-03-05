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

  const { name, planIds, releaseBranch, targetBranch, autoStart } = args;

  try {
    const release = await ctx.releaseManager.createRelease({
      name,
      planIds,
      releaseBranch,
      targetBranch,
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

    return {
      success: true,
      release: {
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
