/**
 * @fileoverview Node detail panel CSS styles.
 *
 * Extracted from {@link NodeDetailPanel#_getStyles} to reduce file size
 * and improve maintainability. Organized into logical sub-functions by UI component.
 *
 * @module ui/templates/nodeDetail/stylesTemplate
 */

/**
 * Base layout and typography styles.
 */
function layoutStyles(): string {
  return `
    * { box-sizing: border-box; }
    body {
      font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    
    /* Sticky header */
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-editor-background);
      padding: 12px 16px 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .sticky-header + * {
      padding-top: 8px;
    }
    body > *:not(.sticky-header) {
      padding-left: 16px;
      padding-right: 16px;
    }
    
    /* Section */
    .section {
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
    }
    .section h3 {
      margin: 0 0 10px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    /* Breadcrumb */
    .breadcrumb {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .breadcrumb a, .link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .breadcrumb a:hover, .link:hover { text-decoration: underline; }
    
    /* Error */
    .error {
      padding: 12px;
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
      border-radius: 4px;
      margin-bottom: 16px;
    }
    .error-title {
      font-weight: 600;
      color: var(--vscode-errorForeground);
      margin-bottom: 4px;
    }
    .error-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
    }
    .error-details .file-path {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    
    /* Session ID */
    .session-id-container {
      margin-top: 8px;
      padding: 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      font-size: 11px;
    }
    .session-id-label {
      color: var(--vscode-descriptionForeground);
      margin-right: 6px;
    }
    .session-id-value {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-foreground);
    }
  `;
}

/**
 * Header, breadcrumb, and status indicator styles.
 */
function headerStyles(): string {
  return `
    /* Force Fail button in sticky header */
    .force-fail-btn {
      padding: 4px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-top: 8px;
      background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.2));
      color: #f48771;
    }
    .force-fail-btn:hover {
      background: rgba(244, 135, 113, 0.4);
    }
    
    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .header h2 {
      margin: 0; font-size: 18px; flex: 1; margin-left: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      min-width: 0; /* allow flex item to shrink below content size */
    }
    
    /* Phase indicator in header */
    .header-phase {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 10px;
      background: rgba(0, 122, 204, 0.15);
      color: #3794ff;
      white-space: nowrap;
      margin-right: 12px;
      animation: pulse-phase-badge 2s infinite;
    }
    @keyframes pulse-phase-badge {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    
    /* Duration display in header */
    .header-duration {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .duration-icon { font-size: 16px; }
    .duration-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .duration-value.running { color: #3794ff; }
    .duration-value.succeeded { color: #4ec9b0; }
    .duration-value.failed { color: #f48771; }
  `;
}

/**
 * Status badge styles (running, succeeded, failed, etc.).
 */
function statusBadgeStyles(): string {
  return `
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-badge.running { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .status-badge.succeeded { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .status-badge.failed { background: rgba(244, 135, 113, 0.2); color: #f48771; }
    .status-badge.pending, .status-badge.ready { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.blocked { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.scheduled { background: rgba(0, 122, 204, 0.15); color: #3794ff; }
  `;
}

/**
 * Metadata grid and git info styles.
 */
function metaGridStyles(): string {
  return `
    /* Meta Grid */
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
    }
    .meta-item { }
    .meta-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }
    .meta-value { font-size: 13px; }
    
    /* Git Info - stacked vertical list */
    .git-info-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .git-info-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .git-info-item-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 100px;
      flex-shrink: 0;
    }
    .git-info-item-value {
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      word-break: break-all;
    }
    .git-commit-sha {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .git-commit-sha:hover { text-decoration: underline; }
  `;
}

/**
 * Config section, phase specs, and on-failure config styles.
 */
