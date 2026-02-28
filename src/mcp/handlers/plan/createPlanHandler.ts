/**
 * @fileoverview Create Plan MCP Tool Handlers
 * 
 * Implements handlers for plan and job creation MCP tools.
 * 
 * @module mcp/handlers/plan/createPlanHandler
 */

import { 
  PlanSpec, 
  JobNodeSpec, 
} from '../../../plan/types';
import { validateAllowedFolders, validateAllowedUrls, validatePowerShellCommands } from '../../validation';
import {
  PlanHandlerContext,
  errorResult,
  resolveBaseBranch,
  resolveTargetBranch,
} from '../utils';
import { validateAgentModels } from '../../validation';
import type { IGitOperations } from '../../../interfaces/IGitOperations';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate and transform raw `create_copilot_plan` input into a {@link PlanSpec}.
 *
 * Schema validation (required fields, allowed properties, patterns) is
 * handled by Ajv in the MCP handler layer. This function performs:
 * 1. Semantic validation (dependency resolution, duplicate detection)
 * 2. Snake_case to camelCase transformation
 *
 * Jobs use a flat array with an optional `group` string property for visual
 * hierarchy. The `group` field supports `/`-separated nesting (e.g., "phase1/setup").
 *
 * @param args - Raw arguments from the `tools/call` request (already schema-validated).
 * @returns `{ valid: true, spec }` on success, or `{ valid: false, error }` on failure.
 */
