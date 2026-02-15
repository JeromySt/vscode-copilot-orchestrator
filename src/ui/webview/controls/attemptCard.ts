/**
 * @fileoverview Attempt card control — expand/collapse for execution attempts.
 *
 * Subscribes to {@link Topics.ATTEMPT_UPDATE} and updates the attempt card
 * content with status, duration, metrics, and expand/collapse state.
 *
 * @module ui/webview/controls/attemptCard
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Data delivered with each update. */
export interface AttemptCardData {
  attemptNumber: number;
  status: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  failedPhase?: string;
  expanded?: boolean;
}

/**
 * Attempt card control with expand/collapse functionality.
 */
export class AttemptCard extends SubscribableControl {
  private elementId: string;
  private expanded = false;
  private attemptNumber: number;

  constructor(bus: EventBus, controlId: string, elementId: string, attemptNumber: number) {
    super(bus, controlId);
    this.elementId = elementId;
    this.attemptNumber = attemptNumber;
    this.subscribe(Topics.ATTEMPT_UPDATE, (data?: AttemptCardData) => {
      if (data && data.attemptNumber === this.attemptNumber) {
        this.update(data);
      }
    });
  }

  update(data?: AttemptCardData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    // Update status badge
    const badge = el.querySelector ? el.querySelector('.attempt-badge') : null;
    if (badge) {
      badge.textContent = `#${data.attemptNumber}`;
    }

    // Update status
    const statusEl = el.querySelector ? el.querySelector('.attempt-status') : null;
    if (statusEl) {
      statusEl.textContent = data.status;
      statusEl.className = `attempt-status status-${data.status}`;
    }

    // Handle error display
    if (data.error) {
      const errorEl = el.querySelector ? el.querySelector('.attempt-error') : null;
      if (errorEl) {
        errorEl.style.display = 'block';
        const msgEl = errorEl.querySelector ? errorEl.querySelector('.error-message') : null;
        if (msgEl) { msgEl.textContent = data.error; }
      }
    }

    // Handle expand state from data
    if (data.expanded !== undefined) {
      data.expanded ? this.expand() : this.collapse();
    }

    this.publishUpdate(data);
  }

  /** Expand the attempt card body. */
  expand(): void {
    this.expanded = true;
    const el = this.getElement(this.elementId);
    if (!el) { return; }
    const body = el.querySelector ? el.querySelector('.attempt-body') : null;
    const chevron = el.querySelector ? el.querySelector('.chevron') : null;
    const header = el.querySelector ? el.querySelector('.attempt-header') : null;
    if (body) { body.style.display = 'block'; }
    if (chevron) { chevron.textContent = '▼'; }
    if (header) { header.setAttribute('data-expanded', 'true'); }
  }

  /** Collapse the attempt card body. */
  collapse(): void {
    this.expanded = false;
    const el = this.getElement(this.elementId);
    if (!el) { return; }
    const body = el.querySelector ? el.querySelector('.attempt-body') : null;
    const chevron = el.querySelector ? el.querySelector('.chevron') : null;
    const header = el.querySelector ? el.querySelector('.attempt-header') : null;
    if (body) { body.style.display = 'none'; }
    if (chevron) { chevron.textContent = '▶'; }
    if (header) { header.setAttribute('data-expanded', 'false'); }
  }

  /** Toggle expand/collapse. */
  toggle(): void {
    this.expanded ? this.collapse() : this.expand();
  }

  isExpanded(): boolean {
    return this.expanded;
  }
}
