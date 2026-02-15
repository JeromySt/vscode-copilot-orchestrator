/**
 * @fileoverview Group container control — aggregates child status with debounce.
 *
 * Uses {@link SubscribableControl.subscribeToChild} to watch children,
 * computes an aggregate status, and cascades the result to its own parent.
 *
 * @module ui/webview/controls/groupContainer
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';

/** Data delivered with each update. */
export interface GroupContainerData {
  childStatuses: Record<string, string>;
}

/** Priority order: higher wins. */
const STATUS_PRIORITY: Record<string, number> = {
  failed: 5,
  running: 4,
  scheduled: 3,
  ready: 2,
  pending: 1,
  succeeded: 0,
};

/**
 * Compute aggregate status from child statuses.
 *
 * @param statuses - Map of child IDs to their status strings.
 * @returns The aggregate status string.
 */
export function aggregateStatus(statuses: Record<string, string>): string {
  const values = Object.values(statuses);
  if (values.length === 0) { return 'pending'; }
  if (values.every(s => s === 'succeeded')) { return 'succeeded'; }
  let highest = '';
  let highestPri = -1;
  for (const s of values) {
    const p = STATUS_PRIORITY[s] ?? 0;
    if (p > highestPri) {
      highestPri = p;
      highest = s;
    }
  }
  return highest || 'pending';
}

/**
 * Container that aggregates status of child controls.
 */
export class GroupContainer extends SubscribableControl {
  private elementId: string;
  private childStatuses: Record<string, string> = {};
  private currentStatus = 'pending';

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
  }

  /** Register a child control to watch. */
  addChild(childId: string, initialStatus = 'pending'): void {
    this.childStatuses[childId] = initialStatus;
    this.subscribeToChild(childId, () => this.recalculate());
  }

  update(data?: GroupContainerData): void {
    if (!data) { return; }
    this.childStatuses = { ...data.childStatuses };
    this.recalculate();
  }

  private recalculate(): void {
    this.currentStatus = aggregateStatus(this.childStatuses);
    const el = this.getElement(this.elementId);
    if (el) {
      el.setAttribute('data-status', this.currentStatus);
    }
    this.publishUpdate({ status: this.currentStatus });
  }

  /** Update a single child's status. */
  setChildStatus(childId: string, status: string): void {
    this.childStatuses[childId] = status;
  }

  getStatus(): string {
    return this.currentStatus;
  }
}
