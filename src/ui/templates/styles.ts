/**
 * @fileoverview Shared CSS styles for webview templates.
 *
 * Reusable CSS style strings used across multiple panel templates.
 * Uses VS Code CSS custom properties for theme consistency.
 *
 * @module ui/templates/styles
 */

/**
 * CSS class definitions for status badge elements.
 *
 * Provides `.status-badge` with status-specific modifiers
 * (`.running`, `.succeeded`, `.failed`, `.partial`, `.pending`, `.ready`,
 * `.blocked`, `.scheduled`) using semi-transparent backgrounds and
 * VS Code theme-aware colors.
 *
 * Used in {@link planDetailPanel}, {@link NodeDetailPanel}, and {@link plansViewProvider}.
 */
export const statusBadgeStyles = `
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
    .status-badge.pending, .status-badge.ready { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.blocked { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.scheduled { background: rgba(0, 122, 204, 0.15); color: #3794ff; }
`;

/**
 * CSS class definitions for action button elements.
 *
 * Provides `.action-btn` with `.primary`, `.secondary`, and `.danger` variants.
 * Uses VS Code button theme variables for consistent styling.
 *
 * Used in {@link planDetailPanel} and {@link NodeDetailPanel}.
 */
export const actionButtonStyles = `
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
    .action-btn.danger {
      background: #cc3333;
      color: white;
    }
    .action-btn.danger:hover {
      background: #aa2222;
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
`;

/**
 * CSS class definitions for work summary stat cards.
 *
 * Provides `.work-stat` container with `.work-stat-value` and `.work-stat-label`,
 * plus color-coded modifiers (`.added`, `.modified`, `.deleted`).
 *
 * Used in {@link planDetailPanel} and {@link NodeDetailPanel}.
 */
export const workSummaryStatStyles = `
    .work-stat {
      text-align: center;
      padding: 8px 16px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-stat-value {
      font-size: 18px;
      font-weight: 600;
    }
    .work-stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .work-stat.added .work-stat-value, .work-stat-value.added { color: #4ec9b0; }
    .work-stat.modified .work-stat-value, .work-stat-value.modified { color: #dcdcaa; }
    .work-stat.deleted .work-stat-value, .work-stat-value.deleted { color: #f48771; }
`;

/**
 * CSS class definitions for commit and file change list items.
 *
 * Provides `.commits-list`, `.commit-item`, `.commit-hash`, `.commit-message`,
 * `.commit-files`, and file status classes (`.file-added`, `.file-modified`,
 * `.file-deleted`).
 *
 * Used in {@link planDetailPanel} and {@link NodeDetailPanel} work summary sections.
 */
export const commitFileStyles = `
    .commits-list {
      margin-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 12px;
    }
    .commit-item {
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .commit-item:last-child {
      border-bottom: none;
    }
    .commit-hash {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: #dcdcaa;
    }
    .commit-message {
      margin-left: 8px;
      font-size: 13px;
    }
    .commit-files {
      margin-top: 8px;
      margin-left: 60px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .file-item {
      padding: 2px 0;
    }
    .file-added { color: #4ec9b0; }
    .file-modified { color: #dcdcaa; }
    .file-deleted { color: #f48771; }
`;
