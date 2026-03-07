/**
 * @fileoverview Release Types
 *
 * Defines types for release management, including release definitions,
 * PR monitoring, merge results, and progress tracking.
 *
 * @module plan/types/release
 */

import type { PreparationTask, ReleaseInstructions } from './releasePrep';

// ============================================================================
// RELEASE STATUS
// ============================================================================

/**
 * Release flow type.
 * 
 * - `from-branch`: Release from existing branch (with optional plan selection)
 * - `from-plans`: Release by merging multiple plans into new branch
 */
export type ReleaseFlowType = 'from-branch' | 'from-plans';

/**
 * Release lifecycle status.
 * 
 * - `drafting`: Release is being configured, plans are being added
 * - `preparing`: Running pre-PR preparation tasks
 * - `merging`: Merging plan commits into the release branch
 * - `creating-pr`: Creating pull request for the release
 * - `pr-active`: PR exists, not yet monitoring
 * - `monitoring`: Monitoring PR for CI checks, reviews, and feedback
 * - `addressing`: Addressing PR feedback and fixing issues
 * - `succeeded`: Release PR merged successfully
 * - `failed`: Release process failed
 * - `canceled`: Release was canceled by user
 */
export type ReleaseStatus = 
  | 'drafting' 
  | 'preparing'
  | 'ready-for-pr'
  | 'merging' 
  | 'creating-pr'
  | 'pr-active'
  | 'monitoring' 
  | 'addressing' 
  | 'succeeded' 
  | 'failed' 
  | 'canceled';

/**
 * A single state transition in the release lifecycle.
 */
export interface StateTransition {
  /** Previous status */
  from: ReleaseStatus;

  /** New status */
  to: ReleaseStatus;

  /** When the transition occurred */
  timestamp: number;

  /** Optional reason for the transition */
  reason?: string;
}

// ============================================================================
// PREPARATION TASKS
// ============================================================================

/** Severity level for a code review finding. */
export type ReviewFindingSeverity = 'error' | 'warning' | 'info' | 'suggestion';

/** Status of a review finding. */
export type ReviewFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'fixed';

/** A single code review finding from the AI reviewer. */
export interface ReviewFinding {
  /** Unique finding ID (auto-generated) */
  id: string;
  /** Severity level */
  severity: ReviewFindingSeverity;
  /** Short title/summary of the finding */
  title: string;
  /** Detailed explanation */
  description: string;
  /** File path (relative to repo root) */
  filePath?: string;
  /** Line number in the file */
  line?: number;
  /** End line for range */
  endLine?: number;
  /** Category (e.g., 'security', 'performance', 'style', 'bug', 'architecture') */
  category?: string;
  /** Current status */
  status: ReviewFindingStatus;
  /** Timestamp when finding was created */
  createdAt: number;
  /** User note when dismissing/acknowledging */
  note?: string;
}

/**
 * Status of a preparation task.
 */
export type PrepTaskStatus = 'pending' | 'running' | 'in-progress' | 'completed' | 'skipped' | 'failed';

/**
 * A preparation task in the pre-PR checklist.
 */
export interface PrepTask {
  /** Task ID */
  id: string;

  /** Task title */
  title: string;

  /** Task description */
  description?: string;

  /** Whether this task is required (blocks PR creation) */
  required: boolean;

  /** Whether this task can be automated by Copilot */
  autoSupported: boolean;

  /** Current status */
  status: PrepTaskStatus;

  /** Error message if task failed */
  error?: string;

  /** Commit hash if task made code changes */
  commitHash?: string;

  /** Timestamp when task execution started */
  startedAt?: number;

  /** Timestamp when task execution completed */
  completedAt?: number;

  /** Path to log file for task execution output */
  logFilePath?: string;

  /** Task result/output summary */
  result?: string;

  /** Code review findings (populated by AI review tasks) */
  findings?: ReviewFinding[];
}

// ============================================================================
// RELEASE DEFINITION
// ============================================================================

/**
 * Defines a release combining multiple plans.
 * 
 * A release creates an isolated repository clone, merges all plan commits
 * into a release branch, creates a PR, monitors it for feedback, and
 * autonomously addresses issues until the PR is merged.
 */
export interface ReleaseDefinition {
  /** Unique identifier for the release */
  id: string;

  /** Human-friendly name for the release */
  name: string;

  /** Release flow type */
  flowType: ReleaseFlowType;

  /** Internal flow type tracking (same as flowType) */
  source?: ReleaseFlowType;

  /** Plan IDs included in this release */
  planIds: string[];

  /** Branch name for the release (e.g., 'release/v1.2.0') */
  releaseBranch: string;

  /** Target branch for the PR (e.g., 'main') */
  targetBranch: string;

  /** Original repository path */
  repoPath: string;

  /** Current lifecycle status */
  status: ReleaseStatus;

  /** Preparation tasks checklist */
  prepTasks?: PrepTask[];

  /** PR number once created */
  prNumber?: number;

  /** PR URL once created */
  prUrl?: string;

  /**
   * Path to isolated repository clone.
   * Always under `<repoRoot>/.orchestrator/release/<sanitized-branch>/`.
   * Used for merge operations and PR monitoring.
   */
  isolatedRepoPath?: string;

