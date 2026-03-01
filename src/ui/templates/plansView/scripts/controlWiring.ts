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
