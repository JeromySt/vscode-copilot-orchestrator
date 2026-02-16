/**
 * @fileoverview Reverse Integration (RI) Merge Phase Executor
 * 
 * Handles merging leaf node changes back to the target branch.
 * This implements the "reverse integration" pattern where completed work
 * from a worktree is merged back to the main target branch.
 * 
 * ## Safety guarantees
 * 
 * - **Never touches the user's working directory.** All merges happen
 *   either via `git merge-tree --write-tree` (in-memory) or inside an
 *   ephemeral detached worktree that is removed after the merge.
 * - **Never stashes user changes.** The stash/pop pattern is inherently
 *   dangerous because it mixes user state with orchestrator state.
 * - **Validates the merged tree.** After every RI merge, the file count
 *   of the result is compared to the source. If the result has
 *   significantly fewer files, the merge is aborted.
 * 
 * @module plan/phases/mergeRiPhase
 */

import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { CopilotUsageMetrics } from '../types';
import { resolveMergeConflictWithCopilot } from './mergeHelper';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';

/** Minimum ratio of (result files / richer parent files) below which we abort. */
const TREE_VALIDATION_MIN_RATIO = 0.8;

/**
 * Executor for the reverse integration merge phase.
 * 
 * Merges completed leaf node changes back to the target branch.
 * Uses merge-tree for conflict detection and Copilot CLI for resolution.
 */
export class MergeRiPhaseExecutor implements IPhaseExecutor {
  private configManager?: any;
  private git: IGitOperations;
  private copilotRunner: ICopilotRunner;
  
  constructor(deps: { configManager?: any; git: IGitOperations; copilotRunner: ICopilotRunner }) {
    this.configManager = deps.configManager;
    this.git = deps.git;
    this.copilotRunner = deps.copilotRunner;
  }
  
  async execute(context: PhaseContext): Promise<PhaseResult> {
    const { 
      node, 
      repoPath, 
      targetBranch, 
      baseCommitAtStart, 
      completedCommit, 
    } = context;
    
    // Validate required parameters
    if (!repoPath) {
      return { success: false, error: 'repoPath is required for reverse integration merge' };
    }
    if (!targetBranch) {
      return { success: false, error: 'targetBranch is required for reverse integration merge' };
    }
    if (!completedCommit) {
      context.logInfo('========== REVERSE INTEGRATION MERGE START ==========');
      context.logInfo('No completed commit — skipping RI merge (expects_no_changes or validation-only node)');
      context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
      return { success: true };
    }
    if (!baseCommitAtStart) {
      return { success: false, error: 'baseCommitAtStart is required for reverse integration merge' };
    }
    
    context.logInfo('========== REVERSE INTEGRATION MERGE START ==========');
    
    const mergeSource = completedCommit;
    const diffBase = baseCommitAtStart;
    try {
      const hasDiff = await this.git.repository.hasChangesBetween(diffBase, mergeSource, repoPath);
      
      if (!hasDiff) {
        context.logInfo(`No changes detected (diff ${diffBase.slice(0, 8)}..${mergeSource.slice(0, 8)} is empty)`);
        context.logInfo('==========================================');
        return { success: true };
      }
      
      context.logInfo(`Merging ${mergeSource.slice(0, 8)} to ${targetBranch} (diff from ${diffBase.slice(0, 8)} detected changes)`);
      
      // Use git merge-tree for conflict-free merge detection
      context.logInfo('Using git merge-tree for conflict-free merge...');
      const mergeTreeResult = await this.git.merge.mergeWithoutCheckout({
        source: mergeSource,
        target: targetBranch,
        repoPath,
        log: s => context.logInfo(s)
      });
      
      if (mergeTreeResult.success && mergeTreeResult.treeSha) {
        context.logInfo('✓ No conflicts detected');
        
        const targetSha = await this.git.repository.resolveRef(targetBranch, repoPath);
        const commitMessage = `Plan ${node.name}: merge ${node.name} (commit ${mergeSource.slice(0, 8)})`;
        
        const newCommit = await this.git.merge.commitTree(
          mergeTreeResult.treeSha,
          [targetSha],
          commitMessage,
          repoPath,
          s => context.logInfo(s)
        );
        
        context.logInfo(`Created merge commit: ${newCommit.slice(0, 8)}`);
        
        // Validate the merged tree before updating the branch
        const validationError = await this.validateMergedTree(
          context, repoPath, newCommit, mergeSource, targetSha
        );
        if (validationError) {
          context.logError(validationError);
          context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
          return { success: false, error: validationError };
        }
        
        // Update the target branch to point to the new commit
        const branchUpdated = await this.updateBranchRef(context, repoPath, targetBranch, newCommit);
        if (branchUpdated) {
          context.logInfo(`Updated ${targetBranch} to ${newCommit.slice(0, 8)}`);
        } else {
          context.logInfo(`⚠ Merge commit ${newCommit.slice(0, 8)} created but branch not auto-updated`);
          context.logInfo(`  Run 'git reset --hard ${newCommit.slice(0, 8)}' to update your local ${targetBranch}`);
        }
        
        // Push if configured
        await this.pushIfConfigured(context, repoPath, targetBranch);
        
        context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
        return { success: true };
      }
      
      // =========================================================================
      // CONFLICT: Resolve in an ephemeral worktree (never touch user's checkout)
      // =========================================================================
      if (mergeTreeResult.hasConflicts) {
        context.logInfo('⚠ Merge has conflicts');
        context.logInfo(`  Conflicts: ${mergeTreeResult.conflictFiles?.join(', ')}`);
        context.logInfo('  Resolving in ephemeral worktree (user checkout untouched)...');
        
        const resolved = await this.mergeInEphemeralWorktree(
          context,
          repoPath,
          mergeSource,
          targetBranch,
          `Plan ${node.name}: merge ${node.name} (commit ${mergeSource.slice(0, 8)})`,
          mergeTreeResult.conflictFiles || []
        );
        
        if (resolved.success) {
          context.logInfo('✓ Conflict resolved in ephemeral worktree');
          context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
          return { success: true, metrics: resolved.metrics };
        } else {
          context.logError(`✗ Conflict resolution failed: ${resolved.error}`);
          context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
          return { success: false, error: resolved.error || 'Failed to resolve merge conflicts', metrics: resolved.metrics };
        }
      }
      
      context.logError(`✗ Merge-tree failed: ${mergeTreeResult.error}`);
      context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
      return { success: false, error: `Merge-tree failed: ${mergeTreeResult.error}` };
      
    } catch (error: any) {
      context.logError(`✗ Exception: ${error.message}`);
      context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
      return { success: false, error: `Reverse integration merge failed: ${error.message}` };
    }
  }
  
