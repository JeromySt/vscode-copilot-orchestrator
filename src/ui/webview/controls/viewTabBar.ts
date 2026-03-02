/**
 * @fileoverview ViewTabBar control for switching between DAG and Timeline views.
 *
 * @module ui/webview/controls/viewTabBar
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';

export type ViewTab = 'dag' | 'timeline';

export interface ViewTabData {
  activeTab: ViewTab;
}

export class ViewTabBar extends SubscribableControl {
  private containerId: string;
  private activeTab: ViewTab = 'dag';

  constructor(bus: EventBus, controlId: string, containerId: string) {
    super(bus, controlId);
    this.containerId = containerId;
    this.setupClickHandlers();
  }

  update(data?: ViewTabData): void {
    if (data) this.activeTab = data.activeTab;
    this.render();
  }

  getActiveTab(): ViewTab { return this.activeTab; }

  private setupClickHandlers(): void {
    // Delegate clicks on .view-tab buttons
    const el = this.getElement(this.containerId);
    if (!el) return;
    el.addEventListener('click', (e: any) => {
      const target = e.target.closest('.view-tab');
      if (!target) return;
      const tab = target.dataset.tab as ViewTab;
      if (tab && tab !== this.activeTab) {
        this.activeTab = tab;
        this.render();
        this.publishUpdate({ activeTab: tab });
      }
    });
  }

  private render(): void {
    const el = this.getElement(this.containerId);
    if (!el) return;
    el.querySelectorAll('.view-tab').forEach((btn: any) => {
      const tab = btn.dataset.tab;
      btn.classList.toggle('active', tab === this.activeTab);
      btn.setAttribute('aria-selected', String(tab === this.activeTab));
    });
  }
}
