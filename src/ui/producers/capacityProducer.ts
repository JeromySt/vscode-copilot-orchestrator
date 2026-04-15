/**
 * @fileoverview Global capacity event producer for WebView subscriptions.
 *
 * Delivers global job capacity stats (running jobs, max parallel, multi-instance)
 * to the sidebar. Uses a generation counter + running job count as cursor so
 * deltas are only sent when capacity actually changes.
 *
 * @module ui/producers/capacityProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';

/** Cursor: serialized running count + stateVersions hash. */
export type CapacityCursor = string;

/** Content shape delivered to webviews. */
export interface CapacityContent {
  globalStats: {
    running: number;
    maxParallel: number;
    queued: number;
  };
  globalCapacity: {
    thisInstanceJobs: number;
    totalGlobalJobs: number;
    globalMaxParallel: number;
    activeInstances: number;
    instanceDetails: any[];
  } | null;
}

/**
 * Delivers global capacity stats.
 * Key: `all` (fixed — one subscription for the sidebar).
 */
export class CapacityProducer implements EventProducer<CapacityCursor> {
  readonly type = 'capacity';

  private _lastContent: CapacityContent | null = null;
  private _pendingCapacityPromise: Promise<any> | null = null;
  private _lastCapacityResult: any = null;

  constructor(private readonly _runner: IPlanRunner) {}

  async prepareTick(): Promise<void> {
    // Pre-fetch global capacity (async OS operation) during the async tick phase
    try {
      this._pendingCapacityPromise = this._runner.getGlobalCapacityStats();
      this._lastCapacityResult = await this._pendingCapacityPromise;
    } catch {
      this._lastCapacityResult = null;
    }
    this._pendingCapacityPromise = null;
  }

  readFull(_key: string): { content: CapacityContent; cursor: CapacityCursor } | null {
    const content = this._build();
    const cursor = this._computeCursor(content);
    this._lastContent = content;
    return { content, cursor };
  }

  readDelta(_key: string, cursor: CapacityCursor): { content: CapacityContent; cursor: CapacityCursor } | null {
    const content = this._build();
    const newCursor = this._computeCursor(content);
    if (newCursor === cursor) { return null; }
    this._lastContent = content;
    return { content, cursor: newCursor };
  }

  private _build(): CapacityContent {
    const globalStats = this._runner.getGlobalStats();
    const cap = this._lastCapacityResult;
    return {
      globalStats,
      globalCapacity: cap ? {
        thisInstanceJobs: cap.thisInstanceJobs,
        totalGlobalJobs: cap.totalGlobalJobs,
        globalMaxParallel: cap.globalMaxParallel,
        activeInstances: cap.activeInstances,
        instanceDetails: cap.instanceDetails,
      } : null,
    };
  }

  private _computeCursor(content: CapacityContent): CapacityCursor {
    return `${content.globalStats.running}:${content.globalStats.queued}:${content.globalCapacity?.totalGlobalJobs ?? 0}`;
  }
}
