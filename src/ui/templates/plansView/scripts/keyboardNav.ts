/**
 * @fileoverview Plans view keyboard navigation script.
 *
 * Generates the keyboard event handler for plan list navigation.
 *
 * @module ui/templates/plansView/scripts/keyboardNav
 */

/**
 * Render the keyboard navigation script for plans view.
 *
 * Supports Enter (open), Delete (delete), Ctrl+Escape (cancel), Arrow Up/Down (navigate).
 *
 * @returns JavaScript code string.
 */
export function renderPlansViewKeyboardNav(): string {
  return `// Global keyboard handler - works without focus on specific plan item
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
});`;
}
