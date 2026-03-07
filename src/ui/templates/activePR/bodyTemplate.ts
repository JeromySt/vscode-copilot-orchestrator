/**
 * @fileoverview Active PR panel body template.
 *
 * Renders the HTML body for the active PR management panel.
 *
 * @module ui/templates/activePR/bodyTemplate
 */

import { escapeHtml } from '../helpers';
import type { ManagedPR } from '../../../plan/types/prLifecycle';

/**
 * Renders the HTML body for the active PR panel.
 *
 * @param pr - The managed PR definition.
 * @returns HTML body string.
 */
export function renderActivePRBody(pr: ManagedPR): string {
  return `
<div class="active-pr-container">
  ${renderPRHeader(pr)}
  ${renderActionButtons(pr)}
  ${renderMonitoringSection(pr)}
  ${renderActivityLog(pr)}
</div>`;
}

function renderPRHeader(pr: ManagedPR): string {
  const statusClass = getStatusClass(pr.status);
  const statusLabel = getStatusLabel(pr.status);
  
  return `
<div class="pr-header-card">
  <div class="pr-title-row">
    <h2>PR #${pr.prNumber}: ${escapeHtml(pr.title)}</h2>
    <span class="pr-status ${statusClass}">${statusLabel}</span>
  </div>
  
  <div class="pr-meta">
    <div class="pr-branches">
      <span class="branch-badge">${escapeHtml(pr.baseBranch)}</span>
      <span class="arrow">←</span>
      <span class="branch-badge">${escapeHtml(pr.headBranch)}</span>
    </div>
    <span class="provider-badge">${escapeHtml(pr.providerType)}</span>
  </div>
  
  <div class="pr-links">
    <a href="${escapeHtml(pr.prUrl)}" class="pr-link" onclick="event.preventDefault(); vscode.postMessage({ type: 'openPR', url: '${escapeHtml(pr.prUrl)}' });">
      View on ${escapeHtml(pr.providerType)} ↗
    </a>
  </div>
  
  ${pr.error ? `<div class="pr-error">${escapeHtml(pr.error)}</div>` : ''}
</div>`;
}

function renderActionButtons(pr: ManagedPR): string {
  const showMonitor = pr.status === 'adopted';
  const showPause = pr.status === 'monitoring' || pr.status === 'addressing';
  const showPromote = shouldShowPromote(pr);
  const showDemote = shouldShowDemote(pr);
  const showAbandon = true;
  const showRemove = true;

  const buttons: string[] = [];
  
  if (showMonitor) {
    buttons.push(`<button class="action-btn primary" onclick="monitor()">▶ Monitor</button>`);
  }
  
  if (showPause) {
    buttons.push(`<button class="action-btn secondary" onclick="pause()">⏸ Pause</button>`);
  }
  
  if (showPromote) {
    buttons.push(`<button class="action-btn secondary" onclick="promote()">⬆ Promote to Ready</button>`);
  }
  
  if (showDemote) {
    buttons.push(`<button class="action-btn secondary" onclick="demote()">⬇ Convert to Draft</button>`);
  }
  
  if (showAbandon) {
    buttons.push(`<button class="action-btn warning" onclick="abandon()">⚠ Abandon</button>`);
  }
  
  if (showRemove) {
    buttons.push(`<button class="action-btn danger" onclick="remove()">🗑 Remove</button>`);
  }

  return `
<div class="action-buttons">
  ${buttons.join('\n  ')}
</div>`;
}

function renderMonitoringSection(pr: ManagedPR): string {
  const isMonitoring = pr.status === 'monitoring' || pr.status === 'addressing';
  const monitoringDuration = pr.monitoringStartedAt 
    ? Date.now() - pr.monitoringStartedAt 
    : 0;
  
  return `
<div class="monitoring-section">
  <h3>Monitoring Status</h3>
  
  ${isMonitoring ? `
  <div class="monitoring-timer">
    <div class="timer-label">Monitoring for:</div>
    <div class="timer-value" id="monitoring-duration" data-started="${pr.monitoringStartedAt || 0}">
      ${formatDuration(monitoringDuration)}
    </div>
  </div>` : `
  <div class="monitoring-inactive">
    <div style="text-align: center; padding: 20px; color: var(--vscode-descriptionForeground);">
      Monitoring is not active
    </div>
  </div>`}
  
  <div class="pr-stats-grid">
    <div class="stat-card">
      <div class="stat-value ${pr.unresolvedComments ? 'warning' : ''}">${pr.unresolvedComments || 0}</div>
      <div class="stat-label">Unresolved Comments</div>
    </div>
    <div class="stat-card">
      <div class="stat-value ${pr.failingChecks ? 'danger' : ''}">${pr.failingChecks || 0}</div>
      <div class="stat-label">Failing Checks</div>
    </div>
    <div class="stat-card">
      <div class="stat-value ${pr.unresolvedAlerts ? 'danger' : ''}">${pr.unresolvedAlerts || 0}</div>
      <div class="stat-label">Security Alerts</div>
    </div>
  </div>
  
  ${isMonitoring ? `
  <div class="timeline-section" id="timeline">
    <h4>Timeline</h4>
    <div class="timeline-entries" id="timeline-entries">
      <div style="padding: 12px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
        No events yet
      </div>
    </div>
  </div>` : ''}
</div>`;
}

function renderActivityLog(pr: ManagedPR): string {
  return `
<div class="activity-log-section">
  <h3>Activity Log</h3>
  <div class="activity-entries" id="activity-log">
    <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
      No activity recorded yet
    </div>
  </div>
</div>`;
}

function getStatusClass(status: string): string {
  switch (status) {
    case 'adopted': return 'status-adopted';
    case 'monitoring': return 'status-monitoring';
    case 'addressing': return 'status-addressing';
    case 'ready': return 'status-ready';
    case 'blocked': return 'status-blocked';
    case 'abandoned': return 'status-abandoned';
    default: return '';
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'adopted': return 'Adopted';
    case 'monitoring': return 'Monitoring';
    case 'addressing': return 'Addressing Feedback';
    case 'ready': return 'Ready';
    case 'blocked': return 'Blocked';
    case 'abandoned': return 'Abandoned';
    default: return status;
  }
}

function shouldShowPromote(pr: ManagedPR): boolean {
  // Promote button shows when PR is draft
  // This is a placeholder - actual implementation would check PR draft status
  return pr.status === 'monitoring' || pr.status === 'addressing';
}

function shouldShowDemote(pr: ManagedPR): boolean {
  // Demote button shows when PR is NOT draft
  // This is a placeholder - actual implementation would check PR draft status
  return pr.status === 'monitoring' || pr.status === 'addressing';
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
