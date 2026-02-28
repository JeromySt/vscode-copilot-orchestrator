/**
 * @fileoverview Timeline Gantt chart — pixel-based, scroll-to-grow.
 *
 * Positions bars at fixed pixel offsets from plan start. Completed bars
 * never move. The container grows rightward and auto-scrolls to keep
 * the live edge visible. Only running bars are updated on each pulse.
 *
 * @module ui/webview/controls/timelineChart
 */

import { EventBus, Subscription } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

export interface PhaseDuration { phase: string; durationMs: number; status: string; }
export interface TimelineAttempt {
  attemptNumber: number; status: string; startedAt: number; endedAt?: number;
  failedPhase?: string; triggerType?: string; stepStatuses?: Record<string, string>;
  phaseDurations?: PhaseDuration[]; phaseTiming?: Array<{ phase: string; startedAt: number; endedAt?: number }>;
}
export interface TimelineNodeData {
  nodeId: string; name: string; group?: string; status: string;
  scheduledAt?: number; startedAt?: number; endedAt?: number;
  dependencies?: string[]; stepStatuses?: Record<string, string>;
  attempts?: TimelineAttempt[];
}
export interface TimelineData {
  planStartedAt?: number; planEndedAt?: number; planCreatedAt?: number;
  stateHistory?: Array<{ from?: string; to?: string; status?: string; timestamp: number; reason?: string }>;
  pauseHistory?: Array<{ pausedAt: number; resumedAt?: number; reason?: string }>;
  nodes: TimelineNodeData[];
}

const LABEL_W = 180;
const ROW_H = 36;
const BAR_H = 20;
const BAR_Y = (ROW_H - BAR_H) / 2;
const AXIS_H = 48;
const PX_PER_SEC = 3; // 3 pixels per second — adjustable

const PHASE_COLORS: Record<string, string> = {
  'merge-fi': '#2196F3', 'setup': '#4CAF50', 'prechecks': '#FF9800',
  'work': '#E91E63', 'commit': '#9C27B0', 'postchecks': '#FF5722', 'merge-ri': '#00BCD4',
  'cleanup': '#607D8B',
};
const PHASES = ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri', 'cleanup'];

export class TimelineChart extends SubscribableControl {
  private cid: string;
  private data: TimelineData | null = null;
  private t0 = 0;
  private pulseSub: Subscription | null = null;
  private barPositions: Array<{ nodeId: string; name: string; status: string; leftPx: number; rightPx: number; rowIndex: number; startedAt: number; endedAt: number }> = [];
  private _cachedPps = PX_PER_SEC;
  private _tickCount = 0;
  private _tickState: {
    wrap: any; planBar: any; nowMarker: any;
    runningBars: Array<{ bar: any; counter: any; startedAt: number }>;
    lastAxisEnd: number;
  } | null = null;
  private _paintingRunningBars: Array<{ bar: any; counter: any; startedAt: number }> = [];
  private _userScrolledAway = false;
  private _scrollListener: (() => void) | null = null;

  constructor(bus: EventBus, controlId: string, containerId: string) {
    super(bus, controlId);
    this.cid = containerId;
  }

  update(data?: TimelineData): void {
    this.data = data || null;
    this.t0 = this.computeStart();
    const running = this.isRunning();
    if (running && !this.pulseSub) {
      this.pulseSub = this.subscribe(Topics.PULSE, () => this.tick());
    } else if (!running && this.pulseSub) {
      this.pulseSub.unsubscribe(); this.pulseSub = null;
    }
    this.paint();
    this.publishUpdate();
  }

  // ── Pixel helpers ─────────────────────────────────────────────────────

  private pxPerSec(): number {
    // For completed plans, scale to fill the container width
    // For running plans, use adaptive scale that decreases as duration grows
    const el = this.getElement(this.cid);
    const containerW = el ? Math.max(el.clientWidth || 600, 600) - LABEL_W : 600;
    
    if (!this.isRunning() && this.data?.planEndedAt) {
      // Completed: fill the container
      const durationSec = Math.max(1, (this.data.planEndedAt - this.t0) / 1000);
      return Math.max(0.5, containerW / durationSec);
    }
    // Running: adaptive scale — starts filling container, then gradually
    // zooms out so the timeline doesn't grow too wide for long-running plans.
    // At short durations (<2min): fills container width
    // At longer durations: fixed px/sec that decreases with duration
    const elapsed = (Date.now() - this.t0) / 1000;
    if (elapsed <= 0) { return PX_PER_SEC; }
    
    // Always ensure at least container width is used
    const fillScale = containerW / elapsed;
    
    // Adaptive target: 3px/s for first 2min, scaling down to ~0.5px/s for 30min+
    // Formula: PX_PER_SEC / (1 + elapsed/120) — halves every 2 minutes
    const adaptiveScale = PX_PER_SEC / (1 + elapsed / 120);
    const minScale = 0.5; // Floor: ~0.5px/s even for very long plans
    
    return Math.max(minScale, Math.max(adaptiveScale, fillScale));
  }

  private px(epoch: number): number {
    return Math.max(0, ((epoch - this.t0) / 1000) * this.pxPerSec());
  }

  /** Use cached pixels-per-second for incremental tick updates (stable between repaints). */
  private pxCached(epoch: number): number {
    return Math.max(0, ((epoch - this.t0) / 1000) * this._cachedPps);
  }

  private totalWidth(): number {
    const end = this.isRunning() ? Date.now() : (this.data?.planEndedAt || Date.now());
    const el = this.getElement(this.cid);
    const containerW = el ? Math.max(el.clientWidth || 600, 600) - LABEL_W : 600;
    return Math.max(containerW, this.pxCached(end) + 50);
  }

