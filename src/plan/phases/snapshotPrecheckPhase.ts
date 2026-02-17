/**
 * @fileoverview Snapshot Prechecks Phase Executor
 *
 * Custom prechecks for the snapshot-validation node. Checks targetBranch
 * health before running verify-ri:
 *
 * - Clean, same commit as snapshot base → proceed
 * - Clean, ahead → rebase snapshot worktree onto new targetBranch HEAD
 * - Dirty AND/OR ahead with uncommitted changes → force-fail (non-auto-healable)
 *
 * @module plan/phases/snapshotPrecheckPhase
 */

import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { SnapshotInfo } from './snapshotManager';
import { SnapshotManager } from './snapshotManager';

export interface SnapshotPrecheckDeps {
  git: IGitOperations;
}

export class SnapshotPrecheckPhaseExecutor {
  private readonly git: IGitOperations;
  private readonly snapshotManager: SnapshotManager;

  constructor(deps: SnapshotPrecheckDeps) {
    this.git = deps.git;
    this.snapshotManager = new SnapshotManager(deps.git);
  }

  /**
   * Execute snapshot prechecks.
   *
   * @param ctx - Phase context (must have repoPath and targetBranch set)
   * @param snapshot - Current snapshot info (mutated: baseCommit updated on rebase)
   */
  async execute(
    ctx: PhaseContext,
    snapshot: SnapshotInfo,
    targetBranch: string,
    repoPath: string,
  ): Promise<PhaseResult> {
    ctx.logInfo('Checking targetBranch health before merge...');

    try {
      // Resolve current targetBranch HEAD
      const currentHead = await this.git.repository.resolveRef(targetBranch, repoPath);

      // Check if targetBranch has uncommitted changes
      const isDirty = await this.git.repository.hasUncommittedChanges(repoPath);

      if (isDirty) {
        ctx.logError(`Target branch '${targetBranch}' has uncommitted changes. Cannot proceed with merge.`);
        return {
          success: false,
          error: `Target branch '${targetBranch}' has uncommitted changes. Clean up before retrying.`,
          noAutoHeal: true,
          failureMessage: `Target branch '${targetBranch}' has uncommitted changes. Please commit or stash your changes, then retry the node.`,
          overrideResumeFromPhase: 'prechecks',
        };
      }

      // Same commit — no rebase needed
      if (currentHead === snapshot.baseCommit) {
        ctx.logInfo(`Target branch '${targetBranch}' is clean and unchanged. Proceeding.`);
        return { success: true };
      }

      // Clean but ahead — rebase snapshot onto new target HEAD
      ctx.logInfo(`Target branch '${targetBranch}' has advanced (${snapshot.baseCommit.slice(0, 8)} → ${currentHead.slice(0, 8)}). Rebasing snapshot...`);

      const rebaseOk = await this.snapshotManager.rebaseOnTarget(
        snapshot,
        targetBranch,
        repoPath,
        ctx.logInfo.bind(ctx),
      );

      if (!rebaseOk) {
        ctx.logError('Snapshot rebase failed — conflicts detected.');
        return {
          success: false,
          error: `Snapshot rebase onto '${targetBranch}' failed due to conflicts. Manual resolution required.`,
          noAutoHeal: true,
          failureMessage: `Could not rebase snapshot onto '${targetBranch}' — merge conflicts detected. Resolve conflicts on targetBranch, then retry.`,
          overrideResumeFromPhase: 'prechecks',
        };
      }

      ctx.logInfo(`Snapshot rebased successfully onto ${currentHead.slice(0, 8)}.`);
      return { success: true };

    } catch (err: any) {
      ctx.logError(`Prechecks error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
