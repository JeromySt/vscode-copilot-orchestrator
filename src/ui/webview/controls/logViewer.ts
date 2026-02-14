/**
 * @fileoverview Log viewer control — incremental log append with auto-scroll.
 *
 * Subscribes to {@link Topics.LOG_UPDATE} and appends new log content
 * to the viewer element while respecting manual scroll position.
 *
 * @module ui/webview/controls/logViewer
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { escapeHtml } from '../../templates/helpers';

/** Data delivered with each update. */
export interface LogViewerData {
  /** Full or incremental log content. */
  content: string;
  /** The log phase. */
  phase?: string;
  /** If true, append rather than replace. */
  append?: boolean;
}



/**
 * Log viewer control with incremental append and auto-scroll.
 */
export class LogViewer extends SubscribableControl {
  private elementId: string;
  private lastContent = '';

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.subscribe(Topics.LOG_UPDATE, (data?: LogViewerData) => this.update(data));
  }

  update(data?: LogViewerData): void {
    if (!data || !data.content) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    // Skip if content hasn't changed
    if (data.content === this.lastContent && !data.append) { return; }
    this.lastContent = data.append ? this.lastContent + data.content : data.content;

    // Check if user was at bottom before updating
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;

    if (data.append) {
      const pre = el.querySelector ? el.querySelector('pre') : null;
      if (pre) {
        pre.textContent = (pre.textContent || '') + data.content;
      } else {
        el.innerHTML = `<pre class="log-content">${escapeHtml(this.lastContent)}</pre>`;
      }
    } else {
      el.innerHTML = `<pre class="log-content">${escapeHtml(data.content)}</pre>`;
    }

    // Auto-scroll if user was at bottom
    if (wasAtBottom) {
      el.scrollTop = el.scrollHeight;
    }

    this.publishUpdate(data);
  }

  /** Clear the log viewer content. */
  clear(): void {
    this.lastContent = '';
    const el = this.getElement(this.elementId);
    if (el) {
      el.innerHTML = '<div class="log-placeholder">Select a phase tab to view logs</div>';
    }
  }
}
