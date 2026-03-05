/**
 * @fileoverview Release management panel CSS styles.
 *
 * Provides styles for the 5-step wizard interface including:
 * - Step indicator dots
 * - Plan selection checkboxes
 * - Merge progress bars
 * - PR monitoring dashboard
 * - Action log with color-coded entries
 * - Smooth CSS transitions and animations
 *
 * All styles use VS Code CSS custom properties for theme consistency.
 *
 * @module ui/templates/release/stylesTemplate
 */

/**
 * Renders complete CSS stylesheet for release management panel.
 *
 * @returns Complete CSS stylesheet as a string.
 */
export function renderReleaseStyles(): string {
  return [
    layoutStyles(),
    stepIndicatorStyles(),
    planSelectorStyles(),
    mergeProgressStyles(),
    prMonitorStyles(),
    actionLogStyles(),
    wizardNavigationStyles(),
    buttonStyles(),
  ].join('\n');
}

function layoutStyles(): string {
  return `
    body {
      font: 13px var(--vscode-font-family);
      padding: 0;
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      overflow-y: auto;
    }
    .release-container {
      padding: 16px;
      max-width: 1200px;
      margin: 0 auto;
    }
    .wizard-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-editor-background);
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 24px;
    }
    .wizard-header h2 {
      margin: 0 0 8px 0;
      font-size: 20px;
      font-weight: 600;
    }
    .wizard-content {
      min-height: 400px;
    }`;
}

function stepIndicatorStyles(): string {
  return `
    .step-indicator {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      margin: 20px 0;
      padding: 16px 0;
    }
    .step-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-input-border);
      transition: all 0.3s ease;
      position: relative;
    }
    .step-dot.active {
      width: 16px;
      height: 16px;
      background: var(--vscode-button-background);
      box-shadow: 0 0 8px var(--vscode-button-background);
    }
    .step-dot.completed {
      background: var(--vscode-testing-iconPassed);
    }
    .step-dot.failed {
      background: var(--vscode-testing-iconFailed);
    }
    .step-connector {
      width: 40px;
      height: 2px;
      background: var(--vscode-input-border);
      transition: background 0.3s ease;
    }
    .step-connector.completed {
      background: var(--vscode-testing-iconPassed);
    }
    .step-labels {
      display: flex;
      justify-content: center;
      gap: 52px;
      margin-top: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .step-label {
      text-align: center;
      min-width: 80px;
    }
    .step-label.active {
      color: var(--vscode-foreground);
      font-weight: 600;
    }`;
}

function planSelectorStyles(): string {
  return `
    .plan-selector {
      margin: 16px 0;
    }
    .plan-selector h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .plan-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .plan-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .plan-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .plan-item.selected {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .plan-checkbox {
      width: 16px;
      height: 16px;
      min-width: 16px;
    }
    .plan-info {
      flex: 1;
      min-width: 0;
    }
    .plan-name {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .plan-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .plan-status-badge {
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .plan-status-badge.succeeded {
      background: rgba(0, 128, 0, 0.2);
      color: var(--vscode-testing-iconPassed);
    }
    .plan-status-badge.running {
      background: rgba(0, 120, 212, 0.2);
      color: var(--vscode-button-background);
    }`;
}

function mergeProgressStyles(): string {
  return `
    .merge-progress {
      margin: 24px 0;
    }
    .merge-progress h3 {
      margin: 0 0 16px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .merge-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      margin-bottom: 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    .merge-status-icon {
      width: 20px;
      height: 20px;
      min-width: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .merge-status-icon.pending { color: var(--vscode-descriptionForeground); }
    .merge-status-icon.merging { color: var(--vscode-button-background); }
    .merge-status-icon.success { color: var(--vscode-testing-iconPassed); }
    .merge-status-icon.failed { color: var(--vscode-testing-iconFailed); }
    .merge-info {
      flex: 1;
      min-width: 0;
    }
    .merge-plan-name {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .merge-status-text {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .merge-progress-bar {
      height: 6px;
      background: var(--vscode-input-border);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 8px;
    }
    .merge-progress-fill {
      height: 100%;
      background: var(--vscode-button-background);
      transition: width 0.3s ease;
    }
    .merge-progress-fill.completed {
      background: var(--vscode-testing-iconPassed);
    }`;
}

function prMonitorStyles(): string {
  return `
    .pr-monitor {
      margin: 24px 0;
    }
    .pr-monitor h3 {
      margin: 0 0 16px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .pr-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      margin-bottom: 16px;
    }
    .pr-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-weight: 600;
    }
    .pr-link:hover {
      text-decoration: underline;
    }
    .pr-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .pr-stat-card {
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      text-align: center;
    }
    .pr-stat-value {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .pr-stat-value.passing { color: var(--vscode-testing-iconPassed); }
    .pr-stat-value.failing { color: var(--vscode-testing-iconFailed); }
    .pr-stat-value.pending { color: var(--vscode-button-background); }
    .pr-stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .pr-checks-list {
      margin-top: 16px;
    }
    .pr-check-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      margin-bottom: 4px;
      background: var(--vscode-input-background);
      border-left: 3px solid var(--vscode-input-border);
      border-radius: 0 4px 4px 0;
    }
    .pr-check-item.passing { border-left-color: var(--vscode-testing-iconPassed); }
    .pr-check-item.failing { border-left-color: var(--vscode-testing-iconFailed); }
    .pr-check-item.pending { border-left-color: var(--vscode-button-background); }
    .pr-cycle-timeline {
      margin-top: 24px;
    }
    .pr-cycle {
      padding: 12px;
      margin-bottom: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    .pr-cycle-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .pr-cycle-timestamp {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
    }`;
}

function actionLogStyles(): string {
  return `
    .action-log {
      margin: 24px 0;
    }
    .action-log h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .action-log-entries {
      max-height: 400px;
      overflow-y: auto;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      background: var(--vscode-input-background);
    }
    .action-entry {
      display: flex;
      gap: 12px;
      padding: 8px;
      margin-bottom: 8px;
      border-left: 3px solid var(--vscode-input-border);
      border-radius: 0 4px 4px 0;
      background: var(--vscode-editor-background);
    }
    .action-entry.fix-code { border-left-color: var(--vscode-testing-iconPassed); }
    .action-entry.fix-ci { border-left-color: var(--vscode-button-background); }
    .action-entry.resolve-conflict { border-left-color: var(--vscode-editorWarning-foreground); }
    .action-entry.resolve-alert { border-left-color: var(--vscode-testing-iconFailed); }
    .action-entry.respond-comment { border-left-color: var(--vscode-textLink-foreground); }
    .action-timestamp {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 80px;
    }
    .action-content {
      flex: 1;
    }
    .action-type {
      font-weight: 600;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .action-description {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .action-status {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      margin-left: 8px;
    }
    .action-status.success {
      background: rgba(0, 128, 0, 0.2);
      color: var(--vscode-testing-iconPassed);
    }
    .action-status.failed {
      background: rgba(255, 0, 0, 0.2);
      color: var(--vscode-testing-iconFailed);
    }`;
}

function wizardNavigationStyles(): string {
  return `
    .wizard-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .wizard-nav button {
      padding: 8px 16px;
      min-width: 100px;
    }`;
}

function buttonStyles(): string {
  return `
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
      font-family: var(--vscode-font-family);
      transition: background 0.2s ease;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.danger {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-errorForeground);
    }`;
}
