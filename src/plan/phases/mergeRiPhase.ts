/**
 * @fileoverview Reverse Integration (RI) Merge Phase Executor
 * 
 * Handles merging leaf node changes back to the target branch.
 * This implements the "reverse integration" pattern where completed work
 * from a worktree is merged back to the main target branch.
 * 
 * ## Safety guarantees
 * 
 * - **Never touches the user's working directory during merges.** All merges
 *   happen via `git merge-tree --write-tree` (in-memory). Conflict resolution
 *   extracts conflicted files to a temp directory, resolves them with
 *   Copilot CLI, then hashes the resolved files back into git objects
 *   and rebuilds the tree — all without modifying any checkout.
 * - **Preserves user's uncommitted changes.** After the merge completes and
 *   the branch ref is updated, plan-changed files are selectively checked
 *   out in the working tree. Pre-existing user modifications are left
 *   untouched — they remain as unstaged modifications.
 * - **Never stashes user changes.** The stash/pop pattern is inherently
 *   dangerous because it mixes user state with orchestrator state.
 * - **Validates the merged tree.** After every RI merge, the file count
 *   of the result is compared to the source. If the result has
 *   significantly fewer files, the merge is aborted.
 * 
 * @module plan/phases/mergeRiPhase
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { CopilotUsageMetrics } from '../types';
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
          [targetSha, mergeSource],
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
      // CONFLICT: Resolve in-memory via merge-tree + Copilot + hash-object
      // Never creates a worktree or touches the user's checkout.
      // =========================================================================
      if (mergeTreeResult.hasConflicts) {
        context.logInfo('⚠ Merge has conflicts');
        context.logInfo(`  Conflicts: ${mergeTreeResult.conflictFiles?.join(', ')}`);

        if (!mergeTreeResult.treeSha) {
          context.logError('Merge has conflicts but no tree SHA was produced — cannot resolve');
          return { success: false, error: 'Merge-tree produced conflicts but no tree SHA' };
        }

        context.logInfo('  Resolving in-memory (user checkout untouched)...');
        
        const resolved = await this.resolveConflictsInMemory(
          context,
          repoPath,
          mergeSource,
          targetBranch,
          `Plan ${node.name}: merge ${node.name} (commit ${mergeSource.slice(0, 8)})`,
          mergeTreeResult.treeSha,
          mergeTreeResult.conflictFiles || []
        );
        
        if (resolved.success) {
          context.logInfo('✓ Conflicts resolved in-memory');
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
   * 
   * If the user has `targetBranch` checked out AND their working tree
   * was clean *before* the ref move, we do `git reset --hard HEAD` to
   * keep the checkout in sync — this is safe because there is nothing
   * to lose.  If the tree was dirty (user has pending work), we sync
   * the index + selectively update plan-changed files in the working
   * tree while preserving the user's pre-existing uncommitted changes.
   */
  private async updateBranchRef(
    context: PhaseContext,
    repoPath: string,
    targetBranch: string,
    newCommit: string
  ): Promise<boolean> {
    // Snapshot dirtiness BEFORE we move the ref — after the move the
    // index will always look dirty relative to the new HEAD.
    let branchCheckedOut = false;
    let wasDirtyBeforeRefUpdate = true; // conservative default
    let dirtyFilesBefore: string[] = [];
    try {
      const currentBranch = await this.git.branches.currentOrNull(repoPath);
      branchCheckedOut = currentBranch === targetBranch;
      context.logInfo(`Main worktree branch: ${currentBranch || '(detached)'}, target: ${targetBranch}, match: ${branchCheckedOut}`);
      if (branchCheckedOut) {
        dirtyFilesBefore = await this.git.repository.getDirtyFiles(repoPath);
        wasDirtyBeforeRefUpdate = dirtyFilesBefore.length > 0;
        context.logInfo(`Main worktree dirty before ref update: ${wasDirtyBeforeRefUpdate} (${dirtyFilesBefore.length} files)`);
      }
    } catch { /* non-fatal — assume dirty to be safe */ }

    try {
      await this.git.repository.updateRef(repoPath, `refs/heads/${targetBranch}`, newCommit);
      context.logInfo(`Ref refs/heads/${targetBranch} → ${newCommit.slice(0, 8)}`);
    } catch (error: any) {
      context.logError(`Failed to update branch ${targetBranch}: ${error.message}`);
      return false;
    }

    if (branchCheckedOut) {
      if (!wasDirtyBeforeRefUpdate) {
        // Working tree was clean — safe to reset to the exact commit.
        // Use the explicit commit SHA (not 'HEAD') to avoid stale
        // symref resolution when other tools (e.g. VS Code git) are
        // watching the repo concurrently.
        try {
          await this.git.repository.resetHard(repoPath, newCommit, s => context.logInfo(s));
          context.logInfo(`Synced main worktree to ${newCommit.slice(0, 8)}`);
        } catch (err: any) {
          context.logInfo(`⚠ Could not sync main worktree: ${err.message}`);
        }
      } else {
        // Working tree is dirty — we must NOT do a hard reset (would
        // destroy user changes).  Strategy:
        //
        // 1. Mixed reset: syncs the INDEX to the new HEAD so
        //    `git diff --cached` is clean (no staged reverse-diff).
        // 2. Selective checkout: for every file that now differs between
        //    the working tree and the index AND was NOT in the user's
        //    pre-existing dirty list, run `git checkout -- <file>`.
        //    This updates plan-changed files in the working tree while
        //    leaving the user's uncommitted modifications untouched.
        try {
          await this.git.repository.resetMixed(repoPath, newCommit, s => context.logInfo(s));
          context.logInfo(`Synced index to ${newCommit.slice(0, 8)}`);

          // After mixed reset, get the list of files that now differ
          // between working tree and the (updated) index.
          const dirtyAfter = await this.git.repository.getDirtyFiles(repoPath);
          const dirtyBeforeSet = new Set(dirtyFilesBefore);
          // Files dirty now that were NOT dirty before = plan-changed
          // files whose working-tree content is stale.
          const planChangedFiles = dirtyAfter.filter(f => !dirtyBeforeSet.has(f));

          if (planChangedFiles.length > 0) {
            context.logInfo(`Updating ${planChangedFiles.length} plan-changed files in working tree`);
            let restored = 0;
            for (const file of planChangedFiles) {
              try {
                await this.git.repository.checkoutFile(repoPath, file);
                restored++;
              } catch {
                // File may have been deleted by the plan — clean up from
                // working tree.  checkoutFile fails on deleted paths.
                try {
                  await this.git.command.execAsync(['rm', '-f', '--', file], { cwd: repoPath });
                  restored++;
                } catch { /* non-fatal */ }
              }
            }
            context.logInfo(`Restored ${restored}/${planChangedFiles.length} files`);
          }

          if (dirtyFilesBefore.length > 0) {
            context.logInfo(
              `ℹ Preserved ${dirtyFilesBefore.length} pre-existing uncommitted file(s): ` +
              dirtyFilesBefore.slice(0, 5).join(', ') +
              (dirtyFilesBefore.length > 5 ? ` (+${dirtyFilesBefore.length - 5} more)` : '')
            );
          }
        } catch (err: any) {
          context.logInfo(
            `⚠ Could not sync working tree: ${err.message}. ` +
            `Run 'git reset --hard ${newCommit.slice(0, 8)}' to sync manually.`
          );
        }
      }
    } else {
      context.logInfo(`Main worktree is not on ${targetBranch} — skipping working tree sync`);
    }

    return true;
  }
  
  /**
   * Resolve merge conflicts entirely in-memory using merge-tree + Copilot CLI.
   * 
   * This approach NEVER touches ANY working directory:
   * 1. merge-tree --write-tree already gave us a tree SHA with conflict markers
   * 2. Extract each conflicted file from the tree to a temp directory
   * 3. Run Copilot CLI in the temp directory to resolve conflict markers
   * 4. hash-object the resolved files back into git's object store
   * 5. replaceTreeBlobs to build a new clean tree
   * 6. commitTree + updateRef to land the merge
   */
  private async resolveConflictsInMemory(
    context: PhaseContext,
    repoPath: string,
    sourceCommit: string,
    targetBranch: string,
    commitMessage: string,
    conflictedTreeSha: string,
    conflictFiles: string[]
  ): Promise<{ success: boolean; error?: string; metrics?: CopilotUsageMetrics }> {
    const targetSha = await this.git.repository.resolveRef(targetBranch, repoPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-conflict-'));
    
    try {
      // Step 1: Extract conflicted files from the tree to a temp directory
      context.logInfo(`Extracting ${conflictFiles.length} conflicted file(s) to temp dir...`);
      
      for (const filePath of conflictFiles) {
        const content = await this.git.merge.catFileFromTree(repoPath, conflictedTreeSha, filePath);
        if (content === null) {
          context.logInfo(`  Skipping ${filePath} — could not read from tree (likely deleted-by-us)`);
          continue;
        }
        const destPath = path.join(tmpDir, filePath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
      }
      
      // Step 2: Run Copilot CLI to resolve conflict markers in the temp dir
      context.logInfo(`Invoking Copilot CLI to resolve ${conflictFiles.length} conflict(s) in-memory...`);
      const cliResult = await this.resolveConflictFilesWithCopilot(
        context,
        tmpDir,
        repoPath,
        sourceCommit,
        targetBranch,
        commitMessage,
        conflictFiles
      );
      
      if (!cliResult.success) {
        return { success: false, error: 'Copilot CLI failed to resolve conflicts', metrics: cliResult.metrics };
      }
      
      context.logInfo('Copilot CLI resolved conflicts');
      
      // Step 3: Hash resolved files back into git object store
      const replacements = new Map<string, string>();
      for (const filePath of conflictFiles) {
        const resolvedPath = path.join(tmpDir, filePath);
        if (!fs.existsSync(resolvedPath)) {
          continue;
        }
        // Verify conflict markers are gone
        const resolvedContent = fs.readFileSync(resolvedPath, 'utf-8');
        if (resolvedContent.includes('<<<<<<<') || resolvedContent.includes('>>>>>>>')) {
          context.logInfo(`  Warning: ${filePath} still contains conflict markers`);
        }
        const blobSha = await this.git.merge.hashObjectFromFile(repoPath, resolvedPath);
        replacements.set(filePath, blobSha);
        context.logInfo(`  Hashed ${filePath} → ${blobSha.slice(0, 8)}`);
      }
      
      // Step 4: Build new tree with resolved blobs
      context.logInfo(`Building resolved tree (${replacements.size} replacement(s))...`);
      const resolvedTreeSha = await this.git.merge.replaceTreeBlobs(
        repoPath,
        conflictedTreeSha,
        replacements,
        s => context.logInfo(s)
      );
      context.logInfo(`Resolved tree: ${resolvedTreeSha.slice(0, 8)}`);
      
      // Step 5: Create merge commit from the resolved tree
      const mergeCommit = await this.git.merge.commitTree(
        resolvedTreeSha,
        [targetSha, sourceCommit],
        commitMessage,
        repoPath,
        s => context.logInfo(s)
      );
      context.logInfo(`Merge commit: ${mergeCommit.slice(0, 8)}`);
      
      // Step 6: Validate the merged tree
      const validationError = await this.validateMergedTree(
        context, repoPath, mergeCommit, sourceCommit, targetSha
      );
      if (validationError) {
        return { success: false, error: validationError };
      }
      
      // Step 7: Update the target branch ref
      const branchUpdated = await this.updateBranchRef(context, repoPath, targetBranch, mergeCommit);
      if (branchUpdated) {
        context.logInfo(`Updated ${targetBranch} to ${mergeCommit.slice(0, 8)}`);
      } else {
        context.logInfo(`⚠ Merge commit exists but branch not updated — run 'git reset --hard ${mergeCommit.slice(0, 8)}'`);
      }
      
      // Push if configured
      await this.pushIfConfigured(context, repoPath, targetBranch);
      
      return { success: true, metrics: cliResult.metrics };
      
    } catch (error: any) {
      context.logError(`In-memory conflict resolution failed: ${error.message}`);
      return { success: false, error: `In-memory merge failed: ${error.message}` };
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        context.logInfo('Cleaned up temp conflict dir');
      } catch { /* ignore */ }
    }
  }
  
  /**
   * Run Copilot CLI to resolve conflict markers in extracted files.
   * 
   * The files live in a plain temp directory (not a git repo). Copilot CLI
   * is instructed to edit the files in-place, removing conflict markers.
   */
  private async resolveConflictFilesWithCopilot(
    context: PhaseContext,
    tmpDir: string,
    _repoPath: string,
    sourceCommit: string,
    targetBranch: string,
    commitMessage: string,
    conflictFiles: string[]
  ): Promise<{ success: boolean; metrics?: CopilotUsageMetrics }> {
    const task = [
      'You are resolving git merge conflicts.',
      `Source commit: ${sourceCommit.slice(0, 8)}`,
      `Target branch: ${targetBranch}`,
      `Merge message: ${commitMessage}`,
      '',
      'The following files have conflict markers (<<<<<<< / ======= / >>>>>>>).',
      'Edit each file to resolve the conflicts by choosing the correct content.',
      'Remove all conflict markers when done.',
      '',
      'Conflicted files:',
      ...conflictFiles.map(f => `  - ${f}`)
    ].join('\n');
    
    try {
      const result = await this.copilotRunner.run({
        task,
        cwd: tmpDir,
        label: 'ri-conflict-resolution',
        onOutput: (line: string) => context.logInfo(line)
      });
      return { success: result.success, metrics: result.metrics };
    } catch (error: any) {
      context.logError(`Copilot CLI conflict resolution error: ${error.message}`);
      return { success: false };
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