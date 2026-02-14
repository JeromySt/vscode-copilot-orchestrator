/**
 * @fileoverview Interface for git operations abstraction.
 * 
 * Provides a high-level interface over the modular git operations in `src/git/`.
 * Organized into sub-interfaces matching the git module structure:
 * branches, worktrees, merge, and repository operations.
 * 
 * @module interfaces/IGitOperations
 */

import type {
  CommandResult,
  GitLogger,
  MergeResult,
  MergeOptions,
  MergeTreeResult,
  MergeTreeOptions,
  CommitInfo,
  FileChange,
  WorktreeCreateOptions,
} from '../git';
import type { CreateTiming } from '../git/core/worktrees';

/**
 * Interface for git branch operations.
 * 
 * @see src/git/core/branches.ts for the concrete implementation.
 */
export interface IGitBranches {
  isDefaultBranch(branchName: string, repoPath: string): Promise<boolean>;
  exists(branchName: string, repoPath: string): Promise<boolean>;
  remoteExists(branchName: string, repoPath: string, remote?: string): Promise<boolean>;
  current(repoPath: string): Promise<string>;
  currentOrNull(repoPath: string): Promise<string | null>;
  create(branchName: string, fromRef: string, repoPath: string, log?: GitLogger): Promise<void>;
  createOrReset(branchName: string, fromRef: string, repoPath: string, log?: GitLogger): Promise<void>;
  checkout(repoPath: string, branchName: string, log?: GitLogger): Promise<void>;
  list(repoPath: string): Promise<string[]>;
  getCommit(branchName: string, repoPath: string): Promise<string | null>;
  getMergeBase(branch1: string, branch2: string, repoPath: string): Promise<string | null>;
  remove(branchName: string, repoPath: string, options?: { force?: boolean; log?: GitLogger }): Promise<void>;
  deleteLocal(repoPath: string, branchName: string, options?: { force?: boolean; log?: GitLogger }): Promise<boolean>;
  deleteRemote(repoPath: string, branchName: string, options?: { remote?: string; log?: GitLogger }): Promise<boolean>;
}

/**
 * Interface for git worktree operations.
 * 
 * @see src/git/core/worktrees.ts for the concrete implementation.
 */
export interface IGitWorktrees {
  create(options: WorktreeCreateOptions): Promise<void>;
  createWithTiming(options: WorktreeCreateOptions): Promise<CreateTiming>;
  createDetachedWithTiming(repoPath: string, worktreePath: string, commitish: string, log?: GitLogger, additionalSymlinkDirs?: string[]): Promise<CreateTiming & { baseCommit: string }>;
  createOrReuseDetached(repoPath: string, worktreePath: string, commitish: string, log?: GitLogger, additionalSymlinkDirs?: string[]): Promise<CreateTiming & { baseCommit: string; reused: boolean }>;
  remove(worktreePath: string, repoPath: string, log?: GitLogger): Promise<void>;
  removeSafe(repoPath: string, worktreePath: string, options?: { force?: boolean; log?: GitLogger }): Promise<boolean>;
  isValid(worktreePath: string): Promise<boolean>;
  getBranch(worktreePath: string): Promise<string | null>;
  getHeadCommit(worktreePath: string): Promise<string | null>;
  list(repoPath: string): Promise<Array<{ path: string; branch: string | null }>>;
  prune(repoPath: string): Promise<void>;
}

/**
 * Interface for git merge operations.
 * 
 * @see src/git/core/merge.ts for the concrete implementation.
 */
export interface IGitMerge {
  merge(options: MergeOptions): Promise<MergeResult>;
  mergeWithoutCheckout(options: MergeTreeOptions): Promise<MergeTreeResult>;
  commitTree(treeSha: string, parents: string[], message: string, repoPath: string, log?: GitLogger): Promise<string>;
  continueAfterResolve(cwd: string, message: string, log?: GitLogger): Promise<boolean>;
  abort(cwd: string, log?: GitLogger): Promise<void>;
  listConflicts(cwd: string): Promise<string[]>;
  isInProgress(cwd: string): Promise<boolean>;
}

/**
 * Interface for general git repository operations.
 * 
 * @see src/git/core/repository.ts for the concrete implementation.
 */
