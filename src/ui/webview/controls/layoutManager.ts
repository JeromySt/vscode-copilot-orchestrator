/**
 * @fileoverview Layout manager control — preserves zoom and scroll across re-renders.
 *
 * Subscribes to {@link Topics.LAYOUT_CHANGE}, debounces via
 * `requestAnimationFrame`, saves/restores SVG transform + scroll position
 * + selected node, and emits {@link Topics.LAYOUT_COMPLETE} after re-render.
 *
 * @module ui/webview/controls/layoutManager
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Saved layout state. */
export interface LayoutState {
  transform: string | null;
  scrollTop: number;
  scrollLeft: number;
  selectedNodeId: string | null;
}

/** Callback invoked during re-render. */
export type RenderCallback = () => void | Promise<void>;

/**
 * Layout manager that preserves zoom/scroll state across Mermaid re-renders.
 */
export class LayoutManager extends SubscribableControl {
  private containerId: string;
  private svgSelector: string;
  private pendingRaf = false;
  private renderCallback: RenderCallback | null = null;
  private lastState: LayoutState | null = null;
  private rafFn: (cb: () => void) => number;
  private selectedNodeId: string | null = null;

  constructor(
    bus: EventBus,
    controlId: string,
    containerId: string,
    svgSelector = 'svg',
    rafFn?: (cb: () => void) => number,
  ) {
    super(bus, controlId);
    this.containerId = containerId;
    this.svgSelector = svgSelector;
    this.rafFn = rafFn || ((cb) => {
      const g = globalThis as any;
      if (typeof g.requestAnimationFrame === 'function') {
        return g.requestAnimationFrame(cb) as number;
      }
      return setTimeout(cb, 16) as unknown as number;
    });
    this.subscribe(Topics.LAYOUT_CHANGE, () => this.scheduleReRender());
  }

  /** Set the render callback to invoke on layout changes. */
  setRenderCallback(cb: RenderCallback): void {
    this.renderCallback = cb;
  }

  /** Set the currently selected node ID. */
  setSelectedNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
  }

  /** Save current layout state. */
  saveState(): LayoutState {
    const container = this.getElement(this.containerId);
    let transform: string | null = null;

    if (container) {
      const svgEl = container.querySelector ? container.querySelector(this.svgSelector) : null;
      if (svgEl) {
        transform = svgEl.getAttribute('transform');
      }
    }

    const state: LayoutState = {
      transform,
      scrollTop: container ? container.scrollTop || 0 : 0,
      scrollLeft: container ? container.scrollLeft || 0 : 0,
      selectedNodeId: this.selectedNodeId,
    };
    this.lastState = state;
    return state;
  }

  /** Restore previously saved layout state. */
  restoreState(state?: LayoutState): void {
    const s = state || this.lastState;
    if (!s) { return; }

    const container = this.getElement(this.containerId);
    if (!container) { return; }

    if (s.transform) {
      const svgEl = container.querySelector ? container.querySelector(this.svgSelector) : null;
      if (svgEl) {
        svgEl.setAttribute('transform', s.transform);
      }
    }

    container.scrollTop = s.scrollTop;
    container.scrollLeft = s.scrollLeft;
    this.selectedNodeId = s.selectedNodeId;
  }

  /** Get last saved state. */
  getLastState(): LayoutState | null {
    return this.lastState;
  }

  update(): void {
    this.scheduleReRender();
  }

  private scheduleReRender(): void {
    if (this.pendingRaf) { return; }
    this.pendingRaf = true;
    this.rafFn(() => {
      this.pendingRaf = false;
      if (this.isDisposed) { return; }
      this.performReRender();
    });
  }

  private async performReRender(): Promise<void> {
    const saved = this.saveState();

    if (this.renderCallback) {
      await this.renderCallback();
    }

    this.restoreState(saved);
    this.bus.emit(Topics.LAYOUT_COMPLETE, saved);
    this.publishUpdate();
  }
}
