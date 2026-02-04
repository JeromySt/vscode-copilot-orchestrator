/**
 * @fileoverview CSS styles for job details panel.
 * 
 * Contains all CSS for the job details webview panel including:
 * - Header and status badges
 * - Execution attempts cards
 * - Process tree visualization
 * - Log viewer
 * - Process modal
 * 
 * @module ui/templates/jobDetailsCss
 */

/**
 * Get the CSS styles for the job details panel.
 * Uses VS Code CSS variables for theme compatibility.
 */
export function getJobDetailsCss(): string {
  return `
    body { 
      font: 12px sans-serif; 
      padding: 16px; 
      margin: 0; 
      color: var(--vscode-foreground); 
      background: var(--vscode-editor-background);
    }
    
    h2 { margin: 0 0 8px 0; }
    h3 { 
      font-size: 11px; 
      margin: 24px 0 12px 0; 
      text-transform: uppercase; 
      letter-spacing: 1px; 
      opacity: 0.6; 
      font-weight: 600;
    }
    
    /* Header */
    .header { 
      margin-bottom: 20px; 
      padding-bottom: 16px; 
      border-bottom: 2px solid var(--vscode-panel-border); 
    }
    .header-top { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      margin-bottom: 12px;
    }
    .title-section { flex: 1; }
    .action-buttons { 
      display: flex; 
      gap: 8px; 
    }
    .action-btn { 
      padding: 6px 14px; 
      border: none; 
      border-radius: 4px; 
      cursor: pointer; 
      font-size: 11px; 
      font-weight: 600; 
      transition: all 0.2s;
    }
    .action-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .cancel-btn { 
      background: var(--vscode-button-background); 
      color: var(--vscode-button-foreground); 
    }
    .cancel-btn:hover:not(:disabled) { 
      background: var(--vscode-button-hoverBackground); 
    }
    .retry-btn { 
      background: var(--vscode-button-background); 
      color: var(--vscode-button-foreground); 
    }
    .retry-btn:hover:not(:disabled) { 
      background: var(--vscode-button-hoverBackground); 
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }
    .delete-btn { 
      background: var(--vscode-button-secondaryBackground); 
      color: var(--vscode-button-secondaryForeground); 
    }
    .delete-btn:hover { 
      background: var(--vscode-button-secondaryHoverBackground); 
    }
    
    /* Status Badges */
    .status-badge { 
      padding: 4px 10px; 
      border-radius: 3px; 
      font-size: 11px; 
      font-weight: 600; 
      text-transform: uppercase; 
      margin-left: 12px;
      display: inline-flex;
      align-items: center;
    }
    .status-running { background: rgba(75, 166, 251, 0.2); border-left: 3px solid var(--vscode-progressBar-background, #4BA6FB); color: #7DD3FC; }
    .status-succeeded { background: rgba(78, 201, 176, 0.15); border-left: 3px solid var(--vscode-testing-iconPassed, #4EC9B0); color: var(--vscode-testing-iconPassed, #4EC9B0); }
    .status-failed { background: rgba(244, 135, 113, 0.15); border-left: 3px solid var(--vscode-testing-iconFailed, #F48771); color: var(--vscode-testing-iconFailed, #F48771); }
    .status-queued { background: rgba(133, 133, 133, 0.1); border-left: 3px solid var(--vscode-descriptionForeground, #858585); color: var(--vscode-descriptionForeground, #858585); }
    .status-canceled { background: rgba(133, 133, 133, 0.1); border-left: 3px solid var(--vscode-descriptionForeground, #858585); color: var(--vscode-descriptionForeground, #858585); }
    
    .live-duration, .duration-display {
      margin-left: 12px;
      font-size: 11px;
      opacity: 0.7;
      font-weight: 400;
    }
    
    /* Work History Timeline */
    .work-history-section { margin-bottom: 24px; }
    .work-history-timeline { 
      border-left: 2px solid var(--vscode-panel-border);
      padding-left: 0;
      margin-left: 12px;
    }
    .work-history-item {
      position: relative;
      padding-left: 24px;
      padding-bottom: 16px;
    }
    .work-history-item:last-child { padding-bottom: 0; }
    .work-history-dot {
      position: absolute;
      left: -7px;
      top: 6px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      border: 2px solid var(--vscode-editor-background);
    }
    .work-history-item.active .work-history-dot {
      background: var(--vscode-progressBar-background);
      box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.2);
    }
    .work-history-label {
      font-weight: 600;
      font-size: 11px;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
    }
    .work-history-item.active .work-history-label {
      color: var(--vscode-progressBar-background);
    }
    .work-history-preview {
      font-size: 10px;
      opacity: 0.7;
      line-height: 1.4;
    }
    
    /* Execution Attempts */
    .attempt-card { 
      background: var(--vscode-sideBar-background); 
      border: 1px solid var(--vscode-panel-border); 
      border-radius: 6px; 
      margin-bottom: 12px; 
      overflow: hidden;
    }
    .attempt-card.active { 
      border-color: var(--vscode-progressBar-background); 
      border-width: 2px;
    }
    .attempt-header { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      padding: 10px 14px; 
      cursor: pointer;
      user-select: none;
    }
    .attempt-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .attempt-header-left { 
      display: flex; 
      gap: 12px; 
      align-items: center;
      flex: 1;
    }
    .attempt-badge { 
      font-weight: 700; 
      padding: 3px 8px; 
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
      border-radius: 4px; 
      font-size: 10px;
      min-width: 20px;
      text-align: center;
    }
    .step-indicators {
      display: flex;
      gap: 4px;
    }
    .step-dot {
      font-size: 14px;
    }
    .step-dot.success { color: var(--vscode-testing-iconPassed); }
    .step-dot.failed { color: var(--vscode-errorForeground); }
    .step-dot.skipped { color: #808080; }
    .step-dot.pending { color: var(--vscode-descriptionForeground); opacity: 0.5; }
    .step-dot.running { color: #7DD3FC; animation: pulse-dot 1.5s ease-in-out infinite; }
    @keyframes pulse-dot {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .attempt-time { 
      font-size: 10px; 
      opacity: 0.7; 
    }
    .attempt-duration { 
      font-size: 10px; 
      opacity: 0.7; 
    }
    .chevron {
      font-size: 12px;
      transition: transform 0.2s;
    }
    .chevron.expanded {
      transform: rotate(90deg);
    }
    
    /* Attempt Body */
    .attempt-body { 
      padding: 14px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .attempt-meta { 
      font-size: 11px; 
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .attempt-meta-row { 
      line-height: 1.6;
    }
    .attempt-meta-row strong {
      opacity: 0.7;
      font-weight: 600;
      margin-right: 8px;
    }
    .attempt-id-value {
      font-family: monospace;
      opacity: 0.8;
      font-size: 10px;
    }
    .work-summary-box {
      background: rgba(78, 201, 176, 0.1);
      border-left: 3px solid #4EC9B0;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 11px;
      margin: 8px 0;
    }
    .work-summary-box.clickable {
      cursor: pointer;
    }
    .work-summary-box.clickable:hover {
      background: rgba(78, 201, 176, 0.15);
    }
    .work-summary-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .work-summary-chevron {
      font-size: 10px;
      transition: transform 0.2s;
      display: inline-block;
    }
    .work-summary-box.expanded .work-summary-chevron {
      transform: rotate(90deg);
    }
    .work-summary-icon {
      font-size: 14px;
    }
    .work-summary-counts {
      opacity: 0.7;
      font-family: monospace;
      font-size: 10px;
    }
    .work-summary-details-panel {
      margin-top: 12px;
      border-top: 1px solid rgba(78, 201, 176, 0.3);
      padding-top: 12px;
    }
    .commits-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .commit-item {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px;
    }
    .commit-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .commit-hash {
      font-family: monospace;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 3px;
      cursor: pointer;
    }
    .commit-hash:hover {
      opacity: 0.8;
    }
    .commit-message {
      font-weight: 500;
      font-size: 12px;
      flex: 1;
    }
    .commit-meta {
      display: flex;
      gap: 16px;
      font-size: 10px;
      opacity: 0.7;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .commit-stats {
      display: flex;
      gap: 8px;
      font-family: monospace;
    }
    .stat-added { color: #89d185; }
    .stat-modified { color: #cca700; }
    .stat-deleted { color: #f48771; }
    .commit-files {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 150px;
      overflow-y: auto;
    }
    .commit-file {
      font-family: monospace;
      font-size: 10px;
      padding: 2px 4px;
      border-radius: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .commit-file:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-status {
      width: 12px;
      text-align: center;
      font-weight: bold;
    }
    .file-added { color: #89d185; }
    .file-added .file-status { color: #89d185; }
    .file-modified { color: #cca700; }
    .file-modified .file-status { color: #cca700; }
    .file-deleted { color: #f48771; }
    .file-deleted .file-status { color: #f48771; }
    .work-instruction-box {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      font-size: 10px;
      max-height: 150px;
      overflow-y: auto;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      border: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
    }
    .session-id {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      font-family: monospace;
    }
    .session-id:hover {
      opacity: 0.8;
    }
    
    /* Phase Tabs */
    .log-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 0;
      border-bottom: 2px solid var(--vscode-panel-border);
      flex-wrap: wrap;
    }
    .log-tabs.folder-tabs {
      padding-left: 4px;
    }
    .log-tab {
      padding: 8px 12px;
      background: var(--vscode-tab-inactiveBackground);
      border: 1px solid var(--vscode-panel-border);
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      opacity: 0.7;
      margin-right: -1px;
      margin-bottom: -2px;
      position: relative;
      transition: all 0.15s ease;
    }
    .log-tab:hover {
      opacity: 0.9;
      background: var(--vscode-tab-hoverBackground);
      z-index: 1;
    }
    .log-tab.active {
      opacity: 1;
      background: var(--vscode-tab-activeBackground);
      border-color: var(--vscode-focusBorder);
      border-bottom: 2px solid var(--vscode-tab-activeBackground);
      border-top: 2px solid var(--vscode-focusBorder);
      z-index: 2;
      box-shadow: 0 -2px 8px rgba(0, 120, 212, 0.2);
    }
    /* Full log tab special styling */
    .log-tab[data-section="FULL"].active {
      background: linear-gradient(180deg, var(--vscode-tab-activeBackground) 0%, rgba(0, 120, 212, 0.1) 100%);
      border-top-color: var(--vscode-progressBar-background);
    }
    .log-tab.phase-tab-success {
      background: rgba(78, 201, 176, 0.1);
      border-left: 3px solid #4EC9B0;
    }
    .log-tab.phase-tab-success.active {
      background: rgba(78, 201, 176, 0.2);
    }
    .log-tab.phase-tab-failed {
      background: rgba(244, 135, 113, 0.1);
      border-left: 3px solid #F48771;
    }
    .log-tab.phase-tab-failed.active {
      background: rgba(244, 135, 113, 0.2);
    }
    .log-tab.phase-tab-skipped {
      background: rgba(206, 145, 120, 0.1);
      border-left: 3px solid #CE9178;
    }
    .log-tab.phase-tab-skipped.active {
      background: rgba(206, 145, 120, 0.2);
    }
    .log-tab.phase-tab-running {
      background: rgba(125, 211, 252, 0.1);
      border-left: 3px solid #7DD3FC;
      animation: pulse-tab 2s ease-in-out infinite;
    }
    .log-tab.phase-tab-running.active {
      background: rgba(125, 211, 252, 0.2);
    }
    .log-tab.phase-tab-pending {
      opacity: 0.5;
    }
    @keyframes pulse-tab {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    .phase-icon {
      margin-right: 4px;
      font-weight: bold;
      font-size: 12px;
      display: inline-block;
    }
    .phase-icon-running {
      animation: spin 1s linear infinite;
    }
    .phase-icon-success {
      color: var(--vscode-testing-iconPassed, #4EC9B0);
    }
    .phase-icon-failed {
      color: var(--vscode-testing-iconFailed, #F48771);
    }
    .phase-icon-skipped {
      color: var(--vscode-descriptionForeground, #858585);
    }
    .phase-icon-pending {
      opacity: 0.4;
    }
    .phase-tab-failed {
      border-bottom: 2px solid var(--vscode-testing-iconFailed, #F48771) !important;
    }
    .phase-tab-success {
      border-bottom: 2px solid var(--vscode-testing-iconPassed, #4EC9B0) !important;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    /* Log Viewer */
    .log-viewer {
      background: var(--vscode-terminal-background);
      color: var(--vscode-terminal-foreground);
      padding: 12px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 10px;
      max-height: 400px;
      overflow-y: auto;
      overflow-x: auto;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      outline: none;
    }
    .log-viewer:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .log-viewer .loading, .log-viewer .no-log {
      text-align: center;
      opacity: 0.6;
      padding: 20px;
    }
    .log-viewer.loading-content {
      opacity: 0.7;
    }
    .log-viewer .loading-indicator {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    .loading { 
      padding: 12px; 
      text-align: center; 
      opacity: 0.6; 
      font-size: 11px; 
    }
    
    /* Process Tree */
    .process-tree-section {
      margin: 16px 0;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
    }
    .process-tree-header {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .process-tree-header[data-expanded="true"] {
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .process-tree-header:hover { opacity: 0.8; }
    .process-tree-chevron {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }
    .process-tree-header[data-expanded="true"] .process-tree-chevron {
      transform: rotate(90deg);
    }
    .process-tree-icon { font-size: 16px; }
    .process-tree-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .process-tree {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 400px;
      overflow-y: auto;
    }
    .process-node {
      background: var(--vscode-editor-background);
      border-radius: 4px;
      padding: 8px 10px;
      border-left: 3px solid var(--vscode-progressBar-background);
      transition: all 0.2s;
    }
    .process-clickable { cursor: pointer; }
    .process-node:hover {
      background: var(--vscode-list-hoverBackground);
      transform: translateX(2px);
    }
    .process-node-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .process-node-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
    }
    .process-perf-icon { font-size: 16px; flex-shrink: 0; }
    .process-node-info { flex: 1; min-width: 0; }
    .process-node-name {
      font-weight: 600;
      font-size: 11px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .process-node-pid {
      font-size: 9px;
      opacity: 0.6;
      font-family: monospace;
      margin-top: 2px;
    }
    .process-node-cmdline {
      font-size: 9px;
      opacity: 0.5;
      font-family: monospace;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .process-node-stats {
      display: flex;
      gap: 12px;
      flex-shrink: 0;
    }
    .process-stat {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    .process-stat-label {
      font-size: 8px;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .process-stat-value {
      font-size: 11px;
      font-weight: 700;
      font-family: monospace;
      margin-top: 1px;
    }
    .process-stat-value.low { color: var(--vscode-testing-iconPassed); }
    .process-stat-value.medium { color: #FFA500; }
    .process-stat-value.high { color: var(--vscode-errorForeground); }
    
    /* Child processes */
    .process-children {
      margin-top: 6px;
      margin-left: 24px;
      padding-left: 12px;
      border-left: 2px dashed var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .process-child {
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-left: 2px solid var(--vscode-descriptionForeground);
      opacity: 0.95;
    }
    .process-child-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .process-child:hover {
      background: var(--vscode-list-hoverBackground);
      opacity: 1;
    }
    .process-child-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    .process-child-arrow { font-size: 12px; opacity: 0.5; }
    .process-child-name {
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .process-child-pid {
      font-size: 8px;
      opacity: 0.5;
      font-family: monospace;
      margin-left: 6px;
    }
    .process-child-stats {
      display: flex;
      gap: 10px;
      flex-shrink: 0;
    }
    .process-child-cmdline {
      font-size: 8px;
      opacity: 0.5;
      font-family: monospace;
      margin-top: 2px;
      margin-left: 26px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    /* Process Modal */
    .process-modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .process-modal-overlay.visible { display: flex; }
    .process-modal {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      min-width: 450px;
      max-width: 600px;
      max-height: 80vh;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .process-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .process-modal-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 14px;
    }
    .process-modal-close {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      font-size: 18px;
      cursor: pointer;
      opacity: 0.7;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .process-modal-close:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }
    .process-modal-body {
      padding: 16px;
      overflow-y: auto;
      max-height: calc(80vh - 60px);
    }
    .process-detail-section { margin-bottom: 16px; }
    .process-detail-section:last-child { margin-bottom: 0; }
    .process-detail-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
      margin-bottom: 4px;
    }
    .process-detail-value {
      font-size: 13px;
      font-family: monospace;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px 10px;
      border-radius: 4px;
      word-break: break-all;
    }
    .process-detail-value.cmdline {
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 150px;
      overflow-y: auto;
    }
    .process-stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .process-stat-card {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 6px;
      text-align: center;
    }
    .process-stat-card-value {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .process-stat-card-value.cpu-high { color: #F48771; }
    .process-stat-card-value.cpu-medium { color: #CCA700; }
    .process-stat-card-value.mem-high { color: #F48771; }
    .process-stat-card-value.mem-medium { color: #CCA700; }
    .process-stat-card-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
    }
    .process-stats-grid-4 {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-top: 12px;
    }
    .process-stat-card-small {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      text-align: center;
    }
    .process-stat-card-small .process-stat-card-value { font-size: 16px; }
    .process-nav-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    .process-nav-link:hover { opacity: 0.8; }
    .process-nav-link.disabled {
      color: var(--vscode-descriptionForeground);
      cursor: default;
      text-decoration: none;
      opacity: 0.5;
    }
    .process-children-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .process-child-link {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      cursor: pointer;
      font-family: monospace;
    }
    .process-child-link:hover { opacity: 0.8; }
  `;
}
