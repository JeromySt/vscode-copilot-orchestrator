/**
 * @fileoverview Plan detail panel CSS styles.
 *
 * Extracted from planDetailPanel.ts to reduce file size and improve maintainability.
 * All styles use VS Code CSS custom properties for theme consistency.
 *
 * @module ui/templates/planDetail/stylesTemplate
 */

/**
 * Renders complete CSS stylesheet for plan detail panel.
 *
 * Combines all sub-style sections into a single string for injection
 * into the webview HTML `<style>` tag.
 *
 * @returns Complete CSS stylesheet as a string.
 */
export function renderPlanDetailStyles(): string {
  return [
    layoutStyles(),
    headerStyles(),
    statusBadgeStyles(),
    branchFlowStyles(),
    capacityStyles(),
    statsGridStyles(),
    progressBarStyles(),
    mermaidDiagramStyles(),
    zoomControlStyles(),
    legendStyles(),
    processesStyles(),
    workSummaryStyles(),
    metricsBarStyles(),
    toolbarStyles(),
    actionButtonStyles(),
    scaffoldingStyles(),
  ].join('\n');
}

function layoutStyles(): string {
  return `
    body {
      font: 13px var(--vscode-font-family);
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      overflow-x: auto;
      overflow-y: auto;
    }
    .plan-content-wrapper {
      display: inline-flex;
      flex-direction: column;
      min-width: 100%;
      box-sizing: border-box;
    }
    .plan-content-wrapper > * {
      min-width: fit-content;
      box-sizing: border-box;
    }
    /* Sticky header */
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-editor-background);
      padding: 12px 16px 8px 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 8px;
    }
    .sticky-header + * {
      padding-top: 8px;
    }
    .plan-content-wrapper > * {
      padding-left: 16px;
      padding-right: 16px;
    }`;
}

function headerStyles(): string {
  return `
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .header h2 {
      margin: 0; flex: 1; margin-left: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      min-width: 0; /* allow flex item to shrink below content size */
    }
    
    /* Duration display in header */
    .header-duration {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
    }
    .duration-icon {
      font-size: 16px;
    }
    .duration-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .duration-value.running {
      color: #3794ff;
    }
    .duration-value.succeeded {
      color: #4ec9b0;
    }
    .duration-value.failed {
      color: #f48771;
    }`;
}

function statusBadgeStyles(): string {
  return `
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.running { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .status-badge.succeeded { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .status-badge.failed { background: rgba(244, 135, 113, 0.2); color: #f48771; }
    .status-badge.partial { background: rgba(255, 204, 0, 0.2); color: #cca700; }
    .status-badge.pending { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.paused { background: rgba(255, 165, 0, 0.2); color: #ffa500; }
    .status-badge.pausing { background: rgba(255, 165, 0, 0.15); color: #cc8400; }
    .status-badge.resumed { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .status-badge.pending-start { background: rgba(158, 158, 158, 0.2); color: #9E9E9E; }
    .status-badge.canceled { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.scaffolding {
      background: repeating-linear-gradient(
        -45deg,
        rgba(245, 197, 24, 0.2) 0px, rgba(245, 197, 24, 0.2) 6px,
        rgba(26, 26, 26, 0.3) 6px, rgba(26, 26, 26, 0.3) 12px
      );
      color: #f5c518;
      border: 1px solid rgba(245, 197, 24, 0.5);
    }
    
    /* Phase indicator in status badge */
    .phase-indicator {
      font-size: 11px;
      font-weight: 500;
    }`;
}

function branchFlowStyles(): string {
  return `
    /* Branch flow */
    .branch-flow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      font-size: 12px;
      overflow: hidden;
      max-width: 100%;
    }
    .branch-name {
      padding: 3px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-family: monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      max-width: 40%;
    }
    .branch-arrow {
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .branch-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      flex-shrink: 0;
    }`;
}

function capacityStyles(): string {
  return `
    .capacity-info.capacity-badge {
      display: inline-flex;
      padding: 4px 10px;
      margin-bottom: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }`;
}

