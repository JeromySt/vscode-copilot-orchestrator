/**
 * @fileoverview Abstract base class for webview controls that participate
 * in the inner-out update cascade via {@link EventBus}.
 *
 * @module ui/webview/subscribableControl
 */

import { EventBus, Subscription } from './eventBus';
import { Topics } from './topics';

// Polyfill for environments without queueMicrotask (e.g. older browsers).
const enqueue: (cb: () => void) => void =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (cb) => Promise.resolve().then(cb);

/**
 * Base class for controls that publish updates and subscribe to children.
 *
 * `subscribeToChild()` debounces by one microtask so that when multiple
 * siblings emit simultaneously the parent recalculates only once.
 */
export abstract class SubscribableControl {
  protected readonly bus: EventBus;
  protected readonly controlId: string;

  private readonly subs: Subscription[] = [];
  private disposed = false;
  private pendingMicrotask = false;
  private pendingChildHandler: (() => void) | null = null;

  constructor(bus: EventBus, controlId: string) {
    this.bus = bus;
    this.controlId = controlId;
  }

  // ── subscriptions ──────────────────────────────────────────────────────

  /** Subscribe to an arbitrary topic. */
  protected subscribe(topic: string, handler: (data?: any) => void): Subscription {
    const sub = this.bus.on(topic, handler);
    this.subs.push(sub);
    return sub;
  }

  /**
   * Subscribe to a child control's update topic with microtask debouncing.
   *
   * When multiple children fire within the same microtask, `handler` is
   * invoked only once — after all synchronous work completes.
   */
  protected subscribeToChild(childId: string, handler: () => void): Subscription {
    this.pendingChildHandler = handler;
    const sub = this.bus.on(Topics.controlUpdate(childId), () => {
      if (this.disposed) { return; }
      if (!this.pendingMicrotask) {
        this.pendingMicrotask = true;
        enqueue(() => {
          this.pendingMicrotask = false;
          if (!this.disposed && this.pendingChildHandler) {
            this.pendingChildHandler();
          }
        });
      }
    });
    this.subs.push(sub);
    return sub;
  }

  /** Remove all subscriptions owned by this control. */
  protected unsubscribeAll(): void {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    this.subs.length = 0;
  }

  /** Publish this control's update event. */
  protected publishUpdate(data?: any): void {
    this.bus.emit(Topics.controlUpdate(this.controlId), data);
  }

  /** Receive external data and update the control's DOM. */
  abstract update(data?: any): void;

  /** Convenience helper — returns the element or `null`. */
  protected getElement(id: string): any {
    if (typeof globalThis !== 'undefined' && (globalThis as any).document) {
      return (globalThis as any).document.getElementById(id);
    }
    return null;
  }

  /** Tear down: unsubscribe everything. */
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.unsubscribeAll();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
