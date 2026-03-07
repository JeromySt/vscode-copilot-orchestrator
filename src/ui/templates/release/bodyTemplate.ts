/**
 * @fileoverview Release management panel body template.
 *
 * Renders the HTML body for the adaptive wizard interface that changes
 * based on release flow type (from-branch vs from-plans).
 *
 * @module ui/templates/release/bodyTemplate
 */

import { escapeHtml } from '../helpers';
import type { ReleaseDefinition, PrepTask } from '../../../plan/types/release';

/**
 * Renders the HTML body for the release management panel.
 *
 * @param release - The release definition.
 * @returns HTML body string.
 */
export function renderReleaseBody(release: ReleaseDefinition): string {
  const steps = getStepsForFlow(release.flowType);
  const currentStepIndex = getCurrentStepIndex(release, steps);
  
  return `
<div class="release-container">
  <div class="wizard-header">
    <h2>${escapeHtml(release.name)}</h2>
    <div class="release-branch-info">
      ${escapeHtml(release.releaseBranch)} → ${escapeHtml(release.targetBranch)}
    </div>
    ${renderAdaptiveStepIndicator(steps, currentStepIndex, release.status)}
  </div>
  
  <div class="wizard-content">
    ${renderStepContent(release, steps[currentStepIndex])}
  </div>
  
  ${renderFloatingAddPlans(release)}
  
  <div class="wizard-nav">
    ${renderNavigationButtons(release, currentStepIndex, steps)}
  </div>
</div>`;
}

type WizardStep = 
  | 'select-plans'
  | 'configure'
  | 'merge'
  | 'prepare'
  | 'create-pr'
  | 'monitor'
  | 'complete';

interface StepDefinition {
  id: WizardStep;
  label: string;
}

function getStepsForFlow(flowType: string): StepDefinition[] {
  if (flowType === 'from-plans') {
    return [
      { id: 'select-plans', label: 'Select Plans' },
      { id: 'configure', label: 'Configure' },
      { id: 'merge', label: 'Merge' },
      { id: 'prepare', label: 'Prepare' },
      { id: 'create-pr', label: 'Create PR' },
      { id: 'monitor', label: 'Monitor' },
      { id: 'complete', label: 'Complete' },
    ];
  } else {
    // from-branch flow
    return [
      { id: 'configure', label: 'Configure' },
      { id: 'prepare', label: 'Prepare' },
      { id: 'create-pr', label: 'Create PR' },
      { id: 'monitor', label: 'Monitor' },
      { id: 'complete', label: 'Complete' },
    ];
  }
}

function getCurrentStepIndex(release: ReleaseDefinition, steps: StepDefinition[]): number {
  const status = release.status;
  
  if (status === 'drafting') {
    // Check if we're in plan selection (from-plans) or configure (from-branch)
    return 0;
  } else if (status === 'merging') {
    return steps.findIndex(s => s.id === 'merge');
  } else if (status === 'preparing') {
    return steps.findIndex(s => s.id === 'prepare');
  } else if (status === 'ready-for-pr' || status === 'creating-pr') {
    return steps.findIndex(s => s.id === 'create-pr');
  } else if (status === 'pr-active' || status === 'monitoring' || status === 'addressing') {
    return steps.findIndex(s => s.id === 'monitor');
  } else if (status === 'succeeded' || status === 'failed' || status === 'canceled') {
    return steps.findIndex(s => s.id === 'complete');
  } else {
    return 0;
  }
}

function renderAdaptiveStepIndicator(
  steps: StepDefinition[], 
  currentIndex: number, 
  status: string
): string {
  const stepColumns = steps.map((step, i) => {
    const isActive = i === currentIndex;
    const isCompleted = i < currentIndex;
    const isFailed = status === 'failed' && isActive;
    
    const dotClass = [
      'step-dot',
      isActive && 'active',
      isCompleted && 'completed',
      isFailed && 'failed'
    ].filter(Boolean).join(' ');
    
    const labelClass = [
      'step-label',
      isActive && 'active',
      isCompleted && 'completed',
    ].filter(Boolean).join(' ');
    
    return `<div class="step-column ${isActive ? 'active' : ''}">
      <div class="${dotClass}"></div>
      <div class="${labelClass}">${step.label}</div>
    </div>`;
  });
  
  // Build connectors between columns
  const items: string[] = [];
  for (let i = 0; i < stepColumns.length; i++) {
    items.push(stepColumns[i]);
    if (i < stepColumns.length - 1) {
      const connectorClass = i < currentIndex ? 'step-connector completed' : 'step-connector';
      items.push(`<div class="${connectorClass}"></div>`);
    }
  }
  
  return `
<div class="step-indicator">
  ${items.join('\n  ')}
</div>`;
}

