/**
 * @fileoverview PR Lifecycle MCP Tool Handlers
 * 
 * Implements handlers for all PR lifecycle management MCP tools.
 * Validates inputs and delegates to IPRLifecycleManager for execution.
 * 
 * @module mcp/handlers/plan/prLifecycleHandlers
 */

import { validateInput } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
} from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle list_available_prs MCP tool call.
 * 
 * Lists PRs from the remote provider with isManaged flag.
 * 
 * @param args - Tool arguments containing repoPath, optional filters
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, prs: AvailablePR[] }
 */
export async function handleListAvailablePRs(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('list_available_prs', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { repoPath, baseBranch, state, limit } = args;

  try {
    const prs = await ctx.prLifecycleManager.listAvailablePRs({
      repoPath,
      baseBranch,
      state,
      limit,
    });

    log.info('Listed available PRs', { repoPath, count: prs.length, managed: prs.filter(p => p.isManaged).length });

    return {
      success: true,
      prs,
      message: `Found ${prs.length} PRs (${prs.filter(p => p.isManaged).length} already managed)`
    };

  } catch (error: any) {
    log.error('Failed to list available PRs', { error: error.message, repoPath });
    return errorResult(`Failed to list available PRs: ${error.message}`);
  }
}

/**
 * Handle adopt_pr MCP tool call.
 * 
 * Adopts an existing PR for lifecycle management.
 * 
 * @param args - Tool arguments containing prNumber, repoPath, optional fields
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, managedPR: ManagedPR }
 */
export async function handleAdoptPR(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('adopt_pr', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { prNumber, repoPath, workingDirectory, releaseId, priority } = args;

  try {
    const result = await ctx.prLifecycleManager.adoptPR({
      prNumber,
      repoPath,
      workingDirectory,
      releaseId,
      priority,
    });

    if (!result.success) {
      log.warn('Failed to adopt PR', { prNumber, repoPath, error: result.error });
      return result;
    }

    log.info('PR adopted', { id: result.managedPR!.id, prNumber, repoPath });

    return {
      success: true,
      managedPR: result.managedPR,
      message: `PR #${prNumber} adopted with ID '${result.managedPR!.id}'. Use start_pr_monitoring to begin monitoring.`
    };

  } catch (error: any) {
    log.error('Failed to adopt PR', { error: error.message, prNumber, repoPath });
    return errorResult(`Failed to adopt PR: ${error.message}`);
  }
}

/**
 * Handle get_managed_pr MCP tool call.
 * 
 * Gets details of a managed PR by ID.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, managedPR: ManagedPR }
 */
export async function handleGetManagedPR(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('get_managed_pr', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const managedPR = ctx.prLifecycleManager.getManagedPR(id);

    if (!managedPR) {
      log.warn('Managed PR not found', { id });
      return errorResult(`Managed PR not found: ${id}`);
    }

    log.debug('Retrieved managed PR', { id, prNumber: managedPR.prNumber, status: managedPR.status });

    return {
      success: true,
      managedPR
    };

  } catch (error: any) {
    log.error('Failed to get managed PR', { error: error.message, id });
    return errorResult(`Failed to get managed PR: ${error.message}`);
  }
}

/**
 * Handle list_managed_prs MCP tool call.
 * 
 * Lists all managed PRs, optionally filtered by status.
 * 
 * @param args - Tool arguments containing optional status filter
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, managedPRs: ManagedPR[] }
 */
export async function handleListManagedPRs(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('list_managed_prs', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { status } = args;

  try {
    const managedPRs = status
      ? ctx.prLifecycleManager.getManagedPRsByStatus(status)
      : ctx.prLifecycleManager.getAllManagedPRs();

    log.info('Listed managed PRs', { count: managedPRs.length, status });

    return {
      success: true,
      managedPRs,
      message: `Found ${managedPRs.length} managed PR${managedPRs.length !== 1 ? 's' : ''}${status ? ` with status '${status}'` : ''}`
    };

  } catch (error: any) {
    log.error('Failed to list managed PRs', { error: error.message, status });
    return errorResult(`Failed to list managed PRs: ${error.message}`);
  }
}

/**
 * Handle start_pr_monitoring MCP tool call.
 * 
 * Starts monitoring a managed PR for autonomous feedback handling.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, message }
 */
export async function handleStartPRMonitoring(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('start_pr_monitoring', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const pr = ctx.prLifecycleManager.getManagedPR(id);
    if (!pr) {
      return errorResult(`Managed PR not found: ${id}`);
    }

    await ctx.prLifecycleManager.startMonitoring(id);
    log.info('PR monitoring started', { id, prNumber: pr.prNumber });

    return {
      success: true,
      message: `Monitoring started for PR #${pr.prNumber}. The PR will be autonomously monitored for feedback.`
    };

  } catch (error: any) {
    log.error('Failed to start PR monitoring', { error: error.message, id });
    return errorResult(`Failed to start PR monitoring: ${error.message}`);
  }
}

/**
 * Handle stop_pr_monitoring MCP tool call.
 * 
 * Stops monitoring a managed PR without abandoning it.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, message }
 */
export async function handleStopPRMonitoring(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('stop_pr_monitoring', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const pr = ctx.prLifecycleManager.getManagedPR(id);
    if (!pr) {
      return errorResult(`Managed PR not found: ${id}`);
    }

    await ctx.prLifecycleManager.stopMonitoring(id);
    log.info('PR monitoring stopped', { id, prNumber: pr.prNumber });

    return {
      success: true,
      message: `Monitoring stopped for PR #${pr.prNumber}. The PR remains managed but is no longer being monitored.`
    };

  } catch (error: any) {
    log.error('Failed to stop PR monitoring', { error: error.message, id });
    return errorResult(`Failed to stop PR monitoring: ${error.message}`);
  }
}

/**
 * Handle promote_pr MCP tool call.
 * 
 * Promotes a managed PR to a higher priority tier.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, message }
 */
export async function handlePromotePR(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('promote_pr', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const result = await ctx.prLifecycleManager.promotePR(id);

    if (!result.success) {
      log.warn('Failed to promote PR', { id, error: result.error });
      return result;
    }

    log.info('PR promoted', { id, message: result.message });

    return result;

  } catch (error: any) {
    log.error('Failed to promote PR', { error: error.message, id });
    return errorResult(`Failed to promote PR: ${error.message}`);
  }
}

/**
 * Handle demote_pr MCP tool call.
 * 
 * Demotes a managed PR to a lower priority tier.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, message }
 */
export async function handleDemotePR(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('demote_pr', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const result = await ctx.prLifecycleManager.demotePR(id);

    if (!result.success) {
      log.warn('Failed to demote PR', { id, error: result.error });
      return result;
    }

    log.info('PR demoted', { id, message: result.message });

    return result;

  } catch (error: any) {
    log.error('Failed to demote PR', { error: error.message, id });
    return errorResult(`Failed to demote PR: ${error.message}`);
  }
}

/**
 * Handle abandon_pr MCP tool call.
 * 
 * Abandons a managed PR, stopping monitoring and closing it on the remote.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, message }
 */
export async function handleAbandonPR(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('abandon_pr', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const result = await ctx.prLifecycleManager.abandonPR(id);

    if (!result.success) {
      log.warn('Failed to abandon PR', { id, error: result.error });
      return result;
    }

    log.info('PR abandoned', { id, message: result.message });

    return result;

  } catch (error: any) {
    log.error('Failed to abandon PR', { error: error.message, id });
    return errorResult(`Failed to abandon PR: ${error.message}`);
  }
}

/**
 * Handle remove_pr MCP tool call.
 * 
 * Removes a managed PR from lifecycle management completely.
 * 
 * @param args - Tool arguments containing id
 * @param ctx - Handler context with prLifecycleManager access
 * @returns On success: { success: true, message }
 */
export async function handleRemovePR(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input against schema
  const validation = validateInput('remove_pr', args);
  if (!validation.valid) {
    return errorResult(validation.error || 'Invalid input');
  }

  if (!ctx.prLifecycleManager) {
    return errorResult('PR lifecycle manager not available');
  }

  const { id } = args;

  try {
    const result = await ctx.prLifecycleManager.removePR(id);

    if (!result.success) {
      log.warn('Failed to remove PR', { id, error: result.error });
      return result;
    }

    log.info('PR removed', { id, message: result.message });

    return result;

  } catch (error: any) {
    log.error('Failed to remove PR', { error: error.message, id });
    return errorResult(`Failed to remove PR: ${error.message}`);
  }
}
