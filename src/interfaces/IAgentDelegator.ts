/**
 * @fileoverview Interface for AI agent delegation.
 * 
 * Abstracts the interaction with GitHub Copilot CLI for:
 * - Unit testing with mock responses
 * - Potential support for other AI agents
 * - Separation from job execution logic
 * 
 * @module interfaces/IAgentDelegator
 */

import { Job } from '../types';

/**
 * Result of an AI agent delegation.
 */
export interface DelegationResult {
  /** Whether the delegation succeeded */
  success: boolean;
  /** Copilot session ID (for resuming/debugging) */
  sessionId?: string;
  /** Process ID of the Copilot CLI process */
  processId?: number;
  /** Error message if delegation failed */
  error?: string;
  /** Exit code from the Copilot CLI process */
  exitCode?: number;
}

/**
 * Options for AI agent delegation.
 */
export interface DelegationOptions {
  /** Working directory for the agent */
  workDir: string;
  /** Path to write the task file */
  taskFilePath: string;
  /** Additional context/instructions for the agent */
  context?: string;
  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs?: number;
}

/**
 * Interface for delegating work to AI agents.
 * 
 * Currently supports GitHub Copilot CLI via the @agent syntax.
 * 
 * @example
 * ```typescript
 * const result = await delegator.delegate(
 *   job,
 *   '@agent Fix the failing tests in src/utils.ts',
 *   { workDir: '/path/to/worktree' }
 * );
 * if (result.success) {
 *   console.log(`Copilot session: ${result.sessionId}`);
 * }
 * ```
 */
export interface IAgentDelegator {
  /**
   * Check if the AI agent CLI is available.
   * @returns true if 'copilot' CLI is available
   */
  isAvailable(): Promise<boolean>;
  
  /**
   * Delegate work to an AI agent.
   * 
   * @param job - The job context
   * @param task - The work instruction (may include @agent prefix)
   * @param options - Delegation options
   * @returns Result of the delegation
   */
  delegate(job: Job, task: string, options: DelegationOptions): Promise<DelegationResult>;
  
  /**
   * Spawn an agent process with the given task.
   * Returns immediately with process info; use for background execution.
   * 
   * @param job - The job context
   * @param task - The work instruction
   * @param options - Delegation options
   * @returns Process info for monitoring
   */
  spawn(job: Job, task: string, options: DelegationOptions): Promise<{
    processId: number;
    sessionId?: string;
  }>;
}
