/**
 * @fileoverview Enhanced Work Summary Panel template.
 *
 * Generates a full HTML document for the work summary panel with:
 * - Header stats grid (commits, files added/modified/deleted)
 * - Collapsible per-job cards with duration, commit details, and clickable files
 * - Commit journey visualization showing DAG flow from base to target
 *
 * All functions are pure (no vscode imports) for testability.
 *
 * @module ui/templates/workSummaryPanel
 */

import { escapeHtml, formatDurationMs } from './helpers';

// ============================================================================
// DATA INTERFACES
// ============================================================================

/**
 * Commit data for the work summary panel.
 */
export interface WsPanelCommit {
  shortHash: string;
  message: string;
  date: string;
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
}

/**
 * Per-job data for the work summary panel.
 */
export interface WsPanelJob {
  nodeId: string;
  nodeName: string;
  description: string;
  durationMs?: number;
  commits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  commitDetails: WsPanelCommit[];
}

/**
 * Node in the commit journey visualization.
 */
export interface WsJourneyNode {
  nodeName: string;
  shortHash?: string;
  status: 'succeeded' | 'failed' | 'running' | 'pending' | 'blocked' | 'canceled';
  mergedToTarget?: boolean;
  isLeaf: boolean;
}

/**
 * Top-level data for the work summary panel.
 */
export interface WorkSummaryPanelData {
  planName: string;
  baseBranch: string;
  baseCommitShort?: string;
  targetBranch?: string;
  totalCommits: number;
  totalFilesAdded: number;
  totalFilesModified: number;
  totalFilesDeleted: number;
  jobs: WsPanelJob[];
  journeyNodes: WsJourneyNode[];
}

// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

/**
 * Render a single file item as a clickable link.
 */
function renderFileLink(path: string, status: 'added' | 'modified' | 'deleted'): string {
  const prefix = status === 'added' ? '+' : status === 'modified' ? '~' : '-';
  const cssClass = `file-${status}`;
  return `<a class="file-link ${cssClass}" href="#" onclick="openFile('${escapeHtml(path.replace(/'/g, "\\'"))}')">${prefix} ${escapeHtml(path)}</a>`;
}

/**
 * Render file lists for a commit, with a "show more" toggle when many files.
 */
function renderCommitFiles(commit: WsPanelCommit): string {
  const allFiles: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];
  for (const f of commit.filesAdded) { allFiles.push({ path: f, status: 'added' }); }
  for (const f of commit.filesModified) { allFiles.push({ path: f, status: 'modified' }); }
  for (const f of commit.filesDeleted) { allFiles.push({ path: f, status: 'deleted' }); }

  if (allFiles.length === 0) { return ''; }

  const INITIAL_SHOW = 5;
  const visible = allFiles.slice(0, INITIAL_SHOW);
  const hidden = allFiles.slice(INITIAL_SHOW);

  let html = '<div class="commit-files">';
  html += visible.map(f => renderFileLink(f.path, f.status)).join('\n');

  if (hidden.length > 0) {
    const moreId = `more-${escapeHtml(commit.shortHash)}-${Math.random().toString(36).slice(2, 8)}`;
    html += `<div id="${moreId}" class="files-hidden" style="display:none;">`;
    html += hidden.map(f => renderFileLink(f.path, f.status)).join('\n');
    html += '</div>';
    html += `<a class="show-more-link" href="#" onclick="toggleMore('${moreId}', this); return false;">... +${hidden.length} more</a>`;
  }

  html += '</div>';
  return html;
}

/**
 * Render a single commit as a collapsible section.
 */
function renderCommitDetail(commit: WsPanelCommit): string {
  const dateStr = commit.date ? new Date(commit.date).toLocaleString() : '';
  const totalFiles = commit.filesAdded.length + commit.filesModified.length + commit.filesDeleted.length;

  return `
      <details class="commit-detail">
        <summary class="commit-summary">
          <code class="commit-hash">${escapeHtml(commit.shortHash)}</code>
          <span class="commit-message">${escapeHtml(commit.message)}</span>
          <span class="commit-file-count">${totalFiles} file${totalFiles !== 1 ? 's' : ''}</span>
        </summary>
        <div class="commit-body">
          ${dateStr ? `<div class="commit-date">📅 ${escapeHtml(dateStr)}</div>` : ''}
          ${renderCommitFiles(commit)}
        </div>
      </details>`;
}

/**
 * Render a collapsible job card.
 */
