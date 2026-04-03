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
 * 'planDeleted', 'badgeUpdate', 'capacityUpdate', 'pulse', PR events.
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
      var badge = document.getElementById('tabBadgePlans') || document.getElementById('badge');
      if (badge) badge.textContent = Plans.length;
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
      var badge = document.getElementById('tabBadgePlans') || document.getElementById('badge');
      if (badge) badge.textContent = (msg.total || 0);
      break;
      
    case 'capacityUpdate':
      bus.emit(PlansTopics.CAPACITY_UPDATE, {
        globalCapacity: msg.globalCapacity,
        globalStats: msg.globalStats
      });
      break;
      
    case 'prsUpdate':
      // Initial load: full PR list
      var prs = msg.prs || [];
      bus.emit('prs:update', prs);
      break;
      
    case 'prAdded':
      // Single PR added
      if (msg.pr) {
        prListContainer.addPR(msg.pr);
      }
      break;
      
    case 'prStateChange':
      // Per-PR state update — emit to EventBus for the matching card
      if (msg.pr) {
        bus.emit('pr:state', msg.pr);
      }
      break;
      
    case 'prDeleted':
      // Single PR removed
      if (msg.prId) {
        prListContainer.removePR(msg.prId);
      }
      break;
      
    case 'releasesUpdate':
      // Initial load: full release list
      var releases = msg.releases || [];
      bus.emit('releases:update', releases);
      break;
      
    case 'releaseAdded':
      // Single release added
      if (msg.release) {
        releaseListContainer.addRelease(msg.release);
      }
      break;
      
    case 'releaseStateChange':
      // Per-release state update — emit to EventBus for the matching card
      if (msg.release) {
        bus.emit('release:state', msg.release);
      }
      break;
      
    case 'releaseDeleted':
      // Single release removed
      if (msg.releaseId) {
        releaseListContainer.removeRelease(msg.releaseId);
      }
      break;
      
    case 'switchTab':
      // Switch to a specific tab programmatically
      if (msg.tab) {
        switchTab(msg.tab);
      }
      break;

  }
});

// Request initial data
vscode.postMessage({ type: 'refresh' });`;
}
