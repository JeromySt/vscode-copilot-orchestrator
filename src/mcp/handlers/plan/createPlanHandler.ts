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
import { validateAllowedFolders, validateAllowedUrls } from '../../validation';
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
// GROUP FLATTENING
// ============================================================================

/**
 * Flatten groups recursively into a flat array of JobNodeSpec.
 * 
 * Each job gets:
 * - Qualified producerId: "group/path/local_id"
 * - group field set to the full group path
 * - Dependencies resolved with qualified paths
 * 
 * @param groups - Array of group specs from MCP input
 * @param groupPath - Current group path prefix (e.g., "backend/api")
 * @returns Flattened array of JobNodeSpec
 */
function flattenGroupsToJobs(
  groups: any[] | undefined, 
  groupPath: string
): JobNodeSpec[] {
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    return [];
  }
  
  const result: JobNodeSpec[] = [];
  
  for (const g of groups) {
    const groupName = g.name;
    const currentPath = groupPath ? `${groupPath}/${groupName}` : groupName;
    
    // Flatten jobs in this group
    for (const j of g.jobs || []) {
      const qualifiedId = `${currentPath}/${j.producer_id}`;
      
      // Resolve dependencies - local refs become qualified, already-qualified refs pass through
      const resolvedDeps = (j.dependencies || []).map((dep: string) => {
        // If dep contains '/', it's already qualified
        if (dep.includes('/')) {return dep;}
        // Otherwise, qualify it with our group path
        return `${currentPath}/${dep}`;
      });
      
      result.push({
        producerId: qualifiedId,
        name: j.name || j.producer_id,
        task: j.task,
        work: j.work,
        dependencies: resolvedDeps,
        prechecks: j.prechecks,
        postchecks: j.postchecks,
        instructions: j.instructions,
        baseBranch: j.baseBranch,
        expectsNoChanges: j.expects_no_changes,
        group: currentPath,
      });
    }
    
    // Recursively flatten nested groups
    result.push(...flattenGroupsToJobs(g.groups, currentPath));
  }
  
  return result;
}

/**
 * Validate groups recursively for dependency references.
 * 
 * Note: Schema validation (required fields, unknown properties, patterns)
 * is handled by Ajv in the MCP handler layer. This function only validates
 * business logic that requires semantic understanding:
 * - Dependency references resolve to valid producer_ids
 * - No self-referential dependencies
 * 
 * @param groups - Array of groups to validate
 * @param groupPath - Current group path for error messages
 * @param validGlobalRefs - All valid producer_ids for dependency checking
 * @param errors - Array to accumulate errors
 */
function validateGroupsRecursively(
  groups: any[] | undefined,
  groupPath: string,
  validGlobalRefs: Set<string>,
  errors: string[]
): void {
  if (!groups || !Array.isArray(groups)) {return;}
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group.name) {continue;} // Schema validation catches this
    
    const currentPath = groupPath ? `${groupPath}/${group.name}` : group.name;
    
    // Validate job dependencies in this group
    for (let j = 0; j < (group.jobs || []).length; j++) {
      const job = group.jobs[j];
      if (!job.producer_id) {continue;} // Schema validation catches this
      
      const qualifiedId = `${currentPath}/${job.producer_id}`;
      
      // Check dependencies resolve
      if (Array.isArray(job.dependencies)) {
        for (const dep of job.dependencies) {
          const resolvedDep = dep.includes('/') ? dep : `${currentPath}/${dep}`;
          if (!validGlobalRefs.has(resolvedDep)) {
            errors.push(`Job '${qualifiedId}' references unknown dependency '${dep}'`);
          }
          if (resolvedDep === qualifiedId) {
            errors.push(`Job '${qualifiedId}' cannot depend on itself`);
          }
        }
      }
    }
    
    // Recursively validate nested groups
    validateGroupsRecursively(group.groups, currentPath, validGlobalRefs, errors);
  }
}

/**
 * Collect all producer_ids from groups recursively (for reference validation).
 */
function collectGroupProducerIds(groups: any[] | undefined, groupPath: string, ids: Set<string>): void {
  if (!groups || !Array.isArray(groups)) {return;}
  
  for (const g of groups) {
    const currentPath = groupPath ? `${groupPath}/${g.name}` : g.name;
    
    for (const j of g.jobs || []) {
      if (j.producer_id) {
        const qualifiedId = `${currentPath}/${j.producer_id}`;
        if (ids.has(qualifiedId)) {
          // Duplicate - will be caught in validation
        }
        ids.add(qualifiedId);
      }
    }
    
    collectGroupProducerIds(g.groups, currentPath, ids);
  }
}

