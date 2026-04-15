/**
 * @fileoverview Commit Phase Executor
 *
 * Handles the commit phase: validates evidence of work, stages and
 * commits changes, and optionally invokes AI review when no file
 * changes are detected.
 *
 * Also implements checkpoint artifact handling per CONTEXT_PRESSURE_DESIGN.md §6.4:
 * - Phase 1: Pre-commit sentinel/manifest detection (4-state matrix)
 * - Phase 2: Post-commit cleanup of consumed checkpoint artifacts
 *
 * @module plan/phases/commitPhase
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';
import type { IEvidenceValidator } from '../../interfaces/IEvidenceValidator';
import type { ICopilotRunner } from '../../interfaces/ICopilotRunner';
import type {
  JobNode,
  LogEntry,
  CopilotUsageMetrics,
} from '../types';
import { normalizeWorkSpec } from '../types';
import type { IGitOperations } from '../../interfaces/IGitOperations';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { parseAiReviewResult } from '../aiReviewUtils';
import { ORCHESTRATOR_SKILL_DIR } from './setupPhase';

// Checkpoint artifact paths (relative to worktree root)
const CHECKPOINT_SENTINEL_REL = path.join('.orchestrator', 'CHECKPOINT_REQUIRED');
const CHECKPOINT_MANIFEST_REL = path.join('.orchestrator', 'checkpoint-manifest.json');
const INSTRUCTIONS_DIR_REL = path.join('.github', 'instructions');

/**
 * Checkpoint detection states from the sentinel/manifest matrix.
 * @see docs/CONTEXT_PRESSURE_DESIGN.md §6.4
 */
type CheckpointMode = 'checkpointing' | 'consuming' | 'normal' | 'failed';

/**
 * Extended context for the commit phase (adds access to execution logs
 * and an AI-review agent delegator).
 */
export interface CommitPhaseContext extends PhaseContext {
  /** Get execution logs for AI review */
  getExecutionLogs: () => LogEntry[];
  /** Get the log file path for the current execution (for granting AI review access) */
  getLogFilePath?: () => string | undefined;
  /** Async callback to read the work spec from disk (avoids in-memory hydration) */
  getWorkSpec?: () => Promise<any>;
}

/**
 * Executes the commit phase of a job node.
 */
export class CommitPhaseExecutor implements IPhaseExecutor {
  private evidenceValidator: IEvidenceValidator;
  private copilotRunner?: ICopilotRunner;
  private git: IGitOperations;
  private fileSystem?: IFileSystem;

  constructor(deps: {
    evidenceValidator: IEvidenceValidator;
    copilotRunner?: ICopilotRunner;
    git: IGitOperations;
    fileSystem?: IFileSystem;
  }) {
    this.evidenceValidator = deps.evidenceValidator;
    this.copilotRunner = deps.copilotRunner;
    this.git = deps.git;
    this.fileSystem = deps.fileSystem;
  }