function configStyles(): string {
  return `
    /* Config Items */
    .config-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    /* Config Phase Sections (Prechecks / Work / Postchecks) */
    .config-phase-section {
      margin-bottom: 12px;
      padding: 10px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
    }
    .config-phase-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .config-phase-header.collapsed,
    .config-phase-header.expanded {
      cursor: pointer;
      user-select: none;
    }
    .config-phase-header.collapsed:hover,
    .config-phase-header.expanded:hover {
      opacity: 0.85;
    }
    .config-phase-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .config-phase-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 8px;
      background: rgba(0, 122, 204, 0.15);
      color: #3794ff;
    }
    .config-phase-content { }
    
    /* On-failure config display */
    .on-failure-config {
      margin-top: 10px;
      padding: 8px;
      background: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 0, 0.1));
      border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 204, 0, 0.3));
      border-radius: 4px;
    }
    .on-failure-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .on-failure-icon {
      font-size: 14px;
    }
    .on-failure-fields {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
    }
    .on-failure-field {
      display: flex;
      gap: 6px;
    }
    .on-failure-label {
      color: var(--vscode-descriptionForeground);
      min-width: 100px;
    }
    .on-failure-value {
      color: var(--vscode-foreground);
      font-family: var(--vscode-editor-font-family);
    }
    .on-failure-message {
      margin-top: 6px;
      padding: 6px;
      background: var(--vscode-editor-background);
      border-radius: 3px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    
    /* Work Display Formatting */
    .config-item-value { }
    
    /* Code block container */
    .spec-code-block {
      margin-top: 4px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    
    /* Code block header with language badge */
    .spec-code-header {
      padding: 4px 8px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
    }
    
    /* Language/type badge */
    .spec-type-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .spec-type-badge.command {
      background: rgba(78, 201, 176, 0.2);
      color: #4ec9b0;
    }
    .spec-type-badge.agent {
      background: rgba(0, 122, 204, 0.2);
      color: #3794ff;
    }
    .spec-type-badge.code {
      background: rgba(133, 133, 133, 0.2);
      color: #858585;
    }
    
    /* Agent model label */
    .agent-model-label {
      margin-left: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Environment variables section */
    .env-vars-section {
      margin-top: 8px;
      padding: 8px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .env-vars-title {
      font-size: 10px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .env-vars-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .env-var-item {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-foreground);
      padding: 2px 4px;
      background: var(--vscode-input-background);
      border-radius: 2px;
    }
    .env-var-name {
      color: #3794ff;
      font-weight: 600;
    }
    
    /* Agent instructions markdown rendering */
    .agent-instructions {
      margin-top: 8px;
      padding: 10px 12px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--vscode-foreground);
    }
    .agent-instructions p { margin: 0 0 8px 0; }
    .agent-instructions p:last-child { margin-bottom: 0; }
    .agent-instructions h1, .agent-instructions h2, .agent-instructions h3 {
      font-size: 13px; font-weight: 600; margin: 10px 0 6px 0;
      color: var(--vscode-foreground);
    }
    .agent-instructions h1:first-child, .agent-instructions h2:first-child { margin-top: 0; }
    .agent-instructions code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px; border-radius: 3px;
      font-family: var(--vscode-editor-font-family); font-size: 11px;
    }
    .agent-instructions pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px 10px; border-radius: 4px; overflow-x: auto;
      margin: 6px 0;
    }
    .agent-instructions pre code { padding: 0; background: none; }
    .agent-instructions ul, .agent-instructions ol { margin: 4px 0; padding-left: 20px; }
    .agent-instructions li { margin-bottom: 2px; }
    .agent-instructions-title {
      font-size: 10px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .agent-instructions-content {
      font-size: 12px;
      line-height: 1.6;
      color: var(--vscode-foreground);
    }
    .agent-instructions-content p {
      margin: 0 0 8px 0;
    }
    .agent-instructions-content p:last-child {
      margin-bottom: 0;
    }
    .agent-instructions-content code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    
    /* General spec-code styling with wrapping */
    .spec-code {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      padding: 8px;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      color: var(--vscode-editor-foreground);
    }
    
    /* Code content area */
    .spec-code-content {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      padding: 8px;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      border-radius: 4px;
      max-height: 300px;
      overflow-y: auto;
    }
    .spec-code-content code {
      background: none;
      padding: 0;
    }
    
    /* Agent instructions (markdown content) */
    .agent-instructions-markdown { }
    
    /* Legacy badge styles (keep for backward compat) */
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge.agent {
      background: rgba(0, 122, 204, 0.2);
      color: #3794ff;
    }
    .badge.command {
      background: rgba(78, 201, 176, 0.2);
      color: #4ec9b0;
    }
    .badge.code {
      background: rgba(133, 133, 133, 0.2);
      color: #858585;
    }
  `;
}

