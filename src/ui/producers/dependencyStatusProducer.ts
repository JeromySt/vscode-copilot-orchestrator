/**
 * @fileoverview Dependency status event producer for WebView subscriptions.
 *
 * Tracks the status of all dependencies for a plan node, delivering deltas
 * only when any dependency status changes between ticks.
 *
 * @module ui/producers/dependencyStatusProducer
 */

import type { EventProducer } from '../webViewSubscriptionManager';
import type { IPlanRunner } from '../../interfaces/IPlanRunner';
import type { NodeStatus } from '../../plan/types';

/** Cursor type — JSON-serialized dependency status array for change detection. */
export type DependencyStatusCursor = string;

/** Shape of a single dependency entry. */
export interface DependencyStatus {
  name: string;
  status: NodeStatus;
}

/**
 * Event producer for dependency statuses of a plan node.
 * Key format: `planId:nodeId`
 */
export class DependencyStatusProducer implements EventProducer<DependencyStatusCursor> {
  readonly type = 'deps';

  constructor(private readonly _planRunner: IPlanRunner) {}

  private _getDependencies(key: string): DependencyStatus[] | null {
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) { return null; }
    const planId = key.slice(0, colonIdx);
    const nodeId = key.slice(colonIdx + 1);

    const plan = this._planRunner.get(planId);
    if (!plan) { return null; }

    const node = plan.jobs.get(nodeId);
    if (!node) { return null; }

    return node.dependencies.map((depId) => {
      const depNode = plan.jobs.get(depId);
      const depState = plan.nodeStates.get(depId);
      return {
        name: depNode?.name ?? depId,
        status: depState?.status ?? 'pending',
      };
    });
  }

  readFull(key: string): { content: DependencyStatus[] | null; cursor: DependencyStatusCursor } | null {
    const deps = this._getDependencies(key);
    return { content: deps, cursor: JSON.stringify(deps) };
  }

  readDelta(key: string, cursor: DependencyStatusCursor): { content: DependencyStatus[] | null; cursor: DependencyStatusCursor } | null {
    const deps = this._getDependencies(key);
    const serialized = JSON.stringify(deps);
    if (serialized === cursor) { return null; }
    return { content: deps, cursor: serialized };
  }
}
