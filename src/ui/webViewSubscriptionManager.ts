/**
 * @fileoverview Generic WebView Subscription Manager.
 *
 * Provides a pub/sub bridge between webview panels and extension host event
 * producers. Webviews subscribe to specific data sources (log files, process
 * stats, etc.) and receive targeted deltas. Subscriptions are paused when the
 * panel isn't visible and resumed with catch-up when it becomes visible again.
 *
 * This is the extension host counterpart to the webview's EventBus — extending
 * the same pub/sub pattern across the process boundary.
 *
 * @module ui/webViewSubscriptionManager
 */

import type * as vscode from 'vscode';

/**
 * Interface for data producers that generate content for webview subscriptions.
 * Each producer type handles one kind of data source (log files, process stats, etc.).
 */
export interface EventProducer<TCursor = any> {
  /** Unique type identifier, e.g., 'log', 'processStats', 'aiUsage' */
  readonly type: string;

  /**
   * Read the full initial state for a subscription.
   * Called when a subscription is first created or resumed after pause.
   *
   * @param key - Producer-specific key (e.g., file path, nodeId)
   * @returns Full content and cursor for subsequent delta reads, or null if unavailable.
   */
  readFull(key: string): { content: any; cursor: TCursor } | null;

  /**
   * Read delta content since the last cursor position.
   * Called on each pulse tick for active subscriptions.
   *
   * @param key - Producer-specific key
   * @param cursor - Cursor from the last read
   * @returns Delta content and updated cursor, or null if no changes.
   */
  readDelta(key: string, cursor: TCursor): { content: any; cursor: TCursor } | null;
}

/** Internal subscription record. */
interface Subscription {
  id: string;
  panelId: string;
  producerType: string;
  producerKey: string;
  tag: string;
  state: 'active' | 'paused';
  cursor: any;
  webview: vscode.Webview;
}

/**
 * Manages webview subscriptions to extension host event producers.
 *
 * Usage:
 * ```typescript
 * const manager = new WebViewSubscriptionManager();
 * manager.registerProducer(new LogFileProducer());
 *
 * // On webview message:
 * manager.subscribe(panelId, webview, 'log', '/path/to/file.log', 'attempt-3');
 *
 * // On pulse tick:
 * manager.tick();
 *
 * // On panel visibility change:
 * manager.pausePanel(panelId);
 * manager.resumePanel(panelId);
 *
 * // On panel dispose:
 * manager.disposePanel(panelId);
 * ```
 */
export class WebViewSubscriptionManager {
  private subs = new Map<string, Subscription>();
  private producers = new Map<string, EventProducer>();
  private nextId = 1;

  /**
   * Register an event producer. Multiple producers can be registered, each
   * identified by its `type` string.
   */
  registerProducer(producer: EventProducer): void {
    this.producers.set(producer.type, producer);
  }

  /**
   * Create a new subscription. Immediately sends the full initial content
   * to the webview.
   *
   * @param panelId - Unique identifier for the webview panel
   * @param webview - The webview to send messages to
   * @param producerType - Which producer to subscribe to
   * @param producerKey - Producer-specific key (e.g., file path)
   * @param tag - Opaque tag passed back to the webview for routing to DOM elements
   * @returns Subscription ID, or null if the producer type is not registered.
   */
  subscribe(
    panelId: string,
    webview: vscode.Webview,
    producerType: string,
    producerKey: string,
    tag: string,
  ): string | null {
    const producer = this.producers.get(producerType);
    if (!producer) { return null; }

    const id = `sub-${this.nextId++}`;
    const initial = producer.readFull(producerKey);

    const sub: Subscription = {
      id,
      panelId,
      producerType,
      producerKey,
      tag,
      state: 'active',
      cursor: initial?.cursor ?? null,
      webview,
    };
    this.subs.set(id, sub);

    // Send initial full content
    if (initial) {
      try {
        webview.postMessage({
          type: 'subscriptionData',
          subscriptionId: id,
          tag,
          full: true,
          content: initial.content,
        });
      } catch { /* webview disposed */ }
    }

    return id;
  }

