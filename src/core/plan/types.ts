/**
 * @fileoverview Plan Types - Type definitions for plan execution.
 * 
 * Single responsibility: Define the data structures for plans, jobs, and state.
 * 
 * ID/ProducerId/Name Convention (SIMPLIFIED - no backward compatibility):
 * - `producerId`: REQUIRED - User-controlled reference used in consumesFrom for DAG dependencies
 *   Format: [a-z0-9-]{5,64} (lowercase letters, numbers, hyphens, 5-64 characters)
 * - `id`: UUID (GUID) - internal, auto-generated, used for worktree paths, branch naming
 * - `name`: Human-readable string - used for display and logging (defaults to producerId)
 * 
 * All state tracking (queued, running, done, etc.) is keyed by producerId.
 * 
 * @module core/plan/types
 */

// ============================================================================
// JOB TYPES
// ============================================================================

/**
 * A job within a plan, with dependency and branching information.
 */
export interface PlanJob {
  /** Unique job ID (UUID/GUID) - internal, auto-generated for worktree paths, branch naming */
  id: string;
  /** Human-readable job name - used for display and logging (defaults to producerId) */
  name: string;
  /** User-controlled reference ID - used in consumesFrom arrays for DAG dependencies. Required for new plans, derived for legacy. */
  producerId?: string;
  /** Pre-computed nested plan ID (if this job creates a sub-plan) - assigned when plan is enqueued */
  nestedPlanId?: string;
  /** Task description */
  task?: string;
  /** Producer IDs of work units (jobs or sub-plans) this job consumes from (producer→consumer). */
  consumesFrom: string[];
  /** Nested plan specification (if this job is a sub-plan) */
  plan?: Omit<PlanSpec, 'id' | 'repoPath' | 'worktreeRoot'>;
  /** Job inputs */
  inputs: {
    /** Base branch - auto-computed from parent jobs when dependencies exist */
    baseBranch: string;
    /** Target branch for this job (auto-generated if empty) */
    targetBranch: string;
    /** Additional instructions */
    instructions?: string;
  };
  /** Execution policy */
  policy?: {
    useJust?: boolean;
    steps?: {
      prechecks?: string;
      work?: string;
      postchecks?: string;
    };
  };
}

/**
 * Job definition within a sub-plan.
 */
export interface SubPlanJob {
  /** Unique job ID (UUID/GUID) - internal, auto-generated */
  id: string;
  /** Human-readable job name - used for display (defaults to producerId) */
  name: string;
  /** User-controlled reference ID - used in consumesFrom arrays within the sub-plan. Required for new plans, derived for legacy. */
  producerId?: string;
  task: string;
  work?: string;
  /** Producer IDs of jobs within the sub-plan this job consumes from (producer→consumer). */
  consumesFrom: string[];
  prechecks?: string;
  postchecks?: string;
  instructions?: string;
}

// ============================================================================
// SUB-PLAN TYPES
// ============================================================================

/**
 * A sub-plan that runs as part of a parent plan.
 * Sub-plans trigger after their consumesFrom work units complete.
 * Downstream work units that list this sub-plan in their consumesFrom
 * will wait for it and receive its completed branch.
 * 
 * Sub-plans can themselves have sub-plans, enabling arbitrary nesting.
 */
export interface SubPlanSpec {
  /** Unique sub-plan ID (UUID/GUID) - internal, auto-generated for worktree paths, branch naming */
  id: string;
  /** Human-readable sub-plan name - used for display and logging (defaults to producerId) */
  name: string;
  /** User-controlled reference ID - used in consumesFrom arrays for DAG dependencies. Required for new plans, derived for legacy. */
  producerId?: string;
  /** Producer IDs of work units (jobs or sub-plans) that must complete before this sub-plan starts. */
  consumesFrom: string[];
  /** Maximum parallel jobs in the sub-plan */
  maxParallel?: number;
  /** Jobs within this sub-plan */
  jobs: SubPlanJob[];
  /** Nested sub-plans within this sub-plan (recursive) */
  subPlans?: SubPlanSpec[];
}

// ============================================================================
// PLAN SPEC
// ============================================================================

/**
 * Plan specification defining the execution DAG.
 */