function validatePlanInput(args: any): { valid: boolean; error?: string; spec?: PlanSpec } {
  const allProducerIds = new Set<string>();
  const errors: string[] = [];
  
  // Collect producerIds and check for duplicates
  for (const job of args.jobs || []) {
    if (!job.producerId) { continue; }
    if (allProducerIds.has(job.producerId)) {
      errors.push(`Duplicate producerId: '${job.producerId}'`);
    } else {
      allProducerIds.add(job.producerId);
    }
  }
  
  // Validate dependencies
  for (const job of args.jobs || []) {
    if (!job.producerId || !Array.isArray(job.dependencies)) { continue; }
    for (const dep of job.dependencies) {
      if (!allProducerIds.has(dep)) {
        errors.push(
          `Job '${job.producerId}' references unknown dependency '${dep}'. ` +
          `Valid producerIds: ${[...allProducerIds].join(', ')}`
        );
      }
      if (dep === job.producerId) {
        errors.push(`Job '${job.producerId}' cannot depend on itself`);
      }
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  
  // Transform to PlanSpec (snake_case → camelCase)
  const jobs: JobNodeSpec[] = (args.jobs || []).map((j: any): JobNodeSpec => ({
    producerId: j.producerId,
    name: j.name || j.producerId,
    task: j.task,
    work: j.work,
    dependencies: j.dependencies || [],
    prechecks: j.prechecks,
    postchecks: j.postchecks,
    instructions: j.instructions,
    baseBranch: j.baseBranch,
    expectsNoChanges: j.expectsNoChanges,
    group: j.group,
  }));
  
  const spec: PlanSpec = {
    name: args.name,
    baseBranch: args.baseBranch,
    targetBranch: args.targetBranch,
    maxParallel: args.maxParallel,
    cleanUpSuccessfulWork: args.cleanUpSuccessfulWork,
    additionalSymlinkDirs: args.additionalSymlinkDirs,
    startPaused: args.resumeAfterPlan ? true : args.startPaused,
    verifyRiSpec: args.verifyRi,
    env: args.env,
    resumeAfterPlan: args.resumeAfterPlan,
    jobs,
  };
  
  return { valid: true, spec };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle the `create_copilot_plan` MCP tool call.
 *
 * Validates input via {@link validatePlanInput}, resolves base/target branches
 * using the workspace git repository, then enqueues the plan via
 * {@link PlanRunner.enqueue}.
 *
 * @param args - Raw tool arguments matching the `create_copilot_plan` input schema.
 * @param ctx  - Handler context providing {@link PlanRunner} and workspace path.
 * @returns On success: `{ success: true, planId, name, jobMapping, status, ... }`.
 *          On failure: `{ success: false, error }`.
 *
 * @example
 * ```jsonc
 * // MCP tools/call request
 * {
 *   "name": "create_copilot_plan",
 *   "arguments": {
 *     "name": "Build & Test",
 *     "jobs": [
 *       { "producerId": "build", "task": "Build", "work": "npm run build", "dependencies": [] },
 *       { "producerId": "test",  "task": "Test",  "work": "npm test",      "dependencies": ["build"] }
 *     ]
 *   }
 * }
 * ```
 */
export async function handleCreatePlan(args: any, ctx: PlanHandlerContext): Promise<any> {
  // Validate input
  const validation = validatePlanInput(args);
  if (!validation.valid || !validation.spec) {
    return errorResult(validation.error || 'Invalid input');
  }

  // Validate allowedFolders paths exist
  const folderValidation = await validateAllowedFolders(args, 'create_copilot_plan');
  if (!folderValidation.valid) {
    return { success: false, error: folderValidation.error };
  }

  // Validate allowedUrls are well-formed HTTP/HTTPS
  const urlValidation = await validateAllowedUrls(args, 'create_copilot_plan');
  if (!urlValidation.valid) {
    return { success: false, error: urlValidation.error };
  }
  
  // Validate agent model names
  const modelValidation = await validateAgentModels(args, 'create_copilot_plan', ctx.configProvider);
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
  }
  
  // Reject PowerShell commands containing 2>&1 (causes false failures)
  const psValidation = validatePowerShellCommands(args);
  if (!psValidation.valid) {
    return { success: false, error: psValidation.error };
  }
  
  // Validate additionalSymlinkDirs: must exist in workspace and be gitignored
  if (args.additionalSymlinkDirs?.length && ctx.workspacePath) {
    // TODO: Implement validateAdditionalSymlinkDirs with git parameter
    // const symlinkValidation = await validateAdditionalSymlinkDirs(
    //   args.additionalSymlinkDirs, ctx.workspacePath, 'create_copilot_plan', ctx.git
    // );
    // if (!symlinkValidation.valid) {
    //   return { success: false, error: symlinkValidation.error };
    // }
  }
  
  try {
    validation.spec.repoPath = ctx.workspacePath;
    const repoPath = ctx.workspacePath;
    
    const baseBranch = await resolveBaseBranch(repoPath, ctx.git, validation.spec.baseBranch);
    validation.spec.baseBranch = baseBranch;
    
    const targetBranch = await resolveTargetBranch(
      baseBranch, repoPath, ctx.git, validation.spec.targetBranch, validation.spec.name, ctx.configProvider
    );
    validation.spec.targetBranch = targetBranch;
    
    // Create the Plan through PlanRepository to ensure filesystem-backed storage
    const spec = validation.spec;
    const scaffolded = await ctx.PlanRepository.scaffold(spec.name, {
      baseBranch,
      targetBranch,
      repoPath,
      worktreeRoot: `${repoPath}/.worktrees`,
      env: spec.env,
    });
    const planId = scaffolded.id;
    
    log.info('Creating plan via scaffold→addNode→finalize', { planId, jobCount: spec.jobs.length });
    
    for (const job of spec.jobs) {
      log.info('Adding job to plan', { planId, producerId: job.producerId, hasWork: !!job.work });
      await ctx.PlanRepository.addNode(planId, {
        producerId: job.producerId,
        name: job.name || job.task,
        task: job.task,
        dependencies: job.dependencies || [],
        group: job.group,
        work: job.work,
        prechecks: job.prechecks,
        postchecks: job.postchecks,
        autoHeal: job.autoHeal,
        expectsNoChanges: job.expectsNoChanges,
      });
    }
    
    const plan = await ctx.PlanRepository.finalize(planId);
    plan.isPaused = spec.startPaused !== false;
    if (spec.resumeAfterPlan) { plan.resumeAfterPlan = spec.resumeAfterPlan; }
    
    // Register with PlanRunner so it appears in UI and can be executed
    ctx.PlanRunner.registerPlan(plan);
    
    // Build job mapping for response (maps producerId → internal jobId)
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
      message: `Plan '${plan.spec.name}' created with ${plan.jobs.size} jobs. ` +
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
    return errorResult(error.message);
  }
}