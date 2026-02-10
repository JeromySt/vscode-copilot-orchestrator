/**
 * @fileoverview Unified Copilot CLI Runner
 * 
 * Single abstraction for all Copilot CLI interactions. Handles:
 * - Writing .github/instructions/*.instructions.md files
 * - Building and executing copilot CLI commands
 * - Capturing session IDs from output
 * - Cleanup of temporary files
 * 
 * All code that needs to invoke Copilot CLI should use this module.
 * 
 * @module agent/copilotCliRunner
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { isCopilotCliAvailable } from './cliCheckCore';
import { CopilotStatsParser } from './copilotStatsParser';
import type { CopilotUsageMetrics } from '../plan/types';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for running Copilot CLI.
 */
export interface CopilotRunOptions {
  /** The working directory (typically a worktree path) */
  cwd: string;
  
  /** The task/prompt to execute */
  task: string;
  
  /** Additional instructions or context */
  instructions?: string;
  
  /** Label for logging purposes */
  label?: string;
  
  /** Resume an existing session */
  sessionId?: string;
  
  /** LLM model to use (e.g., 'claude-sonnet-4.5', 'gpt-5') */
  model?: string;
  
  /** Directory for Copilot logs */
  logDir?: string;
  
  /** Path to write session share file */
  sharePath?: string;
  
  /** Callback for output lines */
  onOutput?: (line: string) => void;
  
  /** Callback when process is spawned */
  onProcess?: (proc: ChildProcess) => void;
  
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
  
  /** Skip writing instructions file (for simple one-off prompts) */
  skipInstructionsFile?: boolean;
  
  /** Unique job/node ID to disambiguate instructions files across concurrent jobs */
  jobId?: string;
}

/**
 * Result from running Copilot CLI.
 */
export interface CopilotRunResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  exitCode?: number;
  /** Usage metrics parsed from Copilot CLI stdout (premium requests, tokens, model breakdown, etc.) */
  metrics?: CopilotUsageMetrics;
}

/**
 * Logger interface for dependency injection.
 */
export interface CopilotCliLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// ============================================================================
// DEFAULT LOGGER
// ============================================================================

const noopLogger: CopilotCliLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ============================================================================
// COPILOT CLI RUNNER
// ============================================================================

/**
 * Unified runner for Copilot CLI operations.
 */
export class CopilotCliRunner {
  private logger: CopilotCliLogger;
  
  constructor(logger?: CopilotCliLogger) {
    this.logger = logger ?? noopLogger;
  }
  
  /**
   * Check if Copilot CLI is available.
   */
  isAvailable(): boolean {
    return isCopilotCliAvailable();
  }
  
  /**
   * Run Copilot CLI with the given options.
   */
  async run(options: CopilotRunOptions): Promise<CopilotRunResult> {
    const {
      cwd,
      task,
      instructions,
      label = 'copilot',
      sessionId,
      model,
      logDir,
      sharePath,
      onOutput,
      onProcess,
      timeout = 300000, // 5 minutes default
      skipInstructionsFile = false,
    } = options;
    
    // Check if Copilot CLI is available
    if (!this.isAvailable()) {
      this.logger.warn(`[${label}] Copilot CLI not available`);
      return { success: true }; // Silent success - work can be done manually
    }
    
    // Setup instructions file if not skipped
    let instructionsFile: string | undefined;
    let instructionsDir: string | undefined;
    
    if (!skipInstructionsFile) {
      const instructionsSetup = this.writeInstructionsFile(cwd, task, instructions, label, options.jobId);
      instructionsFile = instructionsSetup.filePath;
      instructionsDir = instructionsSetup.dirPath;
    }
    
    // Build the command
    const copilotCmd = this.buildCommand({
      task: skipInstructionsFile ? task : 'Complete the task described in the instructions.',
      sessionId,
      model,
      logDir,
      sharePath,
    });
    
    this.logger.info(`[${label}] Running: ${copilotCmd.substring(0, 100)}...`);
    
    // Execute and return result
    try {
      const result = await this.execute({
        command: copilotCmd,
        cwd,
        label,
        sessionId,
        timeout,
        onOutput,
        onProcess,
      });
      
      return result;
    } finally {
      // Cleanup instructions file
      if (instructionsFile) {
        this.cleanupInstructionsFile(instructionsFile, instructionsDir, label);
      }
    }
  }
  
