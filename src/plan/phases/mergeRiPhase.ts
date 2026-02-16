/**
 * @fileoverview Reverse Integration (RI) Merge Phase Executor
 * 
 * Handles merging leaf node changes back to the target branch.
 * This implements the "reverse integration" pattern where completed work
 * from a worktree is merged back to the main target branch.
 * 
 * @module plan/phases/mergeRiPhase
 */

import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { CopilotUsageMetrics } from '../types';
import { resolveMergeConflictWithCopilot } from './mergeHelper';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';

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
      // No completed commit — nothing to merge back.
      // This happens for expects_no_changes nodes or validation-only nodes.
      context.logInfo('========== REVERSE INTEGRATION MERGE START ==========');
      context.logInfo('No completed commit — skipping RI merge (expects_no_changes or validation-only node)');
      context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
      return { success: true };
    }
    if (!baseCommitAtStart) {
      return { success: false, error: 'baseCommitAtStart is required for reverse integration merge' };
    }
    
    context.logInfo('========== REVERSE INTEGRATION MERGE START ==========');
    
    // Check if there are any changes to merge
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
        
        // Create the merge commit from the tree
        const targetSha = await this.git.repository.resolveRef(targetBranch, repoPath);
        const commitMessage = `Plan ${node.name}: merge ${node.name} (commit ${mergeSource.slice(0, 8)})`;
        
        const newCommit = await this.git.merge.commitTree(
          mergeTreeResult.treeSha,
          [targetSha],  // Single parent for squash-style merge
          commitMessage,
          repoPath,
          s => context.logInfo(s)
        );
        
        context.logInfo(`Created merge commit: ${newCommit.slice(0, 8)}`);
        
        // Update the target branch to point to the new commit
        const branchUpdated = await this.updateBranchRef(context, repoPath, targetBranch, newCommit);
        if (branchUpdated) {
          context.logInfo(`Updated ${targetBranch} to ${newCommit.slice(0, 8)}`);
        } else {
          // Stash/reset failed but merge commit exists - partial success
          context.logInfo(`⚠ Merge commit ${newCommit.slice(0, 8)} created but branch not auto-updated (stash failed)`);
          context.logInfo(`  Run 'git reset --hard ${newCommit.slice(0, 8)}' to update your local ${targetBranch}`);
        }
        
        // Push if configured
        const pushOnSuccess = this.configManager?.getConfig('copilotOrchestrator.merge', 'pushOnSuccess', false) ?? false;
        
        if (pushOnSuccess) {
          try {
            context.logInfo(`Pushing ${targetBranch} to origin...`);
            await this.git.repository.push(repoPath, { branch: targetBranch, log: s => context.logInfo(s) });
            context.logInfo('✓ Pushed to origin');
          } catch (pushError: any) {
            context.logError(`Push failed: ${pushError.message}`);
            // Push failure doesn't mean merge failed - the commit is local
          }
        }
        
        context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
        return { success: true };
      }
      
      // =========================================================================
      // CONFLICT: Use Copilot CLI to resolve via main repo merge
      // =========================================================================
      if (mergeTreeResult.hasConflicts) {
        context.logInfo('⚠ Merge has conflicts');
        context.logInfo(`  Conflicts: ${mergeTreeResult.conflictFiles?.join(', ')}`);
        context.logInfo('  Invoking Copilot CLI to resolve...');
        
        // Fall back to main repo merge with Copilot CLI resolution
        const resolved = await this.mergeWithConflictResolution(
          context,
          repoPath,
          mergeSource,
          targetBranch,
          `Plan ${node.name}: merge ${node.name} (commit ${mergeSource.slice(0, 8)})`
        );
        
        if (resolved.success) {
          context.logInfo('✓ Conflict resolved by Copilot CLI');
          context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
          return { success: true, metrics: resolved.metrics };
        } else {
          context.logError('✗ Copilot CLI failed to resolve conflict');
          context.logInfo('========== REVERSE INTEGRATION MERGE END ==========');
          return { success: false, error: 'Failed to resolve merge conflicts', metrics: resolved.metrics };
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
   * Handles cases where the branch is checked out elsewhere.
   */
  private async updateBranchRef(
    context: PhaseContext,
    repoPath: string,
    targetBranch: string,
    newCommit: string
  ): Promise<boolean> {
    try {
      // Try to update the branch reference — args: (cwd, refName, commit)
      await this.git.repository.updateRef(repoPath, `refs/heads/${targetBranch}`, newCommit);
      return true;
    } catch (error: any) {
      context.logError(`Failed to update branch ${targetBranch}: ${error.message}`);
      // Note: Even if branch update fails, the merge commit exists and the operation
      // should be considered successful from a data integrity perspective
      return false;
    }
  }
  
  /**
   * Merge with conflict resolution using main repo merge and Copilot CLI.
   * 
   * This is used when merge-tree detects conflicts. It:
   * 1. Stashes user's uncommitted changes
   * 2. Checks out target branch
   * 3. Performs merge (conflicts occur)
   * 4. Uses Copilot CLI to resolve conflicts
   * 5. Restores user's original branch and stash
   */
  private async mergeWithConflictResolution(
    context: PhaseContext,
    repoPath: string,
    sourceCommit: string,
    targetBranch: string,
    commitMessage: string
  ): Promise<{ success: boolean; metrics?: CopilotUsageMetrics }> {
    // Capture user's current state
    const originalBranch = await this.git.branches.currentOrNull(repoPath);
    const isOnTargetBranch = originalBranch === targetBranch;
    const isDirty = await this.git.repository.hasUncommittedChanges(repoPath);
    
    let didStash = false;
    let didCheckout = false;
    
    try {
      // Step 1: Stash uncommitted changes if needed
      if (isDirty) {
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        didStash = await this.git.repository.stashPush(repoPath, stashMsg, s => context.logInfo(s));
        context.logInfo('Stashed user\'s uncommitted changes');
      }
      
      // Step 2: Checkout targetBranch if needed
      if (!isOnTargetBranch) {
        await this.git.branches.checkout(repoPath, targetBranch, s => context.logInfo(s));
        didCheckout = true;
        context.logInfo(`Checked out ${targetBranch} for merge`);
      }
      
      // Step 3: Perform the merge (will have conflicts)
      await this.git.merge.merge({
        source: sourceCommit,
        target: targetBranch,
        cwd: repoPath,
        noCommit: true,
        log: s => context.logInfo(s)
      }).catch(() => {
        // Expected to fail due to conflicts
      });

      // List conflicted files for the instructions
      const conflictedFiles = await this.git.merge.listConflicts(repoPath).catch(() => []);
      
      // Step 4: Use Copilot CLI to resolve conflicts
      const cliResult = await resolveMergeConflictWithCopilot(
        context,
        repoPath,
        sourceCommit,
        targetBranch,
        commitMessage,
        this.copilotRunner,
        conflictedFiles,
        this.configManager
      );
      
      if (!cliResult.success) {
        throw new Error('Copilot CLI failed to resolve conflicts');
      }
      
      context.logInfo('Merge conflict resolved by Copilot CLI');
      
      // Push if configured
      const pushOnSuccess = this.configManager?.getConfig('copilotOrchestrator.merge', 'pushOnSuccess', false) ?? false;
      
      if (pushOnSuccess) {
        try {
          await this.git.repository.push(repoPath, { branch: targetBranch, log: s => context.logInfo(s) });
          context.logInfo(`Pushed ${targetBranch} to origin`);
        } catch (pushError: any) {
          context.logInfo(`Push failed: ${pushError.message}`);
        }
      }
      
      // Step 5: Restore user to original branch (if they weren't on target)
      if (didCheckout && originalBranch) {
        await this.git.branches.checkout(repoPath, originalBranch, (s: string) => context.logInfo(s));
        context.logInfo(`Restored user to ${originalBranch}`);
      }
      
      // Step 6: Restore stashed changes
      if (didStash) {
        try {
          await this.git.repository.stashPop(repoPath, (s: string) => context.logInfo(s));
          context.logInfo('Restored user\'s stashed changes');
        } catch (stashError: any) {
          context.logInfo(`Stash pop failed: ${stashError.message}`);
          context.logInfo('Attempting AI-assisted resolution of stash conflicts...');
          
          // Stash pop leaves conflict markers in the working tree.
          // Use AI to resolve them, then stage + drop the stash.
          try {
            const conflictFiles = await this.git.merge.listConflicts(repoPath).catch(() => []);
            if (conflictFiles.length > 0) {
              const stashResult = await resolveMergeConflictWithCopilot(
                context,
                repoPath,
                'stash@{0}',
                'HEAD',
                'Resolve stash pop conflicts (restore user\'s local changes after RI merge)',
                this.copilotRunner,
                conflictFiles,
                this.configManager
              );
              
              if (stashResult.success) {
                // Stage resolved files and drop the stash
                await this.git.repository.stageAll(repoPath);
                await this.git.repository.stashDrop(repoPath);
                context.logInfo('AI resolved stash conflicts successfully');
              } else {
                context.logInfo('AI could not resolve stash conflicts. Run `git stash pop` manually.');
              }
            } else {
              // No conflicts but pop still failed — check if it's orchestrator-only
              const isOrchestratorOnly = await this.isStashOrchestratorOnly(repoPath);
              if (isOrchestratorOnly) {
                await this.git.repository.stashDrop(repoPath);
                context.logInfo('Dropped stash (orchestrator-only changes already in merge)');
              } else {
                context.logInfo('Run `git stash list` and `git stash pop` manually if needed');
              }
            }
          } catch (resolveErr: any) {
            context.logInfo(`Stash resolution failed: ${resolveErr.message}`);
            context.logInfo('Run `git stash list` and `git stash pop` manually if needed');
          }
        }
      }
      
      return { success: true, metrics: cliResult.metrics };
      
    } catch (error: any) {
      context.logError(`Merge with conflict resolution failed: ${error.message}`);
      
      // Best effort cleanup
      try {
        // Abort any ongoing merge
        await this.git.merge.abort(repoPath, s => context.logInfo(s));
        
        // Restore original branch if we changed it
        if (didCheckout && originalBranch) {
          await this.git.branches.checkout(repoPath, originalBranch, s => context.logInfo(s));
        }
        
        // Restore stash if we created one
        if (didStash) {
          await this.git.repository.stashPop(repoPath, s => context.logInfo(s));
        }
      } catch {
        // Ignore cleanup errors
      }
      
      return { success: false };
    }
  }
  
  /** Check if stash contains only orchestrator-managed changes (safe to drop). */
  private async isStashOrchestratorOnly(repoPath: string): Promise<boolean> {
    try {
      const files = await this.git.repository.stashShowFiles(repoPath);
      if (files.length !== 1 || files[0] !== '.gitignore') {return false;}
      const diff = await this.git.repository.stashShowPatch(repoPath);
      if (!diff) {return false;}
      return this.git.gitignore.isDiffOnlyOrchestratorChanges(diff);
    } catch {
      return false;
    }
  }
}