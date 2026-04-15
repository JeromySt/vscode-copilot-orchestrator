/**
 * @fileoverview AI usage metrics event producer for WebView subscriptions.
 *
 * Tracks Copilot usage metrics for a single plan node, delivering deltas
 * only when the metrics change between ticks.
 *
 * @module ui/producers/aiUsageProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { CopilotUsageMetrics } from '../../plan/types';
import { getNodeMetrics } from '../../plan/metricsAggregator';

/** Cursor type — JSON-serialized metrics for change detection. */
export type AiUsageCursor = string;

/**
 * Event producer for AI usage metrics of a plan node.
 * Key format: `planId:nodeId`
 */
export class AiUsageProducer implements EventProducer<AiUsageCursor> {
  readonly type = 'aiUsage';

  constructor(private readonly _planRunner: IPlanRunner) {}

  private _getMetrics(key: string): CopilotUsageMetrics | null {
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) { return null; }
    const planId = key.slice(0, colonIdx);
    const nodeId = key.slice(colonIdx + 1);

    const plan = this._planRunner.get(planId);
    if (!plan) { return null; }

    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) { return null; }

    return getNodeMetrics(nodeState) ?? null;
  }

  readFull(key: string): { content: CopilotUsageMetrics | null; cursor: AiUsageCursor } | null {
    const metrics = this._getMetrics(key);
    return { content: metrics, cursor: JSON.stringify(metrics) };
  }

  readDelta(key: string, cursor: AiUsageCursor): { content: CopilotUsageMetrics | null; cursor: AiUsageCursor } | null {
    const metrics = this._getMetrics(key);
    const serialized = JSON.stringify(metrics);
    if (serialized === cursor) { return null; }
    return { content: metrics, cursor: serialized };
  }
}
