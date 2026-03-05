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
  var multiSelect = window._planMultiSelect;
  
  // Ctrl/Cmd+A: Select all
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    if (multiSelect) {
      multiSelect.selectAll();
    }
    return;
  }
  
  // Escape: Deselect all
  if (e.key === 'Escape') {
    e.preventDefault();
    if (multiSelect) {
      multiSelect.deselectAll();
    }
    return;
  }
  
  // Delete: Bulk delete if multi-selected
  if (e.key === 'Delete') {
    e.preventDefault();
    if (multiSelect) {
      var selectedIds = multiSelect.getSelectedIds();
      if (selectedIds.length > 1) {
        // Bulk delete
        vscode.postMessage({
          type: 'bulkAction',
          action: 'delete',
          planIds: selectedIds
        });
        return;
      } else if (selectedIds.length === 1) {
        // Single delete
        vscode.postMessage({ type: 'deletePlan', planId: selectedIds[0] });
        return;
      }
    }
    // Fallback to focused element
    let targetEl = document.activeElement;
    if (!targetEl || !targetEl.classList.contains('plan-item')) {
      targetEl = document.querySelector('.plan-item');
    }
    if (targetEl) {
      const planId = targetEl.dataset.id;
      vscode.postMessage({ type: 'deletePlan', planId });
    }
    return;
  }
  
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
      // If shift held, extend selection
      if (e.shiftKey && multiSelect) {
        multiSelect.handleKeyboard('ArrowDown', { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
      } else if (!e.ctrlKey && !e.metaKey) {
        // Arrow without modifiers: select the focused item
        const nextId = next.dataset.id;
        if (multiSelect && nextId) {
          multiSelect.handleClick(nextId, { ctrlKey: false, shiftKey: false, metaKey: false });
        }
      }
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = targetEl.previousElementSibling;
    if (prev && prev.classList.contains('plan-item')) {
      prev.focus();
      // If shift held, extend selection
      if (e.shiftKey && multiSelect) {
        multiSelect.handleKeyboard('ArrowUp', { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
      } else if (!e.ctrlKey && !e.metaKey) {
        // Arrow without modifiers: select the focused item
        const prevId = prev.dataset.id;
        if (multiSelect && prevId) {
          multiSelect.handleClick(prevId, { ctrlKey: false, shiftKey: false, metaKey: false });
        }
      }
    }
  }
});`;
}
