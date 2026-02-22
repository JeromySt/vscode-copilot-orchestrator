/**
 * @fileoverview Plan lifecycle management interface.
 * 
 * Provides high-level plan operations including creation, modification,
 * persistence, and querying. Acts as the main entry point for plan
 * management operations.
 * 
 * @module interfaces/IPlanRepository
 */

import type { PlanInstance, PlanStatus } from '../plan/types/plan';
import type { WorkSpec } from '../plan/types/specs';
import type { IPlanDefinition } from './IPlanDefinition';

/**
 * Lightweight plan summary for listing and filtering.
 * Contains essential information without loading full plan details.
 */
export interface PlanSummary {
  /** Plan unique identifier */
  id: string;
  
  /** Plan display name */
  name: string;
  
  /** Current plan status */
  status: PlanStatus;
  
  /** Number of nodes in the plan */
  nodeCount: number;
  
  /** Plan creation timestamp */
  createdAt: number;
  
  /** Plan start timestamp */
  startedAt?: number;
  
  /** Plan end timestamp */
  endedAt?: number;
}

/**
 * Options for plan scaffolding.
 */
export interface ScaffoldOptions {
  /** Base branch name */
  baseBranch: string;
  
  /** Target branch name */
  targetBranch?: string;
  
  /** Maximum parallel nodes */
  maxParallel?: number;
  
  /** Repository path */
  repoPath: string;
  
  /** Worktree root path */
  worktreeRoot: string;
  
  /** Parent plan ID if this is a subplan */
  parentPlanId?: string;
  
  /** Parent node ID if this is a subplan */
  parentNodeId?: string;
  
  /** Environment variables applied to all jobs */
  env?: Record<string, string>;

  /** Plan ID that must succeed before this plan auto-resumes */
  resumeAfterPlan?: string;
}

/**
 * Node specification with optional file-backed instructions.
 */
export interface NodeSpec {
  /** Producer identifier */
  producerId: string;
  
  /** Human-readable node name */
  name: string;
  
  /** Brief task description */
  task?: string;
  
  /** Node dependencies (producer IDs) */
  dependencies?: string[];
  
  /** Group path if part of a group */
  group?: string;
  
  /** Work specification */
  work?: WorkSpec;
  
  /** Work specification with optional file reference */
  workWithFile?: WorkSpec & {
    /** Workspace-relative path to instructions file */
    instructionsFile?: string;
  };

  /** Prechecks specification */
  prechecks?: WorkSpec;

  /** Postchecks specification */
  postchecks?: WorkSpec;

  /** Enable automatic AI-assisted retry on failure */
  autoHeal?: boolean;

  /** When true, this node is expected to produce no file changes */
  expectsNoChanges?: boolean;
}

/**
 * Options for importing legacy plan specifications.
 */
export interface ImportOptions extends ScaffoldOptions {
  /** Whether to preserve original plan ID */
  preserveId?: boolean;
  
  /** Whether to validate imported data */
  validate?: boolean;
}

/**
 * Plan lifecycle management interface.
 * Provides operations for creating, modifying, and querying plans.
 */
export interface IPlanRepository {
  /**
   * Create a new plan scaffold in 'scaffolding' status.
   * @param name Plan display name
   * @param options Scaffold configuration options
   * @returns PlanInstance for runner registration
   */
  scaffold(name: string, options: ScaffoldOptions): Promise<import('../plan/types').PlanInstance>;
  
  /**
   * Add a node to a scaffolding plan and rebuild the plan topology.
   * Calls buildPlan() internally so the returned PlanInstance includes
   * dependency resolution, SV node injection, and group assignment.
   * @param planId Plan unique identifier
   * @param nodeSpec Node specification to add
   * @returns Rebuilt PlanInstance with the new node
   */
  addNode(planId: string, nodeSpec: NodeSpec): Promise<PlanInstance>;
  
  /**
   * Remove a node from a scaffolding plan by producerId and rebuild.
   * @param planId Plan unique identifier
   * @param producerId Producer identifier of the node to remove
   * @returns Rebuilt PlanInstance without the removed node
   */
  removeNode(planId: string, producerId: string): Promise<PlanInstance>;
  
  /**
   * Update an existing node's spec in a scaffolding plan and rebuild.
   * @param planId Plan unique identifier
   * @param producerId Producer identifier of the node to update
   * @param updates Partial node spec with fields to update
   * @returns Rebuilt PlanInstance with the updated node
   */
  updateNode(planId: string, producerId: string, updates: Partial<NodeSpec>): Promise<PlanInstance>;
  
  /**
   * Finalize a scaffolding plan and make it ready for execution.
   * @param planId Plan unique identifier
   * @returns Finalized plan instance
   */
  finalize(planId: string): Promise<PlanInstance>;
  
  /**
   * Get read-only plan definition.
   * @param planId Plan unique identifier
   * @returns Plan definition or undefined if not found
   */
  getDefinition(planId: string): Promise<IPlanDefinition | undefined>;
  
  /**
   * Load plan state into memory for execution.
   * @param planId Plan unique identifier
   * @returns Plan instance or undefined if not found
   */
  loadState(planId: string): Promise<PlanInstance | undefined>;
  
  /**
   * Save plan state to persistent storage.
   * @param plan Plan instance to save
   */
  saveState(plan: PlanInstance): Promise<void>;
  
  /**
   * Save plan state to persistent storage synchronously.
   * @param plan Plan instance to save
   */
  saveStateSync(plan: PlanInstance): void;
  
  /**
   * List all plans with summary information.
   * @returns Array of plan summaries
   */
  list(): Promise<PlanSummary[]>;
  
  /**
   * Delete a plan and all associated data.
   * @param planId Plan unique identifier
   */
  delete(planId: string): Promise<void>;

  /**
   * Synchronously write a deletion tombstone (deleted: true) into plan.json.
   * Called before the async physical cleanup to guarantee that even if the
   * extension reloads before cleanup finishes, the plan won't be rehydrated.
   * @param planId Plan unique identifier
   */
  markDeletedSync(planId: string): void;
  
  /**
   * Import a legacy plan specification.
  /**
   * Write a node specification to storage.
   * @param planId Plan unique identifier
   * @param producerId Node producer identifier
   * @param phase Specification phase ('work', 'prechecks', 'postchecks')
   * @param spec Specification to write
   */
  writeNodeSpec(planId: string, nodeId: string, phase: 'work' | 'prechecks' | 'postchecks', spec: WorkSpec): Promise<void>;
  
  /**
   * Snapshot current specs for a new attempt. Creates per-attempt spec directory
   * and re-points the current symlink. Preserves spec history across retries.
   * @param planId Plan unique identifier
   * @param nodeId Node UUID
   * @param attemptNumber Attempt number (1-based)
   */
  snapshotSpecsForAttempt(planId: string, nodeId: string, attemptNumber: number): Promise<void>;

  /**
   * Migrate legacy plan format to new format.
   * @param planId Plan unique identifier
   */
  migrateLegacy(planId: string): Promise<void>;
}