/**
 * @fileoverview Job HTTP route handlers.
 * 
 * Handles all /copilot_job* endpoints.
 * 
 * @module http/routes/jobs
 */

import { Logger } from '../../core/logger';
import * as git from '../../git';
import { RouteContext, ParsedRequest, readBody, sendJson, sendError } from '../types';
import { calculateProgress, buildJobStatus } from '../helpers';

const log = Logger.for('http');

/**
 * GET /copilot_jobs - List all jobs
 */
export async function listJobs(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || pathname !== '/copilot_jobs') return false;
  
  const jobs = context.runner.list();
  sendJson(res, { jobs, count: jobs.length });
  return true;
}

/**
 * POST /copilot_jobs/status - Batch status check
 */
export async function batchJobStatus(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || pathname !== '/copilot_jobs/status') return false;
  
  const body = await readBody(req);
  const { ids } = JSON.parse(body) as { ids: string[] };
  
  if (!ids || !Array.isArray(ids)) {
    sendError(res, 'Missing or invalid ids array');
    return true;
  }
  
  const jobs = context.runner.list();
  const statuses = ids.map(id => {
    const job = jobs.find(j => j.id === id);
    if (!job) return { id, error: 'Job not found' };
    return buildJobStatus(job);
  });
  
  sendJson(res, {
    statuses,
    allComplete: statuses.every(s => 'isComplete' in s && s.isComplete),
    timestamp: Date.now()
  });
  return true;
}

/**
 * POST /copilot_job - Create new job
 */
export async function createJob(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || pathname !== '/copilot_job') return false;
  
  const body = await readBody(req);
  const spec = JSON.parse(body);
  
  // Auto-derive targetBranch from baseBranch if not specified
  if (!spec.inputs.targetBranch) {
    const isDefaultBranch = await git.branches.isDefaultBranch(spec.inputs.baseBranch, spec.inputs.repoPath);
    spec.inputs.targetBranch = isDefaultBranch
      ? `feature/${spec.name.replace(/\W+/g, '-').toLowerCase()}`
      : spec.inputs.baseBranch;
  }
  
  context.runner.enqueue(spec);
  
  const job = context.runner.list().find(j => j.id === spec.id);
  sendJson(res, {
    ok: true,
    id: spec.id,
    message: 'Job created successfully',
    status: job?.status || 'queued',
    currentStep: job?.currentStep || null,
    stepStatuses: job?.stepStatuses || {},
    recommendedPollIntervalMs: 2000
  });
  return true;
}

/**
 * GET /copilot_job/:id/status - Get job status
 */
export async function getJobStatus(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || !pathname.match(/^\/copilot_job\/[^\/]+\/status$/)) return false;
  
  const id = pathname.split('/')[2];
  const job = context.runner.list().find(j => j.id === id);
  
  if (!job) {
    sendError(res, 'Job not found', 404, { id });
    return true;
  }
  
  sendJson(res, buildJobStatus(job));
  return true;
}

/**
 * GET /copilot_job/:id - Get full job details
 */
export async function getJob(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || !pathname.match(/^\/copilot_job\/[^\/]+$/)) return false;
  
  const id = pathname.split('/')[2];
  const job = context.runner.list().find(j => j.id === id);
  
  if (!job) {
    sendError(res, 'Job not found', 404, { id });
    return true;
  }
  
  sendJson(res, job);
  return true;
}

/**
 * POST /copilot_job/:id/cancel - Cancel job
 */
export async function cancelJob(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'POST' || !pathname.endsWith('/cancel')) return false;
  if (!pathname.startsWith('/copilot_job/')) return false;
  
  const id = pathname.split('/')[2];
  (context.runner as any).cancel(id);
  sendJson(res, { ok: true, id, message: 'Job cancelled' });
  return true;
}

/**
 * POST /copilot_job/:id/continue - Continue work on job
 */
export async function continueJob(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || !pathname.endsWith('/continue')) return false;
  if (!pathname.startsWith('/copilot_job/')) return false;
  
  const id = pathname.split('/')[2];
  const body = await readBody(req);
  const data = JSON.parse(body);
  
  const result = (context.runner as any).continueWork(id, data.work);
  if (!result) {
    sendError(res, 'Job not found or cannot be continued', 404, { id });
    return true;
  }
  
  sendJson(res, { ok: true, id, message: 'Job work continuation queued' });
  return true;
}

