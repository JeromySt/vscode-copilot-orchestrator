/**
 * @fileoverview Default implementation of IGitOperations interface.
 * 
 * Provides a concrete implementation that delegates to the corresponding
 * functions in the git module's core submodules. Each sub-interface
 * maps directly to a core module in `src/git/core/`.
 * 
 * @module git/DefaultGitOperations
 */

import type {
  IGitOperations,
  IGitBranches,
  IGitWorktrees,
  IGitMerge,
  IGitRepository,
  IGitGitignore,
} from '../interfaces/IGitOperations';
import type {
  GitLogger,
  MergeResult,
  MergeOptions,
  MergeTreeResult,
  MergeTreeOptions,
  CommitInfo,
  FileChange,
  WorktreeCreateOptions,
} from './index';
import type { CreateTiming } from './core/worktrees';
import * as branches from './core/branches';
import * as worktrees from './core/worktrees';
import * as merge from './core/merge';
import * as repository from './core/repository';
import * as gitignore from './core/gitignore';

/**
 * Default implementation of IGitBranches that delegates to branches module.
 */
class DefaultGitBranches implements IGitBranches {
  async isDefaultBranch(branchName: string, repoPath: string): Promise<boolean> {
    return branches.isDefaultBranch(branchName, repoPath);
  }

  async exists(branchName: string, repoPath: string): Promise<boolean> {
    return branches.exists(branchName, repoPath);
  }

  async remoteExists(branchName: string, repoPath: string, remote?: string): Promise<boolean> {
    return branches.remoteExists(branchName, repoPath, remote);
  }

  async current(repoPath: string): Promise<string> {
    return branches.current(repoPath);
  }

  async currentOrNull(repoPath: string): Promise<string | null> {
    return branches.currentOrNull(repoPath);
  }

  async create(branchName: string, fromRef: string, repoPath: string, log?: GitLogger): Promise<void> {
    return branches.create(branchName, fromRef, repoPath, log);
  }

  async createOrReset(branchName: string, fromRef: string, repoPath: string, log?: GitLogger): Promise<void> {
    return branches.createOrReset(branchName, fromRef, repoPath, log);
  }

  async checkout(repoPath: string, branchName: string, log?: GitLogger): Promise<void> {
    return branches.checkout(repoPath, branchName, log);
  }

  async list(repoPath: string): Promise<string[]> {
    return branches.list(repoPath);
  }

  async getCommit(branchName: string, repoPath: string): Promise<string | null> {
    return branches.getCommit(branchName, repoPath);
  }

  async getMergeBase(branch1: string, branch2: string, repoPath: string): Promise<string | null> {
    return branches.getMergeBase(branch1, branch2, repoPath);
  }

  async remove(branchName: string, repoPath: string, options?: { force?: boolean; log?: GitLogger }): Promise<void> {
    return branches.remove(branchName, repoPath, options);
  }

  async deleteLocal(repoPath: string, branchName: string, options?: { force?: boolean; log?: GitLogger }): Promise<boolean> {
    return branches.deleteLocal(repoPath, branchName, options);
  }

  async deleteRemote(repoPath: string, branchName: string, options?: { remote?: string; log?: GitLogger }): Promise<boolean> {
    return branches.deleteRemote(repoPath, branchName, options);
  }
}

/**
 * Default implementation of IGitWorktrees that delegates to worktrees module.
 */
class DefaultGitWorktrees implements IGitWorktrees {
  async create(options: WorktreeCreateOptions): Promise<void> {
    return worktrees.create(options);
  }

  async createWithTiming(options: WorktreeCreateOptions): Promise<CreateTiming> {
    return worktrees.createWithTiming(options);
  }

  async createDetachedWithTiming(repoPath: string, worktreePath: string, commitish: string, log?: GitLogger, additionalSymlinkDirs?: string[]): Promise<CreateTiming & { baseCommit: string }> {
    return worktrees.createDetachedWithTiming(repoPath, worktreePath, commitish, log, additionalSymlinkDirs);
  }

