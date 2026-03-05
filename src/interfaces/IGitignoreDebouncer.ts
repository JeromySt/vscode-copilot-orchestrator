/**
 * @fileoverview Debouncer for .gitignore writes after branch changes.
 * Prevents creating uncommitted changes that block git checkout operations
 * by deferring .gitignore re-application for a configurable delay after
 * branch switches.
 *
 * @module interfaces/IGitignoreDebouncer
 */

/**
 * Delays .gitignore entry writes after branch changes to prevent dirty-branch
 * race conditions with VS Code's git integration.
 */
export interface IGitignoreDebouncer {
  /** Record that a branch change just occurred; starts the delay window. */
  notifyBranchChange(): void;

  /**
   * Ensure .gitignore entries exist, deferring if within the post-branch-change window.
   * Merges pending entries if multiple calls arrive during the delay.
   * @param repoPath - Absolute path to the git repository root
   * @param entries - Lines to ensure exist in .gitignore
   * @returns Resolves when entries are written (immediately or after delay)
   */
  ensureEntries(repoPath: string, entries: string[]): Promise<void>;

  /** Clean up any pending timers. */
  dispose(): void;
}
