/**
 * @fileoverview Job Splitter Interface
 *
 * Defines the contract for splitting a checkpointed job into sub-jobs
 * based on a checkpoint manifest. Used by the execution engine when a
 * job completes with a checkpoint (context pressure fan-out/fan-in).
 *
 * @module interfaces/IJobSplitter
 */

import type { AgentSpec } from '../plan/types/specs';
import type { JobNodeSpec } from '../plan/types/nodes';

/**
 * A completed file entry from the checkpoint manifest.
 */
export interface ManifestCompletedFile {
  /** File path */
  file: string;
  /** What was implemented and key design decisions made */
  summary: string;
  /** Public API surface — exports, interfaces, key method signatures */
  publicApi?: string;
  /** Patterns used that remaining work should follow */
  patterns?: string;
}

/**
 * An in-progress file entry from the checkpoint manifest.
 */
export interface ManifestInProgressFile {
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
 * A remaining work item from the checkpoint manifest.
 */
export interface ManifestRemainingItem {
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
 * Agent-suggested split strategy entry.
 */
export interface ManifestSuggestedSplit {
  /** Human-readable name for this sub-job */
  name: string;
  /** Which remaining files/items this sub-job should handle */
  files: string[];
  /** Full prompt the orchestrator should give to the sub-job agent */
  prompt: string;
  /** Execution order — lower runs first */
  priority?: number;
}

/**
 * Codebase context discovered by the parent agent.
 */
export interface ManifestCodebaseContext {
  /** Build/test commands that work */
  buildCommand?: string;
  testCommand?: string;
  /** Key directories and what they contain */
  projectStructure?: string;
  /** Naming conventions, coding patterns the project follows */
  conventions?: string;
  /** Gotchas or issues encountered */
  warnings?: string;
}

/**
 * Checkpoint manifest written by an agent under context pressure.
 * Represents the agent's memory transfer protocol for sub-job creation.
 */
export interface CheckpointManifest {
  /** Always "checkpointed" */
  status: 'checkpointed';
  /** Summary of ALL completed work */
  completed: ManifestCompletedFile[];
  /** File the agent was mid-way through when checkpointed */
  inProgress?: ManifestInProgressFile;
  /** Work items not yet started */
  remaining: ManifestRemainingItem[];
  /** Agent's recommended split strategy */
  suggestedSplits?: ManifestSuggestedSplit[];
  /** Codebase context the parent agent discovered */
  codebaseContext?: ManifestCodebaseContext;
  /** One-paragraph executive summary */
  summary: string;
  /** Context pressure level at checkpoint time */
  pressure?: number;
}

/**
 * A chunk of work to be assigned to a single sub-job.
 */
export interface WorkChunk {
  /** Human-readable name for the chunk */
  name?: string;
  /** Files this chunk covers */
  files: string[];
  /** Description of the work */
  description: string;
  /** Agent-authored prompt (from suggestedSplits) */
  prompt?: string;
  /** Execution priority — lower runs first */
  priority: number;
}

/**
 * Service that converts a checkpoint manifest into sub-job specifications.
 *
 * Used by the execution engine during fan-out/fan-in DAG reshaping after
 * a job completes with a checkpoint due to context pressure.
 */
export interface IJobSplitter {
  /**
   * Build work chunks from a checkpoint manifest.
   *
   * Primary strategy: use the agent's {@link CheckpointManifest.suggestedSplits}
   * sorted by priority. Fallback: naive batch-by-2 with inProgress getting its
   * own chunk.
   *
   * Chunks are capped at configurable `maxSubJobs` (VS Code setting, default 8).
   *
   * @param manifest - The checkpoint manifest from the completed job.
   * @param originalInstructions - The parent job's original instructions text.
   * @returns Array of work chunks, one per sub-job.
   */
  buildChunks(manifest: CheckpointManifest, originalInstructions: string): WorkChunk[];

  /**
   * Build an {@link AgentSpec} for a sub-job from a work chunk.
   *
   * Generates agent instructions wrapping the chunk's prompt (or fallback
   * instructions) with a standard preamble listing completed files and rules.
   *
   * @param chunk - The work chunk to generate a spec for.
   * @param manifest - The full checkpoint manifest (for completed files context).
   * @param parentNodeId - The parent node ID (for referencing the instructions file).
   * @returns An AgentSpec ready to be assigned as a sub-job's work spec.
   */
  buildSubJobSpec(chunk: WorkChunk, manifest: CheckpointManifest, parentNodeId: string): AgentSpec;

  /**
   * Build a fan-in {@link JobNodeSpec} that validates combined sub-job output.
   *
   * The fan-in job has no-op work (`{ type: 'shell', command: 'true' }`),
   * runs the parent's postchecks, and has autoHeal enabled.
   *
   * @param parentNode - The parent node spec (for inheriting postchecks).
   * @param subJobProducerIds - Producer IDs of all sub-jobs this fan-in waits for.
   * @returns A JobNodeSpec for the fan-in validation job.
   */
  buildFanInSpec(parentNode: JobNodeSpec, subJobProducerIds: string[]): JobNodeSpec;
}