function renderStepContent(release: ReleaseDefinition, step: StepDefinition): string {
  switch (step.id) {
    case 'select-plans':
      return renderPlanSelectionStep(release);
    case 'configure':
      return renderConfigureStep(release);
    case 'merge':
      return renderMergeStep(release);
    case 'prepare':
      return renderPrepareStep(release);
    case 'create-pr':
      return renderPRCreationStep(release);
    case 'monitor':
      return renderMonitoringStep(release);
    case 'complete':
      return renderCompletionStep(release);
    default:
      return '';
  }
}

function renderPlanSelectionStep(release: ReleaseDefinition): string {
  return `
<div class="plan-selector">
  <h3>Select Plans to Include</h3>
  <div id="plan-list" class="plan-list">
    <!-- Plans will be populated by JavaScript -->
    <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">
      Loading available plans...
    </div>
  </div>
</div>`;
}

function renderConfigureStep(release: ReleaseDefinition): string {
  const isFromPlans = release.flowType === 'from-plans';
  
  return `
<div class="configuration-section">
  <h3>Release Configuration</h3>
  <div style="display: grid; gap: 12px; max-width: 600px;">
    <div>
      <label style="display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600;">Release Name</label>
      <input 
        type="text" 
        id="release-name" 
        value="${escapeHtml(release.name)}"
        style="width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;"
        placeholder="v1.0.0"
      />
    </div>
    <div>
      <label style="display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600;">Release Branch</label>
      <input 
        type="text" 
        id="release-branch" 
        value="${escapeHtml(release.releaseBranch)}"
        style="width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;"
        placeholder="release/v1.0.0"
        ${isFromPlans ? '' : 'disabled'}
      />
      ${!isFromPlans ? '<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">Auto-filled from current branch</div>' : ''}
    </div>
    <div>
      <label style="display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600;">Target Branch</label>
      <input 
        type="text" 
        id="target-branch" 
        value="${escapeHtml(release.targetBranch)}"
        style="width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;"
        placeholder="main"
      />
    </div>
    <div>
      <label style="display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600;">Git Account</label>
      <div style="display: flex; align-items: center; gap: 8px;">
        <div id="git-account-display" style="flex: 1; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
          <span id="git-account-value" style="color: var(--vscode-descriptionForeground);">Loading...</span>
        </div>
        <button onclick="switchAccount()" style="padding: 8px 12px; white-space: nowrap;">Switch</button>
      </div>
    </div>
  </div>
  
  ${!isFromPlans ? renderOptionalPlansSection(release) : ''}
</div>`;
}

function renderOptionalPlansSection(release: ReleaseDefinition): string {
  return `
<div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--vscode-panel-border);">
  <h3>Add Plans (Optional)</h3>
  <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">
    Include additional succeeded plans in this release
  </div>
  <div id="optional-plan-list" class="plan-list">
    <!-- Optional plans will be populated by JavaScript -->
    <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">
      Loading available plans...
    </div>
  </div>
</div>`;
}

