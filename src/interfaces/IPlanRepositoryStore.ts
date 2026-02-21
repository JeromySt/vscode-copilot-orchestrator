/**
 * @fileoverview Storage backend interface for plan repository.
 * 
 * Defines the low-level storage operations for plan metadata and node specifications.
 * The store abstracts file system operations and handles the physical persistence layer.
 * 
 * @module interfaces/IPlanRepositoryStore
 */

import type { NodeExecutionState, GroupInstance, GroupExecutionState, WorkSummary } from '../plan/types/plan';
import type { WorkSpec } from '../plan/types/specs';

/**
 * Plan metadata stored in plan.json (no inline agent instructions).
 * Contains all fields from SerializedPlan except work specs are referenced by file.
 */
export interface StoredPlanMetadata {
  /** Unique plan identifier */
  id: string;
  
  /** Plan specification without inline work instructions */
  spec: any;
  
  /** Job metadata array */
  jobs: StoredJobMetadata[];
  
  /** Map producer ID to node ID */
  producerIdToNodeId: Record<string, string>;
  
  /** Root node IDs */
  roots: string[];
  
  /** Leaf node IDs */
  leaves: string[];
  
  /** Node execution states by node ID */
  nodeStates: Record<string, NodeExecutionState>;
  
  /** Group instances by group ID */
  groups?: Record<string, GroupInstance>;
  
  /** Group execution states by group ID */
  groupStates?: Record<string, GroupExecutionState>;
  
  /** Map group path to group ID */
  groupPathToId?: Record<string, string>;
  
  /** Parent plan ID if this is a subplan */
  parentPlanId?: string;
  
  /** Parent node ID if this is a subplan */
  parentNodeId?: string;
  
  /** Repository path */
  repoPath: string;
  
  /** Base branch name */
  baseBranch: string;
  
  /** Base commit SHA at plan start */
  baseCommitAtStart?: string;
  
  /** Target branch name */
  targetBranch?: string;
  
  /** Worktree root path */
  worktreeRoot: string;
  
  /** Plan creation timestamp */
  createdAt: number;
  
  /** Plan start timestamp */
  startedAt?: number;
  
  /** Plan end timestamp */
  endedAt?: number;
  
  /** State version for migration */
  stateVersion?: number;
  
  /** Whether to clean up successful work */
  cleanUpSuccessfulWork: boolean;
  
  /** Maximum parallel nodes */
  maxParallel: number;
  
  /** Work summary */
  workSummary?: WorkSummary;
  
  /** Whether plan is paused */
  isPaused?: boolean;
  
  /** Environment variables applied to all jobs */
  env?: Record<string, string>;
  
  /** Whether target branch is ready */
  branchReady?: boolean;

  /** Plan ID that must succeed before this plan auto-resumes */
  resumeAfterPlan?: string;
  
  /** Snapshot information */
  snapshot?: {
    branch: string;
    worktreePath: string;
    baseCommit: string;
  };

  /** Tombstone: set to true before physical deletion. Guards against zombie plans. */
  deleted?: boolean;
}

/**
 * Per-job metadata with boolean flags for spec availability.
 * All specs are stored as files under specs/<nodeId>/attempts/<n>/.
 * No inline spec storage — plan.json is pure state.
 */
export interface StoredJobMetadata {
  /** Node unique identifier */
  id: string;
  
  /** Producer identifier */
  producerId: string;
  
  /** Human-readable node name */
  name: string;
  
  /** Brief task description */
  task?: string;
  
  /** Node dependencies (producer IDs, resolved to UUIDs at finalize) */
  dependencies: string[];
  
  /** Group path if part of a group */
  group?: string;
  
  /** Whether this node has work specifications */
  hasWork: boolean;
  /** Relative path to work spec file (e.g., "specs/<nodeId>/current/work.json") */
  workRef?: string;
  
  /** Whether this node has prechecks specifications */
  hasPrechecks: boolean;
  /** Relative path to prechecks spec file */
  prechecksRef?: string;
  
  /** Whether this node has postchecks specifications */
  hasPostchecks: boolean;
  /** Relative path to postchecks spec file */
  postchecksRef?: string;

  /** Controls auto-heal behavior (false = disabled) */
  autoHeal?: boolean;

  /** When true, node is expected to produce no file changes */
  expectsNoChanges?: boolean;

  /** Override base branch (only for root nodes) */
  baseBranch?: string;

  /** Pre-assigned worktree path (e.g., SV node reuses snapshot worktree) */
  assignedWorktreePath?: string;
}

/**
 * Storage backend interface for plan persistence.
 * Handles the physical storage and retrieval of plan data.
 */
export interface IPlanRepositoryStore {
  /**
   * Read plan metadata from storage.
   * @param planId Plan unique identifier
   * @returns Plan metadata or undefined if not found
   */
  readPlanMetadata(planId: string): Promise<StoredPlanMetadata | undefined>;
  
  /**
   * Read plan metadata synchronously (for sync save path).
   * @param planId Plan unique identifier
   * @returns Plan metadata or undefined if not found
   */
  readPlanMetadataSync?(planId: string): StoredPlanMetadata | undefined;
  
  /**
   * Write plan metadata to storage.
   * @param metadata Plan metadata to write
   */
  writePlanMetadata(metadata: StoredPlanMetadata): Promise<void>;
  
  /**
   * Write plan metadata to storage synchronously.
   * @param metadata Plan metadata to write
   */
  writePlanMetadataSync(metadata: StoredPlanMetadata): void;
  
  /**
   * Read node specification from storage.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID (unique across all groups)
   * @param phase Specification phase ('work', 'prechecks', 'postchecks')
   * @returns Node specification or undefined if not found
   */
  readNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks'): Promise<WorkSpec | undefined>;
  
  /**
   * Write node specification to storage.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID (unique across all groups)
   * @param phase Specification phase
   * @param spec Specification to write
   */
  writeNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', spec: WorkSpec): Promise<void>;
  
  /**
   * Move external file to node specification storage.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID (unique across all groups)
   * @param phase Specification phase
   * @param sourcePath Source file path
   */
  moveFileToSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', sourcePath: string): Promise<void>;
  
  /**
   * Check if node specification exists in storage.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID (unique across all groups)
   * @param phase Specification phase
   * @returns True if specification exists
   */
  hasNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks'): Promise<boolean>;
  
  /**
   * Snapshot current specs for a new attempt.
   * Creates attempts/<attemptNumber>/ directory, copies current specs there,
   * and re-points the current symlink/junction to the new attempt directory.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID
   * @param attemptNumber Attempt number (1-based)
   */
  snapshotSpecsForAttempt(planId: string, nodeId: string, attemptNumber: number): Promise<void>;

  /**
   * Read a node spec from a specific attempt's snapshot.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID
   * @param phase Specification phase
   * @param attemptNumber Attempt number (1-based)
   * @returns Node specification or undefined if not found
   */
  readNodeSpecForAttempt(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', attemptNumber: number): Promise<WorkSpec | undefined>;

  /**
   * List all plan identifiers in storage.
   * @returns Array of plan IDs
   */
  listPlanIds(): Promise<string[]>;
  
  /**
   * Delete plan and all associated data.
   * @param planId Plan unique identifier
   */
  deletePlan(planId: string): Promise<void>;
  
  /**
   * Check if storage exists for the given plan.
   * @param planId Plan unique identifier
   * @returns True if plan exists in storage
   */
  exists(planId: string): Promise<boolean>;
  
  /**
   * Migrate legacy plan format to new format.
   * @param planId Plan unique identifier
   */
  migrateLegacy(planId: string): Promise<void>;
}