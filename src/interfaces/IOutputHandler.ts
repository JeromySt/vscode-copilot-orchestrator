/**
 * @fileoverview Interface for process output handlers.
 *
 * Defines the typed output source descriptor system and the handler contract
 * used by {@link IProcessOutputBus} to dispatch lines to registered handlers.
 *
 * Handlers declare which sources they listen to (stdout, stderr, log files)
 * using strongly typed {@link OutputSource} descriptors rather than raw strings.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §4.4
 * @module interfaces/IOutputHandler
 */

/**
 * Strongly typed output source descriptor.
 * Handlers declare which sources they listen to using these types,
 * not raw strings.
 */
export type OutputSource =
  | { type: 'stdout' }
  | { type: 'stderr' }
  | { type: 'log-file'; pattern: string };

/** Frozen singleton source descriptors — no allocation per handler */
export const OutputSources = {
  stdout: Object.freeze({ type: 'stdout' } as const),
  stderr: Object.freeze({ type: 'stderr' } as const),
  logFile: (pattern: string): OutputSource => Object.freeze({ type: 'log-file', pattern } as const),
} as const;

/**
 * Get the source key used internally by the bus for matching.
 * - stdout → 'stdout'
 * - stderr → 'stderr'
 * - log-file with pattern 'debug-log' → 'log-file:debug-log'
 */
export function sourceKey(source: OutputSource): string {
  if (source.type === 'log-file') { return `log-file:${source.pattern}`; }
  return source.type;
}

/**
 * Handler that receives lines from a {@link IProcessOutputBus}.
 *
 * Each handler declares which sources it listens to and how many trailing
 * lines it needs for pattern matching (windowSize). The bus maintains a
 * per-source sliding window and invokes `onLine` for each new line.
 */
export interface IOutputHandler {
  /** Unique name for retrieval via bus.getHandler(name) */
  readonly name: string;
  /** Which sources this handler listens to — strongly typed */
  readonly sources: OutputSource[];
  /** Number of trailing lines this handler needs to evaluate a match */
  readonly windowSize: number;
  /**
   * Called for each new line from a matching source.
   * @param window - The last N lines (handler's windowSize) for this source. ReadonlyArray — no copies.
   * @param source - The typed source that produced this line
   */
  onLine(window: ReadonlyArray<string>, source: OutputSource): void;
  /** Optional cleanup when the bus is disposed. */
  dispose?(): void;
}
