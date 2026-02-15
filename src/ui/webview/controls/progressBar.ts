/**
 * @fileoverview Progress bar control — displays plan completion percentage.
 *
 * Subscribes to {@link Topics.PLAN_STATE_CHANGE} and updates the fill
 * element's width and color class.
 *
 * @module ui/webview/controls/progressBar
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Data delivered with each update. */
export interface ProgressBarData {
  /** Completion percentage 0–100. */
  progress: number;
  /** Plan status (drives color). */
  status: string;
}

/** Status → CSS color class. */
function progressColorClass(status: string): string {
  if (status === 'failed') { return 'failed'; }
  if (status === 'succeeded') { return 'succeeded'; }
  return '';
}

/**
 * Progress bar control that reflects plan completion.
 */
export class ProgressBar extends SubscribableControl {
  private fillElementId: string;

  constructor(bus: EventBus, controlId: string, fillElementId: string) {
    super(bus, controlId);
    this.fillElementId = fillElementId;
    this.subscribe(Topics.PLAN_STATE_CHANGE, (data?: ProgressBarData) => this.update(data));
  }

  update(data?: ProgressBarData): void {
    if (!data) { return; }
    const el = this.getElement(this.fillElementId);
    if (!el) { return; }

    const pct = Math.max(0, Math.min(100, data.progress));
    el.style.width = `${pct}%`;

    // Update color class
    el.className = 'progress-fill';
    const colorClass = progressColorClass(data.status);
    if (colorClass) {
      el.className += ` ${colorClass}`;
    }
    this.publishUpdate(data);
  }
}
