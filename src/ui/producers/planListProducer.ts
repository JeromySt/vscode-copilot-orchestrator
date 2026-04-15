/**
 * @fileoverview Plan list event producer for WebView subscriptions.
 *
 * Tracks the list of all plans and delivers deltas when any plan's
 * stateVersion changes or new plans are added/removed.
 *
 * @module ui/producers/planListProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { PlanStatus } from '../../plan/types';

/**
 * Cursor type — maps planId to stateVersion for change detection.
 * Serialized as JSON for comparison.
 */
export type PlanListCursor = string;

/** Summary shape for a single plan. */
export interface PlanSummary {
  id: string;
  name: string;
  status: PlanStatus;
  stateVersion: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  nodes: number;
  progress: number;
  counts: {
    running: number;
    succeeded: number;
    failed: number;
    pending: number;
  };
}

/**
 * Event producer for the list of all plans.
 * Key: `all` (fixed — one subscription covers all plans)
 */
export class PlanListProducer implements EventProducer<PlanListCursor> {
  readonly type = 'planList';

  constructor(private readonly _planRunner: IPlanRunner) {}

  private _getSummaries(): PlanSummary[] {
    return this._planRunner.getAll().filter((plan) => !plan.parentPlanId).map((plan) => {
      const statusInfo = this._planRunner.getStatus(plan.id);
      const counts = statusInfo?.counts ?? {
        pending: 0, ready: 0, scheduled: 0, running: 0,
        succeeded: 0, failed: 0, blocked: 0, canceled: 0,
      };
      return {
        id: plan.id,
        name: plan.spec.name,
        status: statusInfo?.status ?? 'pending',
        stateVersion: plan.stateVersion,
        createdAt: plan.createdAt,
        startedAt: plan.startedAt,
        endedAt: this._planRunner.getEffectiveEndedAt(plan.id) ?? plan.endedAt,
        nodes: plan.jobs.size,
        progress: statusInfo?.progress ?? 0,
        counts: {
          running: counts.running,
          succeeded: counts.succeeded,
          failed: counts.failed,
          pending: (counts.pending ?? 0) + (counts.ready ?? 0),
        },
      };
    });
  }

  /** Build a cursor string: serialized map of planId → stateVersion. */
  private _buildCursor(summaries: PlanSummary[]): PlanListCursor {
    const versionMap: Record<string, number> = {};
    for (const s of summaries) {
      versionMap[s.id] = s.stateVersion;
    }
    return JSON.stringify(versionMap);
  }

  readFull(_key: string): { content: PlanSummary[]; cursor: PlanListCursor } | null {
    const summaries = this._getSummaries();
    return { content: summaries, cursor: this._buildCursor(summaries) };
  }

  readDelta(_key: string, cursor: PlanListCursor): { content: { changed: PlanSummary[]; removed: string[] }; cursor: PlanListCursor } | null {
    const summaries = this._getSummaries();
    const newCursor = this._buildCursor(summaries);

    if (newCursor === cursor) { return null; }

    // Return only plans that are new or have a changed stateVersion
    let prevVersionMap: Record<string, number> = {};
    try {
      prevVersionMap = JSON.parse(cursor) as Record<string, number>;
    } catch {
      // Malformed cursor — return full list as changed
      return { content: { changed: summaries, removed: [] }, cursor: newCursor };
    }

    const changed = summaries.filter(
      (s) => prevVersionMap[s.id] === undefined || prevVersionMap[s.id] !== s.stateVersion,
    );

    // Detect removed plans: IDs in previous cursor but not in current summaries
    const currentIds = new Set(summaries.map(s => s.id));
    const removed = Object.keys(prevVersionMap).filter(id => !currentIds.has(id));

    return { content: { changed, removed }, cursor: newCursor };
  }
}
