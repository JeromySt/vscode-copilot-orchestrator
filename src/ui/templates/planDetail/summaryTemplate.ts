/**
 * @fileoverview Plan detail summary template.
 *
 * Renders the work summary section and the AI usage metrics bar
 * for the plan detail view.
 *
 * @module ui/templates/planDetail/summaryTemplate
 */

import { escapeHtml } from '../helpers';
import { formatTokenCount } from '../../../plan/metricsAggregator';

/**
 * Job summary data for work summary rendering.
 */
export interface JobSummaryItem {
  nodeId: string;
  nodeName: string;
  commits: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  description: string;
}

/**
 * Input data for the work summary section.
 */
export interface PlanSummaryData {
  /** Total commits across all jobs */
  totalCommits: number;
  /** Total files added */
  totalFilesAdded: number;
  /** Total files modified */
  totalFilesModified: number;
  /** Total files deleted */
  totalFilesDeleted: number;
  /** Per-job work summary items */
  jobSummaries: JobSummaryItem[];
  /** Target branch name (for title suffix) */
  targetBranch?: string;
}

/**
 * Model breakdown item for metrics bar.
 */
export interface ModelBreakdownItem {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  premiumRequests?: number;
}

/**
 * Input data for the metrics bar section.
 */
export interface PlanMetricsBarData {
  /** Formatted premium requests string */
  premiumRequests?: string;
  /** Formatted API time string */
  apiTime?: string;
  /** Formatted session time string */
  sessionTime?: string;
  /** Formatted code changes string */
  codeChanges?: string;
  /** Model breakdown items */
  modelBreakdown?: ModelBreakdownItem[];
}



/**
 * Render the work summary section HTML fragment.
 *
 * Displays an aggregate stats grid (commits, files added/modified/deleted)
 * and optional per-job summary rows.
 *
 * @param data - Summary input data, or undefined/null if no work has been done.
 * @returns HTML fragment string, or empty string if no data.
 */
export function renderPlanSummary(data: PlanSummaryData | undefined | null): string {
  if (!data) { return ''; }

  const { totalCommits, totalFilesAdded, totalFilesModified, totalFilesDeleted, jobSummaries, targetBranch } = data;

  if (totalCommits === 0 && totalFilesAdded === 0 && totalFilesModified === 0 && totalFilesDeleted === 0) {
    return '';
  }

  const jobSummariesHtml = jobSummaries.map(j => `
      <div class="job-summary" data-node-id="${j.nodeId}">
        <span class="job-name">${escapeHtml(j.nodeName)}</span>
        <span class="job-stats">
          <span class="stat-commits">${j.commits} commits</span>
          <span class="stat-added">+${j.filesAdded}</span>
          <span class="stat-modified">~${j.filesModified}</span>
          <span class="stat-deleted">-${j.filesDeleted}</span>
        </span>
      </div>
    `).join('');

  const titleSuffix = targetBranch ? ` (Merged to ${escapeHtml(targetBranch)})` : '';

  return `
    <div class="work-summary">
      <h3>Work Summary${titleSuffix}</h3>
      <div class="work-summary-grid work-summary-clickable" onclick="if(typeof showWorkSummary==='function')showWorkSummary()" title="Click to open full Work Summary">
        <div class="work-stat">
          <div class="work-stat-value">${totalCommits}</div>
          <div class="work-stat-label">Commits</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value added">+${totalFilesAdded}</div>
          <div class="work-stat-label">Files Added</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value modified">~${totalFilesModified}</div>
          <div class="work-stat-label">Modified</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value deleted">-${totalFilesDeleted}</div>
          <div class="work-stat-label">Deleted</div>
        </div>
      </div>
      ${jobSummaries.length > 0 ? `
      <div class="job-summaries">
        ${jobSummariesHtml}
      </div>
      ` : ''}
    </div>
    `;
}

/**
 * Render the AI usage metrics bar HTML fragment.
 *
 * Displays premium requests, API time, session time, code changes,
 * and optional per-model token breakdown.
 *
 * @param data - Metrics bar input data, or undefined/null if no metrics.
 * @returns HTML fragment string (hidden div if no data).
 */
export function renderMetricsBar(data: PlanMetricsBarData | undefined | null): string {
  if (!data) {
    return '<div class="plan-metrics-bar" id="planMetricsBar" style="display:none;"></div>';
  }

  const parts: string[] = [];
  if (data.premiumRequests !== undefined) {
    parts.push(`<span class="metric-item">🎫 <span class="metric-value">${escapeHtml(data.premiumRequests)}</span></span>`);
  }
  if (data.apiTime !== undefined) {
    parts.push(`<span class="metric-item">⏱ API: <span class="metric-value">${escapeHtml(data.apiTime)}</span></span>`);
  }
  if (data.sessionTime !== undefined) {
    parts.push(`<span class="metric-item">🕐 Session: <span class="metric-value">${escapeHtml(data.sessionTime)}</span></span>`);
  }
  if (data.codeChanges !== undefined) {
    parts.push(`<span class="metric-item">📝 <span class="metric-value">${escapeHtml(data.codeChanges)}</span></span>`);
  }

  if (parts.length === 0) {
    return '<div class="plan-metrics-bar" id="planMetricsBar" style="display:none;"></div>';
  }

  let modelsLine = '';
  if (data.modelBreakdown && data.modelBreakdown.length > 0) {
    const rows = data.modelBreakdown.map(m => {
      const cached = m.cachedTokens ? `, ${escapeHtml(formatTokenCount(m.cachedTokens))} cached` : '';
      const reqs = m.premiumRequests !== undefined ? ` (${m.premiumRequests} req)` : '';
      return `<div class="model-row">
            <span class="model-name">${escapeHtml(m.model)}</span>
            <span class="model-tokens">${escapeHtml(formatTokenCount(m.inputTokens))} in, ${escapeHtml(formatTokenCount(m.outputTokens))} out${cached}${reqs}</span>
          </div>`;
    }).join('');
    modelsLine = `
      <div class="model-breakdown">
        <div class="model-breakdown-label">Model Breakdown:</div>
        <div class="model-breakdown-list">${rows}</div>
      </div>`;
  }

  return `
    <div class="plan-metrics-bar" id="planMetricsBar">
      <span class="metrics-label">⚡ AI Usage:</span>
      ${parts.join('\n      ')}
      ${modelsLine}
    </div>
    `;
}
