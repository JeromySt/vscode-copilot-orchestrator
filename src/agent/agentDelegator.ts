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
import * as git from '../git';
import { TokenUsage, CopilotUsageMetrics } from '../plan/types';

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

  /**
   * Create a new agent delegator.
   * 
   * @param logger - Logger for output messages
   * @param callbacks - Optional callbacks for delegation events
   */
  constructor(logger: DelegatorLogger, callbacks: DelegatorCallbacks = {}) {
    this.logger = logger;
    this.callbacks = callbacks;
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
    const { jobId, taskDescription, label, worktreePath, sessionId, model } = options;

    // Validate model if provided
    if (model && !await isValidModel(model)) {
      this.logger.log(`[${label}] Warning: Model '${model}' not in discovered models`);
    }

    // Create CLI runner with logger adapter
    const cliLogger: CopilotCliLogger = {
      info: (msg) => this.logger.log(msg),
      warn: (msg) => this.logger.log(msg),
      error: (msg) => this.logger.log(msg),
      debug: (msg) => this.logger.log(msg),
    };
    const cliRunner = new CopilotCliRunner(cliLogger);

    // Create job-specific directories for Copilot logs and session tracking
    const copilotJobDir = path.join(worktreePath, '.copilot-orchestrator');
    const copilotLogDir = path.join(copilotJobDir, 'logs');
    const sessionSharePath = path.join(copilotJobDir, `session-${label}.md`);

    try {
      fs.mkdirSync(copilotLogDir, { recursive: true });
    } catch (e) {
      this.logger.log(`[${label}] Warning: Could not create Copilot log directory: ${e}`);
    }

    this.logger.log(`[${label}] ${sessionId ? 'Resuming' : 'Starting new'} Copilot session...`);

    // Track PID and early session ID for process callbacks
    let spawnedPid: number | undefined;
    let earlySessionId: string | undefined;

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

    // Process has exited — notify callback
    if (spawnedPid) {
      this.callbacks.onProcessExited?.(spawnedPid);
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
      // Stage the task file using git/* module
      await git.executor.execAsync(['add', '.copilot-task.md'], { cwd: worktreePath });
      
      // Create the marker commit using git/* module
      const commitMessage = `orchestrator(${jobId}): AI agent task created\n\n${taskDescription}`;
      const committed = await git.repository.commit(worktreePath, commitMessage, { allowEmpty: true });

      if (committed) {
        this.logger.log(`[${label}] Created marker commit for agent delegation`);
      }
    } catch (e: any) {
      // Non-fatal - log and continue
      this.logger.log(`[${label}] Could not create marker commit: ${e.message}`);
    }
  }
}