/**
 * Log viewer and phase tabs styles.
 */
function logViewerStyles(): string {
  return `
    /* Retry Buttons */
    .retry-buttons {
      margin-bottom: 12px;
      display: flex;
      gap: 8px;
    }
    .retry-btn {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .retry-btn:hover { background: var(--vscode-button-hoverBackground); }
    .retry-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    /* Phase Tabs */
    .phase-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .phase-tab {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .phase-tab:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .phase-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    .phase-tab.failed { color: #f48771; }
    .phase-tab.succeeded { color: #4ec9b0; }
    .phase-tab.skipped { opacity: 0.5; }
    .phase-tab-icon { margin-right: 4px; }

    /* Phase-specific accent colors (matching timeline) */
    .phase-tab[data-phase="merge-fi"] { border-left: 3px solid #2196F3; }
    .phase-tab[data-phase="setup"] { border-left: 3px solid #4CAF50; }
    .phase-tab[data-phase="prechecks"] { border-left: 3px solid #FF9800; }
    .phase-tab[data-phase="work"] { border-left: 3px solid #E91E63; }
    .phase-tab[data-phase="commit"] { border-left: 3px solid #9C27B0; }
    .phase-tab[data-phase="postchecks"] { border-left: 3px solid #FF5722; }
    .phase-tab[data-phase="merge-ri"] { border-left: 3px solid #00BCD4; }
    .phase-tab[data-phase="cleanup"] { border-left: 3px solid #607D8B; }
    
    /* Log File Path */
    .log-file-path {
      margin-bottom: 8px;
      padding: 6px 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      font-size: 11px;
    }
    .log-file-path-label {
      color: var(--vscode-descriptionForeground);
      margin-right: 4px;
    }
    .log-file-path-value {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }
    .log-file-path-value:hover { text-decoration: underline; }
    
    /* Log Viewer */
    .log-viewer {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      overflow-x: auto;
      max-height: 400px;
      overflow-y: auto;
    }
    .log-viewer.empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
      padding: 24px;
    }
    .log-loading {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
      padding: 24px;
    }
  `;
}

/**
 * Process tree styles for running jobs.
 */
function processTreeStyles(): string {
  return `
    /* Process Tree */
    .process-tree-section {
      margin-bottom: 12px;
    }
    .process-tree-header {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      padding: 6px 0;
      user-select: none;
    }
    .process-tree-header:hover {
      opacity: 0.8;
    }
    .process-tree-chevron {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.15s ease;
    }
    .process-tree-header[data-expanded="false"] .process-tree-chevron {
      transform: rotate(-90deg);
    }
    .process-tree-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .process-tree {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.6;
    }
    .process-tree-root {
      padding: 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .process-tree-node {
      display: flex;
      align-items: flex-start;
      padding: 4px 0;
    }
    .process-tree-node-indent {
      margin-left: 20px;
    }
    .process-tree-connector {
      color: var(--vscode-panel-border);
      margin-right: 8px;
    }
    .process-tree-icon {
      margin-right: 6px;
      flex-shrink: 0;
    }
    .process-tree-content {
      flex: 1;
    }
    .process-tree-label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .process-tree-pid {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .process-tree-command {
      color: var(--vscode-foreground);
    }
    .process-tree-status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      margin-left: 8px;
    }
    .process-tree-status.running {
      background: rgba(0, 122, 204, 0.2);
      color: #3794ff;
    }
    .process-tree-status.exited {
      background: rgba(78, 201, 176, 0.2);
      color: #4ec9b0;
    }
    .process-tree-status.failed {
      background: rgba(244, 135, 113, 0.2);
      color: #f48771;
    }
    .process-tree-details {
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .process-tree-detail-item {
      margin-right: 12px;
    }
    .process-tree-empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
      padding: 16px;
    }
    .process-tree-error {
      color: var(--vscode-errorForeground);
      padding: 8px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
    }
    .process-tree-loading {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
      padding: 16px;
    }
  `;
}