  // ── Render ────────────────────────────────────────────────────────────

  private paint(): void {
    const el = this.getElement(this.cid);
    if (!el) return;
    this.cleanupTooltips();
    this._paintingRunningBars = [];
    this._tickState = null;

    // Save scroll position before clearing DOM
    const container = el.closest?.('.timeline-container') as any;
    const savedScrollLeft = container ? container.scrollLeft : 0;
    const savedScrollTop = container ? container.scrollTop : 0;

    el.innerHTML = '';
    if (!this.data || !this.data.nodes.length) {
      el.innerHTML = '<div style="padding:24px;color:var(--vscode-descriptionForeground);text-align:center;">No timeline data.</div>';
      return;
    }
    const d = this.doc(); if (!d) return;
    this._cachedPps = this.pxPerSec();
    const tw = this.totalWidth();
    this.barPositions = []; // Reset for this render

    const wrap = d.createElement('div');
    wrap.style.cssText = `position:relative;width:${tw + LABEL_W}px;min-width:100%;`;

    // Sticky axis + plan row
    const axisWrap = d.createElement('div');
    axisWrap.style.cssText = 'position:sticky;top:0;z-index:50;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);';
    axisWrap.appendChild(this.paintAxis(d, tw));
    // Plan row — markers added AFTER job rows render (two-pass)
    let ri = 0;
    const planRowResult = this.paintPlanRow(d, ri++, tw);
    axisWrap.appendChild(planRowResult.row);
    wrap.appendChild(axisWrap);

    // Job rows (grouped, SV at bottom) — this populates barPositions
    const groups = this.groupNodes();
    for (const [gname, nodes] of groups) {
      if (gname) wrap.appendChild(this.paintGroupHeader(d, gname));
      for (const n of nodes) {
        wrap.appendChild(this.paintRow(d, n, ri++, tw));
      }
    }

    // SECOND PASS: add consolidated markers to plan row + dependency lines
    this.paintPlanMarkers(d, planRowResult.area);
    this.paintDependencyLines(d, wrap);

    // Now marker
    let nowMarkerEl: any = null;
    if (this.isRunning()) {
      const nowPx = this.px(Date.now());
      const mk = d.createElement('div');
      mk.style.cssText = `position:absolute;left:${LABEL_W + nowPx}px;top:0;bottom:0;width:2px;background:var(--vscode-editorCursor-foreground,#e00);z-index:15;pointer-events:none;opacity:0.7;`;
      wrap.appendChild(mk);
      nowMarkerEl = mk;
    }

    // Legend
    wrap.appendChild(this.paintLegend(d));

    // Backward compat
    if (this.shouldShowBackwardCompatMessage()) wrap.appendChild(this.paintBackwardCompatMessage(d));

    el.appendChild(wrap);

    // Assemble tick state for incremental updates
    const axisEnd = this.isRunning() ? Date.now() : (this.data?.planEndedAt || Date.now());
    this._tickState = {
      wrap,
      planBar: planRowResult.bar,
      nowMarker: nowMarkerEl,
      runningBars: this._paintingRunningBars,
      lastAxisEnd: axisEnd,
    };

    // Auto-scroll to right edge (live edge visible) — only if user hasn't scrolled away
    if (this.isRunning()) {
      const container = el.closest?.('.timeline-container') as any;
      if (container) {
        if (!this._userScrolledAway) {
          container.scrollLeft = Math.max(0, tw + LABEL_W - container.clientWidth + 20);
        } else {
          // Restore previous scroll position after full repaint
          container.scrollLeft = savedScrollLeft;
          container.scrollTop = savedScrollTop;
        }
        this._attachScrollListener(container, tw);
      }
    } else if (container) {
      // For completed plans, restore scroll position
      container.scrollLeft = savedScrollLeft;
      container.scrollTop = savedScrollTop;
    }
  }

  // ── Axis ──────────────────────────────────────────────────────────────

