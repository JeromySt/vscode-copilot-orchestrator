/**
 * @fileoverview Job-related MCP tool handlers.
 * 
 * Implements the business logic for all job-related MCP tools.
 * 
 * @module mcp/handlers/jobHandlers
 */

import { ToolHandlerContext } from '../types';

/**
 * Calculate progress percentage based on job phase.
 */
function calculateProgress(job: any): number {
  const phaseWeights: Record<string, number> = {
    'prechecks': 10,
    'work': 70,
    'postchecks': 85,
    'mergeback': 95,
    'cleanup': 100
  };
  
  if (job.status === 'succeeded') return 100;
  if (job.status === 'failed' || job.status === 'canceled') return -1;
  if (job.status === 'queued') return 0;
  
  const currentStep = job.currentStep;
  if (!currentStep) return 5;
  
  const stepStatuses = job.stepStatuses || {};
  const phases = ['prechecks', 'work', 'commit', 'postchecks', 'mergeback', 'cleanup'];
  
  let progress = 0;
  for (const phase of phases) {
    if (stepStatuses[phase] === 'success' || stepStatuses[phase] === 'skipped') {
      progress = phaseWeights[phase];
    } else if (phase === currentStep) {
      const prevPhase = phases[phases.indexOf(phase) - 1];
      const prevProgress = prevPhase ? phaseWeights[prevPhase] : 0;
      progress = prevProgress + (phaseWeights[phase] - prevProgress) / 2;
      break;
    }
  }
  
  return Math.round(progress);
}

/**
 * Build a simplified job status object.
 */
export function buildJobStatus(job: any) {
  const isComplete = job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled';
  
  return {
    id: job.id,
    isComplete,
    status: job.status,
    progress: calculateProgress(job),
    currentStep: job.currentStep || null,
    stepStatuses: job.stepStatuses || {},
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    workSummary: job.workSummary || null,
    metrics: job.metrics || null
  };
}

/**
 * Create a new job.
 */
export async function handleCreateJob(args: any, ctx: ToolHandlerContext): Promise<any> {
  const jobId = args.id || `job-${Date.now()}`;
  ctx.runner.enqueue({
    id: jobId,
    name: args.name || args.task,
    task: args.task,
    inputs: {
      repoPath: args.repoPath || ctx.workspacePath,
      baseBranch: args.baseBranch || 'main',
      targetBranch: '',
      worktreeRoot: '',
      instructions: args.instructions
    },
    policy: {
      useJust: false,
      steps: {
        prechecks: args.prechecks || '',
        work: args.work || `@agent ${args.task}`,
        postchecks: args.postchecks || ''
      }
    }
  });
  const job = ctx.runner.list().find(j => j.id === jobId);
  return {
    success: true,
    jobId,
    message: `Job ${jobId} created and queued`,
    status: job ? buildJobStatus(job) : { id: jobId, status: 'queued' }
  };
}

/**
 * Get status of a single job.
 */
export async function handleGetJobStatus(args: any, ctx: ToolHandlerContext): Promise<any> {
  const job = ctx.runner.list().find(j => j.id === args.id);
  if (!job) {
    return { error: `Job ${args.id} not found` };
  }
  return buildJobStatus(job);
}

/**
 * Get status of multiple jobs.
 */
export async function handleGetJobsBatchStatus(args: any, ctx: ToolHandlerContext): Promise<any> {
  const statuses = args.ids.map((id: string) => {
    const job = ctx.runner.list().find(j => j.id === id);
    return job ? buildJobStatus(job) : { id, error: 'Not found' };
  });
  const allComplete = statuses.every((s: any) => s.isComplete || s.error);
  return { statuses, allComplete };
}

/**
 * Get full job details.
 */
export async function handleGetJobDetails(args: any, ctx: ToolHandlerContext): Promise<any> {
  const job = ctx.runner.list().find(j => j.id === args.id);
  if (!job) {
    return { error: `Job ${args.id} not found` };
  }
  return job;
}

/**
 * Get job log section.
 */
export async function handleGetJobLogSection(args: any, ctx: ToolHandlerContext): Promise<any> {
  // Note: getLog may not exist, return a placeholder for now
  return { section: args.section, content: 'Log retrieval not implemented in MCP handler' };
}

/**
 * List all jobs.
 */
export async function handleListJobs(args: any, ctx: ToolHandlerContext): Promise<any> {
  let jobs = ctx.runner.list();
  
  if (args.status && args.status !== 'all') {
    const statusMap: Record<string, string[]> = {
      running: ['running', 'queued'],
      completed: ['succeeded'],
      failed: ['failed', 'canceled']
    };
    const allowed = statusMap[args.status] || [];
    jobs = jobs.filter(j => allowed.includes(j.status));
  }
  
  return { jobs: jobs.map(j => buildJobStatus(j)), count: jobs.length };
}

/**
 * Cancel a job.
 */
export async function handleCancelJob(args: any, ctx: ToolHandlerContext): Promise<any> {
  ctx.runner.cancel(args.id);
  const job = ctx.runner.list().find(j => j.id === args.id);
  return job && job.status === 'canceled'
    ? { success: true, message: `Job ${args.id} canceled` }
    : { error: `Job ${args.id} not found or already completed` };
}

/**
 * Retry a failed job.
 */
export async function handleRetryJob(args: any, ctx: ToolHandlerContext): Promise<any> {
  ctx.runner.retry(args.id, args.instructions);
  const job = ctx.runner.list().find(j => j.id === args.id);
  return job
    ? { success: true, message: `Job ${args.id} queued for retry`, status: buildJobStatus(job) }
    : { error: `Job ${args.id} not found or currently running` };
}

/**
 * Continue work on a job.
 */
export async function handleContinueJobWork(args: any, ctx: ToolHandlerContext): Promise<any> {
  ctx.runner.continueWork(args.id, args.work);
  const job = ctx.runner.list().find(j => j.id === args.id);
  return job
    ? { success: true, message: `Additional work queued for job ${args.id}`, status: buildJobStatus(job) }
    : { error: `Job ${args.id} not found` };
}

/**
 * Delete a job.
 */
export async function handleDeleteJob(args: any, ctx: ToolHandlerContext): Promise<any> {
  ctx.runner.delete(args.id);
  const job = ctx.runner.list().find(j => j.id === args.id);
  return !job
    ? { success: true, message: `Job ${args.id} deleted` }
    : { error: `Job ${args.id} not found or could not be deleted` };
}

/**
 * Delete multiple jobs.
 */
export async function handleDeleteJobs(args: any, ctx: ToolHandlerContext): Promise<any> {
  const results = args.ids.map((id: string) => {
    ctx.runner.delete(id);
    const job = ctx.runner.list().find(j => j.id === id);
    const success = !job;
    return { id, success, message: success ? 'deleted' : 'not found or could not be deleted' };
  });
  const successCount = results.filter((r: any) => r.success).length;
  return {
    success: successCount > 0,
    message: `Deleted ${successCount} of ${args.ids.length} jobs`,
    results
  };
}
