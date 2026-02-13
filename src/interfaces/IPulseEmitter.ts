/**
 * @fileoverview Interface for the pulse event emitter.
 *
 * Provides a single-interval heartbeat that UI components subscribe to
 * instead of creating their own `setInterval` timers.
 *
 * @module interfaces/IPulseEmitter
 */

/**
 * A disposable subscription handle.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * A single-interval pulse emitter that fires every ~1 second.
 *
 * UI components subscribe via {@link onPulse} and receive periodic
 * callbacks without managing their own timers.
 *
 * The emitter auto-starts when the first subscriber is added and
 * auto-stops when the last subscriber is removed.
 */
export interface IPulseEmitter {
  /** Subscribe to pulse events. Dispose the returned handle to unsubscribe. */
  onPulse(callback: () => void): Disposable;

  /** Whether the internal interval is currently running. */
  readonly isRunning: boolean;
}