  async createOrReuseDetached(repoPath: string, worktreePath: string, commitish: string, log?: GitLogger, additionalSymlinkDirs?: string[]): Promise<CreateTiming & { baseCommit: string; reused: boolean }> {
    return worktrees.createOrReuseDetached(repoPath, worktreePath, commitish, log, additionalSymlinkDirs);
  }

  async remove(worktreePath: string, repoPath: string, log?: GitLogger): Promise<void> {
    return worktrees.remove(worktreePath, repoPath, log);
  }

  async removeSafe(repoPath: string, worktreePath: string, options?: { force?: boolean; log?: GitLogger }): Promise<boolean> {
    return worktrees.removeSafe(repoPath, worktreePath, options);
  }

  async isValid(worktreePath: string): Promise<boolean> {
    return worktrees.isValid(worktreePath);
  }

  async getBranch(worktreePath: string): Promise<string | null> {
    return worktrees.getBranch(worktreePath);
  }

  async getHeadCommit(worktreePath: string): Promise<string | null> {
    return worktrees.getHeadCommit(worktreePath);
  }

  async list(repoPath: string): Promise<Array<{ path: string; branch: string | null }>> {
    return worktrees.list(repoPath);
  }

  async prune(repoPath: string): Promise<void> {
    return worktrees.prune(repoPath);
  }
}

/**
 * Default implementation of IGitMerge that delegates to merge module.
 */
class DefaultGitMerge implements IGitMerge {
  async merge(options: MergeOptions): Promise<MergeResult> {
    return merge.merge(options);
  }

  async mergeWithoutCheckout(options: MergeTreeOptions): Promise<MergeTreeResult> {
    return merge.mergeWithoutCheckout(options);
  }

  async commitTree(treeSha: string, parents: string[], message: string, repoPath: string, log?: GitLogger): Promise<string> {
    return merge.commitTree(treeSha, parents, message, repoPath, log);
  }

  async continueAfterResolve(cwd: string, message: string, log?: GitLogger): Promise<boolean> {
    return merge.continueAfterResolve(cwd, message, log);
  }

  async abort(cwd: string, log?: GitLogger): Promise<void> {
    return merge.abort(cwd, log);
  }

  async listConflicts(cwd: string): Promise<string[]> {
    return merge.listConflicts(cwd);
  }

  async isInProgress(cwd: string): Promise<boolean> {
    return merge.isInProgress(cwd);
  }
}

/**
 * Default implementation of IGitRepository that delegates to repository module.
 */
class DefaultGitRepository implements IGitRepository {
  async fetch(cwd: string, options?: { remote?: string; all?: boolean; tags?: boolean; log?: GitLogger }): Promise<void> {
    return repository.fetch(cwd, options);
  }

  async pull(cwd: string, log?: GitLogger): Promise<boolean> {
    return repository.pull(cwd, log);
  }

  async push(cwd: string, options?: { remote?: string; branch?: string; force?: boolean; log?: GitLogger }): Promise<boolean> {
    return repository.push(cwd, options);
  }

  async stageAll(cwd: string, log?: GitLogger): Promise<void> {
    return repository.stageAll(cwd, log);
  }

  async stageFile(cwd: string, filePath: string, log?: GitLogger): Promise<void> {
    return repository.stageFile(cwd, filePath, log);
  }

  async commit(cwd: string, message: string, options?: { allowEmpty?: boolean; log?: GitLogger }): Promise<boolean> {
    return repository.commit(cwd, message, options);
  }

  async hasChanges(cwd: string): Promise<boolean> {
    return repository.hasChanges(cwd);
  }

