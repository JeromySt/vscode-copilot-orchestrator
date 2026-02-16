/**
 * @fileoverview Node Types
 *
 * Defines node status, node specifications (user input), and internal node
 * representations used in the Plan DAG.
 *
 * @module plan/types/nodes
 */

import type { WorkSpec } from './specs';
import type { PlanSpec, PhaseStatus, JobWorkSummary, AttemptRecord, GroupInfo } from './plan';

// ============================================================================
// NODE STATUS
// ============================================================================

/**
 * Valid node status values.
 * Terminal states: succeeded, failed, blocked, canceled
 */
export type NodeStatus =
  | 'pending'     // Waiting for dependencies
  | 'ready'       // Dependencies met, can be scheduled
  | 'scheduled'   // Handed to executor
  | 'running'     // Currently executing
  | 'succeeded'   // Completed successfully
  | 'failed'      // Execution failed
  | 'blocked'     // Dependency failed, can never run
  | 'canceled';   // User canceled

/**
 * Terminal states - nodes in these states will never change
 */
export const TERMINAL_STATES: readonly NodeStatus[] = ['succeeded', 'failed', 'blocked', 'canceled'];

/**
 * Valid state transitions
 */
export const VALID_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  'pending':   ['ready', 'blocked', 'canceled'],
  'ready':     ['scheduled', 'blocked', 'canceled'],
  'scheduled': ['running', 'failed', 'canceled'],
  'running':   ['succeeded', 'failed', 'canceled'],
  'succeeded': [],  // Terminal
  'failed':    [],  // Terminal
  'blocked':   [],  // Terminal
  'canceled':  [],  // Terminal
};

/**
 * Check if a node status is terminal (no further transitions possible).
 *
 * @param status - The status to check.
 * @returns `true` if the status is one of succeeded, failed, blocked, or canceled.
 */
