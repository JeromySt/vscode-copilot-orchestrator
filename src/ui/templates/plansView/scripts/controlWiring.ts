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

// ── Multi-Select Manager ─────────────────────────────────────────────
var multiSelectManager = new MultiSelectManager(bus, 'plan-multi-select');
window._planMultiSelect = multiSelectManager; // Global ref for card event handlers

// Listen for selection changes
bus.on(Topics.PLANS_SELECTION_CHANGED, function(event) {
  var bulkActionsBar = document.getElementById('bulkActions');
  var selectionCountEl = document.getElementById('selectionCount');
  
  if (event.count > 1) {
    // Show bulk actions bar
    bulkActionsBar.style.display = 'flex';
    selectionCountEl.textContent = event.count + ' selected';
  } else {
    // Hide bulk actions bar
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