  /**
   * Update branch reference to point to new commit.
   */
  private async updateBranchRef(
    context: PhaseContext,
    repoPath: string,
    targetBranch: string,
    newCommit: string
  ): Promise<boolean> {
    try {
      await this.git.repository.updateRef(repoPath, `refs/heads/${targetBranch}`, newCommit);
      return true;
    } catch (error: any) {
      context.logError(`Failed to update branch ${targetBranch}: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Resolve merge conflicts in an ephemeral worktree.
   * 
   * This approach NEVER touches the user's main working directory:
   * 1. Create a temporary detached worktree at the target branch commit
   * 2. Run `git merge <source> --no-commit` inside the worktree
   * 3. Use Copilot CLI to resolve conflicts inside the worktree
   * 4. Read the resulting commit SHA
   * 5. Validate the merged tree
   * 6. Update the target branch ref in the main repo
   * 7. Remove the ephemeral worktree
   */
  private async mergeInEphemeralWorktree(
    context: PhaseContext,
    repoPath: string,
    sourceCommit: string,
    targetBranch: string,
    commitMessage: string,
    conflictFiles: string[]
  ): Promise<{ success: boolean; error?: string; metrics?: CopilotUsageMetrics }> {
    const targetSha = await this.git.repository.resolveRef(targetBranch, repoPath);
    const worktreeName = `ri-merge-${Date.now()}`;
    // Place the ephemeral worktree inside the plan's worktree root (already gitignored)
    const worktreePath = path.join(repoPath, '.worktrees', worktreeName);
    
    context.logInfo(`Creating ephemeral worktree at ${worktreePath}`);
    
    try {
      // Step 1: Create detached worktree at target branch commit
      await this.git.worktrees.createDetachedWithTiming(
        repoPath, worktreePath, targetSha,
        s => context.logInfo(s)
      );
      
      // Step 2: Perform merge in the worktree (will have conflicts)
      context.logInfo(`Merging ${sourceCommit.slice(0, 8)} in ephemeral worktree...`);
      await this.git.merge.merge({
        source: sourceCommit,
        target: 'HEAD',
        cwd: worktreePath,
        noCommit: true,
        log: s => context.logInfo(s)
      }).catch(() => {
        // Expected to fail due to conflicts
      });
      
      // List conflicts in the worktree
      const worktreeConflicts = await this.git.merge.listConflicts(worktreePath).catch(() => conflictFiles);
      
      // Step 3: Use Copilot CLI to resolve conflicts in the worktree
      context.logInfo(`Invoking Copilot CLI to resolve ${worktreeConflicts.length} conflict(s)...`);
      const cliResult = await resolveMergeConflictWithCopilot(
        context,
        worktreePath,
        sourceCommit,
        targetBranch,
        commitMessage,
        this.copilotRunner,
        worktreeConflicts,
        this.configManager
      );
      
      if (!cliResult.success) {
        return { success: false, error: 'Copilot CLI failed to resolve conflicts', metrics: cliResult.metrics };
      }
      
      context.logInfo('Copilot CLI resolved conflicts');
      
      // Step 4: Get the resulting commit from the worktree
      const resultCommit = await this.git.worktrees.getHeadCommit(worktreePath);
      if (!resultCommit) {
        return { success: false, error: 'No commit found in worktree after conflict resolution' };
      }
      
      context.logInfo(`Worktree merge commit: ${resultCommit.slice(0, 8)}`);
      
      // Step 5: Validate the merged tree
      const validationError = await this.validateMergedTree(
        context, repoPath, resultCommit, sourceCommit, targetSha
      );
      if (validationError) {
        return { success: false, error: validationError };
      }
      
      // Step 6: Update the target branch ref
      const branchUpdated = await this.updateBranchRef(context, repoPath, targetBranch, resultCommit);
      if (branchUpdated) {
        context.logInfo(`Updated ${targetBranch} to ${resultCommit.slice(0, 8)}`);
      } else {
        context.logInfo(`⚠ Merge commit exists but branch not updated — run 'git reset --hard ${resultCommit.slice(0, 8)}'`);
      }
      
      // Push if configured
      await this.pushIfConfigured(context, repoPath, targetBranch);
      
      return { success: true, metrics: cliResult.metrics };
      
    } catch (error: any) {
      context.logError(`Ephemeral worktree merge failed: ${error.message}`);
      
      // Abort any ongoing merge in the worktree
      try {
        await this.git.merge.abort(worktreePath, s => context.logInfo(s));
      } catch { /* ignore */ }
      
      return { success: false, error: `Merge in ephemeral worktree failed: ${error.message}` };
    } finally {
      // Always clean up the ephemeral worktree
      try {
        await this.git.worktrees.removeSafe(repoPath, worktreePath, {
          force: true,
          log: s => context.logInfo(s)
        });
        context.logInfo('Cleaned up ephemeral worktree');
      } catch (cleanupErr: any) {
        context.logInfo(`Warning: failed to remove ephemeral worktree: ${cleanupErr.message}`);
      }
    }
  }
  
  /**
   * Validate the merged tree hasn't lost a significant number of files.
   * 
   * Compares the file count of the merge result against the richer parent
   * (source or target). If the result has < 80% of the richer parent's
   * files, it's flagged as suspicious — likely a bad merge (e.g., stash-pop
   * deletion was treated as intentional).
   * 
   * @returns Error message if validation fails, undefined if OK.
   */
  private async validateMergedTree(
    context: PhaseContext,
    repoPath: string,
    resultCommit: string,
    sourceCommit: string,
    targetCommit: string,
  ): Promise<string | undefined> {
    try {
      const [resultCount, sourceCount, targetCount] = await Promise.all([
        this.countTreeFiles(repoPath, resultCommit),
        this.countTreeFiles(repoPath, sourceCommit),
        this.countTreeFiles(repoPath, targetCommit),
      ]);
      
      const richerCount = Math.max(sourceCount, targetCount);
      const ratio = richerCount > 0 ? resultCount / richerCount : 1;
      
      context.logInfo(`Tree validation: result=${resultCount} files, source=${sourceCount}, target=${targetCount}, ratio=${ratio.toFixed(2)}`);
      
      if (ratio < TREE_VALIDATION_MIN_RATIO && richerCount > 10) {
        return `ABORTED: Merged tree has ${resultCount} files but richer parent has ${richerCount} files ` +
          `(ratio ${ratio.toFixed(2)} < ${TREE_VALIDATION_MIN_RATIO}). This likely indicates a destructive merge. ` +
          `The merge commit was NOT applied to the target branch.`;
      }
    } catch (err: any) {
      context.logInfo(`Tree validation skipped (non-fatal): ${err.message}`);
    }
    return undefined;
  }
  
  /**
   * Count the number of files (blobs) in a commit's tree.
   */
  private async countTreeFiles(repoPath: string, commitish: string): Promise<number> {
    try {
      const { execAsync } = await import('../../git/core/executor');
      const lsResult = await execAsync(
        ['ls-tree', '-r', '--name-only', commitish],
        { cwd: repoPath }
      );
      if (!lsResult.success) { return 0; }
      const lines = lsResult.stdout.trim().split('\n').filter(Boolean);
      return lines.length;
    } catch {
      return 0;
    }
  }
  
  /**
   * Push the target branch if the pushOnSuccess setting is enabled.
   */
  private async pushIfConfigured(
    context: PhaseContext,
    repoPath: string,
    targetBranch: string
  ): Promise<void> {
    const pushOnSuccess = this.configManager?.getConfig('copilotOrchestrator.merge', 'pushOnSuccess', false) ?? false;
    if (pushOnSuccess) {
      try {
        context.logInfo(`Pushing ${targetBranch} to origin...`);
        await this.git.repository.push(repoPath, { branch: targetBranch, log: s => context.logInfo(s) });
        context.logInfo('✓ Pushed to origin');
      } catch (pushError: any) {
        context.logError(`Push failed: ${pushError.message}`);
      }
    }
  }
}