/**
 * @fileoverview Shared utilities for MCP handlers.
 *
 * Common helpers for error responses, input validation, plan/node lookup,
 * and branch resolution to reduce duplication across handlers.
 *
 * @module mcp/handlers/utils
 */

import * as vscode from 'vscode';
import { ToolHandlerContext } from '../types';
import { PlanInstance } from '../../plan/types';
import { PlanRunner } from '../../plan/runner';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';

/**
 * Extended handler context with access to the {@link PlanRunner} instance.
 *
 * All plan-related handlers receive this context, which extends
 * {@link ToolHandlerContext} with the PlanRunner needed to create,
 * query, and control plans.
 */
export interface PlanHandlerContext extends ToolHandlerContext {
  /** The singleton PlanRunner orchestrating all plan execution. */
  PlanRunner: PlanRunner;
  /** Git operations interface */
  git: IGitOperations;
  /** Copilot CLI runner for instruction augmentation (optional for backward compat). */
  copilotRunner?: ICopilotRunner;
}

/**
 * Standard error response shape returned by all MCP handlers on failure.
 *
 * Every handler returns `{ success: false, error: "<message>" }` when the
 * request cannot be fulfilled.  Use {@link errorResult} to construct this.
 */
export interface ErrorResult {
  /** Always `false` for error responses. */
  success: false;
  /** Human-readable error description. */
  error: string;
}

/**
 * Build a standard error response.
 *
 * @param error - Human-readable error message.
 * @returns An {@link ErrorResult} with `success: false`.
 *
 * @example
 * ```ts
 * return errorResult('Plan must have a name');
 * // => { success: false, error: 'Plan must have a name' }
 * ```
 */
export function errorResult(error: string): ErrorResult {
  return { success: false, error };
}

/**
 * Validate that required fields are present and truthy in `args`.
 *
 * @param args   - The raw tool arguments object.
 * @param fields - Array of field names that must be present.
 * @returns An {@link ErrorResult} if any field is missing, or `null` if all are present.
 *
 * @example
 * ```ts
 * const err = validateRequired(args, ['planId', 'nodeId']);
 * if (err) return err;
 * ```
 */
export function validateRequired(args: any, fields: string[]): ErrorResult | null {
  for (const field of fields) {
    if (!args[field]) {
      return errorResult(`${field} is required`);
    }
  }
  return null;
}

/**
 * Look up a plan by ID, returning the plan instance or an error.
 *
 * @param ctx    - Handler context containing the PlanRunner.
 * @param planId - UUID of the plan to look up.
 * @param method - Which PlanRunner method to use: `'get'` (default, includes
 *                 child plans) or `'getPlan'` (top-level only).
 * @returns The {@link PlanInstance} if found, otherwise an {@link ErrorResult}.
 */
export function lookupPlan(
  ctx: PlanHandlerContext,
  planId: string,
  method: 'get' | 'getPlan' = 'get'
): PlanInstance | ErrorResult {
  const plan = method === 'getPlan'
    ? ctx.PlanRunner.getPlan(planId)
    : ctx.PlanRunner.get(planId);
  if (!plan) {
    return errorResult(`Plan not found: ${planId}`);
  }
  return plan;
}

/**
 * Type guard that checks whether a value is an {@link ErrorResult}.
 *
 * Used after {@link lookupPlan} or {@link lookupNode} to narrow the
 * union return type before proceeding with the success path.
 *
 * @param value - Value to test.
 * @returns `true` if the value is `{ success: false, error: string }`.
 */
export function isError(value: any): value is ErrorResult {
  return !!(value && value.success === false && typeof value.error === 'string');
}

/**
 * Look up a node within a plan by its UUID.
 *
 * @param plan   - The plan instance to search.
 * @param nodeId - UUID of the node.
 * @returns `{ node, state }` if found, otherwise an {@link ErrorResult}.
 */