export interface PlanSpec {
  /** Unique plan ID (UUID/GUID) - used for worktree paths, branch naming, state indexing */
  id: string;
  /** Human-readable plan name - used for display and logging */
  name: string;
  /** Repository path (defaults to workspace) */
  repoPath?: string;
  /** Worktree root for this plan (defaults to .worktrees/<id>) */
  worktreeRoot?: string;
  /** Base branch the plan starts from */
  baseBranch?: string;
  /** Target branch to merge final results (defaults to baseBranch) */
  targetBranch?: string;
  /** Maximum parallel jobs (0 = auto based on CPU) */
  maxParallel?: number;
  /** Jobs in this plan */
  jobs: PlanJob[];
  /** Sub-plans that trigger after certain jobs complete */
  subPlans?: SubPlanSpec[];
  /** Whether this plan is a sub-plan (launched by a parent plan) */
  isSubPlan?: boolean;
  /** Parent plan ID if this is a sub-plan */
  parentPlanId?: string;
  /** 
   * Whether to clean up worktrees/branches for successfully merged work units.
   * When true (default), worktrees and branches are deleted after a leaf merges to targetBranch.
   * This keeps local git state minimal during plan execution.
   * When false, cleanup only happens when the plan is deleted.
   */
  cleanUpSuccessfulWork?: boolean;
}

// ============================================================================
// PLAN STATE
// ============================================================================

/** Job summary with commit details */
export interface JobSummary {
  jobId: string;
  jobName: string;
  commits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  description: string;
  /** Detailed commit information */
  commitDetails?: CommitDetail[];
}

/** Detailed commit information */
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

/** Aggregated work summary across all completed jobs */
export interface AggregatedWorkSummary {
  totalCommits: number;
  totalFilesAdded: number;
  totalFilesModified: number;
  totalFilesDeleted: number;
  jobSummaries: JobSummary[];
}

/**
 * Runtime state of a plan (public/external view).
 */
export interface PlanState {
  /** Plan ID */
  id: string;
  /** Current status */
  status: PlanStatus;
  /** Jobs waiting to be scheduled */
  queued: string[];
  /** Jobs whose worktrees are being created (async) */
  preparing: string[];
  /** Currently running jobs */
  running: string[];
  /** Successfully completed jobs */
  done: string[];
  /** Failed jobs */
  failed: string[];
  /** Canceled jobs */
  canceled: string[];
  /** Jobs that have been submitted to the runner */
  submitted: string[];
  /** Plan start time */
  startedAt?: number;
  /** Plan end time */
  endedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Whether the final RI merge to targetBranch completed successfully */
  riMergeCompleted?: boolean;
  /** Work units that have been merged to targetBranch (incremental delivery) */
  mergedLeaves?: string[];
  
  // Sub-plan status (optional, only present if plan has sub-plans)
  /** Sub-plans that have not yet been triggered */
  pendingSubPlans?: string[];
  /** Sub-plans currently running (map of sub-plan producerId -> child plan ID) */
  runningSubPlans?: Record<string, string>;
  /** Sub-plans that have completed (map of sub-plan producerId -> child plan ID) */
  completedSubPlans?: Record<string, string>;
  /** Sub-plans that have failed (map of sub-plan producerId -> child plan ID, empty string if never launched) */
  failedSubPlans?: Record<string, string>;
  
  /** Aggregated work summary across all completed jobs in the plan */
  aggregatedWorkSummary?: AggregatedWorkSummary;
}

/** Plan status values */
export type PlanStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'partial';

// ============================================================================
// INTERNAL STATE
// ============================================================================

/**
 * Internal plan state with Maps for efficient tracking.
 * This extends PlanState but uses Maps instead of arrays/records for performance.
 * 
 * All Maps are keyed by job/sub-plan NAME (the user-friendly identifier used in consumesFrom),
 * NOT by UUID. This allows the DAG logic to work with the names users specify.
 */
