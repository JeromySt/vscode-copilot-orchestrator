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
    prepChecklistStyles(),
    mergeProgressStyles(),
    prMonitorStyles(),
    pendingActionsStyles(),
    actionLogStyles(),
    floatingButtonStyles(),
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
      align-items: flex-start;
      margin: 20px 0;
      padding: 16px 0 0;
    }
    .step-column {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 80px;
      position: relative;
      padding-bottom: 12px;
      border-bottom: 3px solid transparent;
      transition: border-color 0.3s ease;
    }
    .step-column.active {
      border-bottom-color: var(--vscode-button-background);
    }
    .step-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-input-border);
      transition: all 0.3s ease;
      margin-bottom: 8px;
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
      margin-top: 5px;
      flex-shrink: 0;
    }
    .step-connector.completed {
      background: var(--vscode-testing-iconPassed);
    }
    .step-label {
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .step-label.active {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .step-label.completed {
      color: var(--vscode-testing-iconPassed);
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

function prepChecklistStyles(): string {
  return `
    .prep-checklist-container {
      max-width: 800px;
      margin: 0 auto;
    }
    .prep-header {
      margin-bottom: 20px;
    }
    .prep-header h3 {
      margin: 0 0 8px 0;
      font-size: 16px;
      font-weight: 600;
    }
    .prep-progress-summary {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .required-remaining {
      color: var(--vscode-editorWarning-foreground);
      font-weight: 600;
    }
    .prep-checklist {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }
    .prep-task {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      transition: all 0.3s ease;
    }
    .prep-task[data-status="completed"] {
      border-color: var(--vscode-testing-iconPassed);
      background: rgba(0, 128, 0, 0.05);
    }
    .prep-task[data-status="skipped"] {
      opacity: 0.6;
    }
    .prep-task[data-status="running"] {
      border-color: var(--vscode-button-background);
      animation: pulse-border 2s ease-in-out infinite;
    }
    @keyframes pulse-border {
      0%, 100% { border-color: var(--vscode-button-background); }
      50% { border-color: var(--vscode-focusBorder); }
    }
    .task-checkbox {
      width: 24px;
      height: 24px;
      min-width: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: bold;
      border: 2px solid var(--vscode-input-border);
      border-radius: 4px;
      background: transparent;
      transition: all 0.3s ease;
    }
    .task-checkbox.pending {
      border-color: var(--vscode-input-border);
    }
    .task-checkbox.completed {
      color: var(--vscode-testing-iconPassed);
      border-color: var(--vscode-testing-iconPassed);
      background: rgba(0, 128, 0, 0.1);
      animation: check-pop 0.3s ease;
    }
    .task-checkbox.skipped {
      color: var(--vscode-descriptionForeground);
      border-color: var(--vscode-descriptionForeground);
    }
    .task-checkbox.running {
      border-color: var(--vscode-button-background);
      animation: spin 1s linear infinite;
    }
    @keyframes check-pop {
      0% { transform: scale(0.5); }
      50% { transform: scale(1.2); }
      100% { transform: scale(1); }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .task-info {
      flex: 1;
      min-width: 0;
    }
    .task-title {
      font-weight: 600;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .required-badge {
      padding: 2px 6px;
      background: rgba(255, 165, 0, 0.2);
      color: var(--vscode-editorWarning-foreground);
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .task-description {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .task-error {
      font-size: 11px;
      color: var(--vscode-errorForeground);
      margin-top: 4px;
    }
    .task-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .task-actions button {
      padding: 4px 10px;
      font-size: 11px;
      min-width: 60px;
    }
    .log-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .log-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .task-log-area {
      margin: 8px 0 0 48px;
      padding: 12px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      max-height: 300px;
      overflow: auto;
    }
    .task-log-content {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      color: var(--vscode-editor-foreground);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .auto-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      position: relative;
    }
    .auto-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .skip-btn {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border);
    }
    .skip-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .manual-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .manual-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .prep-footer {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .prep-progress-bar {
      height: 8px;
      background: var(--vscode-input-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .prep-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--vscode-button-background), var(--vscode-testing-iconPassed));
      transition: width 0.5s ease;
    }
    .create-pr-btn {
      align-self: flex-end;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
    }
    
    /* Findings Section */
    .findings-badge {
      padding: 2px 6px;
      background: var(--vscode-editorWarning-background);
      color: var(--vscode-editorWarning-foreground);
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
    }
    .findings-section {
      margin: 8px 0 0 48px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    .findings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-input-border);
      margin-bottom: 8px;
    }
    .findings-count {
      font-weight: 600;
      font-size: 12px;
    }
    .findings-summary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .findings-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .finding-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      background: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-input-border);
      border-radius: 3px;
      transition: all 0.2s ease;
    }
    .finding-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .finding-item.error {
      border-left-color: var(--vscode-errorForeground);
    }
    .finding-item.warning {
      border-left-color: var(--vscode-editorWarning-foreground);
    }
    .finding-item.info {
      border-left-color: var(--vscode-button-background);
    }
    .finding-item.suggestion {
      border-left-color: var(--vscode-descriptionForeground);
    }
    .finding-item.acknowledged {
      border-left-color: var(--vscode-testing-iconPassed);
      opacity: 0.8;
    }
    .finding-item.dismissed {
      opacity: 0.4;
    }
    .finding-item.dismissed .finding-title {
      text-decoration: line-through;
    }
    .finding-item.fixed {
      border-left-color: var(--vscode-testing-iconPassed);
      background: rgba(0, 128, 0, 0.05);
    }
    .finding-severity-badge {
      font-size: 14px;
      min-width: 20px;
      text-align: center;
    }
    .finding-content {
      flex: 1;
      min-width: 0;
    }
    .finding-title {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .finding-description {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      line-height: 1.4;
    }
    .finding-location {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      font-family: var(--vscode-editor-font-family);
    }
    .finding-file-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .finding-file-link:hover {
      text-decoration: underline;
    }
    .finding-category {
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .finding-actions {
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .finding-item:hover .finding-actions {
      opacity: 1;
    }
    .finding-ack-btn,
    .finding-dismiss-btn {
      padding: 4px 8px;
      font-size: 12px;
      min-width: 30px;
      background: transparent;
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-foreground);
      cursor: pointer;
      border-radius: 3px;
      transition: all 0.2s ease;
    }
    .finding-ack-btn:hover {
      background: var(--vscode-testing-iconPassed);
      border-color: var(--vscode-testing-iconPassed);
      color: white;
    }
    .finding-dismiss-btn:hover {
      background: var(--vscode-errorForeground);
      border-color: var(--vscode-errorForeground);
      color: white;
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
    .pr-header-section {
      margin-bottom: 16px;
    }
    .pr-monitor h3 {
      margin: 0 0 12px 0;
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
    }
    .pr-number {
      font-weight: 600;
      font-size: 14px;
    }
    .pr-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-weight: 600;
      margin-left: auto;
    }
    .pr-link:hover {
      text-decoration: underline;
    }
    .monitoring-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    .monitoring-controls button.secondary {
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-family: var(--vscode-font-family);
    }
    .monitoring-controls button.secondary:hover {
      background: var(--vscode-input-border);
    }
    .monitor-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .monitor-status-badge.active {
      background: rgba(0, 128, 0, 0.15);
      color: var(--vscode-testing-iconPassed);
    }
    .monitor-status-badge.addressing {
      background: rgba(0, 122, 204, 0.15);
      color: var(--vscode-button-background);
    }
    .monitor-status-badge.idle {
      background: rgba(128, 128, 128, 0.15);
      color: var(--vscode-descriptionForeground);
    }
    .monitoring-pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      animation: pulse-glow 2s ease-in-out infinite;
    }
    @keyframes pulse-glow {
      0%, 100% { opacity: 1; box-shadow: 0 0 4px var(--vscode-testing-iconPassed); }
      50% { opacity: 0.4; box-shadow: none; }
    }
    .monitor-timer-bar {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .monitor-timer-label {
      font-weight: 500;
    }
    .monitor-countdown {
      font-size: 14px;
      font-weight: 700;
      color: var(--vscode-button-background);
      font-variant-numeric: tabular-nums;
      min-width: 36px;
    }
    .monitor-poll-info {
      font-size: 10px;
      opacity: 0.7;
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
    .pr-check-item.skipped { border-left-color: var(--vscode-descriptionForeground); opacity: 0.7; }
    .pr-check-icon {
      font-size: 14px;
      min-width: 18px;
    }
    .pr-check-name {
      flex: 1;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pr-check-status-label {
      font-size: 10px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      min-width: 50px;
      text-align: right;
    }
    .pr-check-url {
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      margin-left: 4px;
    }
    .pr-check-url:hover {
      text-decoration: underline;
    }
    .pr-cycle-timeline {
      margin: 24px 0 16px 0;
    }
    .pr-cycle-timeline h4 {
      margin: 0 0 12px 0;
      font-size: 13px;
      font-weight: 600;
    }
    .cycle-dots {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      overflow-x: auto;
    }
    .cycle-dot {
      width: 12px;
      height: 12px;
      min-width: 12px;
      border-radius: 50%;
      background: var(--vscode-input-border);
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .cycle-dot.active {
      width: 16px;
      height: 16px;
      background: var(--vscode-button-background);
    }
    .cycle-dot.success {
      background: var(--vscode-testing-iconPassed);
    }
    .cycle-dot.partial {
      background: var(--vscode-editorWarning-foreground);
    }
    .cycle-dot:hover {
      transform: scale(1.2);
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

function pendingActionsStyles(): string {
  return `
    .pending-actions-section {
      margin: 24px 0 16px 0;
    }
    .pending-actions-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .pending-actions-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    .pending-actions-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pending-selected-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .pending-select-all-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-foreground);
      cursor: pointer;
      user-select: none;
    }
    .pending-select-all-label input {
      cursor: pointer;
      accent-color: var(--vscode-button-background);
    }
    .pending-action-btn {
      padding: 4px 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .pending-action-btn.ai {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .pending-action-btn.ai:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .pending-action-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .pending-action-icon {
      font-size: 13px;
    }
    .pending-actions-filters {
      display: flex;
      gap: 4px;
      margin-bottom: 10px;
    }
    .pending-filter {
      padding: 3px 10px;
      border: 1px solid var(--vscode-input-border);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-radius: 12px;
      cursor: pointer;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      transition: all 0.15s ease;
    }
    .pending-filter.active {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-color: var(--vscode-badge-background);
    }
    .pending-filter:hover:not(.active) {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .pending-actions-list {
      max-height: 500px;
      overflow-y: auto;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
    }
    .review-group {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .review-group-resolved {
      opacity: 0.6;
    }
    .review-group-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 12px;
    }
    .review-group-icon {
      font-size: 14px;
    }
    .review-group-author {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .review-group-label {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .review-group-progress {
      margin-left: auto;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .review-group-body {
      padding: 6px 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-input-border);
      line-height: 1.4;
    }
    .review-group-children {
      margin-left: 20px;
      border-left: 3px solid var(--vscode-panel-border);
    }
    .review-group-children .pending-action-item {
      padding-left: 16px;
    }
    .pending-action-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-input-border);
      transition: background 0.1s ease;
      cursor: default;
    }
    .pending-action-item:last-child {
      border-bottom: none;
    }
    .pending-action-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .pending-action-item.resolved {
      opacity: 0.5;
    }
    .pending-action-checkbox {
      margin-top: 2px;
      cursor: pointer;
      accent-color: var(--vscode-button-background);
    }
    .pending-action-body {
      flex: 1;
      min-width: 0;
    }
    .pending-action-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .pending-action-type-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .pending-action-type-badge.comment {
      background: rgba(0, 120, 212, 0.15);
      color: var(--vscode-textLink-foreground);
    }
    .pending-action-type-badge.check {
      background: rgba(255, 0, 0, 0.12);
      color: var(--vscode-testing-iconFailed);
    }
    .pending-action-type-badge.alert {
      background: rgba(255, 165, 0, 0.15);
      color: var(--vscode-editorWarning-foreground);
    }
    .pending-action-author {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .pending-action-source {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .pending-action-text {
      font-size: 12px;
      color: var(--vscode-foreground);
      line-height: 1.5;
      margin-bottom: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .thread-replies {
      margin: 4px 0 6px 8px;
      padding-left: 8px;
      border-left: 2px solid var(--vscode-panel-border);
    }
    .thread-reply {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
      padding: 2px 0;
      display: flex;
      align-items: baseline;
      gap: 4px;
    }
    .reply-connector {
      color: var(--vscode-panel-border);
      font-family: monospace;
      font-size: 10px;
      flex-shrink: 0;
    }
    .reply-author {
      font-weight: 600;
      color: var(--vscode-foreground);
      white-space: nowrap;
      font-size: 11px;
    }
    .reply-body {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .pending-action-location {
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      text-decoration: none;
    }
    .pending-action-location:hover {
      text-decoration: underline;
    }
    .pending-action-location .codicon {
      font-size: 12px;
    }
    .pending-action-severity {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
    }
    .pending-action-severity.critical {
      background: rgba(255, 0, 0, 0.2);
      color: var(--vscode-testing-iconFailed);
    }
    .pending-action-severity.high {
      background: rgba(255, 80, 0, 0.2);
      color: var(--vscode-testing-iconFailed);
    }
    .pending-action-severity.medium {
      background: rgba(255, 165, 0, 0.15);
      color: var(--vscode-editorWarning-foreground);
    }
    .pending-action-severity.low {
      background: rgba(0, 128, 0, 0.15);
      color: var(--vscode-testing-iconPassed);
    }
    /* AI status badges on pending action items */
    .pending-action-ai-status {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
      margin-left: auto;
    }
    .pending-action-ai-status.queued {
      background: rgba(0, 120, 212, 0.15);
      color: var(--vscode-button-background);
    }
    .pending-action-ai-status.processing {
      background: rgba(0, 120, 212, 0.2);
      color: var(--vscode-button-background);
    }
    .pending-action-ai-status.fixed {
      background: rgba(0, 128, 0, 0.15);
      color: var(--vscode-testing-iconPassed);
    }
    .pending-action-ai-status.failed {
      background: rgba(255, 0, 0, 0.12);
      color: var(--vscode-testing-iconFailed);
    }
    .pending-action-item.processing {
      border-left: 3px solid var(--vscode-button-background);
      background: rgba(0, 120, 212, 0.04);
    }
    .pending-action-item.resolved {
      border-left-color: var(--vscode-testing-iconPassed);
    }
    /* AI spinner */
    .ai-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid var(--vscode-button-background);
      border-top-color: transparent;
      border-radius: 50%;
      animation: ai-spin 0.8s linear infinite;
    }
    @keyframes ai-spin {
      to { transform: rotate(360deg); }
    }
    /* AI Working Banner */
    .ai-working-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      margin-bottom: 8px;
      background: rgba(0, 120, 212, 0.08);
      border: 1px solid rgba(0, 120, 212, 0.3);
      border-radius: 4px;
      font-size: 12px;
      color: var(--vscode-button-background);
      font-weight: 500;
    }
    .ai-banner-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-button-background);
      border-top-color: transparent;
      border-radius: 50%;
      animation: ai-spin 0.8s linear infinite;
    }`;
}

function floatingButtonStyles(): string {
  return `
    .floating-add-plans {
      position: fixed;
      bottom: 80px;
      right: 24px;
      padding: 12px 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 24px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      font-family: var(--vscode-font-family);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      transition: all 0.2s ease;
      z-index: 1000;
    }
    .floating-add-plans:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
    }
    .floating-add-plans:active {
      transform: translateY(0);
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
      gap: 10px;
      padding: 10px 12px;
      margin-bottom: 6px;
      border-left: 3px solid var(--vscode-input-border);
      border-radius: 0 4px 4px 0;
      background: var(--vscode-editor-background);
      transition: border-left-color 0.2s ease;
    }
    .action-entry.success { border-left-color: var(--vscode-testing-iconPassed); }
    .action-entry.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .action-entry.fix-code.success { border-left-color: var(--vscode-testing-iconPassed); }
    .action-entry.fix-code.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .action-entry.respond-comment { border-left-color: var(--vscode-textLink-foreground); }
    .action-icon {
      font-size: 16px;
      min-width: 20px;
      text-align: center;
      line-height: 1.4;
    }
    .action-timestamp {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    .action-content {
      flex: 1;
    }
    .action-type {
      font-size: 12px;
      line-height: 1.4;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .action-status {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
    }
    .action-status.success {
      background: rgba(0, 128, 0, 0.15);
      color: var(--vscode-testing-iconPassed);
    }
    .action-status.failed {
      background: rgba(255, 0, 0, 0.12);
      color: var(--vscode-testing-iconFailed);
    }
    .action-commit {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-descriptionForeground);
    }
    .action-entry.clickable {
      cursor: pointer;
    }
    .action-entry.clickable:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .action-console-link {
      font-size: 10px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      white-space: nowrap;
    }
    .action-console-link:hover {
      text-decoration: underline;
    }
    .action-comment-link {
      font-size: 10px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
    }
    .action-comment-link:hover {
      text-decoration: underline;
    }
    .action-plan-link, .finding-job-link {
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
      padding: 2px 8px;
      border: 1px solid var(--vscode-textLink-foreground);
      border-radius: 3px;
      display: inline-block;
      margin-left: 4px;
    }
    .action-plan-link:hover, .finding-job-link:hover {
      text-decoration: none;
      background: var(--vscode-textLink-foreground);
      color: var(--vscode-editor-background);
    }
    .md-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .md-link:hover {
      text-decoration: underline;
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
