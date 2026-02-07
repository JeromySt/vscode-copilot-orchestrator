/**
 * @fileoverview UI Templates module exports.
 * 
 * Centralized exports for all webview HTML templates used in the extension.
 * 
 * @module ui/templates
 */

export { escapeHtml, formatDuration, formatDurationMs, errorPageHtml, loadingPageHtml } from './helpers';
export { statusBadgeStyles, actionButtonStyles, workSummaryStatStyles, commitFileStyles } from './styles';
export { commitDetailsHtml, workSummaryStatsHtml } from './workSummary';
export type { CommitItemData } from './workSummary';
