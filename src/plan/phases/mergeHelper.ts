/**
 * @fileoverview Merge Helper Utilities
 * 
 * Shared utilities for merge conflict resolution used by both
 * merge-fi and merge-ri phases.
 * 
 * @module plan/phases/mergeHelper
 */

import type { PhaseContext } from '../../interfaces/IPhaseExecutor';
import type { ExecutionPhase, CopilotUsageMetrics } from '../types';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';

interface MergeConflictContext {
  planId: string;
  nodeId: string;
  phase: ExecutionPhase;
  attemptNumber?: number;
}

interface MergeConflictResult {
  success: boolean;
  sessionId?: string;
  metrics?: CopilotUsageMetrics;
}

/**
 * Resolve merge conflicts using Copilot CLI.
 * 
 * This shared helper creates merge-specific instructions and invokes
 * the Copilot CLI to resolve conflicts. It uses the onProcess callback
 * to track the spawned process in the PhaseContext.
 * 
 * @param ctx - Phase execution context
 * @param cwd - Working directory where the merge is happening
 * @param sourceBranch - Source branch/commit being merged
 * @param targetBranch - Target branch receiving the merge
 * @param commitMessage - Message for the final merge commit
 * @param conflictedFiles - List of files with conflicts (optional)
 * @param copilotRunner - ICopilotRunner instance (optional, will create if needed)
 * @param configManager - Config manager for getting merge preferences
 */
export async function resolveMergeConflictWithCopilot(
  ctx: PhaseContext,
  cwd: string,
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  copilotRunner: ICopilotRunner,
  conflictedFiles?: string[],
  configManager?: any
): Promise<MergeConflictResult> {
  const prefer = configManager?.getConfig('copilotOrchestrator.merge', 'prefer', 'theirs') ?? 'theirs';
  
  // Write a merge-specific instructions file so the agent focuses ONLY on
  // resolving merge conflicts, not performing the job's actual work.
  const conflictList = conflictedFiles?.length
    ? conflictedFiles.map(f => `- ${f}`).join('\n')
    : '(run `git diff --name-only --diff-filter=U` to list them)';

  const mergeInstructions =
`# Merge Conflict Resolution

## Context
We are merging \`${sourceBranch}\` into \`${targetBranch}\`.
You MUST resolve all git merge conflicts and commit the result.

## Conflicted Files
${conflictList}

## Rules
1. **Prefer "${prefer}" changes** when there is a conflict. Keep all non-conflicting changes from both sides.
2. Open each conflicted file and remove ALL \`<<<<<<<\`, \`=======\`, \`>>>>>>>\` conflict markers.
3. After resolving, verify no conflict markers remain: \`git diff --check\`
4. Stage all resolved files: \`git add <file>\` for each conflicted file.
5. Commit with message: \`${commitMessage}\`

## Important
- Do NOT modify any files beyond resolving the conflict markers.
- Do NOT refactor, rename, or restructure code.
- Do NOT run builds, tests, or linters — just resolve conflicts and commit.
- If both sides added different imports, keep ALL imports from both sides.
- If both sides modified the same function differently, prefer "${prefer}" but preserve non-conflicting logic from the other side.`;

  ctx.logInfo(`Running Copilot CLI to resolve conflicts...`);
  
  const result = await copilotRunner.run({
    cwd,
    task: 'Resolve all git merge conflicts in this repository.',
    instructions: mergeInstructions,
    label: 'merge-conflict',
    jobId: ctx.node.id,
    timeout: 600000, // 10 minutes — merge resolution needs time for multi-file conflicts
    onOutput: (line) => {
      if (line.trim()) {
        ctx.logInfo(`[copilot] ${line.trim()}`);
      }
    },
    onProcess: (proc: any) => {
      // Use the context's setProcess to track the spawned process
      ctx.setProcess(proc);
    },
  });
  
  // Log the CLI result details
  if (result.sessionId) {
    ctx.logInfo(`Copilot session: ${result.sessionId}`);
  }
  if (!result.success) {
    ctx.logError(`Copilot CLI error: ${result.error || 'unknown'}`);
    if (result.exitCode !== undefined) {
      ctx.logError(`Exit code: ${result.exitCode}`);
    }
  }
  
  return { success: result.success, sessionId: result.sessionId, metrics: result.metrics };
}