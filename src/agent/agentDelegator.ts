/**
 * @fileoverview AI Agent delegation functionality.
 * 
 * Handles delegation of tasks to GitHub Copilot CLI or other AI agents.
 * Manages session tracking, process monitoring, and output streaming.
 * 
 * @module agent/agentDelegator
 */

import * as fs from 'fs';
import * as path from 'path';
import { isCopilotCliAvailable } from './cliCheckCore';
import { CopilotCliRunner, CopilotCliLogger } from './copilotCliRunner';
import { isValidModel } from './modelDiscovery';
import type { IGitOperations } from '../interfaces/IGitOperations';
import { TokenUsage, CopilotUsageMetrics } from '../plan/types';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import type { IFileSystem } from '../interfaces/IFileSystem';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Delegate options for agent task delegation.
 */
export interface DelegateOptions {
  /** Unique job identifier */
  jobId: string;
  /** Human-readable task description */
  taskDescription: string;
  /** Step label (e.g., 'work', 'postchecks') */
  label: string;
  /** Path to the worktree directory */
  worktreePath: string;
  /** Base branch name */
  baseBranch: string;
  /** Target branch name */
  targetBranch: string;
  /** Additional instructions */
  instructions?: string;
  /** Existing Copilot session ID to resume */
  sessionId?: string;
  /** Model to use for the AI agent */
  model?: string;
  
  /**
   * Additional folder paths the agent is allowed to access beyond the worktree.
   * 
   * **Security Consideration**: By default, the agent is sandboxed to only access
   * files within `worktreePath`. This provides isolation between concurrent jobs
   * and prevents unintended modifications to other areas of the repository.
   * 
   * Specify absolute paths here to grant access to shared resources (e.g., shared
   * libraries, config files, build tools). Each path is validated and passed to
   * the Copilot CLI via the `--allow-paths` flag.
   * 
   * **Principle of Least Privilege**: Only add folders that this delegation truly
   * needs for its specific task.
   * 
   * @example
   * ```typescript
   * allowedFolders: [
   *   '/repo/shared/utilities',
   *   '/repo/shared/styles'
   * ]
   * ```
   */
  allowedFolders?: string[];
  /**
   * Additional URLs the agent is allowed to access.
   * 
   * **Security Consideration**: By default, the agent has no network access.
   * This provides isolation and prevents unintended network requests.
   * 
   * Specify URLs here to grant network access to specific domains/endpoints.
   * Each URL is validated and passed to the Copilot CLI via the `--allow-url` flag.
   * 
   * **Principle of Least Privilege**: Only add URLs that this delegation truly
   * needs for its specific task.
   * 
   * @example
   * ```typescript
   * allowedUrls: [
   *   'https://api.github.com',
   *   'https://registry.npmjs.org'
   * ]
   * ```
   */
  allowedUrls?: string[];
  /**
   * Config directory for Copilot CLI.
   * 
   * Stores sessions and configuration in a worktree-local directory instead of the user's
   * home directory. This enables:
   * 
   * - **Worktree-Local Storage**: Session state and configuration are scoped to this job's
   *   worktree, enabling multiple concurrent jobs without conflicts
   * - **Job Isolation**: Each delegated task has its own isolated session state
   * - **Clean Shutdown**: When the worktree is cleaned up, all session files are automatically
   *   removed with it
   */
  /** Override the Copilot CLI --config-dir. If set, used instead of the worktree-derived default. */
  configDir?: string;
  /** Additional environment variables to inject into the spawned agent process */
  env?: Record<string, string>;
  /** Callback for writing lines to the execution log (separate from the delegator's internal logger) */
  logOutput?: (line: string) => void;
  /** Callback when the agent process is spawned */
  onProcess?: (proc: any) => void;
}

/**
 * Result of an agent delegation.
 */
