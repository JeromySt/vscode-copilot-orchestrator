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
import { renderPlanHeader, renderPlanControls, renderPlanDag, renderPlanNodeCard, renderPlanSummary, renderMetricsBar, renderPlanScripts, renderPlanDetailStyles, buildMermaidDiagram, renderViewTabBar, renderPlanTimeline, renderTabBarStyles, renderTimelineStyles } from '../templates/planDetail';
import type { PlanSummaryData, PlanMetricsBarData } from '../templates/planDetail';
import { PlanDetailController } from './planDetailController';
import type { PlanDetailDelegate } from './planDetailController';
import type { IDialogService } from '../../interfaces/IDialogService';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';
import { webviewScriptTag } from '../webviewUri';

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
  private _cachedCapacity: { data: any; fetchedAt: number } | null = null;
  private static readonly CAPACITY_CACHE_TTL_MS = 5000;
  
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
    const onPlanUpdated = (planId: string) => {
      if (planId === this._planId) {
        this._update();
      }
    };
    this._planRunner.on('nodeTransition', onNodeTransition);
    this._planRunner.on('planStarted', onPlanStarted);
    this._planRunner.on('planCompleted', onPlanCompleted);
    this._planRunner.on('planUpdated', onPlanUpdated);
    this._disposables.push({ dispose: () => {
      this._planRunner.removeListener('nodeTransition', onNodeTransition);
      this._planRunner.removeListener('planStarted', onPlanStarted);
      this._planRunner.removeListener('planCompleted', onPlanCompleted);
      this._planRunner.removeListener('planUpdated', onPlanUpdated);
    }});
    
    // Subscribe to pulse — forward to webview for client-side duration ticking.
    // Duration counters (plan header + node labels) update purely client-side
    // using data-started timestamps. No server data needed on every tick.
    this._pulseSubscription = this._pulse.onPulse(() => {
      if (!this._disposed) {
        try { this._panel.webview.postMessage({ type: 'pulse' }); } catch { /* panel disposed */ }
      }
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
   * Used when the webview requests a refresh (e.g., after an error).
   */
  private async _forceFullRefresh() {
    if (this._disposed) { return; }
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
    
    // Get global capacity stats
    const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
    
    // Build node status map for incremental updates (includes version, attempts, stepStatuses for timeline)
    const nodeStatuses: Record<string, any> = {};
    for (const [nodeId, state] of plan.nodeStates) {
      const sanitizedId = this._sanitizeId(nodeId);
      const entry: Record<string, any> = {
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
      // Include attempt history so timeline can render new attempt bars
      if (state.attemptHistory && state.attemptHistory.length > 0) {
        entry.attempts = state.attemptHistory.map((a: any) => ({
          attemptNumber: a.attemptNumber, status: a.status,
          startedAt: a.startedAt, endedAt: a.endedAt,
          failedPhase: a.failedPhase, triggerType: a.triggerType || 'initial',
          stepStatuses: a.stepStatuses || {},
          phaseDurations: a.phaseMetrics ? Object.entries(a.phaseMetrics).map(([phase, metrics]: [string, any]) => ({
            phase, durationMs: metrics?.durationMs || 0,
            status: (a.stepStatuses as any)?.[phase] || 'succeeded',
          })).filter((pd: any) => pd.durationMs > 0) : [],
          phaseTiming: a.phaseTiming || [],
        }));
      }
      if (state.stepStatuses) { entry.stepStatuses = state.stepStatuses; }
      if (state.scheduledAt) { entry.scheduledAt = state.scheduledAt; }
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
    
    // If structure changed or first render, do full HTML render
    if (structureChanged || this._isFirstRender) {
      this._isFirstRender = false;
      // Compute effective endedAt from node data for accurate duration
      const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
      this._panel.webview.html = this._getHtml(plan, status, counts, effectiveEndedAt, totalNodes, globalCapacityStats);
      return;
    }
    
    // Otherwise, send incremental status update (preserves zoom/scroll)
    const total = totalNodes ?? plan.jobs.size;
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
      planEndedAt: effectiveEndedAt,
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
    if (this._disposed) { return; }
    const plan = this._planRunner.get(this._planId);
    if (!plan) {return;}
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = (plan.spec as any)?.status === 'scaffolding' ? 'scaffolding' : (sm?.computePlanStatus() || 'pending');
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const counts = recursiveCounts.counts;
    const totalNodes = recursiveCounts.totalNodes;
    const total = totalNodes ?? plan.jobs.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    // Get global capacity stats with caching to avoid async overhead on every pulse tick
    let globalCapacityStats: any = null;
    const now = Date.now();
    if (this._cachedCapacity && (now - this._cachedCapacity.fetchedAt) < planDetailPanel.CAPACITY_CACHE_TTL_MS) {
      globalCapacityStats = this._cachedCapacity.data;
    } else {
      globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
      this._cachedCapacity = { data: globalCapacityStats, fetchedAt: now };
    }
    
    // Build node statuses (with attempt data for timeline)
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
      // Include attempt history for timeline rendering (stepStatuses + phaseTiming)
      if (state.attemptHistory && state.attemptHistory.length > 0) {
        entry.attempts = state.attemptHistory.map((a: any) => ({
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
      }
      // Include current stepStatuses for running nodes (live phase display)
      if (state.stepStatuses) {
        entry.stepStatuses = state.stepStatuses;
      }
      if (state.scheduledAt) {
        entry.scheduledAt = state.scheduledAt;
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
      planEndedAt: effectiveEndedAt,
      globalCapacity: globalCapacityStats ? {
        activeInstances: globalCapacityStats.activeInstances,
        totalGlobalJobs: globalCapacityStats.totalGlobalJobs,
        globalMaxParallel: globalCapacityStats.globalMaxParallel
      } : null
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
    const total = totalNodes ?? plan.jobs.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
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
   * @param id - The raw node ID (UUID like "abc12345-6789-...").
   * @returns Mermaid-safe ID like "nabc123456789..."
   */
  private _sanitizeId(id: string): string {
    return 'n' + id.replace(/-/g, '');
  }
}
