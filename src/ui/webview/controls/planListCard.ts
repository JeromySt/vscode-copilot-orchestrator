/**
 * @fileoverview Plan list card control — sidebar plan entry with status/progress.
 *
 * Subscribes to {@link Topics.PLAN_STATE_CHANGE} and updates the sidebar
 * card with current status, progress percentage, and node counts.
 *
 * @module ui/webview/controls/planListCard
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { escapeHtml } from '../../templates/helpers';

/** Data delivered with each update. */
export interface PlanListCardData {
  planId: string;
  planName: string;
  status: string;
  progress: number;
  totalNodes: number;
  succeededNodes: number;
  failedNodes: number;
  runningNodes: number;
}

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  running: '▶',
  succeeded: '✓',
  failed: '✗',
  paused: '⏸',
};



/**
 * Sidebar plan list card showing plan status and progress.
 */
export class PlanListCard extends SubscribableControl {
  private elementId: string;
  private planId: string;

  constructor(bus: EventBus, controlId: string, elementId: string, planId: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.planId = planId;
    this.subscribe(Topics.PLAN_STATE_CHANGE, (data?: PlanListCardData) => {
      if (data && data.planId === this.planId) {
        this.update(data);
      }
    });
  }

  update(data?: PlanListCardData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    const icon = STATUS_ICONS[data.status] || '○';
    const pct = Math.max(0, Math.min(100, data.progress));

    el.innerHTML = `<div class="plan-card-header">
      <span class="plan-card-icon">${icon}</span>
      <span class="plan-card-name">${escapeHtml(data.planName)}</span>
      <span class="plan-card-status ${data.status}">${data.status}</span>
    </div>
    <div class="plan-card-progress"><div class="plan-card-progress-fill" style="width:${pct}%"></div></div>
    <div class="plan-card-counts">
      <span class="count-total">${data.totalNodes} nodes</span>
      <span class="count-succeeded">✓${data.succeededNodes}</span>
      <span class="count-failed">✗${data.failedNodes}</span>
      <span class="count-running">▶${data.runningNodes}</span>
    </div>`;

    el.className = `plan-list-card ${data.status}`;
    this.publishUpdate(data);
  }
}
