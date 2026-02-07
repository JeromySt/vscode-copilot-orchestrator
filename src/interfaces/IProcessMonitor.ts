/**
 * @fileoverview Interface for process monitoring.
 * 
 * Abstracts OS-level process queries for:
 * - Cross-platform support (Windows, Linux, macOS)
 * - Unit testing with mock process data
 * - Separation from job execution logic
 * 
 * @module interfaces/IProcessMonitor
 */

import { ProcessInfo, ProcessNode } from '../types';

/**
 * Interface for monitoring OS processes.
 * 
 * Used to track processes spawned by jobs and display
 * resource usage in the UI.
 * 
 * @example
 * ```typescript
 * const snapshot = await monitor.getSnapshot();
 * const tree = monitor.buildTree([pid1, pid2], snapshot);
 * // tree contains hierarchical process info
 * ```
 */
export interface IProcessMonitor {
  /**
   * Get a snapshot of all running processes.
   * This is expensive - cache the result when possible.
   * 
   * @returns Array of process information
   */
  getSnapshot(): Promise<ProcessInfo[]>;
  
  /**
   * Build a process tree from specific root PIDs.
   * 
   * @param rootPids - PIDs to use as tree roots
   * @param snapshot - Process snapshot to build from
   * @returns Hierarchical tree of processes
   */
  buildTree(rootPids: number[], snapshot: ProcessInfo[]): ProcessNode[];
  
  /**
   * Check if a specific process is running.
   * More efficient than getSnapshot() for single checks.
   * 
   * @param pid - Process ID to check
   * @returns true if process exists
   */
  isRunning(pid: number): boolean;
  
  /**
   * Terminate a process tree.
   * Kills the specified process and all its descendants.
   * 
   * @param pid - Root process ID to terminate
   * @param force - Whether to force kill (SIGKILL on Unix)
   */
  terminate(pid: number, force?: boolean): Promise<void>;
}
