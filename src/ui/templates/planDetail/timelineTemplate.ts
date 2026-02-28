/**
 * @fileoverview Plan detail timeline (Gantt) visualization template.
 *
 * Renders the timeline view container, zoom controls, and chart structure
 * for the plan detail view.
 *
 * @module ui/templates/planDetail/timelineTemplate
 */

/**
 * Input data for rendering the timeline visualization section.
 */
export interface PlanTimelineData {
  /** Computed plan status */
  status: string;
}

/**
 * Render the timeline visualization section HTML fragment.
 *
 * Includes zoom controls (zoom in/out, reset), a scrollable container,
 * and the timeline chart area that will be populated client-side.
 *
 * The section starts hidden (CSS `display: none`) — the tab bar toggles visibility.
 *
 * @param data - Timeline input data.
 * @returns HTML fragment string for the timeline section.
 */
export function renderPlanTimeline(data: PlanTimelineData): string {
  return `
    <div id="timeline-section" class="section">
      <h3 style="display:flex;align-items:center;gap:6px;margin:24px 0 8px 0;padding-top:8px;border-top:1px solid var(--vscode-panel-border);font-size:14px;color:var(--vscode-foreground);">
        <svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle;"><rect x="1" y="2" width="10" height="3" rx="1" fill="currentColor" opacity="0.9"/><rect x="4" y="7" width="11" height="3" rx="1" fill="currentColor" opacity="0.7"/><rect x="2" y="12" width="7" height="3" rx="1" fill="currentColor" opacity="0.5"/></svg>
        Timeline
      </h3>
      <div id="timeline-container" class="timeline-container">
        <div id="timeline-chart" class="timeline-chart"></div>
      </div>
    </div>
  `;
}
