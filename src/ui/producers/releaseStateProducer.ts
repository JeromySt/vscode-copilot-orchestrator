/**
 * @fileoverview Release state event producer for WebView subscriptions.
 *
 * Tracks a single release's full state (status, tasks, PR info, plans)
 * and delivers deltas when any field changes. Also buffers real-time
 * streaming events (task output, PR cycles, actions, findings) and
 * delivers them as batches on each pulse tick.
 *
 * Key: `releaseId`.
 *
 * @module ui/producers/releaseStateProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IReleaseManager } from '../../interfaces/IReleaseManager';
import type { EventEmitter } from 'events';

/** Cursor: serialized status + version counter. */
export type ReleaseStateCursor = string;

/** Buffered streaming event from the release manager. */
export interface ReleaseStreamEvent {
  type: 'taskOutput' | 'cycleCompleted' | 'prUpdate' | 'actionTaken' |
        'findingsResolved' | 'findingsProcessing' | 'monitoringStopped' |
        'pollIntervalChanged';
  data: any;
}

/** Content shape delivered to webviews. */
export interface ReleaseStateContent {
  /** Full release data snapshot (status, tasks, PR, plans, etc.). */
  release?: any;
  /** Available plans for the plan selector. */
  availablePlans?: any[];
  /** Buffered streaming events since last delta. */
  events: ReleaseStreamEvent[];
  /** Whether the release was deleted. */
  deleted?: boolean;
}

/**
 * Event producer for a single release's state + streaming events.
 * Key: `releaseId`.
 *
 * Subscribes to the release manager's EventEmitter to buffer real-time
 * events (task output, PR cycles, etc.) for delivery on the next tick.
 */
export class ReleaseStateProducer implements EventProducer<ReleaseStateCursor> {
  readonly type = 'releaseState';

  private _eventBuffer: Map<string, ReleaseStreamEvent[]> = new Map();
  private _listeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  constructor(
    private readonly _manager: IReleaseManager,
    private readonly _getAvailablePlans?: () => any[],
  ) {
    // Buffer streaming events from the release manager
    const mgr = _manager as unknown as EventEmitter;
    if (typeof mgr.on === 'function') {
      this._listenAndBuffer(mgr, 'releaseTaskOutput', (releaseId: string, taskId: string, line: string) => ({
        type: 'taskOutput' as const, data: { taskId, line },
      }));
      this._listenAndBuffer(mgr, 'releasePRCycle', (releaseId: string, cycle: any) => {
        const checks = cycle.checks || [];
        const comments = cycle.comments || [];
        const alerts = cycle.securityAlerts || [];
        return [
          { type: 'cycleCompleted' as const, data: cycle },
          { type: 'prUpdate' as const, data: {
            stats: {
              checksPass: checks.filter((c: any) => c.status === 'passing' || c.status === 'skipped').length,
              checksFail: checks.filter((c: any) => c.status === 'failing').length,
              unresolvedThreads: comments.filter((c: any) => !c.isResolved).length,
              unresolvedAlerts: alerts.filter((a: any) => !a.resolved).length,
            },
          }},
        ];
      });
      this._listenAndBuffer(mgr, 'releaseActionTaken', (releaseId: string, action: any) => ({
        type: 'actionTaken' as const, data: action,
      }));
      this._listenAndBuffer(mgr, 'findingsResolved', (releaseId: string, findingIds: string[], hasCommit: boolean) => ({
        type: 'findingsResolved' as const, data: { findingIds, hasCommit },
      }));
      this._listenAndBuffer(mgr, 'findingsProcessing', (releaseId: string, findingIds: string[], status: string, sessionId?: string) => ({
        type: 'findingsProcessing' as const, data: { findingIds, status, sessionId },
      }));
      this._listenAndBuffer(mgr, 'monitoringStopped', (releaseId: string, totalCycles: number) => ({
        type: 'monitoringStopped' as const, data: { totalCycles },
      }));
      this._listenAndBuffer(mgr, 'pollIntervalChanged', (releaseId: string, intervalTicks: number) => ({
        type: 'pollIntervalChanged' as const, data: { intervalSeconds: intervalTicks },
      }));
    }
  }

  readFull(key: string): { content: ReleaseStateContent; cursor: ReleaseStateCursor } | null {
    const release = this._manager.getRelease(key);
    if (!release) { return null; }
    const content: ReleaseStateContent = {
      release: this._buildReleaseData(release),
      availablePlans: this._getAvailablePlans?.(),
      events: [],
    };
    return { content, cursor: this._buildCursor(release) };
  }

  readDelta(key: string, cursor: ReleaseStateCursor): { content: ReleaseStateContent; cursor: ReleaseStateCursor } | null {
    const release = this._manager.getRelease(key);

    // Flush buffered events for this release
    const events = this._eventBuffer.get(key) || [];
    this._eventBuffer.delete(key);

    if (!release) {
      if (events.length === 0) { return null; }
      // Release deleted but events were buffered — deliver them
      return { content: { events, deleted: true }, cursor: cursor + ':deleted' };
    }

    const newCursor = this._buildCursor(release);
    if (newCursor === cursor && events.length === 0) { return null; }

    const content: ReleaseStateContent = {
      release: this._buildReleaseData(release),
      availablePlans: this._getAvailablePlans?.(),
      events,
    };
    return { content, cursor: newCursor };
  }

  /** Clean up event listeners. */
  dispose(): void {
    const mgr = this._manager as unknown as EventEmitter;
    if (typeof mgr.removeListener === 'function') {
      for (const { event, fn } of this._listeners) {
        mgr.removeListener(event, fn);
      }
    }
    this._listeners = [];
    this._eventBuffer.clear();
  }

  private _buildCursor(release: any): ReleaseStateCursor {
    return `${release.status}:${release.planIds?.length ?? 0}:${release.prNumber ?? ''}:${release.updatedAt ?? release.startedAt ?? 0}`;
  }

  private _buildReleaseData(release: any): any {
    let progress = 0;
    switch (release.status) {
      case 'drafting': progress = 10; break;
      case 'merging': progress = 30; break;
      case 'creating-pr': progress = 50; break;
      case 'monitoring': case 'addressing': progress = 75; break;
      case 'succeeded': progress = 100; break;
    }
    return {
      id: release.id,
      name: release.name,
      status: release.status,
      releaseBranch: release.releaseBranch,
      targetBranch: release.targetBranch,
      planIds: release.planIds,
      planCount: release.planIds?.length ?? 0,
      prNumber: release.prNumber,
      prUrl: release.prUrl,
      progress,
      createdAt: release.createdAt,
      startedAt: release.startedAt,
      endedAt: release.endedAt,
      prepTasks: release.prepTasks,
      error: release.error,
    };
  }

  /**
   * Subscribe to a release manager event and buffer it for the matching releaseId.
   * The transform function extracts the releaseId and produces one or more events.
   */
  private _listenAndBuffer(
    mgr: EventEmitter,
    event: string,
    transform: (...args: any[]) => ReleaseStreamEvent | ReleaseStreamEvent[],
  ): void {
    const fn = (...args: any[]) => {
      const releaseId = args[0]; // First arg is always releaseId
      const result = transform(...args);
      const events = Array.isArray(result) ? result : [result];
      if (!this._eventBuffer.has(releaseId)) {
        this._eventBuffer.set(releaseId, []);
      }
      this._eventBuffer.get(releaseId)!.push(...events);
    };
    mgr.on(event, fn);
    this._listeners.push({ event, fn });
  }
}