/**
 * Validate and transform raw `create_copilot_plan` input into a {@link PlanSpec}.
 *
 * Note: Schema validation (required fields, allowed properties, patterns) is
 * handled by Ajv in the MCP handler layer. This function performs:
 * 1. Semantic validation (dependency resolution, duplicate detection)
 * 2. Transformation to internal PlanSpec format
 * 3. Group flattening
 *
 * @param args - Raw arguments from the `tools/call` request (already schema-validated).
 * @returns `{ valid: true, spec }` on success, or `{ valid: false, error }` on failure.
 */
function validatePlanInput(args: any): { valid: boolean; error?: string; spec?: PlanSpec } {
  // Collect all producer_ids for reference validation
  const allProducerIds = new Set<string>();
  const errors: string[] = [];
  
  // Collect root job producer_ids and check for duplicates
  for (const job of args.jobs || []) {
    if (!job.producer_id) {continue;} // Schema validation catches this
    
    if (allProducerIds.has(job.producer_id)) {
      errors.push(`Duplicate producer_id: '${job.producer_id}'`);
    } else {
      allProducerIds.add(job.producer_id);
    }
  }
  
  // Collect all producer_ids from groups (qualified paths)
  collectGroupProducerIds(args.groups, '', allProducerIds);
  
  // Validate root-level job dependencies
  for (const job of args.jobs || []) {
    if (!job.producer_id || !Array.isArray(job.dependencies)) {continue;}
    
    for (const dep of job.dependencies) {
      if (!allProducerIds.has(dep)) {
        errors.push(
          `Job '${job.producer_id}' references unknown dependency '${dep}'. ` +
          `Valid producer_ids: ${[...allProducerIds].join(', ')}`
        );
      }
      if (dep === job.producer_id) {
        errors.push(`Job '${job.producer_id}' cannot depend on itself`);
      }
    }
  }
  
  // Validate group job dependencies
  validateGroupsRecursively(args.groups, '', allProducerIds, errors);
  
  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  
  // Transform to PlanSpec - flatten groups into jobs
  const rootJobs: JobNodeSpec[] = (args.jobs || []).map((j: any): JobNodeSpec => ({
    producerId: j.producer_id,
    name: j.name || j.producer_id,
    task: j.task,
    work: j.work,
    dependencies: j.dependencies || [],
    prechecks: j.prechecks,
    postchecks: j.postchecks,
    instructions: j.instructions,
    baseBranch: j.baseBranch,
    expectsNoChanges: j.expects_no_changes,
    group: j.group,
  }));
  
  // Flatten groups into additional jobs
  const groupJobs = flattenGroupsToJobs(args.groups, '');
  
  const spec: PlanSpec = {
    name: args.name,
    baseBranch: args.baseBranch,
    targetBranch: args.targetBranch,
    maxParallel: args.maxParallel,
    cleanUpSuccessfulWork: args.cleanUpSuccessfulWork,
    additionalSymlinkDirs: args.additionalSymlinkDirs,
    startPaused: args.startPaused,
    jobs: [...rootJobs, ...groupJobs],
    // Note: groups are flattened into jobs, not stored separately
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
 * @returns On success: `{ success: true, planId, name, nodeMapping, status, ... }`.
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
 *       { "producer_id": "build", "task": "Build", "work": "npm run build", "dependencies": [] },
 *       { "producer_id": "test",  "task": "Test",  "work": "npm test",      "dependencies": ["build"] }
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
  const modelValidation = await validateAgentModels(args, 'create_copilot_plan');
  if (!modelValidation.valid) {
    return { success: false, error: modelValidation.error };
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
    
    validation.spec.targetBranch = await resolveTargetBranch(
      baseBranch, repoPath, ctx.git, validation.spec.targetBranch, validation.spec.name, ctx.configProvider
    );
    
    // Create the Plan
    const plan = ctx.PlanRunner.enqueue(validation.spec);
    
    // Build node mapping for response
    const nodeMapping: Record<string, string> = {};
    for (const [producerId, nodeId] of plan.producerIdToNodeId) {
      nodeMapping[producerId] = nodeId;
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
      message: `Plan '${plan.spec.name}' created with ${plan.nodes.size} nodes. ` +
               `Base: ${plan.baseBranch}, Target: ${plan.targetBranch}.${pauseNote} ` +
               `Use planId '${plan.id}' to monitor progress.`,
      nodeMapping,
      status: {
        status: isPaused ? 'paused' : 'pending',
        nodes: plan.nodes.size,
        roots: plan.roots.length,
        leaves: plan.leaves.length,
      },
    };
  } catch (error: any) {
    return errorResult(error.message);
  }
}