  /**
   * Write instructions to .github/instructions/ in the working directory.
   * Public so callers with custom execution needs can still use standardized instructions.
   */
  writeInstructionsFile(
    cwd: string,
    task: string,
    instructions: string | undefined,
    label: string,
    jobId?: string
  ): { filePath: string; dirPath: string } {
    const instructionsDir = path.join(cwd, '.github', 'instructions');
    const suffix = jobId ? `-${jobId.slice(0, 8)}` : '';
    const instructionsFile = path.join(instructionsDir, `orchestrator-job${suffix}.instructions.md`);
    
    // Get the worktree folder name for scoping
    const worktreeName = path.basename(cwd);
    const worktreeParent = path.basename(path.dirname(cwd));
    const applyToScope = `${worktreeParent}/${worktreeName}/**`;
    
    // Build instructions content with frontmatter
    const content = `---
applyTo: '${applyToScope}'
---

# Current Task

${task}

${instructions ? `## Additional Context\n\n${instructions}` : ''}

## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
`;
    
    try {
      fs.mkdirSync(instructionsDir, { recursive: true });
      fs.writeFileSync(instructionsFile, content, 'utf8');
      this.logger.info(`[${label}] Wrote instructions to: ${instructionsFile}`);
    } catch (e) {
      this.logger.warn(`[${label}] Failed to write instructions file: ${e}`);
    }
    
    return { filePath: instructionsFile, dirPath: instructionsDir };
  }
  
  /**
   * Build the Copilot CLI command string.
   * Public so callers with custom execution needs can build standardized commands.
   */
  buildCommand(options: {
    task: string;
    sessionId?: string;
    model?: string;
    logDir?: string;
    sharePath?: string;
  }): string {
    const { task, sessionId, model, logDir, sharePath } = options;
    
    let cmd = `copilot -p ${JSON.stringify(task)} --stream off --allow-all-paths --allow-all-urls --allow-all-tools`;
    
    if (model) {
      cmd += ` --model ${model}`;
    }
    
    if (logDir) {
      cmd += ` --log-dir ${JSON.stringify(logDir)} --log-level debug`;
    }
    
    if (sharePath) {
      cmd += ` --share ${JSON.stringify(sharePath)}`;
    }
    
    if (sessionId) {
      cmd += ` --resume ${sessionId}`;
    }
    
    return cmd;
  }
  
  /**
   * Execute the Copilot CLI command.
   */
  private execute(options: {
    command: string;
    cwd: string;
    label: string;
    sessionId?: string;
    timeout: number;
    onOutput?: (line: string) => void;
    onProcess?: (proc: ChildProcess) => void;
  }): Promise<CopilotRunResult> {
    const { command, cwd, label, sessionId, timeout, onOutput, onProcess } = options;
    
    return new Promise((resolve) => {
      const proc = spawn(command, [], {
        cwd,
        shell: true,
      });
      
      let capturedSessionId: string | undefined = sessionId;
      const statsParser = new CopilotStatsParser();

      // Track whether Copilot printed its completion marker ("Task complete").
      // On Windows, shell:true spawns nested cmd.exe wrappers whose exit-code
      // propagation can break, producing code=null/signal=null even though the
      // CLI finished normally.  When we see the marker we treat null as success.
      let sawTaskComplete = false;
      
      // Notify process spawned
      if (proc.pid) {
        this.logger.info(`[${label}] Copilot PID: ${proc.pid}`);
        onProcess?.(proc);
      }
      
      // Extract session ID from output
      const extractSession = (text: string) => {
        if (capturedSessionId) return;
        const match = text.match(/Session ID[:\s]+([a-f0-9-]{36})/i) ||
                     text.match(/session[:\s]+([a-f0-9-]{36})/i) ||
                     text.match(/Starting session[:\s]+([a-f0-9-]{36})/i);
        if (match) {
          capturedSessionId = match[1];
          this.logger.info(`[${label}] Captured session ID: ${capturedSessionId}`);
        }
      };
      
      // Handle stdout
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        text.split('\n').forEach(line => {
          if (line.trim()) {
            this.logger.debug(`[${label}] ${line.trim()}`);
            statsParser.feedLine(line.trim());
            onOutput?.(line.trim());
            // Detect Copilot completion marker
            if (!sawTaskComplete && line.includes('Task complete')) {
              sawTaskComplete = true;
            }
          }
        });
        extractSession(text);
      });
      
      // Handle stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        text.split('\n').forEach(line => {
          if (line.trim()) {
            this.logger.debug(`[${label}] ${line.trim()}`);
            statsParser.feedLine(line.trim());
            onOutput?.(line.trim());
          }
        });
        extractSession(text);
      });
      
      // Handle exit
      proc.on('exit', (code, signal) => {
        // On Windows, nested cmd.exe wrapper chains can exit with
        // code=null & signal=null even after a normal completion.  When
        // the completion marker was observed in stdout, treat null as 0.
        const effectiveCode = (code === null && signal === null && sawTaskComplete) ? 0 : code;

        // Extract metrics parsed from stdout
        const metrics = statsParser.getMetrics();
        // Backfill legacy tokenUsage from model breakdown if available
        if (metrics && !metrics.tokenUsage && metrics.modelBreakdown?.length) {
          const totals = metrics.modelBreakdown.reduce(
            (acc, m) => ({ input: acc.input + m.inputTokens, output: acc.output + m.outputTokens }),
            { input: 0, output: 0 }
          );
          metrics.tokenUsage = {
            inputTokens: totals.input,
            outputTokens: totals.output,
            totalTokens: totals.input + totals.output,
            model: metrics.modelBreakdown[0].model,
          };
        }

        if (effectiveCode !== 0) {
          const reason = signal
            ? `Copilot CLI was killed by signal ${signal} (PID ${proc.pid})`
            : `Copilot CLI exited with code ${effectiveCode}`;
          this.logger.error(`[${label}] ${reason}, code=${code}, signal=${signal}, sawTaskComplete=${sawTaskComplete}`);
          resolve({
            success: false,
            sessionId: capturedSessionId,
            error: reason,
            exitCode: effectiveCode ?? undefined,
            metrics,
          });
        } else {
          if (code === null) {
            this.logger.info(`[${label}] Copilot CLI completed (exit code null coerced to 0 — task completion marker was present)`);
          } else {
            this.logger.info(`[${label}] Copilot CLI completed successfully`);
          }
          resolve({
            success: true,
            sessionId: capturedSessionId,
            exitCode: 0,
            metrics,
          });
        }
      });
      
      // Handle spawn error
      proc.on('error', (err) => {
        this.logger.error(`[${label}] Copilot CLI error: ${err.message}`);
        resolve({
          success: false,
          error: err.message,
        });
      });
    });
  }
  
  /**
   * Clean up the instructions file after execution.
   * Public so callers with custom execution can clean up properly.
   */
  cleanupInstructionsFile(
    filePath: string,
    dirPath: string | undefined,
    label: string
  ): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`[${label}] Cleaned up instructions file`);
        
        // Try to remove directory if empty
        if (dirPath) {
          try {
            const files = fs.readdirSync(dirPath);
            if (files.length === 0) {
              fs.rmdirSync(dirPath);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      this.logger.warn(`[${label}] Failed to cleanup instructions file: ${e}`);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let defaultRunner: CopilotCliRunner | undefined;

/**
 * Get or create the default Copilot CLI runner.
 */
export function getCopilotCliRunner(logger?: CopilotCliLogger): CopilotCliRunner {
  if (!defaultRunner) {
    defaultRunner = new CopilotCliRunner(logger);
  }
  return defaultRunner;
}

/**
 * Convenience function to run Copilot CLI with default runner.
 */
export async function runCopilotCli(
  options: CopilotRunOptions,
  logger?: CopilotCliLogger
): Promise<CopilotRunResult> {
  const runner = getCopilotCliRunner(logger);
  return runner.run(options);
}
