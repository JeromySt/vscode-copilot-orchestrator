/**
 * @fileoverview Snapshot Postchecks Phase Executor
 *
 * Custom postchecks for the snapshot-validation node. Re-checks targetBranch
 * health after verify-ri work completes, before merge-ri to targetBranch:
 *
 * - Clean, same commit as rebased-to → proceed to merge-ri
 * - Clean, new commit (target moved during verify) → auto-retry from prechecks
 * - Dirty → force-fail (non-auto-healable)
 *
 * @module plan/phases/snapshotPostcheckPhase
 */

import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { SnapshotInfo } from './snapshotManager';

export interface SnapshotPostcheckDeps {
  git: IGitOperations;
}

export class SnapshotPostcheckPhaseExecutor {
  private readonly git: IGitOperations;

  constructor(deps: SnapshotPostcheckDeps) {
    this.git = deps.git;
  }

  /**
   * Execute snapshot postchecks.
   *
   * @param ctx - Phase context
   * @param snapshot - Current snapshot info (baseCommit reflects last rebase target)
   */
  async execute(
    ctx: PhaseContext,
    snapshot: SnapshotInfo,
    targetBranch: string,
    repoPath: string,
  ): Promise<PhaseResult> {
    ctx.logInfo('Re-checking targetBranch before merge-ri...');

    try {
      const currentHead = await this.git.repository.resolveRef(targetBranch, repoPath);
      const isDirty = await this.git.repository.hasUncommittedChanges(repoPath);

      if (isDirty) {
        ctx.logError(`Target branch '${targetBranch}' has uncommitted changes. Cannot merge.`);
        return {
          success: false,
          error: `Target branch '${targetBranch}' has uncommitted changes.`,
          noAutoHeal: true,
          failureMessage: `Target branch '${targetBranch}' has uncommitted changes. Please commit or stash your changes, then retry.`,
          overrideResumeFromPhase: 'prechecks',
        };
      }

      // Same commit we rebased to — safe to proceed
      if (currentHead === snapshot.baseCommit) {
        ctx.logInfo('Target branch unchanged since prechecks. Proceeding to merge-ri.');
        return { success: true };
      }

      // Target moved during verify-ri — need to re-rebase and re-verify
      ctx.logInfo(`Target branch '${targetBranch}' advanced during verification (${snapshot.baseCommit.slice(0, 8)} → ${currentHead.slice(0, 8)}). Will retry from prechecks.`);
      return {
        success: false,
        error: `Target branch '${targetBranch}' advanced during verification. Retrying from prechecks.`,
        // Allow auto-heal (this is a transient condition, not user error)
        noAutoHeal: false,
        overrideResumeFromPhase: 'prechecks',
      };

    } catch (err: any) {
      ctx.logError(`Postchecks error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