  async hasStagedChanges(cwd: string): Promise<boolean> {
    return repository.hasStagedChanges(cwd);
  }

  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    return repository.hasUncommittedChanges(cwd);
  }

  async getHead(cwd: string): Promise<string | null> {
    return repository.getHead(cwd);
  }

  async resolveRef(ref: string, cwd: string): Promise<string> {
    return repository.resolveRef(ref, cwd);
  }

  async getCommitLog(from: string, to: string, cwd: string): Promise<CommitInfo[]> {
    return repository.getCommitLog(from, to, cwd);
  }

  async getCommitChanges(commitHash: string, cwd: string): Promise<FileChange[]> {
    return repository.getCommitChanges(commitHash, cwd);
  }

  async getDiffStats(from: string, to: string, cwd: string): Promise<{ added: number; modified: number; deleted: number }> {
    return repository.getDiffStats(from, to, cwd);
  }

  async getFileDiff(repoPath: string, filePath: string): Promise<string | null> {
    return repository.getFileDiff(repoPath, filePath);
  }

  async getStagedFileDiff(repoPath: string, filePath: string): Promise<string | null> {
    return repository.getStagedFileDiff(repoPath, filePath);
  }

  async getFileChangesBetween(from: string, to: string, cwd: string): Promise<FileChange[]> {
    return repository.getFileChangesBetween(from, to, cwd);
  }

  async hasChangesBetween(from: string, to: string, repoPath: string): Promise<boolean> {
    return repository.hasChangesBetween(from, to, repoPath);
  }

  async getCommitCount(from: string, to: string, cwd: string): Promise<number> {
    return repository.getCommitCount(from, to, cwd);
  }

  async getDirtyFiles(cwd: string): Promise<string[]> {
    return repository.getDirtyFiles(cwd);
  }

  async checkoutFile(cwd: string, filePath: string, log?: GitLogger): Promise<void> {
    return repository.checkoutFile(cwd, filePath, log);
  }

  async resetHard(cwd: string, ref: string, log?: GitLogger): Promise<void> {
    return repository.resetHard(cwd, ref, log);
  }

  async clean(cwd: string, log?: GitLogger): Promise<void> {
    return repository.clean(cwd, log);
  }

  async updateRef(cwd: string, refName: string, commit: string, log?: GitLogger): Promise<void> {
    return repository.updateRef(cwd, refName, commit, log);
  }

  async stashPush(cwd: string, message: string, log?: GitLogger): Promise<boolean> {
    return repository.stashPush(cwd, message, log);
  }

  async stashPop(cwd: string, log?: GitLogger): Promise<boolean> {
    return repository.stashPop(cwd, log);
  }

  async stashDrop(cwd: string, index?: number, log?: GitLogger): Promise<boolean> {
    return repository.stashDrop(cwd, index, log);
  }

  async stashList(cwd: string): Promise<string[]> {
    return repository.stashList(cwd);
  }

  async stashShowFiles(repoPath: string): Promise<string[]> {
    return repository.stashShowFiles(repoPath);
  }

  async stashShowPatch(repoPath: string): Promise<string | null> {
    return repository.stashShowPatch(repoPath);
  }
}

/**
 * Default implementation of IGitGitignore that delegates to gitignore module.
 */
class DefaultGitGitignore implements IGitGitignore {
  async ensureGitignoreEntries(repoPath: string, entries?: string[], logger?: GitLogger): Promise<boolean> {
    return gitignore.ensureGitignoreEntries(repoPath, entries, logger);
  }

  async isIgnored(repoPath: string, relativePath: string): Promise<boolean> {
    return gitignore.isIgnored(repoPath, relativePath);
  }

  async isOrchestratorGitIgnoreConfigured(workspaceRoot: string): Promise<boolean> {
    return gitignore.isOrchestratorGitIgnoreConfigured(workspaceRoot);
  }

  async ensureOrchestratorGitIgnore(workspaceRoot: string): Promise<boolean> {
    return gitignore.ensureOrchestratorGitIgnore(workspaceRoot);
  }

  isDiffOnlyOrchestratorChanges(diff: string): boolean {
    return gitignore.isDiffOnlyOrchestratorChanges(diff);
  }
}

/**
 * Default implementation of IGitOperations.
 * 
 * Provides concrete implementations for all git operations by delegating
 * to the appropriate core modules. This is the main implementation that
 * should be used in production.
 */
export class DefaultGitOperations implements IGitOperations {
  public readonly branches = new DefaultGitBranches();
  public readonly worktrees = new DefaultGitWorktrees();
  public readonly merge = new DefaultGitMerge();
  public readonly repository = new DefaultGitRepository();
  public readonly gitignore = new DefaultGitGitignore();
}