  async execute(context: PhaseContext): Promise<PhaseResult> {
    const ctx = context as CommitPhaseContext;
    const { node, worktreePath } = ctx;

    try {
      // --- Phase 1: Checkpoint sentinel/manifest detection (§6.4) ---
      const checkpointMode = await this.detectCheckpointMode(worktreePath, ctx);
      if (checkpointMode === 'failed') {
        return {
          success: false,
          error: 'Checkpoint sentinel present but no manifest written. ' +
            'The agent must create .orchestrator/checkpoint-manifest.json with completed/remaining ' +
            'work details and force-add it to git before committing.',
        };
      }

      // --- Core commit logic ---
      const result = await this.executeCommitCore(ctx);

      // --- Phase 2: Post-commit cleanup for consuming mode (§6.4) ---
      // Consuming = sub-job that inherited artifacts via FI from parent.
      // After the work commit, clean artifacts from the commit tree so they
      // don't pollute downstream FI merges. The cleanup commit becomes the
      // completedCommit for merge-ri.
      if (checkpointMode === 'consuming' && result.success && result.commit) {
        const cleanupCommit = await this.cleanupConsumedArtifacts(worktreePath, node.id, ctx);
        if (cleanupCommit) {
          result.commit = cleanupCommit;
        }
      }

      return result;
    } catch (error: any) {
      ctx.logError(`Commit error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ---------- Core commit logic ----------

  private async executeCommitCore(ctx: CommitPhaseContext): Promise<PhaseResult> {
    const { node, worktreePath, baseCommit } = ctx;

    // Remove projected orchestrator skill directory before staging
    this.removeOrchestratorSkillDir(worktreePath, ctx);
    // Remove .copilot-cli session state that copilot-cli may create in cwd despite --config-dir
    this.removeCopilotCliDir(worktreePath, ctx);

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
      if (this.copilotRunner) {
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
  }

  // ---------- Checkpoint artifact handling ----------

  /**
   * Detect the checkpoint mode from the sentinel/manifest matrix.
   *
   * | Sentinel | Manifest | Mode          | Action                        |
   * |----------|----------|---------------|-------------------------------|
   * | YES      | YES      | checkpointing | Keep artifacts for sub-jobs   |
   * | NO       | YES      | consuming     | git rm + cleanup commit       |
   * | NO       | NO       | normal        | No action                     |
   * | YES      | NO       | failed        | Fail — agent didn't write manifest |
   */
  private async detectCheckpointMode(
    worktreePath: string,
    ctx: CommitPhaseContext,
  ): Promise<CheckpointMode> {
    if (!this.fileSystem) {
      return 'normal';
    }

    const sentinelPath = path.join(worktreePath, CHECKPOINT_SENTINEL_REL);
    const manifestPath = path.join(worktreePath, CHECKPOINT_MANIFEST_REL);

    const hasSentinel = await this.fileSystem.existsAsync(sentinelPath);
    const hasManifest = await this.fileSystem.existsAsync(manifestPath);

    if (hasSentinel && hasManifest) {
      ctx.logInfo('Checkpoint mode: preserving artifacts (will flow to sub-jobs via FI merge)');
      return 'checkpointing';
    }
    if (hasSentinel && !hasManifest) {
      ctx.logInfo('Checkpoint sentinel present but no manifest — failing commit phase');
      return 'failed';
    }
    if (!hasSentinel && hasManifest) {
      ctx.logInfo('Consuming mode: will clean up checkpoint artifacts after commit');
      return 'consuming';
    }
    return 'normal';
  }

  /**
   * Remove consumed checkpoint artifacts from the commit tree via `git rm`
   * and create a dedicated cleanup commit. This cleanup commit becomes the
   * completedCommit for merge-ri.
   *
   * Artifacts removed:
   * - `.orchestrator/checkpoint-manifest.json`
   * - `.github/instructions/orchestrator-job-*.instructions.md` (except this job's own file)
   *
   * @returns The cleanup commit SHA, or undefined if no cleanup was needed.
   */
  private async cleanupConsumedArtifacts(
    worktreePath: string,
    nodeId: string,
    ctx: CommitPhaseContext,
  ): Promise<string | undefined> {
    try {
      ctx.logInfo('Cleaning up consumed checkpoint artifacts (consuming mode)');

      const artifactsToRemove: string[] = [];

      // 1. Checkpoint manifest
      const manifestAbsPath = path.join(worktreePath, CHECKPOINT_MANIFEST_REL);
      if (this.fileSystem && await this.fileSystem.existsAsync(manifestAbsPath)) {
        artifactsToRemove.push(CHECKPOINT_MANIFEST_REL);
      }

      // 2. Parent instruction files (orchestrator-job-*.instructions.md)
      //    Filter out THIS job's instruction file — don't remove own instructions.
      const instrDirAbs = path.join(worktreePath, INSTRUCTIONS_DIR_REL);
      try {
        if (this.fileSystem && await this.fileSystem.existsAsync(instrDirAbs)) {
          const files = await this.fileSystem.readdirAsync(instrDirAbs);
          const ownSuffix = nodeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-12);
          for (const file of files) {
            if (file.startsWith('orchestrator-job') && file.endsWith('.instructions.md')) {
              if (!ownSuffix || !file.includes(ownSuffix)) {
                artifactsToRemove.push(path.join(INSTRUCTIONS_DIR_REL, file));
              }
            }
          }
        }
      } catch {
        // Instructions directory may not exist — non-fatal
      }

      if (artifactsToRemove.length === 0) {
        ctx.logInfo('No checkpoint artifacts found to clean up');
        return undefined;
      }

      // 3. git rm all consumed artifacts (removes from both worktree and index)
      for (const relPath of artifactsToRemove) {
        try {
          await this.git.command.execAsync(
            ['rm', '-f', '--', relPath.replace(/\\/g, '/')],
            { cwd: worktreePath },
          );
        } catch {
          // File may not be tracked in git — non-fatal
        }
      }

      // 4. Dedicated cleanup commit
      const hasStaged = await this.git.repository.hasStagedChanges(worktreePath);
      if (hasStaged) {
        await this.git.repository.commit(
          worktreePath,
          '[orchestrator:cleanup] Remove consumed checkpoint artifacts',
        );
        const commit = await this.git.worktrees.getHeadCommit(worktreePath);
        ctx.logInfo(
          `Cleanup commit: ${commit?.slice(0, 8)}, removed ${artifactsToRemove.length} artifact(s): ` +
          artifactsToRemove.map(f => path.basename(f)).join(', '),
        );
        return commit || undefined;
      }

      ctx.logInfo('No staged changes after git rm — artifacts may not have been tracked');
      return undefined;
    } catch (error: any) {
      ctx.logError(`Checkpoint artifact cleanup failed: ${error.message}`);
      return undefined;
    }
  }

  // ---------- private helpers ----------

  // Direct fs usage: Non-fatal worktree cleanup before commit (approved exception — see code-review.instructions.md)
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

  private removeCopilotCliDir(worktreePath: string, ctx: CommitPhaseContext): void {
    const copilotCliDir = path.join(worktreePath, '.copilot-cli');
    try {
      if (fs.existsSync(copilotCliDir)) {
        fs.rmSync(copilotCliDir, { recursive: true, force: true });
        ctx.logInfo('Removed .copilot-cli directory leaked by copilot-cli into worktree');
      }
    } catch {
      // Non-fatal
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

      const workDesc = await (async () => {
        const resolvedWork = node.work || (ctx.getWorkSpec ? await ctx.getWorkSpec() : undefined);
        const spec = normalizeWorkSpec(resolvedWork);
        if (!spec) {return 'No work specified';}
        if (spec.type === 'shell') {return `Shell: ${spec.command}`;}
        if (spec.type === 'process') {return `Process: ${spec.executable} ${(spec.args || []).join(' ')}`;}
        if (spec.type === 'agent') {return `Agent: ${spec.instructions.slice(0, 200)}`;}
        return 'Unknown work type';
      })();

      const taskDescription = `Node: ${node.name}\nTask: ${node.task}\nWork: ${workDesc}`;

      ctx.logInfo('========== AI REVIEW: NO-CHANGE ASSESSMENT ==========');

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

      // Grant the AI reviewer read access to the attempt log directory so it can
      // inspect execution logs for diagnostic context.
      const logFilePath = ctx.getLogFilePath?.();
      const logDir = logFilePath ? path.dirname(logFilePath) : undefined;

      const result = await this.copilotRunner!.run({
        task: 'Complete the task described in the instructions.',
        instructions: aiInstructions,
        cwd: worktreePath,
        model: 'claude-haiku-4.5',
        jobId: node.id,
        allowedFolders: logDir ? [logDir] : undefined,
        timeout: 0,
        onOutput: (line: string) => ctx.logInfo(`[ai-review] ${line}`),
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
