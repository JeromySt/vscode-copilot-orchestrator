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

const { EventBus, SubscribableControl, Topics, escapeHtml, formatDurationMs, MultiSelectManager } = window.Orca;

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
    this.element.setAttribute('role', 'option');
    this.element.setAttribute('aria-selected', 'false');

    this.subscribe(PlansTopics.PLAN_STATE_CHANGE, (data) => {
      if (data && data.id === this.planId) this._onUpdate(data);
    });

    this.element.addEventListener('click', (e) => {
      // Let MultiSelectManager handle the click
      window._planMultiSelect.handleClick(this.planId, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
      
      // Only preview/open if single-click without multi-select modifiers
      if (!e.ctrlKey && !e.shiftKey && !e.metaKey) {
        vscode.postMessage({ type: 'previewPlan', planId: this.planId });
      }
    });
    this.element.addEventListener('dblclick', () => {
      vscode.postMessage({ type: 'openPlan', planId: this.planId });
    });
    this.element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window._planMultiSelect.handleContextMenu(this.planId);
      // Show context menu at cursor position
      var menu = document.getElementById('contextMenu');
      if (menu) {
        menu.style.display = 'block';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
      }
    });
  }

  update(data) { if (data) this._onUpdate(data); }

  _initDom(data) {
    var progressClass = data.status === 'failed' ? 'failed' :
                       data.status === 'succeeded' ? 'succeeded' : '';
    var canArchive = data.status === 'succeeded' || data.status === 'partial' || data.status === 'failed' || data.status === 'canceled';
    var archiveButton = canArchive && data.status !== 'archived' ? 
      '<button class="archive-action" data-plan-id="' + escapeHtml(data.id) + '" title="Archive this plan">$(archive)</button>' : '';
    var showRecover = data.status === 'canceled' || data.status === 'failed';
    var recoverBtnHtml = showRecover ?
      '<button class="recover-btn" title="Recover this plan">$(history)</button>' : '';
    var releaseTag = data.release ? 
      '<span class="release-tag" title="Release: ' + escapeHtml(data.release.name) + ' (' + data.release.status + ')">$(package) ' + escapeHtml(data.release.name) + '</span>' : '';
    
    this.element.innerHTML =
      '<div class="plan-name">' +
        '<span class="plan-name-text" title="' + escapeHtml(data.name) + '">' + escapeHtml(data.name) + '</span>' +
        archiveButton +
        '<span class="plan-status ' + data.status + '">' + (data.status === 'scaffolding' ? '\\u{1F6A7} Under Construction' : data.status) + '</span>' +
        recoverBtnHtml +
        releaseTag +
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
    
    // Wire up archive button click
    var archiveBtn = this.element.querySelector('.archive-action');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'archivePlan', planId: data.id });
      });
    }
    // Wire up recover button click
    var recoverBtn = this.element.querySelector('.recover-btn');
    if (recoverBtn) {
      recoverBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'recoverPlan', planId: data.id });
      });
    }
  }

  _onUpdate(data) {
    if (!data || data.id !== this.planId) return;
    var isSelected = this.element.classList.contains('selected');
    this.element.className = 'plan-item ' + data.status + (isSelected ? ' selected' : '');
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
    
    // Update or add/remove recover button based on status
    var existingRecoverBtn = this.element.querySelector('.recover-btn');
    var shouldShowRecover = data.status === 'canceled' || data.status === 'failed';
    if (shouldShowRecover && !existingRecoverBtn) {
      var recoverBtn = document.createElement('button');
      recoverBtn.className = 'recover-btn';
      recoverBtn.title = 'Recover this plan';
      recoverBtn.innerHTML = '$(history)';
      var self = this;
      recoverBtn.onclick = function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'recoverPlan', planId: self.planId });
      };
      var planNameEl = this.element.querySelector('.plan-name');
      if (planNameEl) planNameEl.appendChild(recoverBtn);
    } else if (!shouldShowRecover && existingRecoverBtn) {
      existingRecoverBtn.parentNode.removeChild(existingRecoverBtn);
    }
    
    // Update or add/remove release tag
    var existingReleaseTag = this.element.querySelector('.release-tag');
    if (data.release && !existingReleaseTag) {
      var releaseTag = document.createElement('span');
      releaseTag.className = 'release-tag';
      releaseTag.title = 'Release: ' + data.release.name + ' (' + data.release.status + ')';
      releaseTag.textContent = '$(package) ' + data.release.name;
      var planNameEl = this.element.querySelector('.plan-name');
      if (planNameEl) planNameEl.appendChild(releaseTag);
    } else if (!data.release && existingReleaseTag) {
      existingReleaseTag.parentNode.removeChild(existingReleaseTag);
    } else if (data.release && existingReleaseTag) {
      existingReleaseTag.title = 'Release: ' + data.release.name + ' (' + data.release.status + ')';
      existingReleaseTag.textContent = '$(package) ' + data.release.name;
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
    this.archivedCollapsed = this._loadCollapseState();

    this.subscribe(PlansTopics.PLANS_UPDATE, (data) => {
      this.updatePlans(data);
    });
    
    // Wire archived toggle
    var self = this;
    setTimeout(function() {
      var toggle = document.getElementById('archivedToggle');
      if (toggle) {
        toggle.addEventListener('click', function() {
          self.toggleArchived();
        });
      }
    }, 0);
  }

  update() {}
  
  _loadCollapseState() {
    try {
      var state = vscode.getState();
      return state && state.archivedCollapsed !== undefined ? state.archivedCollapsed : false;
    } catch (e) {
      return false;
    }
  }
  
  _saveCollapseState() {
    try {
      var state = vscode.getState() || {};
      state.archivedCollapsed = this.archivedCollapsed;
      vscode.setState(state);
    } catch (e) {}
  }
  
  toggleArchived() {
    this.archivedCollapsed = !this.archivedCollapsed;
    this._saveCollapseState();
    
    var toggle = document.getElementById('archivedToggle');
    var archivedPlans = document.getElementById('archivedPlans');
    
    if (toggle && archivedPlans) {
      toggle.setAttribute('aria-expanded', String(!this.archivedCollapsed));
      archivedPlans.style.display = this.archivedCollapsed ? 'none' : 'block';
    }
  }

  updatePlans(plans) {
    var container = this.getElement(this.containerId);
    var archivedContainer = this.getElement('archivedPlans');
    if (!container || !archivedContainer) return;

    if (!plans || plans.length === 0) {
      container.innerHTML = '<div class="welcome-state"><div class="welcome-icon">&#10024;</div><div class="welcome-title">No plans yet</div><div class="welcome-subtitle">Ask Copilot to create a plan, or use the <code>create_copilot_plan</code> MCP tool.</div></div>';
      archivedContainer.innerHTML = '';
      document.getElementById('archivedDivider').style.display = 'none';
      for (var entry of this.planCards.values()) { entry.dispose(); }
      this.planCards.clear();
      return;
    }

    var emptyEl = container.querySelector('.welcome-state') || container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);

    // Separate active and archived plans
    var activePlans = [];
    var archivedPlans = [];
    for (var i = 0; i < plans.length; i++) {
      if (plans[i].status === 'archived') {
        archivedPlans.push(plans[i]);
      } else {
        activePlans.push(plans[i]);
      }
    }
    
    // Update archived section visibility
    var archivedDivider = document.getElementById('archivedDivider');
    var archivedCountEl = document.getElementById('archivedCount');
    if (archivedPlans.length > 0) {
      archivedDivider.style.display = 'block';
      if (archivedCountEl) archivedCountEl.textContent = String(archivedPlans.length);
      
      // Apply collapse state
      var toggle = document.getElementById('archivedToggle');
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!this.archivedCollapsed));
        archivedContainer.style.display = this.archivedCollapsed ? 'none' : 'block';
      }
    } else {
      archivedDivider.style.display = 'none';
      archivedContainer.innerHTML = '';
    }

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
        
        // Place in correct container
        var targetContainer = plan.status === 'archived' ? archivedContainer : container;
        targetContainer.appendChild(element);
        
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
      // Rebuild both containers in correct order
      for (var i = 0; i < activePlans.length; i++) {
        var card = this.planCards.get(activePlans[i].id);
        if (card && card.element) container.appendChild(card.element);
      }
      for (var i = 0; i < archivedPlans.length; i++) {
        var card = this.planCards.get(archivedPlans[i].id);
        if (card && card.element) archivedContainer.appendChild(card.element);
      }
    }

    this.publishUpdate(plans);
  }

  addPlan(planData) {
    var container = this.getElement(this.containerId);
    var archivedContainer = this.getElement('archivedPlans');
    if (!container || !archivedContainer) return;
    
    var targetContainer = planData.status === 'archived' ? archivedContainer : container;
    
    var emptyEl = container.querySelector('.welcome-state') || container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
    if (this.planCards.has(planData.id)) {
      var existing = this.planCards.get(planData.id);
      existing._onUpdate(planData);
      
      // Move card if status changed between active/archived
      if (existing.element) {
        var currentParent = existing.element.parentNode;
        if (currentParent && currentParent !== targetContainer) {
          targetContainer.appendChild(existing.element);
        }
      }
      return;
    }
    var element = document.createElement('div');
    element.className = 'plan-item-wrapper';
    if (targetContainer.firstChild) targetContainer.insertBefore(element, targetContainer.firstChild);
    else targetContainer.appendChild(element);
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
      if (container) container.innerHTML = '<div class="welcome-state"><div class="welcome-icon">&#10024;</div><div class="welcome-title">No plans yet</div><div class="welcome-subtitle">Ask Copilot to create a plan, or use the <code>create_copilot_plan</code> MCP tool.</div></div>';
      document.getElementById('archivedDivider').style.display = 'none';
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
    this._idleTimer = null;
    this._wasActive = false;
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

    // Local stats: always show when there are running OR queued jobs,
    // and briefly show "idle" after jobs complete so user sees the transition.
    var gs = data.globalStats;
    if (gs) {
      var hasActivity = gs.running > 0 || gs.queued > 0;
      
      if (hasActivity) {
        if (this._idleTimer) {
          clearTimeout(this._idleTimer);
          this._idleTimer = null;
        }
        this._wasActive = true;
        statsEl.style.display = 'block';
        this.getElement('runningJobs').textContent = gs.running;
        this.getElement('maxParallel').textContent = gs.maxParallel;
        this.getElement('queuedJobs').textContent = gs.queued;
        var qs = this.getElement('queuedSection');
        if (qs) qs.style.display = gs.queued > 0 ? 'inline' : 'none';
      } else if (this._wasActive && !this._idleTimer) {
        this._wasActive = false;
        this.getElement('runningJobs').textContent = '0';
        this.getElement('queuedJobs').textContent = '0';
        var qs = this.getElement('queuedSection');
        if (qs) qs.style.display = 'none';
        this._idleTimer = setTimeout(function() {
          statsEl.style.display = 'none';
          this._idleTimer = null;
        }.bind(this), 5000);
      }
    }

    this.publishUpdate(data);
  }
}

