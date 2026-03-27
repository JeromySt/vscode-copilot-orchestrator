/**
 * @fileoverview Batch Add Jobs MCP Tool Handler
 * 
 * Implements handler for adding multiple jobs to a scaffolding plan in a single call.
 * Delegates to addJobHandler for each job, collecting results.
 * 
 * @module mcp/handlers/plan/addJobsHandler
 */

import { handleAddPlanJob } from './addJobHandler';
import type { PlanHandlerContext } from '../utils';
import { errorResult } from '../utils';
import { Logger } from '../../../core/logger';

const log = Logger.for('mcp');

/**
 * Handle add_copilot_plan_jobs (batch) MCP tool call.
 * 
 * Adds multiple jobs to a scaffolding plan sequentially.
 * If any job fails validation, it stops and reports which jobs succeeded and which failed.
 */
export async function handleAddPlanJobs(args: any, ctx: PlanHandlerContext): Promise<any> {
  const { planId, jobs } = args || {};

  if (!planId || typeof planId !== 'string') {
    return errorResult("Missing required field 'planId'");
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return errorResult("Missing or empty 'jobs' array");
  }
  if (jobs.length > 100) {
    return errorResult(`Too many jobs (${jobs.length}). Maximum is 100 per batch.`);
  }

  const results: Array<{ producerId: string; success: boolean; error?: string }> = [];
  let successCount = 0;

  for (const job of jobs) {
    const jobArgs = { planId, ...job };
    const result = await handleAddPlanJob(jobArgs, ctx);

    if (result.success) {
      successCount++;
      results.push({ producerId: job.producerId || 'unknown', success: true });
    } else {
      const errorMsg = typeof result.content === 'string' 
        ? result.content 
        : result.content?.[0]?.text || 'Unknown error';
      results.push({ producerId: job.producerId || 'unknown', success: false, error: errorMsg });
      log.warn('Batch add job failed, stopping', { planId, producerId: job.producerId, error: errorMsg });
      break;
    }
  }

  const allSucceeded = successCount === jobs.length;

  if (allSucceeded) {
    return {
      success: true,
      added: successCount,
      total: jobs.length,
      message: `All ${successCount} jobs added to plan '${planId}'.`,
      results,
    };
  }

  return errorResult(
    `Batch add stopped: ${successCount}/${jobs.length} jobs added. ` +
    `Failed on '${results[results.length - 1]?.producerId}': ${results[results.length - 1]?.error}`
  );
}
