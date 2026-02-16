/**
 * @fileoverview Commit Phase Executor
 *
 * Handles the commit phase: validates evidence of work, stages and
 * commits changes, and optionally invokes AI review when no file
 * changes are detected.
 *
 * @module plan/phases/commitPhase
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { IEvidenceValidator } from '../../interfaces/IEvidenceValidator';
import type {
  JobNode,
  LogEntry,
  CopilotUsageMetrics,
} from '../types';
import { normalizeWorkSpec } from '../types';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import { parseAiReviewResult } from '../aiReviewUtils';
import { ORCHESTRATOR_SKILL_DIR } from './setupPhase';

/**
 * Extended context for the commit phase (adds access to execution logs
 * and an AI-review agent delegator).
 */
export interface CommitPhaseContext extends PhaseContext {
  /** Get execution logs for AI review */
  getExecutionLogs: () => LogEntry[];
}

/**
 * Executes the commit phase of a job node.
 */
export class CommitPhaseExecutor implements IPhaseExecutor {
  private evidenceValidator: IEvidenceValidator;
  private agentDelegator?: any;
  private getCopilotConfigDir: (worktreePath: string) => string;
  private git: IGitOperations;

  constructor(deps: {
    evidenceValidator: IEvidenceValidator;
    agentDelegator?: any;
    getCopilotConfigDir: (worktreePath: string) => string;
    git: IGitOperations;
  }) {
    this.evidenceValidator = deps.evidenceValidator;
    this.agentDelegator = deps.agentDelegator;
    this.getCopilotConfigDir = deps.getCopilotConfigDir;
    this.git = deps.git;
  }

