/**
 * @fileoverview Work summary HTML template.
 *
 * Generates HTML for displaying commit and file change statistics.
 * Used in both planDetailPanel and nodeDetailPanel.
 *
 * @module ui/templates/workSummary
 */

import { escapeHtml } from './helpers';

/**
 * Data shape for a single commit item in a work summary display.
 *
 * @see {@link commitDetailsHtml}
 */
export interface CommitItemData {
  shortHash: string;
  message: string;
  filesAdded?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
}

/**
 * Render a list of commits as an HTML fragment with per-commit file changes.
 *
 * Each commit shows its short hash, message, and optional lists of added,
 * modified, and deleted files. All user-supplied text is HTML-escaped.
 *
 * @param commits - Array of commit items to render.
 * @returns An HTML fragment string wrapped in a `.commits-list` container,
 *   or an empty string if the array is empty or undefined.
 *
 * @example
 * ```ts
 * const html = commitDetailsHtml([
 *   { shortHash: 'abc1234', message: 'Add feature', filesAdded: ['src/feature.ts'] }
 * ]);
 * ```
 */
export function commitDetailsHtml(commits: CommitItemData[]): string {
  if (!commits || commits.length === 0) {return '';}

  const items = commits.map(commit => {
    let filesHtml = '';
    if (commit.filesAdded?.length) {
      filesHtml += commit.filesAdded.map(f => `<div class="file-item file-added">+${escapeHtml(f)}</div>`).join('');
    }
    if (commit.filesModified?.length) {
      filesHtml += commit.filesModified.map(f => `<div class="file-item file-modified">~${escapeHtml(f)}</div>`).join('');
    }
    if (commit.filesDeleted?.length) {
      filesHtml += commit.filesDeleted.map(f => `<div class="file-item file-deleted">-${escapeHtml(f)}</div>`).join('');
    }

    return `
              <div class="commit-item">
                <code class="commit-hash">${escapeHtml(commit.shortHash)}</code>
                <span class="commit-message">${escapeHtml(commit.message)}</span>
                ${filesHtml ? `<div class="commit-files">${filesHtml}</div>` : ''}
              </div>`;
  }).join('');

  return `<div class="commits-list">${items}</div>`;
}

/**
 * Render a work summary statistics grid as an HTML fragment.
 *
 * Displays four stat cards: total commits, files added, files modified,
 * and files deleted, each with a color-coded value and label.
 *
 * @param stats - An object containing the aggregate counts.
 * @param stats.commits - Total number of commits.
 * @param stats.filesAdded - Number of files added.
 * @param stats.filesModified - Number of files modified.
 * @param stats.filesDeleted - Number of files deleted.
 * @returns An HTML fragment string containing `.work-stat` elements
 *   (not wrapped in a container — the caller provides the grid wrapper).
 */
export function workSummaryStatsHtml(stats: {
  commits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
}): string {
  return `
        <div class="work-stat">
          <div class="work-stat-value">${stats.commits}</div>
          <div class="work-stat-label">Commits</div>
        </div>
        <div class="work-stat added">
          <div class="work-stat-value">+${stats.filesAdded}</div>
          <div class="work-stat-label">Added</div>
        </div>
        <div class="work-stat modified">
          <div class="work-stat-value">~${stats.filesModified}</div>
          <div class="work-stat-label">Modified</div>
        </div>
        <div class="work-stat deleted">
          <div class="work-stat-value">-${stats.filesDeleted}</div>
          <div class="work-stat-label">Deleted</div>
        </div>`;
}