/**
 * Dependencies section styles.
 */
function dependencyStyles(): string {
  return `
    /* Dependencies */
    .dependencies {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .dependency-item {
      padding: 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dependency-id { font-weight: 600; }
  `;
}

/**
 * Attempt history card styles.
 */
function attemptHistoryStyles(): string {
  return `
    /* Attempt History Cards */
    .attempt-card {
      margin-bottom: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      transition: border-color 0.15s;
    }
    .attempt-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    /* ── Header (collapsed row) ── */
    .attempt-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      gap: 8px;
    }
    .attempt-header:hover {
      background: rgba(128,128,128,0.06);
    }
    .attempt-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .attempt-header-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .attempt-status-icon {
      font-size: 14px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .attempt-badge {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      flex-shrink: 0;
    }
    .attempt-trigger-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: rgba(128,128,128,0.12);
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
      white-space: nowrap;
    }
    .step-indicators {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .step-icon {
      font-size: 11px;
    }
    .step-icon.success { color: #4ec9b0; }
    .step-icon.failed { color: #f48771; }
    .step-icon.skipped { color: #858585; opacity: 0.5; }
    .step-icon.running { color: #3794ff; }
    .step-icon.pending { color: #858585; opacity: 0.3; }
    .attempt-time {
      white-space: nowrap;
    }
    .attempt-duration {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .attempt-chevron {
      font-size: 16px;
      font-weight: 300;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.2s ease;
      transform: rotate(0deg);
      flex-shrink: 0;
      line-height: 1;
    }
    .attempt-header[data-expanded="true"] .attempt-chevron {
      transform: rotate(90deg);
    }

    /* ── Expanded body ── */
    .attempt-body {
      padding: 0 14px 14px;
    }

    /* ── Sections inside body ── */
    .attempt-section {
      margin-top: 12px;
    }
    .attempt-running-indicator {
      color: var(--vscode-charts-blue, #3794ff);
      font-style: italic;
      font-size: 12px;
      padding: 8px 10px;
    }
    .attempt-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    /* Error section */
    .attempt-error-section { }
    .attempt-error-body {
      padding: 8px 10px;
      background: rgba(244, 135, 113, 0.08);
      border: 1px solid rgba(244, 135, 113, 0.25);
      border-radius: 4px;
    }
    .attempt-error-msg {
      font-size: 12px;
      color: #f48771;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
    }
    .attempt-error-detail {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    /* Context grid */
    .attempt-ctx-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .attempt-ctx-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 11px;
    }
    .attempt-ctx-label {
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      min-width: 60px;
      flex-shrink: 0;
    }
    .attempt-ctx-value {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Attempt metrics override */
    .attempt-section .attempt-metrics-card {
      margin: 0;
      border: none;
    }
    .attempt-section .metrics-stats-grid {
      gap: 6px;
    }
    
    /* Attempt phase tabs */
    .attempt-phase-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .attempt-phase-tab {
      padding: 4px 10px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .attempt-phase-tab:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .attempt-phase-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    .attempt-phase-tab.failed { color: #f48771; }
    .attempt-phase-tab.succeeded { color: #4ec9b0; }
    .attempt-phase-tab.skipped { opacity: 0.5; }
    .attempt-phase-tab-icon { margin-right: 4px; }

    /* Phase-specific accent colors (matching timeline) */
    .attempt-phase-tab[data-phase="merge-fi"] { border-left: 3px solid #2196F3; }
    .attempt-phase-tab[data-phase="setup"] { border-left: 3px solid #4CAF50; }
    .attempt-phase-tab[data-phase="prechecks"] { border-left: 3px solid #FF9800; }
    .attempt-phase-tab[data-phase="work"] { border-left: 3px solid #E91E63; }
    .attempt-phase-tab[data-phase="commit"] { border-left: 3px solid #9C27B0; }
    .attempt-phase-tab[data-phase="postchecks"] { border-left: 3px solid #FF5722; }
    .attempt-phase-tab[data-phase="merge-ri"] { border-left: 3px solid #00BCD4; }
    .attempt-phase-tab[data-phase="cleanup"] { border-left: 3px solid #607D8B; }
    .attempt-log-viewer {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      white-space: pre-wrap;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
    }
    .attempt-log-viewer.empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      text-align: center;
      padding: 20px;
    }
  `;
}

