/**
 * @fileoverview Unit tests for GroupContainer control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { GroupContainer, aggregateStatus } from '../../../../../ui/webview/controls/groupContainer';

function mockDocument(elements: Record<string, any> = {}): () => void {
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    getElementById(id: string) { return elements[id] || null; },
  };
  return () => {
    if (prev === undefined) { delete (globalThis as any).document; }
    else { (globalThis as any).document = prev; }
  };
}

suite('GroupContainer', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  // ── aggregateStatus ────────────────────────────────────────────────────

  test('aggregateStatus: empty → "pending"', () => {
    assert.strictEqual(aggregateStatus({}), 'pending');
  });

  test('aggregateStatus: all succeeded → "succeeded"', () => {
    assert.strictEqual(aggregateStatus({ a: 'succeeded', b: 'succeeded' }), 'succeeded');
  });

  test('aggregateStatus: any failed → "failed"', () => {
    assert.strictEqual(aggregateStatus({ a: 'succeeded', b: 'failed' }), 'failed');
  });

  test('aggregateStatus: any running → "running"', () => {
    assert.strictEqual(aggregateStatus({ a: 'succeeded', b: 'running' }), 'running');
  });

  test('aggregateStatus: failed wins over running', () => {
    assert.strictEqual(aggregateStatus({ a: 'running', b: 'failed' }), 'failed');
  });

  test('aggregateStatus: pending only → "pending"', () => {
    assert.strictEqual(aggregateStatus({ a: 'pending', b: 'pending' }), 'pending');
  });

  test('aggregateStatus: mixed pending/scheduled → "scheduled"', () => {
    assert.strictEqual(aggregateStatus({ a: 'pending', b: 'scheduled' }), 'scheduled');
  });

  // ── basic operations ───────────────────────────────────────────────────

  test('initial status is pending', () => {
    const gc = new GroupContainer(bus, 'gc', 'el');
    assert.strictEqual(gc.getStatus(), 'pending');
    gc.dispose();
  });

  test('addChild registers subscription', () => {
    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.addChild('child-a');
    // subscribeToChild creates a subscription on control:child-a:updated
    assert.strictEqual(bus.count(Topics.controlUpdate('child-a')), 1);
    gc.dispose();
  });

  test('update sets child statuses and recalculates', () => {
    const el = { setAttribute: sinon.spy() };
    restoreDoc = mockDocument({ el });

    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.update({ childStatuses: { a: 'running', b: 'succeeded' } });

    assert.strictEqual(gc.getStatus(), 'running');
    assert.ok(el.setAttribute.calledWith('data-status', 'running'));
    gc.dispose();
  });

  test('update with no data is a no-op', () => {
    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.update(undefined);
    assert.strictEqual(gc.getStatus(), 'pending');
    gc.dispose();
  });

  test('setChildStatus updates individual child', () => {
    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.addChild('a', 'pending');
    gc.addChild('b', 'pending');
    gc.setChildStatus('a', 'succeeded');
    assert.strictEqual(gc.getStatus(), 'pending'); // Not recalculated yet
    gc.dispose();
  });

  test('child update triggers recalculation via microtask', async () => {
    const el = { setAttribute: sinon.spy() };
    restoreDoc = mockDocument({ el });

    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.addChild('child-a', 'pending');
    gc.setChildStatus('child-a', 'succeeded');

    bus.emit(Topics.controlUpdate('child-a'));
    await Promise.resolve();

    assert.strictEqual(gc.getStatus(), 'succeeded');
    gc.dispose();
  });

  test('publishes control update on recalculate', () => {
    const el = { setAttribute: sinon.spy() };
    restoreDoc = mockDocument({ el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('gc'), spy);

    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.update({ childStatuses: { a: 'succeeded' } });
    assert.strictEqual(spy.callCount, 1);
    gc.dispose();
  });

  test('debounces multiple child updates', async () => {
    const el = { setAttribute: sinon.spy() };
    restoreDoc = mockDocument({ el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('gc'), spy);

    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.addChild('a');
    gc.addChild('b');

    bus.emit(Topics.controlUpdate('a'));
    bus.emit(Topics.controlUpdate('b'));
    assert.strictEqual(spy.callCount, 0);

    await Promise.resolve();
    assert.strictEqual(spy.callCount, 1);
    gc.dispose();
  });

  test('dispose unsubscribes all', () => {
    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.addChild('a');
    gc.addChild('b');
    gc.dispose();
    assert.strictEqual(bus.count(), 0);
  });

  test('recalculate with missing element still updates status', () => {
    restoreDoc = mockDocument({});
    const gc = new GroupContainer(bus, 'gc', 'el');
    gc.update({ childStatuses: { a: 'failed' } });
    assert.strictEqual(gc.getStatus(), 'failed');
    gc.dispose();
  });
});
