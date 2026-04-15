/**
 * @fileoverview Process stats event producer for WebView subscriptions.
 *
 * Delivers process tree data including PID, running status, OS-level CPU/memory
 * stats, and the full process hierarchy. Uses the {@link EventProducer.prepareTick}
 * hook to take a single async OS process snapshot per tick cycle, then serves
 * it synchronously to all subscriptions via {@link readDelta}.
 *
 * The async pre-fetch pattern avoids:
 * - Multiple OS queries per tick (one snapshot serves all subscriptions)
 * - Blocking the synchronous tick loop with async operations
 * - Stale data from synchronous-only reads (pid/running without tree)
 *
 * @module ui/producers/processStatsProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { IProcessMonitor } from '../../interfaces/IProcessMonitor';
import type { ProcessNode } from '../../types';

/** Cursor type for process stats — generation counter to detect changes. */
export type ProcessStatsCursor = number;

/** Full content shape delivered to webviews — matches ProcessTree control's expected data. */
export interface ProcessStatsContent {
  pid: number | null;
  running: boolean;
  /** Full process hierarchy with CPU/memory per node. */
  tree: ProcessNode[];
  /** Elapsed runtime in milliseconds since execution started. */
  duration: number | null;
  /** Whether this is an agent work phase (shows "Agent starting..." before PID). */
  isAgentWork?: boolean;
}

/**
 * Event producer for node process stats with full OS process tree.
 *
 * Key format: `planId:nodeId`.
 *
 * Uses `prepareTick()` to take a single OS process snapshot per tick, then
 * serves cached tree data synchronously from `readDelta()`. This ensures:
 * - One OS query per tick (not per subscription)
 * - Full process hierarchy data (CPU, memory, child processes)
 * - No async operations in the synchronous `readDelta` path
 */
export class ProcessStatsProducer implements EventProducer<ProcessStatsCursor> {
  readonly type = 'processStats';

  /** Cached process snapshot from the latest prepareTick() call. */
  private _cachedSnapshot: any[] = [];
  /** Generation counter — increments on each prepareTick() so readDelta always delivers. */
  private _generation = 0;

  constructor(
    private readonly _runner: IPlanRunner,
    private readonly _processMonitor?: IProcessMonitor,
  ) {}

  /**
   * Async pre-tick hook — takes one OS process snapshot per tick cycle.
   * Called by WebViewSubscriptionManager before the synchronous read loop.
   */
  async prepareTick(): Promise<void> {
    this._generation++;
    if (!this._processMonitor) { return; }
    try {
      this._cachedSnapshot = await this._processMonitor.getSnapshot();
    } catch {
      this._cachedSnapshot = [];
    }
  }

  readFull(key: string): { content: ProcessStatsContent; cursor: ProcessStatsCursor } | null {
    const stats = this._buildStats(key);
    if (!stats) { return null; }
    return { content: stats, cursor: this._generation };
  }

  readDelta(key: string, cursor: ProcessStatsCursor): { content: ProcessStatsContent; cursor: ProcessStatsCursor } | null {
    if (cursor === this._generation) { return null; }
    const stats = this._buildStats(key);
    if (!stats) { return null; }
    if (!stats.running) { return null; }
    return { content: stats, cursor: this._generation };
  }

  private _buildStats(key: string): ProcessStatsContent | null {
    const sep = key.indexOf(':');
    if (sep < 0) { return null; }
    const planId = key.slice(0, sep);
    const nodeId = key.slice(sep + 1);
    const plan = this._runner.get(planId);
    if (!plan) { return null; }
    const state = plan.nodeStates.get(nodeId);
    if (!state) { return null; }

    const running = state.status === 'running' || state.status === 'scheduled';
    const duration = state.startedAt != null
      ? (state.endedAt ?? Date.now()) - state.startedAt
      : null;
    const pid = state.pid ?? null;
    const isAgentWork = running && !pid;

    let tree: ProcessNode[] = [];
    if (pid && this._processMonitor && this._cachedSnapshot.length > 0) {
      try {
        tree = this._processMonitor.buildTree([pid], this._cachedSnapshot);
      } catch { /* ignore */ }
    }

    return { pid, running, tree, duration, isAgentWork };
  }
}