  private paintAxis(d: any, tw: number): any {
    const axRow = d.createElement('div');
    axRow.style.cssText = `display:flex;height:${AXIS_H}px;`;
    // Sticky label placeholder (matches row label width)
    const axLbl = d.createElement('div');
    axLbl.style.cssText = `width:${LABEL_W}px;min-width:${LABEL_W}px;box-sizing:border-box;position:sticky;left:0;z-index:51;background:var(--vscode-editor-background);border-right:1px solid var(--vscode-panel-border);`;
    axRow.appendChild(axLbl);
    const ax = d.createElement('div');
    ax.style.cssText = `position:relative;height:${AXIS_H}px;width:${tw}px;`;

    const iv = this.tickInterval();
    const first = Math.ceil(this.t0 / iv) * iv;
    const end = this.isRunning() ? Date.now() : (this.data?.planEndedAt || Date.now());

    // Always show the exact start time at position 0
    const startLabel = d.createElement('div');
    startLabel.style.cssText = `position:absolute;left:0;top:4px;font-size:11px;color:var(--vscode-testing-iconPassed,#4caf50);white-space:nowrap;font-weight:600;`;
    startLabel.textContent = this.clockTimePrecise(this.t0);
    ax.appendChild(startLabel);
    const startElapsed = d.createElement('div');
    startElapsed.style.cssText = `position:absolute;left:0;top:24px;font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;`;
    startElapsed.textContent = '0s';
    ax.appendChild(startElapsed);
    // Start gridline
    const startGl = d.createElement('div');
    startGl.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--vscode-testing-iconPassed,#4caf50);opacity:0.4;';
    ax.appendChild(startGl);

    for (let t = first; t <= end; t += iv) {
      const x = this.px(t);
      if (x < 40) continue; // skip ticks too close to the start label
      // Gridline
      const gl = d.createElement('div');
      gl.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:var(--vscode-panel-border);opacity:0.2;`;
      ax.appendChild(gl);
      // Clock time
      const ct = d.createElement('div');
      ct.style.cssText = `position:absolute;left:${x}px;top:4px;transform:translateX(-50%);font-size:11px;color:var(--vscode-foreground);white-space:nowrap;font-weight:500;`;
      ct.textContent = this.clockTime(t);
      ax.appendChild(ct);
      // Elapsed
      const et = d.createElement('div');
      et.style.cssText = `position:absolute;left:${x}px;top:24px;transform:translateX(-50%);font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;`;
      et.textContent = this.elapsed(t - this.t0);
      ax.appendChild(et);
    }

    // Event markers from stateHistory (keep in axis - these are plan-level)
    if (this.data?.stateHistory) {
      for (const evt of this.data.stateHistory) {
        const evtStatus = evt.to || evt.status || '';
        const x = this.px(evt.timestamp);
        const color = this.getEventColor(evtStatus);
        const mk = d.createElement('div');
        mk.style.cssText = `position:absolute;left:${x}px;bottom:0;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid ${color};transform:translateX(-4px);cursor:pointer;z-index:10;`;
        mk.title = `${evtStatus} at ${this.clockTimePrecise(evt.timestamp)}${evt.reason ? '\n' + evt.reason : ''}`;
        ax.appendChild(mk);
      }
    }

    axRow.appendChild(ax);
    return axRow;
  }

  // ── Plan state row ────────────────────────────────────────────────────

  private paintPlanRow(d: any, ri: number, tw: number): { row: any; area: any; bar: any } {
    const row = d.createElement('div');
    row.style.cssText = `display:flex;height:${ROW_H}px;border-bottom:1px solid var(--vscode-panel-border);background:rgba(128,128,128,0.06);`;
    const lbl = d.createElement('div');
    lbl.style.cssText = `width:${LABEL_W}px;min-width:${LABEL_W}px;box-sizing:border-box;padding:0 8px;display:flex;align-items:center;gap:4px;font-size:12px;font-weight:600;border-right:1px solid var(--vscode-panel-border);position:sticky;left:0;z-index:10;background:var(--vscode-editor-background);`;
    lbl.textContent = '\u{1F4CA} Plan';
    row.appendChild(lbl);
    const area = d.createElement('div');
    area.style.cssText = `position:relative;width:${tw}px;height:100%;overflow:hidden;`;
    // Plan bar — always starts at position 0
    const pe = this.data!.planEndedAt || Date.now();
    const w = Math.max(2, this.px(pe));
    const status = this.getPlanStatus();
    const bar = d.createElement('div');
    bar.style.cssText = `position:absolute;left:0;width:${w}px;top:${BAR_Y}px;height:${BAR_H}px;border-radius:3px;background:${this.getStatusColor(status)};z-index:3;box-shadow:0 1px 3px rgba(0,0,0,0.3);`;
    if (!this.data!.planEndedAt) {
      bar.style.animation = 'timeline-pulse 2s ease-in-out infinite';
    }
    bar.title = `Plan: ${status}`;
    area.appendChild(bar);
    // Pause overlays
    for (const p of this.data!.pauseHistory || []) {
      const px1 = this.px(p.pausedAt);
      const px2 = this.px(p.resumedAt || Date.now());
      const ov = d.createElement('div');
      ov.style.cssText = `position:absolute;left:${px1}px;width:${Math.max(2, px2 - px1)}px;top:${BAR_Y}px;height:${BAR_H}px;background:rgba(128,128,128,0.5);z-index:4;pointer-events:none;`;
      ov.title = p.reason ? `Paused: ${p.reason}` : 'Paused';
      area.appendChild(ov);
    }
    // Note: job markers are added in second pass after job rows render
    row.appendChild(area);
    return { row, area, bar };
  }

  // ── Job rows ──────────────────────────────────────────────────────────

  private paintRow(d: any, node: TimelineNodeData, ri: number, tw: number): any {
    const row = d.createElement('div');
    const bg = ri % 2 === 0 ? 'transparent' : 'rgba(128,128,128,0.04)';
    row.style.cssText = `display:flex;height:${ROW_H}px;border-bottom:1px solid var(--vscode-panel-border);background:${bg};`;
    // Label
    const lbl = d.createElement('div');
    const si = this.statusIcon(node.status);
    const lblBg = ri % 2 === 0 ? 'var(--vscode-editor-background)' : 'var(--vscode-editor-background)';
    lbl.style.cssText = `width:${LABEL_W}px;min-width:${LABEL_W}px;box-sizing:border-box;padding:0 8px;display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--vscode-panel-border);position:sticky;left:0;z-index:10;background:${lblBg};`;
    const ic = d.createElement('span'); ic.style.cssText = 'font-size:10px;flex-shrink:0;'; ic.textContent = si;
    const nm = d.createElement('span'); nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;'; nm.textContent = node.name;
    lbl.appendChild(ic); lbl.appendChild(nm); lbl.title = `${node.name} (${node.status})`;
    row.appendChild(lbl);

    const area = d.createElement('div');
    area.style.cssText = `position:relative;width:${tw}px;height:100%;`;

    // Gridlines
    const iv = this.tickInterval();
    const first = Math.ceil(this.t0 / iv) * iv;
    const end = this.isRunning() ? Date.now() : (this.data?.planEndedAt || Date.now());
    for (let t = first; t <= end; t += iv) {
      const gl = d.createElement('div');
      gl.style.cssText = `position:absolute;left:${this.px(t)}px;top:0;bottom:0;width:1px;background:var(--vscode-panel-border);opacity:0.08;pointer-events:none;`;
      area.appendChild(gl);
    }

    // Wait line
    if (node.scheduledAt && node.startedAt && node.startedAt > node.scheduledAt) {
      const x1 = this.px(node.scheduledAt), x2 = this.px(node.startedAt);
      const wl = d.createElement('div');
      wl.style.cssText = `position:absolute;left:${x1}px;width:${x2 - x1}px;top:50%;height:0;border-top:2px dashed var(--vscode-descriptionForeground);opacity:0.3;`;
      area.appendChild(wl);
    }

    // Bars (no per-row markers — they're on the plan row)
    const attempts = node.attempts && node.attempts.length > 0 ? node.attempts :
      (node.startedAt ? [{ attemptNumber: 1, status: node.status, startedAt: node.startedAt, endedAt: node.endedAt, stepStatuses: (node as any).stepStatuses || {}, phaseDurations: [], phaseTiming: [] }] : []);
    if (attempts.length > 0) {
      for (const att of attempts) {
        area.appendChild(this.paintBar(d, node, att, ri));
      }
    } else {
      area.appendChild(this.paintPending(d, node));
    }

    row.appendChild(area);
    return row;
  }

  // ── Bars ──────────────────────────────────────────────────────────────

  private paintBar(d: any, node: TimelineNodeData, att: TimelineAttempt, rowIndex: number): any {
    // Use attempt endedAt as the authoritative bar end.
    // phaseTiming is used only for internal segment proportions, not total width,
    // because phaseTiming can be stale (duplicated from a prior attempt) or incomplete
    // (auto-heal executions may not record their own phase timings).
    const end = att.endedAt || Date.now();
    const x = this.px(att.startedAt);
    const w = Math.max(2, this.px(end) - x);
    const bar = d.createElement('div');
    bar.style.cssText = `position:absolute;left:${x}px;width:${w}px;top:${BAR_Y}px;height:${BAR_H}px;border-radius:3px;cursor:pointer;overflow:hidden;z-index:3;box-shadow:0 1px 3px rgba(0,0,0,0.3);`;

    // Store position for plan row markers and dependency lines
    this.barPositions.push({ nodeId: node.nodeId, name: node.name, status: att.status, leftPx: x, rightPx: x + w, rowIndex, startedAt: att.startedAt, endedAt: end });

    // Tooltip
    const ms = end - att.startedAt;
    let tipHtml = `<div style="font-weight:600;margin-bottom:4px;">Attempt ${att.attemptNumber}: ${att.status} (${this.elapsed(ms)})</div>`;
    tipHtml += `<div style="font-size:11px;opacity:0.9;">${this.clockTimePrecise(att.startedAt)}${att.endedAt ? ' \u2192 ' + this.clockTimePrecise(att.endedAt) : ' (running)'}</div>`;
    if (att.failedPhase) tipHtml += `<div style="color:#f48771;margin-top:2px;">Failed: ${att.failedPhase}</div>`;
    tipHtml += '<div style="margin-top:6px;font-size:11px;">';
    for (const phase of PHASES) {
      const color = PHASE_COLORS[phase] || '#888';
      let txt = '--';
      if (att.phaseTiming && att.phaseTiming.length > 0) {
        const pt = att.phaseTiming.find((p: any) => p.phase === phase);
        txt = pt ? this.elapsed((pt.endedAt || Date.now()) - pt.startedAt) : 'skipped';
      } else if (att.phaseDurations && att.phaseDurations.length > 0) {
        const pd = att.phaseDurations.find((p: any) => p.phase === phase);
        txt = pd ? `${this.elapsed(pd.durationMs)} (${pd.status})` : 'skipped';
      } else if (att.stepStatuses && Object.keys(att.stepStatuses).length > 0) {
        txt = att.stepStatuses[phase] || 'skipped';
      }
      const op = txt === 'skipped' || txt === '--' ? '0.4' : '1';
      tipHtml += `<div style="display:flex;align-items:center;gap:6px;padding:1px 0;opacity:${op};"><span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;display:inline-block;"></span>${phase}: ${txt}</div>`;
    }
    tipHtml += '</div>';
    this.attachTooltip(d, bar, tipHtml);

