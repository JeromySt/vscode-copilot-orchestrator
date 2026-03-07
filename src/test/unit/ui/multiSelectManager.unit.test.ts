/**
 * @fileoverview Unit tests for MultiSelectManager
 * 
 * @module test/unit/ui/multiSelectManager
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { MultiSelectManager } from '../../../ui/webview/controls/multiSelectManager';
import { EventBus } from '../../../ui/webview/eventBus';

suite('MultiSelectManager', () => {
  let sandbox: sinon.SinonSandbox;
  let manager: MultiSelectManager;
  let mockBus: EventBus;
  let emitStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockBus = new EventBus();
    emitStub = sandbox.stub(mockBus, 'emit');
    manager = new MultiSelectManager(mockBus, 'test-control');
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleClick — single select', () => {
    test('selects clicked item and deselects all others', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 1);
      assert.strictEqual(selected[0], 'id2');
      assert.ok(manager.isSelected('id2'));
      assert.ok(!manager.isSelected('id1'));
    });

    test('sets anchor to clicked item', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: false });

      // Verify anchor is set by attempting shift+click range
      emitStub.resetHistory();
      manager.handleClick('id3', { ctrlKey: false, shiftKey: true, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 2);
      assert.ok(manager.isSelected('id2'));
      assert.ok(manager.isSelected('id3'));
    });

    test('emits selection changed event with single ID', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      emitStub.resetHistory();

      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: false });

      assert.ok(emitStub.called);
      const callArgs = emitStub.getCall(0).args;
      assert.strictEqual(callArgs[0], 'plans:selection:changed');
      assert.deepStrictEqual(callArgs[1].selectedIds, ['id2']);
      assert.strictEqual(callArgs[1].count, 1);
    });
  });

  suite('handleClick — Ctrl+Click toggle', () => {
    test('adds item to selection when not already selected', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 2);
      assert.ok(manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
    });

    test('removes item from selection when already selected', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 1);
      assert.ok(!manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
    });

    test('preserves other selections', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3', 'id4']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id3', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 2);
      assert.ok(manager.isSelected('id1'));
      assert.ok(!manager.isSelected('id2'));
      assert.ok(manager.isSelected('id3'));
    });

    test('works with metaKey for Mac compatibility', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: false, shiftKey: false, metaKey: true });
      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: true });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 2);
      assert.ok(manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
    });
  });

  suite('handleClick — Shift+Click range', () => {
    test('selects range from anchor to clicked item', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3', 'id4', 'id5']);
      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id4', { ctrlKey: false, shiftKey: true, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 3);
      assert.ok(manager.isSelected('id2'));
      assert.ok(manager.isSelected('id3'));
      assert.ok(manager.isSelected('id4'));
    });

    test('selects range in reverse direction', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3', 'id4', 'id5']);
      manager.handleClick('id4', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: false, shiftKey: true, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 3);
      assert.ok(manager.isSelected('id2'));
      assert.ok(manager.isSelected('id3'));
      assert.ok(manager.isSelected('id4'));
    });

    test('replaces previous selection', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3', 'id4', 'id5']);
      manager.handleClick('id1', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id4', { ctrlKey: false, shiftKey: true, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 3);
      assert.ok(!manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
      assert.ok(manager.isSelected('id3'));
      assert.ok(manager.isSelected('id4'));
    });

    test('does nothing when no anchor set', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      emitStub.resetHistory();
      manager.handleClick('id2', { ctrlKey: false, shiftKey: true, metaKey: false });

      // When no anchor exists, shift+click acts as single select
      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 1);
      assert.ok(manager.isSelected('id2'));
      assert.ok(emitStub.called);
    });

    test('handles adjacent items', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: false, shiftKey: true, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 2);
      assert.ok(manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
    });

    test('handles same item clicked twice', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id2', { ctrlKey: false, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: false, shiftKey: true, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 1);
      assert.ok(manager.isSelected('id2'));
    });
  });

  suite('handleContextMenu', () => {
    test('keeps selection when right-clicking selected item', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });
      
      emitStub.resetHistory();
      manager.handleContextMenu('id1');

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 2);
      assert.ok(manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
      assert.ok(!emitStub.called);
    });

    test('selects only right-clicked item when outside selection', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      
      emitStub.resetHistory();
      manager.handleContextMenu('id3');

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 1);
      assert.ok(!manager.isSelected('id1'));
      assert.ok(manager.isSelected('id3'));
    });

    test('emits selection changed on new selection', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: false, shiftKey: false, metaKey: false });
      
      emitStub.resetHistory();
      manager.handleContextMenu('id3');

      assert.ok(emitStub.called);
      const callArgs = emitStub.getCall(0).args;
      assert.strictEqual(callArgs[0], 'plans:selection:changed');
      assert.deepStrictEqual(callArgs[1].selectedIds, ['id3']);
    });
  });

  suite('handleKeyboard', () => {
    test('Ctrl+A selects all items', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      
      emitStub.resetHistory();
      manager.handleKeyboard('a', { ctrlKey: true, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 3);
      assert.ok(manager.isSelected('id1'));
      assert.ok(manager.isSelected('id2'));
      assert.ok(manager.isSelected('id3'));
      assert.ok(emitStub.called);
    });

    test('Escape deselects all', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });
      
      emitStub.resetHistory();
      manager.handleKeyboard('Escape', { ctrlKey: false, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 0);
      assert.ok(emitStub.called);
    });

    test('Delete emits bulk action for selected', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });
      
      emitStub.resetHistory();
      manager.handleKeyboard('Delete', { ctrlKey: false, shiftKey: false, metaKey: false });

      assert.ok(emitStub.called);
      const callArgs = emitStub.getCall(0).args;
      assert.strictEqual(callArgs[0], 'plans:bulk:action');
      assert.strictEqual(callArgs[1].action, 'delete');
      assert.strictEqual(callArgs[1].selectedIds.length, 2);
    });
  });

  suite('selectAll / deselectAll', () => {
    test('selectAll selects all ordered IDs', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3', 'id4']);
      
      emitStub.resetHistory();
      manager.selectAll();

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 4);
      assert.strictEqual(manager.getSelectionCount(), 4);
      assert.ok(emitStub.called);
    });

    test('deselectAll clears selection', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.selectAll();
      
      emitStub.resetHistory();
      manager.deselectAll();

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 0);
      assert.strictEqual(manager.getSelectionCount(), 0);
      assert.ok(emitStub.called);
    });

    test('both emit selection changed', () => {
      manager.setOrderedIds(['id1', 'id2']);
      
      emitStub.resetHistory();
      manager.selectAll();
      assert.ok(emitStub.called);
      
      emitStub.resetHistory();
      manager.deselectAll();
      assert.ok(emitStub.called);
    });
  });

  suite('edge cases', () => {
    test('handles empty ordered IDs list', () => {
      manager.setOrderedIds([]);
      manager.handleClick('id1', { ctrlKey: false, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 0);
    });

    test('handles click on non-existent ID gracefully', () => {
      manager.setOrderedIds(['id1', 'id2']);
      manager.handleClick('nonexistent', { ctrlKey: false, shiftKey: false, metaKey: false });

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 0);
    });

    test('handles setOrderedIds with changed list', () => {
      manager.setOrderedIds(['id1', 'id2', 'id3']);
      manager.handleClick('id1', { ctrlKey: true, shiftKey: false, metaKey: false });
      manager.handleClick('id2', { ctrlKey: true, shiftKey: false, metaKey: false });
      
      // Remove id2 from list
      emitStub.resetHistory();
      manager.setOrderedIds(['id1', 'id3']);

      const selected = manager.getSelectedIds();
      assert.strictEqual(selected.length, 1);
      assert.ok(manager.isSelected('id1'));
      assert.ok(!manager.isSelected('id2'));
      assert.ok(emitStub.called, 'Should emit when selection pruned');
    });
  });
});
