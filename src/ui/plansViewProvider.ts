/**
 * @fileoverview Plans view Provider
 * 
 * Displays a list of Plans with their execution status in the sidebar.
 * Supports clicking to open detailed Plan view.
 * 
 * @module ui/plansViewProvider
 */

import * as vscode from 'vscode';
import { PlanRunner, PlanInstance, PlanStatus, NodeStatus } from '../plan';
import { planDetailPanel } from './panels/planDetailPanel';
import { NodeDetailPanel } from './panels/nodeDetailPanel';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../interfaces/IPulseEmitter';
import type { IPRLifecycleManager } from '../interfaces/IPRLifecycleManager';
import type { ManagedPR } from '../plan/types/prLifecycle';
import type { IReleaseManager } from '../interfaces/IReleaseManager';
import type { ReleaseDefinition } from '../plan/types/release';
import { WebViewSubscriptionManager } from './webViewSubscriptionManager';
import { PlanListProducer } from './producers/planListProducer';
import { CapacityProducer } from './producers/capacityProducer';
import { PRListProducer } from './producers/prListProducer';
import { ReleaseListProducer } from './producers/releaseListProducer';

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
  private _subscriptionManager: WebViewSubscriptionManager;
  
  /**
   * @param _context - The extension context for managing subscriptions and resources.
   * @param _planRunner - The {@link PlanRunner} instance used to query Plan state.
   * @param _pulse - The pulse emitter for periodic updates.
   * @param _prLifecycleManager - The PR lifecycle manager (optional).
   * @param _releaseManager - The release manager (optional).
   */
  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _planRunner: PlanRunner,
    private readonly _pulse: IPulseEmitter,
    private readonly _prLifecycleManager?: IPRLifecycleManager,
    private readonly _releaseManager?: import('../interfaces/IReleaseManager').IReleaseManager
  ) {
    // Set up subscription manager for pulse-based plan list deltas
    this._subscriptionManager = new WebViewSubscriptionManager();
    this._subscriptionManager.registerProducer(new PlanListProducer(_planRunner));
    this._subscriptionManager.registerProducer(new CapacityProducer(_planRunner as any));
    if (_prLifecycleManager) {
      this._subscriptionManager.registerProducer(new PRListProducer(_prLifecycleManager));
    }
    if (_releaseManager) {
      this._subscriptionManager.registerProducer(new ReleaseListProducer(_releaseManager));
    }

    // ── Event wiring ────────────────────────────────────────────────────
    // ALL UI data delivery flows through producers via WebViewSubscriptionManager:
    //   - PlanListProducer: plan add/remove/status (with removal detection)
    //   - CapacityProducer: global capacity stats
    //   - PRListProducer: PR add/remove/status changes
    //   - ReleaseListProducer: release add/remove/status changes
    //
    // No direct PlanRunner, PRLifecycleManager, or ReleaseManager event
    // listeners needed for data delivery.
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

    // Subscribe sidebar to PlanListProducer for pulse-based incremental updates
    const sidebarPanelId = 'sidebar';
    this._subscriptionManager.disposePanel(sidebarPanelId);
    this._subscriptionManager.subscribe(
      sidebarPanelId,
      webviewView.webview,
      'planList',
      'all',
      'planList',
    );
    // Subscribe to capacity updates (running jobs, global parallel limits)
    this._subscriptionManager.subscribe(
      sidebarPanelId,
      webviewView.webview,
      'capacity',
      'all',
      'capacity',
    );
    // Subscribe to PR list updates
    this._subscriptionManager.subscribe(
      sidebarPanelId,
      webviewView.webview,
      'prList',
      'all',
      'prList',
    );
    // Subscribe to release list updates
    this._subscriptionManager.subscribe(
      sidebarPanelId,
      webviewView.webview,
      'releaseList',
      'all',
      'releaseList',
    );

    // Pause/resume subscription when sidebar visibility changes
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._subscriptionManager.resumePanel(sidebarPanelId);
      } else {
        this._subscriptionManager.pausePanel(sidebarPanelId);
      }
    });
    
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
        case 'archivePlan':
          vscode.commands.executeCommand('orchestrator.archivePlan', message.planId);
          break;
        case 'recoverPlan':
          vscode.commands.executeCommand('orchestrator.recoverPlan', message.planId);
          break;
        case 'bulkAction':
          this._handleBulkAction(message.action, message.planIds);
          break;
        case 'adoptPR':
          // Trigger the adopt PR command
          vscode.commands.executeCommand('orchestrator.adoptPR');
          break;
        case 'openPR':
          // Open Active PR Panel for the PR
          vscode.commands.executeCommand('orchestrator.showActivePRPanel', message.prId);
          break;
        case 'createRelease':
          // Trigger the create release command
          vscode.commands.executeCommand('orchestrator.createRelease');
          break;
        case 'createReleaseFromBranch':
          this._handleCreateReleaseFromBranch();
          break;
        case 'openRelease':
          // Open Release Panel for the release
          vscode.commands.executeCommand('orchestrator.showReleasePanel', message.releaseId);
          break;
        case 'deleteRelease':
          if (message.releaseId && this._releaseManager) {
            const rel = this._releaseManager.getRelease(message.releaseId);
            const name = rel ? rel.name : message.releaseId.slice(0, 8);
            vscode.window.showWarningMessage(
              `Delete release "${name}"? This cannot be undone.`,
              { modal: true },
              'Delete'
            ).then((choice) => {
              if (choice === 'Delete' && this._releaseManager) {
                this._releaseManager.deleteRelease(message.releaseId);
                this.refresh();
              }
            });
          }
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
    
    // Pulse: 1-second signal forwarding to webview + subscription tick
    this._pulseSubscription = this._pulse.onPulse(() => {
      if (this._view) {
        this._view.webview.postMessage({ type: 'pulse' });
        // Deliver all subscription deltas (plans, capacity, PRs, releases)
        this._subscriptionManager.tick().catch(() => { /* error logged internally */ });
      }
    });
    
    webviewView.onDidDispose(() => {
      if (this._pulseSubscription) {
        this._pulseSubscription.dispose();
      }
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
      if (this._capacityDebounceTimer) {
        clearTimeout(this._capacityDebounceTimer);
      }
      this._subscriptionManager.disposePanel(sidebarPanelId);
    });
  }
  
  /**
   * Handle bulk actions on multiple plans.
   * 
   * @param action - The action to perform (resume, pause, cancel, retry, finalize, delete)
   * @param planIds - Array of plan IDs to act on
   */
  private async _handleBulkAction(action: string, planIds: string[]) {
    if (!planIds || planIds.length === 0) {
      return;
    }
    
    // Actions that use single-plan commands (no bulk* variant exists)
    const singlePlanActions: Record<string, string> = {
      'archive': 'orchestrator.archivePlan',
      'recover': 'orchestrator.recoverPlan',
      'assignToRelease': 'orchestrator.assignToRelease',
      'createReleaseFromPlans': 'orchestrator.createReleaseFromPlans',
    };
    
    if (singlePlanActions[action]) {
      const command = singlePlanActions[action];
      if (action === 'createReleaseFromPlans' || action === 'assignToRelease') {
        // These take an array of planIds
        await vscode.commands.executeCommand(command, planIds);
      } else {
        // Archive/recover: loop over individual plans
        for (const planId of planIds) {
          await vscode.commands.executeCommand(command, planId);
        }
      }
      return;
    }
    
    // Standard bulk commands (resume, pause, cancel, retry, finalize, delete)
    const commandAction = action.charAt(0).toUpperCase() + action.slice(1);
    await vscode.commands.executeCommand(
      `orchestrator.bulk${commandAction}`,
      planIds
    );
  }
  
  /**
   * Build data object for a single plan (used by both initial load and per-plan events).
   */
  private _buildPlanData(plan: PlanInstance) {
    const sm = this._planRunner.getStateMachine(plan.id);
    // Check if plan is archived by looking at stateHistory
    let status: string;
    if (plan.stateHistory && plan.stateHistory.length > 0) {
      const lastState = plan.stateHistory[plan.stateHistory.length - 1];
      if (lastState.to === 'archived') {
        status = 'archived';
      } else if ((plan.spec as any)?.status === 'scaffolding') {
        status = 'scaffolding';
      } else {
        status = sm?.computePlanStatus() || 'pending';
      }
    } else {
      // Scaffolding plans use their spec status directly (state machine doesn't understand them)
      status = (plan.spec as any)?.status === 'scaffolding' ? 'scaffolding' : (sm?.computePlanStatus() || 'pending');
    }
    
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      completed_split: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    const counts = sm?.getStatusCounts() || defaultCounts;
    const total = plan.jobs.size;
    const completed = counts.succeeded + counts.failed + counts.blocked;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Find release info for this plan
    let releaseInfo: { id: string; name: string; status: string } | undefined;
    if (this._releaseManager) {
      const allReleases = this._releaseManager.getAllReleases();
      const release = allReleases.find(r => r.planIds.includes(plan.id));
      if (release) {
        releaseInfo = {
          id: release.id,
          name: release.name,
          status: release.status,
        };
      }
    }
    
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
      release: releaseInfo,
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
    // Auto-switch to Plans tab
    this._view.webview.postMessage({ type: 'switchTab', tab: 'plans' });
  }
  
  /** Send notification that a plan was deleted. */
  private _sendPlanDeleted(planId: string) {
    if (!this._view) {return;}
    this._view.webview.postMessage({ type: 'planDeleted', planId });
    const total = this._planRunner.getAll().filter(p => !p.parentPlanId).length;
    this._view.webview.postMessage({ type: 'badgeUpdate', total });
  }
  
  /** 
   * Refresh capacity stats independently (called on its own cadence + on events).
   * Debounced to avoid flooding the webview when multiple node transitions fire rapidly.
   */
  private _capacityDebounceTimer?: NodeJS.Timeout;
  private async _refreshCapacity() {
    if (!this._view) {return;}
    // Debounce: if multiple events fire within 200ms, only send one update
    if (this._capacityDebounceTimer) {clearTimeout(this._capacityDebounceTimer);}
    this._capacityDebounceTimer = setTimeout(async () => {
      this._capacityDebounceTimer = undefined;
      if (!this._view) {return;}
      try {
        const globalStats = this._planRunner.getGlobalStats();
        const globalCapacityStats = await this._planRunner.getGlobalCapacityStats().catch((err: any) => {
          // Log but don't fail — global capacity is optional (single-instance mode)
          return null;
        });
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
      } catch { /* webview may have been disposed between debounce and fire */ }
    }, 200);
  }

  /**
   * Build data object for a single PR (used by both initial load and per-PR events).
   */
  private _buildPRData(pr: ManagedPR) {
    return {
      id: pr.id,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      title: pr.title,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      status: pr.status,
      isDraft: pr.status === 'adopted' || pr.status === 'monitoring',
      priority: pr.priority ?? 0,
      adoptedAt: pr.adoptedAt,
      unresolvedComments: pr.unresolvedComments ?? 0,
      failingChecks: pr.failingChecks ?? 0,
    };
  }

  /** Send a per-PR state change to the webview. */
  private _sendPRStateChange(pr: ManagedPR) {
    if (!this._view) {return;}
    const data = this._buildPRData(pr);
    this._view.webview.postMessage({ type: 'prStateChange', pr: data });
  }

  /** Send notification that a new PR was added. */
  private _sendPRAdded(pr: ManagedPR) {
    if (!this._view) {return;}
    const data = this._buildPRData(pr);
    this._view.webview.postMessage({ type: 'prAdded', pr: data });
    // Auto-switch to PRs tab
    this._view.webview.postMessage({ type: 'switchTab', tab: 'prs' });
  }

  /** Send notification that a PR was deleted. */
  private _sendPRDeleted(id: string) {
    if (!this._view) {return;}
    this._view.webview.postMessage({ type: 'prDeleted', prId: id });
  }

  /** Refresh PRs independently. */
  private async _refreshPRs() {
    if (!this._view || !this._prLifecycleManager) {return;}
    const prs = this._prLifecycleManager.getAllManagedPRs();
    const prData = prs.map(pr => this._buildPRData(pr));
    this._view.webview.postMessage({
      type: 'prsUpdate',
      prs: prData,
    });
  }

  /**
   * Build data object for a single release (used by both initial load and per-release events).
   */
  private _buildReleaseData(release: ReleaseDefinition) {
    // Calculate progress based on status
    let progress = 0;
    switch (release.status) {
      case 'drafting':
        progress = 10;
        break;
      case 'merging':
        progress = 30;
        break;
      case 'creating-pr':
        progress = 50;
        break;
      case 'monitoring':
      case 'addressing':
        progress = 75;
        break;
      case 'succeeded':
        progress = 100;
        break;
      case 'failed':
      case 'canceled':
        progress = 0;
        break;
    }
    
    return {
      id: release.id,
      name: release.name,
      status: release.status,
      releaseBranch: release.releaseBranch,
      targetBranch: release.targetBranch,
      planCount: release.planIds.length,
      prNumber: release.prNumber,
      prUrl: release.prUrl,
      progress,
      createdAt: release.createdAt,
      startedAt: release.startedAt,
      endedAt: release.endedAt,
    };
  }

  /** Send a per-release state change to the webview. */
  private _sendReleaseStateChange(release: ReleaseDefinition) {
    if (!this._view) {return;}
    const data = this._buildReleaseData(release);
    this._view.webview.postMessage({ type: 'releaseStateChange', release: data });
  }

  /** Send notification that a new release was added. */
  private _sendReleaseAdded(release: ReleaseDefinition) {
    if (!this._view) {return;}
    const data = this._buildReleaseData(release);
    this._view.webview.postMessage({ type: 'releaseAdded', release: data });
    // Auto-switch to Releases tab
    this._view.webview.postMessage({ type: 'switchTab', tab: 'releases' });
  }

  /** Send notification that a release was deleted. */
  private _sendReleaseDeleted(id: string) {
    if (!this._view) {return;}
    this._view.webview.postMessage({ type: 'releaseDeleted', releaseId: id });
  }

  /** Refresh releases independently. */
  private async _refreshReleases() {
    if (!this._view || !this._releaseManager) {return;}
    const releases = this._releaseManager.getAllReleases();
    const releaseData = releases.map(release => this._buildReleaseData(release));
    this._view.webview.postMessage({
      type: 'releasesUpdate',
      releases: releaseData,
    });
  }

  /**
   * Handle "From Current Branch" button click.
   * Detects current git branch and creates a release for it.
   */
  private async _handleCreateReleaseFromBranch() {
    // Delegate to the registered command which has the full implementation
    vscode.commands.executeCommand('orchestrator.createReleaseFromBranch');
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
    
    // PR and release data are delivered by PRListProducer and ReleaseListProducer
    // via the subscription manager on the next pulse tick. No explicit refresh needed.
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