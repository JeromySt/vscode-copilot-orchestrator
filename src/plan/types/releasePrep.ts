/**
 * @fileoverview Release Preparation Types
 *
 * Defines types for pre-PR preparation tasks that guide developers
 * through quality checks, documentation updates, and validation before
 * creating a pull request.
 *
 * @module plan/types/releasePrep
 */

// ============================================================================
// PREPARATION TASK STATUS
// ============================================================================

/**
 * Lifecycle status of a preparation task.
 * 
 * - `pending`: Task is waiting to be started
 * - `in-progress`: Task is currently being executed
 * - `completed`: Task finished successfully
 * - `skipped`: Task was intentionally skipped (optional tasks only)
 */
export type PrepTaskStatus = 'pending' | 'in-progress' | 'completed' | 'skipped';

// ============================================================================
// PREPARATION TASK TYPES
// ============================================================================

/**
 * Type of preparation task.
 * 
 * Each type has specific automation capabilities and requirements.
 */
export type PrepTaskType = 
  | 'update-changelog'     // Update CHANGELOG.md with release notes
  | 'update-version'       // Bump version numbers (package.json etc.)
  | 'update-docs'          // Update README, docs for new features
  | 'create-release-notes' // Generate release notes from commits/plans
  | 'run-checks'           // Run compile + test suite
  | 'ai-review'            // AI reviews the release for quality
  | 'custom';              // User-defined task

// ============================================================================
// PREPARATION TASK
// ============================================================================

/**
 * A single preparation task to complete before creating a PR.
 * 
 * Tasks can be required (blocking PR creation) or optional, and can be
 * automatable (Copilot can execute them) or manual (user must complete).
 */
export interface PreparationTask {
  /** Unique identifier for the task */
  id: string;

  /** Type of task */
  type: PrepTaskType;

  /** Human-readable task title */
  title: string;

  /** Detailed description of what the task involves */
  description: string;

  /** Current status of the task */
  status: PrepTaskStatus;

  /** Whether this task is required (blocks PR creation) or optional */
  required: boolean;

  /** Whether Copilot can auto-complete this task */
  automatable: boolean;

  /** Result/output of the task (populated after completion) */
  result?: string;

  /** Error message if task failed */
  error?: string;

  /** Timestamp when task execution started */
  startedAt?: number;

  /** Timestamp when task execution completed */
  completedAt?: number;
}

// ============================================================================
// RELEASE INSTRUCTIONS
// ============================================================================

/**
 * Release instructions file metadata.
 * 
 * Contains guidance for preparing the release, including checklists,
 * documentation standards, and validation steps.
 */
export interface ReleaseInstructions {
  /** Path to the release instructions file */
  filePath: string;

  /** Content of the instructions */
  content: string;

  /** Whether the file was auto-generated or pre-existing */
  source: 'auto-generated' | 'existing';
}
