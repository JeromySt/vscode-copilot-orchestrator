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
    case 'agent': {
      const model = (normalized as any).model;
      return { type: 'agent', label: model ? `Agent · ${model}` : 'Agent' };
    }
    case 'process':
      return { type: 'process', label: 'Process' };
    case 'shell': {
      const shell = (normalized as any).shell;
      return { type: 'shell', label: shell ? `Shell · ${shell}` : 'Shell' };
    }
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
    // Render instructions as formatted content with basic markdown support
    html += `<div class="agent-instructions">${renderMarkdownLike(spec.instructions)}</div>`;
  }
  
  // Show metadata below instructions
  const meta: string[] = [];
  if (spec.allowedFolders && spec.allowedFolders.length > 0) {
    meta.push(`<span class="spec-label">Allowed Folders:</span> ${escapeHtml(spec.allowedFolders.join(', '))}`);
  }
  if (spec.allowedUrls && spec.allowedUrls.length > 0) {
    meta.push(`<span class="spec-label">Allowed URLs:</span> ${escapeHtml(spec.allowedUrls.join(', '))}`);
  }
  if (meta.length > 0) {
    html += `<div class="spec-meta">${meta.map(m => `<div class="spec-field">${m}</div>`).join('')}</div>`;
  }
  
  html += '</div>';
  return html;
}

/**
 * Render text with basic markdown-like formatting.
 * Supports: headers (#), bold (**), code blocks (```), inline code (`), lists (- / *), numbered lists.
 */
function renderMarkdownLike(text: string): string {
  const lines = text.split('\n');
  let html = '';
  let inCodeBlock = false;
  let inList = false;
  
  for (const line of lines) {
    // Code block toggle
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        html += '</code></pre>';
        inCodeBlock = false;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<pre class="spec-code"><code>';
        inCodeBlock = true;
      }
      continue;
    }
    
    if (inCodeBlock) {
      html += escapeHtml(line) + '\n';
      continue;
    }
    
    // Headers
    if (line.startsWith('### ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h5>${escapeHtml(line.substring(4))}</h5>`;
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4>${escapeHtml(line.substring(3))}</h4>`;
      continue;
    }
    if (line.startsWith('# ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3>${escapeHtml(line.substring(2))}</h3>`;
      continue;
    }
    
    // List items
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)/);
    if (listMatch) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${formatInline(listMatch[3])}</li>`;
      continue;
    }
    
    // Close list if not a list item
    if (inList && line.trim() === '') {
      html += '</ul>';
      inList = false;
      continue;
    }
    
    // Empty line
    if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }
    
    // Regular paragraph
    html += `<p>${formatInline(line)}</p>`;
  }
  
  if (inCodeBlock) html += '</code></pre>';
  if (inList) html += '</ul>';
  
  return html;
}

/** Format inline markdown: bold, inline code */
function formatInline(text: string): string {
  let result = escapeHtml(text);
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  result = result.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  return result;
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
    <div class="git-info-list">
      ${data.baseBranch ? `
      <div class="git-info-row">
        <span class="git-info-label">Base Branch</span>
        <span class="git-info-value mono">${escapeHtml(data.baseBranch)}</span>
      </div>
      ` : ''}
      ${data.targetBranch ? `
      <div class="git-info-row">
        <span class="git-info-label">Target Branch</span>
        <span class="git-info-value mono">${escapeHtml(data.targetBranch)}</span>
      </div>
      ` : ''}
      ${data.baseCommit ? `
      <div class="git-info-row">
        <span class="git-info-label">Base Commit</span>
        <span class="git-info-value mono">${data.baseCommit.slice(0, 12)}</span>
      </div>
      ` : ''}
      ${data.workCommit && data.workCommit !== data.completedCommit ? `
      <div class="git-info-row">
        <span class="git-info-label">Work Commit</span>
        <span class="git-info-value mono">${data.workCommit.slice(0, 12)}</span>
      </div>
      ` : ''}
      ${data.completedCommit ? `
      <div class="git-info-row">
        <span class="git-info-label">Completed Commit</span>
        <span class="git-info-value mono">${data.completedCommit.slice(0, 12)}</span>
      </div>
      ` : ''}
      ${data.mergedToTarget !== undefined ? `
      <div class="git-info-row">
        <span class="git-info-label">Merged to Target</span>
        <span class="git-info-value">${data.mergedToTarget ? '✅ Yes' : '⏳ Pending'}</span>
      </div>
      ` : ''}
    </div>
    ${data.worktreePath ? `
    <div class="git-info-row" style="margin-top: 8px;">
      <span class="git-info-label">Worktree${data.worktreeCleanedUp ? ' (cleaned up)' : ' (detached HEAD)'}</span>
      <span class="git-info-value mono" style="${data.worktreeCleanedUp ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${escapeHtml(data.worktreePath)}</span>
    </div>
    ` : ''}
  </div>`;
}
