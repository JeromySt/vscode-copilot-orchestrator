/**
 * @fileoverview Multi-select state manager for list controls.
 *
 * Provides standard Windows/Mac multi-select behavior with keyboard support:
 * - Click: single select (deselect others)
 * - Ctrl/Cmd+Click: toggle single item
 * - Shift+Click: range selection from anchor
 * - Right-click: context-aware selection
 * - Ctrl+A: select all
 * - Escape: deselect all
 * - Shift+Arrow: extend selection
 * - Delete: trigger bulk delete action
 *
 * @module ui/webview/controls/multiSelectManager
 */

import { SubscribableControl } from '../subscribableControl';
import { EventBus } from '../eventBus';
import { Topics } from '../topics';

/** Selection state maintained by the manager. */
export interface SelectionState {
  /** Set of currently selected item IDs. */
  selectedIds: Set<string>;
  /** Last selected ID (for range selection anchor). */
  lastSelectedId: string | null;
  /** Anchor ID for shift-click range selection. */
  anchorId: string | null;
}

/** Event payload for selection change notifications. */
export interface SelectionChangedEvent {
  /** Array of selected IDs. */
  selectedIds: string[];
  /** Number of selected items. */
  count: number;
}

/** Event payload for bulk action requests. */
export interface BulkActionEvent {
  /** Action type (e.g., 'delete'). */
  action: string;
  /** IDs to act on. */
  selectedIds: string[];
}

/**
 * Manages multi-select state for a list of items.
 *
 * Provides standard Windows/Mac multi-select behavior:
 * - Click: single select
 * - Ctrl+Click: toggle
 * - Shift+Click: range
 * - Right-click: context-aware selection
 * - Ctrl+A: select all
 * - Escape: deselect all
 */
export class MultiSelectManager extends SubscribableControl {
  private _state: SelectionState;
  private _orderedIds: string[] = []; // Maintains order for range selection

  /**
   * Create a new multi-select manager.
   *
   * @param bus - Event bus for publishing selection changes
   * @param controlId - Unique identifier for this control
   */
  constructor(bus: EventBus, controlId: string) {
    super(bus, controlId);
    this._state = { selectedIds: new Set(), lastSelectedId: null, anchorId: null };
  }

  /**
   * Update the ordered list of item IDs.
   *
   * Call this when the list content changes (items added/removed/reordered).
   * Automatically prunes selection of IDs no longer in the list.
   *
   * @param ids - Array of item IDs in display order
   */
  setOrderedIds(ids: string[]): void {
    this._orderedIds = [...ids];
    
    // Prune selected IDs that are no longer in the list
    const validIds = new Set(ids);
    const pruned = new Set<string>();
    for (const id of this._state.selectedIds) {
      if (validIds.has(id)) {
        pruned.add(id);
      }
    }
    
    const countBefore = this._state.selectedIds.size;
    this._state.selectedIds = pruned;
    
    // Clear anchor/last if they're no longer valid
    if (this._state.anchorId && !validIds.has(this._state.anchorId)) {
      this._state.anchorId = null;
    }
    if (this._state.lastSelectedId && !validIds.has(this._state.lastSelectedId)) {
      this._state.lastSelectedId = null;
    }
    
    // Emit if selection changed due to pruning
    if (countBefore !== this._state.selectedIds.size) {
      this._emitSelectionChanged();
    }
  }

  /**
   * Handle a click on an item.
   *
   * @param id - Item ID that was clicked
   * @param event - Mouse event modifiers
   */
  handleClick(id: string, event: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): void {
    // Validate ID exists in list
    if (!this._orderedIds.includes(id)) {
      return;
    }
    
    const isMultiModifier = event.ctrlKey || event.metaKey;
    
    if (event.shiftKey && this._state.anchorId) {
      // Range select from anchor to clicked item
      this._rangeSelect(this._state.anchorId, id);
    } else if (isMultiModifier) {
      // Toggle single item
      this._toggleItem(id);
    } else {
      // Single select (clear others)
      this._selectSingle(id);
    }
    
    this._emitSelectionChanged();
  }

  /**
   * Handle right-click context menu.
   *
   * If the clicked item is in the selection, keep selection unchanged.
   * Otherwise, select only the clicked item.
   *
   * @param id - Item ID that was right-clicked
   */
  handleContextMenu(id: string): void {
    // Validate ID exists in list
    if (!this._orderedIds.includes(id)) {
      return;
    }
    
    if (!this._state.selectedIds.has(id)) {
      // Clicked outside selection - select only this item
      this._selectSingle(id);
      this._emitSelectionChanged();
    }
    // If already in selection, keep selection unchanged
  }

  /**
   * Handle keyboard navigation with selection.
   *
   * Supports:
   * - Ctrl+A / Cmd+A: select all
   * - Escape: deselect all
   * - Shift+ArrowUp/Down: extend selection
   * - Delete: trigger bulk delete action
   *
   * @param key - Keyboard key code
   * @param event - Keyboard event modifiers
   */
  handleKeyboard(key: string, event: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): void {
    const isModifier = event.ctrlKey || event.metaKey;
    
    // Ctrl+A / Cmd+A: select all
    if (key === 'a' && isModifier) {
      this.selectAll();
      return;
    }
    
    // Escape: deselect all
    if (key === 'Escape') {
      this.deselectAll();
      return;
    }
    
    // Delete: trigger bulk delete action
    if (key === 'Delete' && this._state.selectedIds.size > 0) {
      this._bus.emit(Topics.PLANS_BULK_ACTION, {
        action: 'delete',
        selectedIds: Array.from(this._state.selectedIds),
      } as BulkActionEvent);
      return;
    }
    
    // Shift+Arrow: extend selection
    if (event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      this._extendSelectionByArrow(key);
      return;
    }
    
    // Arrow without shift: move focus (caller's responsibility to implement focus)
    // We just ensure the focused item becomes selected
    if (!event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      // This is handled by the caller - we don't manage focus, just selection
      return;
    }
  }

