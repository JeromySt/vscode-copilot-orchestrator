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
import { spawn } from 'child_process';
import { isCopilotCliAvailable } from './cliCheckCore';
import { CopilotCliRunner, CopilotCliLogger } from './copilotCliRunner';
import * as git from '../git';

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
    const { jobId, taskDescription, label, worktreePath, sessionId } = options;

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

    // Write instructions file using the unified runner
    const { filePath: instructionsFile, dirPath: instructionsDir } = cliRunner.writeInstructionsFile(
      worktreePath,
      taskDescription,
      undefined, // No additional instructions
      label,
      jobId
    );

    // Build command using the unified runner
    const copilotCmd = cliRunner.buildCommand({
      task: 'Complete the task described in the instructions.',
      sessionId,
      logDir: copilotLogDir,
      sharePath: sessionSharePath,
    });
    
    this.logger.log(`[${label}] ${sessionId ? 'Resuming' : 'Starting new'} Copilot session...`);
    
    // Cleanup function using the unified runner
    const cleanup = () => {
      cliRunner.cleanupInstructionsFile(instructionsFile, instructionsDir, label);
    };

    return new Promise<DelegateResult>((resolve) => {
      const proc = spawn(copilotCmd, [], {
        cwd: worktreePath,
        shell: true,
      });

      let capturedSessionId: string | undefined = sessionId;

      // Notify process spawned
      if (proc.pid) {
        this.callbacks.onProcessSpawned?.(proc.pid);
        this.logger.log(`[${label}] Copilot PID: ${proc.pid}`);
      }

      // Buffers to accumulate streaming output - flush after quiet period
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let stdoutFlushTimer: NodeJS.Timeout | null = null;
      let stderrFlushTimer: NodeJS.Timeout | null = null;
      const FLUSH_DELAY_MS = 3000; // Wait 3s of silence before flushing (Copilot streams tokens slowly)
      
      // Helper to log a line and check for session ID
      const logLine = (line: string) => {
        this.logger.log(`[${label}] ${line}`);
        
        // Try to extract session ID
        if (!capturedSessionId) {
          const extracted = this.extractSessionId(line);
          if (extracted) {
            capturedSessionId = extracted;
            this.logger.log(`[${label}] ✓ Captured Copilot session ID: ${capturedSessionId}`);
            this.callbacks.onSessionCaptured?.(capturedSessionId);
          }
        }
      };
      
      // Helper to flush buffered content as complete lines
      const flushBuffer = (buffer: string): string => {
        const lines = buffer.split('\n');
        // Log all complete lines (all but the last if incomplete)
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line) {
            logLine(line);
          }
        }
        // Return the incomplete last line for further buffering
        const lastLine = lines[lines.length - 1];
        // If buffer ended with newline, last element is empty - return it
        return lastLine;
      };

      // Stream stdout - accumulate and flush after quiet period
      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        
        // Reset the flush timer on each new data
        if (stdoutFlushTimer) {
          clearTimeout(stdoutFlushTimer);
        }
        stdoutFlushTimer = setTimeout(() => {
          if (stdoutBuffer.trim()) {
            stdoutBuffer = flushBuffer(stdoutBuffer);
            // Flush any remaining incomplete line too
            if (stdoutBuffer.trim()) {
              logLine(stdoutBuffer.trim());
              stdoutBuffer = '';
            }
          }
          stdoutFlushTimer = null;
        }, FLUSH_DELAY_MS);
      });

      // Stream stderr - accumulate and flush after quiet period
      proc.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
        
        // Reset the flush timer on each new data
        if (stderrFlushTimer) {
          clearTimeout(stderrFlushTimer);
        }
        stderrFlushTimer = setTimeout(() => {
          if (stderrBuffer.trim()) {
            stderrBuffer = flushBuffer(stderrBuffer);
            // Flush any remaining incomplete line too
            if (stderrBuffer.trim()) {
              logLine(stderrBuffer.trim());
              stderrBuffer = '';
            }
          }
          stderrFlushTimer = null;
        }, FLUSH_DELAY_MS);
      });

      proc.on('exit', (code: number | null) => {
        // Clean up temp prompt file and instructions
        cleanup();
        
        // Clear any pending flush timers
        if (stdoutFlushTimer) clearTimeout(stdoutFlushTimer);
        if (stderrFlushTimer) clearTimeout(stderrFlushTimer);
        
        // Flush any remaining buffered output
        if (stdoutBuffer.trim()) {
          logLine(stdoutBuffer.trim());
        }
        if (stderrBuffer.trim()) {
          logLine(stderrBuffer.trim());
        }
        
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
        cleanup();
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
