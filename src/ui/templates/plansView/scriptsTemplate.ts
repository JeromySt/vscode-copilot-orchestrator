/**
 * @fileoverview Plans view scripts template.
 *
 * Generates the `<script>` block for the plans sidebar webview.
 * Controls are loaded from the `window.Orca` namespace provided by the
 * pre-built `plansList.js` bundle.
 *
 * @module ui/templates/plansView/scriptsTemplate
 */

import { renderPlansViewControlWiring } from './scripts/controlWiring';
import { renderPlansViewMessageRouter } from './scripts/messageRouter';
import { renderPlansViewKeyboardNav } from './scripts/keyboardNav';

/**
 * Render the webview `<script>` block for the plans view.
 *
 * Assumes `window.Orca` is already defined by the pre-loaded plansList bundle.
 * Destructures EventBus, SubscribableControl, and Topics from the bundle,
 * then defines UI-specific controls using ES6 `class extends` syntax.
 *
 * @returns HTML `<script>…</script>` string.
 */
export function renderPlansViewScripts(): string {
  return `<script>
const vscode = acquireVsCodeApi();

if (typeof window.Orca === 'undefined') {
  document.body.innerHTML = '<div style="padding:16px;color:var(--vscode-errorForeground)">Error: Webview bundle failed to load. Check Developer Tools console.</div>';
  throw new Error('window.Orca is undefined — plansList.js bundle did not load');
}

const { EventBus, SubscribableControl, Topics, escapeHtml, formatDurationMs } = window.Orca;

// Global bus instance
var bus = new EventBus();

// Well-known topics for plans view
var PlansTopics = {
  PLAN_STATE_CHANGE: 'plan:state',
  PLANS_UPDATE: 'plans:update',
  CAPACITY_UPDATE: 'capacity:update',
  PULSE: 'extension:pulse'
};

function formatDuration(start, end) {
  if (!start) return '';
  var ms = (end || Date.now()) - start;
  if (ms < 0) ms = 0;
  return formatDurationMs(ms);
}

// ── PlanListCardControl ──────────────────────────────────────────────
class PlanListCardControl extends SubscribableControl {
  constructor(bus, controlId, element, planId) {
    super(bus, controlId);
    this.element = element;
    this.planId = planId;
    this._rendered = false;
    this.element.dataset.id = planId;
    this.element.classList.add('plan-item');
    this.element.tabIndex = 0;

    this.subscribe(PlansTopics.PLAN_STATE_CHANGE, (data) => {
      if (data && data.id === this.planId) this._onUpdate(data);
    });

    this.element.addEventListener('click', () => {
      vscode.postMessage({ type: 'previewPlan', planId: this.planId });
    });
    this.element.addEventListener('dblclick', () => {
      vscode.postMessage({ type: 'openPlan', planId: this.planId });
    });
  }

  update(data) { if (data) this._onUpdate(data); }

  _initDom(data) {
    var progressClass = data.status === 'failed' ? 'failed' :
                       data.status === 'succeeded' ? 'succeeded' : '';
    this.element.innerHTML =
      '<div class="plan-name">' +
        '<span class="plan-name-text" title="' + escapeHtml(data.name) + '">' + escapeHtml(data.name) + '</span>' +
        '<span class="plan-status ' + data.status + '">' + (data.status === 'scaffolding' ? '\\u{1F6A7} Under Construction' : data.status) + '</span>' +
      '</div>' +
      '<div class="plan-details">' +
        '<span class="plan-node-count">' + data.nodes + ' jobs</span>' +
        '<span class="plan-succeeded">\\u2713 ' + data.counts.succeeded + '</span>' +
        '<span class="plan-failed">\\u2717 ' + data.counts.failed + '</span>' +
        '<span class="plan-running">\\u23F3 ' + data.counts.running + '</span>' +
        '<span class="plan-duration" data-started="' + (data.startedAt || 0) + '" data-ended="' + (data.endedAt || 0) + '">' + formatDuration(data.startedAt, data.endedAt) + '</span>' +
      '</div>' +
      '<div class="plan-progress">' +
        '<div class="plan-progress-bar ' + progressClass + '" style="width: ' + data.progress + '%"></div>' +
      '</div>';
  }

  _onUpdate(data) {
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
    if (nameEl) { nameEl.textContent = data.name; nameEl.title = data.name; }
    var statusEl = this.element.querySelector('.plan-status');
    if (statusEl) {
      statusEl.className = 'plan-status ' + data.status;
      statusEl.textContent = data.status === 'scaffolding' ? '\\u{1F6A7} Under Construction' : data.status;
    }
    var countEl = this.element.querySelector('.plan-node-count');
    if (countEl) countEl.textContent = data.nodes + ' jobs';
    var sEl = this.element.querySelector('.plan-succeeded');
    if (sEl) sEl.textContent = '\\u2713 ' + data.counts.succeeded;
    var fEl = this.element.querySelector('.plan-failed');
    if (fEl) fEl.textContent = '\\u2717 ' + data.counts.failed;
    var rEl = this.element.querySelector('.plan-running');
    if (rEl) rEl.textContent = '\\u23F3 ' + data.counts.running;
    var durEl = this.element.querySelector('.plan-duration');
    if (durEl) {
      if (data.startedAt) durEl.dataset.started = String(data.startedAt);
      if (data.endedAt) durEl.dataset.ended = String(data.endedAt);
      else durEl.dataset.ended = '0';
    }
    var barEl = this.element.querySelector('.plan-progress-bar');
    if (barEl) {
      barEl.className = 'plan-progress-bar ' + (data.status === 'failed' ? 'failed' : data.status === 'succeeded' ? 'succeeded' : '');
      barEl.style.width = data.progress + '%';
    }
    this.publishUpdate(data);
  }
}

// ── PlanListContainerControl ─────────────────────────────────────────
class PlanListContainerControl extends SubscribableControl {
  constructor(bus, controlId, containerId) {
    super(bus, controlId);
    this.containerId = containerId;
    this.planCards = new Map();

    this.subscribe(PlansTopics.PLANS_UPDATE, (data) => {
      this.updatePlans(data);
    });
  }

  update() {}

  updatePlans(plans) {
    var container = this.getElement(this.containerId);
    if (!container) return;

    if (!plans || plans.length === 0) {
      container.innerHTML = '<div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div>';
      for (var entry of this.planCards.values()) { entry.dispose(); }
      this.planCards.clear();
      return;
    }

    var emptyEl = container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);

    var existingPlanIds = new Set(this.planCards.keys());
    var newPlanIds = new Set(plans.map(function(p) { return p.id; }));
    var structureChanged = false;

    for (var planId of existingPlanIds) {
      if (!newPlanIds.has(planId)) {
        structureChanged = true;
        var card = this.planCards.get(planId);
        if (card) { card.dispose(); if (card.element && card.element.parentNode) card.element.parentNode.removeChild(card.element); }
        this.planCards.delete(planId);
      }
    }

    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      if (!this.planCards.has(plan.id)) {
        structureChanged = true;
        var element = document.createElement('div');
        element.className = 'plan-item-wrapper';
        container.appendChild(element);
        var cardId = 'plan-card-' + plan.id;
        var card = new PlanListCardControl(bus, cardId, element, plan.id);
        this.planCards.set(plan.id, card);
        this.subscribeToChild(cardId, function() {});
      }
    }

    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      var card = this.planCards.get(plan.id);
      if (card) card._onUpdate(plan);
    }

    if (structureChanged) {
      for (var i = 0; i < plans.length; i++) {
        var card = this.planCards.get(plans[i].id);
        if (card && card.element) container.appendChild(card.element);
      }
    }

    this.publishUpdate(plans);
  }

  addPlan(planData) {
    var container = this.getElement(this.containerId);
    if (!container) return;
    var emptyEl = container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
    if (this.planCards.has(planData.id)) {
      var existing = this.planCards.get(planData.id);
      existing._onUpdate(planData);
      return;
    }
    var element = document.createElement('div');
    element.className = 'plan-item-wrapper';
    if (container.firstChild) container.insertBefore(element, container.firstChild);
    else container.appendChild(element);
    var cardId = 'plan-card-' + planData.id;
    var card = new PlanListCardControl(bus, cardId, element, planData.id);
    this.planCards.set(planData.id, card);
    card._onUpdate(planData);
  }

  removePlan(planId) {
    var card = this.planCards.get(planId);
    if (card) { card.dispose(); if (card.element && card.element.parentNode) card.element.parentNode.removeChild(card.element); }
    this.planCards.delete(planId);
    if (this.planCards.size === 0) {
      var container = this.getElement(this.containerId);
      if (container) container.innerHTML = '<div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div>';
    }
  }

  _managePulseSub() {}

  dispose() {
    for (var card of this.planCards.values()) card.dispose();
    this.planCards.clear();
    super.dispose();
  }
}

// ── CapacityBarControl ───────────────────────────────────────────────
class CapacityBarControl extends SubscribableControl {
  constructor(bus, controlId) {
    super(bus, controlId);
    this.subscribe(PlansTopics.CAPACITY_UPDATE, (data) => { this._onUpdate(data); });
  }

  update(data) { if (data) this._onUpdate(data); }

  _onUpdate(data) {
    var capacityBarEl = this.getElement('globalCapacityBar');
    var statsEl = this.getElement('globalStats');
    if (!capacityBarEl || !statsEl) return;

    var gc = data.globalCapacity;
    if (gc && (gc.totalGlobalJobs > 0 || gc.activeInstances > 1)) {
      capacityBarEl.style.display = 'flex';
      this.getElement('globalRunningJobs').textContent = gc.totalGlobalJobs;
      this.getElement('globalMaxParallel').textContent = gc.globalMaxParallel;
      this.getElement('activeInstances').textContent = gc.activeInstances;
      var instancesEl = capacityBarEl.querySelector('.capacity-instances');
      if (instancesEl) {
        instancesEl.classList.toggle('multiple', gc.activeInstances > 1);
        if (gc.instanceDetails && gc.instanceDetails.length > 0) {
          instancesEl.title = gc.instanceDetails.map(function(i) { return (i.isCurrentInstance ? '> ' : '  ') + 'Instance: ' + i.runningJobs + ' jobs'; }).join('\\n');
        }
      }
    } else {
      capacityBarEl.style.display = 'none';
    }

    var gs = data.globalStats;
    if (gs && (gs.running > 0 || gs.queued > 0)) {
      statsEl.style.display = 'block';
      this.getElement('runningJobs').textContent = gs.running;
      this.getElement('maxParallel').textContent = gs.maxParallel;
      this.getElement('queuedJobs').textContent = gs.queued;
      var qs = this.getElement('queuedSection');
      if (qs) qs.style.display = gs.queued > 0 ? 'inline' : 'none';
    } else {
      statsEl.style.display = 'none';
    }

    this.publishUpdate(data);
  }
}

${renderPlansViewControlWiring()}

${renderPlansViewMessageRouter()}

${renderPlansViewKeyboardNav()}
</script>`;
}