function statsGridStyles(): string {
  return `
    .stats {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 600;
    }
    .stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .stat-value.succeeded { color: #4ec9b0; }
    .stat-value.failed { color: #f48771; }
    .stat-value.running { color: #3794ff; }`;
}

function progressBarStyles(): string {
  return `
    .progress-container {
      margin-bottom: 16px;
    }
    .progress-bar {
      height: 6px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 3px;
    }
    .progress-fill {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .progress-fill.succeeded { background: #4ec9b0; }
    .progress-fill.failed { background: #f48771; }`;
}

function mermaidDiagramStyles(): string {
  return `
    #mermaid-diagram {
      background: var(--vscode-sideBar-background);
      padding: 16px;
      border-radius: 8px;
      overflow: auto;
      margin-bottom: 16px;
      position: relative;
    }
    #mermaid-diagram {
      cursor: grab;
    }
    #mermaid-diagram.panning {
      cursor: grabbing;
      user-select: none;
    }
    #mermaid-diagram.panning .mermaid-container {
      transition: none;
    }
    .mermaid-container {
      transform-origin: top left;
      transition: transform 0.2s ease;
    }
    
    /* Mermaid node styling */
    .mermaid .node rect { rx: 8px; ry: 8px; }
    .mermaid .node.pending rect { fill: #3c3c3c; stroke: #858585; }
    .mermaid .node.ready rect { fill: #2d4a6e; stroke: #3794ff; }
    .mermaid .node.running rect { fill: #2d4a6e; stroke: #3794ff; stroke-width: 2px; }
    .mermaid .node.succeeded rect { fill: #1e4d40; stroke: #4ec9b0; }
    .mermaid .node.failed rect { fill: #4d2929; stroke: #f48771; }
    .mermaid .node.blocked rect { fill: #3c3c3c; stroke: #858585; stroke-dasharray: 5,5; }
    
    .mermaid .node { cursor: pointer; }
    .mermaid .node.branchNode,
    .mermaid .node.baseBranchNode,
    .mermaid g[id*="BASE_BRANCH"] .node,
    .mermaid g[id*="TARGET_SOURCE"] .node,
    .mermaid g[id*="TARGET_MERGED"] .node { cursor: default; }  /* Branch nodes are not clickable */
    
    /* Node labels — override Mermaid's inline max-width so text renders
       at its natural width.  Labels are pre-truncated server-side so they
       won't grow unbounded.  overflow:visible ensures nothing clips. */
    .mermaid .node .nodeLabel {
      white-space: nowrap !important;
      display: block !important;
      overflow: visible !important;
      max-width: none !important;
    }
    .mermaid .node foreignObject {
      overflow: visible !important;
    }
    .mermaid .node foreignObject div {
      white-space: nowrap !important;
      overflow: visible !important;
      max-width: none !important;
    }
    
    /* Subgraph/cluster styling */
    .mermaid .cluster rect { 
      rx: 8px; 
      ry: 8px;
    }
    .mermaid .cluster,
    .mermaid .cluster-label,
    .mermaid g.cluster,
    .mermaid g.cluster foreignObject,
    .mermaid g.cluster foreignObject div {
      overflow: visible !important;
      clip-path: none !important;
    }
    .mermaid .cluster-label,
    .mermaid .cluster-label span,
    .mermaid g.cluster text { 
      cursor: pointer !important;
      font-weight: bold;
      pointer-events: all !important;
    }
    /* Disable any clipping on cluster labels */
    .mermaid .cluster .label-container {
      overflow: visible !important;
    }
    .mermaid .cluster-label:hover,
    .mermaid g.cluster text:hover {
      text-decoration: underline;
      fill: #7DD3FC;
    }
    /* Subgraph titles are pre-truncated server-side; let Mermaid size the box */
    .mermaid .cluster .nodeLabel {
      white-space: nowrap !important;
    }
    .mermaid svg {
      overflow: visible;
    }`;
}

function zoomControlStyles(): string {
  return `
    /* Zoom controls */
    .zoom-controls {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      background: rgba(30, 30, 30, 0.95);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border);
      width: fit-content;
    }
    .zoom-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      min-width: 32px;
    }
    .zoom-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .zoom-level {
      display: flex;
      align-items: center;
      padding: 0 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-width: 50px;
      justify-content: center;
    }`;
}

