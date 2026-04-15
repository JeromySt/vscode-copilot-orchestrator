/**
 * @fileoverview Interface for checkpoint sentinel and manifest file operations.
 *
 * Manages the filesystem signals used by the context pressure system:
 * - **Sentinel file** (`CHECKPOINT_REQUIRED`): written by the orchestrator to
 *   signal the agent to stop and checkpoint its work.
 * - **Manifest file** (`checkpoint-manifest.json`): written by the agent to
 *   describe completed/remaining work for sub-job creation.
 *
 * All I/O goes through {@link IFileSystem} — never raw `fs`.
 *
 * @see docs/CONTEXT_PRESSURE_DESIGN.md §5.1–§5.2, §6.2–§6.3, §13.1
 * @module interfaces/ICheckpointManager
 */

/**
 * Pressure state snapshot passed when writing the sentinel.
 *
 * Mirrors the detection layer's output so the sentinel carries full context
 * for the agent (and for diagnostics).
 */
export interface ContextPressureState {
  /** Pressure level that triggered the checkpoint signal */
  level: 'normal' | 'elevated' | 'high' | 'critical';
  /** Current input-token count observed in the most recent turn */
  currentInputTokens: number;
  /** Model's max prompt-token budget */
  maxPromptTokens: number;
  /** Ratio: currentInputTokens / maxPromptTokens */
  pressure: number;
}

/**
 * A single completed work item recorded by the agent.
 */
export interface CheckpointCompletedItem {
  /** File path */
  file: string;
  /** What was implemented and key design decisions made */
  summary: string;
  /** Public API surface — exports, interfaces, key method signatures */
  publicApi?: string;
  /** Patterns used that the remaining work should follow */
  patterns?: string;
}

/**
 * Partially-completed work the agent was mid-way through when checkpointed.
 */
export interface CheckpointInProgressItem {
  /** File path */
  file: string;
  /** What's done in this file */
  completedParts: string;
  /** What's NOT done — specific methods, test cases, logic blocks */
  remainingParts: string;
  /** Any important decisions made or constraints discovered */
  notes?: string;
}

/**
 * A remaining work item not yet started.
 */
export interface CheckpointRemainingItem {
  /** File path or logical unit of work */
  file: string;
  /** Full description of what needs to be built */
  description: string;
  /** Dependencies on completed work — what to import, extend, or reference */
  dependsOn?: string;
  /** Any constraints or requirements the parent agent discovered */
  constraints?: string;
}

/**
 * Agent-suggested split strategy for remaining work.
 */
export interface CheckpointSuggestedSplit {
  /** Human-readable name for this sub-job */
  name: string;
  /** Which remaining files/items this sub-job should handle */
  files: string[];
  /** Full prompt the orchestrator should give to the sub-job agent */
  prompt: string;
  /** Suggested execution order — lower runs first */
  priority?: number;
}

/**
 * Codebase context discovered during the agent's work.
 */
export interface CheckpointCodebaseContext {
  /** Build command that works */
  buildCommand?: string;
  /** Test command that works */
  testCommand?: string;
  /** Key directories and what they contain */
  projectStructure?: string;
  /** Naming conventions, coding patterns the project follows */
  conventions?: string;
  /** Gotchas or issues encountered */
  warnings?: string;
}

/**
 * The checkpoint manifest — the agent's memory-transfer protocol.
 *
 * Written by the agent to `.orchestrator/checkpoint-manifest.json` when it
 * receives the checkpoint signal. Contains enough context for sub-job agents
 * to resume work without re-discovering the codebase.
 *
 * @see docs/CONTEXT_PRESSURE_DESIGN.md §6.2
 */
export interface CheckpointManifest {
  /** Always "checkpointed" */
  status: 'checkpointed';
  /** All completed work with rich context */
  completed: CheckpointCompletedItem[];
  /** File the agent was mid-way through when checkpointed */
  inProgress?: CheckpointInProgressItem;
  /** Work items not yet started */
  remaining: CheckpointRemainingItem[];
  /** Agent's recommended split strategy */
  suggestedSplits?: CheckpointSuggestedSplit[];
  /** Codebase context the parent agent discovered */
  codebaseContext?: CheckpointCodebaseContext;
  /** One-paragraph executive summary */
  summary: string;
}

/**
 * Manages checkpoint sentinel and manifest files for context pressure.
 *
 * @example
 * ```typescript
 * const mgr = container.resolve<ICheckpointManager>(Tokens.ICheckpointManager);
 *
 * // Orchestrator writes sentinel when pressure is critical
 * await mgr.writeSentinel(worktreePath, pressureState);
 *
 * // After agent exits, read the manifest it wrote
 * if (await mgr.manifestExists(worktreePath)) {
 *   const manifest = await mgr.readManifest(worktreePath);
 *   // ... create sub-jobs from manifest ...
 * }
 * ```
 */
export interface ICheckpointManager {
  /**
   * Write the checkpoint sentinel file to signal the agent to stop.
   *
   * Creates `<worktreePath>/.orchestrator/CHECKPOINT_REQUIRED` with a JSON
   * payload containing the pressure state and instructions for the agent.
   *
   * @param worktreePath - Absolute path to the agent's worktree
   * @param state - Current context pressure state
   */
  writeSentinel(worktreePath: string, state: ContextPressureState): Promise<void>;

  /**
   * Check whether the agent wrote a checkpoint manifest.
   *
   * @param worktreePath - Absolute path to the agent's worktree
   * @returns `true` if `checkpoint-manifest.json` exists
   */
  manifestExists(worktreePath: string): Promise<boolean>;

  /**
   * Read and parse the checkpoint manifest.
   *
   * Returns `undefined` if the file does not exist or cannot be parsed.
   * Logs a warning on parse errors so diagnostics are visible.
   *
   * @param worktreePath - Absolute path to the agent's worktree
   * @returns Parsed manifest, or `undefined` on missing/invalid file
   */
  readManifest(worktreePath: string): Promise<CheckpointManifest | undefined>;

  /**
   * Remove the checkpoint manifest file.
   *
   * Safe to call even if the file does not exist.
   *
   * @param worktreePath - Absolute path to the agent's worktree
   */
  cleanupManifest(worktreePath: string): Promise<void>;

  /**
   * Remove the checkpoint sentinel file.
   *
   * Safe to call even if the file does not exist.
   *
   * @param worktreePath - Absolute path to the agent's worktree
   */
  cleanupSentinel(worktreePath: string): Promise<void>;
}
