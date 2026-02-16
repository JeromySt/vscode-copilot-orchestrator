/**
 * @fileoverview Metrics display HTML template for node detail panel.
 *
 * Generates HTML for the AI usage metrics card and per-attempt metrics.
 *
 * @module ui/templates/nodeDetail/metricsTemplate
 */

import { escapeHtml } from '../helpers';
import { formatDurationSeconds, formatTokenCount, formatPremiumRequests, formatCodeChanges } from '../../../plan/metricsAggregator';

/**
 * Model usage breakdown for display.
 */
export interface ModelBreakdownData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  premiumRequests?: number;
}

/**
 * Code change statistics.
 */
export interface CodeChangesData {
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Input data for the metrics summary card.
 */
export interface MetricsData {
  premiumRequests?: number;
  apiTimeSeconds?: number;
  sessionTimeSeconds?: number;
  codeChanges?: CodeChangesData;
  modelBreakdown?: ModelBreakdownData[];
}

/**
 * Input data for per-phase metrics.
 */
export interface PhaseMetricsData {
  [phase: string]: MetricsData;
}



/**
 * Build the main AI usage metrics card.
 *
 * @param metrics - The aggregated metrics data.
 * @param phaseMetrics - Optional per-phase metrics.
 * @returns HTML fragment string for the metrics card.
 */
export function metricsSummaryHtml(metrics: MetricsData, phaseMetrics?: PhaseMetricsData): string {
  const statsHtml: string[] = [];

  if (metrics.premiumRequests !== undefined) {
    statsHtml.push(`<div class="metrics-stat">🎫 ${formatPremiumRequests(metrics.premiumRequests)}</div>`);
  }
  if (metrics.apiTimeSeconds !== undefined) {
    statsHtml.push(`<div class="metrics-stat">⏱ API: ${formatDurationSeconds(metrics.apiTimeSeconds)}</div>`);
  }
  if (metrics.sessionTimeSeconds !== undefined) {
    statsHtml.push(`<div class="metrics-stat">🕐 Session: ${formatDurationSeconds(metrics.sessionTimeSeconds)}</div>`);
  }
  if (metrics.codeChanges) {
    statsHtml.push(`<div class="metrics-stat">📝 Code: ${formatCodeChanges(metrics.codeChanges)}</div>`);
  }

  let modelBreakdownHtml = '';
  if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
    const rows = metrics.modelBreakdown.map(b => {
      const cached = b.cachedTokens ? `, ${formatTokenCount(b.cachedTokens)} cached` : '';
      const reqs = b.premiumRequests !== undefined ? ` (${b.premiumRequests} req)` : '';
      return `<div class="model-row">
          <span class="model-name">${escapeHtml(b.model)}</span>
          <span class="model-tokens">${formatTokenCount(b.inputTokens)} in, ${formatTokenCount(b.outputTokens)} out${cached}${reqs}</span>
        </div>`;
    }).join('');

    modelBreakdownHtml = `
        <div class="model-breakdown">
          <div class="model-breakdown-label">Model Breakdown:</div>
          <div class="model-breakdown-list">${rows}</div>
        </div>`;
  }

  let phaseBreakdownHtml = '';
  if (phaseMetrics && Object.keys(phaseMetrics).length > 0) {
    const phaseLabels: Record<string, string> = {
      'prechecks': '🔍 Prechecks',
      'merge-fi': '↙↘ Merge FI',
      'work': '⚙ Work',
      'commit': '📝 Commit Review',
      'postchecks': '✅ Postchecks',
      'merge-ri': '↗↙ Merge RI',
    };
    const phaseOrder = ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'];

    const phaseRows = phaseOrder
      .filter(phase => phaseMetrics[phase])
      .map(phase => {
        const pm = phaseMetrics[phase];
        const parts: string[] = [];
        if (pm.premiumRequests !== undefined) {parts.push(`${pm.premiumRequests} req`);}
        if (pm.apiTimeSeconds !== undefined) {parts.push(`${formatDurationSeconds(pm.apiTimeSeconds)} API`);}
        if (pm.sessionTimeSeconds !== undefined) {parts.push(`${formatDurationSeconds(pm.sessionTimeSeconds)} session`);}
        if (pm.codeChanges) {parts.push(`${formatCodeChanges(pm.codeChanges)}`);}

        const modelInfo = pm.modelBreakdown?.map(b => escapeHtml(b.model)).join(', ') || '';

        return `<div class="phase-metrics-row">
            <span class="phase-metrics-label">${phaseLabels[phase] || phase}</span>
            <span class="phase-metrics-stats">${parts.join(' · ')}${modelInfo ? ` · ${modelInfo}` : ''}</span>
          </div>`;
      }).join('');

    if (phaseRows) {
      phaseBreakdownHtml = `
          <div class="phase-metrics-breakdown">
            <div class="model-breakdown-label">Phase Breakdown:</div>
            ${phaseRows}
          </div>`;
    }
  }