function renderPrepareStep(release: ReleaseDefinition): string {
  const tasks = release.prepTasks || getDefaultPrepTasks();
  const completedCount = tasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;
  const requiredCount = tasks.filter(t => t.required).length;
  const requiredCompleted = tasks.filter(t => t.required && (t.status === 'completed' || t.status === 'skipped')).length;
  const canCreatePR = requiredCompleted === requiredCount;
  const usingDefaults = !release.prepTasks;
  
  return `
<div class="prep-checklist-container">
  <div class="prep-header">
    <h3>Pre-PR Checklist</h3>
    <div class="prep-progress-summary">
      <span>${completedCount} of ${tasks.length} tasks complete</span>
      ${!canCreatePR ? `<span class="required-remaining">• ${requiredCount - requiredCompleted} required task(s) remaining</span>` : ''}
    </div>
  </div>
  
  ${usingDefaults ? `
  <div style="margin-bottom: 16px; padding: 12px; background: var(--vscode-editorInfo-background); border-left: 4px solid var(--vscode-editorInfo-foreground); border-radius: 4px;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 14px;">ℹ️</span>
      <div style="flex: 1; font-size: 12px;">
        Using default tasks. <a href="#" onclick="scaffoldTaskFiles(); return false;" style="color: var(--vscode-textLink-foreground); text-decoration: none;">Create task files</a> to customize.
      </div>
    </div>
  </div>
  ` : ''}
  
  <div class="prep-checklist">
    ${tasks.map(task => renderPrepTask(task)).join('\n')}
  </div>
  
  <div class="prep-footer">
    <div class="prep-progress-bar">
      <div class="prep-progress-fill" style="width: ${(completedCount / tasks.length) * 100}%"></div>
    </div>
    <button 
      class="primary create-pr-btn" 
      ${canCreatePR ? '' : 'disabled'}
      onclick="createPR()"
    >
      ${canCreatePR ? 'Create PR →' : `Create PR (${requiredCount - requiredCompleted} required remaining)`}
    </button>
  </div>
</div>`;
}

function getDefaultPrepTasks(): PrepTask[] {
  return [
    {
      id: 'changelog',
      title: 'Update CHANGELOG',
      description: 'Add release notes to CHANGELOG.md',
      required: true,
      autoSupported: true,
      status: 'pending'
    },
    {
      id: 'version',
      title: 'Bump Version',
      description: 'Update version in package.json',
      required: true,
      autoSupported: true,
      status: 'pending'
    },
    {
      id: 'compile',
      title: 'Run Compilation',
      description: 'Ensure TypeScript compiles without errors',
      required: true,
      autoSupported: true,
      status: 'pending'
    },
    {
      id: 'tests',
      title: 'Run Tests',
      description: 'Execute test suite',
      required: true,
      autoSupported: true,
      status: 'pending'
    },
    {
      id: 'docs',
      title: 'Update Documentation',
      description: 'Review and update README if needed',
      required: false,
      autoSupported: false,
      status: 'pending'
    },
    {
      id: 'ai-review',
      title: 'AI Code Review',
      description: 'Run Copilot code review on changes',
      required: false,
      autoSupported: true,
      status: 'pending'
    }
  ];
}

function renderPrepTask(task: PrepTask): string {
  const statusIcon = task.status === 'completed' ? '✓' : 
                     task.status === 'skipped' ? '−' :
                     task.status === 'running' ? '⏳' : '';
  
  const statusClass = task.status;
  const requiredBadge = task.required ? '<span class="required-badge">Required</span>' : '';
  const hasLog = task.logFilePath || task.status === 'running';
  
  // Count findings badge
  const findingsCount = task.findings?.length || 0;
  const findingsBadge = findingsCount > 0 ? ` <span class="findings-badge">${findingsCount} finding${findingsCount !== 1 ? 's' : ''}</span>` : '';
  
  return `
<div class="prep-task" data-task-id="${task.id}" data-status="${task.status}">
  <span class="task-checkbox ${statusClass}">${statusIcon}</span>
  <div class="task-info">
    <div class="task-title">
      ${escapeHtml(task.title)}${findingsBadge}
      ${requiredBadge}
    </div>
    ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}
    ${task.error ? `<div class="task-error">Error: ${escapeHtml(task.error)}</div>` : ''}
  </div>
  <div class="task-actions">
    ${task.status === 'pending' && task.autoSupported ? 
      '<button class="auto-btn" onclick="executeTask(\'' + task.id + '\')" title="Let Copilot handle this">🤖 Auto</button>' : ''}
    ${task.status === 'pending' ? 
      '<button class="skip-btn" onclick="skipTask(\'' + task.id + '\')" title="Skip this task">Skip</button>' : ''}
    ${task.status === 'pending' && !task.autoSupported ? 
      '<button class="manual-btn" onclick="markTaskComplete(\'' + task.id + '\')" title="Mark as complete">✓ Done</button>' : ''}
    ${task.status === 'failed' ? 
      '<button class="auto-btn" onclick="retryTask(\'' + task.id + '\')" title="Retry this task">↻ Retry</button>' : ''}
    ${task.status === 'failed' && !task.required ? 
      '<button class="skip-btn" onclick="skipTask(\'' + task.id + '\')" title="Skip this task">Skip</button>' : ''}
    ${hasLog ? 
      '<button class="log-btn" onclick="viewTaskLog(\'' + task.id + '\')" title="View task log">📄 Log</button>' : ''}
  </div>
</div>
${task.findings && task.findings.length > 0 ? renderFindings(task.id, task.findings) : ''}
<div class="task-log-area" id="task-log-${task.id}" style="display: none;">
  <pre class="task-log-content"></pre>
</div>`;
}

