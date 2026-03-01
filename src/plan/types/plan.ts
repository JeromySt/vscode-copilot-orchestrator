/**
 * @fileoverview Plan Types
 *
 * Defines the Plan specification, Plan instance, execution state,
 * work summaries, events, executor types, and log types.
 *
 * @module plan/types/plan
 */

import type { WorkSpec, CopilotUsageMetrics } from './specs';
import type { NodeStatus, JobNodeSpec, GroupSpec, PlanNode, PlanJob, JobNode } from './nodes';

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
  
  /** Whether to create the plan in a paused state (default: true for plans, false for single jobs) */
  startPaused?: boolean;
  
  /** Additional directories to symlink from the main repo into worktrees.
   *  Merged with the built-in list (node_modules). Must be .gitignored,
   *  read-only directories (e.g. '.venv', 'vendor', '.gradle'). */
  additionalSymlinkDirs?: string[];
  
  /**
   * Optional verification spec used as the work phase of the auto-injected
   * snapshot-validation node. Executes in the snapshot worktree after all
   * dependency commits are forward-integrated, validating the combined result
   * (e.g. compilation, tests) before the final merge to targetBranch.
   * Auto-healable: on failure, Copilot CLI attempts to fix the issue.
   */
  verifyRiSpec?: WorkSpec;
  
  /** 
   * Environment variables applied to all jobs in this plan.
   * Individual work specs can override specific keys.
   * Supports variable expansion: `$VAR`, `${VAR}` (Unix), `%VAR%` (Windows)
   * resolve against the host environment at execution time.
   * At execution time: { ...planEnv, ...workSpecEnv } → expand → { ...processEnv, ...expanded }
   */
  env?: Record<string, string>;
  
  /** Job nodes at the top level of this Plan */
  jobs: JobNodeSpec[];
  
  /**
   * Plan ID that must complete successfully before this plan auto-resumes.
   * When set, the plan is created paused and automatically resumed when the
   * dependency plan reaches 'succeeded' status.
   */
  resumeAfterPlan?: string;
  
  /** 
   * Visual groups for organizing jobs.
   * Groups provide namespace isolation for producerIds and visual hierarchy.
   */
  groups?: GroupSpec[];
}

// ============================================================================
// PLAN STATE (Execution State)
// ============================================================================

/**
 * Per-phase execution status
 */
export type PhaseStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

/**
 * A single state transition event, used at all levels (plan, job, attempt, phase).
 * The stateHistory array on each object is the canonical source of truth for timing.
 * `startedAt` and `endedAt` are derived: first 'running' transition and first terminal transition.
 */
export interface StateTransition {
  /** Previous status (empty string for initial state) */
  from: string;
  /** New status after transition */
  to: string;
  /** Epoch milliseconds when the transition occurred */
  timestamp: number;
  /** Optional reason for the transition */
  reason?: string;
}

/**
 * A single plan-level state change event.
 * @deprecated Use StateTransition instead. Kept for backward compat with existing plan data.
 */
export interface PlanStateChange {
  /** Plan status string */
  status: string;
  /** Epoch milliseconds timestamp */
  timestamp: number;
  /** Reason for state change */
  reason?: string; // 'user-paused', 'user-resumed', 'started', 'completed', 'canceled', 'startPaused', 'resumeAfterPlan', 'capacity-wait'
}

/**
 * A pause/resume interval.
 */
export interface PauseInterval {
  /** When the plan was paused (epoch ms) */
  pausedAt: number;
  /** When the plan was resumed (epoch ms), undefined if currently paused */
  resumedAt?: number;
  /** Reason for pause */
  reason?: string; // 'user', 'startPaused', 'resumeAfterPlan'
}

/**
 * Per-phase wall-clock timing within a node attempt.
 */
export interface PhaseTiming {
  /** Execution phase name */
  phase: string;
  /** When the phase started (epoch ms) */
  startedAt: number;
  /** When the phase ended (epoch ms), undefined if currently running */
  endedAt?: number;
}

/**
 * Execution state for a single node
 */
export interface NodeExecutionState {
  /** Current status */
  status: NodeStatus;
  