export interface IGitRepository {
  fetch(cwd: string, options?: { remote?: string; all?: boolean; tags?: boolean; log?: GitLogger }): Promise<void>;
  pull(cwd: string, log?: GitLogger): Promise<boolean>;
  push(cwd: string, options?: { remote?: string; branch?: string; force?: boolean; log?: GitLogger }): Promise<boolean>;
  stageAll(cwd: string, log?: GitLogger): Promise<void>;
  stageFile(cwd: string, filePath: string, log?: GitLogger): Promise<void>;
  commit(cwd: string, message: string, options?: { allowEmpty?: boolean; log?: GitLogger }): Promise<boolean>;
  hasChanges(cwd: string): Promise<boolean>;
  hasStagedChanges(cwd: string): Promise<boolean>;
  hasUncommittedChanges(cwd: string): Promise<boolean>;
  getHead(cwd: string): Promise<string | null>;
  resolveRef(ref: string, cwd: string): Promise<string>;
  getCommitLog(from: string, to: string, cwd: string): Promise<CommitInfo[]>;
  getCommitChanges(commitHash: string, cwd: string): Promise<FileChange[]>;
  getDiffStats(from: string, to: string, cwd: string): Promise<{ added: number; modified: number; deleted: number }>;
  getFileDiff(repoPath: string, filePath: string): Promise<string | null>;
  getStagedFileDiff(repoPath: string, filePath: string): Promise<string | null>;
  getFileChangesBetween(from: string, to: string, cwd: string): Promise<FileChange[]>;
  hasChangesBetween(from: string, to: string, repoPath: string): Promise<boolean>;
  getCommitCount(from: string, to: string, cwd: string): Promise<number>;
  getDirtyFiles(cwd: string): Promise<string[]>;
  checkoutFile(cwd: string, filePath: string, log?: GitLogger): Promise<void>;
  resetHard(cwd: string, ref: string, log?: GitLogger): Promise<void>;
  clean(cwd: string, log?: GitLogger): Promise<void>;
  updateRef(cwd: string, refName: string, commit: string, log?: GitLogger): Promise<void>;
  stashPush(cwd: string, message: string, log?: GitLogger): Promise<boolean>;
  stashPop(cwd: string, log?: GitLogger): Promise<boolean>;
  stashDrop(cwd: string, index?: number, log?: GitLogger): Promise<boolean>;
  stashList(cwd: string): Promise<string[]>;
  stashShowFiles(repoPath: string): Promise<string[]>;
  stashShowPatch(repoPath: string): Promise<string | null>;
}

/**
 * Interface for git gitignore operations.
 * 
 * @see src/git/core/gitignore.ts for the concrete implementation.
 */
export interface IGitGitignore {
  ensureGitignoreEntries(repoPath: string, entries?: string[], logger?: GitLogger): Promise<boolean>;
  isIgnored(repoPath: string, relativePath: string): Promise<boolean>;
  isOrchestratorGitIgnoreConfigured(workspaceRoot: string): Promise<boolean>;
  ensureOrchestratorGitIgnore(workspaceRoot: string): Promise<boolean>;
}

/**
 * Interface for git command execution.
 * 
 * @see src/git/core/executor.ts for the concrete implementation.
 */
export interface IGitExecutor {
  /**
   * Execute a git command asynchronously.
   */
  execAsync(args: string[], options: { cwd: string; log?: GitLogger; throwOnError?: boolean; errorPrefix?: string; timeoutMs?: number }): Promise<CommandResult>;

  /**
   * Execute a git command, returning stdout or throwing on failure.
   */
  execAsyncOrThrow(args: string[], cwd: string): Promise<string>;

  /**
   * Execute a git command, returning stdout or null on failure.
   */
  execAsyncOrNull(args: string[], cwd: string): Promise<string | null>;
}

/**
 * Unified interface for all git operations.
 * 
 * Groups the git API into logical sub-interfaces matching the
 * modular structure of the `src/git/` module.
 * 
 * @example
 * ```typescript
 * class PlanRunner {
 *   constructor(private readonly git: IGitOperations) {}
 *   
 *   async mergeBranch(source: string, target: string, cwd: string) {
 *     return this.git.merge.merge({ source, target, cwd });
 *   }
 * }
 * ```
 */
export interface IGitOperations {
  readonly branches: IGitBranches;
  readonly worktrees: IGitWorktrees;
  readonly merge: IGitMerge;
  readonly repository: IGitRepository;
  readonly gitignore: IGitGitignore;
}