function renderFindings(taskId: string, findings: any[]): string {
  // Group findings by severity
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');
  const infos = findings.filter(f => f.severity === 'info');
  const suggestions = findings.filter(f => f.severity === 'suggestion');
  
  const sortedFindings = [...errors, ...warnings, ...infos, ...suggestions];
  
  const errorCount = errors.length;
  const warningCount = warnings.length;
  const infoCount = infos.length;
  
  return `
<div class="findings-section" data-task-id="${taskId}">
  <div class="findings-header">
    <span class="findings-count">${findings.length} finding${findings.length !== 1 ? 's' : ''}</span>
    <span class="findings-summary">
      ${errorCount > 0 ? errorCount + ' error' + (errorCount !== 1 ? 's' : '') : ''}${errorCount > 0 && (warningCount > 0 || infoCount > 0) ? ', ' : ''}${warningCount > 0 ? warningCount + ' warning' + (warningCount !== 1 ? 's' : '') : ''}${warningCount > 0 && infoCount > 0 ? ', ' : ''}${infoCount > 0 ? infoCount + ' info' : ''}
    </span>
  </div>
  <div class="findings-list">
    ${sortedFindings.map(finding => renderFinding(taskId, finding)).join('')}
  </div>
</div>`;
}

function renderFinding(taskId: string, finding: any): string {
  const severityIcon = finding.severity === 'error' ? '🔴' :
                       finding.severity === 'warning' ? '🟡' :
                       finding.severity === 'info' ? '🔵' :
                       '💡';
  
  const location = finding.filePath 
    ? `<a class="finding-file-link" onclick="openFindingFile('${escapeHtml(finding.filePath)}', ${finding.line || 1})">${escapeHtml(finding.filePath)}${finding.line ? ':' + finding.line : ''}</a>`
    : '';
  
  const category = finding.category 
    ? `<span class="finding-category">${escapeHtml(finding.category)}</span>`
    : '';
  
  return `
<div class="finding-item ${finding.severity} ${finding.status}" data-finding-id="${finding.id}">
  <div class="finding-severity-badge ${finding.severity}">${severityIcon}</div>
  <div class="finding-content">
    <div class="finding-title">${escapeHtml(finding.title)}</div>
    <div class="finding-description">${escapeHtml(finding.description)}</div>
    <div class="finding-location">
      ${location}
      ${category}
    </div>
  </div>
  <div class="finding-actions">
    ${finding.status !== 'acknowledged' && finding.status !== 'dismissed' ? 
      `<button class="finding-ack-btn" onclick="acknowledgeFinding('${taskId}', '${finding.id}')" title="Acknowledge">✓</button>` : ''}
    ${finding.status !== 'dismissed' ? 
      `<button class="finding-dismiss-btn" onclick="dismissFinding('${taskId}', '${finding.id}')" title="Dismiss">✕</button>` : ''}
  </div>
</div>`;
}

function renderMergeStep(release: ReleaseDefinition): string {
  return `
<div class="merge-progress">
  <h3>Merging Plans into Release Branch</h3>
  <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 16px;">
    Merging ${release.planIds.length} plan(s) into ${escapeHtml(release.releaseBranch)}
  </div>
  <div id="merge-list" class="merge-list">
    <!-- Merge progress will be populated by JavaScript -->
    <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">
      Preparing to merge plans...
    </div>
  </div>
  <div class="merge-progress-bar" style="margin-top: 16px;">
    <div id="overall-merge-progress" class="merge-progress-fill" style="width: 0%;"></div>
  </div>
</div>`;
}

