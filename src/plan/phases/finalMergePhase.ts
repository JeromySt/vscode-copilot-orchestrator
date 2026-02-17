/**
 * @fileoverview Final Merge Phase
 *
 * Triggered after ALL leaf nodes have completed their merge-ri + verify-ri
 * into the snapshot branch.  Performs a single validated merge from the
 * snapshot branch into `targetBranch`.
 *
 * ## Flow
 *
 * 1. Rebase the snapshot branch onto the current `targetBranch` HEAD (in
 *    case the target moved forward during execution).
 * 2. Run verify-ri on the rebased snapshot (validates accumulated changes).
 * 3. In-memory merge-tree: snapshot → targetBranch.
 * 4. Run verify-ri on the final merged targetBranch.
 * 5. On failure — retry once (re-snapshot, rebase, verify, merge).
 *    After 2 failures, the plan is left in `awaiting-final-merge` state
 *    for the user to trigger manually via UI button.
 *
 * @module plan/phases/finalMergePhase
 */

import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { PlanInstance } from '../types/plan';
import { SnapshotManager, type SnapshotInfo } from './snapshotManager';

export interface FinalMergeResult {
  success: boolean;
  error?: string;
  /** Number of attempts used (1 or 2) */
  attempts: number;
}

export interface FinalMergeDeps {
  git: IGitOperations;
  log: (s: string) => void;
  /** Optional callback to run verify-ri on a given branch. */
  runVerifyRi?: (targetBranch: string, worktreePath?: string) => Promise<{ success: boolean; error?: string }>;
}

const MAX_FINAL_MERGE_ATTEMPTS = 2;

export class FinalMergeExecutor {
  private readonly git: IGitOperations;
  private readonly snapshotMgr: SnapshotManager;
  private readonly log: (s: string) => void;
  private readonly runVerifyRi?: FinalMergeDeps['runVerifyRi'];

  constructor(deps: FinalMergeDeps) {
    this.git = deps.git;
    this.snapshotMgr = new SnapshotManager(deps.git);
    this.log = deps.log;
    this.runVerifyRi = deps.runVerifyRi;
  }

  /**
   * Execute the final merge: snapshot → targetBranch.
   *
   * Retries up to {@link MAX_FINAL_MERGE_ATTEMPTS} times on failure.
   */
  async execute(plan: PlanInstance): Promise<FinalMergeResult> {
    const { targetBranch, repoPath, snapshot } = plan;
    if (!targetBranch || !snapshot) {
      return { success: true, attempts: 0 }; // No target or no snapshot — nothing to do
    }

    this.log('========== FINAL MERGE START ==========');

    for (let attempt = 1; attempt <= MAX_FINAL_MERGE_ATTEMPTS; attempt++) {
      this.log(`Final merge attempt ${attempt}/${MAX_FINAL_MERGE_ATTEMPTS}`);

      const result = await this.attemptFinalMerge(plan, snapshot, targetBranch, repoPath);
      if (result.success) {
        this.log('========== FINAL MERGE END (SUCCESS) ==========');
        return { success: true, attempts: attempt };
      }

      this.log(`Attempt ${attempt} failed: ${result.error}`);

      if (attempt < MAX_FINAL_MERGE_ATTEMPTS) {
        this.log('Retrying...');
      }
    }

    this.log('========== FINAL MERGE END (FAILED — awaiting user action) ==========');
    return {
      success: false,
      error: `Final merge failed after ${MAX_FINAL_MERGE_ATTEMPTS} attempts. Use the "Complete RI Merge" button to retry.`,
      attempts: MAX_FINAL_MERGE_ATTEMPTS,
    };
  }

  private async attemptFinalMerge(
    plan: PlanInstance,
    snapshot: SnapshotInfo,
    targetBranch: string,
    repoPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Step 1: Rebase snapshot onto current targetBranch HEAD
    const rebased = await this.snapshotMgr.rebaseOnTarget(
      snapshot, targetBranch, repoPath, this.log,
    );
    if (!rebased) {
      return { success: false, error: 'Rebase of snapshot onto target branch failed' };
    }

    // Step 2: Run verify-ri on the rebased snapshot (if configured)
    if (this.runVerifyRi) {
      this.log('Running verify-ri on rebased snapshot...');
      const vr = await this.runVerifyRi(snapshot.branch, snapshot.worktreePath);
      if (!vr.success) {
        return { success: false, error: `Pre-merge verify-ri failed: ${vr.error}` };
      }
      this.log('✓ Pre-merge verify-ri passed');
    }

    // Step 3: In-memory merge-tree: snapshot → targetBranch
    const snapshotSha = await this.git.repository.resolveRef(snapshot.branch, repoPath);
    const targetSha = await this.git.repository.resolveRef(targetBranch, repoPath);

    this.log(`Merging snapshot (${snapshotSha.slice(0, 8)}) into ${targetBranch} (${targetSha.slice(0, 8)})...`);

    const mergeResult = await this.git.merge.mergeWithoutCheckout({
      source: snapshotSha,
      target: targetBranch,
      repoPath,
      log: this.log,
    });

    if (!mergeResult.success || !mergeResult.treeSha) {
      if (mergeResult.hasConflicts) {
        return { success: false, error: `Final merge has conflicts: ${mergeResult.conflictFiles?.join(', ')}` };
      }
      return { success: false, error: `Merge-tree failed: ${mergeResult.error}` };
    }

    // Create the merge commit (two parents: targetBranch + snapshot)
    const commitMessage = `Plan ${plan.spec.name}: final merge from snapshot`;
    const newCommit = await this.git.merge.commitTree(
      mergeResult.treeSha,
      [targetSha, snapshotSha],
      commitMessage,
      repoPath,
      this.log,
    );

    this.log(`Created final merge commit: ${newCommit.slice(0, 8)}`);

    // Step 4: Update targetBranch ref (safe — no working tree modification)
    // Check dirty state BEFORE moving the ref.
    let branchCheckedOut = false;
    let wasDirtyBefore = true;
    try {
      const currentBranch = await this.git.branches.currentOrNull(repoPath);
      branchCheckedOut = currentBranch === targetBranch;
      if (branchCheckedOut) {
        wasDirtyBefore = await this.git.repository.hasUncommittedChanges(repoPath);
      }
    } catch { /* default to dirty for safety */ }

    await this.git.repository.updateRef(repoPath, `refs/heads/${targetBranch}`, newCommit);
    this.log(`Updated ${targetBranch} to ${newCommit.slice(0, 8)}`);

    // Safe sync: only reset if working tree was clean before ref move.
    if (branchCheckedOut && !wasDirtyBefore) {
      try {
        await this.git.repository.resetHard(repoPath, 'HEAD', this.log);
        this.log(`Synced working tree to ${newCommit.slice(0, 8)}`);
      } catch (err: any) {
        this.log(`⚠ Could not sync working tree: ${err.message}`);
      }
    } else if (branchCheckedOut) {
      this.log(`ℹ Your checkout on ${targetBranch} has uncommitted changes. Run 'git reset --hard HEAD' after saving your work.`);
    }

    // Step 5: Run verify-ri on the final merged targetBranch (if configured)
    if (this.runVerifyRi) {
      this.log('Running verify-ri on merged target branch...');
      const vr = await this.runVerifyRi(targetBranch);
      if (!vr.success) {
        return { success: false, error: `Post-merge verify-ri failed: ${vr.error}` };
      }
      this.log('✓ Post-merge verify-ri passed');
    }

    return { success: true };
  }
}
