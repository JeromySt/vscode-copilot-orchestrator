/**
 * @fileoverview Forward Integration (FI) Merge Phase Executor
 * 
 * Handles merging additional source commits from dependencies into the worktree.
 * This is called when a job has multiple dependencies (RI/FI model).
 * The worktree is already created from the first dependency's commit,
 * and we merge in the remaining dependency commits.
 * 
 * @module plan/phases/mergeFiPhase
 */

import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { CopilotUsageMetrics } from '../types';
import { resolveMergeConflictWithCopilot } from './mergeHelper';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';
import { aggregateMetrics } from '../metricsAggregator';

interface DependencyInfo {
  nodeId: string;
  nodeName: string;
  workSummary?: string;
}

/**
 * Executor for the forward integration merge phase.
 * 
 * Merges additional source commits into a worktree when a job has multiple
 * dependencies. Uses full merge (not squash) to preserve history for downstream jobs.
 */
export class MergeFiPhaseExecutor implements IPhaseExecutor {
  private configManager?: any;
  private git: IGitOperations;
  private copilotRunner: ICopilotRunner;
  
  constructor(deps: { configManager?: any; git: IGitOperations; copilotRunner: ICopilotRunner }) {
    this.configManager = deps.configManager;
    this.git = deps.git;
    this.copilotRunner = deps.copilotRunner;
  }
  
  async execute(context: PhaseContext): Promise<PhaseResult> {
    const { node, worktreePath, dependencyCommits } = context;
    
    if (!dependencyCommits || dependencyCommits.length === 0) {
      context.logInfo('No additional dependency commits to merge - forward integration complete');
      return { success: true };
    }
    
    context.logInfo(`========== FORWARD INTEGRATION MERGE START ==========`);
    context.logInfo(`Merging ${dependencyCommits.length} dependency commit(s) into worktree...`);
    
    // Create dependency info map for logging
    const dependencyInfoMap = new Map<string, DependencyInfo>();
    dependencyCommits.forEach(dep => {
      dependencyInfoMap.set(dep.commit, {
        nodeId: dep.nodeId,
        nodeName: dep.nodeName,
        workSummary: undefined, // This would need to be passed in if available
      });
    });
    
    let accumulatedMetrics: CopilotUsageMetrics | undefined;
    
    // Merge each dependency commit
    for (const { commit: sourceCommit, nodeName } of dependencyCommits) {
      const shortSha = sourceCommit.slice(0, 8);
      const depInfo = dependencyInfoMap.get(sourceCommit);
      
      context.logInfo(`[Merge Source] ${nodeName}`);
      context.logInfo(`  Commit: ${shortSha} (from dependency "${nodeName}")`);
      
      // Show work summary from the dependency node if available
      if (depInfo?.workSummary) {
        this.logDependencyWorkSummary(context, depInfo.workSummary);
      }
      context.logInfo('  Merging into worktree...');
      
      try {
        // Merge by commit SHA directly (no branch needed)
        const mergeResult = await this.git.merge.merge({
          source: sourceCommit,
          target: 'HEAD',
          cwd: worktreePath,
          message: `Merge parent commit ${shortSha} for job ${node.name}`,
          fastForward: true,
        });
        
        if (mergeResult.success) {
          context.logInfo(`  ✓ Merged successfully`);
        } else if (mergeResult.hasConflicts) {
          context.logInfo(`  ⚠ Merge conflict detected`);
          context.logInfo(`    Conflicts: ${mergeResult.conflictFiles?.join(', ')}`);
          context.logInfo(`    Invoking Copilot CLI to resolve...`);
          
          // Use Copilot CLI to resolve conflicts
          const cliResult = await resolveMergeConflictWithCopilot(
            context,
            worktreePath,
            sourceCommit,
            'HEAD',
            `Merge parent commit ${shortSha} for job ${node.name}`,
            this.copilotRunner,
            mergeResult.conflictFiles,
            this.configManager
          );
          
          if (!cliResult.success) {
            context.logError(`  ✗ Copilot CLI failed to resolve conflict`);
            await this.git.merge.abort(worktreePath, s => context.logInfo(s));
            context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
            return { 
              success: false, 
              error: `Failed to resolve merge conflict for dependency ${nodeName} (${shortSha})`,
              metrics: accumulatedMetrics
            };
          }
          
          context.logInfo(`  ✓ Conflict resolved by Copilot CLI`);
          
          // Accumulate CLI metrics
          if (cliResult.metrics) {
            accumulatedMetrics = accumulatedMetrics
              ? aggregateMetrics([accumulatedMetrics, cliResult.metrics])
              : cliResult.metrics;
          }
        } else {
          // Merge rejected — check if it's due to local uncommitted changes
          const isLocalChangesError = mergeResult.error?.includes('local changes') || 
                                      mergeResult.error?.includes('would be overwritten');
          
          if (isLocalChangesError) {
            // Stash local changes, retry the merge, then pop
            context.logInfo(`  ⚠ Merge blocked by local changes — stashing and retrying`);
            let stashed = false;
            try {
              stashed = await this.git.repository.stashPush(worktreePath, `fi-pre-merge-${Date.now()}`);
            } catch {
              // stash failed — fall through to error
            }
            
            if (stashed) {
              // Retry the merge on clean worktree
              const retryResult = await this.git.merge.merge({
                source: sourceCommit,
                target: 'HEAD',
                cwd: worktreePath,
                message: `Merge parent commit ${shortSha} for job ${node.name}`,
                fastForward: true,
              });
              
              if (retryResult.success) {
                context.logInfo(`  ✓ Merged successfully (after stash)`);
              } else if (retryResult.hasConflicts) {
                // AI conflict resolution on retry
                context.logInfo(`  ⚠ Merge conflict on retry — invoking AI resolution`);
                const cliResult = await resolveMergeConflictWithCopilot(
                  context, worktreePath, sourceCommit, 'HEAD',
                  `Merge parent commit ${shortSha} for job ${node.name}`,
                  this.copilotRunner, retryResult.conflictFiles, this.configManager
                );
                if (!cliResult.success) {
                  await this.git.merge.abort(worktreePath, s => context.logInfo(s));
                  await this.popStash(worktreePath, true, context);
                  context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
                  return { success: false, error: `Failed to resolve conflict for ${nodeName} (${shortSha}) after stash retry`, metrics: accumulatedMetrics };
                }
                context.logInfo(`  ✓ Conflict resolved after stash retry`);
                if (cliResult.metrics) {
                  accumulatedMetrics = accumulatedMetrics ? aggregateMetrics([accumulatedMetrics, cliResult.metrics]) : cliResult.metrics;
                }
              } else {
                // Retry also failed for non-conflict reason
                await this.popStash(worktreePath, true, context);
                context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
                return { success: false, error: `Merge failed for ${nodeName} (${shortSha}) even after stash: ${retryResult.error}`, metrics: accumulatedMetrics };
              }
              
              // Pop stash — if it fails, AI resolves
              await this.popStash(worktreePath, true, context);
            } else {
              context.logError(`  ✗ Could not stash local changes`);
              context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
              return { success: false, error: `Merge failed for ${nodeName} (${shortSha}): ${mergeResult.error}`, metrics: accumulatedMetrics };
            }
          } else {
            context.logError(`  ✗ Merge failed: ${mergeResult.error}`);
            context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
            return { 
              success: false, 
              error: `Merge failed for dependency ${nodeName} (${shortSha}): ${mergeResult.error}`,
              metrics: accumulatedMetrics 
            };
          }
        }
        
      } catch (error: any) {
        context.logError(`  ✗ Merge error: ${error.message}`);
        context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
        return { 
          success: false, 
          error: `Merge error for dependency ${nodeName} (${shortSha}): ${error.message}`,
          metrics: accumulatedMetrics
        };
      }
    }
    
    context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
    
    return { success: true, metrics: accumulatedMetrics };
  }
  
