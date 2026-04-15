/**
 * @fileoverview Bulk Update Jobs MCP Tool Handler
 * 
 * Applies common AgentSpec attributes (model, modelTier, effort, maxTurns,
 * resumeSession, env) across multiple jobs in a single call. Only "bulk-safe"
 * attributes are accepted — per-job fields like instructions, contextFiles,
 * and allowedFolders must be updated individually via update_copilot_plan_job.
 * 
 * @module mcp/handlers/plan/bulkUpdateJobsHandler
 */

import { AgentSpec, normalizeWorkSpec, JobNode } from '../../../plan/types';
import {
  PlanHandlerContext,
  errorResult,
  validateRequired,
  lookupPlan,
  isError,
} from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/** Fields that can be bulk-set on an AgentSpec without replacing the full work spec. */
const BULK_SAFE_FIELDS = ['model', 'modelTier', 'effort', 'maxTurns', 'resumeSession', 'env'] as const;
type BulkSafeField = typeof BULK_SAFE_FIELDS[number];

/**
 * Handle the `bulk_update_copilot_plan_jobs` MCP tool call.
 *
 * Applies a set of common AgentSpec attributes to multiple (or all) jobs in a plan.
 * Only agent-type work specs are updated — shell/process specs are skipped.
 * Jobs that are already running or terminal are skipped.
 *
 * @param args - Must contain `planId` and `updates` (object with bulk-safe fields).
 *               Optional `jobIds` array to scope to specific jobs (UUIDs or producerIds).
 *               If `jobIds` is omitted, updates ALL agent-type jobs.
 * @param ctx  - Handler context.
 */
export async function handleBulkUpdatePlanJobs(args: any, ctx: PlanHandlerContext): Promise<any> {
  const fieldError = validateRequired(args, ['planId', 'updates']);
  if (fieldError) { return fieldError; }

  const updates = args.updates;
  if (!updates || typeof updates !== 'object') {
    return errorResult('updates must be an object with bulk-safe AgentSpec fields');
  }

  // Validate only bulk-safe fields are provided
  const providedFields = Object.keys(updates);
  const invalidFields = providedFields.filter(f => !(BULK_SAFE_FIELDS as readonly string[]).includes(f));
  if (invalidFields.length > 0) {
    return errorResult(
      `These fields cannot be bulk-updated: ${invalidFields.join(', ')}. ` +
      `Allowed bulk fields: ${BULK_SAFE_FIELDS.join(', ')}. ` +
      `Use update_copilot_plan_job for per-job fields like instructions, contextFiles, allowedFolders.`
    );
  }

  if (providedFields.length === 0) {
    return errorResult('updates must contain at least one field');
  }

  const plan = lookupPlan(ctx, args.planId, 'getPlan');
  if (isError(plan)) { return plan; }

  // Determine which jobs to update
  const targetJobIds: string[] | undefined = args.jobIds;
  const skipped: { id: string; reason: string }[] = [];
  const updated: string[] = [];

  for (const [nodeId, job] of plan.jobs) {
    const jobNode = job as JobNode;
    
    // Skip SV node
    if (jobNode.producerId === '__snapshot-validation__') { continue; }

    // If specific jobIds provided, filter to those
    if (targetJobIds && targetJobIds.length > 0) {
      const match = targetJobIds.some(id =>
        id === nodeId || id === jobNode.producerId || id.toLowerCase() === (jobNode.name ?? '').toLowerCase()
      );
      if (!match) { continue; }
    }

    // Skip terminal/running jobs
    const state = plan.nodeStates.get(nodeId);
    if (state) {
      const status = state.status;
      if (status === 'running' || status === 'succeeded' || status === 'failed' || status === 'blocked' || status === 'canceled') {
        skipped.push({ id: jobNode.producerId ?? nodeId, reason: `status=${status}` });
        continue;
      }
    }

    // Normalize and check if work spec is agent-type
    const normalized = normalizeWorkSpec(jobNode.work);
    if (!normalized || normalized.type !== 'agent') {
      skipped.push({ id: jobNode.producerId ?? nodeId, reason: 'not an agent work spec' });
      continue;
    }

    // Apply bulk-safe fields
    const agentSpec = normalized as AgentSpec;
    for (const field of providedFields) {
      const key = field as BulkSafeField;
      if (updates[key] !== undefined) {
        (agentSpec as any)[key] = updates[key];
      }
    }

    // Write back
    jobNode.work = agentSpec;

    // Persist per-node if repository available
    if (ctx.PlanRepository) {
      try {
        await ctx.PlanRepository.writeNodeSpec(plan.id, jobNode.producerId ?? nodeId, 'work', agentSpec);
      } catch (err) {
        log.warn('Failed to persist bulk update for node', { nodeId, error: err });
      }
    }

    updated.push(jobNode.producerId ?? nodeId);
  }

  // Save plan
  ctx.PlanRunner.savePlan(args.planId);
  ctx.PlanRunner.emit('planUpdated', args.planId);

  log.info('Bulk update applied', {
    planId: args.planId,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    fields: providedFields,
  });

  return {
    success: true,
    updated: updated.length,
    skipped: skipped.length,
    skippedDetails: skipped.length > 0 ? skipped : undefined,
    updatedJobs: updated,
    fieldsApplied: providedFields,
    message: `Updated ${updated.length} job(s) with ${providedFields.join(', ')}. ${skipped.length} skipped.`,
  };
}