// ── PRCardControl ────────────────────────────────────────────────────
class PRCardControl extends SubscribableControl {
  constructor(bus, controlId, element, prId) {
    super(bus, controlId);
    this.element = element;
    this.prId = prId;
    this._rendered = false;
    this.element.dataset.id = prId;
    this.element.classList.add('pr-item');

    this.subscribe('pr:state', (data) => {
      if (data && data.id === this.prId) this._onUpdate(data);
    });

    this.element.addEventListener('click', () => {
      vscode.postMessage({ type: 'openPR', prId: this.prId });
    });
  }

  update(data) { if (data) this._onUpdate(data); }

  _initDom(data) {
    var draftIndicator = data.isDraft ? '<span class="pr-draft-indicator">DRAFT</span>' : '';
    this.element.innerHTML =
      '<div class="pr-header">' +
        '<span class="pr-number">#' + data.prNumber + '</span>' +
        '<span class="pr-title" title="' + escapeHtml(data.title) + '">' + escapeHtml(data.title) + '</span>' +
        draftIndicator +
        '<span class="pr-status-badge ' + data.status + '">' + data.status + '</span>' +
      '</div>' +
      '<div class="pr-branches">' +
        '<span class="pr-branch">' + escapeHtml(data.headBranch) + '</span>' +
        '<span>→</span>' +
        '<span class="pr-branch">' + escapeHtml(data.baseBranch) + '</span>' +
      '</div>' +
      '<div class="pr-details">' +
        '<span>💬 ' + data.unresolvedComments + '</span>' +
        '<span>✗ ' + data.failingChecks + '</span>' +
      '</div>';
  }

