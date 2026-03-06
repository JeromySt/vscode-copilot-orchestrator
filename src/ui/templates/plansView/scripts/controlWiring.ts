/**
 * @fileoverview Plans view control wiring script.
 *
 * Generates the control instantiation code.
 *
 * @module ui/templates/plansView/scripts/controlWiring
 */

/**
 * Render the control wiring script for plans view.
 *
 * Instantiates the PlanListContainerControl and CapacityBarControl.
 *
 * @returns JavaScript code string.
 */
export function renderPlansViewControlWiring(): string {
  return `// ── Control Initialization ───────────────────────────────────────────
var planListContainer = new PlanListContainerControl(bus, 'plan-list-container', 'plans');
var capacityBar = new CapacityBarControl(bus, 'capacity-bar');
var prListContainer = new PRListContainerControl(bus, 'pr-list-container', 'prs');

// ── Adopt PR Button ───────────────────────────────────────────────────
var adoptPRButton = document.getElementById('adoptPRButton');
if (adoptPRButton) {
  adoptPRButton.addEventListener('click', function() {
    vscode.postMessage({ type: 'adoptPR' });
  });
}

// ── Managed PRs Section Collapse/Expand ────────────────────────────────
var managedPRsHeader = document.getElementById('managedPRsToggle') || document.getElementById('managedPRsHeader');
var managedPRsContent = document.getElementById('managedPRsContent');
var prsSectionChevron = document.getElementById('prsSectionChevron');
var prsSectionCollapsed = true;  // Start collapsed by default

if (managedPRsHeader && managedPRsContent && prsSectionChevron) {
  managedPRsHeader.addEventListener('click', function() {
    prsSectionCollapsed = !prsSectionCollapsed;
    if (prsSectionCollapsed) {
      managedPRsContent.classList.add('collapsed');
      prsSectionChevron.classList.add('collapsed');
    } else {
      managedPRsContent.classList.remove('collapsed');
      prsSectionChevron.classList.remove('collapsed');
    }
  });
}

// ── Multi-Select Manager ─────────────────────────────────────────────
var multiSelectManager = new MultiSelectManager(bus, 'plan-multi-select');
window._planMultiSelect = multiSelectManager; // Global ref for card event handlers

// Listen for selection changes
bus.on(Topics.PLANS_SELECTION_CHANGED, function(event) {
  var bulkActionsBar = document.getElementById('bulkActions');
  var selectionCountEl = document.getElementById('selectionCount');
  
  if (event.count > 1) {
    bulkActionsBar.style.display = 'flex';
    selectionCountEl.textContent = event.count + ' selected';
    updateBulkActionVisibility(event.selectedIds);
  } else {
    bulkActionsBar.style.display = 'none';
  }
  
  // Update selected state on all cards
  var allCards = document.querySelectorAll('.plan-item');
  for (var i = 0; i < allCards.length; i++) {
    var card = allCards[i];
    var planId = card.dataset.id;
    var isSelected = event.selectedIds.indexOf(planId) !== -1;
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  }
});

// Dismiss button clears selection
var bulkDismissBtn = document.getElementById('bulkDismiss');
if (bulkDismissBtn) {
  bulkDismissBtn.addEventListener('click', function() {
    multiSelectManager.deselectAll();
  });
}

/** Show/hide bulk action buttons based on selected plans' statuses */
function updateBulkActionVisibility(selectedIds) {
  var statuses = [];
  for (var si = 0; si < selectedIds.length; si++) {
    var card = document.querySelector('.plan-item[data-id=\"' + selectedIds[si] + '\"]');
    if (card && card.dataset.status) statuses.push(card.dataset.status);
  }
  var hasRunning = statuses.indexOf('running') !== -1 || statuses.indexOf('pending') !== -1;
  var hasPaused = statuses.indexOf('paused') !== -1 || statuses.indexOf('pending-start') !== -1;
  var hasFailed = statuses.indexOf('failed') !== -1 || statuses.indexOf('partial') !== -1;
  var hasScaffolding = statuses.indexOf('scaffolding') !== -1;
  var hasArchivable = statuses.indexOf('succeeded') !== -1 || statuses.indexOf('partial') !== -1 || statuses.indexOf('canceled') !== -1 || statuses.indexOf('failed') !== -1;
  var hasRecoverable = statuses.indexOf('canceled') !== -1 || statuses.indexOf('archived') !== -1 || statuses.indexOf('failed') !== -1;
  var btns = document.querySelectorAll('#bulkButtons .bulk-btn');
  for (var bi = 0; bi < btns.length; bi++) {
    var action = btns[bi].dataset.action;
    var show = false;
    switch (action) {
      case 'resume':   show = hasPaused; break;
      case 'pause':    show = hasRunning; break;
      case 'cancel':   show = hasRunning || hasPaused; break;
      case 'retry':    show = hasFailed; break;
      case 'finalize': show = hasScaffolding; break;
      case 'archive':  show = hasArchivable; break;
      case 'recover':  show = hasRecoverable; break;
      case 'delete':   show = true; break;
    }
    btns[bi].style.display = show ? '' : 'none';
  }
}

/** Show/hide context menu items based on selected plans' statuses */
function updateContextMenuVisibility(selectedIds) {
  var statuses = [];
  for (var si = 0; si < selectedIds.length; si++) {
    var card = document.querySelector('.plan-item[data-id=\"' + selectedIds[si] + '\"]');
    if (card && card.dataset.status) statuses.push(card.dataset.status);
  }
  var hasRunning = statuses.indexOf('running') !== -1 || statuses.indexOf('pending') !== -1;
  var hasPaused = statuses.indexOf('paused') !== -1 || statuses.indexOf('pending-start') !== -1;
  var hasFailed = statuses.indexOf('failed') !== -1 || statuses.indexOf('partial') !== -1;
  var hasScaffolding = statuses.indexOf('scaffolding') !== -1;
  var hasArchivable = statuses.indexOf('succeeded') !== -1 || statuses.indexOf('partial') !== -1 || statuses.indexOf('canceled') !== -1 || statuses.indexOf('failed') !== -1;
  var hasRecoverable = statuses.indexOf('canceled') !== -1 || statuses.indexOf('archived') !== -1 || statuses.indexOf('failed') !== -1;
  var items = document.querySelectorAll('#contextMenu .context-menu-item');
  for (var ci = 0; ci < items.length; ci++) {
    var action = items[ci].dataset.action;
    if (!action) continue;
    var show = false;
    switch (action) {
      case 'resume':   show = hasPaused; break;
      case 'pause':    show = hasRunning; break;
      case 'cancel':   show = hasRunning || hasPaused; break;
      case 'retry':    show = hasFailed; break;
      case 'finalize': show = hasScaffolding; break;
      case 'archive':  show = hasArchivable; break;
      case 'recover':  show = hasRecoverable; break;
      case 'delete':   show = true; break;
    }
    items[ci].style.display = show ? '' : 'none';
  }
}

// Wire bulk action buttons
var bulkButtons = document.querySelectorAll('.bulk-btn');
for (var i = 0; i < bulkButtons.length; i++) {
  bulkButtons[i].addEventListener('click', function(e) {
    var action = e.currentTarget.dataset.action;
    var selectedIds = multiSelectManager.getSelectedIds();
    if (selectedIds.length > 0) {
      vscode.postMessage({
        type: 'bulkAction',
        action: action,
        planIds: selectedIds
      });
    }
  });
}

// Wire context menu items
var contextMenuItems = document.querySelectorAll('.context-menu-item');
for (var i = 0; i < contextMenuItems.length; i++) {
  contextMenuItems[i].addEventListener('click', function(e) {
    var action = e.currentTarget.dataset.action;
    if (!action) return;
    var selectedIds = multiSelectManager.getSelectedIds();
    if (selectedIds.length > 0) {
      vscode.postMessage({
        type: 'bulkAction',
        action: action,
        planIds: selectedIds
      });
    }
    // Hide context menu
    document.getElementById('contextMenu').style.display = 'none';
  });
}

// Hide context menu on click outside
document.addEventListener('click', function(e) {
  var menu = document.getElementById('contextMenu');
  if (menu && !menu.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// Update ordered IDs when plan list changes
bus.on(PlansTopics.PLANS_UPDATE, function(plans) {
  if (plans && plans.length > 0) {
    var ids = plans.map(function(p) { return p.id; });
    multiSelectManager.setOrderedIds(ids);
  } else {
    multiSelectManager.setOrderedIds([]);
  }
});

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

bus.on(PlansTopics.PULSE, tickAllDurations);`;
}
