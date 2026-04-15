/**
 * @fileoverview Process output bus implementation.
 *
 * Central dispatch: splits raw process output into lines, maintains per-source
 * sliding windows, and invokes matching {@link IOutputHandler} instances.
 *
 * The bus is per-invocation — each spawned process gets its own bus with its
 * own line buffers, windows, and handler instances.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §5.1
 * @module process/processOutputBus
 */

import type { IProcessOutputBus } from '../interfaces/IProcessOutputBus';
import type { IOutputHandler, OutputSource } from '../interfaces/IOutputHandler';
import { sourceKey } from '../interfaces/IOutputHandler';
import { Logger } from '../core/logger';

const log = Logger.for('process-output-bus');

/** Maximum line length before forced line break (prevents unbounded buffer on progress spinners) */
const MAX_LINE_LENGTH = 65_536; // 64KB

/**
 * Bus-level metrics for diagnostics.
 */
export interface BusMetrics {
  /** Total lines fed per source key */
  linesBySource: Record<string, number>;
  /** Total handler invocations */
  handlerInvocations: number;
  /** Handler errors caught and swallowed */
  handlerErrors: number;
}

export class ProcessOutputBus implements IProcessOutputBus {
  private _windows = new Map<string, string[]>();
  private _lineBuffers = new Map<string, string>();
  private _handlers = new Map<string, IOutputHandler>();
  /** Per-source max(handler.windowSize) — determines sliding window capacity */
  private _maxWindowPerSource = new Map<string, number>();
  /** Pre-computed dispatch table: sourceKey → handler[] (built at register() time) */
  private _handlersBySourceKey = new Map<string, IOutputHandler[]>();
  private _metrics: BusMetrics = { linesBySource: {}, handlerInvocations: 0, handlerErrors: 0 };
  private _lineCallback?: (line: string, source: OutputSource) => void;

  /** Set callback for IManagedProcess 'line' event emission */
  setLineCallback(cb: (line: string, source: OutputSource) => void): void {
    this._lineCallback = cb;
  }

  register(handler: IOutputHandler): void {
    this._handlers.set(handler.name, handler);
    // Pre-compute source key → handler[] dispatch table (avoids per-line sourceKey() calls)
    for (const src of handler.sources) {
      const key = sourceKey(src);
      const existing = this._handlersBySourceKey.get(key) ?? [];
      existing.push(handler);
      this._handlersBySourceKey.set(key, existing);
      // Track per-source max window
      const current = this._maxWindowPerSource.get(key) ?? 0;
      if (handler.windowSize > current) { this._maxWindowPerSource.set(key, handler.windowSize); }
    }
  }

  /** Internal — called by ManagedProcess and LogFileTailer only */
  feed(chunk: string, source: OutputSource): void {
    const key = sourceKey(source);
    const buffer = (this._lineBuffers.get(key) ?? '') + chunk;
    const lines = buffer.split(/\r?\n/);
    let remainder = lines.pop() ?? '';
    // Guard: if remainder exceeds max length, force a line break
    if (remainder.length > MAX_LINE_LENGTH) {
      lines.push(remainder);
      remainder = '';
    }
    this._lineBuffers.set(key, remainder);

    const maxWin = this._maxWindowPerSource.get(key) ?? 0;
    const handlers = this._handlersBySourceKey.get(key);
    if (!handlers || handlers.length === 0) { return; }

    for (const line of lines) {
      if (line.length === 0) { continue; }
      this._metrics.linesBySource[key] = (this._metrics.linesBySource[key] ?? 0) + 1;

      // Emit line event for IManagedProcess listeners
      this._lineCallback?.(line, source);

      // Update sliding window (skip if all handlers need windowSize=1)
      let window: string[];
      if (maxWin <= 1) {
        window = [line]; // fast path — no window management
      } else {
        const win = this._windows.get(key) ?? [];
        win.push(line);
        if (win.length > maxWin) { win.splice(0, win.length - maxWin); }
        this._windows.set(key, win);
        window = win;
      }

      // Dispatch to matching handlers — errors isolated per handler
      for (const handler of handlers) {
        try {
          const tail = handler.windowSize >= window.length
            ? window
            : window.slice(window.length - handler.windowSize);
          handler.onLine(tail, source);
          this._metrics.handlerInvocations++;
        } catch (err) {
          this._metrics.handlerErrors++;
          // Log but don't propagate — one handler failure must not break others
          log.error('Handler threw', { handler: handler.name, error: String(err) });
        }
      }
    }
  }

  getHandler<T extends IOutputHandler>(name: string): T | undefined {
    return this._handlers.get(name) as T | undefined;
  }

  getHandlerNames(): string[] {
    return Array.from(this._handlers.keys());
  }

  getMetrics(): Readonly<BusMetrics> { return this._metrics; }

  dispose(): void {
    for (const h of this._handlers.values()) { h.dispose?.(); }
    this._handlers.clear();
    this._handlersBySourceKey.clear();
    this._windows.clear();
    this._lineBuffers.clear();
  }
}
