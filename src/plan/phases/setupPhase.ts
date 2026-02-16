/**
 * @fileoverview Setup Phase Executor
 *
 * Handles the setup phase: writes a projected orchestrator skill file
 * (`.github/skills/.orchestrator/SKILL.md`) into the worktree so that
 * downstream agent phases can discover worktree-specific context via the
 * standard skill-discovery mechanism.
 *
 * The skill file is ephemeral — it is removed by the commit phase before
 * staging so it never lands in a commit.
 *
 * @module plan/phases/setupPhase
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IPhaseExecutor, PhaseContext, PhaseResult } from '../../interfaces/IPhaseExecutor';

/** Directory path (relative to worktree root) for the projected skill. */
export const ORCHESTRATOR_SKILL_DIR = path.join('.github', 'skills', '.orchestrator');

/** Full relative path to the projected SKILL.md. */
export const ORCHESTRATOR_SKILL_PATH = path.join(ORCHESTRATOR_SKILL_DIR, 'SKILL.md');

/**
 * Build the SKILL.md content for the orchestrator projected skill.
 *
 * @param node - The job node being executed.
 * @param worktreePath - Resolved worktree path.
 * @param projectWorktreeContext - Whether to include worktree context.
 * @returns Markdown string with YAML frontmatter.
 */
export function buildSkillContent(
  node: { id: string; name: string; task: string },
  worktreePath: string,
  projectWorktreeContext: boolean,
): string {
  const lines: string[] = [
    '---',
    'name: orchestrator-context',
    'description: Provides worktree and job context for the current orchestrator execution.',
    '---',
    '',
    '# Orchestrator Context',
    '',
    `**Job:** ${node.name}`,
    `**Task:** ${node.task}`,
    `**Node ID:** ${node.id}`,
  ];

  if (projectWorktreeContext) {
    lines.push('', `**Worktree Path:** ${worktreePath}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Executes the setup phase of a job node.
 *
 * Writes the projected orchestrator skill file into the worktree so that
 * skill-aware agents can discover job/worktree context.
 */
export class SetupPhaseExecutor implements IPhaseExecutor {
  private configManager?: any;

  constructor(deps: { configManager?: any }) {
    this.configManager = deps.configManager;
  }

  async execute(context: PhaseContext): Promise<PhaseResult> {
    const { node, worktreePath } = context;

    try {
      const projectWorktreeContext: boolean =
        this.configManager?.getConfig(
          'copilotOrchestrator.instructionEnrichment',
          'projectWorktreeContext',
          true,
        ) ?? true;

      const skillDir = path.join(worktreePath, ORCHESTRATOR_SKILL_DIR);
      const skillPath = path.join(worktreePath, ORCHESTRATOR_SKILL_PATH);

      context.logInfo(`Writing projected orchestrator skill to ${ORCHESTRATOR_SKILL_PATH}`);
      fs.mkdirSync(skillDir, { recursive: true });

      const content = buildSkillContent(node, worktreePath, projectWorktreeContext);
      fs.writeFileSync(skillPath, content, 'utf-8');

      context.logInfo('Setup phase complete');
      return { success: true };
    } catch (error: any) {
      context.logError(`Setup phase error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
