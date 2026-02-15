/**
 * @fileoverview Lightweight pub/sub event bus for webview controls.
 * Zero dependencies — works in Node.js and browser environments.
 *
 * @module ui/webview/eventBus
 */

/** Handle returned by {@link EventBus.on} / {@link EventBus.once}. */
export interface Subscription {
  unsubscribe(): void;
  readonly topic: string;
  readonly isActive: boolean;
}

/**
 * Synchronous publish/subscribe event bus.
 *
 * - `emit()` invokes handlers synchronously over a snapshot, so
 *   unsubscribing inside a handler is safe.
 * - `once()` auto-unsubscribes after the first invocation.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<(data?: any) => void>>();

  /** Subscribe to a topic. */
  on(topic: string, handler: (data?: any) => void): Subscription {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return this.createSubscription(topic, handler);
  }

  /** Subscribe to a topic; auto-unsubscribes after the first call. */
  once(topic: string, handler: (data?: any) => void): Subscription {
    const wrapper = (data?: any): void => {
      sub.unsubscribe();
      handler(data);
    };
    const sub = this.on(topic, wrapper);
    return sub;
  }

  /** Emit a topic synchronously (snapshot-safe). */
  emit(topic: string, data?: any): void {
    const set = this.handlers.get(topic);
    if (!set) { return; }
    // Iterate over a snapshot so removals during iteration are safe.
    for (const fn of [...set]) {
      fn(data);
    }
  }

  /**
   * Remove handlers.
   * - With a topic: clears that topic's handlers.
   * - Without: clears **all** handlers.
   */
  clear(topic?: string): void {
    if (topic !== undefined) {
      this.handlers.delete(topic);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Count subscriptions.
   * - With a topic: count for that topic.
   * - Without: total across all topics.
   */
  count(topic?: string): number {
    if (topic !== undefined) {
      return this.handlers.get(topic)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }

  // ── private ────────────────────────────────────────────────────────────

  private createSubscription(
    topic: string,
    handler: (data?: any) => void,
  ): Subscription {
    let active = true;
    return {
      get isActive() { return active; },
      topic,
      unsubscribe: () => {
        if (!active) { return; }
        active = false;
        const set = this.handlers.get(topic);
        if (set) {
          set.delete(handler);
          if (set.size === 0) { this.handlers.delete(topic); }
        }
      },
    };
  }
}