  /**
   * Remove a subscription. No more messages will be sent for this subscription.
   */
  unsubscribe(subscriptionId: string): void {
    this.subs.delete(subscriptionId);
  }

  /**
   * Pause all subscriptions for a panel (e.g., when the panel is hidden).
   * Cursors are preserved so resumePanel() can send a catch-up batch.
   */
  pausePanel(panelId: string): void {
    for (const sub of this.subs.values()) {
      if (sub.panelId === panelId) {
        sub.state = 'paused';
      }
    }
  }

  /**
   * Resume all subscriptions for a panel (e.g., when the panel becomes visible).
   * Sends a catch-up batch for each subscription with accumulated content since pause.
   */
  resumePanel(panelId: string): void {
    for (const sub of this.subs.values()) {
      if (sub.panelId === panelId && sub.state === 'paused') {
        sub.state = 'active';
        // Send catch-up: read everything accumulated since pause
        const producer = this.producers.get(sub.producerType);
        if (producer && sub.cursor !== null) {
          const delta = producer.readDelta(sub.producerKey, sub.cursor);
          if (delta) {
            sub.cursor = delta.cursor;
            try {
              sub.webview.postMessage({
                type: 'subscriptionData',
                subscriptionId: sub.id,
                tag: sub.tag,
                full: false,
                content: delta.content,
              });
            } catch { /* webview disposed */ }
          }
        }
      }
    }
  }

  /**
   * Remove all subscriptions for a panel (e.g., when the panel is disposed).
   */
  disposePanel(panelId: string): void {
    for (const [id, sub] of this.subs) {
      if (sub.panelId === panelId) {
        this.subs.delete(id);
      }
    }
  }

  /**
   * Process all active subscriptions. Called on each pulse tick (~1 second).
   * Reads deltas from producers and sends them to the appropriate webviews.
   * Paused subscriptions are skipped entirely — zero IO.
   */
  tick(): void {
    for (const sub of this.subs.values()) {
      if (sub.state !== 'active') { continue; }
      if (sub.cursor === null) { continue; }

      const producer = this.producers.get(sub.producerType);
      if (!producer) { continue; }

      const delta = producer.readDelta(sub.producerKey, sub.cursor);
      if (!delta) { continue; }

      sub.cursor = delta.cursor;
      try {
        sub.webview.postMessage({
          type: 'subscriptionData',
          subscriptionId: sub.id,
          tag: sub.tag,
          full: false,
          content: delta.content,
        });
      } catch { /* webview disposed */ }
    }
  }

  /**
   * Send an end signal for a subscription (e.g., job finished, no more updates).
   */
  endSubscription(subscriptionId: string): void {
    const sub = this.subs.get(subscriptionId);
    if (!sub) { return; }
    try {
      sub.webview.postMessage({
        type: 'subscriptionEnd',
        subscriptionId: sub.id,
        tag: sub.tag,
      });
    } catch { /* webview disposed */ }
    this.subs.delete(subscriptionId);
  }

  /**
   * Find a subscription by panel, producer type, and key.
   * Useful for checking if a subscription already exists before creating a duplicate.
   */
  findSubscription(panelId: string, producerType: string, producerKey: string): string | undefined {
    for (const [id, sub] of this.subs) {
      if (sub.panelId === panelId && sub.producerType === producerType && sub.producerKey === producerKey) {
        return id;
      }
    }
    return undefined;
  }

  /** Get the count of active (non-paused) subscriptions. */
  get activeCount(): number {
    let count = 0;
    for (const sub of this.subs.values()) {
      if (sub.state === 'active') { count++; }
    }
    return count;
  }

  /** Get the total subscription count. */
  get totalCount(): number {
    return this.subs.size;
  }
}