  return `
    <div class="section metrics-card">
      <h3>⚡ AI Usage</h3>
      <div class="metrics-stats-grid">${statsHtml.join('')}</div>
      ${modelBreakdownHtml}
      ${phaseBreakdownHtml}
    </div>`;
}

/**
 * Build a compact metrics row for an individual attempt.
 *
 * @param metrics - The metrics for a single attempt.
 * @param phaseMetrics - Optional per-phase metrics for this attempt.
 * @returns HTML fragment string for the compact metrics display.
 */
export function attemptMetricsHtml(metrics: MetricsData, phaseMetrics?: PhaseMetricsData): string {
  const statsHtml: string[] = [];

  if (metrics.premiumRequests !== undefined) {
    statsHtml.push(`<div class="metrics-stat">🎫 ${formatPremiumRequests(metrics.premiumRequests)}</div>`);
  }
  if (metrics.apiTimeSeconds !== undefined) {
    statsHtml.push(`<div class="metrics-stat">⏱ API: ${formatDurationSeconds(metrics.apiTimeSeconds)}</div>`);
  }
  if (metrics.sessionTimeSeconds !== undefined) {
    statsHtml.push(`<div class="metrics-stat">🕐 Session: ${formatDurationSeconds(metrics.sessionTimeSeconds)}</div>`);
  }
  if (metrics.codeChanges) {
    statsHtml.push(`<div class="metrics-stat">📝 Code: ${formatCodeChanges(metrics.codeChanges)}</div>`);
  }

  let modelBreakdownHtml = '';
  if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
    const rows = metrics.modelBreakdown.map(b => {
      const cached = b.cachedTokens ? `, ${formatTokenCount(b.cachedTokens)} cached` : '';
      const reqs = b.premiumRequests !== undefined ? ` (${b.premiumRequests} req)` : '';
      return `<div class="model-row">
          <span class="model-name">${escapeHtml(b.model)}</span>
          <span class="model-tokens">${formatTokenCount(b.inputTokens)} in, ${formatTokenCount(b.outputTokens)} out${cached}${reqs}</span>
        </div>`;
    }).join('');

    modelBreakdownHtml = `
        <div class="model-breakdown">
          <div class="model-breakdown-label">Model Breakdown:</div>
          <div class="model-breakdown-list">${rows}</div>
        </div>`;
  }

  let phaseBreakdownHtml = '';
  if (phaseMetrics && Object.keys(phaseMetrics).length > 1) {
    const phaseLabels: Record<string, string> = {
      'prechecks': '🔍 Prechecks',
      'merge-fi': '↙↘ Merge FI',
      'work': '⚙ Work',
      'commit': '📝 Commit Review',
      'postchecks': '✅ Postchecks',
      'merge-ri': '↗↙ Merge RI',
    };
    const phaseOrder = ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'];

    const phaseRows = phaseOrder
      .filter(phase => phaseMetrics[phase])
      .map(phase => {
        const pm = phaseMetrics[phase];
        const parts: string[] = [];
        if (pm.premiumRequests !== undefined) {parts.push(`${pm.premiumRequests} req`);}
        if (pm.apiTimeSeconds !== undefined) {parts.push(`${formatDurationSeconds(pm.apiTimeSeconds)} API`);}
        if (pm.codeChanges) {parts.push(`${formatCodeChanges(pm.codeChanges)}`);}
        return `<div class="phase-metrics-row">
            <span class="phase-metrics-label">${phaseLabels[phase] || phase}</span>
            <span class="phase-metrics-stats">${parts.join(' · ')}</span>
          </div>`;
      }).join('');

    if (phaseRows) {
      phaseBreakdownHtml = `
          <div class="phase-metrics-breakdown">
            <div class="model-breakdown-label">Phase Breakdown:</div>
            ${phaseRows}
          </div>`;
    }
  }

  return `
    <div class="attempt-metrics-card">
      <div class="metrics-stats-grid">${statsHtml.join('')}</div>
      ${modelBreakdownHtml}
      ${phaseBreakdownHtml}
    </div>`;
}
