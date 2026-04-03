/**
 * @fileoverview Interface for isolated repository management.
 * 
 * Manages isolated git clones for release workflows, placed under
 * `.orchestrator/release/<sanitized-branch-name>/` directory structure.
 * 
 * @module interfaces/IIsolatedRepoManager
 */

/**
 * Information about an isolated repository clone.
 */
export interface IsolatedRepoInfo {
  /** Unique identifier for this isolated repo (typically release ID) */
  releaseId: string;
  
  /** Absolute path to the clone directory under .orchestrator/release/ */
  clonePath: string;
  
  /** Whether the clone is ready for use (clone + checkout completed) */
  isReady: boolean;
  
  /** Current branch checked out in the clone, if available */
  currentBranch?: string;
}

/**
 * Interface for managing isolated repository clones.
 * 
 * Creates and manages git clones in `.orchestrator/release/` for release workflows.
 * Clones use `--shared` or `--reference` for efficiency, avoiding full object duplication.
 * 
 * @example
 * ```typescript
 * const manager = container.resolve<IIsolatedRepoManager>(Tokens.IIsolatedRepoManager);
 * 
 * // Create isolated clone for release workflow
 * const info = await manager.createIsolatedRepo('release-v1.0.0', '/path/to/repo', 'release/v1.0.0');
 * 
 * // Get clone path
 * const clonePath = await manager.getRepoPath('release-v1.0.0');
 * 
 * // Cleanup after release completes
 * await manager.removeIsolatedRepo('release-v1.0.0');
 * ```
 */
export interface IIsolatedRepoManager {
  /**
   * Create an isolated repository clone.
   * 
   * Clones the repository at `repoPath` to `.orchestrator/release/<sanitized-branch>/`,
   * checks out the specified branch, and sets up the remote URL.
   * 
   * Strategy: Tries `git clone --shared` first; if that fails (child-of-parent issue),
   * falls back to `git clone --reference`; if both fail, tries `git worktree add --detach`.
   * 
   * @param releaseId - Unique identifier for this isolated repo
   * @param repoPath - Path to the source repository to clone from
   * @param branch - Branch name to checkout in the clone
   * @returns Information about the created clone
   * @throws Error if clone creation fails or path validation fails
   */
  createIsolatedRepo(releaseId: string, repoPath: string, branch: string): Promise<IsolatedRepoInfo>;

  /**
   * Get the clone path for an isolated repository.
   * 
   * @param releaseId - Unique identifier for the isolated repo
   * @returns Absolute path to the clone, or null if not found
   */
  getRepoPath(releaseId: string): Promise<string | null>;

  /**
   * Get detailed information about an isolated repository.
   * 
   * @param releaseId - Unique identifier for the isolated repo
   * @returns Repository info, or null if not found
   */
  getRepoInfo(releaseId: string): Promise<IsolatedRepoInfo | null>;

  /**
   * Remove an isolated repository clone.
   * 
   * Deletes the clone directory and removes it from tracking.
   * Safe to call even if the clone doesn't exist.
   * 
   * @param releaseId - Unique identifier for the isolated repo to remove
   * @returns true if removed, false if not found
   */
  removeIsolatedRepo(releaseId: string): Promise<boolean>;

  /**
   * Cleanup all isolated repository clones.
   * 
   * Called during extension deactivation to clean up all managed clones.
   * Also scans `.orchestrator/release/` for orphaned clones not in the active registry.
   * 
   * @returns Number of clones cleaned up
   */
  cleanupAll(): Promise<number>;

  /**
   * List all active isolated repositories.
   * 
   * @returns Array of release IDs for all managed clones
   */
  listActive(): Promise<string[]>;
}
