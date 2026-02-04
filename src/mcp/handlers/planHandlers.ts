/**
 * @fileoverview Plan-related MCP tool handlers.
 * 
 * Implements the business logic for all plan-related MCP tools.
 * 
 * Producer ID Pattern (SIMPLIFIED - no backward compatibility):
 * - producer_id: REQUIRED - user-controlled DAG reference key
 * - Format: [a-z0-9-]{5,64} (lowercase letters, numbers, hyphens, 5-64 chars)
 * - Used in consumesFrom arrays to establish dependencies
 * - Must be unique within scope (plan-level or sub-plan-level)
 * - Declaration order does NOT matter - a job can depend on a sub-plan declared after it
 * 
 * Internal IDs:
 * - id: UUID (auto-generated) - used for worktree paths, branch naming
 * - name: Human-friendly display string (defaults to producer_id)
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
 * - Sub-plan jobs have their own producer_id scope (unique within the sub-plan)
 * 
 * @module mcp/handlers/planHandlers
 */

import { ToolHandlerContext } from '../types';
import { PlanSpec, PlanJob, SubPlanSpec } from '../../core/planRunner';
import { PRODUCER_ID_PATTERN } from '../tools/planTools';

/**
 * Map sub-plan args to SubPlanSpec recursively.
 * 
 * Producer ID Convention:
 * - producer_id = user-controlled reference (used in consumesFrom)
 * - id = UUID (auto-assigned by PlanRunner)
 * - name = user-friendly display string (defaults to producer_id)
 */
function mapSubPlans(subPlans: any[] | undefined): SubPlanSpec[] | undefined {
  if (!subPlans || subPlans.length === 0) return undefined;
  
  return subPlans.map((sp: any): SubPlanSpec => ({
    id: '',  // Will be assigned by PlanRunner as UUID
    name: sp.name || sp.producer_id,  // Display name (defaults to producer_id)
    producerId: sp.producer_id,  // User-controlled reference for consumesFrom
    consumesFrom: sp.consumesFrom || [],  // References other work units by producer_id
    maxParallel: sp.maxParallel,
    jobs: (sp.jobs || []).map((j: any) => ({
      id: '',  // Will be assigned by PlanRunner as UUID
      name: j.name || j.producer_id,  // Display name (defaults to producer_id)
      producerId: j.producer_id,  // User-controlled reference for consumesFrom
      task: j.task,
      work: j.work,
      consumesFrom: j.consumesFrom || [],  // References by producer_id
      prechecks: j.prechecks,
      postchecks: j.postchecks,
      instructions: j.instructions
    })),
    subPlans: mapSubPlans(sp.subPlans)  // Recursive!
  }));
}

/**
 * Validate plan input strictly according to schema.
 * - Validates required fields (producer_id, task)
 * - Validates producer_id format (lowercase, numbers, hyphens, 5-64 chars)
 * - Validates producer_id uniqueness within scope
 * - Validates all consumesFrom references point to valid producer_id values
 * - Rejects invalid structures with clear error messages
 */
