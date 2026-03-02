/**
 * @fileoverview CSS styles for the view tab bar component.
 *
 * @module ui/templates/planDetail/tabBarStyles
 */

export function renderTabBarStyles(): string {
  return `
    .view-tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin: 8px 0 0 0;
      padding: 0 8px;
    }
    .view-tab {
      padding: 8px 20px;
      border: none;
      background: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .view-tab:hover {
      color: var(--vscode-foreground);
    }
    .view-tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tab-icon {
      margin-right: 4px;
    }
  `;
}
