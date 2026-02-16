/**
 * @fileoverview Process tree HTML template for node detail panel.
 *
 * Generates the initial HTML shell for the process tree section.
 * The actual process tree content is rendered client-side via JavaScript.
 *
 * @module ui/templates/nodeDetail/processTreeTemplate
 */

/**
 * Input data for the process tree section.
 */
export interface ProcessTreeData {
  /** Current node status */
  status: string;
}

/**
 * Render the process tree section shell.
 *
 * Only renders for running or scheduled nodes. The actual tree content
 * is populated client-side via postMessage responses.
 *
 * @param data - Process tree input data.
 * @returns HTML fragment string, or empty string if not applicable.
 */
export function processTreeSectionHtml(data: ProcessTreeData): string {
  if (data.status !== 'running' && data.status !== 'scheduled') {return '';}

  return `<!-- Process Tree (only for running jobs) -->
  <div class="section process-tree-section" id="processTreeSection">
    <div class="process-tree-header" data-expanded="true">
      <span class="process-tree-chevron">▼</span>
      <span class="process-tree-icon">⚡</span>
      <span class="process-tree-title" id="processTreeTitle">Running Processes</span>
    </div>
    <div class="process-tree" id="processTree">
      <div class="process-loading">Loading process tree...</div>
    </div>
  </div>`;
}