export function lookupNode(plan: PlanInstance, nodeId: string): { node: any; state: any } | ErrorResult {
  const node = plan.nodes.get(nodeId);
  if (!node) {
    return errorResult(`Node not found: ${nodeId}`);
  }
  const state = plan.nodeStates.get(nodeId);
  return { node, state };
}

/**
 * Context alias for node-centric handlers.
 * Currently the same as PlanHandlerContext since the new handlers
 * still use PlanRunner internally.
 */
export type NodeHandlerContext = PlanHandlerContext;

/**
 * Resolve the base branch for a plan.
 *
 * Falls back to the repository's current branch, then to `'main'`
 * if no branch is currently checked out.
 *
 * @param repoPath  - Absolute path to the git repository.
 * @param requested - Explicitly requested branch name (used as-is if provided).
 * @returns Resolved base branch name.
 */
export async function resolveBaseBranch(repoPath: string, git: IGitOperations, requested?: string): Promise<string> {
  if (requested) {return requested;}
  try {
    const current = await git.branches.currentOrNull(repoPath);
    return current || 'main';
  } catch {
    return 'main';
  }
}

/**
 * Resolve the target branch for a plan, creating it if necessary.
 *
 * When no explicit target is provided, generates a branch name under
 * the `copilot_plan/` namespace and creates it from the base branch
 * if it does not already exist.
 *
 * @param baseBranch - The resolved base branch name.
 * @param repoPath   - Absolute path to the git repository.
 * @param requested  - Explicitly requested target branch name (used as-is if provided).
 * @param planName   - Optional plan/job name to use for generating a readable branch name.
 * @returns Resolved target branch name.
 */
export async function resolveTargetBranch(
  baseBranch: string,
  repoPath: string,
  git: IGitOperations,
  requested?: string,
  planName?: string
): Promise<string> {
  // Helper to generate a new feature branch
  const generateFeatureBranch = async (): Promise<string> => {
    // Use VS Code's git.branchPrefix setting if configured, otherwise fallback to 'copilot_plan'
    const gitConfig = vscode.workspace.getConfiguration('git');
    const userPrefix = gitConfig.get<string>('branchPrefix', '').trim();
    const prefix = userPrefix || 'copilot_plan';
    
    // Generate a readable branch suffix from the plan name, or use short UUID
    // TODO: Add git.orchestrator to IGitOperations interface
    // const branchSuffix = planName ? git.orchestrator.slugify(planName) : undefined;
    const branchSuffix = planName ? planName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() : undefined;
    
    // TODO: Add git.orchestrator to IGitOperations interface
    // const { targetBranchRoot, needsCreation } = await git.orchestrator.resolveTargetBranchRoot(
    //   baseBranch,
    //   repoPath,
    //   prefix,
    //   branchSuffix
    // );
    // For now, use simple branch name generation
    const targetBranchRoot = branchSuffix ? `${prefix}/${branchSuffix}` : `${prefix}/${Date.now()}`;
    const needsCreation = true;
    if (needsCreation) {
      const exists = await git.branches.exists(targetBranchRoot, repoPath);
      if (!exists) {
        await git.branches.create(targetBranchRoot, baseBranch, repoPath);
      }
    }
    return targetBranchRoot;
  };

  // If explicit branch requested, check if it's a protected default branch
  if (requested) {
    try {
      // NEVER allow merging back to a default branch (main, master, etc.)
      const isDefault = await git.branches.isDefaultBranch(requested, repoPath);
      if (isDefault) {
        // Requested branch is protected - generate a feature branch instead
        return await generateFeatureBranch();
      }
      
      // Not a default branch - ensure it exists (create from base if needed)
      const exists = await git.branches.exists(requested, repoPath);
      if (!exists) {
        await git.branches.create(requested, baseBranch, repoPath);
      }
      return requested;
    } catch (err) {
      // In test environments or invalid paths, branch operations may fail
      // Fall through to generate a safe feature branch
    }
  }

  // No explicit request or error in validation - generate a new feature branch
  return await generateFeatureBranch();
}