  _onUpdate(data) {
    if (!data || data.id !== this.prId) return;
    this.element.className = 'pr-item ' + data.status;
    this.element.dataset.status = data.status;

    if (!this._rendered) {
      this._rendered = true;
      this._initDom(data);
      this.publishUpdate(data);
      return;
    }

    var numberEl = this.element.querySelector('.pr-number');
    if (numberEl) numberEl.textContent = '#' + data.prNumber;
    var titleEl = this.element.querySelector('.pr-title');
    if (titleEl) { titleEl.textContent = data.title; titleEl.title = data.title; }
    var statusEl = this.element.querySelector('.pr-status-badge');
    if (statusEl) {
      statusEl.className = 'pr-status-badge ' + data.status;
      statusEl.textContent = data.status;
    }
    var branchEls = this.element.querySelectorAll('.pr-branch');
    if (branchEls.length >= 2) {
      branchEls[0].textContent = data.headBranch;
      branchEls[1].textContent = data.baseBranch;
    }
    var detailsEl = this.element.querySelector('.pr-details');
    if (detailsEl) {
      detailsEl.innerHTML = '<span>💬 ' + data.unresolvedComments + '</span><span>✗ ' + data.failingChecks + '</span>';
    }

    this.publishUpdate(data);
  }
}

// ── PRListContainerControl ───────────────────────────────────────────
class PRListContainerControl extends SubscribableControl {
  constructor(bus, controlId, containerId) {
    super(bus, controlId);
    this.containerId = containerId;
    this.prCards = new Map();

    this.subscribe('prs:update', (data) => {
      this.updatePRs(data);
    });
  }