    // Phase segments
    if (att.phaseTiming && att.phaseTiming.length > 0) {
      for (const pt of att.phaseTiming) {
        const pe = pt.endedAt || Date.now();
        const segStartPx = this.px(pt.startedAt) - x; // Relative to bar start
        const segEndPx = this.px(pe) - x;
        const segWidthPx = Math.max(1, segEndPx - segStartPx);
        const seg = d.createElement('div');
        seg.style.cssText = `position:absolute;left:${segStartPx}px;width:${segWidthPx}px;height:100%;background:${PHASE_COLORS[pt.phase] || '#888'};pointer-events:none;`;
        bar.appendChild(seg);
      }
    } else if (att.phaseDurations && att.phaseDurations.length > 0) {
      const active = att.phaseDurations.filter((pd: any) => pd.status !== 'skipped');
      let cumulativeOffsetPx = 0;
      for (const pd of active) {
        const segWidthPx = Math.max(1, this.px(att.startedAt + pd.durationMs) - this.px(att.startedAt));
        const seg = d.createElement('div');
        seg.style.cssText = `position:absolute;left:${cumulativeOffsetPx}px;width:${segWidthPx}px;height:100%;background:${PHASE_COLORS[pd.phase] || '#888'};pointer-events:none;`;
        bar.appendChild(seg);
        cumulativeOffsetPx += segWidthPx;
      }
    } else if (att.stepStatuses && Object.keys(att.stepStatuses).length > 0) {
      const exec = PHASES.filter(p => att.stepStatuses![p] && att.stepStatuses![p] !== 'skipped');
      const segWidthPx = exec.length > 0 ? w / exec.length : 0;
      let cumulativeOffsetPx = 0;
      for (const ph of exec) {
        const seg = d.createElement('div');
        const st = att.stepStatuses![ph];
        seg.style.cssText = `position:absolute;left:${cumulativeOffsetPx}px;width:${segWidthPx}px;height:100%;background:${PHASE_COLORS[ph] || '#888'};opacity:${st === 'succeeded' || st === 'success' ? '1' : '0.6'};pointer-events:none;`;
        bar.appendChild(seg);
        cumulativeOffsetPx += segWidthPx;
      }
    } else {
      bar.style.background = att.status === 'succeeded' ? 'var(--vscode-testing-iconPassed)' : att.status === 'failed' ? 'var(--vscode-testing-iconFailed)' : 'var(--vscode-progressBar-background)';
    }

