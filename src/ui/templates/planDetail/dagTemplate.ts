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
  <h3 style="display:flex;align-items:center;gap:6px;margin:16px 0 8px 0;font-size:14px;color:var(--vscode-foreground);">
    <svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle;"><circle cx="4" cy="8" r="2.5" fill="currentColor"/><circle cx="12" cy="4" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><line x1="6.5" y1="7" x2="9.5" y2="5" stroke="currentColor" stroke-width="1.2"/><line x1="6.5" y1="9" x2="9.5" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>
    DAG
  </h3>
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

  return html;
}
