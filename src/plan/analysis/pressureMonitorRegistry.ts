/**
 * @fileoverview Global registry for active context pressure monitors.
 *
 * Links the adapter-layer monitors (created in planInitialization.ts)
 * to the UI-layer producer (ContextPressureProducer) without requiring
 * either side to import the other.
 *
 * Key format: `planId:nodeId` (coalesces across attempts/phases — the UI
 * shows the latest active monitor for a given node).
 *
 * @module plan/analysis/pressureMonitorRegistry
 */

import type { IContextPressureMonitor } from '../../interfaces/IContextPressureMonitor';

const monitors = new Map<string, IContextPressureMonitor>();

/**
 * Register an active monitor for a plan node.
 * Overwrites any previous monitor for the same key (e.g. on retry).
 */
export function registerMonitor(planId: string, nodeId: string, monitor: IContextPressureMonitor): void {
  monitors.set(`${planId}:${nodeId}`, monitor);
}

/** Remove a monitor when the delegation ends. */
export function unregisterMonitor(planId: string, nodeId: string): void {
  monitors.delete(`${planId}:${nodeId}`);
}

/**
 * Look up the active monitor for a plan node.
 * Returns undefined when no delegation is active for this node.
 */
export function getMonitor(planId: string, nodeId: string): IContextPressureMonitor | undefined {
  return monitors.get(`${planId}:${nodeId}`);
}
