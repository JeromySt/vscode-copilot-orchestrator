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
          context.logError(`  ✗ Merge failed: ${mergeResult.error}`);
          context.logInfo('========== FORWARD INTEGRATION MERGE END ==========');
          return { 
            success: false, 
            error: `Merge failed for dependency ${nodeName} (${shortSha}): ${mergeResult.error}`,
            metrics: accumulatedMetrics 
          };
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
}