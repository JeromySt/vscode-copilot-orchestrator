/**
 * @fileoverview Git Command Executor - Low-level git command execution.
 * 
 * Single responsibility: Execute git commands safely with proper error handling.
 * All other git modules use this for command execution.
 * 
 * @module git/core/executor
 */

import { spawnSync, SpawnSyncReturns } from 'child_process';

/**
 * Logger function type for git operations.
 */
export type GitLogger = (message: string) => void;

/**
 * Result of a git command execution.
 */
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Options for git command execution.
 */
export interface ExecuteOptions {
  /** Working directory for the command */
  cwd: string;
  /** Logger function (optional) */
  log?: GitLogger;
  /** Whether to throw on non-zero exit (default: false) */
  throwOnError?: boolean;
  /** Custom error message prefix */
  errorPrefix?: string;
}

/**
 * Execute a git command with proper error handling.
 * 
 * @param args - Git command arguments (without 'git' prefix)
 * @param options - Execution options
 * @returns Command result
 * @throws Error if throwOnError is true and command fails
 * 
 * @example
 * ```typescript
 * const result = exec(['status', '--porcelain'], { cwd: repoPath });
 * if (result.success) {
 *   console.log(result.stdout);
 * }
 * ```
 */
export function exec(args: string[], options: ExecuteOptions): CommandResult {
  const { cwd, log, throwOnError = false, errorPrefix = 'Git command failed' } = options;
  
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe'
  });
  
  const commandResult: CommandResult = {
    success: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status
  };
  
  if (log && commandResult.stdout) {
    log(commandResult.stdout.trim());
  }
  
  if (!commandResult.success && throwOnError) {
    const errorMsg = commandResult.stderr || `Exit code: ${result.status}`;
    throw new Error(`${errorPrefix}: git ${args.join(' ')} - ${errorMsg}`);
  }
  
  return commandResult;
}

/**
 * Execute a shell command (for complex git pipelines).
 * 
 * @param cmd - Shell command string
 * @param options - Execution options
 * @returns Command result
 */
export function execShell(cmd: string, options: ExecuteOptions): CommandResult {
  const { cwd, log, throwOnError = false, errorPrefix = 'Command failed' } = options;
  
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    stdio: 'pipe'
  });
  
  const commandResult: CommandResult = {
    success: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status
  };
  
  if (log) {
    if (commandResult.stdout) log(commandResult.stdout.trim());
    if (commandResult.stderr && !commandResult.success) log(commandResult.stderr.trim());
  }
  
  if (!commandResult.success && throwOnError) {
    const errorMsg = commandResult.stderr || `Exit code: ${result.status}`;
    throw new Error(`${errorPrefix}: ${cmd} - ${errorMsg}`);
  }
  
  return commandResult;
}

/**
 * Execute a git command and return trimmed stdout on success.
 * Throws on failure.
 * 
 * @param args - Git command arguments
 * @param cwd - Working directory
 * @returns Trimmed stdout
 * @throws Error on non-zero exit
 */
export function execOrThrow(args: string[], cwd: string): string {
  const result = exec(args, { cwd, throwOnError: true });
  return result.stdout.trim();
}

/**
 * Execute a git command and return stdout or null on failure.
 * 
 * @param args - Git command arguments
 * @param cwd - Working directory
 * @returns Trimmed stdout or null
 */
export function execOrNull(args: string[], cwd: string): string | null {
  const result = exec(args, { cwd });
  return result.success ? result.stdout.trim() : null;
}
