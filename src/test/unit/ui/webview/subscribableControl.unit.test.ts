/**
 * @fileoverview Unit tests for SubscribableControl
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../ui/webview/eventBus';
import { SubscribableControl } from '../../../../ui/webview/subscribableControl';
import { Topics } from '../../../../ui/webview/topics';

// ── Concrete test doubles ────────────────────────────────────────────────

class LeafControl extends SubscribableControl {
  updated = false;

  update(data?: any): void {
    this.updated = true;
    this.publishUpdate(data);
  }

  /** Expose protected for testing. */
  doSubscribe(topic: string, handler: (d?: any) => void) {
    return this.subscribe(topic, handler);
  }

  doPublishUpdate(data?: any) {
    this.publishUpdate(data);
  }

  doGetElement(id: string) {
    return this.getElement(id);
  }

  doUnsubscribeAll() {
    this.unsubscribeAll();
  }
}

class ParentControl extends SubscribableControl {
  recalcCount = 0;

  update(): void {
    // no-op for this stub
  }

  watchChild(childId: string) {
    return this.subscribeToChild(childId, () => {
      this.recalcCount++;
      this.publishUpdate();
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

suite('SubscribableControl', () => {
  let bus: EventBus;

  setup(() => {
    bus = new EventBus();
  });

  // ── basics ─────────────────────────────────────────────────────────────

  test('publishUpdate emits on control topic', () => {
    const leaf = new LeafControl(bus, 'leaf-1');
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('leaf-1'), spy);
    leaf.doPublishUpdate('hello');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 'hello');
    leaf.dispose();
  });

  test('subscribe() registers on bus and delivers data', () => {
    const leaf = new LeafControl(bus, 'c');
    const spy = sinon.spy();
    leaf.doSubscribe('custom:topic', spy);
    bus.emit('custom:topic', 99);
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 99);
    leaf.dispose();
  });

  test('unsubscribeAll() removes all subscriptions', () => {
    const leaf = new LeafControl(bus, 'c');
    leaf.doSubscribe('a', () => {});
    leaf.doSubscribe('b', () => {});
    assert.strictEqual(bus.count(), 2);
    leaf.doUnsubscribeAll();
    assert.strictEqual(bus.count(), 0);
  });

  // ── dispose ────────────────────────────────────────────────────────────

  test('dispose sets isDisposed and removes subs', () => {
    const leaf = new LeafControl(bus, 'c');
    leaf.doSubscribe('t', () => {});
    assert.strictEqual(leaf.isDisposed, false);
    leaf.dispose();
    assert.strictEqual(leaf.isDisposed, true);
    assert.strictEqual(bus.count(), 0);
  });

  test('dispose is idempotent', () => {
    const leaf = new LeafControl(bus, 'c');
    leaf.dispose();
    leaf.dispose();
    assert.strictEqual(leaf.isDisposed, true);
  });

  // ── getElement fallback ────────────────────────────────────────────────

  test('getElement returns null when document is undefined', () => {
    const leaf = new LeafControl(bus, 'c');
    // Node.js has no global document, so should return null.
    assert.strictEqual(leaf.doGetElement('foo'), null);
    leaf.dispose();
  });

  // ── update abstract method ─────────────────────────────────────────────

  test('update() is callable on concrete subclass', () => {
    const leaf = new LeafControl(bus, 'c');
    leaf.update('data');
    assert.strictEqual(leaf.updated, true);
    leaf.dispose();
  });

  // ── subscribeToChild: microtask debounce ───────────────────────────────

  test('subscribeToChild fires handler after microtask', async () => {
    const parent = new ParentControl(bus, 'parent');
    const child = new LeafControl(bus, 'child-a');
    parent.watchChild('child-a');

    child.doPublishUpdate();
    // Handler should NOT have fired synchronously.
    assert.strictEqual(parent.recalcCount, 0);

    // Wait one microtask.
    await Promise.resolve();
    assert.strictEqual(parent.recalcCount, 1);

    parent.dispose();
    child.dispose();
  });

  test('multiple sibling updates coalesce into one parent recalc', async () => {
    const parent = new ParentControl(bus, 'parent');
    const childA = new LeafControl(bus, 'child-a');
    const childB = new LeafControl(bus, 'child-b');

    parent.watchChild('child-a');
    parent.watchChild('child-b');

    // Both siblings fire synchronously.
    childA.doPublishUpdate();
    childB.doPublishUpdate();

    assert.strictEqual(parent.recalcCount, 0);
    await Promise.resolve();
    // Parent recalculates only once.
    assert.strictEqual(parent.recalcCount, 1);

    parent.dispose();
    childA.dispose();
    childB.dispose();
  });

  test('subscribeToChild does not fire after dispose', async () => {
    const parent = new ParentControl(bus, 'parent');
    const child = new LeafControl(bus, 'child');
    parent.watchChild('child');

    child.doPublishUpdate();
    parent.dispose();
    await Promise.resolve();
    // Handler must NOT fire after dispose.
    assert.strictEqual(parent.recalcCount, 0);
  });

  // ── inner-out cascade ──────────────────────────────────────────────────

  test('inner-out cascade: leaf → parent → grandparent', async () => {
    const gp = new ParentControl(bus, 'gp');
    const parent = new ParentControl(bus, 'parent');
    const leaf = new LeafControl(bus, 'leaf');

    parent.watchChild('leaf');
    gp.watchChild('parent');

    // Leaf publishes.
    leaf.doPublishUpdate();
    assert.strictEqual(parent.recalcCount, 0);
    assert.strictEqual(gp.recalcCount, 0);

    // After one microtask: parent fires.
    await Promise.resolve();
    assert.strictEqual(parent.recalcCount, 1);
    // Grandparent may still be pending.
    assert.strictEqual(gp.recalcCount, 0);

    // After a second microtask: grandparent fires.
    await Promise.resolve();
    assert.strictEqual(gp.recalcCount, 1);

    gp.dispose();
    parent.dispose();
    leaf.dispose();
  });

  test('sibling debounce in cascade: two leaves → one parent recalc', async () => {
    const parent = new ParentControl(bus, 'parent');
    const leafA = new LeafControl(bus, 'la');
    const leafB = new LeafControl(bus, 'lb');

    parent.watchChild('la');
    parent.watchChild('lb');

    leafA.doPublishUpdate();
    leafB.doPublishUpdate();

    await Promise.resolve();
    assert.strictEqual(parent.recalcCount, 1);

    parent.dispose();
    leafA.dispose();
    leafB.dispose();
  });

  test('separate microtasks produce separate parent recalcs', async () => {
    const parent = new ParentControl(bus, 'parent');
    const child = new LeafControl(bus, 'child');

    parent.watchChild('child');

    child.doPublishUpdate();
    await Promise.resolve();
    assert.strictEqual(parent.recalcCount, 1);

    child.doPublishUpdate();
    await Promise.resolve();
    assert.strictEqual(parent.recalcCount, 2);

    parent.dispose();
    child.dispose();
  });
});
