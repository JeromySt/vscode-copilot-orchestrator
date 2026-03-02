/**
 * @fileoverview Tab bar template for switching between DAG and Timeline views.
 *
 * @module ui/templates/planDetail/tabBarTemplate
 */

export type PlanViewTab = 'dag' | 'timeline';

export interface TabBarData {
  activeTab: PlanViewTab;
}

export function renderViewTabBar(data: TabBarData): string {
  const dagActive = data.activeTab === 'dag' ? 'active' : '';
  const timelineActive = data.activeTab === 'timeline' ? 'active' : '';
  
  return `
    <div id="viewTabBar" class="view-tab-bar" role="tablist">
      <button class="view-tab ${dagActive}" data-tab="dag" role="tab" aria-selected="${data.activeTab === 'dag'}">
        <svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle;margin-right:4px;"><circle cx="4" cy="8" r="2.5" fill="currentColor"/><circle cx="12" cy="4" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><line x1="6.5" y1="7" x2="9.5" y2="5" stroke="currentColor" stroke-width="1.2"/><line x1="6.5" y1="9" x2="9.5" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>
        DAG
      </button>
      <button class="view-tab ${timelineActive}" data-tab="timeline" role="tab" aria-selected="${data.activeTab === 'timeline'}">
        <svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle;margin-right:4px;"><rect x="1" y="2" width="10" height="3" rx="1" fill="currentColor" opacity="0.9"/><rect x="4" y="7" width="11" height="3" rx="1" fill="currentColor" opacity="0.7"/><rect x="2" y="12" width="7" height="3" rx="1" fill="currentColor" opacity="0.5"/></svg>
        Timeline
      </button>
    </div>
  `;
}
