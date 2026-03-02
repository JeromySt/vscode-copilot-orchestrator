/**
 * @fileoverview Plans view message router script.
 *
 * Generates the postMessage handler for extension → webview communication.
 *
 * @module ui/templates/plansView/scripts/messageRouter
 */

/**
 * Render the message router script for plans view.
 *
 * Handles messages from the extension: 'update', 'planAdded', 'planStateChange',
 * 'planDeleted', 'badgeUpdate', 'capacityUpdate', 'pulse'.
 *
 * @returns JavaScript code string.
 */
export function renderPlansViewMessageRouter(): string {
  return `let isInitialLoad = true;

// ── Message Handler ──────────────────────────────────────────────────
window.addEventListener('message', function(ev) {
  var msg = ev.data;
  switch (msg.type) {
    case 'pulse':
      bus.emit(PlansTopics.PULSE);
      break;
      
    case 'update':
      // Initial load: full plan list
      var Plans = msg.Plans || [];
      document.getElementById('badge').textContent = Plans.length + ' total';
      bus.emit(PlansTopics.PLANS_UPDATE, Plans);
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
        bus.emit(PlansTopics.PLAN_STATE_CHANGE, msg.plan);
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
      bus.emit(PlansTopics.CAPACITY_UPDATE, {
        globalCapacity: msg.globalCapacity,
        globalStats: msg.globalStats
      });
      break;

  }
});

// Request initial data
vscode.postMessage({ type: 'refresh' });`;
}
