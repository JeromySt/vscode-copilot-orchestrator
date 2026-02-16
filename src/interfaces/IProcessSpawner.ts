/**
 * @fileoverview Interface for process spawning abstraction.
 * 
 * Thin wrapper around child_process.spawn to enable dependency injection
 * and unit testing without spawning real processes.
 * 
 * @module interfaces/IProcessSpawner
 */

import type { ChildProcess, SpawnOptions } from 'child_process';

/**
 * Minimal child process interface for testability.
 * Matches the subset of ChildProcess used by consumers.
 */
export interface ChildProcessLike {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Interface for spawning child processes.
 * 
 * @example
 * ```typescript
 * class CopilotCliRunner {
 *   constructor(private readonly spawner: IProcessSpawner) {}
 *   
 *   execute(cmd: string, cwd: string) {
 *     const proc = this.spawner.spawn(cmd, [], { cwd, shell: true });
 *     // ...
 *   }
 * }
 * ```
 */
export interface IProcessSpawner {
  /**
   * Spawn a child process.
   * 
   * @param command - The command to run
   * @param args - Arguments to pass to the command
   * @param options - Spawn options (cwd, env, shell, etc.)
   * @returns A child process handle
   */
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcessLike;
}

/**
 * Default process spawner that delegates to child_process.spawn.
 */
export class DefaultProcessSpawner implements IProcessSpawner {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcessLike {
     
    const cp = require('child_process');
    return cp.spawn(command, args, options) as ChildProcess;
  }
}