  /** Version number - incremented on every state change (for efficient UI updates) */
  version: number;
  
  /** When the node was scheduled */
  scheduledAt?: number;
  
  /** When execution started */
  startedAt?: number;
  
  /** When execution ended */
  endedAt?: number;
  
  /** Error message if failed */
  error?: string;
  
  /** Reason for failure - helps distinguish crash from other failures */
  failureReason?: 'crashed' | 'timeout' | 'execution-error' | 'user-canceled';
  
  /** Base commit SHA the worktree was created from */
  baseCommit?: string;
  
  /** Completed commit SHA (for jobs) - the final commit after work is done */
  completedCommit?: string;
  
  /** Worktree path (for jobs) - detached HEAD mode, no branch */
  worktreePath?: string;
  
  /** Execution attempt count */
  attempts: number;
  
  /** Log of status transitions for timeline rendering.
   * @deprecated Use stateHistory instead — kept for backward compat with pre-0.14 plan data. */
  transitionLog?: Array<{ from: string; to: string; timestamp: number }>;

  /**
   * Canonical state history for this node.
   * Every status transition is recorded here. Timestamps are derived:
   * - scheduledAt = first transition to 'scheduled'
   * - startedAt = first transition to 'running'
   * - endedAt = first transition to a terminal state (succeeded/failed/blocked/canceled)
   * On retry, a new 'pending'/'ready' transition is appended (not cleared).
   */
  stateHistory?: StateTransition[];
  
  /** Work summary (files changed, commits) - set on success */
  workSummary?: JobWorkSummary;
  
  /**
   * Aggregated work summary for leaf nodes.
   * Captures the total diff from baseBranch to completedCommit,
   * including all upstream dependency work accumulated through FI merges.
   * Only populated for leaf nodes after successful execution.
   * This represents the total work that will be merged to targetBranch.
   * 
   * Unlike `workSummary` (which shows baseCommit → completedCommit for this node only),
   * `aggregatedWorkSummary` shows baseBranch → completedCommit across the entire DAG path.
   * 
   * Example: For DAG A → B → C (leaf), if A adds 3 files and B adds 2 files:
   * - C's `workSummary`: 0 files (no changes made by C)
   * - C's `aggregatedWorkSummary`: 5 files (A's 3 + B's 2, merged through FI)
   */
  aggregatedWorkSummary?: JobWorkSummary;
  
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
   * Tracks all 7 phases: merge-fi, setup, prechecks, work, commit, postchecks, merge-ri.
   */
  stepStatuses?: {
    'merge-fi'?: PhaseStatus;
    setup?: PhaseStatus;
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
    'merge-ri'?: PhaseStatus;
    cleanup?: PhaseStatus;
  };
  
  /**
   * Copilot CLI session ID for session resumption.
   * Captured from CLI output during agent work execution.
   * Can be used to resume context on retry or follow-up.
   */
  copilotSessionId?: string;
  
  /** 
   * Process ID of the running agent/shell process.
   * Used for crash detection on extension restart.
   */
  pid?: number;
  
  /**
   * Flag indicating this node was manually force-failed by the user.
   * Used by UI to show different styling/messaging for user-initiated failures.
   */
  forceFailed?: boolean;

  /**
   * User-facing failure message set by a phase executor's onFailure config.
   * Displayed prominently in NodeDetailPanel. Indicates a non-auto-healable
   * failure that requires user action (e.g., "targetBranch has uncommitted changes").
   */
  forceFailMessage?: string;
  
  /**
   * Phase to resume from on retry.
   * Set when a node fails and is retried - allows skipping already-completed phases.
   * Cleared when new work is provided or worktree is reset.
   */
  resumeFromPhase?: 'merge-fi' | 'prechecks' | 'work' | 'postchecks' | 'commit' | 'merge-ri';

  /**
   * Tracks auto-heal attempts per phase.
   * Each value is the number of heal attempts for that phase.
   * Backwards-compatible: `true` is treated as 1 when reading.
   */
  autoHealAttempted?: Partial<Record<'prechecks' | 'work' | 'postchecks', boolean | number>>;
  
