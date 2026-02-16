/**
 * @fileoverview Central pulse emitter for the extension.
 *
 * Replaces per-component `setInterval` timers with a single heartbeat.
 * UI components subscribe via {@link onPulse} and receive a callback
 * every ~1 000 ms.  The interval auto-starts when the first subscriber
 * is added and auto-stops when the last subscriber is removed.
 *
 * **No `vscode` imports** — this module is framework-agnostic.
 *
 * @module core/pulse
 */

import { EventEmitter } from 'events';
import type { IPulseEmitter, Disposable } from '../interfaces/IPulseEmitter';

const PULSE_INTERVAL_MS = 1000;
const PULSE_EVENT = 'pulse';

/**
 * Single-interval pulse emitter.
 *
 * @example
 * ```ts
 * const pulse = new PulseEmitter();
 * const sub = pulse.onPulse(() => console.log('tick'));
 * // … later
 * sub.dispose();
 * ```
 */
export class PulseEmitter extends EventEmitter implements IPulseEmitter {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _subscriberCount = 0;

  /** Whether the internal interval is currently ticking. */
  get isRunning(): boolean {
    return this._timer !== undefined;
  }

  /**
   * Subscribe to pulse events.
   *
   * Auto-starts the interval when the first subscriber is added.
   * Disposing the returned handle auto-stops the interval when the
   * last subscriber is removed.
   */
  onPulse(callback: () => void): Disposable {
    this.on(PULSE_EVENT, callback);
    this._subscriberCount++;

    if (this._subscriberCount === 1) {
      this.start();
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {return;}
        disposed = true;
        this.removeListener(PULSE_EVENT, callback);
        this._subscriberCount--;
        if (this._subscriberCount === 0) {
          this.stop();
        }
      },
    };
  }

  /** Manually start the interval (idempotent). */
  start(): void {
    if (this._timer !== undefined) {return;}
    this._timer = setInterval(() => this.emit(PULSE_EVENT), PULSE_INTERVAL_MS);
  }

  /** Manually stop the interval (idempotent). */
  stop(): void {
    if (this._timer === undefined) {return;}
    clearInterval(this._timer);
    this._timer = undefined;
  }
}
