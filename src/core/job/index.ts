/**
 * @fileoverview Job Module - Job execution and management.
 * 
 * This module provides:
 * - Job types (Job, JobSpec, WorkSummary, etc.)
 * - Job logging utilities
 * - Work summary calculation
 * - Metrics extraction from logs
 * 
 * @module core/job
 */

// Types
export {
  CommitDetail,
  WorkSummary,
  JobMetrics,
  StepStatus,
  StepStatuses,
  ExecutionAttempt,
  JobPolicy,
  JobInputs,
  JobSpec,
  JobStatus,
  Job,
  isCompletedStatus,
  isActiveStatus,
  createJobFromSpec,
} from './types';

// Logging
export {
  writeJobLog,
  readJobLog,
  initializeAttemptLog,
  logSectionStart,
  logSectionEnd,
  logOrchestrator,
  logPreflight,
  logError,
  logStepOutput,
} from './logging';

// Work Summary
export { calculateWorkSummary } from './workSummary';

// Metrics
export {
  extractMetricsFromLog,
  calculateTestPassRate,
  getMetricsSummary,
} from './metricsExtractor';
