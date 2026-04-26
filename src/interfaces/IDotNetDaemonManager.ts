/**
 * @fileoverview IDotNetDaemonManager — lifecycle manager for the .NET
 * AiOrchestrator daemon process.
 *
 * @module interfaces/IDotNetDaemonManager
 */

import type { Disposable } from 'vscode';

/**
 * Daemon health status.
 */
export interface DaemonStatus {
  /** Whether the daemon process is running. */
  running: boolean;
  /** Process ID if running. */
  pid?: number;
  /** Named pipe path for MCP communication. */
  pipeName?: string;
  /** Uptime in seconds. */
  uptimeSeconds?: number;
  /** Last error message if startup failed. */
  lastError?: string;
}

/**
 * Manages the lifecycle of the .NET AiOrchestrator daemon process.
 *
 * The daemon is started as a child process when the dotnet engine is enabled.
 * Communication happens via MCP protocol over named pipes.
 */
export interface IDotNetDaemonManager extends Disposable {
  /** Start the daemon process. Resolves when the daemon is ready to accept connections. */
  start(): Promise<void>;

  /** Stop the daemon process gracefully. */
  stop(): Promise<void>;

  /** Restart the daemon (stop + start). */
  restart(): Promise<void>;

  /** Get current daemon health status. */
  getStatus(): DaemonStatus;

  /** Get the named pipe path for MCP communication. */
  getPipeName(): string | undefined;

  /** Whether the daemon is currently running and healthy. */
  readonly isRunning: boolean;
}
