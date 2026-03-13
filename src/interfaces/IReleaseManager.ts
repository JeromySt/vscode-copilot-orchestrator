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

  // ── State Management ───────────────────────────────────────────────

  /**
   * Transitions a release to a new status.
   * 
   * @param releaseId - The release ID
   * @param newStatus - The target status
   * @param reason - Optional reason for the transition
   * @returns True if transition succeeded, false otherwise
   */
  transitionToState(releaseId: string, newStatus: ReleaseStatus, reason?: string): Promise<boolean>;

  // ── Preparation Tasks ──────────────────────────────────────────────

  /**
   * Auto-executes a preparation task using Copilot.
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID to execute
   */
  executePreparationTask(releaseId: string, taskId: string): Promise<void>;

  /**
   * Manually marks a preparation task as complete.
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID to complete
   */
  completePreparationTask(releaseId: string, taskId: string): Promise<void>;

  /**
   * Skips a preparation task.
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID to skip
   */
  skipPreparationTask(releaseId: string, taskId: string): Promise<void>;

  /**
   * Gets the log file path for a preparation task.
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID
   * @returns The log file path, or undefined if not found or no log exists
   */
  getTaskLogFilePath(releaseId: string, taskId: string): string | undefined;

  /**
   * Update the status of a review finding.
   * 
   * @param releaseId - The release ID
   * @param taskId - The task ID
   * @param findingId - The finding ID to update
   * @param status - The new status
   * @param note - Optional note (e.g., reason for dismissal)
   */
  updateFindingStatus(releaseId: string, taskId: string, findingId: string, status: import('../plan/types/release').ReviewFindingStatus, note?: string): Promise<void>;

  /**
   * Get all findings for a release (across all tasks).
   * 
   * @param releaseId - The release ID
   * @returns Array of all findings from all tasks in the release
   */
  getAllFindings(releaseId: string): import('../plan/types/release').ReviewFinding[];

  // ── Plan Management ────────────────────────────────────────────────

  /**
   * Adds plans to a release at any stage.
   * 
   * @param releaseId - The release ID
   * @param planIds - The plan IDs to add
   */
  addPlansToRelease(releaseId: string, planIds: string[]): Promise<void>;

  // ── PR Management ──────────────────────────────────────────────────

  /**
   * Creates a PR for the release.
   * 
   * @param releaseId - The release ID
   * @param asDraft - Whether to create as draft PR
   */
  createPR(releaseId: string, asDraft?: boolean): Promise<void>;

  /**
   * Adopts an existing PR for the release.
   * 
   * @param releaseId - The release ID
   * @param prNumber - The PR number to adopt
   */
  adoptPR(releaseId: string, prNumber: number): Promise<void>;

  /**
   * Starts monitoring a release's PR.
   * 
   * @param releaseId - The release ID
   */
  startMonitoring(releaseId: string): Promise<void>;

  /**
   * Stops monitoring a release's PR.
   * 
   * @param releaseId - The release ID
   */
  stopMonitoring(releaseId: string): Promise<void>;
  /**
   * Address selected findings using AI-assisted fixing.
   *
   * @param releaseId - The release ID
   * @param findings - Array of findings to address (comments, checks, alerts)
   */
  addressFindings(releaseId: string, findings: any[]): Promise<void>;

  /**
   * Toggle auto-fix mode.
   * When enabled, new findings from monitoring cycles are automatically sent to AI.
   */
  setAutoFix(releaseId: string, enabled: boolean): void;

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
  on(event: 'releaseActionTaken', handler: (releaseId: string, action: import('../plan/types/release').PRActionTaken & { timestamp?: number }) => void): void;
  on(event: 'findingsResolved', handler: (releaseId: string, findingIds: string[], hasCommit: boolean) => void): void;
}
