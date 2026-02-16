/**
 * @fileoverview Plan Detail Panel
 * 
 * Shows detailed view of a Plan with:
 * - Mermaid diagram of the Plan structure
 * - Node status with real-time updates
 * - Progress tracking
 * - Actions (cancel, etc.)
 * 
 * @module ui/panels/planDetailPanel
 */

import * as vscode from 'vscode';
import { PlanRunner, PlanInstance, PlanNode, JobNode, NodeStatus, NodeExecutionState, computeMergedLeafWorkSummary, normalizeWorkSpec } from '../../plan';
import { escapeHtml, formatDurationMs, errorPageHtml, commitDetailsHtml, workSummaryStatsHtml } from '../templates';
import { renderWorkSummaryPanelHtml } from '../templates/workSummaryPanel';
import type { WorkSummaryPanelData, WsPanelJob, WsJourneyNode } from '../templates/workSummaryPanel';
import { getPlanMetrics, formatPremiumRequests, formatDurationSeconds, formatCodeChanges, formatTokenCount } from '../../plan/metricsAggregator';
import { renderPlanHeader, renderPlanControls, renderPlanDag, renderPlanNodeCard, renderPlanSummary, renderMetricsBar, renderPlanScripts } from '../templates/planDetail';
import type { PlanSummaryData, PlanMetricsBarData } from '../templates/planDetail';
import { PlanDetailController } from './planDetailController';
import type { PlanDetailDelegate } from './planDetailController';
import type { IDialogService } from '../../interfaces/IDialogService';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';

/**
 * Webview panel that shows a detailed view of a single Plan's execution.
 *
 * Displays a Mermaid-based DAG diagram of the Plan's node structure, real-time
 * node status updates, progress tracking, branch/merge flow, work summary
 * (commit/file stats), and action buttons (cancel, delete).
 *
 * Only one panel is created per Plan ID — subsequent calls to
 * {@link createOrShow} reveal the existing panel.
 *
 * **Webview → Extension messages:**
 * - `{ type: 'cancel' }` — cancel the Plan
 * - `{ type: 'delete' }` — delete the Plan
 * - `{ type: 'openNode', nodeId: string, planId?: string }` — open a {@link NodeDetailPanel}
 * - `{ type: 'openNode', nodeId, planId }` — open a node detail panel
 * - `{ type: 'refresh' }` — request a manual data refresh
 * - `{ type: 'showWorkSummary' }` — open work summary in a separate webview panel
 * - `{ type: 'getAllProcessStats' }` — request process tree statistics
 *
 * **Extension → Webview messages:**
 * - Full HTML re-render via `webview.html` on each update cycle
 * - `{ type: 'allProcessStats', flat, hierarchy, rootJobs }` — process stats response
 *
 * @see {@link NodeDetailPanel} for per-node detail views
 */
export class planDetailPanel {
  private static panels = new Map<string, planDetailPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _planId: string;
  private _disposables: vscode.Disposable[] = [];
  private _pulseSubscription?: PulseDisposable;
  private _lastStateVersion: number = -1;
  private _lastStructureHash: string = '';
  private _isFirstRender: boolean = true;
  private readonly _controller: PlanDetailController;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param planId - Unique identifier of the Plan to display.
   * @param _planRunner - The {@link PlanRunner} instance for querying Plan/node state.
   * @param dialogService - Abstraction over VS Code dialog APIs.
   * @param _pulse - Pulse emitter for periodic updates.
   */
  private constructor(
    panel: vscode.WebviewPanel,
    planId: string,
    private _planRunner: PlanRunner,
    dialogService: IDialogService,
    private _pulse: IPulseEmitter
  ) {
    this._panel = panel;
    this._planId = planId;
    
    // Build the delegate that bridges controller → VS Code APIs
    const delegate: PlanDetailDelegate = {
      executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args) as Promise<void>,
      postMessage: (msg) => this._panel.webview.postMessage(msg),
      forceFullRefresh: () => this._forceFullRefresh(),
      showWorkSummaryDocument: () => this._showWorkSummaryDocument(),
      sendAllProcessStats: () => this._sendAllProcessStats(),
      openFile: (relativePath) => {
        const plan = this._planRunner.get(this._planId);
        if (plan) {
          const fileUri = vscode.Uri.file(require('path').join(plan.repoPath, relativePath));
          vscode.window.showTextDocument(fileUri, { preview: true }).then(undefined, () => { /* file may not exist */ });
        }
      },
    };
    this._controller = new PlanDetailController(planId, dialogService, delegate);
    
    // Initial render
    this._update();
    
    // Subscribe to plan runner events for live state updates
    const onNodeTransition = (event: any) => {
      const eventPlanId = typeof event === 'string' ? event : event?.planId;
      if (eventPlanId === this._planId) {
        this._update();
      }
    };
    const onPlanStarted = (plan: any) => {
      if (plan?.id === this._planId || plan === this._planId) {
        this._sendIncrementalUpdate();
      }
    };
    const onPlanCompleted = (plan: any) => {
      if (plan?.id === this._planId || plan === this._planId) {
        this._update();
      }
    };
    this._planRunner.on('nodeTransition', onNodeTransition);
    this._planRunner.on('planStarted', onPlanStarted);
    this._planRunner.on('planCompleted', onPlanCompleted);
    this._disposables.push({ dispose: () => {
      this._planRunner.removeListener('nodeTransition', onNodeTransition);
      this._planRunner.removeListener('planStarted', onPlanStarted);
      this._planRunner.removeListener('planCompleted', onPlanCompleted);
    }});
    