  /**
   * Details about the last execution attempt (for retry context).
   */
  lastAttempt?: {
    /** Which phase failed or was running */
    phase: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup' | 'cleanup';
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
  
  /**
   * Agent execution metrics (token usage, duration, turns, tool calls).
   * Captured from agent delegation results when available.
   */
  metrics?: CopilotUsageMetrics;

  /**
   * Per-phase AI usage metrics breakdown.
   * Keys are phase names for which metrics are available:
   * 'prechecks', 'work', 'commit', 'postchecks', 'merge-fi', 'merge-ri', 'setup'.
   */
  phaseMetrics?: Partial<Record<'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup' | 'cleanup', CopilotUsageMetrics>>;
}

/**
 * Record of a single execution attempt.
 */
export interface AttemptRecord {
  /** Attempt number (1-based) */
  attemptNumber: number;
  
  /** Status of this attempt */
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  
  /** What triggered this attempt */
  triggerType?: 'initial' | 'auto-heal' | 'retry' | 'postchecks-revalidation';
  
  /** When the attempt started */
  startedAt: number;
  
  /** When the attempt ended */
  endedAt: number;
  
  /** Which phase failed (if failed) */
  failedPhase?: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup' | 'cleanup';
  
  /** Error message (if failed) */
  error?: string;
  
  /** Exit code (if applicable) */
  exitCode?: number;
  
  /** Copilot session ID used in this attempt */
  copilotSessionId?: string;
  
  /** Per-phase status at end of attempt */
  stepStatuses?: {
    'merge-fi'?: PhaseStatus;
    setup?: PhaseStatus;
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
    'merge-ri'?: PhaseStatus;
    cleanup?: PhaseStatus;
  };
  
  /** Per-phase wall-clock timing within this attempt. */
  phaseTiming?: PhaseTiming[];
  
  /** Worktree path used in this attempt */
  worktreePath?: string;
  
  /** Base commit SHA this attempt started from */
  baseCommit?: string;
  
  /** Completed commit SHA from this attempt (if work succeeded) */
  completedCommit?: string;
  
  /** Logs captured during this attempt (deprecated — use logsRef) */
  logs?: string;
  
  /** Path to the log file for this attempt (separate file per attempt) */
  logFilePath?: string;

  /** Ref to execution log file: specs/<nodeId>/attempts/<n>/execution.log */
  logsRef?: string;
  
  /** Work spec used for this attempt (deprecated — use workRef) */
  workUsed?: WorkSpec;

  /** Ref to work spec file: specs/<nodeId>/attempts/<n>/work.json */
  workRef?: string;

  /** Ref to prechecks spec file: specs/<nodeId>/attempts/<n>/prechecks.json */
  prechecksRef?: string;

  /** Ref to postchecks spec file: specs/<nodeId>/attempts/<n>/postchecks.json */
  postchecksRef?: string;

  /** Ref to the attempt directory: specs/<nodeId>/attempts/<n>/ */
  attemptDir?: string;
  
  /** Execution metrics captured during this attempt */
  metrics?: CopilotUsageMetrics;

  /** Per-phase AI usage metrics breakdown */
  phaseMetrics?: Partial<Record<'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup' | 'cleanup', CopilotUsageMetrics>>;

  /**
   * Attempt-level state history.
   * Tracks transitions: scheduled → running → succeeded/failed.
   * Timestamps derived: startedAt = first → running, endedAt = first → terminal.
   */
  stateHistory?: StateTransition[];
}

// ============================================================================
// GROUP INSTANCE(Visual Hierarchy with State)
// ============================================================================

/**
 * Group instance (internal representation with UUID).
 * Groups are visual hierarchy containers for organizing jobs.
 * Jobs push their state changes to their parent group.
 */
export interface GroupInstance {
  /** Unique group ID (UUID) */
  id: string;
  
  /** Group name (from spec) */
  name: string;
  
  /** Full path (e.g., "tier1/processor") */
  path: string;
  
  /** Parent group ID (if nested) */
  parentGroupId?: string;
  
  /** Child group IDs */
  childGroupIds: string[];
  
  /** Node IDs directly contained in this group (not in subgroups) */
  nodeIds: string[];
  
