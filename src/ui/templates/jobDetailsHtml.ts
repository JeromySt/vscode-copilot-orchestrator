/**
 * @fileoverview HTML builder for job details panel.
 * 
 * Constructs the complete HTML document for the job details webview,
 * assembling CSS, JS, and dynamic HTML content based on job state.
 * 
 * @module ui/templates/jobDetailsHtml
 */

import * as fs from 'fs';
import { getJobDetailsCss } from './jobDetailsCss';
import { getJobDetailsJs } from './jobDetailsJs';

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Format a duration in seconds to a human-readable string.
 * @param seconds - Duration in seconds
 * @returns Formatted duration string (e.g., "1h 23m 45s", "5m 30s", "45s")
 */
function formatDuration(seconds: number): string {
  if (seconds < 0) return '0s';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Execution attempt data structure.
 */
interface CommitDetail {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
}

interface AttemptData {
  attemptId: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  logFile?: string;
  copilotSessionId?: string;
  workInstruction?: string;
  workSummary?: {
    description: string;
    commits: number;
    filesAdded: number;
    filesDeleted: number;
    filesModified: number;
    commitDetails?: CommitDetail[];
  };
  stepStatuses?: Record<string, string>;
}

/**
 * Job policy structure with step definitions.
 */
interface JobPolicy {
  steps: {
    work: string;
  };
}

/**
 * Job data structure for HTML generation.
 */
interface JobData {
  id: string;
  name: string;
  status: string;
  task: string;
  currentStep?: string;
  currentAttemptId?: string;
  startedAt?: number;
  endedAt?: number;
  attempts?: AttemptData[];
  workHistory?: string[];
  policy: JobPolicy;
  stepStatuses?: Record<string, string>;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Escape HTML special characters to prevent XSS.
 * 
 * @param text - Raw text to escape
 * @returns HTML-safe string
 */
function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Get CSS class for step status indicator dot.
 * 
 * @param status - Step status string
 * @returns HTML span element with appropriate styling
 */
function getStepDot(status: string): string {
  if (status === 'success') return '<span class="step-dot success">●</span>';
  if (status === 'failed') return '<span class="step-dot failed">●</span>';
  if (status === 'skipped') return '<span class="step-dot skipped">●</span>';
  if (status === 'running') return '<span class="step-dot running">●</span>';
  return '<span class="step-dot pending">●</span>';
}

// ============================================================================
// CONTENT BUILDERS
// ============================================================================

/**
 * Build the work history timeline HTML.
 * Only shown when there are 2+ iterations of work refinement.
 * 
 * @param workHistory - Array of work instruction iterations
 * @returns HTML string for work history section
 */
function buildWorkHistoryHtml(workHistory: string[] | undefined): string {
  if (!workHistory || workHistory.length < 2) {
    return '';
  }

  const historyItems = workHistory.map((work: string, idx: number) => {
    const isLatest = idx === 0; // Latest is at index 0 (unshift)
    const isOriginal = idx === workHistory.length - 1; // Original is at end
    const label = isLatest ? 'Latest' : isOriginal ? 'Original' : `Iteration ${workHistory.length - idx - 1}`;
    const preview = work.length > 120 ? work.substring(0, 120) + '...' : work;
    const active = isLatest ? 'active' : '';

    return `
      <div class="work-history-item ${active}">
        <div class="work-history-dot"></div>
        <div class="work-history-content">
          <div class="work-history-label">${label}</div>
          <div class="work-history-preview">${escapeHtml(preview)}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="work-history-section">
      <h3>Work History</h3>
      <div class="work-history-timeline">
        ${historyItems}
      </div>
    </div>
  `;
}

/**
 * Build expandable work summary HTML with commit details.
 * 
 * @param workSummary - Work summary data with optional commit details
 * @returns HTML string for work summary section
 */
function buildWorkSummaryHtml(workSummary: AttemptData['workSummary']): string {
  if (!workSummary) return '';
  
  const hasDetails = workSummary.commitDetails && workSummary.commitDetails.length > 0;
  const chevron = hasDetails ? '<span class="work-summary-chevron">▶</span>' : '';
  const clickable = hasDetails ? 'clickable' : '';
  
  // Build commit details HTML
  let commitDetailsHtml = '';
  if (hasDetails && workSummary.commitDetails) {
    const commitsHtml = workSummary.commitDetails.map((commit, idx) => {
      const filesHtml = [
        ...commit.filesAdded.map(f => `<div class="commit-file file-added"><span class="file-status">+</span> ${escapeHtml(f)}</div>`),
        ...commit.filesModified.map(f => `<div class="commit-file file-modified"><span class="file-status">~</span> ${escapeHtml(f)}</div>`),
        ...commit.filesDeleted.map(f => `<div class="commit-file file-deleted"><span class="file-status">−</span> ${escapeHtml(f)}</div>`)
      ].join('');
      
      const totalFiles = commit.filesAdded.length + commit.filesModified.length + commit.filesDeleted.length;
      const commitDate = new Date(commit.date).toLocaleString();
      
      return `
        <div class="commit-item">
          <div class="commit-header">
            <span class="commit-hash" title="${commit.hash}">${commit.shortHash}</span>
            <span class="commit-message">${escapeHtml(commit.message)}</span>
          </div>
          <div class="commit-meta">
            <span class="commit-author">👤 ${escapeHtml(commit.author)}</span>
            <span class="commit-date">📅 ${commitDate}</span>
            <span class="commit-stats">
              <span class="stat-added">+${commit.filesAdded.length}</span>
              <span class="stat-modified">~${commit.filesModified.length}</span>
              <span class="stat-deleted">−${commit.filesDeleted.length}</span>
            </span>
          </div>
          <div class="commit-files">${filesHtml}</div>
        </div>
      `;
    }).join('');
    
    commitDetailsHtml = `
      <div class="work-summary-details-panel" style="display: none;">
        <div class="commits-list">
          ${commitsHtml}
        </div>
      </div>
    `;
  }
  
  return `
    <div class="work-summary-box ${clickable}" ${hasDetails ? 'data-expandable="true"' : ''}>
      <div class="work-summary-header">
        ${chevron}
        <span class="work-summary-icon">📊</span>
        <strong>Work Summary:</strong> ${escapeHtml(workSummary.description)}
        <span class="work-summary-counts">(${workSummary.commits} commits, +${workSummary.filesAdded} −${workSummary.filesDeleted} ~${workSummary.filesModified})</span>
      </div>
      ${commitDetailsHtml}
    </div>
  `;
}

/**
 * Build phase tabs HTML for log viewer navigation.
 * Shows status indicators for each execution phase.
 * 
 * @param job - Job data
 * @param attempt - Current attempt data
 * @returns HTML string for phase tabs
 */
function buildPhaseTabsHtml(job: JobData, attempt: AttemptData): string {
  // Use job-level statuses if running, else attempt-level
  const ss = (job.status === 'running' || job.status === 'queued') 
    ? (job.stepStatuses || {}) 
    : (attempt.stepStatuses || {});
  const cs = job.currentStep;
  const isRunning = attempt.status === 'running';

  const getPhaseClass = (phase: string): string => {
    const status = ss[phase as keyof typeof ss];
    if (status) return status;
    if (isRunning && cs === phase) return 'running';
    return 'pending';
  };

  const getPhaseIcon = (phase: string): string => {
    const status = ss[phase as keyof typeof ss];
    if (status === 'success') return '✓';
    if (status === 'failed') return '✗';
    if (status === 'skipped') return '⊘';
    if (isRunning && cs === phase) return '⟳';
    return '○';
  };

  const phases = ['PRECHECKS', 'WORK', 'POSTCHECKS', 'MERGEBACK', 'CLEANUP'];
  const phaseTabs = phases.map(phase => {
    const phaseLower = phase.toLowerCase();
    const phaseClass = getPhaseClass(phaseLower);
    const phaseIcon = getPhaseIcon(phaseLower);
    const displayName = phase === 'PRECHECKS' ? 'Prechecks' :
                        phase === 'POSTCHECKS' ? 'Postchecks' :
                        phase === 'MERGEBACK' ? 'Mergeback' :
                        phase.charAt(0) + phase.slice(1).toLowerCase();
    return `<button class="log-tab phase-tab phase-tab-${phaseClass}" data-section="${phase}"><span class="phase-icon phase-icon-${phaseClass}">${phaseIcon}</span>${displayName}</button>`;
  }).join('');

  return `<div class="log-tabs folder-tabs">
    <button class="log-tab active" data-section="FULL">📋 Full</button>
    ${phaseTabs}
  </div>`;
}

/**
 * Build HTML for a single execution attempt card.
 * 
 * @param attempt - Attempt data
 * @param idx - Attempt index (0-based)
 * @param job - Parent job data
 * @returns HTML string for attempt card
 */
function buildAttemptCard(attempt: AttemptData, idx: number, job: JobData): string {
  const attemptNum = idx + 1;
  const isLatest = idx === job.attempts!.length - 1;
  const duration = attempt.endedAt
    ? formatDuration(Math.round((attempt.endedAt - attempt.startedAt) / 1000))
    : 'running...';
  const timestamp = new Date(attempt.startedAt).toLocaleString();

  // Determine step status for indicators
  const getStepStatus = (stepName: string, stepStatus?: string): string => {
    if (stepStatus) return stepStatus;
    if (attempt.status === 'running' && job.currentStep === stepName) return 'running';
    return 'pending';
  };

  const stepIndicators = `
    ${getStepDot(getStepStatus('prechecks', attempt.stepStatuses?.prechecks))}
    ${getStepDot(getStepStatus('work', attempt.stepStatuses?.work))}
    ${getStepDot(getStepStatus('postchecks', attempt.stepStatuses?.postchecks))}
    ${getStepDot(getStepStatus('mergeback', attempt.stepStatuses?.mergeback))}
    ${getStepDot(getStepStatus('cleanup', attempt.stepStatuses?.cleanup))}
  `;

  // Session ID with copy functionality
  const sessionIdHtml = attempt.copilotSessionId
    ? `<strong>Session:</strong> <span class="session-id" data-session="${attempt.copilotSessionId}" title="Click to copy">${attempt.copilotSessionId.substring(0, 12)}... 📋</span>`
    : '';

  // Work summary display with expandable commit details
  const workSummaryHtml = attempt.workSummary ? buildWorkSummaryHtml(attempt.workSummary) : '';

  // Process tree section (only for running attempts)
  const isRunningAttempt = attempt.status === 'running' || 
    (attempt.attemptId === job.currentAttemptId && (job.status === 'running' || job.status === 'queued'));
  
  const processTreeHtml = isRunningAttempt ? `
    <div class="process-tree-section">
      <div class="process-tree-header" data-expanded="false">
        <span class="process-tree-chevron">▶</span>
        <span class="process-tree-icon">⚡</span>
        <span class="process-tree-title">Running Processes</span>
      </div>
      <div class="process-tree" data-attempt-id="${attempt.attemptId}" style="display: none;">
        <div class="loading">Loading process tree...</div>
      </div>
    </div>
  ` : '';

  // Log viewer
  const logViewerContent = attempt.logFile && fs.existsSync(attempt.logFile)
    ? '<div class="loading">Loading log...</div>'
    : '<div class="no-log">No log file available</div>';

  return `
    <div class="attempt-card ${attempt.attemptId === job.currentAttemptId ? 'active' : ''}" data-attempt-id="${attempt.attemptId}">
      <div class="attempt-header" data-expanded="${isLatest}">
        <div class="attempt-header-left">
          <span class="attempt-badge">#${attemptNum}</span>
          <span class="step-indicators">${stepIndicators}</span>
          <span class="attempt-time">${timestamp}</span>
          <span class="attempt-duration">(${duration})</span>
        </div>
        <span class="chevron">${isLatest ? '▼' : '▶'}</span>
      </div>
      <div class="attempt-body" style="display: ${isLatest ? 'block' : 'none'};">
        <div class="attempt-meta">
          <div class="attempt-meta-row"><strong>Status:</strong> <span class="status-${attempt.status}">${attempt.status}</span></div>
          <div class="attempt-meta-row"><strong>Attempt ID:</strong> <span class="attempt-id-value">${attempt.attemptId}</span></div>
          ${sessionIdHtml ? '<div class="attempt-meta-row">' + sessionIdHtml + '</div>' : ''}
          ${workSummaryHtml}
          <div class="attempt-meta-row"><strong>Task:</strong></div>
          <div class="work-instruction-box">${escapeHtml(job.task)}</div>
          <div class="attempt-meta-row"><strong>Work Instruction:</strong></div>
          <div class="work-instruction-box">${escapeHtml(attempt.workInstruction || job.policy.steps.work)}</div>
        </div>
        ${processTreeHtml}
        ${buildPhaseTabsHtml(job, attempt)}
        <div class="log-viewer" data-log="${attempt.logFile}" data-section="FULL" data-running="${attempt.status === 'running'}">
          ${logViewerContent}
        </div>
      </div>
    </div>
  `;
}

/**
 * Build execution attempts HTML section.
 * 
 * @param job - Job data with attempts array
 * @returns HTML string for all attempt cards
 */
function buildAttemptsHtml(job: JobData): string {
  if (!job.attempts || job.attempts.length === 0) {
    return '';
  }

  // Reconcile inconsistent states before rendering
  for (const attempt of job.attempts) {
    if (attempt.status === 'running' && job.status !== 'running' && job.status !== 'queued') {
      attempt.status = job.status === 'succeeded' ? 'succeeded' : 'failed';
      attempt.endedAt = attempt.endedAt || job.endedAt || Date.now();
    }
  }

  return job.attempts
    .map((attempt, idx) => buildAttemptCard(attempt, idx, job))
    .reverse()
    .join('');
}

/**
 * Build the process modal HTML structure.
 * This modal shows detailed process information when clicking a process node.
 * 
 * @returns HTML string for process details modal
 */
function buildProcessModalHtml(): string {
  return `
    <div class="process-modal-overlay" id="processModal">
      <div class="process-modal">
        <div class="process-modal-header">
          <div class="process-modal-title">
            <span id="modalPerfIcon">🟢</span>
            <span id="modalProcessName">Process</span>
          </div>
          <button class="process-modal-close" id="closeProcessModal">✕</button>
        </div>
        <div class="process-modal-body">
          <div class="process-stats-grid">
            <div class="process-stat-card">
              <div class="process-stat-card-value" id="modalCpu">0%</div>
              <div class="process-stat-card-label">CPU Usage</div>
            </div>
            <div class="process-stat-card">
              <div class="process-stat-card-value" id="modalMemory">0 MB</div>
              <div class="process-stat-card-label">Memory</div>
            </div>
          </div>
          <div class="process-stats-grid-4">
            <div class="process-stat-card-small">
              <div class="process-stat-card-value" id="modalThreads">0</div>
              <div class="process-stat-card-label">Threads</div>
            </div>
            <div class="process-stat-card-small">
              <div class="process-stat-card-value" id="modalHandles">0</div>
              <div class="process-stat-card-label">Handles</div>
            </div>
            <div class="process-stat-card-small">
              <div class="process-stat-card-value" id="modalPriority">0</div>
              <div class="process-stat-card-label">Priority</div>
            </div>
            <div class="process-stat-card-small">
              <div class="process-stat-card-value" id="modalUptime">-</div>
              <div class="process-stat-card-label">Uptime</div>
            </div>
          </div>
          <div class="process-detail-section">
            <div class="process-detail-label">Process ID</div>
            <div class="process-detail-value" id="modalPid">-</div>
          </div>
          <div class="process-detail-section">
            <div class="process-detail-label">Parent Process</div>
            <div class="process-detail-value"><span id="modalParentPid" class="process-nav-link">-</span></div>
          </div>
          <div class="process-detail-section" id="modalChildrenSection" style="display:none;">
            <div class="process-detail-label">Child Processes</div>
            <div class="process-children-list" id="modalChildren"></div>
          </div>
          <div class="process-detail-section">
            <div class="process-detail-label">Executable Path</div>
            <div class="process-detail-value" id="modalExePath">-</div>
          </div>
          <div class="process-detail-section">
            <div class="process-detail-label">Command Line</div>
            <div class="process-detail-value cmdline" id="modalCmdline">-</div>
          </div>
          <div class="process-detail-section">
            <div class="process-detail-label">Started</div>
            <div class="process-detail-value" id="modalStarted">-</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Build header section with job title, status, and action buttons.
 * 
 * @param job - Job data
 * @returns HTML string for header section
 */
function buildHeaderHtml(job: JobData): string {
  // Duration display logic
  let durationHtml = '';
  if (job.status === 'running' && job.startedAt) {
    durationHtml = `<span class="live-duration" data-started="${job.startedAt}"></span>`;
  } else if (job.endedAt && job.startedAt) {
    const durationSecs = Math.floor((job.endedAt - job.startedAt) / 1000);
    durationHtml = `<span class="duration-display">${formatDuration(durationSecs)}</span>`;
  }

  // Action buttons based on status
  let actionButtonsHtml = '';
  if (job.status === 'running' || job.status === 'queued') {
    actionButtonsHtml += `<button class="action-btn cancel-btn" data-action="cancel" data-job-id="${job.id}">⏹ Cancel</button>`;
  }
  if (job.status === 'failed') {
    actionButtonsHtml += `<button class="action-btn retry-btn" data-action="retry" data-job-id="${job.id}">🔄 Retry with AI Analysis</button>`;
  }
  actionButtonsHtml += `<button class="action-btn delete-btn" data-action="delete" data-job-id="${job.id}">🗑 Delete</button>`;

  return `
    <div class="header">
      <div class="header-top">
        <div class="title-section">
          <h2>${escapeHtml(job.name)}<span class="status-badge status-${job.status}">${job.status}</span>${durationHtml}</h2>
        </div>
      </div>
      <div class="action-buttons">
        ${actionButtonsHtml}
      </div>
    </div>
  `;
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Generate the complete HTML document for job details panel.
 * 
 * Assembles CSS, HTML body, and JavaScript into a cohesive webview document.
 * The generated HTML includes:
 * - Job header with status and action buttons
 * - Work history timeline (if multiple iterations)
 * - Execution attempts with expandable cards
 * - Log viewer with phase filtering
 * - Process tree for running jobs
 * - Process details modal
 * 
 * @param job - Job data object
 * @returns Complete HTML document string
 * 
 * @example
 * ```typescript
 * const html = getJobDetailsHtml(job);
 * webview.html = html;
 * ```
 */
export function getJobDetailsHtml(job: JobData): string {
  const workHistoryHtml = buildWorkHistoryHtml(job.workHistory);
  const attemptsHtml = buildAttemptsHtml(job);
  const headerHtml = buildHeaderHtml(job);
  const processModalHtml = buildProcessModalHtml();
  const css = getJobDetailsCss();
  const js = getJobDetailsJs(JSON.stringify(job));

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
${css}
  </style>
</head>
<body>
  ${processModalHtml}
  
  ${headerHtml}
  
  ${workHistoryHtml}
  
  <h3>Execution Attempts</h3>
  ${attemptsHtml || '<div style="opacity:0.6;padding:20px;text-align:center">No execution attempts yet</div>'}
  
  <script>
${js}
  </script>
</body>
</html>`;
}
