/**
 * @fileoverview Plans view styles template.
 *
 * Generates the CSS styles for the plans sidebar webview.
 *
 * @module ui/templates/plansView/stylesTemplate
 */

/**
 * Render the CSS styles for the plans view.
 *
 * @returns CSS string wrapped in `<style>` tags.
 */
export function renderPlansViewStyles(): string {
  return `<style>
    body { 
      font: 12px var(--vscode-font-family); 
      padding: 0; 
      margin: 0; 
      color: var(--vscode-foreground); 
    }
    
    /* ── Header ─────────────────────────────────────────────── */
    .header { 
      display: flex; 
      gap: 8px; 
      padding: 10px 12px 6px;
      align-items: center; 
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .header h3 { 
      margin: 0; 
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }
    .pill { 
      padding: 1px 7px; 
      border-radius: 10px; 
      font-size: 11px; 
      font-weight: 600;
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
      min-width: 14px;
      text-align: center;
    }
    .pill.small {
      font-size: 10px;
      padding: 1px 5px;
    }
    
    /* ── Stats bar ──────────────────────────────────────────── */
    .global-stats {
      padding: 5px 12px;
      font-size: 11px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .stats-row {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .stat-item {
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--vscode-descriptionForeground);
    }
    .stat-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .stat-dot.running {
      background: var(--vscode-progressBar-background);
      animation: pulse-dot 2s ease-in-out infinite;
    }
    .stat-dot.queued {
      background: var(--vscode-editorWarning-foreground);
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    
    .global-capacity-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 12px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .capacity-label { font-weight: 600; }
    .capacity-instances { cursor: help; }
    .capacity-instances.multiple {
      color: var(--vscode-charts-yellow);
      font-weight: 600;
    }
    
    /* ── Plans list ─────────────────────────────────────────── */
    #plans {
      padding: 6px 8px;
    }
    
    .plan-item {
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      border-left: 3px solid transparent;
      min-width: 0;
      transition: background 0.1s ease;
    }
    .plan-item:hover,
    .plan-item:focus {
      background: var(--vscode-list-hoverBackground);
      outline: none;
    }
    .plan-item:focus {
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }
    .plan-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .plan-item.selected .plan-status { opacity: 1; }
    .plan-item.running { border-left-color: var(--vscode-progressBar-background); }
    .plan-item.succeeded { border-left-color: var(--vscode-testing-iconPassed); }
    .plan-item.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .plan-item.partial { border-left-color: var(--vscode-editorWarning-foreground); }
    .plan-item.canceled { border-left-color: var(--vscode-descriptionForeground); }
    .plan-item.scaffolding {
      border-left: 3px solid transparent;
      border-image: repeating-linear-gradient(
        -45deg,
        #f5c518 0px, #f5c518 3px,
        transparent 3px, transparent 6px
      ) 3;
    }
    
    .plan-name { 
      font-weight: 600; 
      margin-bottom: 3px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 12px;
    }
    .plan-name-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .plan-status {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 8px;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.3px;
      flex-shrink: 0;
      white-space: nowrap;
    }
      text-transform: uppercase;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .plan-status.running { background: rgba(0, 122, 204, 0.2); color: var(--vscode-progressBar-background); }
    .plan-status.succeeded { background: rgba(78, 201, 176, 0.2); color: var(--vscode-testing-iconPassed); }
    .plan-status.failed { background: rgba(244, 135, 113, 0.2); color: var(--vscode-testing-iconFailed); }
    .plan-status.partial { background: rgba(255, 204, 0, 0.2); color: var(--vscode-editorWarning-foreground); }
    .plan-status.pending { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    .plan-status.paused { background: rgba(255, 165, 0, 0.2); color: #ffa500; }
    .plan-status.pausing { background: rgba(255, 165, 0, 0.15); color: #cc8400; }
    .plan-status.resumed { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .plan-status.pending-start { background: rgba(158, 158, 158, 0.2); color: #9E9E9E; }
    .plan-status.canceled { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    .plan-status.scaffolding { background: rgba(245, 197, 24, 0.15); color: #f5c518; }
    
    .scaffolding { background: rgba(245, 197, 24, 0.08); border: 1px dashed rgba(245, 197, 24, 0.4); }
    
    .plan-details {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 10px;
      margin-top: 2px;
    }
    .plan-progress {
      height: 2px;
      background: rgba(128, 128, 128, 0.15);
      border-radius: 2px;
      margin-top: 5px;
      overflow: hidden;
    }
    .plan-progress-bar {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
      background: var(--vscode-progressBar-background);
    }
    .plan-progress-bar.succeeded { background: var(--vscode-testing-iconPassed); }
    .plan-progress-bar.failed { background: var(--vscode-testing-iconFailed); }
    
    /* ── Welcome / Empty state ──────────────────────────── */
    .welcome-state {
      padding: 32px 16px;
      text-align: center;
    }
    .welcome-icon {
      font-size: 28px;
      margin-bottom: 10px;
      opacity: 0.8;
    }
    .welcome-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--vscode-foreground);
    }
    .welcome-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
    .welcome-subtitle code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
    }
    .empty-section {
      padding: 12px 8px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }
    
    /* ── Section dividers & toggles ────────────────────── */
    .section-divider {
      display: flex;
      align-items: center;
      margin-top: 4px;
      padding: 0 4px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .collapse-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 6px 8px;
      flex: 1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    .collapse-toggle:hover {
      color: var(--vscode-foreground);
    }
    .collapse-toggle .codicon {
      font-size: 12px;
      transition: transform 0.2s;
    }
    .collapse-toggle[aria-expanded='true'] .codicon {
      transform: rotate(90deg);
    }
    .section-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      background: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
    }
    .section-action:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .managed-prs-content {
      padding: 4px 8px;
    }
    .archived-plans {
      padding: 4px 8px;
    }
    
    .plan-item.archived {
      opacity: 0.5;
    }
    .plan-item.archived .plan-name-text {
      font-style: italic;
    }
    .plan-status.archived {
      background: rgba(133, 133, 133, 0.15);
      color: var(--vscode-descriptionForeground);
    }
    .plan-item .archive-action {
      display: none;
      margin-left: auto;
      padding: 2px 6px;
      font-size: 10px;
      background: none;
      color: var(--vscode-descriptionForeground);
      border: none;
      cursor: pointer;
    }
    .plan-item:hover .archive-action {
      display: inline-block;
    }
    .plan-item .archive-action:hover {
      color: var(--vscode-foreground);
    }
    
    .bulk-actions {
      display: flex;
      flex-direction: column;
      padding: 8px 12px;
      margin: 4px 8px 6px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      gap: 8px;
      animation: slideDown 0.15s ease-out;
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .bulk-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .selection-count {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .bulk-dismiss {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 16px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      border-radius: 3px;
    }
    .bulk-dismiss:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }
    .bulk-buttons {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .bulk-btn {
      font-size: 11px;
      padding: 4px 10px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      transition: background 0.12s ease, opacity 0.12s ease;
      white-space: nowrap;
    }
    .bulk-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .bulk-btn.danger {
      color: var(--vscode-errorForeground);
    }
    .bulk-btn.danger:hover:not(:disabled) {
      background: rgba(244, 71, 71, 0.15);
    }
    .bulk-btn:disabled,
    .bulk-btn.hidden {
      display: none;
    }
    
    /* Context Menu */
    .context-menu {
      position: fixed;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      border-radius: 4px;
      padding: 4px 0;
      min-width: 160px;
      z-index: 9999;
      font-size: 12px;
    }
    .context-menu-item {
      padding: 6px 16px;
      cursor: pointer;
      color: var(--vscode-menu-foreground);
      transition: background 0.1s ease;
    }
    .context-menu-item:hover:not(.disabled) {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    .context-menu-item.danger {
      color: var(--vscode-errorForeground);
    }
    .context-menu-item.disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .context-menu-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground);
      margin: 4px 0;
    }

    /* \u2500\u2500 Managed PRs Section \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    
    /* PR Cards */
    .pr-item {
      padding: 6px 10px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground);
      transition: background 0.1s ease;
    }
    .pr-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .pr-item.adopted { border-left-color: var(--vscode-gitDecoration-addedResourceForeground); }
    .pr-item.monitoring { border-left-color: var(--vscode-progressBar-background); }
    .pr-item.addressing { border-left-color: var(--vscode-editorWarning-foreground); }
    .pr-item.ready { border-left-color: var(--vscode-testing-iconPassed); }
    .pr-item.blocked { border-left-color: var(--vscode-testing-iconFailed); }
    .pr-item.abandoned { border-left-color: var(--vscode-descriptionForeground); }
    
    .pr-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    .pr-number {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
    }
    .pr-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
    }
    .pr-status-badge {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 6px;
      text-transform: uppercase;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .pr-status-badge.adopted { background: rgba(78, 201, 176, 0.2); color: var(--vscode-gitDecoration-addedResourceForeground); }
    .pr-status-badge.monitoring { background: rgba(0, 122, 204, 0.2); color: var(--vscode-progressBar-background); }
    .pr-status-badge.addressing { background: rgba(255, 204, 0, 0.2); color: var(--vscode-editorWarning-foreground); }
    .pr-status-badge.ready { background: rgba(78, 201, 176, 0.2); color: var(--vscode-testing-iconPassed); }
    .pr-status-badge.blocked { background: rgba(244, 135, 113, 0.2); color: var(--vscode-testing-iconFailed); }
    .pr-status-badge.abandoned { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    
    .pr-draft-indicator {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 6px;
      background: rgba(158, 158, 158, 0.2);
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    
    .pr-branches {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .pr-branch {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 2px;
    }
    .pr-details {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      display: flex;
      gap: 8px;
    }
  </style>`;
}
