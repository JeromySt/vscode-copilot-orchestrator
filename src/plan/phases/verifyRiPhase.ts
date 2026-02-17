/**
 * @fileoverview Verify-RI Phase Executor
 *
 * Runs after a successful merge-ri to validate the merged target branch.
 * Executes the plan-level `verifyRiSpec` (e.g. compile, test) inside a
 * temporary worktree checked out at the target branch HEAD.
 *
 * ## Safety guarantees
 *
 * - Runs in an **ephemeral worktree** — never touches the user's checkout.
 * - Auto-healable: if verification fails, the auto-heal machinery in
 *   executionEngine can invoke Copilot CLI to fix the issue in the worktree,
 *   commit the fix to targetBranch, and re-run verification.
 * - Cleans up the worktree on completion (success or failure).
 *
 * @module plan/phases/verifyRiPhase
 */

import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import { normalizeWorkSpec } from '../types';
import type { ProcessSpec, ShellSpec, AgentSpec } from '../types';
import { runProcess, runShell, runAgent } from './workPhase';

/**
 * Executes the verify-ri phase: validates the target branch after an RI merge.
 *
 * Creates a temporary worktree at the target branch HEAD, runs the plan-level
 * verification WorkSpec there, and cleans up.  If the WorkSpec produces file
 * changes (e.g. auto-heal fix), they are committed and the target branch ref
 * is updated before cleanup.
 */
export class VerifyRiPhaseExecutor implements IPhaseExecutor {
  private agentDelegator?: any;
  private spawner: IProcessSpawner;
  private git: IGitOperations;

  constructor(deps: {
    agentDelegator?: any;
    spawner: IProcessSpawner;
    git: IGitOperations;
  }) {
    this.agentDelegator = deps.agentDelegator;
    this.spawner = deps.spawner;
    this.git = deps.git;
  }

  async execute(context: PhaseContext): Promise<PhaseResult> {
    const normalized = normalizeWorkSpec(context.workSpec);
    if (!normalized) {
      return { success: true };
    }

    const { repoPath, targetBranch } = context;
    if (!repoPath || !targetBranch) {
      return { success: true }; // No target branch → nothing to verify
    }

    const targetSha = await this.git.repository.resolveRef(targetBranch, repoPath);
    const worktreeName = `verify-ri-${Date.now()}`;
    const worktreePath = path.join(repoPath, '.worktrees', worktreeName);

    context.logInfo(`Creating verification worktree at ${targetBranch} (${targetSha.slice(0, 8)})...`);

    try {
      // Step 1: Create detached worktree at the just-merged target branch
      await this.git.worktrees.createDetachedWithTiming(
        repoPath, worktreePath, targetSha,
        s => context.logInfo(s)
      );

      // Step 2: Run the verification WorkSpec in the worktree
      // Override the context worktreePath so the work runs in the verify worktree
      const verifyContext: PhaseContext = {
        ...context,
        worktreePath,
      };

      context.logInfo(`Running verification: ${normalized.type}`);
      let result: PhaseResult;

      switch (normalized.type) {
        case 'process':
          result = await runProcess(normalized as ProcessSpec, verifyContext, this.spawner);
          break;
        case 'shell':
          result = await runShell(normalized as ShellSpec, verifyContext, this.spawner);
          break;
        case 'agent':
          result = await runAgent(normalized as AgentSpec, verifyContext, this.agentDelegator);
          break;
        default:
          result = { success: false, error: `Unknown work type: ${(normalized as any).type}` };
      }

      // Step 3: If the verification (or auto-heal) produced changes, commit them
      if (result.success) {
        await this.commitVerifyFixIfNeeded(context, repoPath, worktreePath, targetBranch);
      }

      return result;

    } catch (error: any) {
      context.logError(`Verify-RI failed: ${error.message}`);
      return { success: false, error: `Verification failed: ${error.message}` };
    } finally {
      // Always clean up the ephemeral worktree
      try {
        await this.git.worktrees.removeSafe(repoPath, worktreePath, {
          force: true,
          log: s => context.logInfo(s)
        });
        context.logInfo('Cleaned up verification worktree');
      } catch (cleanupErr: any) {
        context.logInfo(`Warning: failed to remove verification worktree: ${cleanupErr.message}`);
      }
    }
  }

  /**
   * If the verification WorkSpec (or auto-heal) produced file changes in the
   * worktree, commit them and update the target branch ref.
   */
  private async commitVerifyFixIfNeeded(
    context: PhaseContext,
    repoPath: string,
    worktreePath: string,
    targetBranch: string
  ): Promise<void> {
    const hasChanges = await this.git.repository.hasChanges(worktreePath);
    if (!hasChanges) {
      return; // Clean verification — no fixes needed
    }

    context.logInfo('Verification produced fixes — committing to target branch...');
    await this.git.repository.stageAll(worktreePath, s => context.logInfo(s));
    const committed = await this.git.repository.commit(
      worktreePath,
      `verify-ri: fix merged state on ${targetBranch}`,
      { log: s => context.logInfo(s) }
    );

    if (committed) {
      const fixCommit = await this.git.repository.getHead(worktreePath);
      if (fixCommit) {
        await this.git.repository.updateRef(repoPath, `refs/heads/${targetBranch}`, fixCommit);
        context.logInfo(`Updated ${targetBranch} with verification fix (${fixCommit.slice(0, 8)})`);
      }
    }
  }
}
