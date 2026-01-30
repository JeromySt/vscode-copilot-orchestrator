/**
 * @fileoverview Plan Types - Type definitions for plan execution.
 * 
 * Single responsibility: Define the data structures for plans, jobs, and state.
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
  /** Unique job ID within the plan */
  id: string;
  /** Pre-computed runner job ID (GUID) - assigned when plan is enqueued */
  runnerJobId?: string;
  /** Pre-computed nested plan ID (if this job creates a sub-plan) - assigned when plan is enqueued */
  nestedPlanId?: string;
  /** Human-readable name */
  name?: string;
  /** Task description */
  task?: string;
  /** IDs of work units (jobs or sub-plans) this job consumes from (producer→consumer). */
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
  id: string;
  name?: string;
  task: string;
  work?: string;
  /** IDs of jobs within the sub-plan this job consumes from (producer→consumer). */
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
  /** Unique sub-plan ID within the parent plan */
  id: string;
  /** Human-readable name */
  name?: string;
  /** IDs of work units (jobs or sub-plans) that must complete before this sub-plan starts. */
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
  /** Unique plan ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Repository path (defaults to workspace) */
  repoPath?: string;
  /** Worktree root for this plan (defaults to .worktrees/<planId>) */
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
  /** Sub-plans currently running (map of sub-plan ID -> child plan ID) */
  runningSubPlans?: Record<string, string>;
  /** Sub-plans that have completed */
  completedSubPlans?: string[];
  /** Sub-plans that have failed */
  failedSubPlans?: string[];
  
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
 */
export interface InternalPlanState extends Omit<PlanState, 'pendingSubPlans' | 'runningSubPlans' | 'completedSubPlans' | 'failedSubPlans' | 'mergedLeaves'> {
  /** Map of plan job ID -> actual JobRunner job ID (GUID) */
  jobIdMap: Map<string, string>;
  /** Map of plan job ID -> completed branch name */
  completedBranches: Map<string, string>;
  /** Map of plan job ID -> worktree path */
  worktreePaths: Map<string, string>;
  /** 
   * The targetBranchRoot for this plan.
   * - If baseBranch was a default branch, this is a new feature branch
   * - Otherwise, this equals baseBranch
   */
  targetBranchRoot?: string;
  /** Whether targetBranchRoot was created by the plan (vs using existing branch) */
  targetBranchRootCreated?: boolean;
  
  // Sub-plan tracking (using Sets/Maps internally)
  /** Sub-plans that haven't been triggered yet */
  pendingSubPlans: Set<string>;
  /** Sub-plans currently running (sub-plan ID -> child plan ID) */
  runningSubPlans: Map<string, string>;
  /** Sub-plans that have completed (sub-plan ID -> completed branch) */
  completedSubPlans: Map<string, string>;
  /** Sub-plans that have failed */
  failedSubPlans: Set<string>;
  /** Integration branches created for sub-plans (sub-plan ID -> branch name) */
  subPlanIntegrationBranches?: Map<string, string>;
  /** Work units (jobs/sub-plans) that have been merged to targetBranch */
  mergedLeaves: Set<string>;
  /** Work units whose worktrees/branches have been cleaned up */
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
    running: [],
    done: [],
    failed: [],
    canceled: [],
    submitted: [],
    jobIdMap: new Map(),
    completedBranches: new Map(),
    worktreePaths: new Map(),
    pendingSubPlans: new Set(),
    runningSubPlans: new Map(),
    completedSubPlans: new Map(),
    failedSubPlans: new Set(),
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
    completedSubPlans: internal.completedSubPlans.size > 0 ? Array.from(internal.completedSubPlans.keys()) : undefined,
    failedSubPlans: internal.failedSubPlans.size > 0 ? Array.from(internal.failedSubPlans) : undefined,
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