function legendStyles(): string {
  return `
    /* Legend */
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 8px 12px;
      background: rgba(30, 30, 30, 0.9);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      align-items: center;
      margin-bottom: 12px;
      font-size: 11px;
    }
    .legend-toggle {
      cursor: pointer;
      user-select: none;
    }
    .legend-toggle:hover {
      color: var(--vscode-foreground);
    }
    .legend.collapsed .legend-items {
      display: none;
    }
    .legend.collapsed .legend-toggle::after {
      content: ' ▸';
    }
    .legend:not(.collapsed) .legend-toggle::after {
      content: ' ▾';
    }
    .legend-items {
      display: contents;
    }
    .legend-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .legend-icon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: bold;
    }
    .legend-icon.pending { background: #3c3c3c; border: 1px solid #858585; color: #858585; }
    .legend-icon.running { background: #2d4a6e; border: 1px solid #3794ff; color: #3794ff; }
    .legend-icon.succeeded { background: #1e4d40; border: 1px solid #4ec9b0; color: #4ec9b0; }
    .legend-icon.failed { background: #4d2929; border: 1px solid #f48771; color: #f48771; }
    .legend-icon.blocked { background: #3c3c3c; border: 1px dashed #858585; color: #858585; }`;
}

function processesStyles(): string {
  return `
    /* Plan Configuration Section */
    .plan-config-section {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 0;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .plan-config-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      cursor: pointer;
      user-select: none;
    }
    .plan-config-header:hover { opacity: 0.85; }
    .plan-config-header h3 {
      margin: 0;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .plan-config-chevron {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.15s;
    }
    .plan-config-body {
      padding: 0 16px 12px 16px;
    }
    .plan-config-item {
      display: flex;
      gap: 12px;
      padding: 5px 0;
      font-size: 12px;
      border-bottom: 1px solid rgba(128,128,128,0.1);
    }
    .plan-config-item:last-child { border-bottom: none; }
    .plan-config-label {
      min-width: 140px;
      flex-shrink: 0;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .plan-config-value {
      color: var(--vscode-foreground);
      word-break: break-all;
    }
    .plan-config-value code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .plan-config-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }
    .plan-config-env-row {
      display: flex;
      gap: 4px;
      align-items: baseline;
      padding: 2px 0;
    }
    .plan-config-env-key {
      color: var(--vscode-symbolIcon-variableForeground, #75beff);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .plan-config-env-eq { color: var(--vscode-descriptionForeground); }
    .plan-config-env-val {
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      word-break: break-all;
    }

    /* Processes Section */
    .processes-section {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      border-left: 3px solid #3794ff;
    }
    .processes-section h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .processes-loading {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 8px 0;
    }
    .node-processes {
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      overflow: hidden;
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
    }
    .node-processes.collapsed .node-processes-tree { display: none; }
    .node-processes.collapsed .node-chevron { content: '▶'; }
    .node-processes-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 500;
    }
    .node-processes-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .node-chevron {
      font-size: 10px;
      transition: transform 0.2s;
    }
    .node-icon { font-size: 14px; }
    .node-name { flex: 1; }
    .node-stats {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
    }
    .node-name-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 1px;
    }
    .node-plan-path {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      opacity: 0.8;
    }
    .node-processes-tree {
      padding: 4px 12px 8px;
      border-top: 1px solid var(--vscode-widget-border);
      max-height: 140px; /* ~5 process rows */
      overflow-y: auto;
      position: relative;
    }
    /* Scroll fade indicator at the bottom */
    .node-processes-tree.has-overflow::after {
      content: '';
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      display: block;
      height: 24px;
      background: linear-gradient(transparent, var(--vscode-editor-background));
      pointer-events: none;
    }
    .process-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 12px;
    }
    .proc-icon { font-size: 12px; }
    .proc-name { flex: 1; font-family: var(--vscode-editor-font-family); }
    .proc-pid { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .proc-stats { color: var(--vscode-descriptionForeground); font-size: 11px; }
    
    /* Process Aggregation Summary */
    .processes-summary {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 14px;
      margin-bottom: 12px;
      background: rgba(55, 148, 255, 0.08);
      border: 1px solid rgba(55, 148, 255, 0.25);
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
    }
    .processes-summary-label {
      color: var(--vscode-foreground);
    }
    .processes-summary-stat {
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      font-size: 12px;
    }

    /* Job status indicators */
    .job-scheduled .node-stats.job-scheduled {
      color: var(--vscode-charts-yellow);
      font-style: italic;
    }
    .job-running .node-stats.job-starting {
      color: var(--vscode-charts-blue);
      font-style: italic;
    }`;
}

