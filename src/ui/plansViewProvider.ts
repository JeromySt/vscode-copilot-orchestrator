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
    
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    
    webviewView.webview.html = this._getHtml();
    
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
          this.refresh();
          break;
      }
    });
    
    // Send initial data (full plan list for first render)
    setTimeout(() => this.refresh(), 100);
    
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
    const status = sm?.computePlanStatus() || 'pending';
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    const counts = sm?.getStatusCounts() || defaultCounts;
    const total = plan.nodes.size;
    const completed = counts.succeeded + counts.failed + counts.blocked;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    return {
      id: plan.id,
      name: plan.spec.name,
      status,
      nodes: plan.nodes.size,
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
    
    const planData = Plans
      .filter(plan => !plan.parentPlanId)
      .map(plan => this._buildPlanData(plan));
    
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
  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    body { 
      font: 12px var(--vscode-font-family); 
      padding: 8px; 
      margin: 0; 
      color: var(--vscode-foreground); 
    }
    .header { 
      display: flex; 
      gap: 8px; 
      margin-bottom: 12px; 
      align-items: center; 
    }
    .header h3 { margin: 0; }
    .pill { 
      padding: 2px 8px; 
      border-radius: 10px; 
      font-size: 11px; 
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
    }
    .plan-item {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    .plan-item:hover,
    .plan-item:focus {
      background: var(--vscode-list-activeSelectionBackground);
      outline: none;
    }
    .plan-item:focus {
      box-shadow: 0 0 0 2px var(--vscode-focusBorder) inset;
      border-left-width: 4px;
    }
    .plan-item.running { border-left-color: var(--vscode-progressBar-background); }
    .plan-item.succeeded { border-left-color: var(--vscode-testing-iconPassed); }
    .plan-item.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .plan-item.partial { border-left-color: var(--vscode-editorWarning-foreground); }
    .plan-item.canceled { border-left-color: var(--vscode-descriptionForeground); }
    
    .plan-name { 
      font-weight: 600; 
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .plan-status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      text-transform: uppercase;
    }
    .plan-status.running { background: rgba(0, 122, 204, 0.2); color: var(--vscode-progressBar-background); }
    .plan-status.succeeded { background: rgba(78, 201, 176, 0.2); color: var(--vscode-testing-iconPassed); }
    .plan-status.failed { background: rgba(244, 135, 113, 0.2); color: var(--vscode-testing-iconFailed); }
    .plan-status.partial { background: rgba(255, 204, 0, 0.2); color: var(--vscode-editorWarning-foreground); }
    .plan-status.pending { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    .plan-status.paused { background: rgba(255, 165, 0, 0.2); color: #ffa500; }
    .plan-status.canceled { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    
    .plan-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
    .plan-progress {
      height: 3px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 2px;
      margin-top: 6px;
    }
    .plan-progress-bar {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .plan-progress-bar.succeeded { background: var(--vscode-testing-iconPassed); }
    .plan-progress-bar.failed { background: var(--vscode-testing-iconFailed); }
    
    .empty { 
      padding: 20px; 
      text-align: center; 
      opacity: 0.6; 
    }
    .empty code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      font-size: 10px;
      padding: 2px 6px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .global-capacity-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      margin-bottom: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
    }
    .capacity-label {
      font-weight: 600;
    }
    .capacity-jobs {
      color: var(--vscode-foreground);
    }
    .capacity-instances {
      color: var(--vscode-descriptionForeground);
      cursor: help;
    }
    .capacity-instances.multiple {
      color: var(--vscode-charts-yellow);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="header">
    <h3>Plans</h3>
    <span class="pill" id="badge">0 total</span>
  </div>
  <div class="global-capacity-bar" id="globalCapacityBar" style="display: none;">
    <span class="capacity-label">Global Capacity:</span>
    <span class="capacity-jobs">
      <span id="globalRunningJobs">0</span>/<span id="globalMaxParallel">16</span> jobs
    </span>
    <span class="capacity-instances" title="VS Code instances using orchestrator">
      <span id="activeInstances">1</span> instance(s)
    </span>
  </div>
  <div class="global-stats" id="globalStats" style="display: none; margin-bottom: 10px; padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; font-size: 11px;">
    <span>Jobs: <span id="runningJobs">0</span>/<span id="maxParallel">8</span></span>
    <span style="margin-left: 8px;" id="queuedSection">Queued: <span id="queuedJobs">0</span></span>
  </div>
  <div id="plans"><div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div></div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    // ── Inline EventBus ──────────────────────────────────────────────────
    const EventBus = (function() {
      function EB() { this._h = new Map(); }
      EB.prototype.on = function(topic, fn) {
        var set = this._h.get(topic);
        if (!set) { set = new Set(); this._h.set(topic, set); }
        set.add(fn);
        var active = true;
        var self = this;
        return { get isActive() { return active; }, topic: topic, unsubscribe: function() {
          if (!active) return; active = false;
          var s = self._h.get(topic); if (s) { s.delete(fn); if (s.size === 0) self._h.delete(topic); }
        }};
      };
      EB.prototype.emit = function(topic, data) {
        var set = this._h.get(topic);
        if (!set) return;
        var snapshot = Array.from(set);
        for (var i = 0; i < snapshot.length; i++) snapshot[i](data);
      };
      EB.prototype.clear = function(topic) {
        if (topic !== undefined) this._h.delete(topic); else this._h.clear();
      };
      return EB;
    })();

    // ── Inline SubscribableControl ───────────────────────────────────────
    function SubscribableControl(bus, controlId) {
      this.bus = bus;
      this.controlId = controlId;
      this.subs = [];
      this.disposed = false;
      this.pendingMicrotask = false;
      this.pendingChildHandler = null;
    }
    
    SubscribableControl.prototype.subscribe = function(topic, handler) {
      var sub = this.bus.on(topic, handler);
      this.subs.push(sub);
      return sub;
    };
    
    SubscribableControl.prototype.subscribeToChild = function(childId, handler) {
      this.pendingChildHandler = handler;
      var self = this;
      var sub = this.bus.on('control:' + childId + ':updated', function() {
        if (self.disposed) return;
        if (!self.pendingMicrotask) {
          self.pendingMicrotask = true;
          (function() {
            if (typeof queueMicrotask === 'function') {
              queueMicrotask(function() {
                self.pendingMicrotask = false;
                if (!self.disposed && self.pendingChildHandler) {
                  self.pendingChildHandler();
                }
              });
            } else {
              Promise.resolve().then(function() {
                self.pendingMicrotask = false;
                if (!self.disposed && self.pendingChildHandler) {
                  self.pendingChildHandler();
                }
              });
            }
          })();
        }
      });
      this.subs.push(sub);
      return sub;
    };
    
    SubscribableControl.prototype.publishUpdate = function(data) {
      this.bus.emit('control:' + this.controlId + ':updated', data);
    };
    
    SubscribableControl.prototype.getElement = function(id) {
      return document.getElementById(id);
    };
    
    SubscribableControl.prototype.dispose = function() {
      if (this.disposed) return;
      this.disposed = true;
      for (var i = 0; i < this.subs.length; i++) {
        this.subs[i].unsubscribe();
      }
      this.subs.length = 0;
    };

    // Well-known topics
    var Topics = {
      PLAN_STATE_CHANGE: 'plan:state',
      PLANS_UPDATE: 'plans:update',
      CAPACITY_UPDATE: 'capacity:update',
      PULSE: 'extension:pulse'
    };

    // Global bus instance
    var bus = new EventBus();
    
    // ── PlanListCardControl ──────────────────────────────────────────────
    function PlanListCardControl(bus, controlId, element, planId) {
      SubscribableControl.call(this, bus, controlId);
      this.element = element;
      this.planId = planId;
      this.element.dataset.id = planId;
      this.element.classList.add('plan-item');
      this.element.tabIndex = 0;
      
      var self = this;
      this.subscribe(Topics.PLAN_STATE_CHANGE, function(data) {
        if (data && data.id === self.planId) {
          self.update(data);
        }
      });
      
      this.element.addEventListener('click', function() {
        vscode.postMessage({ type: 'previewPlan', planId: self.planId });
      });
      this.element.addEventListener('dblclick', function() {
        vscode.postMessage({ type: 'openPlan', planId: self.planId });
      });
    }
    
    PlanListCardControl.prototype = Object.create(SubscribableControl.prototype);
    PlanListCardControl.prototype.constructor = PlanListCardControl;
    
    PlanListCardControl.prototype._initDom = function(data) {
      var progressClass = data.status === 'failed' ? 'failed' : 
                         data.status === 'succeeded' ? 'succeeded' : '';
      this.element.innerHTML = 
        '<div class="plan-name">' +
          '<span class="plan-name-text">' + escapeHtml(data.name) + '</span>' +
          '<span class="plan-status ' + data.status + '">' + data.status + '</span>' +
        '</div>' +
        '<div class="plan-details">' +
          '<span class="plan-node-count">' + data.nodes + ' nodes</span>' +
          '<span class="plan-succeeded">✓ ' + data.counts.succeeded + '</span>' +
          '<span class="plan-failed">✗ ' + data.counts.failed + '</span>' +
          '<span class="plan-running">⏳ ' + data.counts.running + '</span>' +
          '<span class="plan-duration" data-started="' + (data.startedAt || 0) + '" data-ended="' + (data.endedAt || 0) + '">' + formatDuration(data.startedAt, data.endedAt) + '</span>' +
        '</div>' +
        '<div class="plan-progress">' +
          '<div class="plan-progress-bar ' + progressClass + '" style="width: ' + data.progress + '%"></div>' +
        '</div>';
    };

    PlanListCardControl.prototype.update = function(data) {
      if (!data || data.id !== this.planId) return;
      
      this.element.className = 'plan-item ' + data.status;
      this.element.dataset.status = data.status;
      
      if (!this._rendered) {
        this._rendered = true;
        this._initDom(data);
        this.publishUpdate(data);
        return;
      }

      var nameEl = this.element.querySelector('.plan-name-text');
      if (nameEl) nameEl.textContent = data.name;
      var statusEl = this.element.querySelector('.plan-status');
      if (statusEl) { statusEl.className = 'plan-status ' + data.status; statusEl.textContent = data.status; }
      var countEl = this.element.querySelector('.plan-node-count');
      if (countEl) countEl.textContent = data.nodes + ' nodes';
      var sEl = this.element.querySelector('.plan-succeeded');
      if (sEl) sEl.textContent = '✓ ' + data.counts.succeeded;
      var fEl = this.element.querySelector('.plan-failed');
      if (fEl) fEl.textContent = '✗ ' + data.counts.failed;
      var rEl = this.element.querySelector('.plan-running');
      if (rEl) rEl.textContent = '⏳ ' + data.counts.running;
      // Update duration data attributes (but don't set textContent — PULSE does that)
      var durEl = this.element.querySelector('.plan-duration');
      if (durEl) {
        if (data.startedAt) durEl.dataset.started = String(data.startedAt);
        if (data.endedAt) durEl.dataset.ended = String(data.endedAt);
        else durEl.dataset.ended = '0';
      }
      var barEl = this.element.querySelector('.plan-progress-bar');
      if (barEl) { barEl.className = 'plan-progress-bar ' + (data.status === 'failed' ? 'failed' : data.status === 'succeeded' ? 'succeeded' : ''); barEl.style.width = data.progress + '%'; }
      
      this.publishUpdate(data);
    };
    
    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    
    // ── PlanListContainerControl ─────────────────────────────────────────
    function PlanListContainerControl(bus, controlId, containerId) {
      SubscribableControl.call(this, bus, controlId);
      this.containerId = containerId;
      this.planCards = new Map(); // planId -> PlanListCardControl
      this._pulseSub = null;      // PULSE subscription — only active when plans are running
      
      // Subscribe to plans update
      var self = this;
      this.subscribe(Topics.PLANS_UPDATE, function(data) {
        self.updatePlans(data);
      });
    }
    
    // Inherit from SubscribableControl
    PlanListContainerControl.prototype = Object.create(SubscribableControl.prototype);
    PlanListContainerControl.prototype.constructor = PlanListContainerControl;
    
    PlanListContainerControl.prototype.updatePlans = function(plans) {
      var container = this.getElement(this.containerId);
      if (!container) return;
      
      // If no plans, show empty state
      if (!plans || plans.length === 0) {
        container.innerHTML = '<div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div>';
        for (var entry of this.planCards.values()) {
          entry.dispose();
        }
        this.planCards.clear();
        return;
      }
      
      // Clear empty state if it's showing
      var emptyEl = container.querySelector('.empty');
      if (emptyEl) {
        emptyEl.parentNode.removeChild(emptyEl);
      }
      
      var existingPlanIds = new Set(this.planCards.keys());
      var newPlanIds = new Set(plans.map(function(p) { return p.id; }));
      var structureChanged = false;
      
      // Remove cards for deleted plans
      for (var planId of existingPlanIds) {
        if (!newPlanIds.has(planId)) {
          structureChanged = true;
          var card = this.planCards.get(planId);
          if (card) {
            card.dispose();
            if (card.element && card.element.parentNode) {
              card.element.parentNode.removeChild(card.element);
            }
          }
          this.planCards.delete(planId);
        }
      }
      
      // Add cards for new plans
      for (var i = 0; i < plans.length; i++) {
        var plan = plans[i];
        if (!this.planCards.has(plan.id)) {
          structureChanged = true;
          var element = document.createElement('div');
          element.className = 'plan-item-wrapper';
          container.appendChild(element);
          
          var cardId = 'plan-card-' + plan.id;
          var card = new PlanListCardControl(this.bus, cardId, element, plan.id);
          this.planCards.set(plan.id, card);
          
          this.subscribeToChild(cardId, function() {});
        }
      }
      
      // Update all cards with their data (targeted DOM updates, no innerHTML)
      for (var i = 0; i < plans.length; i++) {
        var plan = plans[i];
        var card = this.planCards.get(plan.id);
        if (card) {
          card.update(plan);
        }
      }
      
      // Only reorder DOM when plans were added or removed
      if (structureChanged) {
        for (var i = 0; i < plans.length; i++) {
          var card = this.planCards.get(plans[i].id);
          if (card && card.element) {
            container.appendChild(card.element);
          }
        }
      }
      
      this.publishUpdate(plans);
      this._managePulseSub();
    };
    
    /** Add a single new plan card (from planAdded event). */
    PlanListContainerControl.prototype.addPlan = function(planData) {
      var container = this.getElement(this.containerId);
      if (!container) return;
      
      // Clear empty state
      var emptyEl = container.querySelector('.empty');
      if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
      
      if (this.planCards.has(planData.id)) {
        // Already exists — just update
        var existing = this.planCards.get(planData.id);
        existing.update(planData);
        return;
      }
      
      var element = document.createElement('div');
      element.className = 'plan-item-wrapper';
      // Insert at top (newest first)
      if (container.firstChild) {
        container.insertBefore(element, container.firstChild);
      } else {
        container.appendChild(element);
      }
      
      var cardId = 'plan-card-' + planData.id;
      var card = new PlanListCardControl(this.bus, cardId, element, planData.id);
      this.planCards.set(planData.id, card);
      card.update(planData);
      this._managePulseSub();
    };
    
    /** Remove a single plan card (from planDeleted event). */
    PlanListContainerControl.prototype.removePlan = function(planId) {
      var card = this.planCards.get(planId);
      if (card) {
        card.dispose();
        if (card.element && card.element.parentNode) {
          card.element.parentNode.removeChild(card.element);
        }
        this.planCards.delete(planId);
      }
      // Show empty state if no plans left
      if (this.planCards.size === 0) {
        var container = this.getElement(this.containerId);
        if (container) {
          container.innerHTML = '<div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div>';
        }
      }
      this._managePulseSub();
    };
    
    /** No-op — each card manages its own PULSE subscription. */
    PlanListContainerControl.prototype._managePulseSub = function() {};

    PlanListContainerControl.prototype.dispose = function() {
      for (var card of this.planCards.values()) {
        card.dispose();
      }
      this.planCards.clear();
      SubscribableControl.prototype.dispose.call(this);
    };
    
    // ── CapacityBarControl ───────────────────────────────────────────────
    function CapacityBarControl(bus, controlId) {
      SubscribableControl.call(this, bus, controlId);
      
      // Subscribe to capacity updates
      var self = this;
      this.subscribe(Topics.CAPACITY_UPDATE, function(data) {
        self.update(data);
      });
    }
    
    // Inherit from SubscribableControl
    CapacityBarControl.prototype = Object.create(SubscribableControl.prototype);
    CapacityBarControl.prototype.constructor = CapacityBarControl;
    
    CapacityBarControl.prototype.update = function(data) {
      var capacityBarEl = this.getElement('globalCapacityBar');
      var statsEl = this.getElement('globalStats');
      
      if (!capacityBarEl || !statsEl) return;
      
      // Update global capacity display
      var globalCapacity = data.globalCapacity;
      if (globalCapacity && (globalCapacity.totalGlobalJobs > 0 || globalCapacity.activeInstances > 1)) {
        capacityBarEl.style.display = 'flex';
        this.getElement('globalRunningJobs').textContent = globalCapacity.totalGlobalJobs;
        this.getElement('globalMaxParallel').textContent = globalCapacity.globalMaxParallel;
        this.getElement('activeInstances').textContent = globalCapacity.activeInstances;
        
        // Highlight if multiple instances
        var instancesEl = capacityBarEl.querySelector('.capacity-instances');
        if (instancesEl) {
          instancesEl.classList.toggle('multiple', globalCapacity.activeInstances > 1);
          
          // Build tooltip with instance details
          if (globalCapacity.instanceDetails && globalCapacity.instanceDetails.length > 0) {
            var tooltip = globalCapacity.instanceDetails
              .map(function(i) { return (i.isCurrentInstance ? '→ ' : '  ') + 'Instance: ' + i.runningJobs + ' jobs'; })
              .join('\\n');
            instancesEl.title = tooltip;
          } else {
            instancesEl.title = 'VS Code instances using orchestrator';
          }
        }
      } else {
        capacityBarEl.style.display = 'none';
      }
      
      // Update global stats
      var globalStats = data.globalStats;
      if (globalStats && (globalStats.running > 0 || globalStats.queued > 0)) {
        statsEl.style.display = 'block';
        this.getElement('runningJobs').textContent = globalStats.running;
        this.getElement('maxParallel').textContent = globalStats.maxParallel;
        this.getElement('queuedJobs').textContent = globalStats.queued;
        var queuedSection = this.getElement('queuedSection');
        if (queuedSection) {
          queuedSection.style.display = globalStats.queued > 0 ? 'inline' : 'none';
        }
      } else {
        statsEl.style.display = 'none';
      }
      
      this.publishUpdate(data);
    };
    
    function formatTime(ms) {
      if (!ms) return '';
      const date = new Date(ms);
      return date.toLocaleTimeString();
    }
    
    function formatDuration(start, end) {
      if (!start) return '';
      const duration = (end || Date.now()) - start;
      const secs = Math.floor(duration / 1000);
      if (secs < 60) return secs + 's';
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      if (mins < 60) return mins + 'm ' + remSecs + 's';
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      return hours + 'h ' + remMins + 'm';
    }
    
    // Global keyboard handler - works without focus on specific plan item
    document.addEventListener('keydown', (e) => {
      // Find the focused plan item or the first one
      let targetEl = document.activeElement;
      if (!targetEl || !targetEl.classList.contains('plan-item')) {
        targetEl = document.querySelector('.plan-item');
      }
      if (!targetEl) return;
      
      const planId = targetEl.dataset.id;
      const status = targetEl.dataset.status;
      
      if (e.key === 'Enter') {
        e.preventDefault();
        vscode.postMessage({ type: 'openPlan', planId });
      } else if (e.key === 'Delete') {
        e.preventDefault();
        vscode.postMessage({ type: 'deletePlan', planId });
      } else if (e.key === 'Escape' && e.ctrlKey) {
        e.preventDefault();
        if (status === 'running' || status === 'pending') {
          vscode.postMessage({ type: 'cancelPlan', planId });
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = targetEl.nextElementSibling;
        if (next && next.classList.contains('plan-item')) {
          next.focus();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = targetEl.previousElementSibling;
        if (prev && prev.classList.contains('plan-item')) {
          prev.focus();
        }
      }
    });
    
    // ── Control Initialization ───────────────────────────────────────────
    var planListContainer = new PlanListContainerControl(bus, 'plan-list-container', 'plans');
    var capacityBar = new CapacityBarControl(bus, 'capacity-bar');
    
    // ── Global duration ticker ───────────────────────────────────────────
    // Identical pattern to plan detail panel: one global PULSE handler that
    // ticks all duration elements. Each .plan-duration stores its own
    // data-started/data-ended timestamps. Simple, reliable, no subscription management.
    function tickAllDurations() {
      var els = document.querySelectorAll('.plan-duration');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var started = parseInt(el.dataset.started || '0', 10);
        if (!started) continue;
        var ended = parseInt(el.dataset.ended || '0', 10);
        // Find parent card status
        var card = el.closest('.plan-item');
        var status = card ? card.dataset.status : '';
        if (status === 'running' || status === 'pending') {
          el.textContent = formatDuration(started, 0);
        } else if (ended) {
          el.textContent = formatDuration(started, ended);
        }
      }
    }
    
    bus.on(Topics.PULSE, tickAllDurations);
    
    let isInitialLoad = true;
    
    // ── Message Handler ──────────────────────────────────────────────────
    window.addEventListener('message', function(ev) {
      var msg = ev.data;
      switch (msg.type) {
        case 'pulse':
          bus.emit(Topics.PULSE);
          break;
          
        case 'update':
          // Initial load: full plan list
          var Plans = msg.Plans || [];
          document.getElementById('badge').textContent = Plans.length + ' total';
          bus.emit(Topics.PLANS_UPDATE, Plans);
          if (isInitialLoad) {
            isInitialLoad = false;
            setTimeout(function() {
              var firstPlan = document.querySelector('.plan-item');
              if (firstPlan) firstPlan.focus();
            }, 50);
          }
          break;
          
        case 'planAdded':
          // Single plan added
          if (msg.plan) {
            planListContainer.addPlan(msg.plan);
          }
          break;
          
        case 'planStateChange':
          // Per-plan state update — emit to EventBus for the matching card
          if (msg.plan) {
            bus.emit(Topics.PLAN_STATE_CHANGE, msg.plan);
            planListContainer._managePulseSub();
          }
          break;
          
        case 'planDeleted':
          // Single plan removed
          if (msg.planId) {
            planListContainer.removePlan(msg.planId);
          }
          break;
          
        case 'badgeUpdate':
          document.getElementById('badge').textContent = (msg.total || 0) + ' total';
          break;
          
        case 'capacityUpdate':
          bus.emit(Topics.CAPACITY_UPDATE, {
            globalCapacity: msg.globalCapacity,
            globalStats: msg.globalStats
          });
          break;
      }
    });
    
    // Request initial data
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
