/**
 * @fileoverview Release management panel body template.
 *
 * Renders the HTML body for the 5-step wizard interface.
 *
 * @module ui/templates/release/bodyTemplate
 */

import { escapeHtml } from '../helpers';
import type { ReleaseDefinition } from '../../../plan/types/release';

/**
 * Renders the HTML body for the release management panel.
 *
 * @param release - The release definition.
 * @returns HTML body string.
 */
export function renderReleaseBody(release: ReleaseDefinition): string {
  const stepIndex = getStepIndex(release.status);
  
  return `
<div class="release-container">
  <div class="wizard-header">
    <h2>${escapeHtml(release.name)}</h2>
    <div class="release-branch-info">
      ${escapeHtml(release.releaseBranch)} → ${escapeHtml(release.targetBranch)}
    </div>
    ${renderStepIndicator(stepIndex, release.status)}
  </div>
  
  <div class="wizard-content">
    ${renderStepContent(release, stepIndex)}
  </div>
  
  <div class="wizard-nav">
    ${renderNavigationButtons(release, stepIndex)}
  </div>
</div>`;
}

function getStepIndex(status: string): number {
  switch (status) {
    case 'drafting': return 0;
    case 'merging': return 1;
    case 'creating-pr': return 2;
    case 'monitoring':
    case 'addressing': return 3;
    case 'succeeded':
    case 'failed':
    case 'canceled': return 4;
    default: return 0;
  }
}

function renderStepIndicator(currentStep: number, status: string): string {
  const steps = ['Select', 'Merge', 'PR', 'Monitor', 'Complete'];
  const dots: string[] = [];
  
  for (let i = 0; i < steps.length; i++) {
    const dotClass = i === currentStep ? 'active' : (i < currentStep ? 'completed' : '');
    const failedClass = status === 'failed' && i === currentStep ? 'failed' : '';
    dots.push(`<div class="step-dot ${dotClass} ${failedClass}"></div>`);
    
    if (i < steps.length - 1) {
      const connectorClass = i < currentStep ? 'completed' : '';
      dots.push(`<div class="step-connector ${connectorClass}"></div>`);
    }
  }
  
  const labels = steps.map((label, i) => {
    const labelClass = i === currentStep ? 'active' : '';
    return `<div class="step-label ${labelClass}">${label}</div>`;
  }).join('');
  
  return `
<div class="step-indicator">
  ${dots.join('\n  ')}
</div>
<div class="step-labels">
  ${labels}
</div>`;
}

function renderStepContent(release: ReleaseDefinition, stepIndex: number): string {
  switch (stepIndex) {
    case 0:
      return renderPlanSelectionStep(release);
    case 1:
      return renderMergeStep(release);
    case 2:
      return renderPRCreationStep(release);
    case 3:
      return renderMonitoringStep(release);
    case 4:
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
</div>
<div class="configuration-section" style="margin-top: 24px;">
  <h3>Release Configuration</h3>
  <div style="display: grid; gap: 12px; max-width: 600px;">
    <div>
      <label style="display: block; margin-bottom: 4px; font-size: 12px;">Release Branch</label>
      <input 
        type="text" 
        id="release-branch" 
        value="${escapeHtml(release.releaseBranch)}"
        style="width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;"
        placeholder="release/v1.0.0"
      />
    </div>
    <div>
      <label style="display: block; margin-bottom: 4px; font-size: 12px;">Target Branch</label>
      <input 
        type="text" 
        id="target-branch" 
        value="${escapeHtml(release.targetBranch)}"
        style="width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;"
        placeholder="main"
      />
    </div>
  </div>
</div>`;
}

function renderMergeStep(release: ReleaseDefinition): string {
  return `
<div class="merge-progress">
  <h3>Merging Plans into Release Branch</h3>
  <div id="merge-list" class="merge-list">
    <!-- Merge progress will be populated by JavaScript -->
    <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">
      Preparing to merge ${release.planIds.length} plan(s)...
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
  <div style="padding: 20px; text-align: center;">
    <div style="font-size: 48px; margin-bottom: 16px;">📝</div>
    <div style="margin-bottom: 8px;">Creating PR from <strong>${escapeHtml(release.releaseBranch)}</strong> to <strong>${escapeHtml(release.targetBranch)}</strong></div>
    <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">This may take a moment...</div>
  </div>
</div>`;
}

function renderMonitoringStep(release: ReleaseDefinition): string {
  const prNumber = release.prNumber || '---';
  const prUrl = release.prUrl || '#';
  
  return `
<div class="pr-monitor">
  <h3>PR Monitoring Dashboard</h3>
  <div class="pr-header">
    <span>Pull Request #${prNumber}</span>
    ${prUrl !== '#' ? `<a href="${escapeHtml(prUrl)}" class="pr-link" target="_blank">View on GitHub ↗</a>` : ''}
  </div>
  
  <div class="pr-stats" id="pr-stats">
    <div class="pr-stat-card">
      <div class="pr-stat-value passing" id="checks-passing">0</div>
      <div class="pr-stat-label">Checks Passing</div>
    </div>
    <div class="pr-stat-card">
      <div class="pr-stat-value failing" id="checks-failing">0</div>
      <div class="pr-stat-label">Checks Failing</div>
    </div>
    <div class="pr-stat-card">
      <div class="pr-stat-value pending" id="comments-unresolved">0</div>
      <div class="pr-stat-label">Unresolved Comments</div>
    </div>
    <div class="pr-stat-card">
      <div class="pr-stat-value" id="alerts-unresolved">0</div>
      <div class="pr-stat-label">Security Alerts</div>
    </div>
  </div>
  
  <div id="pr-checks-list" class="pr-checks-list">
    <!-- Checks will be populated by JavaScript -->
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
  
  const icon = isSuccess ? '✅' : (isFailed ? '❌' : '⚠️');
  const title = isSuccess ? 'Release Completed Successfully!' : 
                isFailed ? 'Release Failed' : 
                'Release Canceled';
  const message = isSuccess ? `PR #${release.prNumber || ''} has been merged.` :
                  isFailed ? (release.error || 'An error occurred during the release process.') :
                  'The release was canceled.';
  
  return `
<div class="completion-screen" style="text-align: center; padding: 40px 20px;">
  <div style="font-size: 72px; margin-bottom: 24px;">${icon}</div>
  <h3 style="margin: 0 0 12px 0; font-size: 18px;">${title}</h3>
  <div style="color: var(--vscode-descriptionForeground); margin-bottom: 24px;">${escapeHtml(message)}</div>
  ${release.prUrl ? `<a href="${escapeHtml(release.prUrl)}" class="pr-link" target="_blank" style="font-size: 14px;">View PR on GitHub ↗</a>` : ''}
</div>`;
}

function renderNavigationButtons(release: ReleaseDefinition, stepIndex: number): string {
  const canGoBack = stepIndex > 0 && release.status === 'drafting';
  const canStart = stepIndex === 0 && release.status === 'drafting' && release.planIds.length > 0;
  const canCancel = ['drafting', 'merging', 'creating-pr', 'monitoring', 'addressing'].includes(release.status);
  
  return `
<div>
  ${canGoBack ? '<button class="secondary" onclick="goBack()">← Back</button>' : '<div></div>'}
</div>
<div style="display: flex; gap: 12px;">
  ${canCancel ? '<button class="danger" onclick="cancelRelease()">Cancel Release</button>' : ''}
  ${canStart ? '<button onclick="startRelease()">Start Release →</button>' : ''}
</div>`;
}
