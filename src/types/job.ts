/**
 * @fileoverview Job-related type definitions for the Copilot Orchestrator.
 * 
 * This module contains all type definitions related to jobs, including:
 * - Job specifications (what a job should do)
 * - Job state (runtime status)
 * - Execution attempts (retry tracking)
 * - Work summaries and metrics
 * 
 * @module types/job
 */

/**
 * Summary of work completed during a job execution.
 * Extracted from git diff analysis after AI agent completes work.
 */
export interface WorkSummary {
  /** Number of commits made during the job */
  commits: number;
  /** Number of new files added */
  filesAdded: number;
  /** Number of existing files modified */
  filesModified: number;
  /** Number of files deleted */
  filesDeleted: number;
  /** Human-readable description of the changes */
  description: string;
}

/**
 * Metrics extracted from job execution logs.
 * Used to track build and test results for reporting.
 */
export interface JobMetrics {
  /** Total number of tests executed */
  testsRun?: number;
  /** Number of tests that passed */
  testsPassed?: number;
  /** Number of tests that failed */
  testsFailed?: number;
  /** Code coverage percentage (0-100) */
  coveragePercent?: number;
  /** Number of build/compile errors */
  buildErrors?: number;
  /** Number of build/compile warnings */
  buildWarnings?: number;
}

/**
 * Status of individual steps within a job execution.
 * Each step can be successful, failed, or skipped.
 */
export interface StepStatuses {
  /** Status of pre-check commands (e.g., npm test before changes) */
  prechecks?: 'success' | 'failed' | 'skipped';
  /** Status of the main work step (AI agent or shell command) */
  work?: 'success' | 'failed' | 'skipped';
  /** Status of post-check commands (e.g., npm test after changes) */
  postchecks?: 'success' | 'failed' | 'skipped';
  /** Status of merging changes back to base branch */
  mergeback?: 'success' | 'failed' | 'skipped';
  /** Status of cleanup (removing worktree, temp files) */
  cleanup?: 'success' | 'failed' | 'skipped';
}

/**
 * Possible states for a job's lifecycle.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * A single execution attempt of a job.
 * Jobs can have multiple attempts when retried after failure.
 */
export interface ExecutionAttempt {
  /** Unique identifier for this attempt */
  attemptId: string;
  /** Unix timestamp when this attempt started */
  startedAt: number;
  /** Unix timestamp when this attempt ended (if completed) */
  endedAt?: number;
  /** Path to the log file for this attempt */
  logFile: string;
  /** GitHub Copilot session ID (if AI agent was used) */
  copilotSessionId?: string;
  /** The work instruction given for this attempt */
  workInstruction: string;
  /** Status of each step in this attempt */
  stepStatuses: StepStatuses;
  /** Overall status of this attempt */
  status: JobStatus;
  /** Summary of work completed (if successful) */
  workSummary?: WorkSummary;
  /** Metrics extracted from logs */
  metrics?: JobMetrics;
}

/**
 * Policy defining how a job should be executed.
 */
export interface JobPolicy {
  /** Whether to use 'just' task runner (for future use) */
  useJust: boolean;
  /** Commands/instructions for each step */
  steps: {
    /** Pre-check command (e.g., "npm test") */
    prechecks: string;
    /** Main work instruction (AI prompt or shell command) */
    work: string;
    /** Post-check command (e.g., "npm run lint") */
    postchecks: string;
  };
}

/**
 * Input parameters for a job.
 */
export interface JobInputs {
  /** Absolute path to the git repository */
  repoPath: string;
  /** Branch to start from and merge back into */
  baseBranch: string;
  /** Branch name for the job's work (auto-generated if on default branch) */
  targetBranch: string;
  /** Directory name for git worktrees (relative to repoPath) */
  worktreeRoot: string;
  /** Additional instructions for the AI agent */
  instructions?: string;
}

/**
 * Specification for creating a new job.
 * This is what the API/MCP receives to create a job.
 */
export interface JobSpec {
  /** Unique job identifier (GUID) */
  id: string;
  /** Human-readable job name for display */
  name: string;
  /** Brief description of the task */
  task: string;
  /** Input parameters */
  inputs: JobInputs;
  /** Execution policy */
  policy: JobPolicy;
}

/**
 * Full job state including runtime information.
 * Extends JobSpec with execution state tracking.
 */
export interface Job extends JobSpec {
  /** Current status of the job */
  status: JobStatus;
  /** Path to the job's log file */
  logFile?: string;
  /** Unix timestamp when the job started executing */
  startedAt?: number;
  /** Unix timestamp when the job completed */
  endedAt?: number;
  /** Current Copilot session ID (for the active attempt) */
  copilotSessionId?: string;
  /** Process IDs spawned by this job (for monitoring/cleanup) */
  processIds?: number[];
  /** Current step being executed */
  currentStep?: string;
  /** Status of each step */
  stepStatuses?: StepStatuses;
  /** History of work instructions (for retries) */
  workHistory?: string[];
  /** All execution attempts */
  attempts?: ExecutionAttempt[];
  /** ID of the currently active attempt */
  currentAttemptId?: string;
  /** Summary of work completed */
  workSummary?: WorkSummary;
  /** Metrics extracted from execution */
  metrics?: JobMetrics;
}

/**
 * Data transfer object for job status responses.
 * Simplified view of job state for API consumers.
 */
export interface JobStatusDto {
  /** Job identifier */
  id: string;
  /** Job display name */
  name: string;
  /** Current status */
  status: JobStatus;
  /** Whether the job has reached a terminal state */
  isComplete: boolean;
  /** Estimated progress (0-100, or -1 if failed/canceled) */
  progress: number;
  /** Current execution step */
  currentStep: string | null;
  /** Status of all steps */
  stepStatuses: StepStatuses;
  /** Work summary (if available) */
  workSummary: WorkSummary | null;
  /** Execution metrics */
  metrics: JobMetrics | null;
  /** Duration in seconds */
  duration: number | null;
  /** Recommended polling interval in milliseconds */
  recommendedPollIntervalMs: number;
}