  private logDependencyWorkSummary(context: PhaseContext, workSummary: string): void {
    const lines = workSummary.split('\n');
    const maxLines = 3;
    const displayLines = lines.slice(0, maxLines);
    
    for (const line of displayLines) {
      context.logInfo(`    ${line}`);
    }
    
    if (lines.length > maxLines) {
      const remaining = lines.length - maxLines;
      context.logInfo(`    ... (${remaining} more lines)`);
    }
  }
  
  /** Pop stash with AI-assisted conflict resolution fallback. */
  private async popStash(worktreePath: string, didStash: boolean, context: PhaseContext): Promise<void> {
    if (!didStash) {return;}
    try {
      await this.git.repository.stashPop(worktreePath);
      context.logInfo('  Restored stashed changes after merge');
    } catch (popErr: any) {
      context.logInfo(`  Stash pop failed: ${popErr.message} — attempting AI resolution`);
      try {
        const conflicts = await this.git.merge.listConflicts(worktreePath).catch(() => []);
        if (conflicts.length > 0) {
          const result = await resolveMergeConflictWithCopilot(
            context, worktreePath, 'stash@{0}', 'HEAD',
            'Resolve stash pop conflicts after FI merge',
            this.copilotRunner, conflicts, this.configManager
          );
          if (result.success) {
            await this.git.repository.stageAll(worktreePath);
            await this.git.repository.stashDrop(worktreePath);
            context.logInfo('  AI resolved stash conflicts');
            return;
          }
        }
        // No conflicts or AI failed — check if orchestrator-only, else drop
        const stashDiff = await this.git.repository.stashShowPatch(worktreePath).catch(() => null);
        if (stashDiff && this.git.gitignore.isDiffOnlyOrchestratorChanges(stashDiff)) {
          await this.git.repository.stashDrop(worktreePath);
          context.logInfo('  Dropped orchestrator-only stash');
        } else {
          await this.git.repository.stashDrop(worktreePath);
          context.logInfo('  Dropped unresolvable stash (merged content is authoritative in worktree)');
        }
      } catch {
        // Last resort — drop the stash in worktrees since merged content is authoritative
        try { await this.git.repository.stashDrop(worktreePath); } catch { /* ignore */ }
        context.logInfo('  Dropped stash (worktree merge content is authoritative)');
      }
    }
  }
}