/**
 * AI metrics and usage statistics styles.
 */
function aiMetricsStyles(): string {
  return `
    /* AI Usage Metrics Card */
    .ai-metrics {
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .ai-metrics-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
    }
    .ai-metrics-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .ai-metrics-icon { font-size: 14px; }
    .ai-metrics-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }
    .ai-metric-item {
      text-align: center;
      padding: 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
    }
    .ai-metric-value {
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .ai-metric-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      text-transform: uppercase;
    }
    .ai-metrics-breakdown {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .ai-metrics-breakdown-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    
    /* Attempt-level metrics card (matches main metrics card style) */
    .attempt-metrics {
      padding: 10px;
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
    }
    .attempt-metrics-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    
    /* Phase breakdown */
    .phase-metrics {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .phase-metrics-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
    }
    .phase-metrics-label {
      font-weight: 600;
      min-width: 120px;
      white-space: nowrap;
    }
    .phase-metrics-stats {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
  `;
}

/**
 * Action button styles.
 */
function actionButtonStyles(): string {
  return `
    /* Actions */
    .actions {
      margin-top: 16px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  `;
}

/**
 * Work summary and commit details styles.
 */
function workSummaryStyles(): string {
  return `
    /* Work Summary */
    .work-summary {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .work-summary-item {
      padding: 10px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-summary-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .work-summary-content { font-size: 12px; }
    
    /* Aggregated Work Summary */
    .work-summary-stats {
      display: flex;
      justify-content: space-around;
      gap: 12px;
    }
    .work-stat {
      text-align: center;
      padding: 8px 16px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-stat-value { font-size: 18px; font-weight: 600; }
    .work-stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .work-stat.added .work-stat-value { color: #4ec9b0; }
    .work-stat.modified .work-stat-value { color: #3794ff; }
    .work-stat.deleted .work-stat-value { color: #f48771; }
    
    /* Commit Details */
    .commit-details {
      padding: 10px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .commit-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .commit-sha {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      margin-bottom: 6px;
    }
    .commit-sha:hover { text-decoration: underline; }
    .commit-message {
      font-size: 12px;
      color: var(--vscode-foreground);
      white-space: pre-wrap;
      padding: 6px;
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
    }
    .commit-stats {
      margin-top: 8px;
      display: flex;
      gap: 12px;
      font-size: 11px;
    }
    .commit-stat-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .commit-stat-value { font-weight: 600; }
    .commit-stat-item.added { color: #4ec9b0; }
    .commit-stat-item.modified { color: #3794ff; }
    .commit-stat-item.deleted { color: #f48771; }
  `;
}

/**
 * Markdown content rendering styles.
 */
function markdownStyles(): string {
  return `
    /* Markdown rendering styles */
    .markdown-content {
      font-size: 12px;
      line-height: 1.6;
      color: var(--vscode-foreground);
    }
    .markdown-content h1,
    .markdown-content h2,
    .markdown-content h3,
    .markdown-content h4 {
      margin: 16px 0 8px 0;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .markdown-content h1 { font-size: 18px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .markdown-content h2 { font-size: 16px; }
    .markdown-content h3 { font-size: 14px; }
    .markdown-content h4 { font-size: 13px; }
    .markdown-content p {
      margin: 0 0 8px 0;
    }
    .markdown-content ul,
    .markdown-content ol {
      margin: 0 0 8px 0;
      padding-left: 24px;
    }
    .markdown-content li {
      margin: 4px 0;
    }
    .markdown-content code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .markdown-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .markdown-content pre code {
      background: none;
      padding: 0;
    }
    .markdown-content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .markdown-content a:hover {
      text-decoration: underline;
    }
    .markdown-content blockquote {
      border-left: 3px solid var(--vscode-panel-border);
      padding-left: 12px;
      margin: 8px 0;
      color: var(--vscode-descriptionForeground);
    }
  `;
}

/**
 * Returns all node detail panel CSS styles.
 *
 * Combines all style sub-functions into a single CSS string.
 * Used by {@link NodeDetailPanel} for webview styling.
 *
 * @returns Complete CSS stylesheet for node detail panel
 */
