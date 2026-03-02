/**
 * @fileoverview Plans view Provider
 * 
 * Displays a list of Plans with their execution status in the sidebar.
 * Supports clicking to open detailed Plan view.
 * 
 * @module ui/plansViewProvider
 */

import * as vscode from 'vscode';
import { PlanRunner, PlanInstance, PlanStatus, NodeStatus } from '\.\./plan';
import { planDetailPanel } from './panels/planDetailPanel';
import { NodeDetailPanel } from './panels/nodeDetailPanel';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../interfaces/IPulseEmitter';

/**
 * Sidebar webview provider that displays all top-level Plans and their execution status.
 *
 * Renders an interactive list of Plans with progress bars, status badges, and node
 * count summaries. Automatically refreshes when Plans are created, completed, deleted,
 * or when node transitions occur (debounced).
 *
 * **Webview → Extension messages:**
 * - `{ type: 'openPlan', planId: string }` — open the {@link planDetailPanel} for a Plan
 * - `{ type: 'cancelPlan', planId: string }` — cancel a running Plan
 * - `{ type: 'deletePlan', planId: string }` — delete a Plan and close associated panels
 * - `{ type: 'refresh' }` — request a manual data refresh
 *
 * **Extension → Webview messages:**
 * - `{ type: 'update', Plans: PlanData[], total: number, running: number }` — refreshed Plan list
 *
 * **Keyboard shortcuts (when a plan item is focused):**
 * - `Enter` — open plan details panel
 * - `Delete` — delete the plan
 * - `Ctrl+Escape` — cancel the plan (if running)
 * - `Arrow Up/Down` — navigate between plans
 *
 * @example
 * ```ts
 * const provider = new plansViewProvider(context, planRunner);
 * vscode.window.registerWebviewViewProvider(plansViewProvider.viewType, provider);
 * ```
 */
export class plansViewProvider implements vscode.WebviewViewProvider {
  /** View identifier used to register this provider with VS Code. */
  public static readonly viewType = 'orchestrator.plansView';
  
  private _view?: vscode.WebviewView;
  private _pulseSubscription?: PulseDisposable;
  private _debounceTimer?: NodeJS.Timeout;
  private _pulseCounter: number = 0;
  private _initialRefreshDone: boolean = false;
  
