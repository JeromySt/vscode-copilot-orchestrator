/**
 * @fileoverview Plan detail DAG visualization template.
 *
 * Renders the Mermaid diagram container, zoom controls, and status legend
 * for the plan detail view.
 *
 * @module ui/templates/planDetail/dagTemplate
 */

/**
 * Input data for rendering the DAG visualization section.
 */
export interface PlanDagData {
  /** The Mermaid diagram definition string */
  mermaidDef: string;
  /** Computed plan status */
  status: string;
  /** Snapshot info (when snapshot-based RI merge is active) */
  snapshot?: {
    branch: string;
    baseCommit: string;
    mergedLeaves: number;
    totalLeaves: number;
    awaitingFinalMerge: boolean;
    planStatus: string;
  };
}

/**
 * Render the DAG visualization section HTML fragment.
 *
 * Includes zoom controls (zoom in/out, reset, fit), a status legend,
 * and the Mermaid `<pre>` block that is rendered client-side.
 *
 * @param data - DAG input data.
 * @returns HTML fragment string for the diagram section.
 */
export function renderPlanDag(data: PlanDagData): string {
  const { mermaidDef, status } = data;

  let html = `
  <div id="mermaid-diagram">
    <div class="zoom-controls">
      <button class="zoom-btn" onclick="zoomOut()" title="Zoom Out">−</button>
      <span class="zoom-level" id="zoomLevel">100%</span>
      <button class="zoom-btn" onclick="zoomIn()" title="Zoom In">+</button>
      <button class="zoom-btn" onclick="zoomReset()" title="Reset Zoom">⟲</button>
      <button class="zoom-btn" onclick="zoomFit()" title="Fit to View">⊡</button>
    </div>
    <div class="legend" id="dagLegend">
      <span class="legend-title legend-toggle" onclick="document.getElementById('dagLegend').classList.toggle('collapsed')">Legend</span>
      <div class="legend-items">
        <div class="legend-item">
          <span class="legend-icon pending">○</span>
          <span>Pending</span>
        </div>
        <div class="legend-item">
          <span class="legend-icon running">▶</span>
          <span>Running</span>
        </div>
        <div class="legend-item">
          <span class="legend-icon succeeded">✓</span>
          <span>Succeeded</span>
        </div>
        <div class="legend-item">
          <span class="legend-icon failed">✗</span>
          <span>Failed</span>
        </div>
        <div class="legend-item">
          <span class="legend-icon blocked">⊘</span>
          <span>Blocked</span>
        </div>
      </div>
    </div>
    <div class="mermaid-container" id="mermaidContainer">
      <pre class="mermaid">
${mermaidDef}
      </pre>
    </div>
  </div>
  `;

  // Snapshot Status card (between diagram and processes)
  if (data.snapshot) {
    const s = data.snapshot;
    const allMerged = s.mergedLeaves === s.totalLeaves;
    const progressPct = s.totalLeaves > 0 ? Math.round((s.mergedLeaves / s.totalLeaves) * 100) : 0;

    let statusIcon: string;
    let statusText: string;
    let statusColor: string;
    if (s.awaitingFinalMerge) {
      statusIcon = '✗'; statusText = 'Awaiting Manual Merge'; statusColor = '#f48771';
    } else if (s.planStatus === 'succeeded') {
      statusIcon = '✓'; statusText = 'Merged to Target'; statusColor = '#4ec9b0';
    } else if (allMerged) {
      statusIcon = '▶'; statusText = 'Final Merge In Progress'; statusColor = '#3794ff';
    } else if (s.mergedLeaves > 0) {
      statusIcon = '▶'; statusText = 'Accumulating Leaf Merges'; statusColor = '#3794ff';
    } else {
      statusIcon = '○'; statusText = 'Waiting for Leaves'; statusColor = '#858585';
    }

    html += `
  <div class="snapshot-status-card" style="margin:12px 0;padding:12px 16px;border:1px solid ${statusColor};border-radius:6px;background:var(--vscode-editor-background)">
    <h3 style="margin:0 0 8px 0;font-size:13px;color:${statusColor}">📦 Snapshot RI Merge</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:12px">
      <div style="color:var(--vscode-descriptionForeground)">Status</div>
      <div><span style="color:${statusColor}">${statusIcon}</span> ${statusText}</div>
      <div style="color:var(--vscode-descriptionForeground)">Branch</div>
      <div style="font-family:var(--vscode-editor-font-family);font-size:11px">${s.branch}</div>
      <div style="color:var(--vscode-descriptionForeground)">Base Commit</div>
      <div style="font-family:var(--vscode-editor-font-family);font-size:11px">${s.baseCommit.slice(0, 8)}</div>
      <div style="color:var(--vscode-descriptionForeground)">Leaf Progress</div>
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:6px;background:var(--vscode-progressBar-background, #3c3c3c);border-radius:3px;overflow:hidden">
            <div style="width:${progressPct}%;height:100%;background:${statusColor};border-radius:3px;transition:width 0.3s"></div>
          </div>
          <span>${s.mergedLeaves}/${s.totalLeaves}</span>
        </div>
      </div>
    </div>
  </div>
    `;
  }

  if (status === 'running') {
    html += `
  <!-- Running Processes -->
  <div class="processes-section" id="processesSection">
    <h3>Running Processes</h3>
    <div id="processesContainer">
      <div class="processes-loading">Loading processes...</div>
    </div>
  </div>
  `;
  } else {
    // Render hidden — the script layer will show it once the plan transitions to running
    html += `
  <div class="processes-section" id="processesSection" style="display:none;">
    <h3>Running Processes</h3>
    <div id="processesContainer">
      <div class="processes-loading">Loading processes...</div>
    </div>
  </div>
  `;
  }

  return html;
}
