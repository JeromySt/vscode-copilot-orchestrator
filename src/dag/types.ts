/**
 * @fileoverview DAG Core Types
 * 
 * Defines the fundamental types for the DAG-based orchestration system.
 * Everything is a DAG - even a single job is a DAG with one node.
 * 
 * Key Concepts:
 * - DagSpec: User-facing specification for creating a DAG
 * - Dag: Immutable topology (nodes + edges)
 * - DagState: Mutable execution state (single source of truth)
 * - NodeStatus: Valid states for a node
 * 
 * @module dag/types
 */

// ============================================================================
// NODE TYPES
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
 * Check if a status is terminal
 */
export function isTerminal(status: NodeStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Check if a transition is valid
 */
export function isValidTransition(from: NodeStatus, to: NodeStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ============================================================================
// NODE SPECIFICATION (User Input)
// ============================================================================

// ============================================================================
// WORK SPECIFICATION TYPES
// ============================================================================

/**
 * Direct process spawn (no shell interpretation).
 * Arguments are passed directly - no quoting issues.
 */
export interface ProcessSpec {
  type: 'process';
  
  /** Executable to run (e.g., "node", "dotnet", "powershell.exe") */
  executable: string;
  
  /** Arguments as array - no shell quoting needed */
  args?: string[];
  
  /** Additional environment variables */
  env?: Record<string, string>;
  
  /** Override working directory (relative to worktree or absolute) */
  cwd?: string;
  
  /** Process timeout in milliseconds */
  timeout?: number;
}

/**
 * Shell command execution.
 * Command is interpreted by the shell.
 */
export interface ShellSpec {
  type: 'shell';
  
  /** Shell command string */
  command: string;
  
  /** 
   * Specific shell to use:
   * - 'cmd' - Windows cmd.exe
   * - 'powershell' - Windows PowerShell
   * - 'pwsh' - PowerShell Core (cross-platform)
   * - 'bash' - Bash shell
   * - 'sh' - Default POSIX shell
   * - undefined - Platform default (cmd on Windows, sh on Unix)
   */
  shell?: 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh';
  
  /** Additional environment variables */
  env?: Record<string, string>;
  
  /** Override working directory */
  cwd?: string;
  
  /** Process timeout in milliseconds */
  timeout?: number;
}

/**
 * AI Agent delegation.
 * Work is performed by Copilot agent.
 */
export interface AgentSpec {
  type: 'agent';
  
  /** Instructions for the agent (what to do) */
  instructions: string;
  
  /** Optional model preference */
  model?: string;
  
  /** Files to include in agent context (relative to worktree) */
  contextFiles?: string[];
  
  /** Maximum agent turns/iterations */
  maxTurns?: number;
  
  /** Additional environment context to provide */
  context?: string;
}

/**
 * Work specification - what to execute.
 * Can be:
 * - string: Legacy format, interpreted as shell command or "@agent ..." 
 * - ProcessSpec: Direct process spawn
 * - ShellSpec: Shell command with explicit shell choice
 * - AgentSpec: AI agent delegation
 */
export type WorkSpec = string | ProcessSpec | ShellSpec | AgentSpec;

/**
 * Normalize a WorkSpec to its structured form.
 * Handles backwards compatibility with string format.
 */
export function normalizeWorkSpec(spec: WorkSpec | undefined): ProcessSpec | ShellSpec | AgentSpec | undefined {
  if (spec === undefined) {
    return undefined;
  }
  
  if (typeof spec === 'string') {
    // Legacy string format
    if (spec.startsWith('@agent')) {
      const instructions = spec.replace(/^@agent\s*/i, '').trim();
      return {
        type: 'agent',
        instructions: instructions || 'Complete the task as specified',
      };
    }
    // Default to shell command
    return {
      type: 'shell',
      command: spec,
    };
  }
  
  return spec;
}

/**
 * Specification for a job node (user input).
 * Jobs execute processes, shell commands, or delegate to AI agents.
 */
export interface JobNodeSpec {
  /** User-controlled identifier for DAG references (used in consumesFrom) */
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
  
  /** Additional instructions for agent tasks (legacy, use AgentSpec.instructions) */
  instructions?: string;
  
  /** IDs of nodes this job depends on (consumesFrom) */
  dependencies: string[];
  
  /** Override base branch (only for root nodes) */
  baseBranch?: string;
}

/**
 * Specification for a sub-DAG node (user input).
 * Sub-DAGs are nested DAGs that run as a unit.
 */
export interface SubDagNodeSpec {
  /** User-controlled identifier for DAG references */
  producerId: string;
  
  /** Human-friendly display name */
  name?: string;
  
  /** Jobs within this sub-DAG */
  jobs: JobNodeSpec[];
  
  /** Nested sub-DAGs (recursive) */
  subDags?: SubDagNodeSpec[];
  
  /** IDs of nodes this sub-DAG depends on */
  dependencies: string[];
  
  /** Max parallel jobs in this sub-DAG */
  maxParallel?: number;
}

/**
 * Full DAG specification (user input for creating a DAG).
 */
export interface DagSpec {
  /** Human-friendly name for the DAG */
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
  
  /** Job nodes in this DAG */
  jobs: JobNodeSpec[];
  
  /** Sub-DAG nodes */
  subDags?: SubDagNodeSpec[];
}

// ============================================================================
// INTERNAL NODE TYPES (After Processing)
// ============================================================================

/**
 * Type discriminator for nodes
 */
export type NodeType = 'job' | 'subdag';

/**
 * Base node properties (shared by all node types)
 */
interface BaseNode {
  /** Unique ID within the DAG (UUID, auto-generated) */
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
  
  /** Agent instructions (legacy support) */
  instructions?: string;
  
  /** Override base branch */
  baseBranch?: string;
}

/**
 * Sub-DAG node (internal representation)
 */
export interface SubDagNode extends BaseNode {
  type: 'subdag';
  
  /** The nested DAG specification */
  childSpec: DagSpec;
  
  /** Max parallel for the sub-DAG */
  maxParallel?: number;
  
  /** Child DAG ID when instantiated (set when node starts running) */
  childDagId?: string;
}

/**
 * Union type for all node types
 */
export type DagNode = JobNode | SubDagNode;

/**
 * Check if a node performs work (has a work specification).
 * Nodes with work consume execution resources and count against parallelism limits.
 * Sub-DAG nodes are coordination nodes that don't perform work directly.
 */
export function nodePerformsWork(node: DagNode): boolean {
  return 'work' in node && node.work !== undefined;
}

// ============================================================================
// DAG STATE (Execution State)
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
  
  /** Child DAG ID (for subdags) */
  childDagId?: string;
  
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
}

/**
 * Overall DAG status (derived from node states)
 */
export type DagStatus = 
  | 'pending'    // Not started
  | 'running'    // At least one node running
  | 'succeeded'  // All nodes succeeded
  | 'failed'     // At least one node failed (not blocked)
  | 'partial'    // Some succeeded, some failed
  | 'canceled';  // User canceled

/**
 * Full DAG instance (topology + state)
 */
export interface DagInstance {
  /** Unique DAG ID (UUID) */
  id: string;
  
  /** The DAG specification */
  spec: DagSpec;
  
  /** Map of node ID to node definition */
  nodes: Map<string, DagNode>;
  
  /** Map of producerId to node ID (for resolving references) */
  producerIdToNodeId: Map<string, string>;
  
  /** Root node IDs (no dependencies) */
  roots: string[];
  
  /** Leaf node IDs (no dependents) */
  leaves: string[];
  
  /** Map of node ID to execution state */
  nodeStates: Map<string, NodeExecutionState>;
  
  /** Parent DAG ID (if this is a sub-DAG) */
  parentDagId?: string;
  
  /** Parent node ID (the subdag node in parent) */
  parentNodeId?: string;
  
  /** Repository path */
  repoPath: string;
  
  /** Base branch */
  baseBranch: string;
  
  /** Target branch */
  targetBranch?: string;
  
  /** Worktree root directory */
  worktreeRoot: string;
  
  /** When the DAG was created */
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
 * Aggregated work summary for a DAG
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
  dagId: string;
  nodeId: string;
  from: NodeStatus;
  to: NodeStatus;
  timestamp: number;
}

/**
 * Event emitted when a DAG completes
 */
export interface DagCompletionEvent {
  dagId: string;
  status: DagStatus;
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
}

/**
 * Context passed to executor
 */
export interface ExecutionContext {
  /** DAG instance */
  dag: DagInstance;
  
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