    if (!att.endedAt) {
      bar.style.animation = 'timeline-pulse 2s ease-in-out infinite';
      const ctr = d.createElement('span');
      ctr.style.cssText = 'position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:white;text-shadow:0 1px 2px rgba(0,0,0,0.5);pointer-events:none;z-index:4;';
      ctr.textContent = this.elapsed(Date.now() - att.startedAt);
      bar.appendChild(ctr);
      this._paintingRunningBars.push({ bar, counter: ctr, startedAt: att.startedAt });
    }

    // Trigger type badge (auto-heal, retry, etc.)
    if (att.triggerType && att.triggerType !== 'initial') {
      const badge = d.createElement('span');
      const icon = att.triggerType === 'auto-heal' ? '\u{1F529}' : att.triggerType === 'retry' ? '\u{1F504}' : '\u{1F50D}';
      badge.style.cssText = 'position:absolute;right:2px;top:-2px;font-size:10px;z-index:6;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,0.7);';
      badge.textContent = icon;
      badge.title = att.triggerType;
      bar.appendChild(badge);
    }

    bar.addEventListener('click', () => this.bus.emit('timeline:nodeClick', { nodeId: node.nodeId, attemptNumber: att.attemptNumber }));
    return bar;
  }

  private paintPending(d: any, node: TimelineNodeData): any {
    const el = d.createElement('div');
    const isReady = node.status === 'ready' || node.status === 'scheduled';
    const isBlocked = node.status === 'blocked';
    if (isReady) {
      const x = this.px(Date.now());
      el.style.cssText = `position:absolute;left:${x}px;top:${BAR_Y + 4}px;width:12px;height:12px;border-radius:50%;background:var(--vscode-progressBar-background);animation:timeline-pulse 1.5s ease-in-out infinite;transform:translateX(-6px);`;
      el.title = `${node.name}: waiting for capacity`;
    } else if (isBlocked) {
      el.style.cssText = `position:absolute;left:4px;top:${BAR_Y}px;height:${BAR_H}px;display:flex;align-items:center;color:var(--vscode-descriptionForeground);font-size:11px;opacity:0.5;`;
      el.textContent = '\u2298 blocked';
    } else {
      el.style.cssText = `position:absolute;left:4px;top:${BAR_Y}px;height:${BAR_H}px;display:flex;align-items:center;color:var(--vscode-descriptionForeground);font-size:11px;opacity:0.4;`;
      el.textContent = '\u25CB waiting';
    }
    return el;
  }

  // ── Group header ──────────────────────────────────────────────────────

  private paintGroupHeader(d: any, name: string): any {
    const h = d.createElement('div');
    h.style.cssText = 'display:flex;align-items:center;height:26px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-activityBar-foreground);padding:0 8px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.5px;position:sticky;left:0;z-index:10;';
    h.textContent = name;
    return h;
  }

  // ── Legend ─────────────────────────────────────────────────────────────

  private paintLegend(d: any): any {
    const w = d.createElement('div');
    w.style.cssText = `display:flex;flex-wrap:wrap;gap:12px;padding:12px 8px 4px;margin-left:${LABEL_W}px;font-size:11px;color:var(--vscode-descriptionForeground);position:sticky;left:0;width:fit-content;`;
    for (const phase of PHASES) {
      const item = d.createElement('div'); item.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const sw = d.createElement('div'); sw.style.cssText = `width:12px;height:12px;border-radius:2px;background:${PHASE_COLORS[phase]};`;
      const lb = d.createElement('span'); lb.textContent = phase;
      item.appendChild(sw); item.appendChild(lb); w.appendChild(item);
    }
    return w;
  }

  // ── Tooltip ───────────────────────────────────────────────────────────

  private attachTooltip(d: any, target: any, html: string): void {
    let tip: any = null;
    target.addEventListener('mouseenter', (e: any) => {
      if (tip) return;
      tip = d.createElement('div');
      tip.className = 'timeline-chart-tooltip';
      tip.style.cssText = 'position:fixed;z-index:1000;background:var(--vscode-editorHoverWidget-background,#252526);color:var(--vscode-editorHoverWidget-foreground,#ccc);border:1px solid var(--vscode-editorHoverWidget-border,#454545);padding:8px 12px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.4);font-size:12px;max-width:350px;pointer-events:none;';
      tip.innerHTML = html;
      d.body.appendChild(tip);
      const rect = target.getBoundingClientRect();
      // Position at mouse X coordinate, clamped to viewport
      const mouseX = e.clientX || rect.left;
      tip.style.left = Math.min(mouseX, ((globalThis as any).innerWidth || 800) - 360) + 'px';
      tip.style.top = (rect.top - tip.offsetHeight - 6) + 'px';
      if (parseInt(tip.style.top) < 0) tip.style.top = (rect.bottom + 6) + 'px';
    });
    target.addEventListener('mouseleave', () => { if (tip) { tip.remove(); tip = null; } });
  }

  // ── Tooltip cleanup ────────────────────────────────────────────────────

  private cleanupTooltips(): void {
    const d = this.doc();
    if (!d || !d.querySelectorAll) return;
    try {
      const tips = d.querySelectorAll('.timeline-chart-tooltip');
      if (tips) for (let i = 0; i < tips.length; i++) tips[i].remove();
    } catch { /* mock environments may not support querySelectorAll */ }
  }

  // ── Incremental tick (lightweight update — no DOM rebuild) ─────────────

  private tick(): void {
    if (!this._tickState || !this.data) { this.paint(); return; }

    // Every 10 ticks (~10s), do a full repaint to refresh axis labels/gridlines
    this._tickCount++;
    if (this._tickCount >= 10) {
      this._tickCount = 0;
      this.paint();
      return;
    }

    // Smoothly update cached scale — during auto-zoom phase the scale
    // decreases as elapsed time grows. Recalculate each tick for smooth animation.
    this._cachedPps = this.pxPerSec();
    const now = Date.now();
    const ts = this._tickState;
    const tw = this.totalWidth();

    // Grow wrapper width (extends scroll range)
    ts.wrap.style.width = (tw + LABEL_W) + 'px';

    // Update running bar positions + widths + elapsed counters
    for (const rb of ts.runningBars) {
      const x = this.pxCached(rb.startedAt);
      const w = Math.max(2, this.pxCached(now) - x);
      rb.bar.style.left = x + 'px';
      rb.bar.style.width = w + 'px';
      if (rb.counter) rb.counter.textContent = this.elapsed(now - rb.startedAt);
    }

    // Update plan bar width
    if (ts.planBar) {
      ts.planBar.style.width = Math.max(2, this.pxCached(now)) + 'px';
    }

    // Move now marker
    if (ts.nowMarker) {
      ts.nowMarker.style.left = (LABEL_W + this.pxCached(now)) + 'px';
    }

    // Auto-scroll to live edge — only if user hasn't scrolled away
    const el = this.getElement(this.cid);
    if (el && !this._userScrolledAway) {
      const container = el.closest?.('.timeline-container');
      if (container) container.scrollLeft = Math.max(0, tw + LABEL_W - container.clientWidth + 20);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private computeStart(): number {
    if (!this.data) return Date.now();
    // Plan startedAt is the canonical start — everything is relative to it
    if (this.data.planStartedAt) return this.data.planStartedAt;
    // Fallback: earliest node timestamp
    let lo = Infinity;
    for (const n of this.data.nodes) {
      if (n.scheduledAt) lo = Math.min(lo, n.scheduledAt);
      if (n.startedAt) lo = Math.min(lo, n.startedAt);
      for (const a of n.attempts || []) lo = Math.min(lo, a.startedAt);
    }
    return isFinite(lo) ? lo : Date.now();
  }

  private isRunning(): boolean {
    if (!this.data) return false;
    // Plan has never started — check if any node has activity
    if (!this.data.planStartedAt) {
      const hasNodeActivity = this.data.nodes.some(n => n.startedAt || n.status === 'running');
      if (!hasNodeActivity) return false;
    }
    if (!this.data.planEndedAt) return true;
    return this.data.nodes.some(n => n.status === 'running' || (n.attempts || []).some(a => !a.endedAt));
  }

  private tickInterval(): number {
    // Ensure at least 5 tick marks are visible within the container width.
    // Calculate based on the visible time span at the current scale.
    const el = this.getElement(this.cid);
    const containerW = el ? Math.max(el.clientWidth || 600, 600) - LABEL_W : 600;
    const pps = this._cachedPps || this.pxPerSec();
    // How many seconds fit in the visible container
    const visibleSec = containerW / Math.max(0.1, pps);
    // Target interval: visible time / 5 (at least 5 ticks on screen)
    const targetSec = visibleSec / 5;
    // Snap to nice intervals: 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m
    const niceIntervals = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    for (const iv of niceIntervals) {
      if (iv >= targetSec) { return iv * 1000; }
    }
    return 1800000; // 30 min max
  }

  private clockTime(epoch: number): string {
    const d = new Date(epoch); const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
  }
  private clockTimePrecise(epoch: number): string {
    const d = new Date(epoch); const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
  }
  private elapsed(ms: number): string {
    if (ms < 0) ms = 0; const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's'; const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  private statusIcon(s: string): string {
    const m: Record<string, string> = { succeeded: '\u2713', failed: '\u2717', running: '\u25B6', ready: '\u23F3', scheduled: '\u23F3', blocked: '\u2298', canceled: '\u2014' };
    return m[s] || '\u25CB';
  }
  private getStatusColor(s: string): string {
    const m: Record<string, string> = { succeeded: 'var(--vscode-testing-iconPassed)', failed: 'var(--vscode-testing-iconFailed)', running: 'var(--vscode-progressBar-background)', pausing: '#FFC107', paused: '#FFC107', resumed: 'var(--vscode-progressBar-background)', 'pending-start': '#9E9E9E' };
    return m[s] || 'var(--vscode-descriptionForeground)';
  }
  private getEventColor(s: string): string {
    const m: Record<string, string> = { running: 'var(--vscode-testing-iconPassed,#4caf50)', succeeded: 'var(--vscode-testing-iconPassed,#4caf50)', failed: 'var(--vscode-testing-iconFailed,#f44336)', canceled: 'var(--vscode-testing-iconFailed,#f44336)', pausing: '#FFC107', paused: '#FFC107', resumed: 'var(--vscode-testing-iconPassed,#4caf50)', 'pending-start': '#9E9E9E', reshaped: '#2196F3', 'job-updated': '#FF9800', 'plan-updated': '#9C27B0' };
    return m[s] || 'var(--vscode-descriptionForeground)';
  }
  private getPlanStatus(): string {
    if (!this.data) return 'pending';
    if (this.data.stateHistory && this.data.stateHistory.length > 0) {
      const last = this.data.stateHistory[this.data.stateHistory.length - 1];
      return last.to || last.status || 'running';
    }
    if (this.data.planEndedAt) return this.data.nodes.some(n => n.status === 'failed') ? 'failed' : 'succeeded';
    return 'running';
  }
  private doc(): any { return typeof globalThis !== 'undefined' ? (globalThis as any).document : null; }

  private groupNodes(): Array<[string, TimelineNodeData[]]> {
    const grouped = new Map<string, TimelineNodeData[]>();
    const noGroup: TimelineNodeData[] = [];
    for (const n of this.data!.nodes) {
      if (n.group) { if (!grouped.has(n.group)) grouped.set(n.group, []); grouped.get(n.group)!.push(n); }
      else noGroup.push(n);
    }
    const result: Array<[string, TimelineNodeData[]]> = [];
    const svKey = [...grouped.keys()].find(k => k.toLowerCase().includes('snapshot'));
    for (const [k, v] of grouped) { if (k !== svKey) result.push([k, v]); }
    if (noGroup.length) result.push(['', noGroup]);
    if (svKey) result.push([svKey, grouped.get(svKey)!]);
    return result;
  }

  private shouldShowBackwardCompatMessage(): boolean {
    if (!this.data) return false;
    return !!this.data.planEndedAt && (!this.data.stateHistory || this.data.stateHistory.length === 0);
  }
  private paintBackwardCompatMessage(d: any): any {
    const el = d.createElement('div');
    el.style.cssText = `padding:8px;margin-left:${LABEL_W}px;font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.6;font-style:italic;`;
    el.textContent = 'Timeline data limited (plan created before v0.14.0)';
    return el;
  }

  dispose(): void {
    if (this.pulseSub) { this.pulseSub.unsubscribe(); this.pulseSub = null; }
    this._detachScrollListener();
    this.cleanupTooltips();
    this._tickState = null;
    super.dispose();
  }

  // ── Scroll tracking ─────────────────────────────────────────────────

  /**
   * Attach a scroll listener to detect when the user scrolls away from the live edge.
   * If the user scrolls back to within 80px of the right edge, re-enable auto-scroll.
   */
  private _attachScrollListener(container: any, tw: number): void {
    this._detachScrollListener();
    if (!container || !container.addEventListener) return;
    const handler = () => {
      const maxScroll = container.scrollWidth - container.clientWidth;
      const distFromRight = maxScroll - container.scrollLeft;
      // If within 80px of the right edge, consider user "at live edge"
      this._userScrolledAway = distFromRight > 80;
    };
    container.addEventListener('scroll', handler);
    this._scrollListener = () => container.removeEventListener('scroll', handler);
  }

  private _detachScrollListener(): void {
    if (this._scrollListener) { this._scrollListener(); this._scrollListener = null; }
  }

  // ── Plan row markers (consolidated) ──────────────────────────────────

  private paintPlanMarkers(d: any, area: any): void {
    // Collect all start and end events, then group by pixel position (within 6px tolerance)
    const events: Array<{ px: number; type: 'start' | 'end'; name: string; status: string; time: number }> = [];
    for (const bp of this.barPositions) {
      events.push({ px: bp.leftPx, type: 'start', name: bp.name, status: bp.status, time: bp.startedAt });
      if (bp.rightPx > bp.leftPx + 2) {
        events.push({ px: bp.rightPx, type: 'end', name: bp.name, status: bp.status, time: bp.endedAt });
      }
    }
    // Sort by px position
    events.sort((a, b) => a.px - b.px);

    // Consolidate: group events within 6px of each other
    const groups: Array<{ px: number; items: typeof events }> = [];
    for (const ev of events) {
      const last = groups.length > 0 ? groups[groups.length - 1] : null;
      if (last && Math.abs(ev.px - last.px) < 6) {
        last.items.push(ev);
        last.px = (last.px * (last.items.length - 1) + ev.px) / last.items.length; // average position
      } else {
        groups.push({ px: ev.px, items: [ev] });
      }
    }

    // Render each consolidated group as a single marker
    for (const group of groups) {
      const hasEnd = group.items.some(i => i.type === 'end');
      const hasFailed = group.items.some(i => i.status === 'failed' && i.type === 'end');
      const hasStart = group.items.some(i => i.type === 'start');

      // Pick color: red if any end is failed, green for starts/successful ends
      const color = hasFailed ? 'var(--vscode-testing-iconFailed,#f44336)' : 'var(--vscode-testing-iconPassed,#4caf50)';
      // Point up for starts, down for ends, diamond for mixed
      let borderCSS: string;
      if (hasStart && hasEnd) {
        // Diamond shape (mixed start+end)
        borderCSS = `width:8px;height:8px;background:${color};transform:translateX(-4px) rotate(45deg);top:${BAR_Y + BAR_H/2 - 4}px;`;
      } else if (hasEnd) {
        // Inverted triangle (end)
        borderCSS = `border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:7px solid ${color};transform:translateX(-5px);top:${BAR_Y - 2}px;`;
      } else {
        // Normal triangle (start)
        borderCSS = `border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid ${color};transform:translateX(-5px);top:${BAR_Y + BAR_H - 5}px;`;
      }

      const mk = d.createElement('div');
      mk.style.cssText = `position:absolute;left:${group.px}px;${borderCSS}width:0;height:0;z-index:10;cursor:pointer;`;

      // Build tooltip
      const lines = group.items.map(i => {
        const icon = i.type === 'start' ? '▶' : (i.status === 'failed' ? '✗' : '✓');
        return `${icon} ${i.name} ${i.type} · ${this.clockTimePrecise(i.time)}`;
      });
      mk.title = lines.join('\n');
      if (group.items.length > 1) {
        // Count badge
        const badge = d.createElement('span');
        badge.style.cssText = 'position:absolute;top:-12px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:700;color:var(--vscode-foreground);opacity:0.7;pointer-events:none;';
        badge.textContent = String(group.items.length);
        mk.appendChild(badge);
      }

      area.appendChild(mk);
    }
  }

  // ── Dependency lines ──────────────────────────────────────────────────

  private paintDependencyLines(d: any, wrap: any): void {
    if (!this.data) { return; }

    // Build a map of nodeId → last bar position (use last attempt's end as the producer finish point)
    const nodeLastBar = new Map<string, { rightPx: number; rowIndex: number; endedAt: number }>();
    for (const bp of this.barPositions) {
      const existing = nodeLastBar.get(bp.nodeId);
      if (!existing || bp.endedAt > existing.endedAt) {
        nodeLastBar.set(bp.nodeId, { rightPx: bp.rightPx, rowIndex: bp.rowIndex, endedAt: bp.endedAt });
      }
    }

    // Build a map of nodeId → first bar position (the consumer's start)
    const nodeFirstBar = new Map<string, { leftPx: number; rowIndex: number; startedAt: number }>();
    for (const bp of this.barPositions) {
      const existing = nodeFirstBar.get(bp.nodeId);
      if (!existing || bp.startedAt < existing.startedAt) {
        nodeFirstBar.set(bp.nodeId, { leftPx: bp.leftPx, rowIndex: bp.rowIndex, startedAt: bp.startedAt });
      }
    }

    // Create an SVG overlay for dependency lines
    const svg = d.createElementNS ? d.createElementNS('http://www.w3.org/2000/svg', 'svg') : d.createElement('svg');
    // Calculate total height based on number of rows rendered
    const maxRow = this.barPositions.reduce((m, bp) => Math.max(m, bp.rowIndex), 0);
    const svgH = (maxRow + 2) * ROW_H + AXIS_H;
    const svgW = this.totalWidth() + LABEL_W;
    svg.setAttribute('width', String(svgW));
    svg.setAttribute('height', String(svgH));
    svg.style.cssText = `position:absolute;top:0;left:0;width:${svgW}px;height:${svgH}px;pointer-events:none;z-index:2;overflow:visible;`;

    let lineCount = 0;
    for (const node of this.data.nodes) {
      if (!node.dependencies || node.dependencies.length === 0) { continue; }
      const consumer = nodeFirstBar.get(node.nodeId);
      if (!consumer) { continue; }

      for (const depId of node.dependencies) {
        const producer = nodeLastBar.get(depId);
        if (!producer) { continue; }

        // Only draw if there's a visible gap (producer ends before consumer starts)
        if (producer.rightPx + 4 >= consumer.leftPx) { continue; }

        const x1 = LABEL_W + producer.rightPx;
        const y1 = AXIS_H + producer.rowIndex * ROW_H + ROW_H / 2;
        const x2 = LABEL_W + consumer.leftPx;
        const y2 = AXIS_H + consumer.rowIndex * ROW_H + ROW_H / 2;

        // Draw a curved line from producer end → consumer start
        const midX = (x1 + x2) / 2;
        const line = d.createElementNS ? d.createElementNS('http://www.w3.org/2000/svg', 'path') : d.createElement('path');
        const pathD = y1 === y2
          ? `M${x1},${y1} L${x2},${y2}`
          : `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
        line.setAttribute('d', pathD);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', 'var(--vscode-descriptionForeground)');
        line.setAttribute('stroke-width', '1');
        line.setAttribute('stroke-opacity', '0.25');
        line.setAttribute('stroke-dasharray', '3,3');
        svg.appendChild(line);

        // Small arrow at consumer end
        const arrow = d.createElementNS ? d.createElementNS('http://www.w3.org/2000/svg', 'polygon') : d.createElement('polygon');
        arrow.setAttribute('points', `${x2},${y2} ${x2 - 5},${y2 - 3} ${x2 - 5},${y2 + 3}`);
        arrow.setAttribute('fill', 'var(--vscode-descriptionForeground)');
        arrow.setAttribute('opacity', '0.25');
        svg.appendChild(arrow);
        lineCount++;
      }
    }

    if (lineCount > 0) {
      wrap.appendChild(svg);
    }
  }
}
