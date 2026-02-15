/**
 * @fileoverview Mermaid node style control — applies status-driven styles to SVG nodes.
 *
 * Subscribes to {@link Topics.NODE_STATE_CHANGE} and updates SVG
 * fill, stroke, and opacity for the corresponding Mermaid graph node.
 *
 * @module ui/webview/controls/mermaidNodeStyle
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Status → SVG fill color. */
const FILL_COLORS: Record<string, string> = {
  pending: '#2d2d2d',
  ready: '#2d2d2d',
  scheduled: '#2d3a3d',
  running: '#1a3a2a',
  succeeded: '#1a3a2a',
  failed: '#3a1a1a',
};

/** Status → SVG stroke color. */
const STROKE_COLORS: Record<string, string> = {
  pending: '#555',
  ready: '#888',
  scheduled: '#4ec9b0',
  running: '#4ec9b0',
  succeeded: '#4ec9b0',
  failed: '#f44747',
};

/** Status → SVG opacity. */
const OPACITY: Record<string, string> = {
  pending: '0.6',
  ready: '0.8',
  scheduled: '1',
  running: '1',
  succeeded: '1',
  failed: '1',
};

/** Data delivered with each update. */
export interface MermaidNodeStyleData {
  status: string;
  sanitizedId: string;
}

/**
 * Applies status-driven SVG styles to a Mermaid diagram node.
 */
export class MermaidNodeStyle extends SubscribableControl {
  private sanitizedId: string;

  constructor(bus: EventBus, controlId: string, sanitizedId: string) {
    super(bus, controlId);
    this.sanitizedId = sanitizedId;
    this.subscribe(Topics.NODE_STATE_CHANGE, (data?: MermaidNodeStyleData) => {
      if (data && data.sanitizedId === this.sanitizedId) {
        this.update(data);
      }
    });
  }

  update(data?: MermaidNodeStyleData): void {
    if (!data) { return; }
    const nodeEl = this.findSvgNode();
    if (!nodeEl) { return; }

    const rect = nodeEl.querySelector ? nodeEl.querySelector('rect, polygon, circle, path') : null;
    if (rect) {
      rect.setAttribute('fill', FILL_COLORS[data.status] || FILL_COLORS.pending);
      rect.setAttribute('stroke', STROKE_COLORS[data.status] || STROKE_COLORS.pending);
    }
    nodeEl.setAttribute('opacity', OPACITY[data.status] || '1');
    this.publishUpdate(data);
  }

  private findSvgNode(): any {
    if (typeof globalThis !== 'undefined' && (globalThis as any).document) {
      return (globalThis as any).document.querySelector(`g[id*="${this.sanitizedId}"]`);
    }
    return null;
  }
}
