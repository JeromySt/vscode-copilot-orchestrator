/**
 * @fileoverview Interface for Copilot CLI runner abstraction.
 * 
 * Decouples consumers from the concrete CopilotCliRunner implementation,
 * enabling dependency injection and unit testing with mock runners.
 * 
 * @module interfaces/ICopilotRunner
 */

import type { CopilotRunOptions, CopilotRunResult } from '../agent/copilotCliRunner';

/**
 * Interface for running Copilot CLI commands.
 * 
 * @example
 * ```typescript
 * // Phase executors inject ICopilotRunner directly:
 * class WorkPhaseExecutor {
 *   constructor(private readonly runner: ICopilotRunner) {}
 *   
 *   async runAgent(spec: AgentSpec): Promise<PhaseResult> {
 *     const result = await this.runner.run({ cwd: spec.worktreePath, task: spec.instructions });
 *     return { success: result.success };
 *   }
 * }
 * ```
 */
export interface ICopilotRunner {
  /**
   * Run Copilot CLI with the given options.
   */
  run(options: CopilotRunOptions): Promise<CopilotRunResult>;

  /**
   * Check if Copilot CLI is available.
   */
  isAvailable(): boolean;

  /**
   * Write instructions to .github/instructions/ in the working directory.
   */
  writeInstructionsFile(
    cwd: string,
    task: string,
    instructions: string | undefined,
    label: string,
    jobId?: string
  ): { filePath: string; dirPath: string };

  /**
   * Build the Copilot CLI command string.
   */
  buildCommand(options: {
    task: string;
    sessionId?: string;
    model?: string;
    logDir?: string;
    sharePath?: string;
    cwd?: string;
    allowedFolders?: string[];
    allowedUrls?: string[];
    effort?: 'low' | 'medium' | 'high' | 'xhigh';
  }): any;

  /**
   * Clean up the instructions file after execution.
   */
  cleanupInstructionsFile(
    filePath: string,
    dirPath: string | undefined,
    label: string
  ): void;
}
