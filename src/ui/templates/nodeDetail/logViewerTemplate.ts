/**
 * @fileoverview Log viewer HTML template for node detail panel.
 *
 * Generates HTML for the phase tabs and log viewer section.
 *
 * @module ui/templates/nodeDetail/logViewerTemplate
 */

import { escapeHtml } from '../helpers';

/**
 * Phase definition for a tab.
 */
interface PhaseTab {
  id: string;
  name: string;
  icon: string;
}

/**
 * Input data for the log viewer section.
 */
export interface LogViewerData {
  /** Phase-to-status mapping */
  phaseStatus: Record<string, string>;
  /** Whether the node is currently running */
  isRunning: boolean;
  /** Log file path for the current attempt */
  logFilePath?: string;
}

/**
 * Map a phase status to a Unicode icon character.
 *
 * @param status - The phase status string.
 * @returns A single Unicode icon character.
 */
export function getPhaseIcon(status: string): string {
  switch (status) {
    case 'success': return '✓';
    case 'failed': return '✗';
    case 'running': return '⟳';
    case 'skipped': return '⊘';
    default: return '○';
  }
}

/**
 * Map a merge status to a directional merge icon.
 *
 * @param status - The merge phase status string.
 * @param arrow - Direction indicator ('↓' for FI, '↑' for RI).
 * @returns A styled merge icon string.
 */
export function getMergeIcon(status: string, arrow: string): string {
  switch (status) {
    case 'success': return `✓${arrow}`;
    case 'failed': return `✗${arrow}`;
    case 'running': return `⟳${arrow}`;
    case 'skipped': return `○${arrow}`;
    default: return `○${arrow}`;
  }
}

/**
 * Build HTML for the execution phase tab bar.
 *
 * @param phaseStatus - Phase-to-status mapping.
 * @param isRunning - Whether the node is running (affects styling).
 * @returns HTML fragment string for the tab bar.
 */
export function phaseTabsHtml(phaseStatus: Record<string, string>, isRunning: boolean): string {
  const phases: PhaseTab[] = [
    { id: 'all', name: 'Full Log', icon: '📋' },
    { id: 'merge-fi', name: 'Merge FI', icon: getMergeIcon(phaseStatus['merge-fi'], '↓') },
    { id: 'prechecks', name: 'Prechecks', icon: getPhaseIcon(phaseStatus.prechecks) },
    { id: 'work', name: 'Work', icon: getPhaseIcon(phaseStatus.work) },
    { id: 'commit', name: 'Commit', icon: getPhaseIcon(phaseStatus.commit) },
    { id: 'postchecks', name: 'Postchecks', icon: getPhaseIcon(phaseStatus.postchecks) },
    { id: 'merge-ri', name: 'Merge RI', icon: getMergeIcon(phaseStatus['merge-ri'], '↑') },
  ];

  return phases.map(p => `
      <button class="phase-tab phase-${phaseStatus[p.id] || 'pending'}" 
              data-phase="${p.id}" 
              onclick="selectPhase('${p.id}')">
        <span class="phase-icon">${p.icon}</span>
        ${p.name}
      </button>
    `).join('');
}

/**
 * Render the full log viewer section with phase tabs.
 *
 * @param data - Log viewer input data.
 * @returns HTML fragment string for the execution phases section.
 */
export function logViewerSectionHtml(data: LogViewerData): string {
  return `<!-- Phase Progress -->
  <div class="section">
    <h3>Execution Phases</h3>
    <div class="phase-tabs">
      ${phaseTabsHtml(data.phaseStatus, data.isRunning)}
    </div>
    ${data.logFilePath ? `<div class="log-file-path" id="logFilePath" data-path="${escapeHtml(data.logFilePath)}" title="${escapeHtml(data.logFilePath)}">📄 ${escapeHtml(truncateLogPath(data.logFilePath))}</div>` : ''}
    <div class="log-viewer" id="logViewer">
      <div class="log-placeholder">Select a phase tab to view logs</div>
    </div>
  </div>`;
}

/**
 * Truncate a log file path for display.
 *
 * Keeps the drive letter, an ellipsis, and the filename visible.
 * UUID-based log filenames are also truncated for readability.
 *
 * @param filePath - The full log file path.
 * @returns A truncated display string.
 */
export function truncateLogPath(filePath: string): string {
  if (!filePath) {return '';}

  const separator = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(separator);
  const filename = parts[parts.length - 1];
  const prefix = parts[0] + separator;

  let truncatedFilename = filename;
  const logMatch = filename.match(/^([a-f0-9]{8})-[a-f0-9-]+_[a-f0-9-]+-([a-f0-9]{12})_(\d+\.log)$/i);
  if (logMatch) {
    truncatedFilename = `${logMatch[1]}....${logMatch[2]}_${logMatch[3]}`;
  }

  if (filePath.length <= 50) {return filePath;}

  return `${prefix}....${separator}${truncatedFilename}`;
}