  async execute(context: PhaseContext): Promise<PhaseResult> {
    const ctx = context as CommitPhaseContext;
    const { node, worktreePath, baseCommit } = ctx;

    try {
      // Remove projected orchestrator skill directory before staging
      this.removeOrchestratorSkillDir(worktreePath, ctx);

      ctx.logInfo(`Checking git status in ${worktreePath}`);
      const statusOutput = await this.getGitStatus(worktreePath);
      if (statusOutput) {
        ctx.logInfo(`Git status:\n${statusOutput}`);
      } else {
        ctx.logInfo('Git status: clean (no changes)');
        const ignoredFiles = await this.getIgnoredFiles(worktreePath);
        if (ignoredFiles) {
          ctx.logInfo(`Ignored files (not tracked by git):\n${ignoredFiles}`);
        }
      }

      const hasChanges = await this.git.repository.hasUncommittedChanges(worktreePath);
      ctx.logInfo(`hasUncommittedChanges: ${hasChanges}`);

      if (!hasChanges) {
        ctx.logInfo('No uncommitted changes, checking for commits since base...');

        const head = await this.git.worktrees.getHeadCommit(worktreePath);
        ctx.logInfo(`HEAD: ${head?.slice(0, 8) || 'unknown'}, baseCommit: ${baseCommit!.slice(0, 8)}`);

        if (head && head !== baseCommit) {
          ctx.logInfo(`Work stage made commits, HEAD: ${head.slice(0, 8)}`);
          return { success: true, commit: head };
        }

        // Check for evidence file
        const hasEvidence = await this.evidenceValidator.hasEvidenceFile(
          worktreePath, node.id,
        );
        if (hasEvidence) {
          ctx.logInfo('Evidence file found, staging...');
          await this.git.repository.stageAll(worktreePath);
          const message = `[Plan] ${node.task} (evidence only)`;
          await this.git.repository.commit(worktreePath, message);
          const commit = await this.git.worktrees.getHeadCommit(worktreePath);
          return { success: true, commit: commit || undefined };
        }

        // Check expectsNoChanges flag
        if (node.expectsNoChanges) {
          ctx.logInfo('Node declares expectsNoChanges — succeeding without commit');
          return { success: true, commit: undefined };
        }

        // AI Review
        if (this.agentDelegator) {
          ctx.logInfo('No file changes detected. Requesting AI review of execution logs...');
          const reviewResult = await this.aiReviewNoChanges(node, worktreePath, ctx);
          if (reviewResult.legitimate) {
            ctx.logInfo(`AI review: No changes needed — ${reviewResult.reason}`);
            return { success: true, commit: undefined, reviewMetrics: reviewResult.metrics };
          } else {
            ctx.logInfo(`AI review: Changes were expected — ${reviewResult.reason}`);
            const error = this.noEvidenceError();
            ctx.logError(error);
            return { success: false, error, reviewMetrics: reviewResult.metrics };
          }
        }

        // No evidence — fail
        const error = this.noEvidenceError();
        ctx.logError(error);
        return { success: false, error };
      }

      // Stage and commit
      ctx.logInfo('Staging all changes...');
      await this.git.repository.stageAll(worktreePath);

      const message = `[Plan] ${node.task}`;
      ctx.logInfo(`Creating commit: "${message}"`);
      await this.git.repository.commit(worktreePath, message);

      const commit = await this.git.worktrees.getHeadCommit(worktreePath);
      ctx.logInfo(`✓ Committed: ${commit?.slice(0, 8)}`);
      return { success: true, commit: commit || undefined };
    } catch (error: any) {
      ctx.logError(`Commit error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ---------- private helpers ----------

  private removeOrchestratorSkillDir(worktreePath: string, ctx: CommitPhaseContext): void {
    const skillDir = path.join(worktreePath, ORCHESTRATOR_SKILL_DIR);
    try {
      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        ctx.logInfo(`Removed projected orchestrator skill directory: ${ORCHESTRATOR_SKILL_DIR}`);
      }
    } catch {
      // Non-fatal: directory may already be gone
    }
  }

  private noEvidenceError(): string {
    return (
      'No work evidence produced. The node must either:\n' +
      '  1. Modify files (results in a commit)\n' +
      '  2. Create an evidence file at .orchestrator/evidence/<nodeId>.json\n' +
      '  3. Declare expectsNoChanges: true in the node spec'
    );
  }

  private async getGitStatus(cwd: string): Promise<string | null> {
    try {
      const dirtyFiles = await this.git.repository.getDirtyFiles(cwd);
      if (dirtyFiles.length === 0) {return null;}
      return dirtyFiles.map(file => `M  ${file}`).join('\n');
    } catch {
      return null;
    }
  }

  private async getIgnoredFiles(cwd: string): Promise<string | null> {
    try {
      // TODO: Add getIgnoredFiles to IGitOperations interface
      // const ignoredFiles = await this.git.repository.getIgnoredFiles(cwd);
      const ignoredFiles: string[] = []; // Temporary placeholder
      if (ignoredFiles.length === 0) {return null;}
      const limitedFiles = ignoredFiles.slice(0, 50);
      const result = limitedFiles.join('\n');
      return limitedFiles.length === 50 ? result + '\n... (truncated)' : result;
    } catch {
      return null;
    }
  }

  private async aiReviewNoChanges(
    node: JobNode,
    worktreePath: string,
    ctx: CommitPhaseContext,
  ): Promise<{ legitimate: boolean; reason: string; metrics?: CopilotUsageMetrics }> {
    try {
      const logs = ctx.getExecutionLogs();
      const logText = logs
        .map(e => `[${e.phase}] [${e.type}] ${e.message}`)
        .join('\n');
      const logLines = logText.split('\n');
      const truncatedLogs = logLines.length > 150
        ? `... (${logLines.length - 150} earlier lines omitted)\n` + logLines.slice(-150).join('\n')
        : logText;

      const workDesc = (() => {
        const spec = normalizeWorkSpec(node.work);
        if (!spec) {return 'No work specified';}
        if (spec.type === 'shell') {return `Shell: ${spec.command}`;}
        if (spec.type === 'process') {return `Process: ${spec.executable} ${(spec.args || []).join(' ')}`;}
        if (spec.type === 'agent') {return `Agent: ${spec.instructions.slice(0, 200)}`;}
        return 'Unknown work type';
      })();

      const taskDescription = `Node: ${node.name}\nTask: ${node.task}\nWork: ${workDesc}`;

      ctx.logInfo('========== AI REVIEW: NO-CHANGE ASSESSMENT ==========');

      const configDir = this.getCopilotConfigDir(worktreePath);

      const aiInstructions = `# AI Review: No-Change Assessment

## Task
You are reviewing the execution logs of an agent that completed without making file changes.
Determine if this is a legitimate outcome or if the agent failed to do its work.

## Original Task Description
${taskDescription}

## Execution Logs
\`\`\`
${truncatedLogs}
\`\`\`

## Your Response
**IMPORTANT: Respond ONLY with a JSON object. No markdown, no explanation, no HTML.**

Analyze the logs and respond with exactly this format:
\`\`\`json
{"legitimate": true, "reason": "Brief explanation why no changes were needed"}
\`\`\`
OR
\`\`\`json
{"legitimate": false, "reason": "Brief explanation of what went wrong"}
\`\`\`

### Legitimate No-Change Scenarios
- Work was already completed in a prior commit/dependency
- Task was verification/analysis only (no changes expected)
- Agent correctly determined no changes were needed

### NOT Legitimate (should return false)
- Agent encountered errors and gave up
- Agent misunderstood the task
- Agent claimed success without evidence
- Logs show the agent didn't attempt the work

**YOUR RESPONSE (JSON ONLY):**`;

      const result = await this.agentDelegator.delegate({
        task: 'Complete the task described in the instructions.',
        instructions: aiInstructions,
        worktreePath,
        model: 'claude-haiku-4.5',
        jobId: node.id,
        configDir,
        logOutput: (line: string) => ctx.logInfo(`[ai-review] ${line}`),
        onProcess: () => {},
      });

      ctx.logInfo('========== AI REVIEW: COMPLETE ==========');

      const reviewMetrics = result.metrics;

      if (!result.success) {
        ctx.logInfo(
          `AI review could not complete: ${result.error}. Falling through to standard validation.`,
        );
        return { legitimate: false, reason: 'AI review unavailable', metrics: reviewMetrics };
      }

      // Parse AI judgment from logs
      const reviewLogs = ctx.getExecutionLogs()
        .filter(e => e.phase === 'commit' && e.message.includes('[ai-review]'))
        .map(e => e.message);

      for (let i = reviewLogs.length - 1; i >= 0; i--) {
        const parsed = parseAiReviewResult(reviewLogs[i]);
        if (parsed) {
          return { legitimate: parsed.legitimate, reason: parsed.reason, metrics: reviewMetrics };
        }
      }

      const combinedOutput = reviewLogs.join(' ');
      const parsed = parseAiReviewResult(combinedOutput);
      if (parsed) {
        return { legitimate: parsed.legitimate, reason: parsed.reason, metrics: reviewMetrics };
      }

      ctx.logInfo('AI review did not return a parseable judgment. Falling through to standard validation.');
      return { legitimate: false, reason: 'AI review returned no parseable judgment', metrics: reviewMetrics };
    } catch (error: any) {
      ctx.logInfo(`AI review error: ${error.message}. Falling through to standard validation.`);
      return { legitimate: false, reason: `AI review error: ${error.message}` };
    }
  }
}
