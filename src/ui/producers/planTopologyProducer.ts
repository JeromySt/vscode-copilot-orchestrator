/**
 * @fileoverview Plan topology event producer for WebView subscriptions.
 *
 * Detects when the plan's DAG topology changes (nodes added/removed/renamed,
 * dependency edges changed) and delivers a signal to trigger Mermaid re-render.
 * Status-only changes are NOT topology changes — those are handled by
 * {@link NodeStateProducer}.
 *
 * @module ui/producers/planTopologyProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { JobNode } from '../../plan/types';

/** Cursor: hash of node IDs + dependencies. */
export type PlanTopologyCursor = string;

/** Content shape: signal + new topology snapshot for Mermaid. */
export interface PlanTopologyContent {
  /** Whether the topology changed since last read. */
  changed: boolean;
  /** Number of nodes in the plan (for UI display). */
  nodeCount: number;
  /** Plan stateVersion at time of read. */
  stateVersion: number;
}

/**
 * Detects DAG topology changes (node add/remove/rename, dependency rewiring).
 * Key: `planId`.
 */
export class PlanTopologyProducer implements EventProducer<PlanTopologyCursor> {
  readonly type = 'planTopology';

  constructor(private readonly _runner: IPlanRunner) {}

  readFull(key: string): { content: PlanTopologyContent; cursor: PlanTopologyCursor } | null {
    const plan = this._runner.get(key);
    if (!plan) { return null; }
    const hash = this._computeHash(plan);
    return {
      content: { changed: false, nodeCount: plan.jobs.size, stateVersion: plan.stateVersion },
      cursor: hash,
    };
  }

  readDelta(key: string, cursor: PlanTopologyCursor): { content: PlanTopologyContent; cursor: PlanTopologyCursor } | null {
    const plan = this._runner.get(key);
    if (!plan) { return null; }
    const hash = this._computeHash(plan);
    if (hash === cursor) { return null; } // No topology change
    return {
      content: { changed: true, nodeCount: plan.jobs.size, stateVersion: plan.stateVersion },
      cursor: hash,
    };
  }

  /** Compute a lightweight hash of the DAG structure (not status). */
  private _computeHash(plan: { jobs: Map<string, any> }): string {
    // Only hash structural fields: IDs, names, dependencies
    const parts: string[] = [];
    for (const [id, node] of plan.jobs) {
      const deps = (node as JobNode).dependencies?.join(',') || '';
      parts.push(`${id}:${node.name}:${deps}`);
    }
    parts.sort(); // Deterministic ordering
    return parts.join('|');
  }
}
