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
      padding: 8px; 
      margin: 0; 
      color: var(--vscode-foreground); 
    }
    .header { 
      display: flex; 
      gap: 8px; 
      margin-bottom: 12px; 
      align-items: center; 
    }
    .header h3 { margin: 0; }
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
  </style>`;
}
