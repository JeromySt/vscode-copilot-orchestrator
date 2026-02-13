/**
 * @fileoverview Config display control — shows job specification.
 *
 * Subscribes to {@link Topics.NODE_STATE_CHANGE} and updates the
 * configuration section with task, work spec, and instructions.
 *
 * @module ui/webview/controls/configDisplay
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Data delivered with each update. */
export interface ConfigDisplayData {
  task: string;
  workHtml?: string;
  instructions?: string;
  status?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Config display control for job specifications.
 */
export class ConfigDisplay extends SubscribableControl {
  private elementId: string;

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.subscribe(Topics.NODE_STATE_CHANGE, (data?: ConfigDisplayData) => this.update(data));
  }

  update(data?: ConfigDisplayData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    let html = `<div class="config-item"><div class="config-label">Task</div><div class="config-value">${escapeHtml(data.task)}</div></div>`;

    if (data.workHtml) {
      html += `<div class="config-item work-item"><div class="config-label">Work</div><div class="config-value work-content">${data.workHtml}</div></div>`;
    }
    if (data.instructions) {
      html += `<div class="config-item"><div class="config-label">Instructions</div><div class="config-value">${escapeHtml(data.instructions)}</div></div>`;
    }

    el.innerHTML = html;
    this.publishUpdate(data);
  }
}
