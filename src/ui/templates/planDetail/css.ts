/**
 * @fileoverview Plan Detail Panel CSS Styles.
 * 
 * Styles for the plan detail visualization including:
 * - Header with status badge
 * - Progress bar and statistics
 * - Mermaid diagram container
 * - Action buttons
 * - Legend for node/edge states
 * 
 * @module ui/templates/planDetail/css
 */

/**
 * Get the main CSS for the plan detail panel.
 */
export function getPlanDetailCss(): string {
  return `
    * { box-sizing: border-box; }
    body { 
      font: 13px -apple-system, Segoe UI, Roboto, sans-serif; 
      padding: 20px; 
      margin: 0; 
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    
    .header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-title-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .plan-name {
      font-size: 18px;
      font-weight: 600;
    }
    .status-badge { 
      display: inline-flex; 
      align-items: center; 
      padding: 4px 10px; 
      border-radius: 3px; 
      font-weight: 600; 
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-badge.failed, .status-badge.partial { 
      background: rgba(244, 135, 113, 0.15); 
      border-left: 3px solid #F48771;
      color: #F48771; 
    }
    .status-badge.completed, .status-badge.succeeded { 
      background: rgba(78, 201, 176, 0.15); 
      border-left: 3px solid #4EC9B0;
      color: #4EC9B0; 
    }
    .status-badge.running { 
      background: rgba(75, 166, 251, 0.2); 
      border-left: 3px solid #4BA6FB;
      color: #7DD3FC; 
    }
    .status-badge.queued, .status-badge.canceled { 
      background: rgba(133, 133, 133, 0.1); 
      border-left: 3px solid #858585;
      color: #858585; 
    }
    
    .progress-section {
      margin-bottom: 24px;
    }
    .progress-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .progress-bar {
      height: 8px;
      border-radius: 4px;
      background: var(--vscode-input-background);
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #4BA6FB, #4EC9B0);
      transition: width 0.5s ease;
    }
    .progress-stats {
      display: flex;
      gap: 16px;
      margin-top: 12px;
      font-size: 12px;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .stat-dot.completed { background: #4EC9B0; }
    .stat-dot.running { background: #7DD3FC; }
    .stat-dot.queued { background: #858585; }
    .stat-dot.failed { background: #F48771; }
    
    .diagram-container {
      margin: 20px 0;
      padding: 20px;
      background: var(--vscode-input-background);
      border-radius: 8px;
      overflow-x: auto;
    }
    
    #mermaid-diagram {
      display: flex;
      justify-content: flex-start;
      min-width: fit-content;
    }
    
    /* Mermaid styling overrides */
    /* Only running/completed/failed job nodes are clickable - not pending, merge, or branch nodes */
    .mermaid .node.running rect,
    .mermaid .node.running .nodeLabel,
    .mermaid .node.completed rect,
    .mermaid .node.completed .nodeLabel,
    .mermaid .node.failed rect,
    .mermaid .node.failed .nodeLabel {
      cursor: pointer !important;
    }

    /* Nodes that are wired as clickable in the webview JS */
    .mermaid g.node.clickable-node,
    .mermaid g.node.clickable-node * {
      cursor: pointer !important;
    }

    .mermaid g.cluster.clickable-node,
    .mermaid g.cluster.clickable-node * {
      cursor: pointer !important;
    }
    
    .mermaid .node.running:hover rect,
    .mermaid .node.completed:hover rect,
    .mermaid .node.failed:hover rect {
      filter: brightness(1.2);
    }
    
    /* Subgraph styling */
    .mermaid .cluster rect {
      fill: rgba(60, 60, 60, 0.3) !important;
      stroke: #555 !important;
      rx: 8px;
    }
    
    .mermaid .cluster-label {
      fill: #888 !important;
      font-size: 11px !important;
    }
    
    /* Force uniform job node widths */
    .mermaid .node rect {
      min-width: 220px !important;
    }
    
    /* Smaller width for MERGE and branch nodes */
    .mermaid .node.mergeNode rect,
    .mermaid .node.mergeCompleted rect,
    .mermaid .node.targetBranchNode rect,
    .mermaid .node.baseBranchNode rect {
      min-width: auto !important;
    }
    
    .actions {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .action-btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .cancel-btn, .retry-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .delete-btn {
      background: #5a1d1d;
      color: #F48771;
      margin-left: auto;
    }
    .delete-btn:hover:not(:disabled) {
      background: #6d2222;
    }
    
    .legend {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      font-size: 11px;
      flex-wrap: wrap;
    }
    .legend-section {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .legend-section-title {
      font-weight: 600;
      color: #888;
      margin-right: 4px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .legend-box {
      width: 14px;
      height: 14px;
      border-radius: 3px;
      border: 2px solid;
    }
    .legend-box.pending { border-color: #858585; background: transparent; }
    .legend-box.running { border-color: #7DD3FC; background: rgba(125, 211, 252, 0.2); }
    .legend-box.completed { border-color: #4EC9B0; background: rgba(78, 201, 176, 0.2); }
    .legend-box.failed { border-color: #F48771; background: rgba(244, 135, 113, 0.2); }
    
    .legend-line {
      width: 20px;
      height: 3px;
      position: relative;
    }
    .legend-line.pending {
      background: repeating-linear-gradient(90deg, #858585 0px, #858585 4px, transparent 4px, transparent 6px);
    }
    .legend-line.running {
      background: repeating-linear-gradient(90deg, #7DD3FC 0px, #7DD3FC 6px, transparent 6px, transparent 8px, #7DD3FC 8px, #7DD3FC 10px, transparent 10px, transparent 12px);
    }
    .legend-line.completed {
      background: #4EC9B0;
    }
    .legend-line.failed {
      background: repeating-linear-gradient(90deg, #F48771 0px, #F48771 2px, transparent 2px, transparent 4px);
    }
    
    /* Responsive legend - stack on smaller screens */
    @media (max-width: 800px) {
      .legend {
        flex-direction: column;
        gap: 8px;
      }
      .legend-section {
        gap: 8px;
      }
    }
  `;
}