/**
 * POST /copilot_job/:id/retry - Retry failed job
 */
export async function retryJob(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { req, res, method, pathname } = request;
  
  if (method !== 'POST' || !pathname.endsWith('/retry')) return false;
  if (!pathname.startsWith('/copilot_job/')) return false;
  
  const id = pathname.split('/')[2];
  const body = await readBody(req);
  const data = body ? JSON.parse(body) : {};
  
  (context.runner as any).retry(id, data.workContext);
  
  const job = context.runner.list().find(j => j.id === id);
  const currentAttempt = job?.attempts?.find((a: any) => a.attemptId === job?.currentAttemptId);
  const contextMsg = data.workContext ? ' with updated context' : ' with AI analysis';
  
  sendJson(res, {
    ok: true,
    id,
    message: `Job retry queued${contextMsg}`,
    attemptId: currentAttempt?.attemptId || null,
    attemptNumber: job?.attempts?.length || 0,
    status: job?.status || 'queued',
    currentStep: job?.currentStep || null,
    stepStatuses: job?.stepStatuses || {},
    recommendedPollIntervalMs: 2000
  });
  return true;
}

/**
 * GET /copilot_job/:id/log/:section - Get job log section
 */
export async function getJobLog(request: ParsedRequest, context: RouteContext): Promise<boolean> {
  const { res, method, pathname } = request;
  
  if (method !== 'GET' || !pathname.match(/^\/copilot_job\/[^\/]+\/log\/[^\/]+$/)) return false;
  
  const parts = pathname.split('/');
  const id = parts[2];
  const section = parts[4];
  
  const job = context.runner.list().find(j => j.id === id);
  if (!job) {
    sendError(res, 'Job not found', 404, { id });
    return true;
  }
  
  if (!job.logFile) {
    sendError(res, 'No log file for this job', 404, { id });
    return true;
  }
  
  const fs = require('fs');
  let logContent = '';
  try {
    logContent = fs.readFileSync(job.logFile, 'utf-8');
  } catch (e) {
    sendError(res, 'Failed to read log file', 500, { message: String(e) });
    return true;
  }
  
  let filteredLog = logContent;
  let sectionStatus = 'unknown';
  
  if (section && section !== 'full') {
    const sectionName = section.toUpperCase();
    const startMarker = `========== ${sectionName} SECTION START ==========`;
    const endMarker = `========== ${sectionName} SECTION END ==========`;
    
    const startIdx = logContent.indexOf(startMarker);
    const endIdx = logContent.indexOf(endMarker);
    
    const stepStatus = job.stepStatuses?.[section.toLowerCase() as keyof typeof job.stepStatuses];
    const isCurrentStep = job.currentStep === section.toLowerCase();
    
    if (startIdx >= 0 && endIdx >= 0 && endIdx > startIdx) {
      filteredLog = logContent.substring(startIdx, endIdx + endMarker.length);
      sectionStatus = stepStatus || 'completed';
    } else if (startIdx >= 0) {
      filteredLog = logContent.substring(startIdx);
      sectionStatus = isCurrentStep ? 'running' : (stepStatus || 'in-progress');
    } else {
      if (stepStatus) {
        sectionStatus = stepStatus;
        filteredLog = `Section '${section}' status is '${stepStatus}' but no logs found.`;
      } else if (job.status === 'running' || job.status === 'queued') {
        sectionStatus = 'pending';
        filteredLog = `Section '${section}' has not started yet. Current phase: ${job.currentStep || 'unknown'}.`;
      } else {
        sectionStatus = 'not-run';
        filteredLog = `Section '${section}' was not executed. Job status: ${job.status}.`;
      }
    }
  } else {
    sectionStatus = job.status;
  }
  
  sendJson(res, {
    ok: true,
    jobId: id,
    section,
    sectionStatus,
    jobStatus: job.status,
    currentStep: job.currentStep,
    log: filteredLog
  });
  return true;
}

/**
 * All job route handlers.
 */
export const jobRoutes = [
  listJobs,
  batchJobStatus,
  createJob,
  getJobStatus,
  getJob,
  cancelJob,
  continueJob,
  retryJob,
  getJobLog
];