  update() {}

  updatePRs(prs) {
    var container = this.getElement(this.containerId);
    if (!container) return;

    if (!prs || prs.length === 0) {
      container.innerHTML = '<div class="welcome-state"><div class="welcome-icon">&#128279;</div><div class="welcome-title">No managed PRs</div><div class="welcome-subtitle">Adopt an existing PR to monitor it.</div></div>';
      for (var entry of this.prCards.values()) { entry.dispose(); }
      this.prCards.clear();
      this._updateBadge(0);
      return;
    }

    var emptyEl = container.querySelector('.welcome-state') || container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);

    var existingPRIds = new Set(this.prCards.keys());
    var newPRIds = new Set(prs.map(function(p) { return p.id; }));
    var structureChanged = false;

    for (var prId of existingPRIds) {
      if (!newPRIds.has(prId)) {
        structureChanged = true;
        var card = this.prCards.get(prId);
        if (card) { card.dispose(); if (card.element && card.element.parentNode) card.element.parentNode.removeChild(card.element); }
        this.prCards.delete(prId);
      }
    }

    for (var i = 0; i < prs.length; i++) {
      var pr = prs[i];
      if (!this.prCards.has(pr.id)) {
        structureChanged = true;
        var element = document.createElement('div');
        element.className = 'pr-item-wrapper';
        container.appendChild(element);
        var cardId = 'pr-card-' + pr.id;
        var card = new PRCardControl(bus, cardId, element, pr.id);
        this.prCards.set(pr.id, card);
        this.subscribeToChild(cardId, function() {});
      }
    }

