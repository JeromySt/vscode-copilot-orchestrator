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
import { spawn, spawnSync } from 'child_process';
import { isCopilotCliAvailable } from './cliCheckCore';

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
    const { jobId, taskDescription, label, worktreePath, sessionId } = options;

    // Create job-specific directories for Copilot logs and session tracking
    const copilotJobDir = path.join(worktreePath, '.copilot-orchestrator');
    const copilotLogDir = path.join(copilotJobDir, 'logs');
    const sessionSharePath = path.join(copilotJobDir, `session-${label}.md`);

    try {
      fs.mkdirSync(copilotLogDir, { recursive: true });
    } catch (e) {
      this.logger.log(`[${label}] Warning: Could not create Copilot log directory: ${e}`);
    }

    // Build Copilot CLI command
    let copilotCmd = `copilot -p ${JSON.stringify(taskDescription)} --allow-all-paths --allow-all-urls --allow-all-tools --log-dir ${JSON.stringify(copilotLogDir)} --log-level debug --share ${JSON.stringify(sessionSharePath)}`;

    // Resume existing session if we have one
    if (sessionId) {
      this.logger.log(`[${label}] Resuming Copilot session: ${sessionId}`);
      copilotCmd += ` --resume ${sessionId}`;
    } else {
      this.logger.log(`[${label}] Starting new Copilot session...`);
    }

    return new Promise<DelegateResult>((resolve) => {
      const proc = spawn(copilotCmd, [], {
        cwd: worktreePath,
        shell: true
      });

      let capturedSessionId: string | undefined = sessionId;

      // Notify process spawned
      if (proc.pid) {
        this.callbacks.onProcessSpawned?.(proc.pid);
        this.logger.log(`[${label}] Copilot PID: ${proc.pid}`);
      }

      // Stream stdout
      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            this.logger.log(`[${label}] ${line.trim()}`);

            // Try to extract session ID
            if (!capturedSessionId) {
              const extracted = this.extractSessionId(line);
              if (extracted) {
                capturedSessionId = extracted;
                this.logger.log(`[${label}] ✓ Captured Copilot session ID: ${capturedSessionId}`);
                this.callbacks.onSessionCaptured?.(capturedSessionId);
              }
            }
          }
        });
      });

      // Stream stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            this.logger.log(`[${label}] ${line.trim()}`);

            // Also check stderr for session ID
            if (!capturedSessionId) {
              const extracted = this.extractSessionId(line);
              if (extracted) {
                capturedSessionId = extracted;
                this.logger.log(`[${label}] ✓ Captured Copilot session ID: ${capturedSessionId}`);
                this.callbacks.onSessionCaptured?.(capturedSessionId);
              }
            }
          }
        });
      });

      proc.on('exit', (code: number | null) => {
        // Notify process exited
        if (proc.pid) {
          this.callbacks.onProcessExited?.(proc.pid);
        }

        // Try to extract session ID from share file if not captured yet
        if (!capturedSessionId) {
          capturedSessionId = this.extractSessionFromFile(sessionSharePath, copilotLogDir, label);
          if (capturedSessionId) {
            this.callbacks.onSessionCaptured?.(capturedSessionId);
          }
        }

        if (code !== 0) {
          this.logger.log(`[${label}] Copilot exited with code ${code}`);
          resolve({
            success: false,
            sessionId: capturedSessionId,
            error: `Copilot failed with exit code ${code}`,
            exitCode: code ?? undefined
          });
        } else {
          this.logger.log(`[${label}] Copilot completed successfully`);
          resolve({
            success: true,
            sessionId: capturedSessionId,
            exitCode: 0
          });
        }
      });

      proc.on('error', (err: Error) => {
        this.logger.log(`[${label}] Copilot delegation failed: ${err}`);
        if (proc.pid) {
          this.callbacks.onProcessExited?.(proc.pid);
        }
        resolve({
          success: false,
          error: `Copilot CLI error: ${err.message}`
        });
      });
    });
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
    spawnSync('git', ['add', '.copilot-task.md'], { cwd: worktreePath });
    const commitResult = spawnSync('git', [
      'commit',
      '-m',
      `orchestrator(${jobId}): AI agent task created\n\n${taskDescription}`,
      '--allow-empty'
    ], {
      cwd: worktreePath,
      encoding: 'utf-8'
    });

    if (commitResult.status === 0) {
      this.logger.log(`[${label}] Created marker commit for agent delegation`);
    }
  }
}
