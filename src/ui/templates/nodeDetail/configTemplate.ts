/**
 * @fileoverview Job configuration HTML template for node detail panel.
 *
 * Generates HTML for the job configuration section showing task,
 * work spec, prechecks, postchecks with collapsible sections.
 *
 * @module ui/templates/nodeDetail/configTemplate
 */

import { escapeHtml } from '../helpers';
import { WorkSpec, normalizeWorkSpec } from '../../../plan/types/specs';

/**
 * Input data for the config section.
 */
export interface ConfigData {
  /** Job task description */
  task: string;
  /** Pre-rendered work spec HTML */
  workHtml?: string;
  /** Work spec (raw) */
  work?: WorkSpec;
  /** Prechecks spec */
  prechecks?: WorkSpec;
  /** Postchecks spec */
  postchecks?: WorkSpec;
  /** Job instructions text */
  instructions?: string;
  /** Current execution phase */
  currentPhase?: string;
}

/**
 * Get spec type info for badge display
 */
export function getSpecTypeInfo(spec: WorkSpec | undefined): { type: string; label: string } {
  if (!spec) return { type: 'none', label: 'None' };
  
  if (typeof spec === 'string') {
    return { type: 'shell', label: 'Shell' };
  }

  const normalized = normalizeWorkSpec(spec);
  if (!normalized) return { type: 'none', label: 'None' };

  switch (normalized.type) {
    case 'agent':
      return { type: 'agent', label: 'Agent' };
    case 'process':
      return { type: 'process', label: 'Process' };
    case 'shell':
      return { type: 'shell', label: 'Shell' };
    default:
      return { type: 'unknown', label: 'Unknown' };
  }
}

/**
 * Render spec content as HTML
 */
export function renderSpecContent(spec: WorkSpec | undefined): string {
  if (!spec) return '<div class="spec-empty">No specification defined</div>';
  
  if (typeof spec === 'string') {
    return `<div class="spec-content"><pre class="spec-code"><code>${escapeHtml(spec)}</code></pre></div>`;
  }

  const normalized = normalizeWorkSpec(spec);
  if (!normalized) return '<div class="spec-empty">Invalid specification</div>';

  switch (normalized.type) {
    case 'agent':
      return renderAgentSpec(normalized);
    case 'process':
      return renderProcessSpec(normalized);
    case 'shell':
      return renderShellSpec(normalized);
    default:
      return `<div class="spec-content"><pre class="spec-code"><code>${escapeHtml(JSON.stringify(spec, null, 2))}</code></pre></div>`;
  }
}

function renderAgentSpec(spec: any): string {
  let html = '<div class="spec-content spec-agent">';
  
  if (spec.instructions) {
    const truncated = spec.instructions.length > 200 ? 
      spec.instructions.substring(0, 200) + '...' : 
      spec.instructions;
    html += `<div class="spec-field"><span class="spec-label">Instructions:</span> <span class="spec-value">${escapeHtml(truncated)}</span></div>`;
  }
  
  if (spec.model) {
    html += `<div class="spec-field"><span class="spec-label">Model:</span> <span class="spec-value">${escapeHtml(spec.model)}</span></div>`;
  }
  
  if (spec.allowedFolders && spec.allowedFolders.length > 0) {
    html += `<div class="spec-field"><span class="spec-label">Allowed Folders:</span> <span class="spec-value">${escapeHtml(spec.allowedFolders.join(', '))}</span></div>`;
  }
  
  if (spec.allowedUrls && spec.allowedUrls.length > 0) {
    html += `<div class="spec-field"><span class="spec-label">Allowed URLs:</span> <span class="spec-value">${escapeHtml(spec.allowedUrls.join(', '))}</span></div>`;
  }
  
  html += '</div>';
  return html;
}

function renderProcessSpec(spec: any): string {
  const args = spec.args?.join(' ') || '';
  const command = `${spec.executable || ''} ${args}`.trim();
  
  return `<div class="spec-content">
    <div class="spec-field"><span class="spec-label">Command:</span> <pre class="spec-code"><code>${escapeHtml(command)}</code></pre></div>
  </div>`;
}

function renderShellSpec(spec: any): string {
  const shellLabel = spec.shell ? ` (${spec.shell})` : '';
  
  return `<div class="spec-content">
    <div class="spec-field"><span class="spec-label">Command${shellLabel}:</span> <pre class="spec-code"><code>${escapeHtml(spec.command || '')}</code></pre></div>
  </div>`;
}

/**
 * Render a phase section (prechecks, work, or postchecks)
 */
function renderPhase(phaseKey: string, phaseLabel: string, spec: WorkSpec | undefined, collapsible: boolean): string {
  const typeInfo = getSpecTypeInfo(spec);
  const specHtml = renderSpecContent(spec);
  
  if (collapsible) {
    return `
      <div class="config-phase">
        <div class="config-phase-header collapsed" data-phase="${phaseKey}">
          <span class="chevron">▶</span>
          <span class="phase-label">${phaseLabel}</span>
          <span class="phase-type-badge ${typeInfo.type.toLowerCase()}">${typeInfo.label}</span>
        </div>
        <div class="config-phase-body" style="display:none">
          ${specHtml}
        </div>
      </div>
    `;
  } else {
    return `
      <div class="config-phase">
        <div class="config-phase-header non-collapsible">
          <span class="phase-label">${phaseLabel}</span>
          <span class="phase-type-badge ${typeInfo.type.toLowerCase()}">${typeInfo.label}</span>
        </div>
        <div class="config-phase-body">
          ${specHtml}
        </div>
      </div>
    `;
  }
}

