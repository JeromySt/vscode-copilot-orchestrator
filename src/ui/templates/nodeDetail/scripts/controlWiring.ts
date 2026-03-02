/**
 * @fileoverview Control wiring for node detail webview.
 * Instantiates and wires all controls to DOM elements.
 * 
 * @module ui/templates/nodeDetail/scripts/controlWiring
 */

import type { ScriptsConfig } from '../scriptsTemplate';

/**
 * Render control wiring code that instantiates all controls and binds them to DOM.
 * 
 * @param config - Configuration parameters for control initialization
 * @returns JavaScript code as a string
 */
export function renderControlWiring(config: ScriptsConfig): string {
  return `
    // Instantiate all controls
    var statusBadge = new StatusBadge(bus, 'nd-status-badge', 'node-status-badge');
    var durationCounter = new DurationCounter(bus, 'nd-duration', 'duration-timer');
    var logViewer = new LogViewer(bus, 'nd-log-viewer', 'logViewer');
    var processTree = new ProcessTree(bus, 'nd-process-tree', 'processTree', 'processTreeTitle');
    var phaseTabBar = new PhaseTabBar(bus, 'nd-phase-tabs', 'phaseTabs');
    var attemptList = new AttemptCard(bus, 'nd-attempt-list', '.attempt-history-container');
    var aiUsageStats = new AiUsageStats(bus, 'nd-ai-usage', 'aiUsageStatsContainer');
    var workSummaryCtrl = new WorkSummary(bus, 'nd-work-summary', 'workSummaryContainer');
    var configDisplay = new ConfigDisplay(bus, 'nd-config-display', 'configDisplayContainer');
  `;
}