  /**
   * @param _context - The extension context for managing subscriptions and resources.
   * @param _planRunner - The {@link PlanRunner} instance used to query Plan state.
   */
  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _planRunner: PlanRunner,
    private readonly _pulse: IPulseEmitter
  ) {
    // Listen for Plan events — emit targeted per-plan messages
    _planRunner.on('planCreated', (plan: PlanInstance) => {
      this._sendPlanAdded(plan);
    });
    _planRunner.on('planStarted', (plan: PlanInstance) => {
      this._sendPlanStateChange(plan.id);
    });
    _planRunner.on('planCompleted', (plan: PlanInstance) => {
      this._sendPlanStateChange(plan.id);
    });
    _planRunner.on('planDeleted', (planId: string) => {
      planDetailPanel.closeForPlan(planId);
      NodeDetailPanel.closeForPlan(planId);
      this._sendPlanDeleted(planId);
    });
    _planRunner.on('planUpdated', (planId: string) => {
      this._sendPlanStateChange(planId);
    });
    _planRunner.on('nodeTransition', (event: any) => {
      const planId = typeof event === 'string' ? event : event?.planId;
      if (planId) {
        this._sendPlanStateChange(planId);
      }
    });
  }
  
  /**
   * Called by VS Code when the webview view becomes visible. Sets up the
   * webview's HTML content, message handling, and periodic refresh for running Plans.
   *
   * Starts a 2-second polling interval that triggers a refresh whenever at least
   * one Plan has a `running` or `pending` status.
   *
   * @param webviewView - The webview view instance provided by VS Code.
   * @param context - Additional context about how the view was resolved.
   * @param _token - Cancellation token (unused).
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._initialRefreshDone = false;
    
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri]
    };
    
    webviewView.webview.html = this._getHtml(webviewView.webview);
    
    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'openPlan':
          // Open plan and take focus
          vscode.commands.executeCommand('orchestrator.showPlanDetails', message.planId, false);
          break;
        case 'previewPlan':
          // Preview plan but keep focus in tree
          vscode.commands.executeCommand('orchestrator.showPlanDetails', message.planId, true);
          break;
        case 'cancelPlan':
          vscode.commands.executeCommand('orchestrator.cancelPlan', message.planId);
          break;
        case 'deletePlan':
          vscode.commands.executeCommand('orchestrator.deletePlan', message.planId);
          break;
        case 'refresh':
          this._initialRefreshDone = true;
          this.refresh();
          break;
      }
    });
    
    // Send initial data when the webview signals 'refresh' (sent at end of
    // its script).  The setTimeout backup handles the case where the webview
    // script fails to send the 'refresh' message.
    setTimeout(() => {
      if (!this._initialRefreshDone) {
        this._initialRefreshDone = true;
        this.refresh();
      }
    }, 500);
    
    // Pulse: 1-second signal forwarding to webview + capacity refresh counter
    this._pulseSubscription = this._pulse.onPulse(() => {
      if (this._view) {
        this._view.webview.postMessage({ type: 'pulse' });
      }
      
      // Capacity refresh every 10 pulses (10 seconds)
      this._pulseCounter++;
      if (this._pulseCounter >= 10) {
        this._pulseCounter = 0;
        this._refreshCapacity();
      }
    });
    
    webviewView.onDidDispose(() => {
      if (this._pulseSubscription) {
        this._pulseSubscription.dispose();
      }
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
    });
  }
  
  /**
   * Build data object for a single plan (used by both initial load and per-plan events).
   */
  private _buildPlanData(plan: PlanInstance) {
    const sm = this._planRunner.getStateMachine(plan.id);
    // Scaffolding plans use their spec status directly (state machine doesn't understand them)
    const status = (plan.spec as any)?.status === 'scaffolding' ? 'scaffolding' : (sm?.computePlanStatus() || 'pending');
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    const counts = sm?.getStatusCounts() || defaultCounts;
    const total = plan.jobs.size;
    const completed = counts.succeeded + counts.failed + counts.blocked;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    return {
      id: plan.id,
      name: plan.spec.name,
      status,
      nodes: plan.jobs.size,
      progress,
      counts: {
        succeeded: counts.succeeded,
        failed: counts.failed,
        running: counts.running,
        pending: counts.pending + counts.ready,
      },
      createdAt: plan.createdAt,
      startedAt: plan.startedAt,
      endedAt: this._planRunner.getEffectiveEndedAt(plan.id) || plan.endedAt,
      issubPlan: !!plan.parentPlanId,
    };
  }
  
  /** Send a per-plan state change to the webview. */
  private _sendPlanStateChange(planId: string) {
    if (!this._view) {return;}
    const plan = this._planRunner.get(planId);
    if (!plan || plan.parentPlanId) {return;} // skip sub-plans
    const data = this._buildPlanData(plan);
    this._view.webview.postMessage({ type: 'planStateChange', plan: data });
  }
  
  /** Send notification that a new plan was added. */
  private _sendPlanAdded(plan: PlanInstance) {
    if (!this._view) {return;}
    if (plan.parentPlanId) {return;} // skip sub-plans
    const data = this._buildPlanData(plan);
    this._view.webview.postMessage({ type: 'planAdded', plan: data });
    // Update total badge
    const total = this._planRunner.getAll().filter(p => !p.parentPlanId).length;
    this._view.webview.postMessage({ type: 'badgeUpdate', total });
  }
  
  /** Send notification that a plan was deleted. */
  private _sendPlanDeleted(planId: string) {
    if (!this._view) {return;}
    this._view.webview.postMessage({ type: 'planDeleted', planId });
    const total = this._planRunner.getAll().filter(p => !p.parentPlanId).length;
    this._view.webview.postMessage({ type: 'badgeUpdate', total });
  }
  
  /** Refresh capacity stats independently (called on its own cadence). */
  private async _refreshCapacity() {
    if (!this._view) {return;}
    const globalStats = this._planRunner.getGlobalStats();
    const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch(() => null);
    this._view.webview.postMessage({
      type: 'capacityUpdate',
      globalStats,
      globalCapacity: globalCapacityStats ? {
        thisInstanceJobs: globalCapacityStats.thisInstanceJobs,
        totalGlobalJobs: globalCapacityStats.totalGlobalJobs,
        globalMaxParallel: globalCapacityStats.globalMaxParallel,
        activeInstances: globalCapacityStats.activeInstances,
        instanceDetails: globalCapacityStats.instanceDetails
      } : null,
    });
  }

  /**
   * Initial load: send all plans to the webview.
   * After this, only per-plan events are sent.
   */
  async refresh() {
    if (!this._view) {return;}
    
    const Plans = this._planRunner.getAll();
    Plans.sort((a, b) => b.createdAt - a.createdAt);
    
    // All plans (including scaffolding) render in the same list — status badge differentiates
    const allPlans = Plans.filter(p => !p.parentPlanId);
    const planData = allPlans.map(plan => this._buildPlanData(plan));
    
    this._view.webview.postMessage({
      type: 'update',
      Plans: planData,
      total: planData.length,
    });
    
    // Kick off first capacity refresh
    this._refreshCapacity();
  }
  
  /**
   * Generate the static HTML shell for the sidebar webview.
   *
   * The returned markup contains the layout, styles, and client-side JavaScript
   * that listens for `update` messages and renders the Plan list dynamically.
   *
   * @returns Full HTML document string for the webview.
   */
  private _getHtml(webview: vscode.Webview): string {
    const { renderPlansViewStyles, renderPlansViewBody, renderPlansViewScripts } = require('./templates/plansView');
    const { webviewScriptTag } = require('./webviewUri');
    const bundleTag = webviewScriptTag(webview, this._context.extensionUri, 'plansList');
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource};">
  ${renderPlansViewStyles()}
</head>
<body>
  ${renderPlansViewBody()}
  ${bundleTag}
  ${renderPlansViewScripts()}
</body>
</html>`;
  }
}