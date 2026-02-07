/**
 * @fileoverview Plan Types
 *
 * Defines the Plan specification, Plan instance, execution state,
 * work summaries, events, executor types, and log types.
 *
 * @module plan/types/plan
 */

import type { WorkSpec } from './specs';
import type { NodeStatus, JobNodeSpec, SubPlanNodeSpec, PlanNode, JobNode } from './nodes';

// ============================================================================
// PLAN SPECIFICATION (User Input)
// ============================================================================

/**
 * Full Plan specification (user input for creating a Plan).
 */
export interface PlanSpec {
  /** Human-friendly name for the Plan */
  name: string;
  
  /** Repository path (defaults to workspace) */
  repoPath?: string;
  
  /** Base branch to start from (default: main) */
  baseBranch?: string;
  
  /** Target branch to merge final results into */
  targetBranch?: string;
  
  /** Max concurrent jobs (default: 4) */
  maxParallel?: number;
  
  /** Whether to clean up worktrees after successful merges (default: true) */
  cleanUpSuccessfulWork?: boolean;
  
  /** Job nodes in this Plan */
  jobs: JobNodeSpec[];
  
  /** sub-plan nodes */
  subPlans?: SubPlanNodeSpec[];
}

// ============================================================================
// PLAN STATE (Execution State)
// ============================================================================

/**
 * Per-phase execution status
 */
export type PhaseStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

/**
 * Execution state for a single node
 */
export interface NodeExecutionState {
  /** Current status */
  status: NodeStatus;
  
  /** When the node was scheduled */
  scheduledAt?: number;
  
  /** When execution started */
  startedAt?: number;
  
  /** When execution ended */
  endedAt?: number;
  
  /** Error message if failed */
  error?: string;
  
  /** Base commit SHA the worktree was created from */
  baseCommit?: string;
  
  /** Completed commit SHA (for jobs) - the final commit after work is done */
  completedCommit?: string;
  
  /** Worktree path (for jobs) - detached HEAD mode, no branch */
  worktreePath?: string;
  
  /** Child Plan ID (for subPlans) */
  childPlanId?: string;
  
  /** Execution attempt count */
  attempts: number;
  
  /** Work summary (files changed, commits) - set on success */
  workSummary?: JobWorkSummary;
  
  /** 
   * Whether this leaf node's commit was successfully merged to targetBranch.
   * Only set for leaf nodes when targetBranch is specified.
   * Worktree cleanup is blocked until this is true (or node is not a leaf).
   */
  mergedToTarget?: boolean;
  
  /**
   * List of dependent node IDs that have successfully consumed (FI'd from) this node.
   * Once all dependents have consumed, this node's worktree is safe to cleanup.
   * This allows cleanup as soon as FI completes, rather than waiting for 
   * dependents to fully succeed.
   */
  consumedByDependents?: string[];
  
  /**
   * Whether the worktree has been cleaned up (removed from disk).
   * Set to true after successful cleanup to prevent "Open Worktree" button.
   */
  worktreeCleanedUp?: boolean;

  /**
   * Per-phase execution status for detailed UI display.
   * Tracks prechecks, work, commit, postchecks phases individually.
   */
  stepStatuses?: {
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
  };
  
  /**
   * Copilot CLI session ID for session resumption.
   * Captured from CLI output during agent work execution.
   * Can be used to resume context on retry or follow-up.
   */
  copilotSessionId?: string;
  
  /**
   * Details about the last execution attempt (for retry context).
   */
  lastAttempt?: {
    /** Which phase failed or was running */
    phase: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri';
    /** When the attempt started */
    startTime: number;
    /** When the attempt ended */
    endTime?: number;
    /** Error message if failed */
    error?: string;
    /** Exit code from process (if applicable) */
    exitCode?: number;
  };
  
  /**
   * History of all execution attempts for this node.
   * Each attempt captures the state and outcome of an execution try.
   */
  attemptHistory?: AttemptRecord[];
}

/**
 * Record of a single execution attempt.
 */
export interface AttemptRecord {
  /** Attempt number (1-based) */
  attemptNumber: number;
  
  /** Status of this attempt */
  status: 'succeeded' | 'failed' | 'canceled';
  
  /** When the attempt started */
  startedAt: number;
  
  /** When the attempt ended */
  endedAt: number;
  
  /** Which phase failed (if failed) */
  failedPhase?: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri';
  
  /** Error message (if failed) */
  error?: string;
  
  /** Exit code (if applicable) */
  exitCode?: number;
  
  /** Copilot session ID used in this attempt */
  copilotSessionId?: string;
  
  /** Per-phase status at end of attempt */
  stepStatuses?: {
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
  };
  
  /** Worktree path used in this attempt */
  worktreePath?: string;
  