export function isTerminal(status: NodeStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Check if a state transition is allowed by the transition table.
 *
 * @param from - Current status.
 * @param to   - Desired target status.
 * @returns `true` if `to` is in the allowed transitions for `from`.
 */
export function isValidTransition(from: NodeStatus, to: NodeStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ============================================================================
// NODE SPECIFICATION (User Input)
// ============================================================================

/**
 * Specification for a job node (user input).
 * Jobs execute processes, shell commands, or delegate to AI agents.
 */
export interface JobNodeSpec {
  /** User-controlled identifier for Plan references (used in consumesFrom) */
  producerId: string;
  
  /** Human-friendly display name (defaults to producerId) */
  name?: string;
  
  /** Task description */
  task: string;
  
  /** 
   * Work to perform. Can be:
   * - string: Shell command or "@agent <instructions>"
   * - ProcessSpec: Direct process spawn with args array
   * - ShellSpec: Shell command with explicit shell choice
   * - AgentSpec: AI agent delegation with rich config
   */
  work?: WorkSpec;
  
  /** 
   * Validation before work. Can be:
   * - string: Shell command
   * - ProcessSpec: Direct process spawn
   * - ShellSpec: Shell command with explicit shell
   */
  prechecks?: WorkSpec;
  
  /** 
   * Validation after work. Can be:
   * - string: Shell command
   * - ProcessSpec: Direct process spawn
   * - ShellSpec: Shell command with explicit shell
   */
  postchecks?: WorkSpec;
  
  /** 
   * Additional instructions for agent tasks.
   * @deprecated Use AgentSpec.instructions instead.
   * **Must be in Markdown format** if provided.
   */
  instructions?: string;
  
  /** IDs of nodes this job depends on (consumesFrom) */
  dependencies: string[];
  
  /** Override base branch (only for root nodes) */
  baseBranch?: string;

  /**
   * When true, this node is expected to produce no file changes.
   * The commit phase will succeed without a commit instead of failing.
   * Use for validation-only nodes, external-system updates, or analysis tasks.
   */
  expectsNoChanges?: boolean;

  /**
   * Controls automatic AI-assisted retry when a process/shell phase fails.
   * When enabled (default), if prechecks, work, or postchecks fail with a
   * non-zero exit code, the executor automatically retries once by delegating
   * to a Copilot agent that can inspect the failure and fix it.
   *
   * - `true` (default for process/shell work) — auto-heal enabled
   * - `false` — auto-heal disabled, fail immediately
   *
   * Auto-heal does NOT apply to agent work (AI already had its chance),
   * commit failures, or merge failures.
   */
  autoHeal?: boolean;

  /**
   * Visual grouping tag. Nodes with the same group tag are
   * rendered together in a Mermaid subgraph. Optional.
   */
  group?: string;
}

/**
 * Specification for a group (user input).
 * Groups provide namespace isolation for producer_ids and visual hierarchy.
 * Jobs within a group can reference each other by local producer_id.
 * Cross-group references use qualified paths: "group/producer_id".
 * 
 * Groups do NOT have dependencies - jobs describe the full dependency graph.
 */
export interface GroupSpec {
  /** Group name (forms part of qualified path) */
  name: string;
  
  /** Jobs within this group */
  jobs?: JobNodeSpec[];
  
  /** Nested groups (recursive - forms path like "parent/child") */
  groups?: GroupSpec[];
}

// ============================================================================
// INTERNAL NODE TYPES (After Processing)
// ============================================================================

/**
 * Type discriminator for nodes.
 * All nodes are jobs - groups are visual hierarchy only.
 */
export type NodeType = 'job';

/**
 * Base node properties (shared by all node types)
 */
interface BaseNode {
  /** Unique ID within the Plan (UUID, auto-generated) */
  id: string;
  
  /** User-controlled reference key (used in dependencies) */
  producerId: string;
  
  /** Human-friendly display name */
  name: string;
  
  /** Node type discriminator */
  type: NodeType;
  
  /** IDs of nodes this node depends on (resolved to UUIDs) */
  dependencies: string[];
  
  /** IDs of nodes that depend on this node (computed) */
  dependents: string[];
}

/**
 * Job node (internal representation)
 */
export interface JobNode extends BaseNode {
  type: 'job';
  
  /** Task description */
  task: string;
  
  /** Work specification (normalized from input) */
  work?: WorkSpec;
  
  /** Prechecks specification */
  prechecks?: WorkSpec;
  
  /** Postchecks specification */
  postchecks?: WorkSpec;
  
  /** 
   * Agent instructions (legacy support).
   * **Must be in Markdown format** if provided.
   */
  instructions?: string;
  
  /** Override base branch */
  baseBranch?: string;

  /**
   * When true, this node is expected to produce no file changes.
   * The commit phase will succeed without a commit instead of failing.
   */
  expectsNoChanges?: boolean;

  /**
   * Controls automatic AI-assisted retry when a process/shell phase fails.
   * Default: true for process/shell work, false for agent work.
   */
  autoHeal?: boolean;

  /**
 * Visual group path. Nodes with the same group path are
 * rendered together in a Mermaid subgraph.
 * Nested groups use "/" separator: "backend/api/auth"
 */
 group?: string;
 
 /** 
  * Resolved group ID (UUID). Set by the builder when creating the Plan.
  * Used to push state updates from jobs to their parent group.
  */
 groupId?: string;
}

/**
 * All nodes are jobs - PlanNode is an alias.
 * Groups are visual hierarchy only, not a separate node type.
 */
export type PlanNode = JobNode;
/**
 * Check if a node performs work (has a work specification).
 *
 * Nodes with work consume execution resources and count against parallelism limits.
 *
 * @param node - The plan node to check.
 * @returns `true` if the node has a `work` property defined.
 */
export function nodePerformsWork(node: PlanNode): boolean {
  return node.work !== undefined;
}

// ============================================================================
// SIMPLIFIED NODE TYPES (Node-Centric Model)
// ============================================================================

/**
 * Specification for creating a node (user input).
 * Replaces both JobNodeSpec (for individual nodes) and
 * PlanSpec (when used with group).
 */
export interface NodeSpec {
  /** User-controlled identifier for dependency references */
  producerId: string;

  /** Human-friendly display name (defaults to producerId) */
  name?: string;

  /** Task description (what this node does) */
  task: string;

  /** Work to perform (shell command, process, or agent) */
  work?: WorkSpec;

  /** Validation before work */
  prechecks?: WorkSpec;

  /** Validation after work */
  postchecks?: WorkSpec;

  /** Additional agent instructions (Markdown) */
  instructions?: string;

  /** Producer IDs this node depends on */
  dependencies: string[];

  /** Override base branch (root nodes only) */
  baseBranch?: string;

  /**
   * When true, this node is expected to produce no file changes.
   * The commit phase will succeed without a commit instead of failing.
   * Use for validation-only nodes, external-system updates, or analysis tasks.
   */
  expectsNoChanges?: boolean;

  /**
   * Controls automatic AI-assisted retry when a process/shell phase fails.
   * Default: true for process/shell work.
   */
  autoHeal?: boolean;

  /** Visual group tag for Mermaid rendering - nodes with same group render in a subgraph */
  group?: string;
}

/**
 * Attempt context from the last execution attempt.
 */
export interface AttemptContext {
  /** Which phase failed or was running */
  phase: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri' | 'setup';
  /** When the attempt started */
  startTime: number;
  /** When the attempt ended */
  endTime?: number;
  /** Error message if failed */
  error?: string;
  /** Exit code from process (if applicable) */
  exitCode?: number;
}

/**
 * Runtime node instance.
 * Combines what was previously split across PlanNode and NodeExecutionState.
 */
export interface NodeInstance {
  /** UUID */
  id: string;

  /** User-controlled reference key */
  producerId: string;

  /** Display name */
  name: string;

  /** Task description */
  task: string;

  /** Work specification */
  work?: WorkSpec;

  /** Pre/post validation */
  prechecks?: WorkSpec;
  postchecks?: WorkSpec;

  /** Agent instructions */
  instructions?: string;

  /** Resolved dependency node IDs */
  dependencies: string[];

  /** Computed reverse edges */
  dependents: string[];

  /** Override base branch */
  baseBranch?: string;

  /** Optional group membership */
  group?: GroupInfo;

  // --- Execution state ---

  /** Current status */
  status: NodeStatus;

  /** Timestamps */
  scheduledAt?: number;
  startedAt?: number;
  endedAt?: number;

  /** Error message if failed */
  error?: string;

  /** Git context */
  baseCommit?: string;
  completedCommit?: string;
  worktreePath?: string;

  /** Repository path */
  repoPath: string;

  /** Retry tracking */
  attempts: number;
  attemptHistory?: AttemptRecord[];

  /** Merge tracking */
  mergedToTarget?: boolean;
  consumedByDependents?: string[];
  worktreeCleanedUp?: boolean;

  /** Phase-level status */
  stepStatuses?: {
    setup?: PhaseStatus;
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
  };

  /** Session resumption */
  copilotSessionId?: string;

  /** Last attempt context */
  lastAttempt?: AttemptContext;

  /** Work summary on success */
  workSummary?: JobWorkSummary;
}