function renderPRCreationStep(release: ReleaseDefinition): string {
  return `
<div class="pr-creation">
  <h3>Creating Pull Request</h3>
  <div style="padding: 40px 20px; text-align: center;">
    <div style="font-size: 48px; margin-bottom: 16px;">📝</div>
    <div style="margin-bottom: 8px;">Creating PR from <strong>${escapeHtml(release.releaseBranch)}</strong> to <strong>${escapeHtml(release.targetBranch)}</strong></div>
    <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">This may take a moment...</div>
  </div>
  <div style="margin-top: 24px; padding: 16px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
    <h4 style="margin: 0 0 8px 0; font-size: 13px;">Or adopt an existing PR</h4>
    <div style="display: flex; gap: 8px; align-items: center;">
      <input 
        type="number" 
        id="pr-number-input" 
        placeholder="PR number" 
        style="flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;"
      />
      <button onclick="adoptPR()">Adopt PR</button>
    </div>
  </div>
</div>`;
}

function renderMonitoringStep(release: ReleaseDefinition): string {
  const prNumber = release.prNumber || '---';
  const prUrl = release.prUrl || '#';
  const isMonitoring = release.status === 'monitoring';
  const isAddressing = release.status === 'addressing';
  const isPRActive = release.status === 'pr-active';
  const stats = release.monitoringStats;
  const checksPass = stats?.checksPass ?? 0;
  const checksFail = stats?.checksFail ?? 0;
  const unresolvedComments = stats?.unresolvedComments ?? 0;
  const unresolvedAlerts = stats?.unresolvedAlerts ?? 0;
  const cycleCount = stats?.cycleCount ?? 0;
  
  // Determine status indicator
  let statusBadge = '';
  if (isMonitoring) {
    statusBadge = '<span class="monitor-status-badge active"><span class="monitoring-pulse"></span>Monitoring Active</span>';
  } else if (isAddressing) {
    statusBadge = '<span class="monitor-status-badge addressing">🤖 Addressing Feedback</span>';
  } else if (isPRActive) {
    statusBadge = '<span class="monitor-status-badge idle">Monitoring Idle</span>';
  }
  
  return `
<div class="pr-monitor">
  <div class="pr-header-section">
    <h3>PR Monitoring Dashboard</h3>
    <div class="pr-header">
      <span class="pr-number">Pull Request #${prNumber}</span>
      ${statusBadge}
      ${prUrl !== '#' ? `<a href="${escapeHtml(prUrl)}" class="pr-link" target="_blank">View on GitHub ↗</a>` : ''}
    </div>
  </div>
  
  <div class="monitoring-controls" style="margin-bottom: 16px;">
    ${isPRActive ? '<button onclick="startMonitoring()">Start Monitoring</button>' : ''}
    ${isMonitoring ? '<button class="secondary" style="padding:6px 14px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-foreground); border-radius:4px; cursor:pointer; font-size:12px; font-family:var(--vscode-font-family);" onclick="stopMonitoring()">Stop Monitoring</button>' : ''}
    ${isMonitoring ? `
    <div class="monitor-timer-bar">
      <div class="monitor-timer-label">Next check in:</div>
      <div class="monitor-countdown" id="countdown-display">2:00</div>
      <div class="monitor-poll-info">Polling every 2 minutes</div>
    </div>` : ''}
  </div>
  
  <div class="pr-stats" id="pr-stats">
    <div class="pr-stat-card">
      <div class="pr-stat-value passing" id="checks-passing">${checksPass}</div>
      <div class="pr-stat-label">Checks Passing</div>
    </div>
    <div class="pr-stat-card">
      <div class="pr-stat-value failing" id="checks-failing">${checksFail}</div>
      <div class="pr-stat-label">Checks Failing</div>
    </div>
    <div class="pr-stat-card">
      <div class="pr-stat-value pending" id="comments-unresolved">${unresolvedComments}</div>
      <div class="pr-stat-label">Unresolved Comments</div>
    </div>
    <div class="pr-stat-card">
      <div class="pr-stat-value" id="alerts-unresolved">${unresolvedAlerts}</div>
      <div class="pr-stat-label">Security Alerts</div>
    </div>
  </div>
  
  <div class="pr-cycle-timeline" id="pr-cycle-timeline">
    <h4>Monitoring Cycles (${cycleCount})</h4>
    <div id="cycle-dots" class="cycle-dots">
      <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
        ${isMonitoring ? 'Waiting for first cycle to complete...' : 'No monitoring cycles yet'}
      </div>
    </div>
  </div>
  
  <div id="pr-checks-list" class="pr-checks-list">
  </div>
  
  <div class="action-log" style="margin-top: 24px;">
    <h3>Autonomous Actions</h3>
    <div id="action-log-entries" class="action-log-entries">
      <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
        No actions taken yet. The system will autonomously address feedback as it arrives.
      </div>
    </div>
  </div>
</div>`;
}

