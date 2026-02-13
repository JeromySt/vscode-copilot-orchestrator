/**
 * @fileoverview Job configuration HTML template for node detail panel.
 *
 * Generates HTML for the job configuration section showing task,
 * work spec, and instructions.
 *
 * @module ui/templates/nodeDetail/configTemplate
 */

import { escapeHtml } from '../helpers';

/**
 * Input data for the config section.
 */
export interface ConfigData {
  /** Job task description */
  task: string;
  /** Pre-rendered work spec HTML */
  workHtml?: string;
  /** Job instructions text */
  instructions?: string;
}

/**
 * Render the job configuration section.
 *
 * @param data - Configuration input data.
 * @returns HTML fragment string for the job config section.
 */
export function configSectionHtml(data: ConfigData): string {
  return `<!-- Job Configuration -->
  <div class="section">
    <h3>Job Configuration</h3>
    <div class="config-item">
      <div class="config-label">Task</div>
      <div class="config-value">${escapeHtml(data.task)}</div>
    </div>
    ${data.workHtml ? `
    <div class="config-item work-item">
      <div class="config-label">Work</div>
      <div class="config-value work-content">${data.workHtml}</div>
    </div>
    ` : ''}
    ${data.instructions ? `
    <div class="config-item">
      <div class="config-label">Instructions</div>
      <div class="config-value">${escapeHtml(data.instructions)}</div>
    </div>
    ` : ''}
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
}): string {
  if (!data.worktreePath && !data.baseCommit && !data.completedCommit) return '';

  return `<!-- Git Information -->
  <div class="section">
    <h3>Git Information</h3>
    <div class="meta-grid">
      ${data.baseCommit ? `
      <div class="meta-item">
        <div class="meta-label">Base Commit</div>
        <div class="meta-value mono">${data.baseCommit.slice(0, 12)}</div>
      </div>
      ` : ''}
      ${data.completedCommit ? `
      <div class="meta-item">
        <div class="meta-label">Completed Commit</div>
        <div class="meta-value mono">${data.completedCommit.slice(0, 12)}</div>
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
