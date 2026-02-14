/**
 * @fileoverview Config display control — shows job specification.
 *
 * Subscribes to {@link Topics.NODE_STATE_CHANGE} and updates the
 * configuration section with task, work spec, and instructions.
 *
 * @module ui/webview/controls/configDisplay
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { escapeHtml } from '../../templates/helpers';

/** Represents a job spec (work, prechecks, or postchecks) */
export interface JobSpec {
  type?: 'agent' | 'shell' | 'process' | string;
  instructions?: string;
  command?: string;
  executable?: string;
  args?: string[];
  shell?: string;
  model?: string;
  allowedFolders?: string[];
  allowedUrls?: string[];
  [key: string]: any;
}

/** Data delivered with each config update. */
export interface ConfigDisplayData {
  task: string;
  work?: JobSpec | string;
  prechecks?: JobSpec | string;
  postchecks?: JobSpec | string;
  instructions?: string;
  currentPhase?: string;
  status?: string;
}



/**
 * Config display control for job specifications.
 */
export class ConfigDisplay extends SubscribableControl {
  private elementId: string;
  private userExpanded: { [phase: string]: boolean } = {};

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.subscribe(Topics.CONFIG_UPDATE, (data?: ConfigDisplayData) => this.update(data));
    this.subscribe(Topics.NODE_STATE_CHANGE, (data?: ConfigDisplayData) => this.handleStateChange(data));
  }

  private handleStateChange(data?: ConfigDisplayData): void {
    // Handle auto-expand logic when phase changes
    if (data?.currentPhase) {
      this.autoExpandPhase(data.currentPhase);
    }
  }

  private autoExpandPhase(currentPhase: string): void {
    // Only auto-expand if user hasn't manually toggled
    if (this.userExpanded[currentPhase] !== undefined) return;

    // Collapse all auto-expanded phases
    ['prechecks', 'postchecks'].forEach(phase => {
      if (phase !== currentPhase && this.userExpanded[phase] === undefined) {
        this.setPhaseExpanded(phase, false);
      }
    });

    // Auto-expand current phase
    if (currentPhase === 'prechecks' || currentPhase === 'postchecks') {
      this.setPhaseExpanded(currentPhase, true);
    }
  }

  private setPhaseExpanded(phase: string, expanded: boolean): void {
    const header = this.getElement(`config-phase-${phase}-header`);
    const body = this.getElement(`config-phase-${phase}-body`);
    const chevron = header?.querySelector('.chevron');

    if (!header || !body) return;

    if (expanded) {
      body.style.display = 'block';
      header.classList.replace('collapsed', 'expanded');
      if (chevron) chevron.textContent = '▼';
    } else {
      body.style.display = 'none';
      header.classList.replace('expanded', 'collapsed');
      if (chevron) chevron.textContent = '▶';
    }
  }

  update(data?: ConfigDisplayData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    el.innerHTML = this.renderConfig(data);
    
    // Apply auto-expand logic
    if (data.currentPhase) {
      setTimeout(() => this.autoExpandPhase(data.currentPhase!), 0);
    }

    this.publishUpdate(data);
  }

  private renderConfig(data: ConfigDisplayData): string {
    let html = `<div class="config-item"><div class="config-label">Task</div><div class="config-value">${escapeHtml(data.task)}</div></div>`;

    // Render prechecks phase (collapsible, collapsed by default)
    if (data.prechecks !== undefined && data.prechecks !== null) {
      html += this.renderPhase('prechecks', 'Prechecks', data.prechecks, true);
    }

    // Render work phase (always expanded, not collapsible)
    if (data.work !== undefined && data.work !== null) {
      html += this.renderPhase('work', 'Work', data.work, false);
    }

    // Render postchecks phase (collapsible, collapsed by default)
    if (data.postchecks !== undefined && data.postchecks !== null) {
      html += this.renderPhase('postchecks', 'Postchecks', data.postchecks, true);
    }

    if (data.instructions) {
      html += `<div class="config-item"><div class="config-label">Instructions</div><div class="config-value">${escapeHtml(data.instructions)}</div></div>`;
    }

    return html;
  }

  private renderPhase(phaseKey: string, phaseLabel: string, spec: JobSpec | string, collapsible: boolean): string {
    const typeInfo = this.getSpecTypeInfo(spec);
    const specHtml = this.renderSpecContent(spec);
    
    if (collapsible) {
      return `
        <div class="config-phase">
          <div class="config-phase-header collapsed" id="config-phase-${phaseKey}-header" data-phase="${phaseKey}">
            <span class="chevron">▶</span>
            <span class="phase-label">${phaseLabel}</span>
            <span class="phase-type-badge ${typeInfo.type.toLowerCase()}">${typeInfo.label}</span>
          </div>
          <div class="config-phase-body" id="config-phase-${phaseKey}-body" style="display:none">
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

  private getSpecTypeInfo(spec: JobSpec | string): { type: string; label: string } {
    if (typeof spec === 'string') {
      return { type: 'shell', label: 'Shell' };
    }

    switch (spec.type) {
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

  private renderSpecContent(spec: JobSpec | string): string {
    if (typeof spec === 'string') {
      return `<div class="spec-content"><pre class="spec-code"><code>${escapeHtml(spec)}</code></pre></div>`;
    }

    switch (spec.type) {
      case 'agent':
        return this.renderAgentSpec(spec);
      case 'process':
        return this.renderProcessSpec(spec);
      case 'shell':
        return this.renderShellSpec(spec);
      default:
        return `<div class="spec-content"><pre class="spec-code"><code>${escapeHtml(JSON.stringify(spec, null, 2))}</code></pre></div>`;
    }
  }

  private renderAgentSpec(spec: JobSpec): string {
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

  private renderProcessSpec(spec: JobSpec): string {
    const args = spec.args?.join(' ') || '';
    const command = `${spec.executable || ''} ${args}`.trim();
    
    return `<div class="spec-content">
      <div class="spec-field"><span class="spec-label">Command:</span> <pre class="spec-code"><code>${escapeHtml(command)}</code></pre></div>
    </div>`;
  }

  private renderShellSpec(spec: JobSpec): string {
    const shellLabel = spec.shell ? ` (${spec.shell})` : '';
    
    return `<div class="spec-content">
      <div class="spec-field"><span class="spec-label">Command${shellLabel}:</span> <pre class="spec-code"><code>${escapeHtml(spec.command || '')}</code></pre></div>
    </div>`;
  }
}