function renderJobCard(job: WsPanelJob): string {
  const durationStr = job.durationMs !== null && job.durationMs !== undefined ? ` (${formatDurationMs(job.durationMs)})` : '';
  const commitsHtml = job.commitDetails.length > 0
    ? job.commitDetails.map(c => renderCommitDetail(c)).join('')
    : '<div class="no-commits">No commit details available</div>';

  return `
    <details class="job-card" open>
      <summary class="job-card-header">
        <span class="job-name">${escapeHtml(job.nodeName)}</span>
        <span class="job-meta">${durationStr}</span>
        <span class="job-stats">
          <span class="stat-commits">${job.commits} commit${job.commits !== 1 ? 's' : ''}</span>
          <span class="stat-added">+${job.filesAdded}</span>
          <span class="stat-modified">~${job.filesModified}</span>
          <span class="stat-deleted">-${job.filesDeleted}</span>
        </span>
      </summary>
      <div class="job-card-body">
        ${job.description ? `<div class="job-description">${escapeHtml(job.description)}</div>` : ''}
        <div class="job-commits">${commitsHtml}</div>
      </div>
    </details>`;
}

/**
 * Render the commit journey visualization.
 */
function renderJourney(data: WorkSummaryPanelData): string {
  if (data.journeyNodes.length === 0) { return ''; }

  const statusIcon = (s: string, merged?: boolean): string => {
    if (merged) { return '✅'; }
    switch (s) {
      case 'succeeded': return '✓';
      case 'failed': return '✗';
      case 'running': return '▶';
      case 'blocked': return '⊘';
      case 'canceled': return '⊘';
      default: return '○';
    }
  };

  const statusLabel = (s: string, merged?: boolean): string => {
    if (merged) { return 'merged'; }
    return s;
  };

  let html = '<div class="journey">';
  html += `<div class="journey-node journey-base">📍 Base: ${escapeHtml(data.baseBranch)}${data.baseCommitShort ? ` (<code>${escapeHtml(data.baseCommitShort)}</code>)` : ''}</div>`;
  html += '<div class="journey-line"></div>';

  for (let i = 0; i < data.journeyNodes.length; i++) {
    const node = data.journeyNodes[i];
    const isLast = i === data.journeyNodes.length - 1;
    const connector = isLast ? '└──' : '├──';
    const icon = statusIcon(node.status, node.mergedToTarget);
    const label = statusLabel(node.status, node.mergedToTarget);
    const hashPart = node.shortHash ? ` <code class="commit-hash">${escapeHtml(node.shortHash)}</code>` : '';

    html += `<div class="journey-node journey-step${isLast ? ' journey-last' : ''}">`;
    html += `<span class="journey-connector">${connector}</span> `;
    html += `<span class="journey-icon status-${escapeHtml(node.status)}">${icon}</span> `;
    html += `<span class="journey-name">${escapeHtml(node.nodeName)}</span>`;
    html += hashPart;
    html += ` <span class="journey-status">→ ${escapeHtml(label)}</span>`;
    html += '</div>';
  }

  if (data.targetBranch) {
    html += '<div class="journey-line"></div>';
    html += `<div class="journey-node journey-target">🎯 Target: ${escapeHtml(data.targetBranch)}</div>`;
  }

  html += '</div>';
  return html;
}

// ============================================================================
// MAIN PANEL RENDERER
// ============================================================================

/**
 * Render the full work summary panel HTML document.
 *
 * @param data - Panel data, or undefined if no work summary is available.
 * @returns Complete HTML document string.
 */
