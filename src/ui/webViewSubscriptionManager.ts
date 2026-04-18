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
import { Logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

const smLog = Logger.for('ui');

/** Crash-safe disk logger — writes synchronously so data survives OOM/crash. */
function crashLog(msg: string): void {
  try {
    const logPath = path.join(process.cwd(), '.orchestrator', 'debug-events.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* best-effort */ }
}

/**
 * Interface for data producers that generate content for webview subscriptions.
 * Each producer type handles one kind of data source (log files, process stats, etc.).
 */
export interface EventProducer<TCursor = any> {
  /** Unique type identifier, e.g., 'log', 'processStats', 'aiUsage' */
  readonly type: string;

  /**
   * Optional async pre-tick hook. Called once per tick cycle BEFORE any
   * readDelta calls. Use this for producers that need to fetch data
   * asynchronously (e.g., OS process snapshots) and cache it for
   * synchronous reads.
   *
   * This runs once per tick, not once per subscription — so a producer
   * serving 10 subscriptions only fetches once.
   */
  prepareTick?(): Promise<void>;

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

  /**
   * Optional teardown hook. Called by `WebViewSubscriptionManager.dispose()`.
   * Producers that attach long-lived listeners (e.g. EventEmitter handlers on
   * a manager) MUST implement this to detach those listeners, otherwise the
   * subscription manager will leak references when the host view is recreated
   * (extension reload, tests, future refactors).
   */
  dispose?(): void;
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

    // Diagnostic: track subscription creation for debugging re-creation loops
    const totalSubs = this.subs.size;
    if (totalSubs > 50) {
      crashLog(`subscribe(${producerType}, ${tag}) — total subs now ${totalSubs + 1} for panel ${panelId}`);
      smLog.warn(`subscribe(${producerType}, ${tag}) — total subs now ${totalSubs + 1} for panel ${panelId}`);
    }

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
   * Tear down the manager: clear all subscriptions and dispose every
   * registered producer that implements the optional `dispose()` hook.
   * Call this when the host (e.g. plansViewProvider) is being disposed so
   * producer-attached EventEmitter listeners do not leak across reloads.
   */
  dispose(): void {
    this.subs.clear();
    for (const producer of this.producers.values()) {
      try { producer.dispose?.(); } catch { /* best-effort */ }
    }
    this.producers.clear();
  }

  /**
   * Process all active subscriptions. Called on each pulse tick (~1 second).
   *
   * First calls `prepareTick()` on any producers that implement it (async
   * pre-fetch for OS data, etc.), then reads deltas synchronously from all
   * active subscriptions.
   *
   * Paused subscriptions are skipped entirely — zero IO.
   */
  private _ticking = false;
  private _tickCount = 0;
  async tick(): Promise<void> {
    if (this._ticking) { return; }
    this._ticking = true;
    this._tickCount++;
    // Log every 10th tick to disk for crash diagnosis
    if (this._tickCount % 10 === 1) {
      crashLog(`tick #${this._tickCount}, subs=${this.subs.size}, producers=${this.producers.size}`);
    }
    try {
      await this._doTick();
    } catch (err: any) {
      crashLog(`tick() EXCEPTION: ${err.message}\n${err.stack}`);
      smLog.error(`tick() error: ${err.message}`);
    } finally {
      this._ticking = false;
    }
  }

  private async _doTick(): Promise<void> {
    // Phase 1: Async pre-fetch — producers that need OS data cache it here
    const producersNeedingPrep: EventProducer[] = [];
    for (const producer of this.producers.values()) {
      if (producer.prepareTick) {
        producersNeedingPrep.push(producer);
      }
    }
    if (producersNeedingPrep.length > 0) {
      await Promise.all(producersNeedingPrep.map(p => 
        p.prepareTick!().catch((err: any) => smLog.error(`prepareTick error in ${p.type}: ${err.message}`))
      ));
    }

    // Phase 2: Synchronous delta reads + webview delivery
    let deliveredCount = 0;
    const deliveredTags: string[] = [];
    for (const sub of this.subs.values()) {
      if (sub.state !== 'active') { continue; }
      if (sub.cursor === null) { continue; }

      const producer = this.producers.get(sub.producerType);
      if (!producer) { continue; }

      let delta: { content: any; cursor: any } | null;
      try {
        delta = producer.readDelta(sub.producerKey, sub.cursor);
      } catch (err: any) {
        crashLog(`readDelta ERROR in ${sub.producerType}[${sub.tag}]: ${err.message}`);
        smLog.error(`readDelta error in ${sub.producerType}[${sub.tag}]: ${err.message}`);
        continue;
      }
      if (!delta) { continue; }

      sub.cursor = delta.cursor;
      deliveredCount++;
      deliveredTags.push(sub.tag);
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

    // Diagnostic: log when excessive messages are delivered per tick
    if (deliveredCount > 10) {
      crashLog(`tick delivered ${deliveredCount} deltas: ${deliveredTags.slice(0, 10).join(', ')}`);
      smLog.warn(`tick delivered ${deliveredCount} deltas: ${deliveredTags.slice(0, 10).join(', ')}${deliveredTags.length > 10 ? '...' : ''}`);
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
