/**
 * @fileoverview Job Types - Type definitions for job execution.
 * 
 * Single responsibility: Define the data structures for jobs, specs, and state.
 * 
 * @module core/job/types
 */

// ============================================================================
// COMMIT AND WORK SUMMARY
// ============================================================================

/**
 * Detailed information about a single commit.
 */
export interface CommitDetail {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
}

/**
 * Summary of work performed by a job.
 */
export interface WorkSummary {
  commits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  description: string;
  commitDetails?: CommitDetail[];
}

// ============================================================================
// METRICS
// ============================================================================

/**
 * Metrics extracted from job execution logs.
 */
export interface JobMetrics {
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  coveragePercent?: number;
  buildErrors?: number;
  buildWarnings?: number;
}

// ============================================================================
// EXECUTION ATTEMPTS
// ============================================================================

/**
 * Step status values.
 */
export type StepStatus = 'success' | 'failed' | 'skipped';

/**
 * Status for each execution step.
 */
export interface StepStatuses {
  prechecks?: StepStatus;
  work?: StepStatus;
  commit?: StepStatus;
  postchecks?: StepStatus;
  mergeback?: StepStatus;
  cleanup?: StepStatus;
}

/**
 * Record of a single execution attempt.
 */
export interface ExecutionAttempt {
  attemptId: string;
  startedAt: number;
  endedAt?: number;
  logFile: string;
  copilotSessionId?: string;
  workInstruction: string;
  stepStatuses: StepStatuses;
  status: JobStatus;
  workSummary?: WorkSummary;
  metrics?: JobMetrics;
}

// ============================================================================
// JOB SPECIFICATION
// ============================================================================

/**
 * Job execution policy.
 */
export interface JobPolicy {
  useJust: boolean;
  steps: {
    prechecks: string;
    work: string;
    postchecks: string;
  };
}

/**
 * Job input parameters.
 */
export interface JobInputs {
  repoPath: string;
  baseBranch: string;
  targetBranch: string;
  worktreeRoot: string;
  instructions?: string;
  /** 
   * If true, this job is managed by a plan.
   * - Worktree is pre-created by the plan
   * - Job skips branch creation and mergeback
   * - Plan handles all branch lifecycle
   */
  isPlanManaged?: boolean;
  /**
   * For plan-managed jobs: the pre-created worktree path.
   * Job will verify this is a valid worktree before executing.
   */
  worktreePath?: string;
  /**
   * The plan ID this job belongs to (if any).
   * Used to group jobs under their parent plan in the UI.
   */
  planId?: string;
}

/**
 * Job specification - defines what work to do and where.
 * 
 * ## Worktree Management Modes:
 * 
 * ### Standalone Job (isPlanManaged = false, default):
 * - Job creates its own worktree from baseBranch
 * - Job manages branch creation if on default branch
 * - Job performs mergeback into targetBranch after work
 * - Job cleans up its worktree
 * 
 * ### Plan-Managed Job (isPlanManaged = true):
 * - Plan pre-creates worktree and provides worktreePath
 * - Job executes work in provided worktree
 * - Job does NOT create branches or perform mergeback
 * - Plan handles all branch/worktree lifecycle
 */
export interface JobSpec {
  id: string;
  name: string;
  task: string;
  inputs: JobInputs;
  policy: JobPolicy;
}

// ============================================================================
// JOB STATE
// ============================================================================

/**
 * Job status values.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * Runtime job state (extends JobSpec with execution state).
 */
export interface Job extends JobSpec {
  status: JobStatus;
  logFile?: string;
  startedAt?: number;
  endedAt?: number;
  copilotSessionId?: string;
  processIds?: number[];
  currentStep?: string;
  stepStatuses?: StepStatuses;
  workHistory?: string[];
  attempts?: ExecutionAttempt[];
  currentAttemptId?: string;
  workSummary?: WorkSummary;
  metrics?: JobMetrics;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check if a job status indicates completion.
 */
export function isCompletedStatus(status: JobStatus): boolean {
  return ['succeeded', 'failed', 'canceled'].includes(status);
}

/**
 * Check if a job is actively running.
 */
export function isActiveStatus(status: JobStatus): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * Create a fresh job from a spec.
 */
export function createJobFromSpec(spec: JobSpec): Job {
  return {
    ...spec,
    status: 'queued',
  };
}