function validateAndTransformPlanInput(args: any): { valid: boolean; error?: string; transformed: any } {
  // Must have jobs array
  if (!args.jobs || !Array.isArray(args.jobs) || args.jobs.length === 0) {
    return { valid: false, error: 'Plan must have at least one job in the jobs array', transformed: args };
  }
  
  // Validate each job has required fields and valid producer_id
  for (let i = 0; i < args.jobs.length; i++) {
    const job = args.jobs[i];
    
    // producer_id is required
    if (!job.producer_id) {
      return { valid: false, error: `Job at index ${i} is missing required 'producer_id' field`, transformed: args };
    }
    
    // Validate producer_id format
    if (!PRODUCER_ID_PATTERN.test(job.producer_id)) {
      return { 
        valid: false, 
        error: `Job '${job.producer_id}' has invalid producer_id format. ` +
               `Must be 5-64 characters, lowercase letters (a-z), numbers (0-9), and hyphens (-) only. ` +
               `Example: "build-step", "run-tests-01"`,
        transformed: args 
      };
    }
    
    if (!job.task) {
      return { valid: false, error: `Job '${job.producer_id}' is missing required 'task' field`, transformed: args };
    }
    
    // consumesFrom is required (can be empty array for root jobs)
    if (!job.consumesFrom || !Array.isArray(job.consumesFrom)) {
      return { valid: false, error: `Job '${job.producer_id}' is missing required 'consumesFrom' array (use [] for root jobs)`, transformed: args };
    }
    
    // Reject inline subPlan on jobs - must use top-level subPlans array
    if (job.subPlan) {
      return { 
        valid: false, 
        error: `Job '${job.producer_id}' has inline 'subPlan' property which is not supported. ` +
               `Sub-plans must be defined in the top-level 'subPlans' array with 'consumesFrom' referencing the parent job. ` +
               `Example: { "subPlans": [{ "producer_id": "sub-plan-1", "consumesFrom": ["${job.producer_id}"], "jobs": [...] }] }`,
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
      
      // producer_id is required
      if (!sp.producer_id) {
        return { valid: false, error: `SubPlan at index ${i} is missing required 'producer_id' field`, transformed: args };
      }
      
      // Validate producer_id format
      if (!PRODUCER_ID_PATTERN.test(sp.producer_id)) {
        return { 
          valid: false, 
          error: `SubPlan '${sp.producer_id}' has invalid producer_id format. ` +
                 `Must be 5-64 characters, lowercase letters (a-z), numbers (0-9), and hyphens (-) only.`,
          transformed: args 
        };
      }
      
      if (!sp.jobs || !Array.isArray(sp.jobs) || sp.jobs.length === 0) {
        return { valid: false, error: `SubPlan '${sp.producer_id}' must have at least one job`, transformed: args };
      }
      
      // consumesFrom is required for sub-plans
      if (!sp.consumesFrom || !Array.isArray(sp.consumesFrom)) {
        return { valid: false, error: `SubPlan '${sp.producer_id}' is missing required 'consumesFrom' array`, transformed: args };
      }
      
      // Validate sub-plan jobs
      for (let j = 0; j < sp.jobs.length; j++) {
        const spJob = sp.jobs[j];
        
        if (!spJob.producer_id) {
          return { valid: false, error: `Job at index ${j} in sub-plan '${sp.producer_id}' is missing required 'producer_id' field`, transformed: args };
        }
        
        if (!PRODUCER_ID_PATTERN.test(spJob.producer_id)) {
          return { 
            valid: false, 
            error: `Job '${spJob.producer_id}' in sub-plan '${sp.producer_id}' has invalid producer_id format. ` +
                   `Must be 5-64 characters, lowercase letters (a-z), numbers (0-9), and hyphens (-) only.`,
            transformed: args 
          };
        }
        
        if (!spJob.task) {
          return { valid: false, error: `Job '${spJob.producer_id}' in sub-plan '${sp.producer_id}' is missing required 'task' field`, transformed: args };
        }
      }
    }
  }
  
  // =========================================================================
  // Validate producer_id uniqueness and consumesFrom references
  // =========================================================================
  const validationResult = validateProducerIdsAndReferences(args);
  if (!validationResult.valid) {
    return { valid: false, error: validationResult.error, transformed: args };
  }
  
  return { valid: true, transformed: args };
}

/**
 * Validate that:
 * 1. All producer_id values are unique within their scope
 * 2. All consumesFrom references point to valid producer_id values
 * 3. No circular dependencies exist (optional - detected at runtime if needed)
 * 
 * Note: Declaration order does NOT matter. A job can depend on a sub-plan that's
 * declared after it in the JSON structure. The runtime scheduler handles proper
 * execution order based on the dependency graph.
 */
function validateProducerIdsAndReferences(args: any): { valid: boolean; error?: string } {
  // Collect all producer_ids at the plan level
  const allJobProducerIds = new Set<string>();
  const allSubPlanProducerIds = new Set<string>();
  
  // Collect job producer_ids and check for duplicates
  for (const job of args.jobs || []) {
    const producerId = job.producer_id;
    if (allJobProducerIds.has(producerId)) {
      return {
        valid: false,
        error: `Duplicate producer_id '${producerId}' found in plan jobs. Each job must have a unique producer_id.`
      };
    }
    allJobProducerIds.add(producerId);
  }
  
  // Collect sub-plan producer_ids and check for duplicates/collisions
  for (const sp of args.subPlans || []) {
    const producerId = sp.producer_id;
    
    if (allSubPlanProducerIds.has(producerId)) {
      return {
        valid: false,
        error: `Duplicate producer_id '${producerId}' found in sub-plans. Each sub-plan must have a unique producer_id.`
      };
    }
    
    if (allJobProducerIds.has(producerId)) {
      return {
        valid: false,
        error: `producer_id '${producerId}' is used by both a job and a sub-plan. Each work unit must have a unique producer_id within the plan.`
      };
    }
    
    allSubPlanProducerIds.add(producerId);
  }
  
  // All valid references at the plan level (jobs + sub-plans)
  const validPlanRefs = new Set([...allJobProducerIds, ...allSubPlanProducerIds]);
  
  // Validate consumesFrom references for jobs
  for (const job of args.jobs || []) {
    for (const ref of job.consumesFrom || []) {
      if (!validPlanRefs.has(ref)) {
        const suggestions = findSimilarNames(ref, validPlanRefs);
        const suggestionMsg = suggestions.length > 0 
          ? ` Did you mean: ${suggestions.map(s => `'${s}'`).join(' or ')}?`
          : '';
        return {
          valid: false,
          error: `Job '${job.producer_id}' has invalid consumesFrom reference '${ref}'. ` +
                 `No job or sub-plan with that producer_id exists.${suggestionMsg} ` +
                 `Valid producer_ids: ${[...validPlanRefs].map(n => `'${n}'`).join(', ')}`
        };
      }
      
      // Self-reference check
      if (ref === job.producer_id) {
        return {
          valid: false,
          error: `Job '${job.producer_id}' cannot reference itself in consumesFrom.`
        };
      }
    }
  }
  
  // Validate consumesFrom references for sub-plans
  for (const sp of args.subPlans || []) {
    for (const ref of sp.consumesFrom || []) {
      if (!validPlanRefs.has(ref)) {
        const suggestions = findSimilarNames(ref, validPlanRefs);
        const suggestionMsg = suggestions.length > 0 
          ? ` Did you mean: ${suggestions.map(s => `'${s}'`).join(' or ')}?`
          : '';
        return {
          valid: false,
          error: `Sub-plan '${sp.producer_id}' has invalid consumesFrom reference '${ref}'. ` +
                 `No job or sub-plan with that producer_id exists.${suggestionMsg} ` +
                 `Valid producer_ids: ${[...validPlanRefs].map(n => `'${n}'`).join(', ')}`
        };
      }
      
      // Self-reference check
      if (ref === sp.producer_id) {
        return {
          valid: false,
          error: `Sub-plan '${sp.producer_id}' cannot reference itself in consumesFrom.`
        };
      }
    }
    
    // Validate jobs within the sub-plan (internal scope)
    const subPlanJobProducerIds = new Set<string>();
    
    // Collect producer_ids within sub-plan
    for (const spJob of sp.jobs || []) {
      const producerId = spJob.producer_id;
      if (subPlanJobProducerIds.has(producerId)) {
        return {
          valid: false,
          error: `Duplicate producer_id '${producerId}' in sub-plan '${sp.producer_id}'. Each job must have a unique producer_id.`
        };
      }
      subPlanJobProducerIds.add(producerId);
    }
    
    // Validate consumesFrom within sub-plan (jobs can only reference other jobs in the same sub-plan)
    for (const spJob of sp.jobs || []) {
      for (const ref of spJob.consumesFrom || []) {
        if (!subPlanJobProducerIds.has(ref)) {
          const suggestions = findSimilarNames(ref, subPlanJobProducerIds);
          const suggestionMsg = suggestions.length > 0 
            ? ` Did you mean: ${suggestions.map(s => `'${s}'`).join(' or ')}?`
            : '';
          return {
            valid: false,
            error: `Job '${spJob.producer_id}' in sub-plan '${sp.producer_id}' has invalid consumesFrom '${ref}'. ` +
                   `Jobs within a sub-plan can only reference other jobs in the same sub-plan.${suggestionMsg} ` +
                   `Valid producer_ids in '${sp.producer_id}': ${[...subPlanJobProducerIds].map(n => `'${n}'`).join(', ')}`
          };
        }
        
        // Self-reference check
        if (ref === spJob.producer_id) {
          return {
            valid: false,
            error: `Job '${spJob.producer_id}' in sub-plan '${sp.producer_id}' cannot reference itself in consumesFrom.`
          };
        }
      }
    }
    
    // Check for cycles within this sub-plan
    const subPlanCycle = detectCycle(sp.jobs || [], 'sub-plan');
    if (subPlanCycle) {
      return {
        valid: false,
        error: `Circular dependency detected in sub-plan '${sp.producer_id}': ${subPlanCycle.join(' -> ')} -> ${subPlanCycle[0]}. ` +
               `Jobs cannot have circular dependencies.`
      };
    }
  }
  
  // =========================================================================
  // Cycle detection at the plan level (jobs + sub-plans)
  // =========================================================================
  const planLevelNodes = [
    ...(args.jobs || []).map((j: any) => ({ producer_id: j.producer_id, consumesFrom: j.consumesFrom || [] })),
    ...(args.subPlans || []).map((sp: any) => ({ producer_id: sp.producer_id, consumesFrom: sp.consumesFrom || [] }))
  ];
  
  const planCycle = detectCycle(planLevelNodes, 'plan');
  if (planCycle) {
    return {
      valid: false,
      error: `Circular dependency detected in plan: ${planCycle.join(' -> ')} -> ${planCycle[0]}. ` +
             `Work units cannot have circular dependencies.`
    };
  }
  
  return { valid: true };
}

/**
 * Detect cycles in a dependency graph using DFS.
 * Returns the cycle path if found, or null if no cycle exists.
 * 
 * @param nodes - Array of nodes with producer_id and consumesFrom
 * @param scope - 'plan' or 'sub-plan' for error context
 */
function detectCycle(
  nodes: Array<{ producer_id: string; consumesFrom: string[] }>,
  scope: string
): string[] | null {
  // Build adjacency list (node -> nodes it depends on)
  const graph = new Map<string, string[]>();
  for (const node of nodes) {
    graph.set(node.producer_id, node.consumesFrom || []);
  }
  
  // Track visited state: 0 = unvisited, 1 = visiting (in current path), 2 = visited (done)
  const state = new Map<string, number>();
  const parent = new Map<string, string>(); // For reconstructing the cycle path
  
  for (const node of nodes) {
    state.set(node.producer_id, 0);
  }
  
  // DFS to find cycle
  function dfs(nodeId: string, path: string[]): string[] | null {
    state.set(nodeId, 1); // Mark as visiting
    path.push(nodeId);
    
    const dependencies = graph.get(nodeId) || [];
    for (const dep of dependencies) {
      // Skip if dependency is not in this scope (e.g., sub-plan job referencing plan-level)
      if (!state.has(dep)) continue;
      
      const depState = state.get(dep);
      
      if (depState === 1) {
        // Found a cycle! Return the cycle path
        const cycleStart = path.indexOf(dep);
        return path.slice(cycleStart);
      }
      
      if (depState === 0) {
        const cycle = dfs(dep, path);
        if (cycle) return cycle;
      }
    }
    
    state.set(nodeId, 2); // Mark as done
    path.pop();
    return null;
  }
  
  // Run DFS from each unvisited node
  for (const node of nodes) {
    if (state.get(node.producer_id) === 0) {
      const cycle = dfs(node.producer_id, []);
      if (cycle) return cycle;
    }
  }
  
  return null;
}

/**
 * Find names similar to the given reference (for helpful error messages).
 * Uses simple substring matching and Levenshtein-like heuristics.
 */
function findSimilarNames(ref: string, validNames: Set<string>): string[] {
  const refLower = ref.toLowerCase();
  const suggestions: string[] = [];
  
  for (const name of validNames) {
    const nameLower = name.toLowerCase();
    
    // Check for substring match (e.g., "g-publish" vs "Publish Sub-plan")
    if (nameLower.includes(refLower) || refLower.includes(nameLower)) {
      suggestions.push(name);
      continue;
    }
    
    // Check for common word overlap (split on non-alphanumeric)
    const refWords = refLower.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const nameWords = nameLower.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const hasCommonWord = refWords.some(rw => nameWords.some(nw => nw.includes(rw) || rw.includes(nw)));
    if (hasCommonWord) {
      suggestions.push(name);
    }
  }
  
  return suggestions.slice(0, 3);  // Return at most 3 suggestions
}

/**
 * Create a new plan with proper branch chaining.
 * 
 * The key insight: jobs with dependencies don't specify their own baseBranch.
 * Instead, the PlanRunner automatically sets baseBranch from the completed
 * dependency's branch. This ensures proper code flow through the DAG.
 * 
 * Producer ID Convention:
 * - producer_id = user-controlled reference (used in consumesFrom)
 * - id = UUID (auto-generated by PlanRunner for worktrees/branches)
 * - name = user-friendly display string (defaults to producer_id)
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
  
  // Map sub-plans recursively
  const subPlans = mapSubPlans(args.subPlans);
  
  // Build the plan spec with proper structure
  // Note: plan.id will be assigned by enqueue() (UUID)
  const planSpec: PlanSpec = {
    id: '',  // Will be assigned by PlanRunner.enqueue() as UUID
    name: args.name || `Plan ${Date.now()}`,  // User-friendly name
    repoPath: ctx.workspacePath,
    // worktreeRoot is NOT set here - enqueue() will set it using UUID for consistency
    baseBranch: args.baseBranch || 'main',  // Plan's starting point
    targetBranch: args.targetBranch,         // Optional: where to merge final results
    maxParallel: args.maxParallel,
    // Jobs: producer_id for DAG references, id (UUID) assigned by enqueue()
    jobs: args.jobs.map((j: any): PlanJob => ({
      id: '',  // Will be assigned by PlanRunner.enqueue() as UUID
      name: j.name || j.producer_id,  // Display name (defaults to producer_id)
      producerId: j.producer_id,  // User-controlled reference for consumesFrom
      task: j.task,
      consumesFrom: j.consumesFrom || [],  // References other jobs by producer_id
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
  // After enqueue, spec.id is now assigned
  const plan = ctx.plans.get(planSpec.id);
  
  // Get the producer_id -> UUID mapping for jobs
  const jobIdMap = ctx.plans.getJobIdMap ? ctx.plans.getJobIdMap(planSpec.id) : undefined;
  const jobMapping: Record<string, string> = {};
  if (jobIdMap) {
    for (const [producerId, uuid] of jobIdMap) {
      jobMapping[producerId] = uuid;
    }
  }
  
  // Count sub-plans recursively for message
  const countSubPlans = (sps: SubPlanSpec[] | undefined): number => {
    if (!sps) return 0;
    return sps.reduce((sum, sp) => sum + 1 + countSubPlans(sp.subPlans), 0);
  };
  const totalSubPlans = countSubPlans(subPlans);
  
  return {
    success: true,
    planId: planSpec.id,
    planName: planSpec.name,
    message: `Plan '${planSpec.name}' created with ${args.jobs.length} jobs${totalSubPlans > 0 ? ` and ${totalSubPlans} sub-plan(s)` : ''}. ` +
             `Use planId '${planSpec.id}' with get_copilot_plan_status to monitor progress.`,
    // IMPORTANT: Mapping of producer_id -> job UUID for status queries
    jobIdMapping: jobMapping,
    branchFlow: describeBranchFlow(planSpec),
    status: plan,
    // Usage hints for the AI
    usageHints: {
      getPlanStatus: `get_copilot_plan_status({ "id": "${planSpec.id}" })`,
      getJobDetails: `get_copilot_job_details({ "id": "<job_uuid_from_jobIdMapping>" })`,
      note: "Use UUIDs from jobIdMapping when querying individual jobs. The planId is also a UUID."
    }
  };
}

/**
 * Describe the branch flow for documentation/debugging.
 */
function describeBranchFlow(spec: PlanSpec): string {
  const lines = [`Plan starts from: ${spec.baseBranch}`];
  
  // Simple topological description using job names
  for (const job of spec.jobs) {
    const consumesFrom = job.consumesFrom || [];
    if (consumesFrom.length === 0) {
      lines.push(`  ${job.name}: branches from ${spec.baseBranch}`);
    } else {
      lines.push(`  ${job.name}: consumes from ${consumesFrom.join(', ')}`);
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