export function renderNodeDetailStyles(): string {
  return [
    layoutStyles(),
    headerStyles(),
    statusBadgeStyles(),
    metaGridStyles(),
    configStyles(),
    logViewerStyles(),
    processTreeStyles(),
    dependencyStyles(),
    attemptHistoryStyles(),
    aiMetricsStyles(),
    actionButtonStyles(),
    workSummaryStyles(),
    markdownStyles(),
    bridgeStyles(),
  ].join('\n');
}

/**
 * Bridge styles — maps template class names to proper styling.
 * Covers classes used in HTML templates that don't have dedicated CSS rules.
 */
function bridgeStyles(): string {
  return `
    /* ── Error box ── */
    .error-box { padding: 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; margin-bottom: 12px; }
    .error-box .error-message { color: var(--vscode-errorForeground); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .error-box .error-message.crashed { color: #f48771; }
    .error-box .error-phase { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }

    /* ── Meta grid extras ── */
    .meta-item.full-width { grid-column: 1 / -1; }
    .session-id { cursor: pointer; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-textLink-foreground); }
    .session-id:hover { text-decoration: underline; }

    /* ── Log viewer extras ── */
    .phase-icon { margin-right: 4px; font-size: 11px; }
    .log-placeholder { color: var(--vscode-descriptionForeground); font-style: italic; text-align: center; padding: 20px; }
    .log-content { font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; line-height: 1.5; }

    /* ── Process tree extras ── */
    .process-loading { color: var(--vscode-descriptionForeground); font-style: italic; text-align: center; padding: 16px; }
    .process-node { display: flex; align-items: flex-start; padding: 4px 0; }
    .process-node-name { color: var(--vscode-foreground); font-weight: 500; }
    .process-node-pid { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .process-stat { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
    .agent-work-indicator { color: var(--vscode-progressBar-background); font-style: italic; padding: 8px; }

    /* ── Config display extras ── */
    .config-phases { display: flex; flex-direction: column; gap: 8px; }
    .config-phase { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
    .config-phase-body { padding: 10px; }
    .config-phase-body.collapsed { display: none; }
    .chevron { font-size: 10px; color: var(--vscode-descriptionForeground); margin-right: 4px; transition: transform 0.15s; }
    .phase-label { font-weight: 600; font-size: 12px; }
    .phase-type-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; background: rgba(128,128,128,0.15); color: var(--vscode-descriptionForeground); }
    .phase-type-badge.skipped { opacity: 0.5; }
    .config-item { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; }
    .config-label { font-weight: 600; color: var(--vscode-descriptionForeground); min-width: 80px; flex-shrink: 0; }
    .config-value { color: var(--vscode-foreground); word-break: break-word; }
    .config-hint { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 4px; }
    .spec-empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px; }
    .spec-content { padding: 8px 0; }
    .spec-content.spec-agent { }
    .spec-meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .spec-field { display: flex; gap: 8px; font-size: 11px; }
    .spec-label { font-weight: 600; color: var(--vscode-descriptionForeground); min-width: 60px; }
    .spec-value { color: var(--vscode-foreground); }
    .non-collapsible .chevron { visibility: hidden; }
    .failure-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: auto; }
    .failure-badge.no-heal { background: rgba(244,135,113,0.2); color: #f48771; }
    .failure-badge.resume { background: rgba(0,122,204,0.2); color: #3794ff; }
    .failure-message { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; padding: 6px 8px; background: rgba(128,128,128,0.06); border-radius: 3px; }

    /* ── Work spec code blocks ── */
    .work-code-block { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; margin: 4px 0; }
    .work-code-block.agent-block { border-left: 3px solid #9C27B0; }
    .work-code-header { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: rgba(128,128,128,0.08); border-bottom: 1px solid var(--vscode-panel-border); }
    .work-lang-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: rgba(128,128,128,0.2); color: var(--vscode-descriptionForeground); font-weight: 600; text-transform: uppercase; }
    .work-lang-badge.shell { background: rgba(76,175,80,0.2); color: #4CAF50; }
    .work-lang-badge.process { background: rgba(33,150,243,0.2); color: #2196F3; }
    .work-lang-badge.agent { background: rgba(156,39,176,0.2); color: #CE93D8; }
    .work-code { margin: 0; padding: 8px; font-size: 11px; background: var(--vscode-editor-background); overflow-x: auto; }
    .agent-model { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .work-instructions { padding: 8px; font-size: 12px; line-height: 1.5; }
    .work-content { padding: 8px; }
    .env-section { margin-top: 4px; font-size: 11px; }
    .env-section summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .env-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    .env-key { font-weight: 600; padding: 2px 8px 2px 0; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .env-val { padding: 2px 0; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; }

    /* ── Dependencies extras ── */
    .deps-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .dep-badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 4px; }

    /* ── Git info ── */
    .git-info-row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 12px; }
    .git-info-label { font-weight: 600; color: var(--vscode-descriptionForeground); min-width: 100px; flex-shrink: 0; }
    .git-info-value { color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); }
    .git-info-value.mono { font-family: var(--vscode-editor-font-family); font-size: 11px; }

    /* ── Metrics extras ── */
    .metrics-card { margin-bottom: 12px; }
    .metrics-stats-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .metrics-stat { font-size: 11px; padding: 4px 8px; background: var(--vscode-editor-background); border-radius: 4px; white-space: nowrap; }
    .phase-metrics-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 11px; }
    .phase-metrics-label { font-weight: 600; }
    .phase-metrics-stats { color: var(--vscode-descriptionForeground); }
    .phase-metrics-breakdown { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
    .attempt-metrics-card { padding: 8px; background: var(--vscode-editor-background); border-radius: 4px; }
    .model-breakdown { margin-top: 6px; }
    .model-breakdown-label { font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .model-breakdown-list { font-size: 11px; }
    .model-row { display: flex; justify-content: space-between; padding: 2px 0; }
    .model-name { font-weight: 500; }
    .model-tokens { color: var(--vscode-descriptionForeground); }
    .metric-item { font-size: 11px; margin-right: 12px; }

    /* ── Action buttons extras ── */
    .retry-section { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .retry-btn { padding: 5px 12px; border-radius: 3px; border: none; cursor: pointer; font-size: 11px; }
    .retry-btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .retry-btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* ── Status text colors ── */
    .status-succeeded { color: #4ec9b0; }
    .status-failed { color: #f48771; }
    .status-running { color: #3794ff; }
    .status-pending { color: #858585; }
    .status-canceled { color: #858585; }
    .status-blocked { color: #858585; opacity: 0.6; }

    /* ── Trigger badges ── */
    .trigger-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
    .trigger-badge.auto-heal { background: rgba(255,204,0,0.2); color: #cca700; }
    .trigger-badge.retry { background: rgba(0,122,204,0.2); color: #3794ff; }

    /* ── Work summary extras ── */
    .work-summary-section { margin-top: 12px; }
    .work-summary-section.aggregated { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; margin-top: 12px; }
    .aggregated-stats { opacity: 0.9; }
    .work-summary-desc { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 4px; }
    .work-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 8px; }
    .commits-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .commit-item { padding: 8px; background: var(--vscode-editor-background); border-radius: 4px; border: 1px solid var(--vscode-panel-border); }
    .commit-hash { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-textLink-foreground); }
    .commit-files { margin-top: 4px; font-size: 11px; }
    .file-item { padding: 2px 0; }
    .file-added { color: #4ec9b0; }
    .file-modified { color: #cca700; }
    .file-deleted { color: #f48771; }

    /* ── Attempt history container ── */
    .attempt-history-container { }

    /* ── Markdown extras ── */
    .md-code-block { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; font-family: var(--vscode-editor-font-family); font-size: 11px; overflow-x: auto; white-space: pre-wrap; margin: 8px 0; }
    .md-header { font-weight: 600; margin-top: 12px; margin-bottom: 4px; color: var(--vscode-foreground); }
    .md-list { margin: 4px 0; padding-left: 20px; }
    .md-para { margin: 4px 0; line-height: 1.5; }
    .md-inline-code { background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .md-link { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .md-link:hover { text-decoration: underline; }
  `;
}
