/**
 * @fileoverview Context pressure event producer for WebView subscriptions.
 *
 * Tracks context pressure state for a single plan node, delivering deltas
 * only when the state's lastUpdated timestamp advances past the cursor.
 *
 * @module ui/producers/contextPressureProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IContextPressureMonitor, ContextPressureState } from '../../interfaces/IContextPressureMonitor';

/** Cursor type — lastUpdated timestamp for change detection. */
export type ContextPressureCursor = number;

/**
 * Callback to look up the active context pressure monitor for a node.
 * Returns undefined when no monitor is active (node not running, or
 * monitoring infrastructure not yet wired).
 */
export type GetMonitorFn = (planId: string, nodeId: string) => IContextPressureMonitor | undefined;

/**
 * Event producer for context pressure state of a plan node.
 * Key format: `planId:nodeId`
 */
export class ContextPressureProducer implements EventProducer<ContextPressureCursor> {
  readonly type = 'contextPressure';

  constructor(private readonly _getMonitor: GetMonitorFn) {}

  private _getState(key: string): ContextPressureState | null {
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) { return null; }
    const planId = key.slice(0, colonIdx);
    const nodeId = key.slice(colonIdx + 1);

    const monitor = this._getMonitor(planId, nodeId);
    if (!monitor) { return null; }

    return monitor.getState();
  }

  readFull(key: string): { content: ContextPressureState | null; cursor: ContextPressureCursor } | null {
    const state = this._getState(key);
    if (!state) { return null; }
    return { content: state, cursor: state.lastUpdated };
  }

  readDelta(key: string, cursor: ContextPressureCursor): { content: ContextPressureState | null; cursor: ContextPressureCursor } | null {
    const state = this._getState(key);
    if (!state) { return null; }
    if (state.lastUpdated <= cursor) { return null; }
    return { content: state, cursor: state.lastUpdated };
  }
}