  /** All node IDs in this group and all subgroups (computed at build time) */
  allNodeIds: string[];
  
  /** Total node count (for progress calculation) */
  totalNodes: number;
}

/**
 * Execution state for a group.
 * Updated via push from jobs - jobs notify the group when they transition.
 * Uses same status values as nodes for consistent rendering.
 */
export interface GroupExecutionState {
  /** 
   * Current status - uses NodeStatus for consistency.
   * Derived from counts: running > 0 → 'running', all succeeded → 'succeeded', etc.
   */
  status: import('./nodes').NodeStatus;
  
  /** Version number - incremented on every state change (for efficient UI updates) */
  version: number;
  
  /** When the first job in this group started (set by first job to start) */
  startedAt?: number;
  
  /** When the last job in this group ended (set when all jobs complete) */
  endedAt?: number;
  
  /** Count of currently running jobs (increment on start, decrement on finish) */
  runningCount: number;
  
  /** Count of succeeded jobs */
  succeededCount: number;
  
  /** Count of failed jobs */
  failedCount: number;
  
  /** Count of blocked jobs */
  blockedCount: number;
  
  /** Count of canceled jobs */
  canceledCount: number;
}

/**
 * Overall Plan status (derived from node states)
 */
export type PlanStatus = 
  | 'scaffolding'    // Plan being built (not ready for execution)
  | 'pending'        // Not started
  | 'pending-start'  // Created paused, awaiting user start (never ran)
  | 'running'        // At least one node running
  | 'pausing'        // User requested pause, running jobs still completing
  | 'paused'         // Fully paused — no jobs running, awaiting resume
  | 'resumed'        // Resume requested, transitioning back to running
  | 'succeeded'      // All nodes succeeded
  | 'failed'         // At least one node failed (not blocked)
  | 'partial'        // @deprecated — maps to 'failed' in computePlanStatus. Kept for backward compat serialization.
  | 'canceled';      // User canceled

/**
 * Valid plan-level state transitions.
 * Non-status events like 'reshaped', 'job-updated', 'plan-updated' are not validated
 * since they don't change the plan's status — they're informational stateHistory entries.
 */
export const VALID_PLAN_TRANSITIONS: Partial<Record<PlanStatus, readonly PlanStatus[]>> = {
  'scaffolding':    ['pending', 'pending-start', 'canceled'],
  'pending':        ['pending-start', 'running', 'canceled'],
  'pending-start':  ['running', 'canceled'],
  'running':        ['pausing', 'paused', 'succeeded', 'failed', 'canceled'],
  'pausing':        ['paused', 'running', 'canceled'],
  'paused':         ['running', 'resumed', 'canceled'],
  'resumed':        ['running', 'canceled'],
  'succeeded':      [],  // Terminal
  'failed':         ['running'],  // Can be retried
  'partial':        ['running'],  // Deprecated, same as failed
  'canceled':       [],  // Terminal
};

/**
 * Full Plan instance (topology + state)
 */
export interface PlanInstance {
  /** Unique Plan ID (UUID) */
  id: string;
  
  /** The Plan specification */
  spec: PlanSpec;
  
  /** Map of node ID to job definition */
  jobs: Map<string, PlanJob>;
  
  /** Map of producerId to node ID (for resolving references) */
  producerIdToNodeId: Map<string, string>;
  
  /** Root node IDs (no dependencies) */
  roots: string[];
  
  /** Leaf node IDs (no dependents) */
  leaves: string[];
  
  /** Map of node ID to execution state */
  nodeStates: Map<string, NodeExecutionState>;
  
  /** Map of group ID to group instance */
  groups: Map<string, GroupInstance>;
  
  /** Map of group ID to execution state (computed from nodes) */
  groupStates: Map<string, GroupExecutionState>;
  
  /** Map of group path to group ID (for resolving references) */
  groupPathToId: Map<string, string>;
  
  /** Parent Plan ID (if this is a sub-plan) */
  parentPlanId?: string;
  
  /** Parent node ID (the subPlan node in parent) */
  parentNodeId?: string;
  
  /** Repository path */
  repoPath: string;
  
