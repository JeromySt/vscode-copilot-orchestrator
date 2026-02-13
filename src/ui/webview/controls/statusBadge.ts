/**
 * @fileoverview Status badge control — reflects node/plan status as CSS class, icon, and color.
 *
 * Subscribes to {@link Topics.NODE_STATE_CHANGE} or {@link Topics.PLAN_STATE_CHANGE}
 * and updates the element's class list, text content, and optional icon.
 *
 * @module ui/webview/controls/statusBadge
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Known status → icon mapping. */
const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  ready: '○',
  scheduled: '◉',
  running: '▶',
  succeeded: '✓',
  failed: '✗',
  paused: '⏸',
};

/** Known status → CSS class mapping. */
const STATUS_CLASSES = ['pending', 'ready', 'scheduled', 'running', 'succeeded', 'failed', 'paused'];

/** Data delivered with each update. */
export interface StatusBadgeData {
  status: string;
  nodeId?: string;
}

/**
 * Status badge that shows a status icon and applies a CSS status class.
 */
export class StatusBadge extends SubscribableControl {
  private elementId: string;
  private topic: string;
  private currentStatus = '';

  constructor(bus: EventBus, controlId: string, elementId: string, topic?: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.topic = topic || Topics.NODE_STATE_CHANGE;
    this.subscribe(this.topic, (data?: StatusBadgeData) => this.update(data));
  }

  update(data?: StatusBadgeData): void {
    if (!data || !data.status) { return; }
    this.currentStatus = data.status;
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    // Remove old status classes
    for (const cls of STATUS_CLASSES) {
      if (el.classList) {
        el.classList.remove(cls);
      }
    }
    // Add new status class
    if (el.classList) {
      el.classList.add(data.status);
    }

    const icon = STATUS_ICONS[data.status] || '';
    el.textContent = `${icon} ${data.status}`;
    this.publishUpdate(data);
  }

  /** Get the current status. */
  getStatus(): string {
    return this.currentStatus;
  }
}