    for (var i = 0; i < prs.length; i++) {
      var pr = prs[i];
      var card = this.prCards.get(pr.id);
      if (card) card._onUpdate(pr);
    }

    if (structureChanged) {
      for (var i = 0; i < prs.length; i++) {
        var card = this.prCards.get(prs[i].id);
        if (card && card.element) container.appendChild(card.element);
      }
    }

    this._updateBadge(prs.length);
    this.publishUpdate(prs);
  }

  addPR(prData) {
    var container = this.getElement(this.containerId);
    if (!container) return;
    var emptyEl = container.querySelector('.welcome-state') || container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
    if (this.prCards.has(prData.id)) {
      var existing = this.prCards.get(prData.id);
      existing._onUpdate(prData);
      return;
    }
    var element = document.createElement('div');
    element.className = 'pr-item-wrapper';
    if (container.firstChild) container.insertBefore(element, container.firstChild);
    else container.appendChild(element);
    var cardId = 'pr-card-' + prData.id;
    var card = new PRCardControl(bus, cardId, element, prData.id);
    this.prCards.set(prData.id, card);
    card._onUpdate(prData);
    this._updateBadge(this.prCards.size);
  }

  removePR(prId) {
    var card = this.prCards.get(prId);
    if (card) { card.dispose(); if (card.element && card.element.parentNode) card.element.parentNode.removeChild(card.element); }
    this.prCards.delete(prId);
    if (this.prCards.size === 0) {
      var container = this.getElement(this.containerId);
      if (container) container.innerHTML = '<div class="welcome-state"><div class="welcome-icon">&#128279;</div><div class="welcome-title">No managed PRs</div><div class="welcome-subtitle">Adopt an existing PR to monitor it.</div></div>';
    }
    this._updateBadge(this.prCards.size);
  }

  _updateBadge(count) {
    var badge = this.getElement('prsBadge');
    if (badge) badge.textContent = count.toString();
  }

  dispose() {
    for (var card of this.prCards.values()) card.dispose();
    this.prCards.clear();
    super.dispose();
  }
}

// ── ReleaseCardControl ───────────────────────────────────────────────
class ReleaseCardControl extends SubscribableControl {
  constructor(bus, controlId, element, releaseId) {
    super(bus, controlId);
    this.element = element;
    this.releaseId = releaseId;
    this._rendered = false;
    this.element.dataset.id = releaseId;
    this.element.classList.add('release-item');

    this.subscribe('release:state', (data) => {
      if (data && data.id === this.releaseId) this._onUpdate(data);
    });

    this.element.addEventListener('click', () => {
      vscode.postMessage({ type: 'openRelease', releaseId: this.releaseId });
    });
  }

  update(data) { if (data) this._onUpdate(data); }

