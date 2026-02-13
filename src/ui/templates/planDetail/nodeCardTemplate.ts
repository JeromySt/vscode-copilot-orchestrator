/**
 * @fileoverview Plan detail node card / stats template.
 *
 * Renders the node statistics section (total, succeeded, failed, running,
 * pending) and the progress bar for the plan detail view.
 *
 * @module ui/templates/planDetail/nodeCardTemplate
 */

import type { NodeStatus } from '../../../plan/types/nodes';

/**
 * Input data for rendering the plan stats and progress section.
 */
export interface PlanNodeCardData {
  /** Total number of nodes (including child plans) */
  total: number;
  /** Per-status node counts */
  counts: Record<NodeStatus, number>;
  /** Computed progress percentage (0-100) */
  progress: number;
  /** Computed plan status */
  status: string;
}

/**
 * Render the node statistics grid and progress bar HTML fragment.
 *
 * Shows five stat cards (Total Nodes, Succeeded, Failed, Running, Pending)
 * and a progress bar whose fill color matches the plan status.
 *
 * @param data - Node card input data.
 * @returns HTML fragment string.
 */
export function renderPlanNodeCard(data: PlanNodeCardData): string {
  const { total, counts, progress, status } = data;

  const progressClass = status === 'failed' ? 'failed' : status === 'succeeded' ? 'succeeded' : '';

  return `
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${total}</div>
      <div class="stat-label">Total Nodes</div>
    </div>
    <div class="stat">
      <div class="stat-value succeeded">${counts.succeeded || 0}</div>
      <div class="stat-label">Succeeded</div>
    </div>
    <div class="stat">
      <div class="stat-value failed">${counts.failed || 0}</div>
      <div class="stat-label">Failed</div>
    </div>
    <div class="stat">
      <div class="stat-value running">${(counts.running || 0) + (counts.scheduled || 0)}</div>
      <div class="stat-label">Running</div>
    </div>
    <div class="stat">
      <div class="stat-value">${(counts.pending || 0) + (counts.ready || 0)}</div>
      <div class="stat-label">Pending</div>
    </div>
  </div>
  
  <div class="progress-container">
    <div class="progress-bar">
      <div class="progress-fill ${progressClass}" 
           style="width: ${progress}%"></div>
    </div>
  </div>
  `;
}