export interface DelegateResult {
  /** Whether the delegation succeeded */
  success: boolean;
  /** Copilot session ID (if captured) */
  sessionId?: string;
  /** Error message (if failed) */
  error?: string;
  /** Exit code from the process */
  exitCode?: number;
  /**
   * Token usage metrics (if extracted from logs).
   * @deprecated Use {@link metrics} instead.
   */
  tokenUsage?: TokenUsage;
  /** Rich usage metrics parsed from Copilot CLI stdout */
  metrics?: CopilotUsageMetrics;
}

/**
 * Logger interface for writing messages.
 */
export interface DelegatorLogger {
  log(message: string): void;
}

/**
 * Callbacks for delegation events.
 */
export interface DelegatorCallbacks {
  /** Called when a process is spawned */
  onProcessSpawned?: (pid: number) => void;
  /** Called when a process exits */
  onProcessExited?: (pid: number) => void;
  /** Called when session ID is captured */
  onSessionCaptured?: (sessionId: string) => void;
}

// ============================================================================
// AGENT DELEGATOR CLASS
// ============================================================================

/**
 * Handles delegation of tasks to AI agents.
 * 
 * Supports both manual delegation (creates task file) and automated
 * delegation via GitHub Copilot CLI.
 * 
 * @example
 * ```typescript
 * const delegator = new AgentDelegator(logger, callbacks);
 * const result = await delegator.delegate({
 *   jobId: 'abc123',
 *   taskDescription: 'Implement feature X',
 *   label: 'work',
 *   worktreePath: '/path/to/worktree',
 *   baseBranch: 'main',
 *   targetBranch: 'feature/x'
 * });
 * ```
 */
export class AgentDelegator {
  private readonly logger: DelegatorLogger;
  private readonly callbacks: DelegatorCallbacks;
  private readonly runner?: ICopilotRunner;
  private readonly gitOps: IGitOperations;

  /**
   * Create a new agent delegator.
   * 
   * @param logger - Logger for output messages
   * @param callbacks - Optional callbacks for delegation events
   * @param runner - Optional ICopilotRunner (defaults to new CopilotCliRunner)
   * @param gitOps - Git operations interface
   */
  constructor(
    logger: DelegatorLogger,
    gitOps: IGitOperations,
    callbacks: DelegatorCallbacks = {},
    runner?: ICopilotRunner
  ) {
    this.logger = logger;
    this.callbacks = callbacks;
    this.runner = runner;
    this.gitOps = gitOps;
  }

  /**
   * Delegate a task to an AI agent.
   * 
   * Creates a task file in the worktree and optionally invokes
   * GitHub Copilot CLI for automated execution.
   * 
   * @param options - Delegation options
   * @returns Promise resolving to delegation result
   */
  async delegate(options: DelegateOptions): Promise<DelegateResult> {
    const { jobId, taskDescription, label, worktreePath, baseBranch, targetBranch, instructions, sessionId } = options;

    this.logger.log(`[${label}] AI Agent Delegation: ${taskDescription}`);
    this.logger.log(`[${label}] Worktree: ${worktreePath}`);

    // Create task file
    const taskFilePath = await this.createTaskFile(options);
    this.logger.log(`[${label}] Created task file: ${taskFilePath}`);
    this.logger.log(`[${label}] ⚠️  This step requires manual AI agent intervention`);
    this.logger.log(`[${label}] Open the worktree and use GitHub Copilot to complete the task`);
    this.logger.log(`[${label}] Or use the Copilot Orchestrator MCP tools to delegate automatically`);

    // Check if Copilot CLI is available for automated delegation
    const copilotAvailable = isCopilotCliAvailable();
    let result: DelegateResult = { success: true };

    if (copilotAvailable) {
      this.logger.log(`[${label}] Attempting automated delegation via GitHub Copilot...`);
      result = await this.delegateViaCopilot(options);
    }

    // Create marker commit
    await this.createMarkerCommit(worktreePath, jobId, taskDescription, label);

    this.logger.log(`[${label}] ✓ Delegation step completed`);
    return result;
  }

  /**
   * Check if Copilot CLI is available.
   */
  isCopilotAvailable(): boolean {
    return isCopilotCliAvailable();
  }

