/**
 * @fileoverview HTTP Response Helpers
 * 
 * Shared helper functions for calculating job status and progress.
 * 
 * @module http/helpers
 */

import { Job } from '../core/job/types';

/**
 * Phase weights for progress calculation.
 */
const PHASE_WEIGHTS: Record<string, number> = {
  'prechecks': 10,
  'work': 70,
  'commit': 75,
  'postchecks': 85,
  'mergeback': 95,
  'cleanup': 100
};

/**
 * Calculate progress percentage based on job phase.
 */
export function calculateProgress(job: Job): number {
  if (job.status === 'succeeded') return 100;
  if (job.status === 'failed' || job.status === 'canceled') return -1;
  if (job.status === 'queued') return 0;
  
  const currentStep = job.currentStep;
  if (!currentStep) return 5;
  
  const stepStatuses = job.stepStatuses || {};
  const phases = ['prechecks', 'work', 'commit', 'postchecks', 'mergeback', 'cleanup'];
  
  let progress = 0;
  for (const phase of phases) {
    const status = stepStatuses[phase as keyof typeof stepStatuses];
    if (status === 'success' || status === 'skipped') {
      progress = PHASE_WEIGHTS[phase];
    } else if (phase === currentStep) {
      const prevPhase = phases[phases.indexOf(phase) - 1];
      const prevProgress = prevPhase ? PHASE_WEIGHTS[prevPhase] : 0;
      progress = prevProgress + (PHASE_WEIGHTS[phase] - prevProgress) / 2;
      break;
    }
  }
  
  return Math.round(progress);
}

/**
 * Build standardized job status response.
 */
export function buildJobStatus(job: Job): Record<string, unknown> {
  const currentAttempt = job.attempts?.find(a => a.attemptId === job.currentAttemptId);
  const isComplete = job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled';
  const isRunning = job.status === 'running' || job.status === 'queued';
  
  // Calculate exponential polling interval
  let recommendedPollIntervalMs = 0;
  if (isRunning && job.startedAt) {
    const durationSec = Math.floor((Date.now() - job.startedAt) / 1000);
    const doublings = Math.floor(durationSec / 30);
    recommendedPollIntervalMs = Math.min(500 * Math.pow(2, doublings), 10000);
  } else if (isRunning) {
    recommendedPollIntervalMs = 500;
  }
  
  return {
    id: job.id,
    isComplete,
    status: job.status,
    progress: calculateProgress(job),
    currentStep: job.currentStep || null,
    stepStatuses: job.stepStatuses || {},
    attemptNumber: job.attempts?.length || 0,
    currentAttempt: currentAttempt ? {
      attemptId: currentAttempt.attemptId,
      status: currentAttempt.status,
      stepStatuses: currentAttempt.stepStatuses || {},
      workSummary: currentAttempt.workSummary || null
    } : null,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    duration: job.endedAt && job.startedAt 
      ? Math.round((job.endedAt - job.startedAt) / 1000) 
      : (job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : null),
    recommendedPollIntervalMs,
    workSummary: job.workSummary || null,
    metrics: job.metrics || null
  };
}
