/**
 * @fileoverview Process monitoring type definitions.
 * 
 * These types are used for tracking and displaying process trees
 * spawned by job executions (e.g., Copilot CLI, npm, etc.).
 * 
 * @module types/process
 */

/**
 * Information about a running process.
 * Collected from OS-level process queries.
 */
export interface ProcessInfo {
  /** Process ID */
  pid: number;
  /** Parent process ID */
  parentPid: number;
  /** Process name (executable name) */
  name: string;
  /** Full command line that started the process */
  commandLine?: string;
  /** CPU usage percentage (0-100) */
  cpu: number;
  /** Memory usage in bytes */
  memory: number;
  /** Number of threads */
  threadCount?: number;
  /** Number of handles/file descriptors */
  handleCount?: number;
  /** Process priority level */
  priority?: number;
  /** ISO 8601 timestamp when process was created */
  creationDate?: string;
  /** Full path to the executable */
  executablePath?: string;
}

/**
 * Process information with hierarchical children.
 * Used for displaying process trees in the UI.
 */
export interface ProcessNode extends ProcessInfo {
  /** Child processes spawned by this process */
  children?: ProcessNode[];
}

/**
 * Platform-agnostic interface for process operations.
 * Implementations exist for Windows (PowerShell) and Unix (ps).
 */
export interface IProcessCommands {
  /**
   * Get a snapshot of all running processes.
   * @returns Array of process information
   */
  getAllProcesses(): Promise<ProcessInfo[]>;
  
  /**
   * Check if a specific process is still running.
   * @param pid - Process ID to check
   * @returns true if process exists, false otherwise
   */
  isProcessRunning(pid: number): boolean;
  
  /**
   * Terminate a process and its children.
   * @param pid - Process ID to terminate
   * @param force - Whether to force kill (SIGKILL vs SIGTERM)
   */
  terminateProcess(pid: number, force?: boolean): Promise<void>;
}