  // ========================================
  // PRIVATE METHODS
  // ========================================

  /**
   * Create the task file in the worktree.
   */
  private async createTaskFile(options: DelegateOptions): Promise<string> {
    const { jobId, taskDescription, worktreePath, baseBranch, targetBranch, instructions, sessionId } = options;

    const taskFilePath = path.join(worktreePath, '.copilot-task.md');
    const taskContent = `# AI Agent Task

## Job ID
${jobId}

## Task Description
${taskDescription}

## Instructions
${instructions || 'No additional instructions provided.'}

## Context
- Working directory: ${worktreePath}
- Base branch: ${baseBranch}
- Target branch: ${targetBranch}

## Next Steps
This task requires AI agent intervention. The agent should:
1. Read and understand this task description
2. Make the necessary code changes in this worktree
3. Commit the changes with a descriptive message
4. The orchestrator will handle merging back to the main branch

## Work Evidence
Your changes must result in at least one modified, added, or deleted file.
If your task does not require file changes (e.g., analysis, validation),
create an evidence file:

Path: .orchestrator/evidence/${jobId}.json
Format:
{
  "version": 1,
  "nodeId": "${jobId}",
  "timestamp": "<ISO 8601>",
  "summary": "<what you did>",
  "type": "analysis" | "validation" | "external_effect"
}

## Status
⏳ Waiting for AI agent to complete this task...

## Copilot Session
${sessionId ? `Session ID: ${sessionId}\n\nThis job has an active Copilot session. Context will be maintained across multiple delegations.` : 'No active session yet. A session will be created on first Copilot interaction.'}
`;

    fs.writeFileSync(taskFilePath, taskContent, 'utf-8');
    return taskFilePath;
  }