export function renderWorkSummaryPanelHtml(data: WorkSummaryPanelData | undefined | null): string {
  if (!data) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
</head><body style="padding:20px;color:var(--vscode-foreground);">
<p>No work summary available.</p></body></html>`;
  }

  const titleSuffix = data.targetBranch ? ` (Merged to ${escapeHtml(data.targetBranch)})` : '';
  const jobCardsHtml = data.jobs.map(j => renderJobCard(j)).join('');
  const journeyHtml = renderJourney(data);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.6;
    }
    h1 {
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
      margin-bottom: 24px;
    }

    /* Overview Stats Grid */
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .overview-stat {
      background: var(--vscode-sideBar-background);
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    .overview-stat .value {
      font-size: 28px;
      font-weight: bold;
      color: var(--vscode-foreground);
    }
    .overview-stat .label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .overview-stat.added .value { color: #4ec9b0; }
    .overview-stat.modified .value { color: #dcdcaa; }
    .overview-stat.deleted .value { color: #f48771; }

    /* Section headings */
    h2 {
      margin-top: 24px;
      margin-bottom: 16px;
      color: var(--vscode-foreground);
    }

    /* Collapsible Job Cards */
    .job-card {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      margin-bottom: 12px;
      border-left: 3px solid #4ec9b0;
      overflow: hidden;
    }
    .job-card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      cursor: pointer;
      font-size: 13px;
      list-style: none;
    }
    .job-card-header::-webkit-details-marker { display: none; }
    .job-card-header::before {
      content: '▶';
      font-size: 10px;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .job-card[open] > .job-card-header::before {
      transform: rotate(90deg);
    }
    .job-card-header .job-name {
      font-weight: 600;
      flex-shrink: 0;
    }
    .job-card-header .job-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .job-card-header .job-stats {
      margin-left: auto;
      display: flex;
      gap: 10px;
      font-size: 12px;
      flex-shrink: 0;
    }
    .stat-commits { color: var(--vscode-descriptionForeground); }
    .stat-added { color: #4ec9b0; }
    .stat-modified { color: #dcdcaa; }
    .stat-deleted { color: #f48771; }

    .job-card-body {
      padding: 0 16px 14px 32px;
    }
    .job-description {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      margin-bottom: 12px;
    }
    .no-commits {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
    }

    /* Collapsible Commit Details */
    .commit-detail {
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 0;
    }
    .commit-detail:last-child { border-bottom: none; }
    .commit-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      cursor: pointer;
      list-style: none;
      font-size: 13px;
    }
    .commit-summary::-webkit-details-marker { display: none; }
    .commit-summary::before {
      content: '▶';
      font-size: 9px;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .commit-detail[open] > .commit-summary::before {
      transform: rotate(90deg);
    }
    .commit-hash {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family), monospace;
      color: #dcdcaa;
    }
    .commit-message {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .commit-file-count {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      flex-shrink: 0;
    }
    .commit-body {
      padding: 4px 0 8px 20px;
    }
    .commit-date {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 8px;
    }

    /* File Links */
    .commit-files {
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 12px;
    }
    .file-link {
      display: block;
      padding: 3px 4px;
      text-decoration: none;
      border-radius: 3px;
      cursor: pointer;
    }
    .file-link:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-link.file-added { color: #4ec9b0; }
    .file-link.file-modified { color: #dcdcaa; }
    .file-link.file-deleted { color: #f48771; }
    .show-more-link {
      display: inline-block;
      color: var(--vscode-textLink-foreground);
      font-size: 11px;
      margin-top: 4px;
      cursor: pointer;
      text-decoration: none;
    }
    .show-more-link:hover {
      text-decoration: underline;
    }
    .files-hidden { /* toggled by JS */ }

    /* Journey Visualization */
    .journey {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 24px;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 13px;
    }
    .journey-node {
      padding: 4px 0;
    }
    .journey-line {
      border-left: 2px solid var(--vscode-panel-border);
      height: 12px;
      margin-left: 8px;
    }
    .journey-base, .journey-target {
      font-weight: 600;
    }
    .journey-connector {
      color: var(--vscode-panel-border);
    }
    .journey-icon {
      font-weight: bold;
    }
    .journey-icon.status-succeeded { color: #4ec9b0; }
    .journey-icon.status-failed { color: #f48771; }
    .journey-icon.status-running { color: #3794ff; }
    .journey-icon.status-pending { color: #858585; }
    .journey-icon.status-blocked { color: #858585; }
    .journey-icon.status-canceled { color: #858585; }
    .journey-name {
      font-family: var(--vscode-font-family);
    }
    .journey-status {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h1>📊 Work Summary: ${escapeHtml(data.planName)}${titleSuffix}</h1>

  <div class="overview-grid">
    <div class="overview-stat">
      <div class="value">${data.totalCommits}</div>
      <div class="label">Total Commits</div>
    </div>
    <div class="overview-stat added">
      <div class="value">+${data.totalFilesAdded}</div>
      <div class="label">Files Added</div>
    </div>
    <div class="overview-stat modified">
      <div class="value">~${data.totalFilesModified}</div>
      <div class="label">Files Modified</div>
    </div>
    <div class="overview-stat deleted">
      <div class="value">-${data.totalFilesDeleted}</div>
      <div class="label">Files Deleted</div>
    </div>
  </div>

  ${journeyHtml ? `<h2>Commit Journey</h2>\n  ${journeyHtml}` : ''}

  ${data.jobs.length > 0 ? `<h2>Job Details</h2>\n  ${jobCardsHtml}` : ''}

  <script>
    const vscode = acquireVsCodeApi();

    function openFile(path) {
      vscode.postMessage({ type: 'openFile', path: path });
    }

    function toggleMore(id, link) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.style.display === 'none') {
        el.style.display = '';
        link.textContent = '▲ show less';
      } else {
        el.style.display = 'none';
        var count = el.children.length;
        link.textContent = '... +' + count + ' more';
      }
    }
  </script>
</body>
</html>`;
}
