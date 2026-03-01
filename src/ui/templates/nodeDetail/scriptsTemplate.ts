/**
 * @fileoverview Webview JavaScript template for node detail panel.
 *
 * Generates the `<script>` block content for the node detail webview.
 * Uses bundled TypeScript controls from window.Orca instead of inline code.
 * All updates are event-driven: incoming postMessages are routed to an
 * EventBus, and SubscribableControl subclasses subscribe to relevant topics.
 *
 * @module ui/templates/nodeDetail/scriptsTemplate
 */

import { renderMessageRouter } from './scripts/messageRouter';
import { renderControlWiring } from './scripts/controlWiring';
import { renderEventHandlers } from './scripts/eventHandlers';

/**
 * Configuration parameters for the webview scripts.
 */
export interface ScriptsConfig {
  /** The Plan ID (JSON-safe string) */
  planId: string;
  /** The Node ID (JSON-safe string) */
  nodeId: string;
  /** Previously selected phase, or null */
  currentPhase: string | null;
  /** Phase to show on initial load */
  initialPhase: string | null;
  /** Current node status */
  nodeStatus: string;
}

/**
 * Generate the complete webview script block content.
 *
 * Uses bundled controls from window.Orca (EventBus, Topics, controls).
 * Incoming extension postMessages are routed to bus topics.
 * Controls extend SubscribableControl and subscribe to the bus.
 * No setInterval/setTimeout is used.
 *
 * @param config - Configuration parameters for script generation.
 * @returns The script block content as a string (without script tags).
 */
export function webviewScripts(config: ScriptsConfig): string {
  return `
    // Destructure bundled controls from window.Orca
    const { EventBus, Topics, StatusBadge, DurationCounter, LogViewer, ProcessTree, PhaseTabBar, AttemptCard, AiUsageStats, WorkSummary, ConfigDisplay } = window.Orca;

    // Initialize vscode API and constants
    var vscode = acquireVsCodeApi();
    var PLAN_ID = ${JSON.stringify(config.planId)};
    var NODE_ID = ${JSON.stringify(config.nodeId)};
    var currentPhase = ${config.currentPhase ? JSON.stringify(config.currentPhase) : 'null'};
    var initialPhase = ${config.initialPhase ? JSON.stringify(config.initialPhase) : 'null'};

    // Create global EventBus instance
    var bus = new EventBus();

    ${renderMessageRouter()}

    ${renderControlWiring(config)}

    ${renderEventHandlers(config)}
  `;
}
