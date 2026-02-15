/**
 * @fileoverview Action buttons HTML template for node detail panel.
 *
 * Generates HTML for retry buttons, force-fail button, and bottom action bar.
 * Button visibility is conditioned on node status.
 *
 * @module ui/templates/nodeDetail/actionButtonsTemplate
 */

import { escapeHtml } from '../helpers';

/**
 * Input data for the action buttons template.
 */
export interface ActionButtonsData {
  /** Current node status */
  status: string;
  /** Plan ID */
  planId: string;
  /** Node ID */
  nodeId: string;
  /** Worktree path (if available) */
  worktreePath?: string;
  /** Whether the worktree has been cleaned up */
  worktreeCleanedUp?: boolean;
}

/**
 * Render retry buttons for failed nodes.
 *
 * Only renders when status is 'failed'. Shows a resume-session retry
 * and a fresh-session retry button.
 *
 * @param data - Action button input data.
 * @returns HTML fragment string, or empty string if not applicable.
 */
export function retryButtonsHtml(data: ActionButtonsData): string {
  if (data.status !== 'failed') return '';

  return `<div class="retry-section">
      <button class="retry-btn" data-action="retry-node" data-plan-id="${data.planId}" data-node-id="${data.nodeId}">
        🔄 Retry Node
      </button>
      <button class="retry-btn secondary" data-action="retry-node-fresh" data-plan-id="${data.planId}" data-node-id="${data.nodeId}">
        🆕 Retry (Fresh Session)
      </button>
    </div>`;
}

/**
 * Render the force-fail section for running nodes.
 *
 * Only renders when status is 'running'. Allows the user to force-fail
 * a stuck or crashed node so it can be retried.
 *
 * @param data - Action button input data.
 * @returns HTML fragment string, or empty string if not applicable.
 */
export function forceFailButtonHtml(data: ActionButtonsData): string {
  if (data.status !== 'running') return '';

  return `<div class="force-fail-section">
      <p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px;">
        If the process has crashed or is stuck, you can force fail this node to enable retry.
      </p>
      <button class="retry-btn secondary" data-action="force-fail-node" data-plan-id="${data.planId}" data-node-id="${data.nodeId}">
        ⚠️ Force Fail (Enable Retry)
      </button>
    </div>`;
}

/**
 * Render the bottom action bar with Open Worktree and Refresh buttons.
 *
 * @param data - Action button input data.
 * @returns HTML fragment string.
 */
export function bottomActionsHtml(data: ActionButtonsData): string {
  return `<div class="actions">
    ${data.worktreePath && !data.worktreeCleanedUp ? '<button class="action-btn" onclick="openWorktree()">Open Worktree</button>' : ''}
    <button class="action-btn" onclick="refresh()">Refresh</button>
  </div>`;
}