function renderCompletionStep(release: ReleaseDefinition): string {
  const isSuccess = release.status === 'succeeded';
  const isFailed = release.status === 'failed';
  const isCanceled = release.status === 'canceled';
  const hasPR = !!release.prNumber;
  
  const icon = isSuccess ? '✅' : (isFailed ? '❌' : '⚠️');
  const title = isSuccess ? 'Release Completed Successfully!' : 
                isFailed ? 'Release Failed' : 
                isCanceled && hasPR ? 'Release Canceled (PR still open)' :
                'Release Canceled';
  const message = isSuccess ? `PR #${release.prNumber || ''} has been merged.` :
                  isFailed ? (release.error || 'An error occurred during the release process.') :
                  isCanceled && hasPR ? `The release was canceled but PR #${release.prNumber} is still open on GitHub.` :
                  'The release was canceled.';
  
  return `
<div class="completion-screen" style="text-align: center; padding: 40px 20px;">
  <div style="font-size: 72px; margin-bottom: 24px;">${icon}</div>
  <h3 style="margin: 0 0 12px 0; font-size: 18px;">${title}</h3>
  <div style="color: var(--vscode-descriptionForeground); margin-bottom: 24px;">${escapeHtml(message)}</div>
  ${release.prUrl ? `<a href="${escapeHtml(release.prUrl)}" class="pr-link" target="_blank" style="font-size: 14px;">View PR on GitHub ↗</a>` : ''}
  <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: center;">
    ${isFailed ? '<button onclick="retryRelease()">↻ Retry Release</button>' : ''}
    <button class="danger" onclick="deleteRelease()">Delete Release</button>
  </div>
</div>`;
}

function renderFloatingAddPlans(release: ReleaseDefinition): string {
  // Only show "+ Add Plans" during drafting/configure steps
  const canAddPlans = ['drafting'].includes(release.status);
  
  if (!canAddPlans) {
    return '';
  }
  
  return `
<button class="floating-add-plans" onclick="openPlanSelector()" title="Add plans to this release">
  + Add Plans
</button>`;
}

function renderNavigationButtons(release: ReleaseDefinition, stepIndex: number, steps: StepDefinition[]): string {
  const currentStep = steps[stepIndex].id;
  const canCancel = !['succeeded', 'failed', 'canceled'].includes(release.status);
  const canProceed = currentStep === 'configure' && release.status === 'drafting';
  const isFromPlans = release.flowType === 'from-plans';
  
  let proceedButton = '';
  if (canProceed) {
    const hasPlans = release.planIds.length > 0;
    const buttonText = isFromPlans && hasPlans ? 'Start Merge →' : 'Prepare Release →';
    proceedButton = `<button onclick="proceedFromConfigure()" ${!hasPlans && isFromPlans ? 'disabled' : ''}>${buttonText}</button>`;
  }
  
  const isTerminal = ['succeeded', 'failed', 'canceled'].includes(release.status);
  
  // Don't show nav buttons for terminal states (they're in the completion screen)
  if (isTerminal) {
    return '';
  }
  
  return `
<div style="display: flex; gap: 12px; justify-content: flex-end; padding: 16px 0;">
  ${canCancel ? '<button class="danger" onclick="cancelRelease()">Cancel Release</button>' : ''}
  ${proceedButton}
</div>`;
}