/**
 * Get loading/error state CSS.
 */
export function getPlanDetailLoadingCss(): string {
  return `
    body { 
      font: 14px sans-serif; 
      padding: 20px; 
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 80vh;
    }
    .error { 
      text-align: center; 
      opacity: 0.6; 
    }
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 60vh;
      gap: 20px;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 3px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      opacity: 0.3;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .loading-text {
      font-size: 14px;
      opacity: 0.6;
    }
    .skeleton-container {
      width: 100%;
      max-width: 800px;
      margin-top: 30px;
    }
    .skeleton {
      background: linear-gradient(90deg, 
        var(--vscode-input-background) 25%, 
        var(--vscode-editor-background) 50%, 
        var(--vscode-input-background) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 4px;
    }
    .skeleton-header {
      height: 24px;
      width: 60%;
      margin-bottom: 20px;
    }
    .skeleton-progress {
      height: 8px;
      width: 100%;
      margin-bottom: 30px;
    }
    .skeleton-diagram {
      height: 200px;
      width: 100%;
      margin-bottom: 20px;
    }
    .skeleton-row {
      height: 16px;
      width: 80%;
      margin-bottom: 10px;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `;
}

/**
 * Get work summary panel CSS.
 */
export function getWorkSummaryCss(): string {
  return `
    * { box-sizing: border-box; }
    body { 
      font: 13px -apple-system, Segoe UI, Roboto, sans-serif; 
      padding: 0; 
      margin: 0; 
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; }
    .header { margin-bottom: 24px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px 0; }
    .subtitle { font-size: 13px; color: var(--vscode-descriptionForeground); }
    
    .summary-stats {
      display: flex;
      gap: 24px;
      margin-bottom: 24px;
      padding: 16px;
      background: var(--vscode-input-background);
      border-radius: 8px;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .stat-value { font-size: 24px; font-weight: 600; }
    .stat-value.added { color: #4EC9B0; }
    .stat-value.modified { color: #DCDCAA; }
    .stat-value.deleted { color: #F48771; }
    .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
    
    .job-section {
      margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .job-section.expandable { cursor: pointer; }
    .job-section.expandable:hover .job-header { background: var(--vscode-list-hoverBackground); }
    .job-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--vscode-input-background);
      transition: background 0.15s;
    }
    .job-chevron {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.2s;
    }
    .job-section.expanded .job-chevron { transform: rotate(90deg); }
    .job-name { font-weight: 600; flex: 1; }
    .job-stats { display: flex; gap: 12px; font-size: 12px; }
    .job-stat { display: flex; align-items: center; gap: 4px; }
    .job-stat.added { color: #4EC9B0; }
    .job-stat.modified { color: #DCDCAA; }
    .job-stat.deleted { color: #F48771; }
    
    .commits-panel {
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .commits-list { padding: 12px 16px; }
    .commit-item {
      padding: 12px;
      margin-bottom: 8px;
      background: var(--vscode-input-background);
      border-radius: 4px;
    }
    .commit-item:last-child { margin-bottom: 0; }
    .commit-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .commit-hash {
      font-family: monospace;
      font-size: 11px;
      padding: 2px 6px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      color: #7DD3FC;
    }
    .commit-message { font-weight: 500; }
    .commit-meta {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .commit-stats { display: flex; gap: 8px; }
    .stat-added { color: #4EC9B0; }
    .stat-modified { color: #DCDCAA; }
    .stat-deleted { color: #F48771; }
    .commit-files { font-size: 12px; }
    .commit-file {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-family: monospace;
    }
    .file-status { font-weight: 600; width: 14px; }
    .file-added .file-status { color: #4EC9B0; }
    .file-modified .file-status { color: #DCDCAA; }
    .file-deleted .file-status { color: #F48771; }
  `;
}