  /** Base branch */
  baseBranch: string;
  
  /**
   * The resolved commit SHA of baseBranch at plan creation time.
   * 
   * This is captured once when the plan starts and never changes,
   * ensuring RI merge diffs are computed against the original starting
   * point even if the base branch moves forward during execution.
   */
  baseCommitAtStart?: string;
  
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
  
  /** Global state version - incremented on any node/group state change (for UI polling) */
  stateVersion: number;
  
  /** Whether cleanup is enabled */
  cleanUpSuccessfulWork: boolean;
  
  /** Max parallel jobs */
  maxParallel: number;
  
  /** Whether the plan is paused (no new work scheduled, worktrees preserved) */
  isPaused?: boolean;
  
  /** Historical log of plan-level state changes for timeline rendering.
   * Uses StateTransition shape: { from, to, timestamp, reason? }
   * Backward compat: old plans may have PlanStateChange shape { status, timestamp, reason? } */
  stateHistory?: StateTransition[];
  
  /** Historical log of pause/resume intervals for timeline rendering. */
  pauseHistory?: PauseInterval[];

  /**
   * Plan ID that must complete successfully before this plan auto-resumes.
   * When set, the plan stays paused until the dependency plan succeeds.
   */
  resumeAfterPlan?: string;

  /** Whether the target branch has been created and .gitignore committed */
  branchReady?: boolean;
  
  /** 
   * Environment variables applied to all jobs in this plan.
   * Individual work specs can override specific keys.
   * At execution time: { ...planEnv, ...workSpecEnv, ...processEnv }
   */
  env?: Record<string, string>;
  
  /** Snapshot branch info for accumulated RI merges (set after plan start) */
  snapshot?: {
    /** Snapshot branch name, e.g. `orchestrator/snapshot/<planId>` */
    branch: string;
    /** Absolute path to the snapshot worktree on disk */
    worktreePath: string;
    /** Commit SHA the snapshot was originally branched from */
    baseCommit: string;
  };

  /** Aggregated work summary */
  workSummary?: WorkSummary;
  
  /** Plan definition for lazy spec loading (set when loaded from repository) */
  definition?: import('../../interfaces/IPlanDefinition').IPlanDefinition;
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
    'merge-fi'?: PhaseStatus;
    setup?: PhaseStatus;
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
    'merge-ri'?: PhaseStatus;
    cleanup?: PhaseStatus;
  };
  /** Copilot session ID captured during agent work (for session resumption) */
  copilotSessionId?: string;
  /** Which phase failed (for retry context) */
  failedPhase?: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup' | 'cleanup';
  /** Exit code from failed process */
  exitCode?: number;
  /** Agent execution metrics (token usage, duration, turns, tool calls) */
  metrics?: CopilotUsageMetrics;
  /** Per-phase metrics breakdown */
  phaseMetrics?: Partial<Record<'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup' | 'cleanup', CopilotUsageMetrics>>;
  /** Process ID of the main running process (for crash detection) */
  pid?: number;

  /**
   * When true, auto-heal should NOT be attempted for this failure.
   * Set by phase executors or from WorkSpec.onFailure.noAutoHeal.
   */
  noAutoHeal?: boolean;

  /**
   * User-facing failure message (shown in NodeDetailPanel).
   * Set by phase executors or from WorkSpec.onFailure.message.
   */
  failureMessage?: string;

  /**
   * Override the phase to resume from on retry.
   * Set by phase executors or from WorkSpec.onFailure.resumeFromPhase.
   * Takes precedence over the default (resume from failedPhase).
   */
  overrideResumeFromPhase?: 'merge-fi' | 'prechecks' | 'work' | 'postchecks' | 'commit' | 'merge-ri';
  
  /** Per-phase timing information collected during this execution */
  phaseTiming?: PhaseTiming[];
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
  
  /** 1-based attempt number for this execution */
  attemptNumber: number;
  
  /** Callback to report progress */
  onProgress?: (step: string) => void;
  
  /** Callback to report per-phase status changes (e.g. 'running', 'success', 'failed') */
  onStepStatusChange?: (phase: string, status: PhaseStatus) => void;
  
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  
  /** Existing Copilot session ID to resume (from previous attempt) */
  copilotSessionId?: string;
  
