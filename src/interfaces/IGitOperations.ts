/**
 * @fileoverview Interface for git operations.
 * 
 * Abstracts git commands to enable:
 * - Unit testing without real git operations
 * - Platform-specific implementations
 * - Consistent error handling
 * 
 * @module interfaces/IGitOperations
 */

/**
 * Configuration for creating a git worktree.
 */
export interface WorktreeConfig {
  /** Path to the main repository */
  repoPath: string;
  /** Base branch to create worktree from */
  baseBranch: string;
  /** Name for the new worktree branch */
  targetBranch: string;
  /** Directory name for worktrees (relative to repoPath) */
  worktreeRoot: string;
  /** Unique identifier for the worktree directory */
  worktreeId: string;
}

/**
 * Result of a merge operation.
 */
export interface MergeResult {
  /** Whether the merge succeeded */
  success: boolean;
  /** Commit hash of the merge commit (if successful) */
  commitHash?: string;
  /** Error message (if failed) */
  error?: string;
  /** Whether there were conflicts */
  hasConflicts?: boolean;
}

/**
 * Interface for git repository operations.
 * 
 * All operations should be idempotent where possible
 * and provide clear error messages on failure.
 * 
 * @example
 * ```typescript
 * const worktreePath = await git.createWorktree({
 *   repoPath: '/repo',
 *   baseBranch: 'main',
 *   targetBranch: 'feature/foo',
 *   worktreeRoot: '.worktrees',
 *   worktreeId: 'job-123'
 * });
 * ```
 */
export interface IGitOperations {
  /**
   * Create a new git worktree for isolated work.
   * @param config - Worktree configuration
   * @returns Absolute path to the created worktree
   * @throws Error if worktree creation fails
   */
  createWorktree(config: WorktreeConfig): Promise<string>;
  
  /**
   * Remove a git worktree and optionally its branch.
   * @param worktreePath - Absolute path to the worktree
   * @param options - Cleanup options
   */
  removeWorktree(worktreePath: string, options?: {
    /** Also delete the branch */
    deleteBranch?: boolean;
    /** Force removal even with uncommitted changes */
    force?: boolean;
  }): Promise<void>;
  
  /**
   * Merge a source branch into a target branch.
   * @param source - Branch to merge from
   * @param target - Branch to merge into
   * @param cwd - Working directory for the operation
   * @returns Result of the merge operation
   */
  merge(source: string, target: string, cwd: string): Promise<MergeResult>;
  
  /**
   * Get the default branch of a repository.
   * @param repoPath - Path to the repository
   * @returns Name of the default branch (e.g., 'main', 'master')
   */
  getDefaultBranch(repoPath: string): Promise<string>;
  
  /**
   * Get the current branch name.
   * @param cwd - Working directory
   * @returns Current branch name
   */
  getCurrentBranch(cwd: string): Promise<string>;
  
  /**
   * Calculate diff statistics between two refs.
   * @param baseRef - Base reference (branch, commit, etc.)
   * @param headRef - Head reference to compare
   * @param cwd - Working directory
   * @returns Statistics about the changes
   */
  getDiffStats(baseRef: string, headRef: string, cwd: string): Promise<{
    commits: number;
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
  }>;
}
