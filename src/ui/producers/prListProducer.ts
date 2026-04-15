/**
 * @fileoverview PR list event producer for WebView subscriptions.
 *
 * Tracks all managed PRs and delivers deltas when any PR's status changes
 * or PRs are added/removed. Uses a serialized ID→status map as cursor
 * for efficient change detection.
 *
 * @module ui/producers/prListProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPRLifecycleManager } from '../../interfaces/IPRLifecycleManager';

/** Cursor: serialized map of prId→status. */
export type PRListCursor = string;

/** Summary shape for a single managed PR. */
export interface PRSummary {
  id: string;
  prNumber: number;
  prUrl: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  status: string;
  isDraft: boolean;
  priority: number;
  adoptedAt: number;
  unresolvedComments: number;
  failingChecks: number;
}

/**
 * Event producer for the list of all managed PRs.
 * Key: `all` (fixed — one subscription covers all PRs).
 */
export class PRListProducer implements EventProducer<PRListCursor> {
  readonly type = 'prList';

  constructor(private readonly _manager: IPRLifecycleManager) {}

  private _getSummaries(): PRSummary[] {
    return this._manager.getAllManagedPRs().map(pr => ({
      id: pr.id,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      title: pr.title,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      status: pr.status,
      isDraft: pr.status === 'adopted' || pr.status === 'monitoring',
      priority: pr.priority ?? 0,
      adoptedAt: pr.adoptedAt,
      unresolvedComments: pr.unresolvedComments ?? 0,
      failingChecks: pr.failingChecks ?? 0,
    }));
  }

  private _buildCursor(summaries: PRSummary[]): PRListCursor {
    const map: Record<string, string> = {};
    for (const s of summaries) { map[s.id] = s.status; }
    return JSON.stringify(map);
  }

  readFull(_key: string): { content: PRSummary[]; cursor: PRListCursor } | null {
    const summaries = this._getSummaries();
    return { content: summaries, cursor: this._buildCursor(summaries) };
  }

  readDelta(_key: string, cursor: PRListCursor): { content: { changed: PRSummary[]; removed: string[] }; cursor: PRListCursor } | null {
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
