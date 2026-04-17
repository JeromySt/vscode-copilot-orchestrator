/**
 * @fileoverview Interface for creating managed processes with output bus integration.
 *
 * Provides the opt-in factory for wrapping an already-spawned {@link ChildProcessLike}
 * with a {@link IProcessOutputBus}, registered handlers, and log file tailers.
 *
 * Only callers that need structured output handling use this factory (2 of 22
 * spawn sites). All other callers continue using {@link IProcessSpawner} directly.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §4.1.1
 * @module interfaces/IManagedProcessFactory
 */

import type { ChildProcessLike } from './IProcessSpawner';
import type { IManagedProcess } from './IManagedProcess';

/**
 * Configuration for a log file source to tail automatically.
 */
export interface LogSourceConfig {
  /** Source tag used in handler.sources filter (e.g., 'debug-log') */
  name: string;
  /** 'file' = single file, 'directory' = watch dir for newest .log file */
  type: 'file' | 'directory';
  /** Absolute path to the file or directory */
  path: string;
  /** Fallback poll interval in ms (default: 500). Only used when fs.watch misses events. */
  pollIntervalMs?: number;
  /** Use fs.watch() for near-realtime notification (default: true) */
  watch?: boolean;
  /** Debounce interval for rapid fs.watch events (default: 50ms) */
  debounceMs?: number;
  /** PID of the owning process — when set, directory-mode tailers only tail files
   *  whose name contains this PID (e.g. `process-{ts}-{pid}.log`). */
  pid?: number;
}

/**
 * Options for creating a managed process.
 */
export interface ManagedProcessOptions {
  /** Process identity — used by handler registry to match handler factories */
  label: string;
  /** Log sources to tail automatically */
  logSources?: LogSourceConfig[];
  /** Plan context — passed to handler factories for per-job handler creation */
  planId?: string;
  nodeId?: string;
  worktreePath?: string;
}

/**
 * Factory for wrapping spawned processes with output bus + handlers + log tailers.
 *
 * @example
 * ```typescript
 * const proc = spawner.spawn('copilot', args, opts);
 * const managed = factory.create(proc, {
 *   label: 'copilot',
 *   logSources: [{ name: 'debug-log', type: 'file', path: debugLogPath }],
 *   planId, nodeId, worktreePath,
 * });
 * managed.on('exit', (code) => { ... });
 * ```
 */
export interface IManagedProcessFactory {
  /**
   * Wrap an already-spawned process with output bus + handlers + log tailers.
   * The factory asks the handler registry for matching handlers based on label,
   * creates a ProcessOutputBus, wires stdout/stderr, starts log tailers.
   */
  create(proc: ChildProcessLike, options: ManagedProcessOptions): IManagedProcess;
}
