/**
 * @fileoverview IReleaseManager Interface
 *
 * Manages release lifecycle including creating releases, merging plan commits,
 * creating PRs, monitoring PR feedback, and autonomously addressing issues.
 *
 * @module interfaces/IReleaseManager
 */

import type {
  ReleaseDefinition,
  ReleaseStatus,
  ReleaseProgress,
} from '../plan/types/release';

/**
 * Options for creating a new release.
 */
export interface CreateReleaseOptions {
  /** Human-friendly name for the release */
  name: string;

  /** Plan IDs to include in this release (can be empty for manual/from-branch releases) */
  planIds: string[];

  /** Branch name for the release (e.g., 'release/v1.2.0') */
  releaseBranch: string;

  /** Target branch for the PR (defaults to 'main') */
  targetBranch?: string;

  /** Repository path (required when planIds is empty) */
  repoPath?: string;
}

/**
 * Release Manager interface.
 * 
 * Orchestrates multi-plan releases by:
 * 1. Creating an isolated repository clone
 * 2. Merging all plan commits into a release branch
 * 3. Creating a pull request
 * 4. Monitoring PR for CI checks, reviews, and security alerts
 * 5. Autonomously addressing feedback until PR is merged
 * 
 * All repository operations use isolated clones under
 * `<repoRoot>/.orchestrator/release/<sanitized-branch>/`.
 */
export interface IReleaseManager {
  // ── Release Lifecycle ──────────────────────────────────────────────

  /**
   * Creates a new release in 'drafting' status.
   * 
   * @param options - Release configuration options
   * @returns The created release definition
   */
  createRelease(options: CreateReleaseOptions): Promise<ReleaseDefinition>;

  /**
   * Starts executing a release.
   * 
   * Transitions through: merging → creating-pr → monitoring → addressing
   * until the PR is merged (succeeded) or an error occurs (failed).
   * 
   * @param releaseId - The release ID to start
   * @throws If release not found or already started
   */
  startRelease(releaseId: string): Promise<void>;

  /**
   * Cancels an in-progress release.
   * 
   * @param releaseId - The release ID to cancel
   * @returns True if canceled, false if not found or already terminal
   */
  cancelRelease(releaseId: string): Promise<boolean>;

  // ── Release Queries ────────────────────────────────────────────────

  /**
   * Gets a release by ID.
   * 
   * @param releaseId - The release ID
   * @returns The release definition or undefined if not found
   */
  getRelease(releaseId: string): ReleaseDefinition | undefined;

  /**
   * Gets all releases.
   * 
   * @returns Array of all release definitions
   */
  getAllReleases(): ReleaseDefinition[];

  /**
   * Gets releases by status.
   * 
   * @param status - The release status to filter by
   * @returns Array of matching release definitions
   */
  getReleasesByStatus(status: ReleaseStatus): ReleaseDefinition[];

  /**
   * Gets detailed progress for a release.
   * 
   * @param releaseId - The release ID
   * @returns Progress information or undefined if not found
   */
  getReleaseProgress(releaseId: string): ReleaseProgress | undefined;

  // ── Release Management ─────────────────────────────────────────────

  /**
   * Deletes a release.
   * 
   * Only terminal releases (succeeded/failed/canceled) can be deleted.
   * Does not clean up the isolated repository automatically.
   * 
   * @param releaseId - The release ID to delete
   * @returns True if deleted, false if not found or still active
   */
  deleteRelease(releaseId: string): boolean;

  /**
   * Cleans up isolated repository clones for all terminal releases.
   * 
   * Removes directories under `.orchestrator/release/` that are no longer
   * needed. Safe to call periodically.
   */
  cleanupIsolatedRepos(): Promise<void>;

  // ── Preparation Tasks ──────────────────────────────────────────────

  /**
   * Gets preparation tasks for a release.
   * 
   * Returns undefined if release has no preparation tasks initialized.
   * 
   * @param releaseId - The release ID
   * @returns Array of preparation tasks or undefined
   */
  getPrepTasks(releaseId: string): import('../plan/types/releasePrep').PreparationTask[] | undefined;

  /**
   * Executes a preparation task using Copilot.
   * 
   * Only automatable tasks can be executed. Manual tasks must be completed
   * by the user and marked complete with completeTask().
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID to execute
   * @throws If release not found, task not found, or task not automatable
   */
  executeTask(releaseId: string, taskId: string): Promise<void>;

  /**
   * Marks a task as completed (for manual tasks).
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID to mark complete
   * @param result - Optional result message
   * @returns True if marked complete, false if not found
   */
  completeTask(releaseId: string, taskId: string, result?: string): boolean;

  /**
   * Skips an optional preparation task.
   * 
   * Required tasks cannot be skipped.
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID to skip
   * @returns True if skipped, false if not found or required
   */
  skipTask(releaseId: string, taskId: string): boolean;

  /**
   * Checks if all required preparation tasks are complete.
   * 
   * @param releaseId - The release ID
   * @returns True if all required tasks are complete
   */
  areRequiredTasksComplete(releaseId: string): boolean;

  // ── Events ─────────────────────────────────────────────────────────

  /**
   * Registers an event handler.
   * 
   * @param event - The event name
   * @param handler - The event handler function
   */
  on(event: 'releaseCreated', handler: (release: ReleaseDefinition) => void): void;
  on(event: 'releaseStatusChanged', handler: (release: ReleaseDefinition) => void): void;
  on(event: 'releaseProgress', handler: (releaseId: string, progress: ReleaseProgress) => void): void;
  on(event: 'releasePRCycle', handler: (releaseId: string, cycle: import('../plan/types/release').PRMonitorCycle) => void): void;
  on(event: 'releaseCompleted', handler: (release: ReleaseDefinition) => void): void;
}