  _initDom(data) {
    var monitoringIndicator = data.status === 'monitoring' ? 
      '<span class="release-monitoring-indicator"><span class="monitoring-dot"></span>Monitoring</span>' : '';
    var prLink = data.prNumber ? 
      '<a href="#" class="release-pr-link" onclick="event.preventDefault(); event.stopPropagation(); window.open(\'' + escapeHtml(data.prUrl) + '\');">' +
        '<span class="codicon codicon-link-external"></span>PR #' + data.prNumber +
      '</a>' : '';
    var progress = data.progress || 0;
    var progressClass = data.status === 'failed' ? 'failed' :
                       data.status === 'succeeded' ? 'succeeded' : '';
    
    this.element.innerHTML =
      '<div class="release-header">' +
        '<span class="release-name" title="' + escapeHtml(data.name) + '">' + escapeHtml(data.name) + '</span>' +
        '<span class="release-status-badge ' + data.status + '">' + data.status + '</span>' +
        monitoringIndicator +
      '</div>' +
      '<div class="release-branches">' +
        '<span class="release-branch">' + escapeHtml(data.releaseBranch) + '</span>' +
        '<span class="release-arrow">→</span>' +
        '<span class="release-branch">' + escapeHtml(data.targetBranch) + '</span>' +
      '</div>' +
      '<div class="release-details">' +
        '<span class="release-plan-count">' +
          '<span class="codicon codicon-layers"></span>' + data.planCount + ' plan' + (data.planCount !== 1 ? 's' : '') +
        '</span>' +
        prLink +
      '</div>' +
      '<div class="release-progress">' +
        '<div class="release-progress-bar ' + progressClass + '" style="width: ' + progress + '%"></div>' +
      '</div>';
  }

  _onUpdate(data) {
    if (!data || data.id !== this.releaseId) return;
    this.element.className = 'release-item ' + data.status;
    this.element.dataset.status = data.status;

    if (!this._rendered) {
      this._rendered = true;
      this._initDom(data);
      this.publishUpdate(data);
      return;
    }

    var nameEl = this.element.querySelector('.release-name');
    if (nameEl) { nameEl.textContent = data.name; nameEl.title = data.name; }
    var statusEl = this.element.querySelector('.release-status-badge');
    if (statusEl) {
      statusEl.className = 'release-status-badge ' + data.status;
      statusEl.textContent = data.status;
    }
    var branchEls = this.element.querySelectorAll('.release-branch');
    if (branchEls.length >= 2) {
      branchEls[0].textContent = data.releaseBranch;
      branchEls[1].textContent = data.targetBranch;
    }
    
    // Update monitoring indicator
    var headerEl = this.element.querySelector('.release-header');
    var existingIndicator = headerEl.querySelector('.release-monitoring-indicator');
    if (data.status === 'monitoring' && !existingIndicator) {
      var indicator = document.createElement('span');
      indicator.className = 'release-monitoring-indicator';
      indicator.innerHTML = '<span class="monitoring-dot"></span>Monitoring';
      headerEl.appendChild(indicator);
    } else if (data.status !== 'monitoring' && existingIndicator) {
      existingIndicator.parentNode.removeChild(existingIndicator);
    }
    
    // Update plan count and PR link
    var detailsEl = this.element.querySelector('.release-details');
    if (detailsEl) {
      var prLink = data.prNumber ? 
        '<a href="#" class="release-pr-link" onclick="event.preventDefault(); event.stopPropagation(); window.open(\'' + escapeHtml(data.prUrl) + '\');">' +
          '<span class="codicon codicon-link-external"></span>PR #' + data.prNumber +
        '</a>' : '';
      detailsEl.innerHTML = 
        '<span class="release-plan-count">' +
          '<span class="codicon codicon-layers"></span>' + data.planCount + ' plan' + (data.planCount !== 1 ? 's' : '') +
        '</span>' +
        prLink;
    }
    
    // Update progress bar
    var barEl = this.element.querySelector('.release-progress-bar');
    if (barEl) {
      var progress = data.progress || 0;
      var progressClass = data.status === 'failed' ? 'failed' :
                         data.status === 'succeeded' ? 'succeeded' : '';
      barEl.className = 'release-progress-bar ' + progressClass;
      barEl.style.width = progress + '%';
    }

    this.publishUpdate(data);
  }
}

// ── ReleaseListContainerControl ──────────────────────────────────────
class ReleaseListContainerControl extends SubscribableControl {
  constructor(bus, controlId, containerId) {
    super(bus, controlId);
    this.containerId = containerId;
    this.releaseCards = new Map();

    this.subscribe('releases:update', (data) => {
      this.updateReleases(data);
    });
  }

  update() {}

