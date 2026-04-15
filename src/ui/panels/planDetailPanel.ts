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
import { renderPlanHeader, renderPlanControls, renderPlanDag, renderPlanNodeCard, renderPlanSummary, renderMetricsBar, renderPlanScripts, renderPlanDetailStyles, buildMermaidDiagram, renderPlanTimeline, renderTabBarStyles, renderTimelineStyles } from '../templates/planDetail';
import type { PlanSummaryData, PlanMetricsBarData } from '../templates/planDetail';
import { PlanDetailController } from './planDetailController';
import type { PlanDetailDelegate } from './planDetailController';
import type { IDialogService } from '../../interfaces/IDialogService';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';
import { WebViewSubscriptionManager } from '../webViewSubscriptionManager';
import { PlanStateProducer } from '../producers/planStateProducer';
import { NodeStateProducer } from '../producers/nodeStateProducer';
import { PlanTopologyProducer } from '../producers/planTopologyProducer';
import { webviewScriptTag } from '../webviewUri';
import { Logger } from '../../core/logger';
import * as fs from 'fs';
import * as path from 'path';

const panelLog = Logger.for('ui');

function crashLog(msg: string): void {
  try {
    const logPath = path.join(process.cwd(), '.orchestrator', 'debug-events.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [PlanDetail] ${msg}\n`);
  } catch { /* best-effort */ }
}

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
  private _disposed = false;
  private readonly _subscriptionManager: WebViewSubscriptionManager;
  private readonly _panelId: string;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param planId - Unique identifier of the Plan to display.
   * @param _planRunner - The {@link PlanRunner} instance for querying Plan/node state.
   * @param dialogService - Abstraction over VS Code dialog APIs.
   * @param _pulse - Pulse emitter for periodic updates.
   * @param _extensionUri - The extension's root URI (used for local resource roots).
   */
  private constructor(
    panel: vscode.WebviewPanel,
    planId: string,
    private _planRunner: PlanRunner,
    dialogService: IDialogService,
    private _pulse: IPulseEmitter,
    private _extensionUri: vscode.Uri
  ) {
    this._panel = panel;
    this._planId = planId;
    this._panelId = `plan:${planId}`;
    this._subscriptionManager = new WebViewSubscriptionManager();
    this._subscriptionManager.registerProducer(new PlanStateProducer(_planRunner as any));
    this._subscriptionManager.registerProducer(new NodeStateProducer(_planRunner as any));
    this._subscriptionManager.registerProducer(new PlanTopologyProducer(_planRunner as any));
    
    // Build the delegate that bridges controller → VS Code APIs
    const delegate: PlanDetailDelegate = {
      executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args) as Promise<void>,
      postMessage: (msg) => {
        if (!this._disposed) {
          try { this._panel.webview.postMessage(msg); } catch { /* panel disposed */ }
        }
      },
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
      closePanel: () => this._panel.dispose(),
    };
    this._controller = new PlanDetailController(planId, dialogService, delegate);
    
    // Initial render
    this._update();
    
    // ── Event wiring ────────────────────────────────────────────────────
    // ALL live state updates — including plan deletion — flow through the
    // WebViewSubscriptionManager via producers. PlanStateProducer delivers
    // status: 'deleted' when a plan is removed, and the webview sends a
    // 'close' message back to dispose this panel.
    //
    // No direct PlanRunner event listeners needed.
    
    // Subscribe to pulse — forward to webview for client-side duration ticking.
    // Duration counters (plan header + node labels) update purely client-side
    // using data-started timestamps. No server data needed on every tick.
    // Also tick subscription manager so plan/node state deltas are pushed when changed.
    this._pulseSubscription = this._pulse.onPulse(() => {
      if (!this._disposed) {
        try { this._panel.webview.postMessage({ type: 'pulse' }); } catch { /* panel disposed */ }
        this._subscriptionManager.tick().catch(() => { /* error logged internally */ });
      }
    });
    
    // Immediate full refresh when plan is reshaped (context pressure split,
    // manual edits, etc.) so the timeline and DAG pick up new nodes without
    // waiting for the next topology-producer poll tick.
    const onPlanReshaped = (reshapedPlanId: string) => {
      if (reshapedPlanId === this._planId && !this._disposed) {
        this._forceFullRefresh();
      }
    };
    this._planRunner.on('planReshaped', onPlanReshaped);
    this._disposables.push({ dispose: () => {
      this._planRunner.removeListener('planReshaped', onPlanReshaped);
    }});
    
    // Pause/resume subscriptions when panel visibility changes
    this._panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) {
        this._subscriptionManager.resumePanel(this._panelId);
      } else {
        this._subscriptionManager.pausePanel(this._panelId);
      }
    }, null, this._disposables);

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
    
    const planPanel = new planDetailPanel(panel, planId, planRunner, effectiveDialogService, effectivePulse, extensionUri);
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
    this._disposed = true;
    planDetailPanel.panels.delete(this._planId);
    
    this._subscriptionManager.disposePanel(this._panelId);

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
    if (this._disposed) { return; }
    try {
      const stats = await this._planRunner.getAllProcessStats(this._planId);
      if (this._disposed) { return; }
      this._panel.webview.postMessage({
        type: 'allProcessStats',
        flat: (stats as any).flat || [],
        hierarchy: (stats as any).hierarchy || [],
        rootJobs: (stats as any).rootJobs || []
      });
    } catch (err) {
      if (this._disposed) { return; }
      // Send empty stats on error to clear the loading state
      try {
        this._panel.webview.postMessage({
          type: 'allProcessStats',
          flat: [],
          hierarchy: [],
          rootJobs: []
        });
      } catch { /* panel disposed */ }
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
      const node = plan.jobs.get(nodeId);
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
      for (const [otherId, otherNode] of plan.jobs) {
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
   * Debounced to prevent infinite refresh loops from subscription re-creation.
   */
  private _refreshDebounce?: ReturnType<typeof setTimeout>;
  private _refreshCount = 0;
  private _refreshBurstStart = 0;
  private _refreshBurstCount = 0;
  private async _forceFullRefresh() {
    if (this._disposed) { return; }
    // Debounce: suppress rapid consecutive refresh requests
    if (this._refreshDebounce) { return; }
    
    // Burst detection: if >5 refreshes in 10 seconds, stop to prevent OOM crash
    const now = Date.now();
    if (now - this._refreshBurstStart > 10000) {
      this._refreshBurstStart = now;
      this._refreshBurstCount = 0;
    }
    this._refreshBurstCount++;
    if (this._refreshBurstCount > 5) {
      panelLog.error(`_forceFullRefresh BURST LIMIT (${this._refreshBurstCount} in 10s) — halting to prevent crash`);
      return;
    }
    
    this._refreshCount++;
    crashLog(`_forceFullRefresh #${this._refreshCount} for plan ${this._planId.slice(0, 8)}`);
    panelLog.warn(`_forceFullRefresh #${this._refreshCount} for plan ${this._planId.slice(0, 8)}`);
    this._refreshDebounce = setTimeout(() => { this._refreshDebounce = undefined; }, 500);

    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = (plan.spec as any)?.status === 'scaffolding' ? 'scaffolding' : (sm?.computePlanStatus() || 'pending');
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    // Get global capacity stats
    const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
    
    // Update hashes to match current state so the next _update()
    // sees no structure change and skips (letting subscriptions handle deltas).
    this._lastStateVersion = plan.stateVersion || 0;
    this._lastStructureHash = JSON.stringify({
      nodes: Array.from(plan.jobs.entries()).map(([id, n]) => [id, n.name, (n as JobNode).dependencies]),
      spec: plan.spec.name
    });
    this._isFirstRender = false;
    
    this._panel.webview.html = this._getHtml(plan, status, recursiveCounts.counts, effectiveEndedAt, recursiveCounts.totalNodes, globalCapacityStats);
    this._setupSubscriptions();
  }

  /**
   * Re-render the panel HTML if the Plan state has changed since the last render.
   * Uses a JSON state hash to skip redundant re-renders.
   * Incremental status and node-colour updates are handled by the subscription manager.
   */
  private async _update() {
    if (this._disposed) { return; }
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = (plan.spec as any)?.status === 'scaffolding' ? 'scaffolding' : (sm?.computePlanStatus() || 'pending');
    
    // Get recursive counts including all child plans (for accurate totals)
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const counts = recursiveCounts.counts;
    const totalNodes = recursiveCounts.totalNodes;
    
    // Structure hash: nodes and their dependencies (doesn't change during execution)
    const structureHash = JSON.stringify({
      nodes: Array.from(plan.jobs.entries()).map(([id, n]) => [id, n.name, (n as JobNode).dependencies]),
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
    
    // If structure changed or first render, do full HTML render then set up subscriptions
    if (structureChanged || this._isFirstRender) {
      this._isFirstRender = false;
      // Compute effective endedAt from node data for accurate duration
      const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
      // Get global capacity stats for initial render
      const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
      this._panel.webview.html = this._getHtml(plan, status, counts, effectiveEndedAt, totalNodes, globalCapacityStats);
      this._setupSubscriptions();
      return;
    }

    // Non-structural change: subscription manager delivers status/node deltas on the next tick.
  }
  
  /**
   * Set up (or reset) WebView subscriptions after a full HTML rebuild.
   *
   * Creates one planState subscription for overall plan status and one
   * nodeState subscription per node (keyed by planId:nodeId, tagged with the
   * sanitized Mermaid node ID). The subscription manager delivers
   * `subscriptionData` messages to the webview on each pulse tick.
   */
  private _setupSubscriptions(): void {
    const plan = this._planRunner.get(this._planId);
    if (!plan) { return; }

    const nodeCount = plan.nodeStates.size;
    const groupCount = plan.groupStates.size;
    crashLog(`_setupSubscriptions: ${nodeCount} nodes, ${groupCount} groups, planId=${this._planId.slice(0, 8)}`);
    panelLog.warn(`_setupSubscriptions: ${nodeCount} nodes, ${groupCount} groups, planId=${this._planId.slice(0, 8)}`);

    // Clear any subscriptions from the previous render
    this._subscriptionManager.disposePanel(this._panelId);

    // Subscribe to overall plan state (status, counts, progress, timestamps)
    this._subscriptionManager.subscribe(
      this._panelId,
      this._panel.webview,
      'planState',
      this._planId,
      'planState',
    );

    // Subscribe to each node's execution state for targeted DAG colour updates
    for (const nodeId of plan.nodeStates.keys()) {
      this._subscriptionManager.subscribe(
        this._panelId,
        this._panel.webview,
        'nodeState',
        `${this._planId}:${nodeId}`,
        this._sanitizeId(nodeId),
      );
    }

    // Also subscribe to group states so group container colours update
    for (const groupId of plan.groupStates.keys()) {
      this._subscriptionManager.subscribe(
        this._panelId,
        this._panel.webview,
        'nodeState',
        `${this._planId}:${groupId}`,
        this._sanitizeId(groupId),
      );
    }

    // Subscribe to topology changes — triggers full Mermaid DAG rebuild
    // when nodes are added/removed (e.g., context pressure fan-out reshape).
    this._subscriptionManager.subscribe(
      this._panelId,
      this._panel.webview,
      'planTopology',
      this._planId,
      'planTopology',
    );
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
    const total = totalNodes ?? plan.jobs.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Repair missing group maps if groupStates exist but groupPathToId is empty.
    // This can happen when plans were persisted before the groups/groupPathToId
    // sync fix, leaving groupStates orphaned from their path mappings.
    this._repairGroupMapsIfNeeded(plan);

    // Build Mermaid diagram
    const { diagram: mermaidDef, nodeTooltips, edgeData } = buildMermaidDiagram(plan);
    
    // Build node data for click handling
    const nodeData: Record<string, { nodeId: string; planId: string; type: string; name: string; startedAt?: number; endedAt?: number; status: string; version: number }> = {};
    
    // Collect all node data with prefixes matching Mermaid IDs
    for (const [nodeId, node] of plan.jobs) {
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
      // Resolve name from groups map, groupPathToId reverse lookup, or job nodes fallback
      let name = plan.groups.get(groupId)?.name;
      if (!name) {
        for (const [path, id] of plan.groupPathToId) {
          if (id === groupId) { name = path.split('/').pop(); break; }
        }
      }
      if (!name) {
        for (const [, node] of plan.jobs) {
          if ((node as JobNode).groupId === groupId && (node as JobNode).group) {
            name = ((node as JobNode).group as string).split('/').pop();
            break;
          }
        }
      }
      nodeData[sanitizedId] = {
        nodeId: groupId,
        planId: plan.id,
        type: 'group',
        name: name || groupId,
        startedAt: state?.startedAt,
        endedAt: state?.endedAt,
        status: state?.status || 'pending',
        version: state?.version || 0,
      };
    }
    
    // Build timeline data for the timeline chart (only if timeline is enabled)
    const showTimeline = this._shouldShowTimeline();
    let timelineData: any = null;
    if (showTimeline) {
      const timelineNodes: Array<{
        nodeId: string;
        name: string;
        group?: string;
        status: string;
        scheduledAt?: number;
        startedAt?: number;
        endedAt?: number;
        dependencies?: string[];
        stepStatuses?: Record<string, string>;
        attempts?: Array<{
          attemptNumber: number;
          status: string;
          startedAt?: number;
          endedAt?: number;
          failedPhase?: string;
          stepStatuses?: Record<string, string>;
          phaseTiming?: Array<{ phase: string; startedAt: number; endedAt?: number }>;
        }>;
      }> = [];
      for (const [nodeId, node] of plan.jobs) {
        const state = plan.nodeStates.get(nodeId);
        if (!state) { continue; }
        // Get attempt history
        const attempts = (state.attemptHistory || []).map(a => ({
          attemptNumber: a.attemptNumber,
          status: a.status,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          failedPhase: a.failedPhase,
          triggerType: a.triggerType || 'initial',
          stepStatuses: a.stepStatuses || {},
          phaseDurations: a.phaseMetrics ? Object.entries(a.phaseMetrics).map(([phase, metrics]: [string, any]) => ({
            phase,
            durationMs: metrics?.durationMs || 0,
            status: (a.stepStatuses as any)?.[phase] || 'succeeded',
          })).filter((pd: any) => pd.durationMs > 0) : [],
          phaseTiming: a.phaseTiming || [],
        }));
        // nodeState.startedAt is set-once (first attempt start) and never overwritten.
        // For backward compat with old plans where it WAS overwritten, fall back to earliest attempt.
        const earliestAttemptStart = state.attemptHistory && state.attemptHistory.length > 0
          ? Math.min(...state.attemptHistory.map((a: any) => a.startedAt).filter(Boolean))
          : undefined;
        const effectiveStart = state.startedAt || (isFinite(earliestAttemptStart as number) ? earliestAttemptStart : undefined);
        timelineNodes.push({
          nodeId,
          name: node.name,
          group: (node as JobNode).group,
          status: state.status,
          scheduledAt: state.scheduledAt,
          startedAt: effectiveStart,
          endedAt: state.endedAt,
          dependencies: (node as JobNode).dependencies || [],
          stepStatuses: state.stepStatuses || {},
          attempts,
        });
      }
      timelineData = {
        planStartedAt: plan.startedAt,
        planEndedAt: effectiveEndedAt || plan.endedAt,
        planCreatedAt: plan.createdAt,
        stateHistory: plan.stateHistory || [],
        pauseHistory: plan.pauseHistory || [],
        nodes: timelineNodes,
      };
    }
    
    // Get branch info
    const baseBranch = plan.spec.baseBranch || 'main';
    const targetBranch = plan.targetBranch || baseBranch;
    const showBranchFlow = baseBranch !== targetBranch || plan.targetBranch;
    
    // Build work summary from node states
    const workSummaryHtml = this._buildWorkSummaryHtml(plan);
    const metricsBarHtml = this._buildMetricsBarHtml(plan);
    
    // Generate webview bundle script tag
    const bundleScriptTag = webviewScriptTag(this._panel.webview, this._extensionUri, 'planDetail');
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${this._panel.webview.cspSource} https://cdn.jsdelivr.net;">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  ${bundleScriptTag}
  <style>
    ${renderPlanDetailStyles()}
    ${renderTabBarStyles()}
    ${showTimeline ? renderTimelineStyles() : ''}
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
  ${renderPlanControls({ status, isChainedPause: !!(plan.resumeAfterPlan && plan.isPaused) })}
  </div>
  ${status === 'scaffolding' ? '<div class="scaffolding-message">Plan is being built. Jobs appear as they are added via MCP.</div>' : ''}
  ${status === 'pending-start' ? '<div class="scaffolding-message">⏳ Pending Start — review the plan and click <strong>Start</strong> when ready.</div>' : ''}
  ${(status === 'paused' || status === 'pending-start') && plan.resumeAfterPlan ? (() => {
    const depPlan = this._planRunner.getPlan(plan.resumeAfterPlan!);
    const depName = depPlan ? depPlan.spec.name : plan.resumeAfterPlan;
    const icon = status === 'pending-start' ? '⏳' : '⏸';
    return `<div class="scaffolding-message">${icon} Waiting for plan "${escapeHtml(depName!)}" to succeed before auto-starting.</div>`;
  })() : ''}
  ${renderPlanNodeCard({ total, counts, progress, status })}
  ${metricsBarHtml}
  ${this._buildPlanConfigHtml(plan)}
  ${renderPlanDag({ mermaidDef, status })}
  ${showTimeline ? renderPlanTimeline({ status }) : ''}
  <!-- Running Processes (below both DAG and Timeline) -->
  <div class="processes-section" id="processesSection" style="${status === 'running' ? '' : 'display:none;'}">
    <h3>Running Processes</h3>
    <div id="processesContainer">
      <div class="processes-loading">Loading processes...</div>
    </div>
  </div>
  ${workSummaryHtml}
  ${renderPlanScripts({ nodeData, nodeTooltips, mermaidDef, edgeData, globalCapacityStats: globalCapacityStats || null, timelineData })}
</body>
</html>`;
  }
  
  /**
   * Check if timeline view should be shown based on experimental feature flag.
   */
  private _shouldShowTimeline(): boolean {
    const config = vscode.workspace.getConfiguration('copilotOrchestrator');
    return config.get<boolean>('experimental.showTimeline', false);
  }
  
  /**
   * Build plan configuration section HTML showing global settings.
   */
  private _buildPlanConfigHtml(plan: PlanInstance): string {
    const rows: string[] = [];

    // Environment variables
    if (plan.env && Object.keys(plan.env).length > 0) {
      const envRows = Object.entries(plan.env).map(([k, v]) => {
        // Redact sensitive-looking values
        const display = /token|key|secret|password|auth/i.test(k)
          ? '***'
          : escapeHtml(String(v));
        return `<div class="plan-config-env-row"><code class="plan-config-env-key">${escapeHtml(k)}</code><span class="plan-config-env-eq">=</span><code class="plan-config-env-val">${display}</code></div>`;
      }).join('');
      rows.push(`<div class="plan-config-item"><div class="plan-config-label">🔑 Environment Variables</div><div class="plan-config-value">${envRows}</div></div>`);
    }

    // Parallelism
    const maxP = plan.maxParallel || (plan.spec as any)?.maxParallel || 0;
    rows.push(`<div class="plan-config-item"><div class="plan-config-label">⚡ Max Parallel</div><div class="plan-config-value">${maxP === 0 ? 'Unlimited' : maxP}</div></div>`);

    // Cleanup behavior
    rows.push(`<div class="plan-config-item"><div class="plan-config-label">🧹 Auto-Cleanup</div><div class="plan-config-value">${plan.cleanUpSuccessfulWork ? 'Yes — worktrees removed after success' : 'No — worktrees kept'}</div></div>`);

    // Repository path
    if (plan.repoPath) {
      rows.push(`<div class="plan-config-item"><div class="plan-config-label">📁 Repository</div><div class="plan-config-value"><code>${escapeHtml(plan.repoPath)}</code></div></div>`);
    }

    // Worktree root
    if (plan.worktreeRoot) {
      rows.push(`<div class="plan-config-item"><div class="plan-config-label">🌲 Worktree Root</div><div class="plan-config-value"><code>${escapeHtml(plan.worktreeRoot)}</code></div></div>`);
    }

    // Snapshot branch
    if (plan.snapshot?.branch) {
      rows.push(`<div class="plan-config-item"><div class="plan-config-label">📸 Snapshot Branch</div><div class="plan-config-value"><code>${escapeHtml(plan.snapshot.branch)}</code>${plan.snapshot.baseCommit ? ` <span class="plan-config-hint">(from ${plan.snapshot.baseCommit.slice(0, 8)})</span>` : ''}</div></div>`);
    }

    // Plan ID
    rows.push(`<div class="plan-config-item"><div class="plan-config-label">🆔 Plan ID</div><div class="plan-config-value"><code style="font-size:10px;opacity:0.7;">${plan.id}</code></div></div>`);

    if (rows.length === 0) { return ''; }

    return `
  <div class="plan-config-section">
    <div class="plan-config-header" id="plan-config-header">
      <span class="plan-config-chevron">▶</span>
      <h3>Plan Configuration</h3>
    </div>
    <div class="plan-config-body" id="plan-config-body" style="display:none;">
      ${rows.join('')}
    </div>
  </div>`;
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

  /**
   * Convert a node ID (UUID) to a Mermaid-safe identifier.
   * Simply prefixes with 'n' and strips hyphens from UUID.
   * 
  /**
   * Rebuild groups and groupPathToId maps when they are empty but groupStates
   * has entries. This repairs plans whose metadata was persisted before the
   * saveStateSync fix that added groups/groupPathToId persistence.
   *
   * Matches group paths (from job nodes) to groupState UUIDs using the same
   * creation order that buildGroupsFromJobs uses during finalization.
   */
  private _repairGroupMapsIfNeeded(plan: PlanInstance): void {
    if (plan.groupPathToId.size > 0 || plan.groupStates.size === 0) { return; }

    // Collect unique leaf group paths from job nodes (preserves insertion order)
    const leafPaths = new Set<string>();
    for (const [, node] of plan.jobs) {
      const group = (node as JobNode).group;
      if (group) { leafPaths.add(group); }
    }
    if (leafPaths.size === 0) { return; }

    // Expand to full hierarchy (parents first), replicating buildGroupsFromJobs order
    const creationOrder: string[] = [];
    const seen = new Set<string>();
    for (const leafPath of leafPaths) {
      const parts = leafPath.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!seen.has(current)) {
          seen.add(current);
          creationOrder.push(current);
        }
      }
    }

    const groupUuids = [...plan.groupStates.keys()];
    if (creationOrder.length !== groupUuids.length) { return; }

    // Match paths to UUIDs positionally (same order as original creation)
    for (let i = 0; i < creationOrder.length; i++) {
      const path = creationOrder[i];
      const uuid = groupUuids[i];
      plan.groupPathToId.set(path, uuid);

      const pathName = path.split('/').pop() || path;
      const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : undefined;
      const parentGroupId = parentPath ? plan.groupPathToId.get(parentPath) : undefined;

      plan.groups.set(uuid, {
        id: uuid,
        name: pathName,
        path,
        parentGroupId,
        childGroupIds: [],
        nodeIds: [],
        allNodeIds: [],
        totalNodes: 0,
      });
    }

    // Link parent → child relationships
    for (const [, group] of plan.groups) {
      if (group.parentGroupId) {
        const parent = plan.groups.get(group.parentGroupId);
        if (parent && !parent.childGroupIds.includes(group.id)) {
          parent.childGroupIds.push(group.id);
        }
      }
    }

    // Set node memberships and assign groupId on job nodes
    for (const [nodeId, node] of plan.jobs) {
      const jn = node as JobNode;
      if (jn.group) {
        const gid = plan.groupPathToId.get(jn.group);
        if (gid) {
          jn.groupId = gid;
          const grp = plan.groups.get(gid);
          if (grp) {
            grp.nodeIds.push(nodeId);
            grp.allNodeIds.push(nodeId);
            grp.totalNodes++;
            let pid = grp.parentGroupId;
            while (pid) {
              const parent = plan.groups.get(pid);
              if (parent) {
                parent.allNodeIds.push(nodeId);
                parent.totalNodes++;
                pid = parent.parentGroupId;
              } else { break; }
            }
          }
        }
      }
    }
  }

  /**
   * Sanitise a UUID for use as a Mermaid node/subgraph ID.
   *
   * @param id - The raw node ID (UUID like "abc12345-6789-...").
   * @returns Mermaid-safe ID like "nabc123456789..."
   */
  private _sanitizeId(id: string): string {
    return 'n' + id.replace(/-/g, '');
  }
}
