/**
 * @fileoverview Plan detail webview scripts template.
 *
 * Thin orchestrator that imports bundled webview controls and wires
 * view-specific logic via focused sub-modules.
 *
 * @module ui/templates/planDetail/scriptsTemplate
 */

import { renderMermaidInit, renderZoomPan, renderControlWiring } from './scripts';

/**
 * Input data for rendering the webview script block.
 */
export interface PlanScriptsData {
  /** JSON-serialisable node data (sanitizedId → node info) */
  nodeData: Record<string, { nodeId: string; planId: string; type: string; name: string; startedAt?: number; endedAt?: number; status: string; version: number }>;
  /** Tooltip map (sanitizedId → full name) for truncated labels */
  nodeTooltips: Record<string, string>;
  /** Raw Mermaid diagram definition */
  mermaidDef: string;
  /** Edge data for incremental edge coloring */
  edgeData: Array<{ index: number; from: string; to: string; isLeafToTarget?: boolean }>;
  /** Global capacity stats (may be null) */
  globalCapacityStats: { thisInstanceJobs: number; totalGlobalJobs: number; globalMaxParallel: number; activeInstances: number } | null;
  /** Timeline data for the timeline chart */
  timelineData: {
    planStartedAt?: number;
    planEndedAt?: number;
    nodes: Array<{
      nodeId: string;
      name: string;
      group?: string;
      status: string;
      scheduledAt?: number;
      startedAt?: number;
      endedAt?: number;
      attempts?: Array<{
        attemptNumber: number;
        status: string;
        startedAt?: number;
        endedAt?: number;
        failedPhase?: string;
      }>;
    }>;
  };
}

/**
 * Render the webview `<script>` block for the plan detail view.
 *
 * Orchestrates bundled controls from window.Orca and view-specific logic
 * from sub-modules (mermaidInit, zoomPan, controlWiring).
 *
 * @param data - Scripts input data.
 * @returns HTML `<script>…</script>` string.
 */
export function renderPlanScripts(data: PlanScriptsData): string {
  return `<script>
    // ── Data Injection ──────────────────────────────────────────────────
    const vscode = acquireVsCodeApi();
    const nodeData = ${JSON.stringify(data.nodeData)};
    const nodeTooltips = ${JSON.stringify(data.nodeTooltips)};
    const mermaidDef = ${JSON.stringify(data.mermaidDef)};
    const edgeData = ${JSON.stringify(data.edgeData)};
    const initialGlobalCapacity = ${JSON.stringify(data.globalCapacityStats)};
    var timelineData = ${JSON.stringify(data.timelineData)};

    // ── Destructure from Bundle ─────────────────────────────────────────
    const { EventBus, SubscribableControl, Topics } = window.Orca;

    // Global bus instance
    var bus = new EventBus();

    // ── Button Handlers (called by onclick attributes) ──────────────────
    function cancelPlan() { vscode.postMessage({ type: 'cancel' }); }
    function pausePlan() { vscode.postMessage({ type: 'pause' }); }
    function resumePlan() { vscode.postMessage({ type: 'resume' }); }
    function deletePlan() { vscode.postMessage({ type: 'delete' }); }
    function refresh() { vscode.postMessage({ type: 'refresh' }); }
    function showWorkSummary() { vscode.postMessage({ type: 'showWorkSummary' }); }

    // ── View-Specific Wiring ────────────────────────────────────────────
    
    ${renderZoomPan()}
    
    ${renderMermaidInit(data)}
    
    ${renderControlWiring(data)}
  </script>`;
}