  /** Phase to resume from on retry (skip phases before this) */
  resumeFromPhase?: 'merge-fi' | 'prechecks' | 'work' | 'postchecks' | 'commit' | 'merge-ri';
  
  /** Previous step statuses to preserve (from failed attempt) */
  previousStepStatuses?: {
    'merge-fi'?: PhaseStatus;
    setup?: PhaseStatus;
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
    'merge-ri'?: PhaseStatus;
    cleanup?: PhaseStatus;
  };
  
  // --- Merge phase specific fields ---
  /** Dependency commits for forward integration (merge-fi phase) */
  dependencyCommits?: Array<{ nodeId: string; nodeName: string; commit: string }>;
  /** Main repository path (not worktree) for reverse integration (merge-ri phase) */
  repoPath?: string;
  /** Target branch for reverse integration merge */
  targetBranch?: string;
  /** Base commit at the start of plan execution */
  baseCommitAtStart?: string;
  
  /** Snapshot branch for RI merges (leaf merges go here, not targetBranch) */
  snapshotBranch?: string;
  /** Snapshot worktree path (real worktree on disk for the snapshot branch) */
  snapshotWorktreePath?: string;
  
  /** Per-phase timing information collected during execution */
  phaseTiming?: PhaseTiming[];
}

// ============================================================================
// EVIDENCE TYPES
// ============================================================================

/**
 * Evidence file format for nodes that produce non-file-change work.
 * Agents or scripts drop this file to prove work was done.
 */
export interface EvidenceFile {
  /** Schema version for forward compatibility */
  version: 1;

  /** Node ID that produced this evidence */
  nodeId: string;

  /** ISO 8601 timestamp of evidence creation */
  timestamp: string;

  /** What the node did — required, shown in work summary */
  summary: string;

  /** Structured outcome data (node-type-specific) */
  outcome?: Record<string, unknown>;

  /**
   * Evidence type classification.
   * - "file_changes": Normal code changes (default, no evidence file needed)
   * - "external_effect": Work affected an external system
   * - "analysis": Work produced analysis/report but no code changes
   * - "validation": Work validated state without modifying it
   */
  type?: 'file_changes' | 'external_effect' | 'analysis' | 'validation';
}

/**
 * Result of evidence validation during the commit phase.
 */
export interface EvidenceValidationResult {
  /** Whether evidence validation passed */
  valid: boolean;

  /** Why validation passed or failed */
  reason: string;

  /** The evidence file contents, if one was found */
  evidence?: EvidenceFile;

  /** How the node satisfied evidence requirements */
  method?: 'file_changes' | 'evidence_file' | 'expects_no_changes' | 'ai_review' | 'none';

  /** AI review summary when method is 'ai_review' */
  aiReviewSummary?: string;
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

// ============================================================================
// GROUP TYPES (Node-Centric Model)
// ============================================================================

/**
 * Grouping replaces PlanInstance as the organizational unit.
 * Nodes sharing the same group.id are scheduled together
 * and share branch/merge semantics.
 */
export interface GroupInfo {
  /** Group ID (auto-generated UUID) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Base branch for all nodes in this group */
  baseBranch: string;

  /** Target branch to merge leaf nodes into */
  targetBranch?: string;

  /** Max parallel nodes in this group */
  maxParallel: number;

  /** Whether to clean up worktrees after merge */
  cleanUpSuccessfulWork: boolean;

  /** Worktree root directory */
  worktreeRoot: string;

  /** Parent group ID (for sub-groups replacing SubPlanNode) */
  parentGroupId?: string;

  /** Timestamps */
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/** Same values as current PlanStatus, now derived from grouped nodes */
export type GroupStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'partial' | 'canceled';

/**
 * Computed group status snapshot (not stored — derived on demand).
 */
export interface GroupStatusSnapshot {
  groupId: string;
  name: string;
  status: GroupStatus;
  progress: number;
  counts: Record<NodeStatus, number>;
  nodes: import('./nodes').NodeInstance[];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  workSummary?: WorkSummary;
}
