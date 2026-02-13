/**
 * @fileoverview Node card control — compositional container for a single DAG node.
 *
 * Owns a {@link StatusBadge} and {@link DurationCounter} as children.
 * Updates the card border and icon based on status and publishes
 * {@link Topics.LAYOUT_CHANGE} when its size changes.
 *
 * @module ui/webview/controls/nodeCard
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { StatusBadge, StatusBadgeData } from './statusBadge';
import { DurationCounter, DurationData } from './durationCounter';

const BORDER_COLORS: Record<string, string> = {
  pending: 'var(--vscode-panel-border)',
  running: 'var(--vscode-progressBar-background)',
  succeeded: '#4ec9b0',
  failed: '#f44747',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  running: '▶',
  succeeded: '✓',
  failed: '✗',
};

/** Data delivered with each update. */
export interface NodeCardData {
  status: string;
  startedAt?: number;
  nodeId: string;
}

/**
 * Compositional node card with StatusBadge and DurationCounter children.
 */
export class NodeCard extends SubscribableControl {
  private elementId: string;
  readonly statusBadge: StatusBadge;
  readonly durationCounter: DurationCounter;
  private lastHeight = 0;

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;

    this.statusBadge = new StatusBadge(bus, `${controlId}:badge`, `${elementId}-badge`);
    this.durationCounter = new DurationCounter(bus, `${controlId}:duration`, `${elementId}-duration`);

    this.subscribeToChild(`${controlId}:badge`, () => this.onChildUpdate());
    this.subscribeToChild(`${controlId}:duration`, () => this.onChildUpdate());
  }

  update(data?: NodeCardData): void {
    if (!data) { return; }

    // Forward to children
    this.statusBadge.update({ status: data.status, nodeId: data.nodeId } as StatusBadgeData);
    this.durationCounter.update({
      startedAt: data.startedAt,
      running: data.status === 'running',
    } as DurationData);

    const el = this.getElement(this.elementId);
    if (!el) { return; }

    // Update border color
    el.style.borderColor = BORDER_COLORS[data.status] || BORDER_COLORS.pending;

    // Update icon
    const iconEl = this.getElement(`${this.elementId}-icon`);
    if (iconEl) {
      iconEl.textContent = STATUS_ICONS[data.status] || STATUS_ICONS.pending;
    }

    this.checkSizeChange(el);
  }

  private onChildUpdate(): void {
    const el = this.getElement(this.elementId);
    if (el) { this.checkSizeChange(el); }
    this.publishUpdate();
  }

  private checkSizeChange(el: any): void {
    const h = el.offsetHeight || 0;
    if (h !== this.lastHeight) {
      this.lastHeight = h;
      this.bus.emit(Topics.LAYOUT_CHANGE, { controlId: this.controlId });
    }
  }

  dispose(): void {
    this.statusBadge.dispose();
    this.durationCounter.dispose();
    super.dispose();
  }
}