  /**
   * Delegate task via GitHub Copilot CLI.
   */
  private async delegateViaCopilot(options: DelegateOptions): Promise<DelegateResult> {
    const { jobId, taskDescription, label, worktreePath, sessionId, model, allowedFolders, allowedUrls } = options;

    // Validate model if provided
    if (model && !await isValidModel(model)) {
      this.logger.log(`[${label}] Warning: Model '${model}' not in discovered models`);
    }

    // Create CLI runner with logger adapter, or use injected runner
    const cliRunner: ICopilotRunner = this.runner ?? (() => {
      const cliLogger: CopilotCliLogger = {
        info: (msg) => this.logger.log(msg),
        warn: (msg) => this.logger.log(msg),
        error: (msg) => this.logger.log(msg),
        debug: (msg) => this.logger.log(msg),
      };
      return new CopilotCliRunner(cliLogger); // eslint-disable-line no-restricted-syntax -- legacy fallback before DI
    })();

    // Create job-specific directories for Copilot logs and session tracking.
    // IMPORTANT: Must be under .orchestrator/ which is .gitignored.
    // Using .copilot-orchestrator/ would put logs inside the commit tree.
    const copilotJobDir = path.join(worktreePath, '.orchestrator', '.copilot-cli');
    const copilotLogDir = path.join(copilotJobDir, 'logs');
    const sessionSharePath = path.join(copilotJobDir, `session-${label}.md`);

    try {
      fs.mkdirSync(copilotLogDir, { recursive: true });
    } catch (e) {
      this.logger.log(`[${label}] Warning: Could not create Copilot log directory: ${e}`);
    }

    this.logger.log(`[${label}] ${sessionId ? 'Resuming' : 'Starting new'} Copilot session...`);

    // Ensure worktree is always in allowedFolders
    const finalAllowedFolders = allowedFolders || [];
    if (!finalAllowedFolders.includes(worktreePath)) {
      finalAllowedFolders.unshift(worktreePath);
    }

    // Log security configuration
    this.logger.log(`[${label}] Executing agent in: ${worktreePath}`);
    this.logger.log(`[${label}] Allowed folders: ${finalAllowedFolders.join(', ')}`);
    if (allowedUrls && allowedUrls.length > 0) {
      this.logger.log(`[${label}] Allowed URLs: ${allowedUrls.join(', ')}`);
    } else {
      this.logger.log(`[${label}] Allowed URLs: none`);
    }

    // Track PID and early session ID for process callbacks
    let spawnedPid: number | undefined;
    let earlySessionId: string | undefined;

    // Start tailing CLI log files for real-time visibility.
    // The CLI writes detailed tool calls to --log-dir which are not in stdout.
    let logTailInterval: NodeJS.Timeout | undefined;
    let logTailOffset = 0;
    let logTailFile: string | undefined;
    
    // Capture logOutput callback for use in setInterval (ensure stable reference)
    const emitLogLine = options.logOutput || (() => {});
    const hasLogOutput = !!options.logOutput;

    const startLogTail = () => {
      // Emit a marker so we know tailing started
      emitLogLine(`[cli-log] Log tailing started (hasCallback=${hasLogOutput}), watching: ${copilotLogDir}`);
      this.logger.log(`[${label}] [log-tail] Started. hasLogOutput=${hasLogOutput}, dir=${copilotLogDir}`);
      logTailInterval = setInterval(() => {
        try {
          // On every poll, check if a newer log file has appeared.
          if (fs.existsSync(copilotLogDir)) {
            const files = fs.readdirSync(copilotLogDir)
              .filter(f => f.endsWith('.log'))
              .map(f => ({ name: f, time: fs.statSync(path.join(copilotLogDir, f)).mtime.getTime() }))
              .sort((a, b) => b.time - a.time);
            if (files.length > 0) {
              const newest = path.join(copilotLogDir, files[0].name);
              if (newest !== logTailFile) {
                // Flush remaining bytes from the old file before switching
                if (logTailFile && fs.existsSync(logTailFile)) {
                  try {
                    const oldStat = fs.statSync(logTailFile);
                    if (oldStat.size > logTailOffset) {
                      const fd = fs.openSync(logTailFile, 'r');
                      const buf = Buffer.alloc(oldStat.size - logTailOffset);
                      fs.readSync(fd, buf, 0, buf.length, logTailOffset);
                      fs.closeSync(fd);
                      for (const line of buf.toString('utf-8').split('\n')) {
                        if (line.trim()) { emitLogLine(`[cli-log] ${line.trim()}`); }
                      }
                    }
                  } catch { /* ignore */ }
                }
                this.logger.log(`[${label}] [log-tail] Switched to: ${path.basename(newest)}`);
                logTailFile = newest;
                logTailOffset = 0; // Reset offset for the new file
              }
            }
          }
          if (logTailFile && fs.existsSync(logTailFile)) {
            const stat = fs.statSync(logTailFile);
            if (stat.size > logTailOffset) {
              const fd = fs.openSync(logTailFile, 'r');
              const buf = Buffer.alloc(stat.size - logTailOffset);
              fs.readSync(fd, buf, 0, buf.length, logTailOffset);
              fs.closeSync(fd);
              logTailOffset = stat.size;
              const newContent = buf.toString('utf-8');
              const lineCount = newContent.split('\n').filter(l => l.trim()).length;
              this.logger.log(`[${label}] [log-tail] Read ${lineCount} lines (${buf.length} bytes) from ${path.basename(logTailFile)}`);
              for (const line of newContent.split('\n')) {
                if (line.trim()) {
                  emitLogLine(`[cli-log] ${line.trim()}`);
                }
              }
            }
          }
        } catch (err: any) {
          this.logger.log(`[${label}] [log-tail] Error: ${err.message}`);
        }
      }, 2000); // Poll every 2 seconds
    };
    
    startLogTail();

    // Run via the unified CopilotCliRunner (handles instructions, spawn, stats parsing)
    const result = await cliRunner.run({
      cwd: worktreePath,
      task: taskDescription,
      label,
      sessionId,
      model,
      logDir: copilotLogDir,
      sharePath: sessionSharePath,
      jobId,
      allowedFolders: finalAllowedFolders,  // Pass through allowed folders with worktree included
      allowedUrls,     // NEW: pass through to CLI runner
      configDir: options.configDir, // Plan-level config dir isolation
      env: options.env, // Plan/spec-level environment variables
      timeout: 0, // No timeout — agent work can run for a long time
      onProcess: (proc) => {
        if (proc.pid) {
          spawnedPid = proc.pid;
          this.callbacks.onProcessSpawned?.(proc.pid);
          this.logger.log(`[${label}] Copilot PID: ${proc.pid}`);
        }
      },
      onOutput: (line) => {
        this.logger.log(`[${label}] ${line}`);
        options.logOutput?.(line);

        // Try to extract session ID from output for early callback notification
        if (!earlySessionId) {
          const extracted = this.extractSessionId(line);
          if (extracted) {
            earlySessionId = extracted;
            this.logger.log(`[${label}] ✓ Captured Copilot session ID: ${extracted}`);
            this.callbacks.onSessionCaptured?.(extracted);
          }
        }
      },
    });

    // Stop log tailing
    if (logTailInterval) { clearInterval(logTailInterval); }

    // Process has exited — notify callback
    if (spawnedPid) {
      this.callbacks.onProcessExited?.(spawnedPid);
    }

    // Final flush: read any remaining log content not yet tailed
    if (hasLogOutput && logTailFile && fs.existsSync(logTailFile)) {
      try {
        const stat = fs.statSync(logTailFile);
        if (stat.size > logTailOffset) {
          const fd = fs.openSync(logTailFile, 'r');
          const buf = Buffer.alloc(stat.size - logTailOffset);
          fs.readSync(fd, buf, 0, buf.length, logTailOffset);
          fs.closeSync(fd);
          const remaining = buf.toString('utf-8');
          for (const line of remaining.split('\n')) {
            if (line.trim()) { emitLogLine(`[cli-log] ${line.trim()}`); }
          }
        }
      } catch (e) {
        this.logger.log(`[${label}] Could not flush CLI log tail: ${e}`);
      }
    }

    // Use the session captured by the runner, then early output capture, then file fallback
    let capturedSessionId = result.sessionId || earlySessionId;

    // Fallback: try to extract session ID from share file / log files
    if (!capturedSessionId) {
      capturedSessionId = this.extractSessionFromFile(sessionSharePath, copilotLogDir, label);
      if (capturedSessionId) {
        this.callbacks.onSessionCaptured?.(capturedSessionId);
      }
    }

    // Use metrics from the runner (parsed from stdout via CopilotStatsParser)
    let metrics: CopilotUsageMetrics | undefined = result.metrics;

    // Legacy fallback: extract token usage from log files if no stdout metrics
    if (!metrics) {
      const tokenUsage = await this.extractTokenUsage(copilotLogDir, model);
      if (tokenUsage) {
        metrics = { durationMs: 0, tokenUsage };
      }
    }

    // Legacy backfill: populate tokenUsage from modelBreakdown
    const tokenUsage = metrics?.tokenUsage;

    return {
      success: result.success,
      sessionId: capturedSessionId,
      error: result.error,
      exitCode: result.exitCode,
      tokenUsage,
      metrics,
    };
  }

