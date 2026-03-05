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
    
    /* Tab Bar */
    .sidebar-tabs {
      display: flex;
      gap: 0;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 4px 8px 0;
    }
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
      opacity: 0.7;
    }
    .tab:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }
    .tab.active {
      opacity: 1;
      border-bottom-color: var(--vscode-focusBorder);
      background: var(--vscode-editor-background);
    }
    .tab-badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-weight: 600;
    }
    
    /* Tab Content */
    .tab-content {
      display: none;
      padding: 8px;
    }
    .tab-content.active {
      display: block;
    }
    
    .header { 
      display: flex; 
      gap: 8px; 
      margin-bottom: 12px; 
      align-items: center; 
      justify-content: flex-end;
    }
    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .action-button {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      white-space: nowrap;
    }
    .action-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .action-button .codicon {
      font-size: 14px;
    }
    .pill { 
      padding: 2px 8px; 
      border-radius: 10px; 
      font-size: 11px; 
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
    }
    .plan-item {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      border-left: 3px solid transparent;
      min-width: 180px;
    }
    .plan-item:hover,
    .plan-item:focus {
      background: var(--vscode-list-activeSelectionBackground);
      outline: none;
    }
    .plan-item:focus {
      box-shadow: 0 0 0 2px var(--vscode-focusBorder) inset;
      border-left-width: 4px;
    }
    .plan-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    .plan-item.selected .plan-status { 
      opacity: 1;
    }
    .plan-item.running { border-left-color: var(--vscode-progressBar-background); }
    .plan-item.succeeded { border-left-color: var(--vscode-testing-iconPassed); }
    .plan-item.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .plan-item.partial { border-left-color: var(--vscode-editorWarning-foreground); }
    .plan-item.canceled { border-left-color: var(--vscode-descriptionForeground); }
    .plan-item.scaffolding {
      border-left: 4px solid transparent;
      border-image: repeating-linear-gradient(
        -45deg,
        #f5c518 0px, #f5c518 4px,
        #1a1a1a 4px, #1a1a1a 8px
      ) 4;
    }
    
    .plan-name { 
      font-weight: 600; 
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .plan-name-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .plan-status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
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
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
    .plan-progress {
      height: 3px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 2px;
      margin-top: 6px;
    }
    .plan-progress-bar {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .plan-progress-bar.succeeded { background: var(--vscode-testing-iconPassed); }
    .plan-progress-bar.failed { background: var(--vscode-testing-iconFailed); }
    
    .empty { 
      padding: 20px; 
      text-align: center; 
      opacity: 0.6; 
    }
    .empty code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      font-size: 10px;
      padding: 2px 6px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .global-capacity-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      margin-bottom: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
    }
    .capacity-label {
      font-weight: 600;
    }
    .capacity-jobs {
      color: var(--vscode-foreground);
    }
    .capacity-instances {
      color: var(--vscode-descriptionForeground);
      cursor: help;
    }
    .capacity-instances.multiple {
      color: var(--vscode-charts-yellow);
      font-weight: 600;
    }
    
    .section-divider {
      margin: 16px 0 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    
    .collapse-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px 8px;
      width: 100%;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    
    .collapse-toggle:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .collapse-toggle .codicon {
      transition: transform 0.2s;
    }
    
    .collapse-toggle[aria-expanded='true'] .codicon {
      transform: rotate(90deg);
    }
    
    .archived-plans {
      margin-top: 8px;
    }
    
    .plan-item.archived {
      opacity: 0.6;
      filter: grayscale(20%);
    }
    
    .plan-item.archived .plan-name {
      font-style: italic;
    }
    
    .plan-status.archived {
      background: rgba(133, 133, 133, 0.15);
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    
    .plan-item .archive-action {
      display: none;
      margin-left: auto;
      padding: 2px 6px;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    
    .plan-item:hover .archive-action {
      display: inline-block;
    }
    
    .plan-item .archive-action:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    /* Bulk Actions Toolbar */
    .bulk-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      gap: 8px;
      animation: slideDown 0.2s ease-out;
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .selection-count {
      font-weight: 600;
      font-size: 11px;
      color: var(--vscode-foreground);
      flex-shrink: 0;
    }
    .bulk-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .bulk-btn {
      font-size: 10px;
      padding: 3px 8px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      transition: background 0.15s ease;
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
    .bulk-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
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

    /* Managed PRs Section */
    .section {
      margin-bottom: 16px;
    }
    .section-header {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      cursor: pointer;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      user-select: none;
    }
    .section-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 12px;
    }
    .section-chevron {
      transition: transform 0.2s ease;
      font-size: 14px;
    }
    .section-chevron.collapsed {
      transform: rotate(-90deg);
    }
    .section-content {
      margin-top: 8px;
      max-height: 1000px;
      overflow: hidden;
      transition: max-height 0.3s ease, opacity 0.2s ease;
      opacity: 1;
    }
    .section-content.collapsed {
      max-height: 0;
      opacity: 0;
    }
    
    /* PR Cards */
    .pr-item {
      padding: 8px;
      margin-bottom: 6px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground);
    }
    .pr-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
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
