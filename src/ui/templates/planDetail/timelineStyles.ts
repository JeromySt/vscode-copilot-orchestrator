/**
 * @fileoverview Timeline (Gantt chart) CSS styles.
 *
 * Styles for the timeline visualization including container, axis, rows,
 * bars, tooltips, and zoom controls. All styles use VS Code CSS custom
 * properties for theme consistency.
 *
 * @module ui/templates/planDetail/timelineStyles
 */

/**
 * Renders CSS stylesheet for timeline visualization.
 *
 * Covers:
 * - Container and scrolling
 * - Time axis with tick marks
 * - Job rows with labels and swim lanes
 * - Gantt bars (succeeded, failed, running, pending, canceled states)
 * - Tooltips on hover
 * - Current time marker
 * - Wait lines (scheduled→started gap)
 * - Zoom controls
 *
 * @returns Timeline CSS stylesheet as a string.
 */
export function renderTimelineStyles(): string {
  return `
    /* Timeline Section Container */
    .timeline-header {
      display: flex;
      justify-content: flex-end;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .timeline-controls {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .timeline-controls .zoom-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 10px;
      cursor: pointer;
      font-size: 14px;
      border-radius: 3px;
    }

    .timeline-controls .zoom-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .timeline-controls .zoom-btn:active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    /* Scrollable Container */
    .timeline-container {
      overflow-x: auto;
      overflow-y: auto;
      max-height: 600px;
      position: relative;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      margin-top: 8px;
    }

    /* Timeline Chart Canvas */
    .timeline-chart {
      position: relative;
      min-width: 800px;
      padding: 16px;
    }

    /* Time Axis (Sticky Top) */
    .timeline-axis {
      position: sticky;
      top: 0;
      z-index: 50;
      background: var(--vscode-editor-background);
      height: 40px;
      border-bottom: 2px solid var(--vscode-panel-border);
      display: flex;
      align-items: flex-end;
      padding-bottom: 4px;
    }

    .timeline-tick {
      position: absolute;
      width: 1px;
      height: 100%;
      background: var(--vscode-panel-border);
      opacity: 0.3;
    }

    .timeline-tick-label {
      position: absolute;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      transform: translateX(-50%);
      white-space: nowrap;
    }

    /* Job Row (Swim Lane) */
    .timeline-row {
      display: flex;
      align-items: center;
      height: 40px;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: relative;
    }

    .timeline-row:nth-child(even) {
      background: var(--vscode-editor-background);
    }

    .timeline-row:nth-child(odd) {
      background: rgba(128, 128, 128, 0.05);
    }

    .timeline-row:hover {
      background: var(--vscode-list-hoverBackground);
    }

    /* Job Label (Fixed Left) */
    .timeline-label {
      min-width: 150px;
      max-width: 150px;
      padding: 0 8px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: sticky;
      left: 0;
      background: inherit;
      z-index: 10;
      border-right: 1px solid var(--vscode-panel-border);
    }

    /* Gantt Bars Area */
    .timeline-bars {
      flex: 1;
      position: relative;
      height: 100%;
    }

    /* Gantt Bar */
    .timeline-bar {
      position: absolute;
      height: 24px;
      top: 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      display: flex;
      align-items: center;
      padding: 0 6px;
      font-size: 11px;
      font-weight: 500;
      color: white;
      overflow: hidden;
    }

    .timeline-bar:hover {
      transform: translateY(-2px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 20;
    }

    /* Bar States */
    .timeline-bar.succeeded {
      background: var(--vscode-testing-iconPassed, #4caf50);
    }

    .timeline-bar.failed {
      background: var(--vscode-testing-iconFailed, #f44336);
    }

    .timeline-bar.running {
      background: var(--vscode-progressBar-background, #0078d4);
      animation: pulse-bar 1.5s ease-in-out infinite;
    }

    @keyframes pulse-bar {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .timeline-bar.pending {
      background: transparent;
      border: 2px dashed var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
    }

    .timeline-bar.canceled {
      background: var(--vscode-descriptionForeground);
      opacity: 0.5;
      text-decoration: line-through;
    }

    .timeline-bar.blocked {
      background: var(--vscode-inputValidation-warningBackground, #ff9800);
      color: var(--vscode-inputValidation-warningForeground, #000);
    }

    /* Tooltip */
    .timeline-bar .bar-tooltip {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border);
      color: var(--vscode-editorHoverWidget-foreground);
      padding: 8px 12px;
      border-radius: 4px;
      white-space: nowrap;
      z-index: 100;
      margin-bottom: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      font-size: 12px;
      pointer-events: none;
    }

    .timeline-bar:hover .bar-tooltip {
      display: block;
    }

    .bar-tooltip .tooltip-title {
      font-weight: 600;
      margin-bottom: 4px;
    }

    .bar-tooltip .tooltip-detail {
      font-size: 11px;
      opacity: 0.9;
    }

    /* Current Time Marker */
    .timeline-now-marker {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--vscode-editorCursor-foreground, #ff0000);
      z-index: 30;
      animation: pulse-marker 2s ease-in-out infinite;
    }

    @keyframes pulse-marker {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .timeline-now-marker::before {
      content: '';
      position: absolute;
      top: 0;
      left: -4px;
      width: 10px;
      height: 10px;
      background: var(--vscode-editorCursor-foreground, #ff0000);
      border-radius: 50%;
    }

    /* Wait Line (Scheduled → Started Gap) */
    .timeline-wait-line {
      position: absolute;
      height: 2px;
      background: transparent;
      border-top: 2px dashed var(--vscode-descriptionForeground);
      opacity: 0.5;
      top: 50%;
      transform: translateY(-50%);
    }

    /* Empty State */
    .timeline-empty {
      padding: 40px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 14px;
    }

    /* Loading State */
    .timeline-loading {
      padding: 40px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 14px;
    }

    .timeline-loading::after {
      content: '...';
      animation: ellipsis 1.5s infinite;
    }

    @keyframes ellipsis {
      0% { content: ''; }
      25% { content: '.'; }
      50% { content: '..'; }
      75% { content: '...'; }
    }

    /* Group Headers */
    .timeline-group-header {
      display: flex;
      align-items: center;
      height: 30px;
      background: var(--vscode-sideBar-background);
      border-bottom: 2px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-activityBar-foreground);
      padding: 4px 8px;
      font-weight: 600;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      position: sticky;
      left: 0;
      z-index: 15;
    }

    .timeline-group-header .group-icon {
      margin-right: 6px;
      font-size: 14px;
    }

    /* Phase Segments */
    .phase-segment {
      flex: 0 0 auto;
      height: 100%;
      border-right: 1px solid rgba(0, 0, 0, 0.1);
      transition: opacity 0.3s ease;
    }

    .phase-segment:last-child {
      border-right: none;
    }

    .phase-segment.merge-fi {
      background: #2196F3;
    }

    .phase-segment.setup {
      background: #4CAF50;
    }

    .phase-segment.prechecks {
      background: #FF9800;
    }

    .phase-segment.work {
      background: #E91E63;
    }

    .phase-segment.commit {
      background: #9C27B0;
    }

    .phase-segment.postchecks {
      background: #FF5722;
    }

    .phase-segment.merge-ri {
      background: #00BCD4;
    }

    .phase-segment.failed {
      border-right: 3px solid var(--vscode-testing-iconFailed, #f44336) !important;
      opacity: 0.7;
    }

    .phase-segment.running {
      animation: pulse-phase 1.5s ease-in-out infinite;
    }

    @keyframes pulse-phase {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Dependency Arrows */
    .timeline-arrows {
      position: absolute;
      top: 30px;
      left: 200px;
      width: calc(100% - 200px);
      height: 100%;
      pointer-events: none;
      z-index: 5;
      overflow: visible;
    }

    .timeline-arrows path {
      transition: stroke-width 0.2s ease, opacity 0.2s ease;
    }

    .timeline-arrows path:hover {
      stroke-width: 2.5;
      opacity: 0.8;
    }
  `;
}
