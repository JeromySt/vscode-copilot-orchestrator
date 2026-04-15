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
  return `// ── Tab Switching ────────────────────────────────────────────────────
var tabs = document.querySelectorAll('.tab');
var tabContents = document.querySelectorAll('.tab-content');

function switchTab(tabName) {
  // Update tab buttons
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  }
  
  // Update tab content
  for (var i = 0; i < tabContents.length; i++) {
    var content = tabContents[i];
    if (content.id === 'tabContent' + tabName.charAt(0).toUpperCase() + tabName.slice(1)) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  }
  
  // Persist state
  vscode.setState({ activeTab: tabName });
}

// Wire tab click handlers
for (var i = 0; i < tabs.length; i++) {
  tabs[i].addEventListener('click', function(e) {
    var tabName = e.currentTarget.dataset.tab;
    switchTab(tabName);
  });
}

// Restore tab state on load
var state = vscode.getState();
if (state && state.activeTab) {
  switchTab(state.activeTab);
} else {
  switchTab('plans'); // Default to Plans tab
}

// ── Control Initialization ───────────────────────────────────────────
var planListContainer = new PlanListContainerControl(bus, 'plan-list-container', 'plans');
var capacityBar = new CapacityBarControl(bus, 'capacity-bar');
var prListContainer = new PRListContainerControl(bus, 'pr-list-container', 'prs');
var releaseListContainer = new ReleaseListContainerControl(bus, 'release-list-container', 'releases');

// ── Adopt PR Button ───────────────────────────────────────────────────
var adoptPRButton = document.getElementById('adoptPRButton');
if (adoptPRButton) {
  adoptPRButton.addEventListener('click', function() {
    vscode.postMessage({ type: 'adoptPR' });
  });
}

// ── Release Buttons ────────────────────────────────────────────────────
var newReleaseButton = document.getElementById('newReleaseButton');
if (newReleaseButton) {
  newReleaseButton.addEventListener('click', function() {
    vscode.postMessage({ type: 'createRelease' });
  });
}

var releaseFromBranchButton = document.getElementById('releaseFromBranchButton');
if (releaseFromBranchButton) {
  releaseFromBranchButton.addEventListener('click', function() {
    vscode.postMessage({ type: 'createReleaseFromBranch' });
  });
}

// ── Managed PRs Section Collapse/Expand ────────────────────────────────
var managedPRsHeader = document.getElementById('managedPRsHeader');
var managedPRsContent = document.getElementById('managedPRsContent');
var prsSectionChevron = document.getElementById('prsSectionChevron');
var prsSectionCollapsed = false;

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

// ── Releases Section Collapse/Expand ───────────────────────────────────
var releasesHeader = document.getElementById('releasesHeader');
var releasesContent = document.getElementById('releasesContent');
var releasesSectionChevron = document.getElementById('releasesSectionChevron');
var releasesSectionCollapsed = false;

if (releasesHeader && releasesContent && releasesSectionChevron) {
  releasesHeader.addEventListener('click', function(e) {
    // Don't toggle if clicking on buttons
    if (e.target.closest('.section-action-btn')) return;
    
    releasesSectionCollapsed = !releasesSectionCollapsed;
    if (releasesSectionCollapsed) {
      releasesContent.classList.add('collapsed');
      releasesSectionChevron.classList.add('collapsed');
    } else {
      releasesContent.classList.remove('collapsed');
      releasesSectionChevron.classList.remove('collapsed');
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
    // Show bulk actions bar with contextual buttons
    bulkActionsBar.style.display = 'flex';
    selectionCountEl.textContent = event.count + ' selected';
    updateBulkActionVisibility(event.selectedIds);
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
    // Fallback: use the right-clicked plan if multi-select is empty
    if (selectedIds.length === 0) {
      var menu = document.getElementById('contextMenu');
      var fallbackId = menu && menu.dataset.contextPlanId;
      if (fallbackId) { selectedIds = [fallbackId]; }
    }
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

// Auto-hide context menu when cursor leaves for 2 seconds
(function() {
  var menu = document.getElementById('contextMenu');
  var hideTimer = null;
  if (menu) {
    menu.addEventListener('mouseleave', function() {
      hideTimer = setTimeout(function() { menu.style.display = 'none'; }, 2000);
    });
    menu.addEventListener('mouseenter', function() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
  }
})();

// Update ordered IDs when plan list changes
bus.on(PlansTopics.PLANS_UPDATE, function(plans) {
  if (plans && plans.length > 0) {
    var ids = plans.map(function(p) { return p.id; });
    multiSelectManager.setOrderedIds(ids);
  } else {
    multiSelectManager.setOrderedIds([]);
  }
  
  // Update Plans tab badge
  updateTabBadge('plans', plans.length);
});

// Update PRs tab badge when PR list changes
bus.on('prs:update', function(prs) {
  updateTabBadge('prs', prs ? prs.length : 0);
});

// Update Releases tab badge when release list changes
bus.on('releases:update', function(releases) {
  updateTabBadge('releases', releases ? releases.length : 0);
});

// Auto-switch to PRs tab when PR is adopted
bus.on('pr:state', function(pr) {
  if (pr && pr.status === 'adopted') {
    switchTab('prs');
  }
});

// Badge update helper
function updateTabBadge(tabName, count) {
  var badgeId = 'tabBadge' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
  var badge = document.getElementById(badgeId);
  if (badge) {
    if (count > 0) {
      badge.textContent = count.toString();
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ── Contextual Action Visibility ─────────────────────────────────────
// Collect statuses from selected plan cards' data-status attribute
function getStatusesForIds(selectedIds) {
  var statuses = [];
  for (var si = 0; si < selectedIds.length; si++) {
    var card = document.querySelector('.plan-item[data-id=\"' + selectedIds[si] + '\"]');
    if (card && card.dataset.status) statuses.push(card.dataset.status);
  }
  return statuses;
}

function computeVisibility(statuses) {
  var hasRunning = statuses.indexOf('running') !== -1 || statuses.indexOf('pending') !== -1;
  var hasPaused = statuses.indexOf('paused') !== -1 || statuses.indexOf('pending-start') !== -1;
  var hasFailed = statuses.indexOf('failed') !== -1 || statuses.indexOf('partial') !== -1;
  var hasScaffolding = statuses.indexOf('scaffolding') !== -1;
  var hasArchivable = statuses.indexOf('succeeded') !== -1 || statuses.indexOf('partial') !== -1 || statuses.indexOf('canceled') !== -1 || statuses.indexOf('failed') !== -1;
  var hasRecoverable = statuses.indexOf('canceled') !== -1 || statuses.indexOf('archived') !== -1 || statuses.indexOf('failed') !== -1;
  var hasSucceeded = statuses.indexOf('succeeded') !== -1;
  return {
    resume: hasPaused,
    pause: hasRunning,
    cancel: hasRunning || hasPaused,
    retry: hasFailed,
    finalize: hasScaffolding,
    archive: hasArchivable,
    recover: hasRecoverable,
    assignToRelease: hasSucceeded,
    createReleaseFromPlans: hasSucceeded,
    delete: true
  };
}

/** Show/hide bulk action buttons based on selected plans' statuses */
function updateBulkActionVisibility(selectedIds) {
  var vis = computeVisibility(getStatusesForIds(selectedIds));
  var btns = document.querySelectorAll('#bulkButtons .bulk-btn');
  for (var bi = 0; bi < btns.length; bi++) {
    var action = btns[bi].dataset.action;
    btns[bi].style.display = (vis[action] !== undefined ? vis[action] : true) ? '' : 'none';
  }
}

/** Show/hide context menu items based on selected plans' statuses */
function updateContextMenuVisibility(selectedIds) {
  var vis = computeVisibility(getStatusesForIds(selectedIds));
  var items = document.querySelectorAll('#contextMenu .context-menu-item');
  var prevVisible = false;
  for (var ci = 0; ci < items.length; ci++) {
    var action = items[ci].dataset.action;
    if (!action) continue;
    var show = vis[action] !== undefined ? vis[action] : true;
    items[ci].style.display = show ? '' : 'none';
    prevVisible = show;
  }
  // Hide separators that are adjacent to hidden items (clean look)
  var seps = document.querySelectorAll('#contextMenu .context-menu-separator');
  for (var si = 0; si < seps.length; si++) {
    var prev = seps[si].previousElementSibling;
    var next = seps[si].nextElementSibling;
    var prevHidden = prev && prev.style.display === 'none';
    var nextHidden = next && (next.style.display === 'none' || next.classList.contains('context-menu-separator'));
    seps[si].style.display = (prevHidden || nextHidden) ? 'none' : '';
  }
}

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