/**
 * Render the job configuration section.
 *
 * @param data - Configuration input data.
 * @returns HTML fragment string for the job config section.
 */
export function configSectionHtml(data: ConfigData): string {
  let configContent = `
    <div class="config-item">
      <div class="config-label">Task</div>
      <div class="config-value">${escapeHtml(data.task)}</div>
    </div>
  `;

  // Add phase sections
  configContent += '<div class="config-phases">';

  // Prechecks phase (collapsible, collapsed by default)
  if (data.prechecks !== undefined && data.prechecks !== null) {
    configContent += renderPhase('prechecks', 'Prechecks', data.prechecks, true);
  }

  // Work phase (always expanded, not collapsible)
  if (data.work !== undefined && data.work !== null) {
    configContent += renderPhase('work', 'Work', data.work, false);
  } else if (data.workHtml) {
    // Backwards compatibility with existing workHtml
    configContent += `
      <div class="config-phase">
        <div class="config-phase-header non-collapsible">
          <span class="phase-label">Work</span>
          <span class="phase-type-badge">spec</span>
        </div>
        <div class="config-phase-body">
          <div class="config-value work-content">${data.workHtml}</div>
        </div>
      </div>
    `;
  }

  // Postchecks phase (collapsible, collapsed by default)
  if (data.postchecks !== undefined && data.postchecks !== null) {
    configContent += renderPhase('postchecks', 'Postchecks', data.postchecks, true);
  }

  configContent += '</div>';

  // Instructions (if provided)
  if (data.instructions) {
    configContent += `
      <div class="config-item">
        <div class="config-label">Instructions</div>
        <div class="config-value">${escapeHtml(data.instructions)}</div>
      </div>
    `;
  }

  return `<!-- Job Configuration -->
  <div class="section">
    <h3>Job Configuration</h3>
    ${configContent}
  </div>`;
}

/**
 * Render the dependencies section.
 *
 * @param dependencies - Array of dependency info objects.
 * @returns HTML fragment string for the dependencies section.
 */
export function dependenciesSectionHtml(dependencies: Array<{ name: string; status: string }>): string {
  return `<!-- Dependencies -->
  <div class="section">
    <h3>Dependencies</h3>
    ${dependencies.length > 0 ? `
    <div class="deps-list">
      ${dependencies.map(dep =>
        `<span class="dep-badge ${dep.status}">${escapeHtml(dep.name)}</span>`
      ).join('')}
    </div>
    ` : '<div class="config-value">No dependencies (root node)</div>'}
  </div>`;
}

/**
 * Render the git information section.
 *
 * @param data - Git-related state data.
 * @returns HTML fragment string, or empty string if no git info available.
 */
export function gitInfoSectionHtml(data: {
  worktreePath?: string;
  worktreeCleanedUp?: boolean;
  baseCommit?: string;
  completedCommit?: string;
  workCommit?: string;      // NEW: last work commit before merge (typically same as completedCommit)
  baseBranch?: string;      // NEW
  targetBranch?: string;    // NEW
  mergedToTarget?: boolean; // NEW
}): string {
  if (!data.worktreePath && !data.baseCommit && !data.completedCommit && !data.workCommit && !data.baseBranch && !data.targetBranch && data.mergedToTarget === undefined) return '';

  return `<!-- Git Information -->
  <div class="section">
    <h3>Git Information</h3>
    <div class="meta-grid">
      ${data.baseBranch ? `
      <div class="meta-item">
        <div class="meta-label">Base Branch</div>
        <div class="meta-value mono">${escapeHtml(data.baseBranch)}</div>
      </div>
      ` : ''}
      ${data.targetBranch ? `
      <div class="meta-item">
        <div class="meta-label">Target Branch</div>
        <div class="meta-value mono">${escapeHtml(data.targetBranch)}</div>
      </div>
      ` : ''}
      ${data.baseCommit ? `
      <div class="meta-item">
        <div class="meta-label">Base Commit</div>
        <div class="meta-value mono">${data.baseCommit.slice(0, 12)}</div>
      </div>
      ` : ''}
      ${data.workCommit && data.workCommit !== data.completedCommit ? `
      <div class="meta-item">
        <div class="meta-label">Work Commit</div>
        <div class="meta-value mono">${data.workCommit.slice(0, 12)}</div>
      </div>
      ` : ''}
      ${data.completedCommit ? `
      <div class="meta-item">
        <div class="meta-label">Completed Commit</div>
        <div class="meta-value mono">${data.completedCommit.slice(0, 12)}</div>
      </div>
      ` : ''}
      ${data.mergedToTarget !== undefined ? `
      <div class="meta-item">
        <div class="meta-label">Merged to Target</div>
        <div class="meta-value">${data.mergedToTarget ? '✅ Yes' : '⏳ Pending'}</div>
      </div>
      ` : ''}
    </div>
    ${data.worktreePath ? `
    <div class="config-item">
      <div class="config-label">Worktree${data.worktreeCleanedUp ? ' (cleaned up)' : ' (detached HEAD)'}</div>
      <div class="config-value mono" style="${data.worktreeCleanedUp ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${escapeHtml(data.worktreePath)}</div>
    </div>
    ` : ''}
  </div>`;
}