  /** Timestamp when release was created */
  createdAt: number;

  /** Timestamp when release execution started */
  startedAt?: number;

  /** Timestamp when release completed (succeeded/failed/canceled) */
  endedAt?: number;

  /** Error message if release failed */
  error?: string;

  /** Preparation tasks to complete before creating PR */
  preparationTasks?: PreparationTask[];

  /** Release instructions file metadata */
  releaseInstructions?: ReleaseInstructions;

  /** Latest monitoring stats (updated after each cycle) */
  monitoringStats?: {
    checksPass: number;
    checksFail: number;
    checksPending: number;
    unresolvedComments: number;
    unresolvedAlerts: number;
    cycleCount: number;
    lastCycleAt?: number;
  };

  /** History of state transitions */
  stateHistory: StateTransition[];
}

// ============================================================================
// MERGE RESULTS
// ============================================================================

/**
 * Result of merging a single plan into the release branch.
 */
export interface ReleaseMergeResult {
  /** Plan ID that was merged */
  planId: string;

  /** Human-friendly plan name */
  planName: string;

  /** Source branch containing the plan's commits */
  sourceBranch: string;

  /** Whether the merge succeeded */
  success: boolean;

  /** Whether conflicts were auto-resolved during merge */
  conflictsResolved?: boolean;

  /** Error message if merge failed */
  error?: string;
}

// ============================================================================
// PR MONITORING
// ============================================================================

/**
 * Result of a CI/CD check on the PR.
 */
export interface PRCheckResult {
  /** Check name (e.g., 'build', 'test', 'lint') */
  name: string;

  /** Check status */
  status: 'passing' | 'failing' | 'pending';

  /** Optional URL to check details */
  url?: string;
}

/**
 * Source of a PR comment.
 */
export type PRCommentSource = 'human' | 'copilot' | 'codeql' | 'bot';

/**
 * A comment or review feedback on the PR.
 */
export interface PRCommentResult {
  /** Comment ID */
  id: string;

  /** Author username */
  author: string;

  /** Comment body text */
  body: string;

  /** File path if this is an inline code comment */
  path?: string;

  /** Line number if this is an inline code comment */
  line?: number;

  /** Whether this comment has been marked resolved */
  isResolved: boolean;

  /** Source of the comment */
  source: PRCommentSource;

  /** Thread ID for grouped review comments */
  threadId?: string;
}

/**
 * A security alert detected on the PR.
 */
export interface PRSecurityAlert {
  /** Alert ID */
  id: string;

  /** Severity level (e.g., 'critical', 'high', 'medium', 'low') */
  severity: string;

  /** Description of the security issue */
  description: string;

  /** File path where the issue was detected */
  file?: string;

  /** Whether the alert has been resolved */
  resolved: boolean;
}

/**
 * Type of action taken during PR monitoring.
 */
export type PRActionType = 
  | 'fix-code'           // Fixed code issue from feedback
  | 'respond-comment'    // Responded to a comment
  | 'resolve-conflict'   // Resolved merge conflict
  | 'fix-ci'             // Fixed CI/CD failure
  | 'resolve-alert';     // Resolved security alert

/**
 * An action taken to address PR feedback.
 */
export interface PRActionTaken {
  /** Type of action performed */
  type: PRActionType;

  /** Description of what was done */
  description: string;

  /** Whether the action succeeded */
  success: boolean;

  /** Commit hash if a code change was made */
  commitHash?: string;
}

/**
 * A single PR monitoring cycle.
 * 
 * The release manager periodically polls the PR for new checks, comments,
 * and alerts, then takes appropriate actions. Each cycle is recorded.
 */
export interface PRMonitorCycle {
  /** Cycle number (incrementing from 1) */
  cycleNumber: number;

  /** When this cycle ran */
  timestamp: number;

  /** CI/CD check results */
  checks: PRCheckResult[];

  /** Comments and review feedback */
  comments: PRCommentResult[];

  /** Security alerts detected */
  securityAlerts: PRSecurityAlert[];

  /** Actions taken during this cycle */
  actions: PRActionTaken[];
}

// ============================================================================
// RELEASE PROGRESS
// ============================================================================

/**
 * Merge progress during the merging phase.
 */
export interface MergeProgress {
  /** Number of plans merged so far */
  merged: number;

  /** Total number of plans to merge */
  total: number;

  /** Results for each plan merge */
  results: ReleaseMergeResult[];
}

/**
 * PR monitoring progress during the monitoring phase.
 */
export interface PRMonitoringProgress {
  /** Number of monitoring cycles completed */
  cyclesCompleted: number;

  /** Most recent cycle results */
  lastCycle?: PRMonitorCycle;

  /** Number of unresolved comments */
  unresolvedComments: number;

  /** Number of failing checks */
  failingChecks: number;

  /** Number of unresolved security alerts */
  unresolvedAlerts: number;
}

/**
 * Overall progress of a release.
 */
export interface ReleaseProgress {
  /** Current status */
  status: ReleaseStatus;

  /** Human-readable description of current step */
  currentStep: string;

  /** Merge progress if in merging phase */
  mergeProgress?: MergeProgress;

  /** PR monitoring progress if in monitoring/addressing phase */
  prMonitoring?: PRMonitoringProgress;
}
