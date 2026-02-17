/**
 * @fileoverview Phase tab bar control — shows/hides execution phase tabs.
 *
 * Subscribes to {@link Topics.NODE_STATE_CHANGE} and
 * {@link Topics.LOG_PHASE_CHANGE} to update tab visibility and active state.
 *
 * @module ui/webview/controls/phaseTabBar
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Phase definition. */
export interface PhaseInfo {
  id: string;
  name: string;
  icon: string;
}

/** Data delivered with each update. */
export interface PhaseTabBarData {
  /** Phase-to-status mapping. */
  phaseStatus: Record<string, string>;
  /** Currently active phase ID. */
  activePhase?: string;
}

const DEFAULT_PHASES: PhaseInfo[] = [
  { id: 'all', name: 'Full Log', icon: '📋' },
  { id: 'merge-fi', name: 'Merge FI', icon: '↓' },
  { id: 'prechecks', name: 'Prechecks', icon: '✓' },
  { id: 'work', name: 'Work', icon: '⚙' },
  { id: 'commit', name: 'Commit', icon: '💾' },
  { id: 'postchecks', name: 'Postchecks', icon: '✓' },
  { id: 'merge-ri', name: 'Merge RI', icon: '↑' },
];

/** Map phase status to CSS icon character. */
export function phaseStatusIcon(status: string): string {
  if (status === 'success') { return '✓'; }
  if (status === 'failed') { return '✗'; }
  if (status === 'running') { return '⟳'; }
  if (status === 'skipped') { return '⊘'; }
  return '○';
}

/**
 * Phase tab bar control for execution phases.
 */
export class PhaseTabBar extends SubscribableControl {
  private elementId: string;
  private activePhase = 'all';
  private phases: PhaseInfo[];

  constructor(bus: EventBus, controlId: string, elementId: string, phases?: PhaseInfo[]) {
    super(bus, controlId);
    this.elementId = elementId;
    this.phases = phases || DEFAULT_PHASES;
    this.subscribe(Topics.NODE_STATE_CHANGE, (data?: PhaseTabBarData) => this.update(data));
    this.subscribe(Topics.LOG_PHASE_CHANGE, (data?: { phase: string }) => {
      if (data) { this.setActivePhase(data.phase); }
    });
  }

  update(data?: PhaseTabBarData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    if (data.activePhase) { this.activePhase = data.activePhase; }

    let html = '';
    for (const phase of this.phases) {
      const status = data.phaseStatus[phase.id] || 'pending';
      const icon = phase.id === 'all' ? phase.icon : phaseStatusIcon(status);
      const activeClass = phase.id === this.activePhase ? ' active' : '';
      html += `<button class="phase-tab phase-${status}${activeClass}" data-phase="${phase.id}">${icon} ${phase.name}</button>`;
    }
    el.innerHTML = html;
    this.publishUpdate(data);
  }

  /** Set the active phase tab. */
  setActivePhase(phaseId: string): void {
    this.activePhase = phaseId;
    const el = this.getElement(this.elementId);
    if (!el || !el.querySelectorAll) { return; }

    const buttons = el.querySelectorAll('.phase-tab');
    for (const btn of buttons) {
      if (btn.getAttribute('data-phase') === phaseId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
    this.publishUpdate({ activePhase: phaseId });
  }

  getActivePhase(): string {
    return this.activePhase;
  }
}
