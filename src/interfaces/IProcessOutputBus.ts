/**
 * @fileoverview Interface for the process output bus.
 *
 * The bus is the central dispatch mechanism that splits raw process output
 * into lines, maintains per-source sliding windows, and invokes matching
 * {@link IOutputHandler} instances.
 *
 * The `feed()` method is intentionally NOT on the public interface — only
 * `ManagedProcess` and `LogFileTailer` call it internally.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §4.3
 * @module interfaces/IProcessOutputBus
 */

import type { BusMetrics } from '../process/processOutputBus';
import type { IOutputHandler } from './IOutputHandler';

export interface IProcessOutputBus {
  /** Retrieve a registered handler by name, cast to the expected type. */
  getHandler<T extends IOutputHandler>(name: string): T | undefined;
  /** Names of all registered handlers */
  getHandlerNames(): string[];
  /** Bus-level metrics for diagnostics */
  getMetrics(): Readonly<BusMetrics>;
  /** Clean up all handlers and internal state. Called automatically on process exit. */
  dispose(): void;
}
