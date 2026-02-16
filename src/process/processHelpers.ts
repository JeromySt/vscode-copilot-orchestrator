/**
 * @fileoverview Process utilities for common spawning patterns
 * 
 * Provides centralized utilities for process execution and termination
 * that delegate to IProcessSpawner for consistency and testability.
 * 
 * @module process/processHelpers
 */

import type { IProcessSpawner } from '../interfaces/IProcessSpawner';

/**
 * Execute a command and return stdout as string.
 * Similar to the execAsync pattern used throughout the codebase.
 * 
 * @param spawner - Process spawner to use
 * @param command - Command to execute
 * @param args - Command arguments
 * @param timeoutMs - Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves to stdout content
 * @throws Error if command fails or times out
 */
export function execCommand(
  spawner: IProcessSpawner, 
  command: string, 
  args: string[], 
  timeoutMs = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawner.spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    const timer = setTimeout(() => {
      killed = true;
      proc?.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    proc.stdout?.on('data', (data) => { 
      stdout += data.toString(); 
    });
    
    proc.stderr?.on('data', (data) => { 
      stderr += data.toString(); 
    });
    
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {return;}
      
      if (code === 0 || stdout) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Kill a process tree using platform-specific methods.
 * Consolidates the taskkill logic used across executor.ts and workPhase.ts.
 * 
 * @param spawner - Process spawner to use
 * @param pid - Process ID to kill
 * @param force - Whether to force kill (default: false)
 * @param timeoutMs - Timeout for kill operation (default: 5000)
 * @returns Promise that resolves when kill operation completes
 */
export async function killProcessTree(
  spawner: IProcessSpawner,
  pid: number,
  force = false,
  timeoutMs = 5000
): Promise<void> {
  if (process.platform === 'win32') {
    const args = force 
      ? ['/F', '/T', '/PID', String(pid)]
      : ['/T', '/PID', String(pid)];
    
    try {
      await execCommand(spawner, 'taskkill', args, timeoutMs);
    } catch (e) {
      console.error(`Failed to kill Windows process ${pid}:`, e);
    }
  } else {
    // On Unix, use process.kill directly for simplicity
    // The spawner is not needed for this operation
    try {
      const signal = force ? 'SIGKILL' : 'SIGTERM';
      process.kill(pid, signal);
    } catch (e) {
      // Process may already be dead
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error(`Failed to kill Unix process ${pid}:`, e);
      }
    }
  }
}