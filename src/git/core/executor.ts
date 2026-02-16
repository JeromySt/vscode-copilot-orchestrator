/**
 * @fileoverview Git Command Executor - Low-level git command execution.
 * 
 * Single responsibility: Execute git commands safely with proper error handling.
 * All other git modules use this for command execution.
 * 
 * Provides both sync (spawnSync) and async (spawn) variants:
 * - Sync: Simpler, but BLOCKS the event loop
 * - Async: Non-blocking, uses child process threads
 * 
 * @module git/core/executor
 */

import { spawnSync, spawn, SpawnSyncReturns } from 'child_process';

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
  /** Timeout in milliseconds (default: 60000 = 1 minute) */
  timeoutMs?: number;
}

/**
 * Execute a git command with proper error handling.
 * 
 * @deprecated Use execAsync instead to avoid blocking the extension host.
 * This sync function is kept for backward compatibility only.
 * 
 * @param args - Git command arguments (without 'git' prefix)
 * @param options - Execution options
 * @returns Command result
 * @throws Error if throwOnError is true and command fails
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
 * @deprecated Use execShellAsync instead to avoid blocking the extension host.
 * This sync function is kept for backward compatibility only.
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
    if (commandResult.stdout) {log(commandResult.stdout.trim());}
    if (commandResult.stderr && !commandResult.success) {log(commandResult.stderr.trim());}
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
 * @deprecated Use execAsyncOrThrow instead to avoid blocking the extension host.
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
 * @deprecated Use execAsyncOrNull instead to avoid blocking the extension host.
 * 
 * @param args - Git command arguments
 * @param cwd - Working directory
 * @returns Trimmed stdout or null
 */
export function execOrNull(args: string[], cwd: string): string | null {
  const result = exec(args, { cwd });
  return result.success ? result.stdout.trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC VARIANTS - Non-blocking, use child process threads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a git command asynchronously (non-blocking).
 * Uses child_process.spawn which runs in a separate process.
 * 
 * @param args - Git command arguments (without 'git' prefix)
 * @param options - Execution options
 * @returns Promise resolving to command result
 */
export async function execAsync(args: string[], options: ExecuteOptions): Promise<CommandResult> {
  const { cwd, log, throwOnError = false, errorPrefix = 'Git command failed', timeoutMs = 60000 } = options;
  
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: 'pipe'
    });
    
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    
    // Set up timeout
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    
    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      
      if (timedOut) {
        const errorMsg = `Command timed out after ${timeoutMs}ms`;
        if (throwOnError) {
          reject(new Error(`${errorPrefix}: git ${args.join(' ')} - ${errorMsg}`));
        } else {
          resolve({
            success: false,
            stdout,
            stderr: errorMsg,
            exitCode: null
          });
        }
        return;
      }
      
      const commandResult: CommandResult = {
        success: code === 0,
        stdout,
        stderr,
        exitCode: code
      };
      
      if (log && commandResult.stdout) {
        log(commandResult.stdout.trim());
      }
      
      if (!commandResult.success && throwOnError) {
        const errorMsg = commandResult.stderr || `Exit code: ${code}`;
        reject(new Error(`${errorPrefix}: git ${args.join(' ')} - ${errorMsg}`));
      } else {
        resolve(commandResult);
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (throwOnError) {
        reject(new Error(`${errorPrefix}: git ${args.join(' ')} - ${err.message}`));
      } else {
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: null
        });
      }
    });
  });
}

/**
 * Execute a git command asynchronously and return stdout or throw.
 */
export async function execAsyncOrThrow(args: string[], cwd: string): Promise<string> {
  const result = await execAsync(args, { cwd, throwOnError: true });
  return result.stdout.trim();
}

/**
 * Execute a git command asynchronously and return stdout or null.
 */
export async function execAsyncOrNull(args: string[], cwd: string): Promise<string | null> {
  const result = await execAsync(args, { cwd });
  return result.success ? result.stdout.trim() : null;
}