  /** Base commit SHA this attempt started from */
  baseCommit?: string;
  
  /** Completed commit SHA from this attempt (if work succeeded) */
  completedCommit?: string;
  
  /** Logs captured during this attempt (stored as string to reduce memory) */
  logs?: string;
  
  /** Work spec used for this attempt (for reference) */
  workUsed?: WorkSpec;
}

/**
 * Overall Plan status (derived from node states)
 */
export type PlanStatus = 
  | 'pending'    // Not started
  | 'running'    // At least one node running
  | 'succeeded'  // All nodes succeeded
  | 'failed'     // At least one node failed (not blocked)
  | 'partial'    // Some succeeded, some failed
  | 'canceled';  // User canceled

/**
 * Full Plan instance (topology + state)
 */
export interface PlanInstance {
  /** Unique Plan ID (UUID) */
  id: string;
  
  /** The Plan specification */
  spec: PlanSpec;
  
  /** Map of node ID to node definition */
  nodes: Map<string, PlanNode>;
  
  /** Map of producerId to node ID (for resolving references) */
  producerIdToNodeId: Map<string, string>;
  
  /** Root node IDs (no dependencies) */
  roots: string[];
  
  /** Leaf node IDs (no dependents) */
  leaves: string[];
  
  /** Map of node ID to execution state */
  nodeStates: Map<string, NodeExecutionState>;
  
  /** Parent Plan ID (if this is a sub-plan) */
  parentPlanId?: string;
  
  /** Parent node ID (the subPlan node in parent) */
  parentNodeId?: string;
  
  /** Repository path */
  repoPath: string;
  
  /** Base branch */
  baseBranch: string;
  
  /** Target branch */
  targetBranch?: string;
  
  /** Worktree root directory */
  worktreeRoot: string;
  
  /** When the Plan was created */
  createdAt: number;
  
  /** When execution started */
  startedAt?: number;
  
  /** When execution ended */
  endedAt?: number;
  
  /** Whether cleanup is enabled */
  cleanUpSuccessfulWork: boolean;
  
  /** Max parallel jobs */
  maxParallel: number;
  
  /** Aggregated work summary */
  workSummary?: WorkSummary;
}

// ============================================================================
// WORK SUMMARY
// ============================================================================

/**
 * Summary of work done by a job
 */
export interface JobWorkSummary {
  nodeId: string;
  nodeName: string;
  commits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  description: string;
  commitDetails?: CommitDetail[];
}

/**
 * Detailed commit information
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
 * Aggregated work summary for a Plan
 */
export interface WorkSummary {
  totalCommits: number;
  totalFilesAdded: number;
  totalFilesModified: number;
  totalFilesDeleted: number;
  jobSummaries: JobWorkSummary[];
}

// ============================================================================
// EVENTS
// ============================================================================

/**
 * Event emitted when a node transitions state
 */
export interface NodeTransitionEvent {
  planId: string;
  nodeId: string;
  from: NodeStatus;
  to: NodeStatus;
  timestamp: number;
}

/**
 * Event emitted when a Plan completes
 */
export interface PlanCompletionEvent {
  planId: string;
  status: PlanStatus;
  timestamp: number;
}

// ============================================================================
// EXECUTOR TYPES
// ============================================================================

/**
 * Result from executing a job
 */
export interface JobExecutionResult {
  success: boolean;
  error?: string;
  completedCommit?: string;
  workSummary?: JobWorkSummary;
  /** Per-phase status for UI display */
  stepStatuses?: {
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
  };
  /** Copilot session ID captured during agent work (for session resumption) */
  copilotSessionId?: string;
  /** Which phase failed (for retry context) */
  failedPhase?: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri';
  /** Exit code from failed process */
  exitCode?: number;
}

/**
 * Context passed to executor
 */
export interface ExecutionContext {
  /** Plan instance */
  plan: PlanInstance;
  
  /** Node being executed */
  node: JobNode;
  
  /** Base commit SHA the worktree was created from */
  baseCommit: string;
  
  /** Worktree path (detached HEAD mode - no branch) */
  worktreePath: string;
  
  /** Callback to report progress */
  onProgress?: (step: string) => void;
  
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  
  /** Existing Copilot session ID to resume (from previous attempt) */
  copilotSessionId?: string;
}

// ============================================================================
// LOG TYPES
// ============================================================================

/**
 * Execution phase for logging
 */
export type ExecutionPhase = 'setup' | 'merge-fi' | 'prechecks' | 'work' | 'postchecks' | 'commit' | 'merge-ri' | 'cleanup';

/**
 * Log entry for job execution
 */
export interface LogEntry {
  timestamp: number;
  phase: ExecutionPhase;
  type: 'stdout' | 'stderr' | 'info' | 'error';
  message: string;
}