export interface InternalPlanState extends Omit<PlanState, 'pendingSubPlans' | 'runningSubPlans' | 'completedSubPlans' | 'failedSubPlans' | 'mergedLeaves'> {
  /** Map of job name -> job UUID (for looking up the actual job ID) */
  jobIdMap: Map<string, string>;
  /** Map of job name -> completed commit SHA (final HEAD after work) */
  completedCommits: Map<string, string>;
  /** Map of job name -> base commit SHA (starting point when worktree was created) */
  baseCommits: Map<string, string>;
  /** Map of job name -> worktree path */
  worktreePaths: Map<string, string>;
  /** Map of job name -> worktree creation promise (for async preparation) - NOT USED FOR CHECKING */
  worktreePromises: Map<string, Promise<boolean>>;
  /** Map of job name -> worktree creation result (set when promise completes) - USED FOR NON-BLOCKING CHECK */
  worktreeResults: Map<string, { success: boolean; error?: string }>;
  /** 
   * The targetBranchRoot for this plan.
   * - If baseBranch was a default branch, this is a new feature branch
   * - Otherwise, this equals baseBranch
   */
  targetBranchRoot?: string;
  /** Whether targetBranchRoot was created by the plan (vs using existing branch) */
  targetBranchRootCreated?: boolean;
  
  // Sub-plan tracking (using Sets/Maps internally, keyed by sub-plan NAME)
  /** Sub-plan names that haven't been triggered yet */
  pendingSubPlans: Set<string>;
  /** Sub-plan names currently running (sub-plan name -> child plan ID) */
  runningSubPlans: Map<string, string>;
  /** Sub-plan names that have completed (sub-plan name -> child plan ID) */
  completedSubPlans: Map<string, string>;
  /** Sub-plan names that have failed (sub-plan name -> child plan ID) */
  failedSubPlans: Map<string, string>;
  /** Work unit names (jobs/sub-plans) that have been merged to targetBranch */
  mergedLeaves: Set<string>;
  /** Work unit names whose worktrees have been cleaned up */
  cleanedWorkUnits: Set<string>;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create a fresh internal plan state.
 */
export function createInternalState(id: string): InternalPlanState {
  return {
    id,
    status: 'queued',
    queued: [],
    preparing: [],
    running: [],
    done: [],
    failed: [],
    canceled: [],
    submitted: [],
    jobIdMap: new Map(),
    completedCommits: new Map(),
    baseCommits: new Map(),
    worktreePaths: new Map(),
    worktreePromises: new Map(),
    worktreeResults: new Map(),
    pendingSubPlans: new Set(),
    runningSubPlans: new Map(),
    completedSubPlans: new Map(),
    failedSubPlans: new Map(),
    mergedLeaves: new Set(),
    cleanedWorkUnits: new Set(),
  };
}

/**
 * Convert internal state to public state (hide Maps, convert to arrays/records).
 */
export function toPublicState(internal: InternalPlanState): PlanState {
  return {
    id: internal.id,
    status: internal.status,
    queued: [...internal.queued],
    preparing: [...internal.preparing],
    running: [...internal.running],
    done: [...internal.done],
    failed: [...internal.failed],
    canceled: [...internal.canceled],
    submitted: [...internal.submitted],
    startedAt: internal.startedAt,
    endedAt: internal.endedAt,
    error: internal.error,
    riMergeCompleted: internal.riMergeCompleted,
    mergedLeaves: internal.mergedLeaves.size > 0 ? Array.from(internal.mergedLeaves) : undefined,
    pendingSubPlans: internal.pendingSubPlans.size > 0 ? Array.from(internal.pendingSubPlans) : undefined,
    runningSubPlans: internal.runningSubPlans.size > 0 ? Object.fromEntries(internal.runningSubPlans) : undefined,
    completedSubPlans: internal.completedSubPlans.size > 0 ? Object.fromEntries(internal.completedSubPlans) : undefined,
    failedSubPlans: internal.failedSubPlans.size > 0 ? Object.fromEntries(internal.failedSubPlans) : undefined,
    aggregatedWorkSummary: internal.aggregatedWorkSummary,
  };
}

/**
 * Check if a plan status indicates completion.
 */
export function isCompletedStatus(status: PlanStatus): boolean {
  return ['succeeded', 'failed', 'canceled', 'partial'].includes(status);
}

/**
 * Check if a plan is actively running.
 */
export function isActiveStatus(status: PlanStatus): boolean {
  return status === 'queued' || status === 'running';
}