  updateReleases(releases) {
    var container = this.getElement(this.containerId);
    if (!container) return;

    if (!releases || releases.length === 0) {
      container.innerHTML = '<div class="welcome-state"><div class="welcome-icon">&#128640;</div><div class="welcome-title">No releases yet</div><div class="welcome-subtitle">Create a release to merge plans and monitor PRs.</div></div>';
      for (var entry of this.releaseCards.values()) { entry.dispose(); }
      this.releaseCards.clear();
      this._updateBadge(0);
      return;
    }

    var emptyEl = container.querySelector('.welcome-state') || container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);

    var existingReleaseIds = new Set(this.releaseCards.keys());
    var newReleaseIds = new Set(releases.map(function(r) { return r.id; }));
    var structureChanged = false;

    for (var releaseId of existingReleaseIds) {
      if (!newReleaseIds.has(releaseId)) {
        structureChanged = true;
        var card = this.releaseCards.get(releaseId);
        if (card) { card.dispose(); if (card.element && card.element.parentNode) card.element.parentNode.removeChild(card.element); }
        this.releaseCards.delete(releaseId);
      }
    }

    for (var i = 0; i < releases.length; i++) {
      var release = releases[i];
      if (!this.releaseCards.has(release.id)) {
        structureChanged = true;
        var element = document.createElement('div');
        element.className = 'release-item-wrapper';
        container.appendChild(element);
        var cardId = 'release-card-' + release.id;
        var card = new ReleaseCardControl(bus, cardId, element, release.id);
        this.releaseCards.set(release.id, card);
        this.subscribeToChild(cardId, function() {});
      }
    }

    for (var i = 0; i < releases.length; i++) {
      var release = releases[i];
      var card = this.releaseCards.get(release.id);
      if (card) card._onUpdate(release);
    }

    if (structureChanged) {
      for (var i = 0; i < releases.length; i++) {
        var card = this.releaseCards.get(releases[i].id);
        if (card && card.element) container.appendChild(card.element);
      }
    }

    this._updateBadge(releases.length);
    this.publishUpdate(releases);
  }

  addRelease(releaseData) {
    var container = this.getElement(this.containerId);
    if (!container) return;
    var emptyEl = container.querySelector('.welcome-state') || container.querySelector('.empty');
    if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
    if (this.releaseCards.has(releaseData.id)) {
      var existing = this.releaseCards.get(releaseData.id);
      existing._onUpdate(releaseData);
      return;
    }
    var element = document.createElement('div');
    element.className = 'release-item-wrapper';
    if (container.firstChild) container.insertBefore(element, container.firstChild);
    else container.appendChild(element);
    var cardId = 'release-card-' + releaseData.id;
    var card = new ReleaseCardControl(bus, cardId, element, releaseData.id);
    this.releaseCards.set(releaseData.id, card);
    card._onUpdate(releaseData);
    this._updateBadge(this.releaseCards.size);
  }

  removeRelease(releaseId) {
    var card = this.releaseCards.get(releaseId);
    if (card) { card.dispose(); if (card.element && card.element.parentNode) card.element.parentNode.removeChild(card.element); }
    this.releaseCards.delete(releaseId);
    if (this.releaseCards.size === 0) {
      var container = this.getElement(this.containerId);
      if (container) container.innerHTML = '<div class="welcome-state"><div class="welcome-icon">&#128640;</div><div class="welcome-title">No releases yet</div><div class="welcome-subtitle">Create a release to merge plans and monitor PRs.</div></div>';
    }
    this._updateBadge(this.releaseCards.size);
  }

  _updateBadge(count) {
    var badge = this.getElement('releasesBadge');
    if (badge) badge.textContent = count.toString();
  }

  dispose() {
    for (var card of this.releaseCards.values()) card.dispose();
    this.releaseCards.clear();
    super.dispose();
  }
}

${renderPlansViewControlWiring()}

${renderPlansViewMessageRouter()}

${renderPlansViewKeyboardNav()}
</script>`;
}
