/**
 * @fileoverview Snapshot Branch Manager
 *
 * Manages a per-plan **snapshot branch + worktree** that accumulates all
 * leaf-node RI merges before a single final merge back into `targetBranch`.
 *
 * ## Why a snapshot?
 *
 * Merging each leaf directly into `targetBranch` during plan execution is
 * problematic:
 *
 * 1. Moving the ref while the user has it checked out causes working-tree
 *    desync — any "convenience" reset/stash-pop cycle can silently destroy
 *    pending user work.
 * 2. Each leaf merge can conflict with the next, creating cascading failures
 *    that are difficult to roll back.
 *
 * By isolating all merges into a snapshot branch (with its own real worktree),
 * we keep `targetBranch` completely untouched until a single, validated final
 * merge at the end.
 *
 * ## Lifecycle
 *
 * ```
 * createSnapshot()          → branch + worktree created off targetBranch HEAD
 * [leaf RI merges happen]   → merge into snapshot branch, verify-ri in worktree
 * rebaseOnTarget()          → rebase snapshot onto current targetBranch HEAD
 * [final merge]             → merge-tree snapshot → targetBranch
 * cleanupSnapshot()         → remove worktree + delete branch
 * ```
 *
 * @module plan/phases/snapshotManager
 */

import * as path from 'path';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import { execAsync } from '../../git/core/executor';

/** Metadata stored in the plan for the active snapshot. */
export interface SnapshotInfo {
  /** The snapshot branch name, e.g. `orchestrator/snapshot/<planId>`. */
  branch: string;

  /** Absolute path to the snapshot worktree on disk. */
  worktreePath: string;

  /** Commit SHA that the snapshot was originally branched from. */
  baseCommit: string;
}

export class SnapshotManager {
  constructor(private readonly git: IGitOperations) {}

  /**
   * Create a snapshot branch and worktree off the current HEAD of
   * `targetBranch`.
   *
   * @returns Metadata about the new snapshot (branch name, worktree path,
   *          base commit).
   */
  async createSnapshot(
    planId: string,
    targetBranch: string,
    repoPath: string,
    worktreeRoot: string,
    log?: (s: string) => void,
    additionalSymlinkDirs?: string[],
  ): Promise<SnapshotInfo> {
    const branch = `orchestrator/snapshot/${planId}`;
    const worktreePath = path.join(worktreeRoot, `_snapshot-${planId.slice(0, 8)}`);

    // Resolve the current HEAD of targetBranch — this is our "base".
    const baseCommit = await this.git.repository.resolveRef(targetBranch, repoPath);

    log?.(`Creating snapshot branch ${branch} from ${targetBranch} (${baseCommit.slice(0, 8)})`);

    // Create the branch at the base commit.
    await this.git.branches.create(branch, baseCommit, repoPath, log);

    // Create a real worktree checked out on the snapshot branch.
    // We use createDetachedWithTiming then checkout the branch inside it
    // because the worktree API only supports detached HEAD creation.
    await this.git.worktrees.createDetachedWithTiming(
      repoPath,
      worktreePath,
      baseCommit,
      log,
      additionalSymlinkDirs,
    );

    // Attach the worktree to the snapshot branch so commits advance it.
    await execAsync(['checkout', branch], { cwd: worktreePath });

    log?.(`Snapshot worktree ready at ${worktreePath}`);

    return { branch, worktreePath, baseCommit };
  }

  /**
   * Rebase the snapshot branch onto the current HEAD of `targetBranch`.
   *
   * This is needed when `targetBranch` has advanced (e.g. external pushes)
   * since the snapshot was created.
   *
   * @returns `true` if the rebase succeeded (or was a no-op), `false` if
   *          it failed and was aborted.
   */
  async rebaseOnTarget(
    snapshot: SnapshotInfo,
    targetBranch: string,
    repoPath: string,
    log?: (s: string) => void,
  ): Promise<boolean> {
    const currentTarget = await this.git.repository.resolveRef(targetBranch, repoPath);

    if (currentTarget === snapshot.baseCommit) {
      log?.('Target branch has not moved — rebase not needed');
      return true;
    }

    log?.(`Rebasing snapshot onto ${targetBranch} (${currentTarget.slice(0, 8)})...`);

    const result = await execAsync(
      ['rebase', '--onto', currentTarget, snapshot.baseCommit, snapshot.branch],
      { cwd: repoPath },
    );

    if (!result.success) {
      log?.(`Rebase failed: ${result.stderr}`);
      // Abort the failed rebase to leave the repo in a clean state.
      await execAsync(['rebase', '--abort'], { cwd: repoPath }).catch(() => {});
      return false;
    }

    // Update the stored base commit so subsequent rebases are incremental.
    snapshot.baseCommit = currentTarget;
    log?.('Rebase succeeded');
    return true;
  }

  /**
   * Clean up the snapshot worktree and branch.
   *
   * Safe to call multiple times — silently ignores "already removed" errors.
   */
  async cleanupSnapshot(
    snapshot: SnapshotInfo,
    repoPath: string,
    log?: (s: string) => void,
  ): Promise<void> {
    // Remove the worktree first (git won't delete a branch with a worktree).
    try {
      await this.git.worktrees.removeSafe(repoPath, snapshot.worktreePath, {
        force: true,
        log,
      });
      log?.('Snapshot worktree removed');
    } catch (err: any) {
      log?.(`Warning: failed to remove snapshot worktree: ${err.message}`);
    }

    // Delete the branch.
    try {
      await this.git.branches.deleteLocal(repoPath, snapshot.branch, { force: true, log });
      log?.(`Snapshot branch ${snapshot.branch} deleted`);
    } catch (err: any) {
      log?.(`Warning: failed to delete snapshot branch: ${err.message}`);
    }
  }

  /**
   * Check whether a snapshot worktree still exists and is valid.
   */
  async isSnapshotValid(snapshot: SnapshotInfo): Promise<boolean> {
    try {
      return await this.git.worktrees.isValid(snapshot.worktreePath);
    } catch {
      return false;
    }
  }
}
