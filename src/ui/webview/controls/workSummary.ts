/**
 * @fileoverview Work summary control — displays file change counts.
 *
 * Subscribes to {@link Topics.WORK_SUMMARY} and renders commit and
 * file change statistics.
 *
 * @module ui/webview/controls/workSummary
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Data delivered with each update. */
export interface WorkSummaryData {
  totalCommits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
}

/**
 * Work summary control that shows file change statistics.
 */
export class WorkSummary extends SubscribableControl {
  private elementId: string;

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.subscribe(Topics.WORK_SUMMARY, (data?: WorkSummaryData) => this.update(data));
  }

  update(data?: WorkSummaryData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    const hasChanges = data.totalCommits > 0 || data.filesAdded > 0 ||
                       data.filesModified > 0 || data.filesDeleted > 0;

    if (!hasChanges) {
      el.style.display = 'none';
      this.publishUpdate(data);
      return;
    }

    el.style.display = '';
    el.innerHTML = `<div class="work-summary-grid">
      <div class="work-stat"><div class="work-stat-value">${data.totalCommits}</div><div class="work-stat-label">Commits</div></div>
      <div class="work-stat added"><div class="work-stat-value">+${data.filesAdded}</div><div class="work-stat-label">Added</div></div>
      <div class="work-stat modified"><div class="work-stat-value">~${data.filesModified}</div><div class="work-stat-label">Modified</div></div>
      <div class="work-stat deleted"><div class="work-stat-value">-${data.filesDeleted}</div><div class="work-stat-label">Deleted</div></div>
    </div>`;
    this.publishUpdate(data);
  }
}
