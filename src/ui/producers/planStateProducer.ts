/**
 * @fileoverview Plan state event producer for WebView subscriptions.
 *
 * Delivers a summary of plan-level status, node counts, progress, and
 * timeline data to webviews. Uses PlanInstance.stateVersion as a cursor
 * so deltas are only pushed when the plan state actually changes.
 *
 * @module ui/producers/planStateProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { PlanStatus, NodeStatus } from '../../plan/types';

/** Cursor type for plan state tracking — stateVersion number. */
export type PlanStateCursor = number;

/** Content shape delivered to webviews. */
export interface PlanStateContent {
  status: PlanStatus;
  /** Count of nodes in each status. */
  counts: Record<NodeStatus, number>;
  /** Completion percentage [0–100]. */
  progress: number;
  /** Effective start timestamp (ms), or null. */
  startedAt: number | null;
  /** Effective end timestamp (ms), or null. */
  endedAt: number | null;
}

/**
 * Event producer for plan-level state.
 * Key: `planId`.
 */
export class PlanStateProducer implements EventProducer<PlanStateCursor> {
  readonly type = 'planState';

  constructor(private readonly _runner: IPlanRunner) {}

  /**
   * Read the full current plan state.
   * @param key - `planId`
   */
  readFull(key: string): { content: PlanStateContent; cursor: PlanStateCursor } | null {
    return this._build(key);
  }

  /**
   * Read state only if the plan's stateVersion has advanced past the cursor.
   * @param key - `planId`
   * @param cursor - stateVersion from last read
   */
  readDelta(key: string, cursor: PlanStateCursor): { content: PlanStateContent; cursor: PlanStateCursor } | null {
    const plan = this._runner.get(key);
    if (!plan) {
      // Plan was deleted — deliver a terminal 'deleted' status so webviews can
      // close themselves instead of relying on direct PlanRunner event listeners.
      return {
        content: {
          status: 'deleted' as any,
          counts: {} as any,
          progress: 100,
          startedAt: null,
          endedAt: null,
        },
        cursor: cursor + 1,
      };
    }
    if (plan.stateVersion <= cursor) { return null; }
    return this._build(key);
  }

  private _build(planId: string): { content: PlanStateContent; cursor: PlanStateCursor } | null {
    const plan = this._runner.get(planId);
    if (!plan) { return null; }

    const statusInfo = this._runner.getStatus(planId);
    if (!statusInfo) { return null; }

    const content: PlanStateContent = {
      status: statusInfo.status,
      counts: statusInfo.counts,
      progress: statusInfo.progress,
      startedAt: this._runner.getEffectiveStartedAt(planId) ?? null,
      endedAt: this._runner.getEffectiveEndedAt(planId) ?? null,
    };

    return { content, cursor: plan.stateVersion };
  }
}
