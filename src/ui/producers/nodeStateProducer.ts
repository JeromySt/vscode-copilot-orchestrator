/**
 * @fileoverview Node state event producer for WebView subscriptions.
 *
 * Delivers processed node state change data to webviews using stateVersion
 * for efficient delta detection. Only pushes data when the node's version
 * advances past the cursor, avoiding unnecessary re-renders.
 *
 * The content includes pre-computed phaseStatus and currentPhase fields so
 * the webview message router can directly emit NODE_STATE_CHANGE events
 * without replicating phase-status computation logic in the browser.
 *
 * @module ui/producers/nodeStateProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { NodeExecutionState } from '../../plan/types';

/** Cursor type for node state tracking — stateVersion number. */
export type NodeStateCursor = number;

/** Content delivered to webviews — maps to the NODE_STATE_CHANGE event shape. */
export interface NodeStateChangeContent {
  status: string;
  version: number;
  phaseStatus: Record<string, string>;
  currentPhase?: string;
  startedAt?: number;
  endedAt?: number;
}

/**
 * Compute phase status indicators from node execution state.
 * Mirrors the _getPhaseStatus() logic in NodeDetailPanel.
 */
export function computePhaseStatus(state: NodeExecutionState): Record<string, string> {
  const result: Record<string, string> = {
    'merge-fi': 'pending',
    prechecks: 'pending',
    work: 'pending',
    commit: 'pending',
    postchecks: 'pending',
    'merge-ri': 'pending',
  };

  const ss = state.stepStatuses
    || ((state.status === 'pending' || state.status === 'ready') && state.attemptHistory?.length
      ? state.attemptHistory[state.attemptHistory.length - 1]?.stepStatuses
      : undefined);

  if (ss) {
    result['merge-fi'] = ss['merge-fi'] || 'pending';
    result.prechecks = ss.prechecks || 'pending';
    result.work = ss.work || 'pending';
    result.commit = ss.commit || 'pending';
    result.postchecks = ss.postchecks || 'pending';
    result['merge-ri'] = ss['merge-ri'] || 'pending';
  }

  const status = state.status;
  const error = state.error || '';
  const failedPhase = state.lastAttempt?.phase;

  if (status === 'succeeded') {
    if (!ss) {
      result['merge-fi'] = 'success';
      result.prechecks = 'success';
      result.work = 'success';
      result.commit = 'success';
      result.postchecks = 'success';
      result['merge-ri'] = 'success';
    }
  } else if (status === 'failed') {
    if (failedPhase === 'merge-ri' || error.includes('Reverse integration merge')) {
      if (!ss) {
        result['merge-fi'] = 'success';
        result.prechecks = 'success';
        result.work = 'success';
        result.commit = 'success';
        result.postchecks = 'success';
      }
      result['merge-ri'] = 'failed';
    } else if (failedPhase === 'merge-fi' || error.includes('merge sources') || error.includes('Forward integration')) {
      result['merge-fi'] = 'failed';
    } else if (!ss) {
      if (error.includes('Prechecks failed')) {
        result['merge-fi'] = 'success';
        result.prechecks = 'failed';
      } else if (error.includes('Work failed')) {
        result['merge-fi'] = 'success';
        result.prechecks = 'success';
        result.work = 'failed';
      } else if (error.includes('Commit failed') || error.includes('produced no work')) {
        result['merge-fi'] = 'success';
        result.prechecks = 'success';
        result.work = 'success';
        result.commit = 'failed';
      } else if (error.includes('Postchecks failed')) {
        result['merge-fi'] = 'success';
        result.prechecks = 'success';
        result.work = 'success';
        result.commit = 'success';
        result.postchecks = 'failed';
      } else {
        result['merge-fi'] = 'success';
        result.prechecks = 'success';
        result.work = 'failed';
      }
    }
  } else if (status === 'running' && !ss) {
    result['merge-fi'] = 'success';
    result.prechecks = 'success';
    result.work = 'running';
  }

  return result;
}

/**
 * Determine the currently executing phase from node state.
 * Mirrors the getCurrentExecutionPhase() logic in NodeDetailPanel.
 */
export function computeCurrentPhase(state: NodeExecutionState): string | undefined {
  if (!state.stepStatuses) { return undefined; }
  for (const [phase, status] of Object.entries(state.stepStatuses)) {
    if (status === 'running') { return phase; }
  }
  const phaseOrder = ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
  for (const phase of phaseOrder) {
    const s = state.stepStatuses[phase as keyof typeof state.stepStatuses];
    if (!s || s === 'pending') { return phase; }
  }
  return undefined;
}

/**
 * Event producer for node execution state.
 * Key format: `planId:nodeId`.
 */
export class NodeStateProducer implements EventProducer<NodeStateCursor> {
  readonly type = 'nodeState';

  constructor(private readonly _runner: IPlanRunner) {}

  /**
   * Read the full current node state change content.
   * @param key - `planId:nodeId`
   */
  readFull(key: string): { content: NodeStateChangeContent; cursor: NodeStateCursor } | null {
    const state = this._resolve(key);
    if (!state) { return null; }
    return { content: this._buildContent(state), cursor: state.version };
  }

  /**
   * Read state only if it has changed since the cursor version.
   * @param key - `planId:nodeId`
   * @param cursor - stateVersion from last read
   */
  readDelta(key: string, cursor: NodeStateCursor): { content: NodeStateChangeContent; cursor: NodeStateCursor } | null {
    const state = this._resolve(key);
    if (!state) { return null; }
    if (state.version <= cursor) { return null; }
    return { content: this._buildContent(state), cursor: state.version };
  }

  private _buildContent(state: NodeExecutionState): NodeStateChangeContent {
    return {
      status: state.status,
      version: state.version,
      phaseStatus: computePhaseStatus(state),
      currentPhase: computeCurrentPhase(state),
      startedAt: state.startedAt,
      endedAt: state.endedAt,
    };
  }

  private _resolve(key: string): NodeExecutionState | null {
    const sep = key.indexOf(':');
    if (sep < 0) { return null; }
    const planId = key.slice(0, sep);
    const nodeId = key.slice(sep + 1);
    const plan = this._runner.get(planId);
    if (!plan) { return null; }
    // Check both nodeStates and groupStates (groups use the same producer)
    return plan.nodeStates.get(nodeId) ?? (plan.groupStates.get(nodeId) as unknown as NodeExecutionState) ?? null;
  }
}
