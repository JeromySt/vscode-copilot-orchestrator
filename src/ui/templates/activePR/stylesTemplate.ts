/**
 * @fileoverview Active PR panel styles template.
 *
 * Renders CSS styles for the active PR management panel.
 *
 * @module ui/templates/activePR/stylesTemplate
 */

/**
 * Renders CSS styles for the active PR panel.
 *
 * @returns CSS string.
 */
export function renderActivePRStyles(): string {
  return `
<style>
  body {
    padding: 0;
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }

  .active-pr-container {
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }

  /* PR Header Card */
  .pr-header-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 20px;
    margin-bottom: 20px;
  }

  .pr-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .pr-title-row h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .pr-status {
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .status-adopted {
    background: var(--vscode-statusBarItem-warningBackground);
    color: var(--vscode-statusBarItem-warningForeground);
  }

  .status-monitoring {
    background: var(--vscode-statusBarItem-prominentBackground);
    color: var(--vscode-statusBarItem-prominentForeground);
  }

  .status-addressing {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .status-ready {
    background: #28a745;
    color: white;
  }

  .status-blocked {
    background: var(--vscode-errorForeground);
    color: white;
  }

  .status-abandoned {
    background: var(--vscode-descriptionForeground);
    color: var(--vscode-editor-background);
  }

  .pr-meta {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  }

  .pr-branches {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .branch-badge {
    padding: 2px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family);
  }

  .arrow {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .provider-badge {
    padding: 2px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-radius: 3px;
    font-size: 11px;
    text-transform: uppercase;
  }

  .pr-links {
    margin-top: 8px;
  }

  .pr-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    font-size: 12px;
    cursor: pointer;
  }

  .pr-link:hover {
    text-decoration: underline;
  }

  .pr-error {
    margin-top: 12px;
    padding: 12px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 4px;
    color: var(--vscode-errorForeground);
    font-size: 12px;
  }

  /* Action Buttons */
  .action-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 20px;
  }

  .action-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .action-btn:hover {
    opacity: 0.8;
  }

  .action-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .action-btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .action-btn.warning {
    background: var(--vscode-statusBarItem-warningBackground);
    color: var(--vscode-statusBarItem-warningForeground);
  }

  .action-btn.danger {
    background: var(--vscode-statusBarItem-errorBackground);
    color: var(--vscode-statusBarItem-errorForeground);
  }

  /* Monitoring Section */
  .monitoring-section {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 20px;
    margin-bottom: 20px;
  }

  .monitoring-section h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
  }

  .monitoring-timer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: var(--vscode-badge-background);
    border-radius: 4px;
    margin-bottom: 16px;
  }

  .timer-label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .timer-value {
    font-size: 20px;
    font-weight: 600;
    color: var(--vscode-badge-foreground);
    font-family: var(--vscode-editor-font-family);
  }

  .monitoring-inactive {
    margin-bottom: 16px;
  }

  .pr-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .stat-card {
    padding: 16px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    text-align: center;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .stat-value.warning {
    color: var(--vscode-statusBarItem-warningForeground);
  }

  .stat-value.danger {
    color: var(--vscode-errorForeground);
  }

  .stat-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .timeline-section {
    margin-top: 16px;
  }

  .timeline-section h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    font-weight: 600;
  }

  .timeline-entries {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-sideBar-background);
  }

  /* Activity Log */
  .activity-log-section {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 20px;
  }

  .activity-log-section h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
  }

  .activity-entries {
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-sideBar-background);
  }

  .activity-entry {
    padding: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .activity-entry:last-child {
    border-bottom: none;
  }

  .activity-timestamp {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }

  .activity-message {
    font-size: 12px;
  }
</style>
`;
}