  /**
   * Extract token usage from Copilot log files.
   */
  private async extractTokenUsage(logDir: string, model?: string): Promise<TokenUsage | undefined> {
    try {
      if (!fs.existsSync(logDir)) {
        return undefined;
      }

      const logFiles = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({
          name: f,
          time: fs.statSync(path.join(logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      if (logFiles.length === 0) {
        return undefined;
      }

      const logContent = fs.readFileSync(path.join(logDir, logFiles[0].name), 'utf-8');

      const patterns = [
        /prompt_tokens["']?:\s*(\d+)/gi,
        /completion_tokens["']?:\s*(\d+)/gi,
        /input[_\s]tokens?["']?:\s*(\d+)/gi,
        /output[_\s]tokens?["']?:\s*(\d+)/gi,
      ];

      let inputTokens = 0;
      let outputTokens = 0;

      // prompt_tokens / input_tokens → inputTokens
      for (const pattern of [patterns[0], patterns[2]]) {
        let match;
        while ((match = pattern.exec(logContent)) !== null) {
          inputTokens += parseInt(match[1], 10);
        }
      }

      // completion_tokens / output_tokens → outputTokens
      for (const pattern of [patterns[1], patterns[3]]) {
        let match;
        while ((match = pattern.exec(logContent)) !== null) {
          outputTokens += parseInt(match[1], 10);
        }
      }

      if (inputTokens === 0 && outputTokens === 0) {
        return undefined;
      }

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model: model || 'unknown',
      };
    } catch (e) {
      return undefined;
    }
  }

  /**
   * Extract session ID from a line of output.
   */
  private extractSessionId(line: string): string | undefined {
    const sessionMatch = line.match(/Session ID[:\s]+([a-f0-9-]{36})/i) ||
                         line.match(/session[:\s]+([a-f0-9-]{36})/i) ||
                         line.match(/Starting session[:\s]+([a-f0-9-]{36})/i);
    return sessionMatch?.[1];
  }

  /**
   * Extract session ID from share file or log files.
   */
  private extractSessionFromFile(sessionSharePath: string, copilotLogDir: string, label: string): string | undefined {
    try {
      // First, try to parse session ID from the share file
      if (fs.existsSync(sessionSharePath)) {
        const shareContent = fs.readFileSync(sessionSharePath, 'utf-8');
        this.logger.log(`[${label}] Parsing session file: ${sessionSharePath}`);

        const firstLines = shareContent.substring(0, 500);
        const sessionMatch = 
          shareContent.match(/Session(?:\s+ID)?[:\s*]+`?([a-f0-9-]{36})`?/i) ||
          firstLines.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i) ||
          shareContent.match(/vscode-chat-session:\/\/[^\/]+\/([a-f0-9-]+)/i) ||
          shareContent.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);

        if (sessionMatch) {
          this.logger.log(`[${label}] ✓ Extracted Copilot session ID from share file: ${sessionMatch[1]}`);
          return sessionMatch[1];
        } else {
          this.logger.log(`[${label}] Warning: Share file exists but no session ID pattern found.`);
        }
      }

      // Fallback: extract from log filename
      if (fs.existsSync(copilotLogDir)) {
        const files = fs.readdirSync(copilotLogDir)
          .filter(f => f.startsWith('copilot-') && f.endsWith('.log'))
          .map(f => ({
            name: f,
            time: fs.statSync(path.join(copilotLogDir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.time - a.time);

        if (files.length > 0) {
          const match = files[0].name.match(/copilot-\d{4}-\d{2}-\d{2}-([a-f0-9-]+)\.log/i);
          if (match) {
            this.logger.log(`[${label}] ✓ Extracted Copilot session ID from log filename: ${match[1]}`);
            return match[1];
          }
        }
      }

      this.logger.log(`[${label}] Note: Could not extract session ID. Future delegations will start new sessions.`);
      return undefined;
    } catch (e) {
      this.logger.log(`[${label}] Could not extract session ID (non-fatal): ${e}`);
      return undefined;
    }
  }

  /**
   * Create a marker commit indicating agent delegation.
   */
  private async createMarkerCommit(worktreePath: string, jobId: string, taskDescription: string, label: string): Promise<void> {
    try {
      const repository = this.gitOps.repository;

      // Stage the task file
      await repository.stageFile(worktreePath, '.copilot-task.md');
      
      // Create the marker commit
      const commitMessage = `orchestrator(${jobId}): AI agent task created\n\n${taskDescription}`;
      const committed = await repository.commit(worktreePath, commitMessage, { allowEmpty: true });

      if (committed) {
        this.logger.log(`[${label}] Created marker commit for agent delegation`);
      }
    } catch (e: any) {
      // Non-fatal - log and continue
      this.logger.log(`[${label}] Could not create marker commit: ${e.message}`);
    }
  }
}