    // Subscribe to pulse — forward to webview for client-side duration ticking.
    // Duration counters (plan header + node labels) update purely client-side
    // using data-started timestamps. No server data needed on every tick.
    this._pulseSubscription = this._pulse.onPulse(() => {
      this._panel.webview.postMessage({ type: 'pulse' });
    });
    
    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    
    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      message => this._controller.handleMessage(message),
      null,
      this._disposables
    );
  }
  
  /**
   * Create a new detail panel for the given Plan, or reveal an existing one.
   *
   * If a panel for `planId` already exists, it is brought to the foreground.
   * Otherwise a new {@link vscode.WebviewPanel} is created in
   * {@link vscode.ViewColumn.One} with scripts enabled and context retention.
   *
   * @param extensionUri - The extension's root URI (used for local resource roots).
   * @param planId - The unique identifier of the Plan to display.
   * @param planRunner - The {@link PlanRunner} instance for querying state.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    planId: string,
    planRunner: PlanRunner,
    options?: { preserveFocus?: boolean },
    dialogService?: IDialogService,
    pulse?: IPulseEmitter
  ) {
    const preserveFocus = options?.preserveFocus ?? false;
    
    // Check if panel already exists
    const existing = planDetailPanel.panels.get(planId);
    if (existing) {
      existing._panel.reveal(undefined, preserveFocus);
      return;
    }
    
    const plan = planRunner.get(planId);
    const title = plan ? `Plan: ${plan.spec.name}` : `Plan: ${planId.slice(0, 8)}`;
    
    // Create new panel - createWebviewPanel always takes focus, so we need to restore
    // focus back to tree if preserveFocus is requested
    const panel = vscode.window.createWebviewPanel(
      'planDetail',
      title,
      { viewColumn: vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    // Default dialog service using VS Code APIs
    const defaultDialogService: IDialogService = {
      showInfo: async (msg: string) => { vscode.window.showInformationMessage(msg); },
      showError: async (msg: string) => { vscode.window.showErrorMessage(msg); },
      showWarning: async (msg: string, opts?: { modal?: boolean }, ...actions: string[]) => {
        return vscode.window.showWarningMessage(msg, opts || {}, ...actions) as Promise<string | undefined>;
      },
      showQuickPick: async (items: string[], opts?: any) => {
        const result = await vscode.window.showQuickPick(items, opts);
        return Array.isArray(result) ? result[0] : result;
      },
    };
    const effectiveDialogService = dialogService ?? defaultDialogService;
    
    // Default pulse emitter (no-op) if not provided
    const effectivePulse: IPulseEmitter = pulse ?? { onPulse: () => ({ dispose: () => {} }), isRunning: false };
    
    const planPanel = new planDetailPanel(panel, planId, planRunner, effectiveDialogService, effectivePulse);
    planDetailPanel.panels.set(planId, planPanel);
  }
  
  /**
   * Close all panels associated with a Plan (used when Plan is deleted).
   *
   * @param planId - The Plan ID whose panel should be closed.
   */
  public static closeForPlan(planId: string): void {
    const panel = planDetailPanel.panels.get(planId);
    if (panel) {
      panel.dispose();
    }
  }
  
  /** Dispose the panel, clear timers, and remove it from the static panel map. */
  public dispose() {
    planDetailPanel.panels.delete(this._planId);
    
    if (this._pulseSubscription) {
      this._pulseSubscription.dispose();
    }
    
    this._panel.dispose();
    
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {d.dispose();}
    }
  }
  
  /**
   * Query all process stats for this Plan and send them to the webview.
   */
  private async _sendAllProcessStats() {
    try {
      const stats = await this._planRunner.getAllProcessStats(this._planId);
      this._panel.webview.postMessage({
        type: 'allProcessStats',
        flat: (stats as any).flat || [],
        hierarchy: (stats as any).hierarchy || [],
        rootJobs: (stats as any).rootJobs || []
      });
    } catch (err) {
      // Send empty stats on error to clear the loading state
      this._panel.webview.postMessage({
        type: 'allProcessStats',
        flat: [],
        hierarchy: [],
        rootJobs: []
      });
    }
  }
  
  /**
   * Open the Plan's work summary in a separate read-only webview panel
   * (displayed beside the current editor column).
   */
  private async _showWorkSummaryDocument(): Promise<void> {
    const plan = this._planRunner.get(this._planId);
    if (!plan || !plan.workSummary) {
      vscode.window.showInformationMessage('No work summary available');
      return;
    }
    
    // Use filtered summary for plans with target branch.
    const summary = plan.targetBranch 
      ? computeMergedLeafWorkSummary(plan, plan.nodeStates)
      : plan.workSummary;
    
    if (!summary) {
      vscode.window.showInformationMessage('No work has been merged to target branch yet.');
      return;
    }
    
    // Build per-job data with duration from node execution states
    const jobs: WsPanelJob[] = (summary.jobSummaries || []).map(job => {
      const nodeState = plan.nodeStates.get(job.nodeId);
      const durationMs = (nodeState?.startedAt && nodeState?.endedAt)
        ? nodeState.endedAt - nodeState.startedAt
        : undefined;
      return {
        nodeId: job.nodeId,
        nodeName: job.nodeName,
        description: job.description,
        durationMs,
        commits: job.commits,
        filesAdded: job.filesAdded,
        filesModified: job.filesModified,
        filesDeleted: job.filesDeleted,
        commitDetails: (job.commitDetails || []).map(c => ({
          shortHash: c.shortHash,
          message: c.message,
          date: c.date,
          filesAdded: c.filesAdded,
          filesModified: c.filesModified,
          filesDeleted: c.filesDeleted,
        })),
      };
    });
    
    // Build journey nodes in topological order
    const journeyNodes: WsJourneyNode[] = [];
    const visited = new Set<string>();
    const toVisit = [...plan.roots];
    while (toVisit.length > 0) {
      const nodeId = toVisit.shift()!;
      if (visited.has(nodeId)) { continue; }
      const node = plan.nodes.get(nodeId);
      if (!node || node.type !== 'job') { continue; }
      const deps = (node as JobNode).dependencies || [];
      if (deps.some(d => !visited.has(d))) {
        toVisit.push(nodeId);
        continue;
      }
      visited.add(nodeId);
      const nodeState = plan.nodeStates.get(nodeId);
      journeyNodes.push({
        nodeName: node.name,
        shortHash: nodeState?.completedCommit?.slice(0, 8),
        status: (nodeState?.status || 'pending') as WsJourneyNode['status'],
        mergedToTarget: nodeState?.mergedToTarget,
        isLeaf: plan.leaves.includes(nodeId),
      });
      // Add dependents
      for (const [otherId, otherNode] of plan.nodes) {
        if (otherNode.type === 'job' && (otherNode as JobNode).dependencies.includes(nodeId)) {
          toVisit.push(otherId);
        }
      }
    }
    
    const panelData: WorkSummaryPanelData = {
      planName: plan.spec.name,
      baseBranch: plan.baseBranch,
      baseCommitShort: plan.baseCommitAtStart?.slice(0, 8),
      targetBranch: plan.targetBranch,
      totalCommits: summary.totalCommits,
      totalFilesAdded: summary.totalFilesAdded,
      totalFilesModified: summary.totalFilesModified,
      totalFilesDeleted: summary.totalFilesDeleted,
      jobs,
      journeyNodes,
    };
    
    // Create the webview panel with scripts enabled for clickable files
    const panelTitle = plan.targetBranch 
      ? `Work Summary: ${plan.spec.name} (Merged to ${plan.targetBranch})`
      : `Work Summary: ${plan.spec.name}`;
    const panel = vscode.window.createWebviewPanel(
      'workSummary',
      panelTitle,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    
    // Handle openFile messages from clickable file links
    panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'openFile' && message.path) {
        const fileUri = vscode.Uri.file(
          require('path').join(plan.repoPath, message.path)
        );
        vscode.window.showTextDocument(fileUri, { preview: true }).then(
          undefined,
          () => { /* file may not exist */ }
        );
      }
    });
    
    panel.webview.html = renderWorkSummaryPanelHtml(panelData);
  }

  /**
   * Force a full HTML re-render, bypassing the state hash check.
   * Used when the webview requests a refresh (e.g., after an error).
   */
  private async _forceFullRefresh() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = sm?.computePlanStatus() || 'pending';
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    // Get global capacity stats
    const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
    
    // Reset hashes to force next _update to also do full render
    this._lastStateVersion = -1;
    this._lastStructureHash = '';
    this._isFirstRender = true;
    
    this._panel.webview.html = this._getHtml(plan, status, recursiveCounts.counts, effectiveEndedAt, recursiveCounts.totalNodes, globalCapacityStats);
  }

  /**
   * Re-render the panel HTML if the Plan state has changed since the last render.
   * Uses a JSON state hash to skip redundant re-renders.
   */
  private async _update() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = sm?.computePlanStatus() || 'pending';
    
    // Get recursive counts including all child plans (for accurate totals)
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const counts = recursiveCounts.counts;
    const totalNodes = recursiveCounts.totalNodes;
    
    // Get global capacity stats
    const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
    
    // Build node status mapfor incremental updates (includes version for efficient updates)
    const nodeStatuses: Record<string, { status: string; version: number; startedAt?: number; endedAt?: number; currentPhase?: string }> = {};
    for (const [nodeId, state] of plan.nodeStates) {
      const sanitizedId = this._sanitizeId(nodeId);
      const entry: typeof nodeStatuses[string] = {
        status: state.status,
        version: state.version || 0,
        startedAt: state.startedAt,
        endedAt: state.endedAt
      };
      if (state.status === 'running' && state.stepStatuses) {
        for (const [phase, phaseStatus] of Object.entries(state.stepStatuses)) {
          if (phaseStatus === 'running') { entry.currentPhase = phase; break; }
        }
      }
      nodeStatuses[sanitizedId] = entry;
    }
    
    // Add group statuses (groups use same sanitized ID pattern as nodes)
    for (const [groupId, state] of plan.groupStates) {
      const sanitizedId = this._sanitizeId(groupId);
      nodeStatuses[sanitizedId] = {
        status: state.status,
        version: state.version || 0,
        startedAt: state.startedAt,
        endedAt: state.endedAt
      };
    }
    
    // Structure hash: nodes and their dependencies (doesn't change during execution)
    const structureHash = JSON.stringify({
      nodes: Array.from(plan.nodes.entries()).map(([id, n]) => [id, n.name, (n as JobNode).dependencies]),
      spec: plan.spec.name
    });
    
    // Use stateVersion for efficient change detection (incremented on every state change)
    const currentStateVersion = plan.stateVersion || 0;
    
    // If nothing changed, skip entirely
    if (currentStateVersion === this._lastStateVersion) {
      return;
    }
    
    const structureChanged = structureHash !== this._lastStructureHash;
    this._lastStateVersion = currentStateVersion;
    this._lastStructureHash = structureHash;
    
    // If structure changed or first render, do full HTML render
    if (structureChanged || this._isFirstRender) {
      this._isFirstRender = false;
      // Compute effective endedAt from node data for accurate duration
      const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
      this._panel.webview.html = this._getHtml(plan, status, counts, effectiveEndedAt, totalNodes, globalCapacityStats);
      return;
    }
    
    // Otherwise, send incremental status update (preserves zoom/scroll)
    const total = totalNodes ?? plan.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    this._panel.webview.postMessage({
      type: 'statusUpdate',
      planStatus: status,
      stateVersion: currentStateVersion,
      nodeStatuses,
      counts,
      progress,
      total,
      completed,
      startedAt: plan.startedAt,
      endedAt: effectiveEndedAt,
      planMetrics: this._serializeMetrics(plan),
      globalCapacity: globalCapacityStats ? {
        activeInstances: globalCapacityStats.activeInstances,
        totalGlobalJobs: globalCapacityStats.totalGlobalJobs,
        globalMaxParallel: globalCapacityStats.globalMaxParallel
      } : null
    });
  }
  
  /**
   * Send an incremental status update to the webview (used by pulse).
   * Unlike _update(), this always sends the status message even if the
   * stateVersion hasn't changed, because duration counters need fresh
   * startedAt/endedAt data on every pulse tick.
   */
  private async _sendIncrementalUpdate() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {return;}
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = sm?.computePlanStatus() || 'pending';
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const counts = recursiveCounts.counts;
    const totalNodes = recursiveCounts.totalNodes;
    const total = totalNodes ?? plan.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    // Build node statuses
    const nodeStatuses: Record<string, any> = {};
    for (const [nodeId, state] of plan.nodeStates) {
      const entry: Record<string, any> = {
        status: state.status, version: state.version || 0,
        startedAt: state.startedAt, endedAt: state.endedAt,
      };
      if (state.status === 'running' && state.stepStatuses) {
        for (const [phase, phaseStatus] of Object.entries(state.stepStatuses)) {
          if (phaseStatus === 'running') { entry.currentPhase = phase; break; }
        }
      }
      nodeStatuses[this._sanitizeId(nodeId)] = entry;
    }
    for (const [groupId, state] of plan.groupStates) {
      nodeStatuses[this._sanitizeId(groupId)] = {
        status: state.status, version: state.version || 0,
        startedAt: state.startedAt, endedAt: state.endedAt,
      };
    }
    
    this._panel.webview.postMessage({
      type: 'statusUpdate',
      planStatus: status,
      nodeStatuses,
      counts, progress, total, completed,
      startedAt: plan.startedAt,
      endedAt: effectiveEndedAt,
    });
  }

  /**
   * Generate a minimal error page HTML.
   *
   * @param message - Error text to display.
   * @returns Full HTML document string.
   */
  private _getErrorHtml(message: string): string {
    return errorPageHtml(message);
  }
  
  /**
   * Build the full HTML document for the Plan detail view.
   *
   * Includes a Mermaid DAG diagram, node status grid, progress bar, action buttons,
   * branch flow info, and work summary section. Loads Mermaid from CDN.
   *
   * @param plan - The Plan instance to render.
   * @param status - The computed overall Plan status.
   * @param counts - Per-{@link NodeStatus} counts from the state machine.
   * @param effectiveEndedAt - Optional override for the Plan's end timestamp
   *   (accounts for still-running child Plans).
   * @param totalNodes - Total node count recursively including child plans.
   * @param globalCapacityStats - Optional global capacity statistics.
   * @returns Full HTML document string.
   */
  private _getHtml(
    plan: PlanInstance,
    status: string,
    counts: Record<NodeStatus, number>,
    effectiveEndedAt?: number,
    totalNodes?: number,
    globalCapacityStats?: { thisInstanceJobs: number; totalGlobalJobs: number; globalMaxParallel: number; activeInstances: number } | null
  ): string {
    const total = totalNodes ?? plan.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Build Mermaid diagram
    const { diagram: mermaidDef, nodeTooltips, edgeData } = this._buildMermaidDiagram(plan);
    
    // Build node data for click handling
    const nodeData: Record<string, { nodeId: string; planId: string; type: string; name: string; startedAt?: number; endedAt?: number; status: string; version: number }> = {};
    
    // Collect all node data with prefixes matching Mermaid IDs
    for (const [nodeId, node] of plan.nodes) {
      const sanitizedId = this._sanitizeId(nodeId);
      const state = plan.nodeStates.get(nodeId);
      
      nodeData[sanitizedId] = {
        nodeId,
        planId: plan.id,
        type: node.type,
        name: node.name,
        startedAt: state?.startedAt,
        endedAt: state?.endedAt,
        status: state?.status || 'pending',
        version: state?.version || 0,
      };
    }
    
    // Add group data for duration tracking
    for (const [groupId, state] of plan.groupStates) {
      const sanitizedId = this._sanitizeId(groupId);
      const group = plan.groups.get(groupId);
      nodeData[sanitizedId] = {
        nodeId: groupId,
        planId: plan.id,
        type: 'group',
        name: group?.name || groupId,
        startedAt: state?.startedAt,
        endedAt: state?.endedAt,
        status: state?.status || 'pending',
        version: state?.version || 0,
      };
    }
    
    // Get branch info
    const baseBranch = plan.spec.baseBranch || 'main';
    const targetBranch = plan.targetBranch || baseBranch;
    const showBranchFlow = baseBranch !== targetBranch || plan.targetBranch;
    
    // Build work summary from node states
    const workSummaryHtml = this._buildWorkSummaryHtml(plan);
    const metricsBarHtml = this._buildMetricsBarHtml(plan);
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net;">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    body {
      font: 13px var(--vscode-font-family);
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    /* Sticky header */
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-editor-background);
      padding: 12px 16px 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .sticky-header + * {
      padding-top: 8px;
    }
    body > *:not(.sticky-header) {
      padding-left: 16px;
      padding-right: 16px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .header h2 { margin: 0; flex: 1; margin-left: 12px; }
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.running { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .status-badge.succeeded { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .status-badge.failed { background: rgba(244, 135, 113, 0.2); color: #f48771; }
    .status-badge.partial { background: rgba(255, 204, 0, 0.2); color: #cca700; }
    .status-badge.pending { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.paused { background: rgba(255, 165, 0, 0.2); color: #ffa500; }
    .status-badge.canceled { background: rgba(133, 133, 133, 0.2); color: #858585; }
    
    /* Duration display in header */
    .header-duration {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
    }
    .duration-icon {
      font-size: 16px;
    }
    .duration-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .duration-value.running {
      color: #3794ff;
    }
    .duration-value.succeeded {
      color: #4ec9b0;
    }
    .duration-value.failed {
      color: #f48771;
    }
    
    /* Branch flow */
    .branch-flow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      font-size: 12px;
    }
    .branch-name {
      padding: 3px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-family: monospace;
    }
    .branch-arrow {
      color: var(--vscode-descriptionForeground);
    }
    .branch-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    
    .capacity-info.capacity-badge {
      display: inline-flex;
      padding: 4px 10px;
      margin-bottom: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    
    .stats {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 600;
    }
    .stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .stat-value.succeeded { color: #4ec9b0; }
    .stat-value.failed { color: #f48771; }
    .stat-value.running { color: #3794ff; }
    
    .progress-container {
      margin-bottom: 16px;
    }
    .progress-bar {
      height: 6px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 3px;
    }
    .progress-fill {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .progress-fill.succeeded { background: #4ec9b0; }
    .progress-fill.failed { background: #f48771; }
    
    #mermaid-diagram {
      background: var(--vscode-sideBar-background);
      padding: 16px;
      border-radius: 8px;
      overflow: auto;
      margin-bottom: 16px;
      position: relative;
    }
    
    /* Zoom controls */
    .zoom-controls {
      position: sticky;
      top: 0;
      left: 0;
      z-index: 10;
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      background: rgba(30, 30, 30, 0.95);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border);
      width: fit-content;
    }
    .zoom-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      min-width: 32px;
    }
    .zoom-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .zoom-level {
      display: flex;
      align-items: center;
      padding: 0 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-width: 50px;
      justify-content: center;
    }
    .mermaid-container {
      transform-origin: top left;
      transition: transform 0.2s ease;
    }
    #mermaid-diagram {
      cursor: grab;
    }
    #mermaid-diagram.panning {
      cursor: grabbing;
      user-select: none;
    }
    #mermaid-diagram.panning .mermaid-container {
      transition: none;
    }
    
    /* Mermaid node styling */
    .mermaid .node rect { rx: 8px; ry: 8px; }
    .mermaid .node.pending rect { fill: #3c3c3c; stroke: #858585; }
    .mermaid .node.ready rect { fill: #2d4a6e; stroke: #3794ff; }
    .mermaid .node.running rect { fill: #2d4a6e; stroke: #3794ff; stroke-width: 2px; }
    .mermaid .node.succeeded rect { fill: #1e4d40; stroke: #4ec9b0; }
    .mermaid .node.failed rect { fill: #4d2929; stroke: #f48771; }
    .mermaid .node.blocked rect { fill: #3c3c3c; stroke: #858585; stroke-dasharray: 5,5; }
    
    .mermaid .node { cursor: pointer; }
    .mermaid .node.branchNode,
    .mermaid .node.baseBranchNode,
    .mermaid g[id*="BASE_BRANCH"] .node,
    .mermaid g[id*="TARGET_SOURCE"] .node,
    .mermaid g[id*="TARGET_MERGED"] .node { cursor: default; }  /* Branch nodes are not clickable */
    
    /* Node labels — override Mermaid's inline max-width so text renders
       at its natural width.  Labels are pre-truncated server-side so they
       won't grow unbounded.  overflow:visible ensures nothing clips. */
    .mermaid .node .nodeLabel {
      white-space: nowrap !important;
      display: block !important;
      overflow: visible !important;
      max-width: none !important;
    }
    .mermaid .node foreignObject {
      overflow: visible !important;
    }
    .mermaid .node foreignObject div {
      white-space: nowrap !important;
      overflow: visible !important;
      max-width: none !important;
    }
    
    /* Subgraph/cluster styling */
    .mermaid .cluster rect { 
      rx: 8px; 
      ry: 8px;
    }
    .mermaid .cluster,
    .mermaid .cluster-label,
    .mermaid g.cluster,
    .mermaid g.cluster foreignObject,
    .mermaid g.cluster foreignObject div {
      overflow: visible !important;
      clip-path: none !important;
    }
    .mermaid .cluster-label,
    .mermaid .cluster-label span,
    .mermaid g.cluster text { 
      cursor: pointer !important;
      font-weight: bold;
      pointer-events: all !important;
    }
    /* Disable any clipping on cluster labels */
    .mermaid .cluster .label-container {
      overflow: visible !important;
    }
    .mermaid .cluster-label:hover,
    .mermaid g.cluster text:hover {
      text-decoration: underline;
      fill: #7DD3FC;
    }
    /* Subgraph titles are pre-truncated server-side; let Mermaid size the box */
    .mermaid .cluster .nodeLabel {
      white-space: nowrap !important;
    }
    .mermaid svg {
      overflow: visible;
    }
    
    /* Legend */
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 8px 12px;
      background: rgba(30, 30, 30, 0.9);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      align-items: center;
      margin-bottom: 12px;
      font-size: 11px;
    }
    .legend-toggle {
      cursor: pointer;
      user-select: none;
    }
    .legend-toggle:hover {
      color: var(--vscode-foreground);
    }
    .legend.collapsed .legend-items {
      display: none;
    }
    .legend.collapsed .legend-toggle::after {
      content: ' ▸';
    }
    .legend:not(.collapsed) .legend-toggle::after {
      content: ' ▾';
    }
    .legend-items {
      display: contents;
    }
    .legend-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .legend-icon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: bold;
    }
    .legend-icon.pending { background: #3c3c3c; border: 1px solid #858585; color: #858585; }
    .legend-icon.running { background: #2d4a6e; border: 1px solid #3794ff; color: #3794ff; }
    .legend-icon.succeeded { background: #1e4d40; border: 1px solid #4ec9b0; color: #4ec9b0; }
    .legend-icon.failed { background: #4d2929; border: 1px solid #f48771; color: #f48771; }
    .legend-icon.blocked { background: #3c3c3c; border: 1px dashed #858585; color: #858585; }
    
    /* Processes Section */
    .processes-section {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      border-left: 3px solid #3794ff;
    }
    .processes-section h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .processes-loading {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 8px 0;
    }
    .node-processes {
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      overflow: hidden;
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
    }
    .node-processes.collapsed .node-processes-tree { display: none; }
    .node-processes.collapsed .node-chevron { content: '▶'; }
    .node-processes-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 500;
    }
    .node-processes-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .node-chevron {
      font-size: 10px;
      transition: transform 0.2s;
    }
    .node-icon { font-size: 14px; }
    .node-name { flex: 1; }
    .node-stats {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
    }
    .node-name-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 1px;
    }
    .node-plan-path {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      opacity: 0.8;
    }
    .node-processes-tree {
      padding: 4px 12px 8px;
      border-top: 1px solid var(--vscode-widget-border);
      max-height: 140px; /* ~5 process rows */
      overflow-y: auto;
      position: relative;
    }
    /* Scroll fade indicator at the bottom */
    .node-processes-tree.has-overflow::after {
      content: '';
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      display: block;
      height: 24px;
      background: linear-gradient(transparent, var(--vscode-editor-background));
      pointer-events: none;
    }
    .process-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 12px;
    }
    .proc-icon { font-size: 12px; }
    .proc-name { flex: 1; font-family: var(--vscode-editor-font-family); }
    .proc-pid { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .proc-stats { color: var(--vscode-descriptionForeground); font-size: 11px; }
    
    /* Process Aggregation Summary */
    .processes-summary {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 14px;
      margin-bottom: 12px;
      background: rgba(55, 148, 255, 0.08);
      border: 1px solid rgba(55, 148, 255, 0.25);
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
    }
    .processes-summary-label {
      color: var(--vscode-foreground);
    }
    .processes-summary-stat {
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      font-size: 12px;
    }

    /* Job status indicators */
    .job-scheduled .node-stats.job-scheduled {
      color: var(--vscode-charts-yellow);
      font-style: italic;
    }
    .job-running .node-stats.job-starting {
      color: var(--vscode-charts-blue);
      font-style: italic;
    }
    
    /* Work Summary */
    .work-summary {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .work-summary h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .work-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .work-stat {
      text-align: center;
      padding: 12px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-stat-value {
      font-size: 20px;
      font-weight: 600;
    }
    .work-stat-value.added { color: #4ec9b0; }
    .work-stat-value.modified { color: #dcdcaa; }
    .work-stat-value.deleted { color: #f48771; }
    .work-stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    
    .job-summaries {
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 12px;
    }
    .job-summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border);
      cursor: pointer;
    }
    .job-summary:hover {
      background: var(--vscode-list-hoverBackground);
      margin: 0 -8px;
      padding: 8px;
    }
    .job-summary:last-child { border-bottom: none; }
    .job-name {
      font-weight: 500;
    }
    .job-stats {
      display: flex;
      gap: 12px;
      font-size: 12px;
    }
    .job-stats .stat-commits { color: var(--vscode-descriptionForeground); }
    .job-stats .stat-added { color: #4ec9b0; }
    .job-stats .stat-modified { color: #dcdcaa; }
    .job-stats .stat-deleted { color: #f48771; }
    
    .plan-metrics-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      margin-bottom: 16px;
      border-left: 3px solid var(--vscode-progressBar-background);
    }
    .plan-metrics-bar .metrics-label {
      font-weight: 600;
      font-size: 13px;
    }
    .plan-metrics-bar .metric-item {
      font-size: 13px;
      white-space: nowrap;
    }
    .plan-metrics-bar .metric-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
    }
    .plan-metrics-bar .models-line {
      width: 100%;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding-left: 2px;
    }
    .plan-metrics-bar .model-breakdown {
      width: 100%;
      margin-top: 8px;
    }
    .plan-metrics-bar .model-breakdown-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .plan-metrics-bar .model-breakdown-list {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
    }
    .plan-metrics-bar .model-row {
      display: flex;
      gap: 12px;
      align-items: baseline;
      padding: 2px 0;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .plan-metrics-bar .model-name {
      font-weight: 600;
      min-width: 140px;
    }
    .plan-metrics-bar .model-tokens {
      color: var(--vscode-descriptionForeground);
    }
    
    .plan-toolbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--vscode-editor-background);
      padding: 8px 0 8px 0;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 6px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s, opacity 0.15s;
    }
    .action-btn:hover {
      opacity: 0.9;
    }
    .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-secondaryBackground);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
    }
    .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
    }
    .action-btn.danger {
      background: #cc3333;
      color: white;
    }
    .action-btn.danger:hover {
      background: #aa2222;
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    /* Phase indicator in status badge */
    .phase-indicator {
      font-size: 11px;
      font-weight: 500;
    }
    
    /* Work summary clickable stats */
    .work-summary-clickable {
      cursor: pointer;
      transition: background 0.15s;
      border-radius: 8px;
      padding: 4px;
    }
    .work-summary-clickable:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
  </style>
</head>
<body>
  <div class="sticky-header">
  ${renderPlanHeader({
    planName: plan.spec.name,
    status,
    startedAt: plan.startedAt,
    effectiveEndedAt,
    baseBranch,
    targetBranch: plan.targetBranch,
    showBranchFlow: !!showBranchFlow,
    globalCapacityStats,
  })}
  </div>
  ${renderPlanControls({ status })}
  ${renderPlanNodeCard({ total, counts, progress, status })}
  ${metricsBarHtml}
  ${renderPlanDag({ mermaidDef, status })}
  ${workSummaryHtml}
  ${renderPlanScripts({ nodeData, nodeTooltips, mermaidDef, edgeData, globalCapacityStats: globalCapacityStats || null })}
</body>
</html>`;
  }
  
  /**
   * Build work summary HTML from node execution states.
   *
   * Aggregates commit/file counts across all nodes that have a work summary,
   * then renders stats cards and per-job detail sections.
   *
   * @param plan - The Plan instance whose node states contain work summaries.
   * @returns HTML fragment string, or empty string if no work has been performed.
   */
  private _buildWorkSummaryHtml(plan: PlanInstance): string {
    // For plans WITH targetBranch: only show merged leaf work (no fallback)
    // For plans WITHOUT targetBranch: show all completed work
    const workSummary = plan.targetBranch 
      ? computeMergedLeafWorkSummary(plan, plan.nodeStates)
      : plan.workSummary;
    
    if (!workSummary) {
      return '';
    }
    
    const summaryData: PlanSummaryData = {
      totalCommits: workSummary.totalCommits || 0,
      totalFilesAdded: workSummary.totalFilesAdded || 0,
      totalFilesModified: workSummary.totalFilesModified || 0,
      totalFilesDeleted: workSummary.totalFilesDeleted || 0,
      jobSummaries: workSummary.jobSummaries.map(j => ({
        nodeId: j.nodeId,
        nodeName: j.nodeName,
        commits: j.commits,
        filesAdded: j.filesAdded,
        filesModified: j.filesModified,
        filesDeleted: j.filesDeleted,
        description: j.description,
      })),
      targetBranch: plan.targetBranch,
    };

    return renderPlanSummary(summaryData);
  }
  
  /**
   * Serialize plan metrics into a plain object for the webview statusUpdate message.
   */
  private _serializeMetrics(plan: PlanInstance): Record<string, unknown> | undefined {
    const metrics = getPlanMetrics(plan);
    if (!metrics) { return undefined; }

    const result: Record<string, unknown> = {};
    if (metrics.premiumRequests !== undefined) {
      result.premiumRequests = formatPremiumRequests(metrics.premiumRequests);
    }
    if (metrics.apiTimeSeconds !== undefined) {
      result.apiTime = formatDurationSeconds(metrics.apiTimeSeconds);
    }
    if (metrics.sessionTimeSeconds !== undefined) {
      result.sessionTime = formatDurationSeconds(metrics.sessionTimeSeconds);
    }
    if (metrics.codeChanges) {
      result.codeChanges = formatCodeChanges(metrics.codeChanges);
    }
    if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
      result.modelBreakdown = metrics.modelBreakdown
        .sort((a, b) => (b.premiumRequests ?? 0) - (a.premiumRequests ?? 0))
        .map(m => ({
          model: m.model,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cachedTokens: m.cachedTokens,
          premiumRequests: m.premiumRequests,
        }));
    }
    return result;
  }

  /**
   * Build a compact AI usage metrics bar from plan-level aggregate metrics.
   *
   * @param plan - The Plan instance to compute metrics for.
   * @returns HTML string (empty if no metrics data is available).
   */
  private _buildMetricsBarHtml(plan: PlanInstance): string {
    const metrics = getPlanMetrics(plan);
    if (!metrics) { return renderMetricsBar(null); }

    const metricsData: PlanMetricsBarData = {};
    if (metrics.premiumRequests !== undefined) {
      metricsData.premiumRequests = formatPremiumRequests(metrics.premiumRequests);
    }
    if (metrics.apiTimeSeconds !== undefined) {
      metricsData.apiTime = formatDurationSeconds(metrics.apiTimeSeconds);
    }
    if (metrics.sessionTimeSeconds !== undefined) {
      metricsData.sessionTime = formatDurationSeconds(metrics.sessionTimeSeconds);
    }
    if (metrics.codeChanges) {
      metricsData.codeChanges = formatCodeChanges(metrics.codeChanges);
    }
    if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
      metricsData.modelBreakdown = metrics.modelBreakdown
        .sort((a, b) => (b.premiumRequests ?? 0) - (a.premiumRequests ?? 0))
        .map(m => ({
          model: m.model,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cachedTokens: m.cachedTokens,
          premiumRequests: m.premiumRequests,
        }));
    }

    return renderMetricsBar(metricsData);
  }
  
  /**
   * Build a Mermaid flowchart definition for the Plan's node DAG.
   *
   * Recursively expands sub-plan nodes into subgraphs. Applies status-based
   * styling (green for succeeded, red for failed, blue for running) and tracks
   * edge indices for `linkStyle` coloring.
   *
   * @param plan - The Plan instance whose nodes form the DAG.
   * @returns An object containing the Mermaid diagram string and node tooltips.
   */
  private _buildMermaidDiagram(plan: PlanInstance): { diagram: string; nodeTooltips: Record<string, string>; edgeData: Array<{ index: number; from: string; to: string; isLeafToTarget?: boolean }> } {
    const lines: string[] = ['flowchart LR'];
    
    // Maximum total character width for a node label (icon + name + duration).
    // Labels exceeding this are truncated with '...' and a hover tooltip.
    const MAX_NODE_LABEL_CHARS = 45;
    
    // Track full names for tooltip display when labels are truncated
    const nodeTooltips: Record<string, string> = {};
    
    // Get branch names
    const baseBranchName = plan.baseBranch || 'main';
    const targetBranchName = plan.targetBranch || baseBranchName;
    const showBaseBranch = baseBranchName !== targetBranchName;
    const showTargetBranch = !!plan.targetBranch;
    
    // Add style definitions
    lines.push('  classDef pending fill:#3c3c3c,stroke:#858585');
    lines.push('  classDef ready fill:#2d4a6e,stroke:#3794ff');
    lines.push('  classDef running fill:#2d4a6e,stroke:#3794ff,stroke-width:2px');
    lines.push('  classDef succeeded fill:#1e4d40,stroke:#4ec9b0');
    lines.push('  classDef failed fill:#4d2929,stroke:#f48771');
    lines.push('  classDef blocked fill:#3c3c3c,stroke:#858585,stroke-dasharray:5');
    lines.push('  classDef branchNode fill:#0e639c,stroke:#0e639c,color:#ffffff');
    lines.push('  classDef baseBranchNode fill:#6e6e6e,stroke:#888888,color:#ffffff');
    lines.push('');
    
    // Track edge indices for linkStyle
    let edgeIndex = 0;
    const successEdges: number[] = [];
    const failedEdges: number[] = [];
    // Edge data for client-side incremental edge coloring
    const edgeData: Array<{ index: number; from: string; to: string; isLeafToTarget?: boolean }> = [];
    
    // Truncate branch names for display (they can be very long)
    const truncBranch = (name: string, maxLen: number) => {
      if (name.length <= maxLen) {return name;}
      // Show the last segment after / for readability
      const lastSlash = name.lastIndexOf('/');
      if (lastSlash > 0 && name.length - lastSlash < maxLen) {
        return '...' + name.substring(lastSlash);
      }
      return name.substring(0, maxLen - 3) + '...';
    };
    
    // Add base branch node if different from target
    if (showBaseBranch) {
      const truncBase = truncBranch(baseBranchName, MAX_NODE_LABEL_CHARS);
      lines.push(`  BASE_BRANCH["🔀 ${this._escapeForMermaid(truncBase)}"]`);
      lines.push('  class BASE_BRANCH baseBranchNode');
      if (truncBase !== baseBranchName) {nodeTooltips['BASE_BRANCH'] = baseBranchName;}
    }
    
    // Add source target branch node
    if (showTargetBranch) {
      const truncTarget = truncBranch(targetBranchName, MAX_NODE_LABEL_CHARS);
      lines.push(`  TARGET_SOURCE["📍 ${this._escapeForMermaid(truncTarget)}"]`);
      lines.push('  class TARGET_SOURCE branchNode');
      if (truncTarget !== targetBranchName) {nodeTooltips['TARGET_SOURCE'] = targetBranchName;}
      
      if (showBaseBranch) {
        lines.push('  BASE_BRANCH --> TARGET_SOURCE');
        successEdges.push(edgeIndex++);
      }
    }
    
    lines.push('');
    
    // Track node entry/exit points for edge connections
    const nodeEntryExitMap = new Map<string, { entryIds: string[], exitIds: string[] }>();
    
    // Track leaf node states for mergedToTarget status
    const leafnodeStates = new Map<string, NodeExecutionState | undefined>();
    
    // Counter for unique group subgraph IDs
    let groupSubgraphCounter = 0;
    
    // Track all edges to add at the end
    const edgesToAdd: Array<{ from: string; to: string; status?: string }> = [];
    
    // Helper function to render a single job node
    const renderJobNode = (
      node: JobNode,
      nodeId: string,
      d: PlanInstance,
      prefix: string,
      indent: string,
      nodeHasDependents: Set<string>,
      localRoots: string[],
      localLeaves: string[]
    ) => {
      const state = d.nodeStates.get(nodeId);
      const status = state?.status || 'pending';
      const sanitizedId = prefix + this._sanitizeId(nodeId);
      
      const isRoot = node.dependencies.length === 0;
      const isLeaf = !nodeHasDependents.has(nodeId);
      
      const label = this._escapeForMermaid(node.name);
      const icon = this._getStatusIcon(status);
      
      // Calculate duration for completed or running nodes.
      // ALL nodes get rendered with ' | 00m 00s' sizing template so Mermaid
      // allocates consistent rect widths. Client-side strips the suffix from
      // non-started nodes after render.
      const DURATION_TEMPLATE = ' | 00m 00s'; // fixed-width sizing template
      let durationLabel = DURATION_TEMPLATE;
      if (state?.startedAt) {
        const endTime = state.endedAt || Date.now();
        const duration = endTime - state.startedAt;
        durationLabel = ' | ' + formatDurationMs(duration);
      }
      
      // Truncate long node labels using the sizing template width.
      const displayLabel = this._truncateLabel(label, DURATION_TEMPLATE, MAX_NODE_LABEL_CHARS);
      if (displayLabel !== label) {
        nodeTooltips[sanitizedId] = node.name;
      }
      
      // Add sparkle to tooltip for augmented nodes
      const normalizedWork = node.work ? normalizeWorkSpec(node.work) : undefined;
      if (normalizedWork?.type === 'agent' && normalizedWork.originalInstructions) {
        nodeTooltips[sanitizedId] = '✨ ' + (nodeTooltips[sanitizedId] || node.name);
      }
      
      lines.push(`${indent}${sanitizedId}["${icon} ${displayLabel}${durationLabel}"]`);
      lines.push(`${indent}class ${sanitizedId} ${status}`);
      
      nodeEntryExitMap.set(sanitizedId, { entryIds: [sanitizedId], exitIds: [sanitizedId] });
      
      if (isRoot) {localRoots.push(sanitizedId);}
      if (isLeaf) {
        localLeaves.push(sanitizedId);
        leafnodeStates.set(sanitizedId, state);
      }
      
      // Add edges from dependencies
      for (const depId of node.dependencies) {
        const depSanitizedId = prefix + this._sanitizeId(depId);
        edgesToAdd.push({ from: depSanitizedId, to: sanitizedId, status: d.nodeStates.get(depId)?.status });
      }
    };
    
    // Recursive function to render Plan structure
    const renderPlanInstance = (d: PlanInstance, prefix: string, depth: number): { roots: string[], leaves: string[] } => {
      const indent = '  '.repeat(depth + 1);
      const localRoots: string[] = [];
      const localLeaves: string[] = [];
      
      // First pass: determine which nodes are roots and leaves in this Plan
      const nodeHasDependents = new Set<string>();
      for (const [nodeId, node] of d.nodes) {
        for (const depId of node.dependencies) {
          nodeHasDependents.add(depId);
        }
      }
      
      // Organize nodes by group tag
      const groupedNodes = new Map<string, { nodeId: string; node: PlanNode }[]>();
      const ungroupedNodes: { nodeId: string; node: PlanNode }[] = [];
      
      for (const [nodeId, node] of d.nodes) {
        const groupTag = node.group;
        if (groupTag) {
          if (!groupedNodes.has(groupTag)) {
            groupedNodes.set(groupTag, []);
          }
          groupedNodes.get(groupTag)!.push({ nodeId, node });
        } else {
          ungroupedNodes.push({ nodeId, node });
        }
      }
      
      // Build a tree structure from group paths
      interface GroupTreeNode {
        name: string;
        children: Map<string, GroupTreeNode>;
        nodes: { nodeId: string; node: PlanNode }[];
      }
      
      const groupTree: GroupTreeNode = { name: '', children: new Map(), nodes: [] };
      
      for (const [groupPath, nodes] of groupedNodes) {
        const parts = groupPath.split('/');
        let current = groupTree;
        
        for (const part of parts) {
          if (!current.children.has(part)) {
            current.children.set(part, { name: part, children: new Map(), nodes: [] });
          }
          current = current.children.get(part)!;
        }
        
        // Nodes belong to the leaf group
        current.nodes = nodes;
      }
      
      // Pre-compute rendered label width for each node (icon + name + duration)
      // so that group labels can be truncated to the widest descendant node.
      const nodeLabelWidths = new Map<string, number>();
      for (const [nodeId, node] of d.nodes) {
        const escapedName = this._escapeForMermaid(node.name);
        const st = d.nodeStates.get(nodeId);
        let dur = ' | --';
        if (st?.startedAt) {
          const endTime = st.endedAt || Date.now();
          dur = ' | ' + formatDurationMs(endTime - st.startedAt);
        }
        // Total = icon(2) + name + duration (matches the formula in _truncateLabel)
        // Cap to MAX_NODE_LABEL_CHARS so group widths reflect truncated nodes.
        const rawWidth = 2 + escapedName.length + dur.length;
        nodeLabelWidths.set(nodeId, Math.min(rawWidth, MAX_NODE_LABEL_CHARS));
      }

      // Recursively compute the max descendant-node label width for each group
      const computeMaxGroupWidth = (treeNode: GroupTreeNode): number => {
        let maxW = 0;
        for (const { nodeId } of treeNode.nodes) {
          const w = nodeLabelWidths.get(nodeId) || 0;
          if (w > maxW) {maxW = w;}
        }
        for (const child of treeNode.children.values()) {
          const w = computeMaxGroupWidth(child);
          if (w > maxW) {maxW = w;}
        }
        return maxW;
      };

      const groupMaxWidths = new Map<string, number>();
      const precomputeGroupWidths = (treeNode: GroupTreeNode, path: string) => {
        groupMaxWidths.set(path, computeMaxGroupWidth(treeNode));
        for (const [childName, child] of treeNode.children) {
          const childPath = path ? `${path}/${childName}` : childName;
          precomputeGroupWidths(child, childPath);
        }
      };
      for (const [name, child] of groupTree.children) {
        precomputeGroupWidths(child, name);
      }

      // Recursively render group tree as nested subgraphs
      const renderGroupTree = (
        treeNode: GroupTreeNode,
        groupPath: string,
        currentIndent: string
      ): void => {
        // Look up the group UUID from the path
        const groupUuid = d.groupPathToId.get(groupPath);
        const groupState = groupUuid ? d.groupStates.get(groupUuid) : undefined;
        const groupStatus = groupState?.status || 'pending';
        
        // Use sanitized group UUID as the subgraph ID (same pattern as nodes)
        const sanitizedGroupId = groupUuid ? this._sanitizeId(groupUuid) : `grp${groupSubgraphCounter++}`;
        
        // Get icon for group status (same as nodes)
        const icon = this._getStatusIcon(groupStatus);
        
        // Calculate duration for groups
        // Always include a duration placeholder to maintain consistent sizing
        let groupDurationLabel = ' | --';
        if (groupState?.startedAt) {
          const endTime = groupState.endedAt || Date.now();
          const duration = endTime - groupState.startedAt;
          groupDurationLabel = ' | ' + formatDurationMs(duration);
        }
        
        // Status-specific styling for groups (same colors as nodes)
        const groupColors: Record<string, { fill: string; stroke: string }> = {
          pending: { fill: '#1a1a2e', stroke: '#6a6a8a' },
          ready: { fill: '#1a2a4e', stroke: '#3794ff' },
          running: { fill: '#1a2a4e', stroke: '#3794ff' },
          succeeded: { fill: '#1a3a2e', stroke: '#4ec9b0' },
          failed: { fill: '#3a1a1e', stroke: '#f48771' },
          blocked: { fill: '#3a1a1e', stroke: '#f48771' },
          canceled: { fill: '#1a1a2e', stroke: '#6a6a8a' },
        };
        const colors = groupColors[groupStatus] || groupColors.pending;
        
        // Truncate group names based on the widest descendant node's rendered
        // label width, so the group title never overflows its content box.
        const displayName = treeNode.name;
        const escapedName = this._escapeForMermaid(displayName);
        const maxWidth = groupMaxWidths.get(groupPath) || 0;
        const truncatedGroupName = maxWidth > 0
          ? this._truncateLabel(escapedName, groupDurationLabel, maxWidth)
          : escapedName;
        // Show full path in tooltip for nested groups or when truncated
        if (truncatedGroupName !== escapedName || groupPath.includes('/')) {
          nodeTooltips[sanitizedGroupId] = groupPath.includes('/') ? groupPath : displayName;
        }
        const emSp = '\u2003'; // em space — proportional-font-safe padding
        const padding = ''; // no extra padding — sizing template handles width
        
        lines.push(`${currentIndent}subgraph ${sanitizedGroupId}["${icon} ${truncatedGroupName}${groupDurationLabel}${padding}"]`);
        
        const childIndent = currentIndent + '  ';
        
        // Render child groups first (nested subgraphs)
        for (const childGroup of treeNode.children.values()) {
          const childPath = groupPath ? `${groupPath}/${childGroup.name}` : childGroup.name;
          renderGroupTree(childGroup, childPath, childIndent);
        }
        
        // Render nodes directly in this group
        for (const { nodeId, node } of treeNode.nodes) {
          renderJobNode(node as JobNode, nodeId, d, prefix, childIndent, nodeHasDependents, localRoots, localLeaves);
        }
        
        lines.push(`${currentIndent}end`);
        lines.push(`${currentIndent}style ${sanitizedGroupId} fill:${colors.fill},stroke:${colors.stroke},stroke-width:2px,stroke-dasharray:5`);
      };
      
      // Render ungrouped nodes first
      for (const { nodeId, node } of ungroupedNodes) {
        renderJobNode(node as JobNode, nodeId, d, prefix, indent, nodeHasDependents, localRoots, localLeaves);
      }
      
      // Render group tree (top-level groups)
      for (const topGroup of groupTree.children.values()) {
        renderGroupTree(topGroup, topGroup.name, indent);
      }
      
      return { roots: localRoots, leaves: localLeaves };
    };
    
    // Render the main Plan
    const mainResult = renderPlanInstance(plan, '', 0);
    
    lines.push('');
    
    // Add edges from target branch to root nodes
    if (showTargetBranch) {
      for (const rootId of mainResult.roots) {
        const mapping = nodeEntryExitMap.get(rootId);
        const entryIds = mapping ? mapping.entryIds : [rootId];
        for (const entryId of entryIds) {
          lines.push(`  TARGET_SOURCE --> ${entryId}`);
          edgeData.push({ index: edgeIndex, from: 'TARGET_SOURCE', to: entryId });
          successEdges.push(edgeIndex++);
        }
      }
    }
    
    // Add all collected edges
    for (const edge of edgesToAdd) {
      const fromMapping = nodeEntryExitMap.get(edge.from);
      const toMapping = nodeEntryExitMap.get(edge.to);
      
      const fromExits = fromMapping ? fromMapping.exitIds : [edge.from];
      const toEntries = toMapping ? toMapping.entryIds : [edge.to];
      
      for (const exit of fromExits) {
        for (const entry of toEntries) {
          // Dashed edge while source is pending/ready; solid once scheduled+
          const edgeStyle = (!edge.status || edge.status === 'pending' || edge.status === 'ready') ? '-.->' : '-->';
          lines.push(`  ${exit} ${edgeStyle} ${entry}`);
          edgeData.push({ index: edgeIndex, from: exit, to: entry });
          if (edge.status === 'succeeded') {
            successEdges.push(edgeIndex);
          } else if (edge.status === 'failed') {
            failedEdges.push(edgeIndex);
          }
          edgeIndex++;
        }
      }
    }
    
    // Add edges to target branch from leaf nodes
    if (showTargetBranch) {
      lines.push('');
      lines.push(`  TARGET_DEST["🎯 ${this._escapeForMermaid(truncBranch(targetBranchName, MAX_NODE_LABEL_CHARS))}"]`);
      lines.push('  class TARGET_DEST branchNode');
      if (targetBranchName.length > MAX_NODE_LABEL_CHARS) {nodeTooltips['TARGET_DEST'] = targetBranchName;}
      
      for (const leafId of mainResult.leaves) {
        const mapping = nodeEntryExitMap.get(leafId);
        const exitIds = mapping ? mapping.exitIds : [leafId];
        for (const exitId of exitIds) {
          // Check if this leaf has been successfully merged to target
          // Use either mergedToTarget flag or succeeded status as proxy, since
          // the Mermaid diagram is rendered once and edge types can't be updated
          // incrementally.  A succeeded leaf will have its RI merge completed.
          const leafState = leafnodeStates.get(exitId);
          const isMerged = leafState?.mergedToTarget === true
            || leafState?.status === 'succeeded';
          
          if (isMerged) {
            // Use solid line and mark as success edge
            lines.push(`  ${exitId} --> TARGET_DEST`);
            successEdges.push(edgeIndex);
          } else {
            // Use dotted line for pending merge
            lines.push(`  ${exitId} -.-> TARGET_DEST`);
          }
          edgeData.push({ index: edgeIndex, from: exitId, to: 'TARGET_DEST', isLeafToTarget: true });
          edgeIndex++;
        }
      }
    }
    
    // Add linkStyle for colored edges
    if (successEdges.length > 0) {
      lines.push(`  linkStyle ${successEdges.join(',')} stroke:#4ec9b0,stroke-width:2px`);
    }
    if (failedEdges.length > 0) {
      lines.push(`  linkStyle ${failedEdges.join(',')} stroke:#f48771,stroke-width:2px`);
    }
    
    return { diagram: lines.join('\n'), nodeTooltips, edgeData };
  }
  
  /**
   * Map a node status string to a single-character icon.
   *
   * @param status - The node status (e.g., `'succeeded'`, `'failed'`, `'running'`).
   * @returns A Unicode status icon character.
   */
  private _getStatusIcon(status: string): string {
    switch (status) {
      case 'succeeded': return '✓';
      case 'failed': return '✗';
      case 'running': return '▶';
      case 'blocked': return '⊘';
      default: return '○';
    }
  }
  
  /**
   * Convert a node ID (UUID) to a Mermaid-safe identifier.
   * Simply prefixes with 'n' and strips hyphens from UUID.
   * 
   * @param id - The raw node ID (UUID like "abc12345-6789-...").
   * @returns Mermaid-safe ID like "nabc123456789..."
   */
  private _sanitizeId(id: string): string {
    // UUIDs have hyphens; just remove them and prefix with 'n'
    return 'n' + id.replace(/-/g, '');
  }
  
  /**
   * Escape a string for safe inclusion in a Mermaid node label.
   *
   * @param str - The raw label text.
   * @returns The escaped string with Mermaid-special characters removed or replaced.
   */
  private _escapeForMermaid(str: string): string {
    return str
      .replace(/"/g, "'")
      .replace(/[<>{}|:#]/g, '')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')');
  }

  /**
   * Truncate a label name so that the combined label (icon + name + duration)
   * stays within the given `maxLen` characters. When truncation occurs the
   * name is trimmed and an ellipsis ('...') is appended.
   *
   * @param name - The escaped display name.
   * @param durationLabel - The duration suffix (e.g., ' | 2m 34s'), may be empty.
   * @param maxLen - Maximum total character count (icon(2) + name + duration).
   * @returns The (possibly truncated) name.
   */
  private _truncateLabel(name: string, durationLabel: string, maxLen: number): string {
    // +3 accounts for the status icon + space prefix ("✓ " renders ~3 chars wide
    // in proportional fonts due to Unicode symbol width)
    const ICON_WIDTH = 3;
    const totalLen = ICON_WIDTH + name.length + durationLabel.length;
    if (totalLen <= maxLen) {
      return name;
    }
    // Reserve space for icon, duration, and ellipsis
    const available = maxLen - ICON_WIDTH - durationLabel.length - 3; // 3 = '...'
    if (available <= 0) {
      return name; // duration alone exceeds limit – don't truncate name to nothing
    }
    return name.slice(0, available).trimEnd() + '...';
  }
  
  /**
   * Format a Plan's duration from start/end timestamps.
   *
   * @param startedAt - Epoch millisecond timestamp when the Plan started.
   * @param endedAt - Epoch millisecond timestamp when the Plan ended (uses `Date.now()` if omitted).
   * @returns Human-readable duration string, or `'--'` if `startedAt` is not set.
   */
  private _formatPlanDuration(startedAt?: number, endedAt?: number): string {
    if (!startedAt) {return '--';}
    const duration = (endedAt || Date.now()) - startedAt;
    return formatDurationMs(duration);
  }
}