function workSummaryStyles(): string {
  return `
    /* Work Summary */
    .work-summary {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .work-summary h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .work-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .work-stat {
      text-align: center;
      padding: 12px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-stat-value {
      font-size: 20px;
      font-weight: 600;
    }
    .work-stat-value.added { color: #4ec9b0; }
    .work-stat-value.modified { color: #dcdcaa; }
    .work-stat-value.deleted { color: #f48771; }
    .work-stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    
    .job-summaries {
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 12px;
    }
    .job-summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border);
      cursor: pointer;
    }
    .job-summary:hover {
      background: var(--vscode-list-hoverBackground);
      margin: 0 -8px;
      padding: 8px;
    }
    .job-summary:last-child { border-bottom: none; }
    .job-name {
      font-weight: 500;
    }
    .job-stats {
      display: flex;
      gap: 12px;
      font-size: 12px;
    }
    .job-stats .stat-commits { color: var(--vscode-descriptionForeground); }
    .job-stats .stat-added { color: #4ec9b0; }
    .job-stats .stat-modified { color: #dcdcaa; }
    .job-stats .stat-deleted { color: #f48771; }
    
    /* Work summary clickable stats */
    .work-summary-clickable {
      cursor: pointer;
      transition: background 0.15s;
      border-radius: 8px;
      padding: 4px;
    }
    .work-summary-clickable:hover {
      background: var(--vscode-list-hoverBackground);
    }`;
}

function metricsBarStyles(): string {
  return `
    .plan-metrics-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      margin-bottom: 16px;
      border-left: 3px solid var(--vscode-progressBar-background);
    }
    .plan-metrics-bar .metrics-label {
      font-weight: 600;
      font-size: 13px;
    }
    .plan-metrics-bar .metric-item {
      font-size: 13px;
      white-space: nowrap;
    }
    .plan-metrics-bar .metric-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
    }
    .plan-metrics-bar .models-line {
      width: 100%;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding-left: 2px;
    }
    .plan-metrics-bar .model-breakdown {
      width: 100%;
      margin-top: 8px;
    }
    .plan-metrics-bar .model-breakdown-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .plan-metrics-bar .model-breakdown-list {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
    }
    .plan-metrics-bar .model-row {
      display: flex;
      gap: 12px;
      align-items: baseline;
      padding: 2px 0;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .plan-metrics-bar .model-name {
      font-weight: 600;
      min-width: 140px;
    }
    .plan-metrics-bar .model-tokens {
      color: var(--vscode-descriptionForeground);
    }`;
}

function toolbarStyles(): string {
  return `
    .plan-toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      padding: 4px 0 0 0;
    }
    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }`;
}

function actionButtonStyles(): string {
  return `
    .action-btn {
      padding: 3px 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.15s, opacity 0.15s;
    }
    .action-btn:hover {
      opacity: 0.9;
    }
    .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-secondaryBackground);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
    }
    .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
    }
    .action-btn.danger {
      background: #cc3333;
      color: white;
    }
    .action-btn.danger:hover {
      background: #aa2222;
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }`;
}

function scaffoldingStyles(): string {
  return `
    .scaffolding-message {
      padding: 8px 12px;
      background: rgba(55, 148, 255, 0.1);
      border-left: 3px solid #3794ff;
      margin-bottom: 12px;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
    }`;
}
