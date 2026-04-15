/**
 * @fileoverview Release list event producer for WebView subscriptions.
 *
 * Tracks all releases and delivers deltas when any release's status changes
 * or releases are added/removed. Uses a serialized ID→status map as cursor.
 *
 * @module ui/producers/releaseListProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IReleaseManager } from '../../interfaces/IReleaseManager';

/** Cursor: serialized map of releaseId→status. */
export type ReleaseListCursor = string;

/** Summary shape for a single release. */
export interface ReleaseSummary {
  id: string;
  name: string;
  status: string;
  releaseBranch: string;
  targetBranch: string;
  planCount: number;
  prNumber?: number;
  prUrl?: string;
  progress: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/**
 * Event producer for the list of all releases.
 * Key: `all` (fixed — one subscription covers all releases).
 */
export class ReleaseListProducer implements EventProducer<ReleaseListCursor> {
  readonly type = 'releaseList';

  constructor(private readonly _manager: IReleaseManager) {}

  private _getSummaries(): ReleaseSummary[] {
    return this._manager.getAllReleases().map(release => {
      let progress = 0;
      switch (release.status) {
        case 'drafting': progress = 10; break;
        case 'merging': progress = 30; break;
        case 'creating-pr': progress = 50; break;
        case 'monitoring': case 'addressing': progress = 75; break;
        case 'succeeded': progress = 100; break;
        case 'failed': case 'canceled': progress = 0; break;
      }
      return {
        id: release.id,
        name: release.name,
        status: release.status,
        releaseBranch: release.releaseBranch,
        targetBranch: release.targetBranch,
        planCount: release.planIds.length,
        prNumber: release.prNumber,
        prUrl: release.prUrl,
        progress,
        createdAt: release.createdAt,
        startedAt: release.startedAt,
        endedAt: release.endedAt,
      };
    });
  }

  private _buildCursor(summaries: ReleaseSummary[]): ReleaseListCursor {
    const map: Record<string, string> = {};
    for (const s of summaries) { map[s.id] = s.status; }
    return JSON.stringify(map);
  }

  readFull(_key: string): { content: ReleaseSummary[]; cursor: ReleaseListCursor } | null {
    const summaries = this._getSummaries();
    return { content: summaries, cursor: this._buildCursor(summaries) };
  }

  readDelta(_key: string, cursor: ReleaseListCursor): { content: { changed: ReleaseSummary[]; removed: string[] }; cursor: ReleaseListCursor } | null {
    const summaries = this._getSummaries();
    const newCursor = this._buildCursor(summaries);
    if (newCursor === cursor) { return null; }

    let prevMap: Record<string, string> = {};
    try { prevMap = JSON.parse(cursor); } catch { return { content: { changed: summaries, removed: [] }, cursor: newCursor }; }

    const changed = summaries.filter(s => prevMap[s.id] === undefined || prevMap[s.id] !== s.status);
    const currentIds = new Set(summaries.map(s => s.id));
    const removed = Object.keys(prevMap).filter(id => !currentIds.has(id));

    return { content: { changed, removed }, cursor: newCursor };
  }
}
