/**
 * @fileoverview Phase Executor Interface
 *
 * Defines the contract for execution phase handlers used by
 * {@link DefaultJobExecutor}. Each phase (prechecks, work, postchecks,
 * commit) implements this interface so the executor can orchestrate
 * them uniformly.
 *
 * @module interfaces/IPhaseExecutor
 */

import type {
  JobNode,
  ExecutionPhase,
  CopilotUsageMetrics,
  WorkSpec,
} from '../plan/types';
import type { ChildProcess } from 'child_process';

/**
 * Context passed to a phase executor.
 */
export interface PhaseContext {
  /** The job node being executed */
  node: JobNode;
  /** Resolved worktree path */
  worktreePath: string;
  /** Unique execution key for logging */
  executionKey: string;
  /** The phase being executed */
  phase: ExecutionPhase;
  /** Work spec to execute (prechecks/work/postchecks) */
  workSpec?: WorkSpec;
  /** Base commit SHA (used by commit phase) */
  baseCommit?: string;
  /** Existing Copilot session ID for resumption */
  sessionId?: string;
  
  // --- Merge phase specific fields ---
  /** Dependency commits for forward integration (merge-fi phase) */
  dependencyCommits?: Array<{ nodeId: string; nodeName: string; commit: string }>;
  /** Main repository path (not worktree) for reverse integration (merge-ri phase) */
  repoPath?: string;
  /** Target branch for reverse integration merge */
  targetBranch?: string;
  /** Base commit at the start of plan execution */
  baseCommitAtStart?: string;
  /** Completed commit from work phase */
  completedCommit?: string;

  // --- Callbacks ---
  /** Log an info message */
  logInfo: (message: string) => void;
  /** Log an error message */
  logError: (message: string) => void;
  /** Log stdout/stderr output */
  logOutput: (type: 'stdout' | 'stderr', message: string) => void;

  // --- Mutable execution state ---
  /** Whether execution has been aborted */
  isAborted: () => boolean;
  /** Set the child process for tracking */
  setProcess: (proc: ChildProcess | undefined) => void;
  /** Set execution start time */
  setStartTime: (time: number) => void;
  /** Mark as agent work */
  setIsAgentWork: (value: boolean) => void;
}

/**
 * Result returned by a phase executor.
 */
export interface PhaseResult {
  /** Whether the phase succeeded */
  success: boolean;
  /** Error message on failure */
  error?: string;
  /** Copilot session ID captured during agent work */
  copilotSessionId?: string;
  /** Exit code from the process (if applicable) */
  exitCode?: number;
  /** Usage metrics captured during execution */
  metrics?: CopilotUsageMetrics;
  /** Commit SHA (commit phase only) */
  commit?: string;
  /** AI review metrics (commit phase only) */
  reviewMetrics?: CopilotUsageMetrics;
}

/**
 * Interface for execution phase handlers.
 *
 * Each phase of job execution (prechecks, work, postchecks, commit)
 * implements this interface. The executor delegates to the appropriate
 * phase handler and interprets the result.
 */
export interface IPhaseExecutor {
  /**
   * Execute the phase.
   *
   * @param context - Phase execution context with node, paths, and callbacks.
   * @returns Result indicating success/failure and any captured data.
   */
  execute(context: PhaseContext): Promise<PhaseResult>;
}
