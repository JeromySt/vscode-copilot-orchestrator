/**
 * @fileoverview Interface for managed processes with output bus integration.
 *
 * A managed process wraps a {@link ChildProcessLike} with:
 * - An {@link IProcessOutputBus} for structured output handling
 * - High-resolution lifecycle timestamps via `performance.now()`
 * - Computed durations derived from timestamps
 * - Comprehensive diagnostics for logging and debugging
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §4.2
 * @module interfaces/IManagedProcess
 */

import type { BusMetrics } from '../process/processOutputBus';
import type { TailerMetrics } from '../process/logFileTailer';
import type { IProcessOutputBus } from './IProcessOutputBus';
import type { OutputSource } from './IOutputHandler';

/**
 * High-resolution timestamp captured via `performance.now()`.
 * Stored as milliseconds with sub-millisecond fractional precision (~5μs on most platforms).
 *
 * For display/serialization, convert to wall-clock via:
 *   wallMs = processOriginEpoch + hrTimestamp
 * where processOriginEpoch = Date.now() - performance.now() (captured once at module load).
 */
export type HrTimestamp = number;

/**
 * Module-level epoch anchor: wall-clock millis at the time `performance.now()` was 0.
 * Used to convert HrTimestamp → Date for display/persistence.
 */
export const processOriginEpoch: number = Date.now() - performance.now();

/** Convert a high-resolution timestamp to a wall-clock epoch ms value. */
export function hrToEpoch(hr: HrTimestamp): number {
  return processOriginEpoch + hr;
}

/**
 * Lifecycle timestamps for a managed process.
 * All values are high-resolution `performance.now()` timestamps for sub-ms precision.
 * Use `hrToEpoch()` to convert to wall-clock milliseconds for display.
 */
export interface ProcessTimestamps {
  /** When spawn() was called by the caller */
  requested: HrTimestamp;
  /** When the child process was actually created (post child_process.spawn) */
  created?: HrTimestamp;
  /** When the process emitted its first stdout/stderr data (confirms it's alive) */
  running?: HrTimestamp;
  /** When kill() was called (by caller, timeout, or watchdog) */
  killRequested?: HrTimestamp;
  /** When the OS confirmed the kill (process exited after kill request) */
  killed?: HrTimestamp;
  /** When the process exited (any reason — normal, error, signal, kill) */
  exited?: HrTimestamp;
}

/**
 * Computed durations derived from timestamps.
 * All values are milliseconds with sub-ms fractional precision.
 * Undefined if the prerequisite timestamps aren't available.
 */
export interface ProcessDurations {
  /** Total wall time from spawn request to process exit: exited - requested */
  total?: number;
  /** Time to spawn: created - requested */
  spawnLatency?: number;
  /** Time from created to first output: running - created */
  startupLatency?: number;
  /** Process active time: exited - created */
  processLifetime?: number;
  /** Time from kill request to actual exit: exited - killRequested */
  killLatency?: number;
}

/**
 * Comprehensive diagnostic snapshot for logging and debugging.
 * Available at any point in the process lifecycle.
 */
export interface ProcessDiagnostics {
  pid: number | undefined;
  exitCode: number | null;
  killed: boolean;
  timestamps: ProcessTimestamps;
  durations: ProcessDurations;
  /** Names of all registered handlers */
  handlerNames: string[];
  /** Bus-level metrics: lines per source, handler invocations, errors */
  busMetrics: BusMetrics;
  /** Per-tailer metrics: bytes read, offset, errors */
  tailerMetrics: Array<TailerMetrics>;
}

/**
 * A managed process with output bus integration and lifecycle diagnostics.
 *
 * Created via {@link IManagedProcessFactory.create} by wrapping an
 * already-spawned {@link ChildProcessLike}. Provides structured output
 * handling, high-resolution timestamps, and comprehensive diagnostics.
 */
export interface IManagedProcess {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly killed: boolean;
  /** The output bus for this process invocation. Handlers are pre-registered. */
  readonly bus: IProcessOutputBus;
  /** Lifecycle timestamps — populated as events occur */
  readonly timestamps: Readonly<ProcessTimestamps>;
  /** Computed durations — derived from timestamps, available after exit */
  readonly durations: ProcessDurations;
  /**
   * Diagnostic snapshot — all lifecycle state, handler names, bus metrics, tailer metrics.
   * Use for logging on failure or debugging missing handler output.
   */
  diagnostics(): ProcessDiagnostics;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  /** Emitted for every complete line from any source. Handlers AND line listeners both fire. */
  on(event: 'line', listener: (line: string, source: OutputSource) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}