  /**
   * Select all items in the list.
   */
  selectAll(): void {
    this._state.selectedIds = new Set(this._orderedIds);
    if (this._orderedIds.length > 0) {
      this._state.anchorId = this._orderedIds[0];
      this._state.lastSelectedId = this._orderedIds[this._orderedIds.length - 1];
    }
    this._emitSelectionChanged();
  }

  /**
   * Deselect all items.
   */
  deselectAll(): void {
    if (this._state.selectedIds.size === 0) {
      return; // Already empty, no change
    }
    this._state.selectedIds.clear();
    this._state.anchorId = null;
    this._state.lastSelectedId = null;
    this._emitSelectionChanged();
  }

  /**
   * Get array of currently selected IDs.
   *
   * @returns Array of selected item IDs
   */
  getSelectedIds(): string[] {
    return Array.from(this._state.selectedIds);
  }

  /**
   * Check if an item is selected.
   *
   * @param id - Item ID to check
   * @returns True if the item is selected
   */
  isSelected(id: string): boolean {
    return this._state.selectedIds.has(id);
  }

  /**
   * Get the number of selected items.
   *
   * @returns Count of selected items
   */
  getSelectionCount(): number {
    return this._state.selectedIds.size;
  }

  /**
   * Required by SubscribableControl base class.
   * Not used by MultiSelectManager (state is managed internally).
   *
   * @param _data - Ignored
   */
  update(_data?: any): void {
    // MultiSelectManager doesn't consume external updates
    // State is driven by user interaction (clicks, keyboard)
  }

  // ── Private Methods ────────────────────────────────────────────────────

  /**
   * Select a single item (deselecting all others).
   *
   * @param id - Item ID to select
   */
  private _selectSingle(id: string): void {
    this._state.selectedIds.clear();
    this._state.selectedIds.add(id);
    this._state.anchorId = id;
    this._state.lastSelectedId = id;
  }

  /**
   * Toggle selection of a single item.
   *
   * @param id - Item ID to toggle
   */
  private _toggleItem(id: string): void {
    if (this._state.selectedIds.has(id)) {
      this._state.selectedIds.delete(id);
      // If we just deselected the anchor, clear it
      if (this._state.anchorId === id) {
        // Find a new anchor from remaining selection
        const remaining = Array.from(this._state.selectedIds);
        this._state.anchorId = remaining.length > 0 ? remaining[0] : null;
      }
      if (this._state.lastSelectedId === id) {
        const remaining = Array.from(this._state.selectedIds);
        this._state.lastSelectedId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
    } else {
      this._state.selectedIds.add(id);
      this._state.anchorId = id;
      this._state.lastSelectedId = id;
    }
  }

  /**
   * Select a range of items from fromId to toId (inclusive).
   *
   * @param fromId - Start of range
   * @param toId - End of range
   */
  private _rangeSelect(fromId: string, toId: string): void {
    const fromIdx = this._orderedIds.indexOf(fromId);
    const toIdx = this._orderedIds.indexOf(toId);
    
    if (fromIdx === -1 || toIdx === -1) {
      return; // Invalid range
    }
    
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    
    // Clear existing selection and select range
    this._state.selectedIds.clear();
    for (let i = start; i <= end; i++) {
      this._state.selectedIds.add(this._orderedIds[i]);
    }
    
    // Keep anchor where it was, update last selected
    this._state.lastSelectedId = toId;
  }

  /**
   * Extend selection by arrow key (Shift+Arrow).
   *
   * @param key - 'ArrowUp' or 'ArrowDown'
   */
  private _extendSelectionByArrow(key: string): void {
    // If no selection, nothing to extend
    if (this._state.selectedIds.size === 0 || this._orderedIds.length === 0) {
      return;
    }
    
    // Find the last selected item's index
    const lastId = this._state.lastSelectedId || Array.from(this._state.selectedIds)[0];
    const lastIdx = this._orderedIds.indexOf(lastId);
    
    if (lastIdx === -1) {
      return; // Invalid state
    }
    
    // Determine new index based on arrow direction
    let newIdx = lastIdx;
    if (key === 'ArrowUp' && lastIdx > 0) {
      newIdx = lastIdx - 1;
    } else if (key === 'ArrowDown' && lastIdx < this._orderedIds.length - 1) {
      newIdx = lastIdx + 1;
    } else {
      return; // Already at boundary
    }
    
    const newId = this._orderedIds[newIdx];
    
    // If anchor is not set, use the first selected item
    if (!this._state.anchorId) {
      this._state.anchorId = Array.from(this._state.selectedIds)[0];
    }
    
    // Range select from anchor to new position
    this._rangeSelect(this._state.anchorId, newId);
    this._emitSelectionChanged();
  }

  /**
   * Emit selection changed event.
   */
  private _emitSelectionChanged(): void {
    this._bus.emit(Topics.PLANS_SELECTION_CHANGED, {
      selectedIds: Array.from(this._state.selectedIds),
      count: this._state.selectedIds.size,
    } as SelectionChangedEvent);
    this.publishUpdate({
      selectedIds: Array.from(this._state.selectedIds),
      count: this._state.selectedIds.size,
    });
  }
}
