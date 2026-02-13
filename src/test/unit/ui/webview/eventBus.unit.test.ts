/**
 * @fileoverview Unit tests for EventBus
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../ui/webview/eventBus';

suite('EventBus', () => {
  let bus: EventBus;

  setup(() => {
    bus = new EventBus();
  });

  // ── on / emit ──────────────────────────────────────────────────────────

  test('on() subscribes and emit() delivers data', () => {
    const spy = sinon.spy();
    bus.on('t', spy);
    bus.emit('t', 42);
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 42);
  });

  test('emit() with no subscribers is a no-op', () => {
    // Should not throw.
    bus.emit('nonexistent', 'data');
  });

  test('multiple handlers on the same topic all fire', () => {
    const a = sinon.spy();
    const b = sinon.spy();
    bus.on('t', a);
    bus.on('t', b);
    bus.emit('t');
    assert.strictEqual(a.callCount, 1);
    assert.strictEqual(b.callCount, 1);
  });

  test('handlers on different topics are independent', () => {
    const a = sinon.spy();
    const b = sinon.spy();
    bus.on('x', a);
    bus.on('y', b);
    bus.emit('x');
    assert.strictEqual(a.callCount, 1);
    assert.strictEqual(b.callCount, 0);
  });

  test('emit() calls handlers synchronously', () => {
    const order: number[] = [];
    bus.on('t', () => order.push(1));
    order.push(0);
    bus.emit('t');
    order.push(2);
    assert.deepStrictEqual(order, [0, 1, 2]);
  });

  test('emit() without data passes undefined', () => {
    const spy = sinon.spy();
    bus.on('t', spy);
    bus.emit('t');
    assert.strictEqual(spy.firstCall.args[0], undefined);
  });

  // ── once ───────────────────────────────────────────────────────────────

  test('once() fires handler exactly once', () => {
    const spy = sinon.spy();
    bus.once('t', spy);
    bus.emit('t', 'a');
    bus.emit('t', 'b');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 'a');
  });

  test('once() subscription reports isActive correctly', () => {
    const sub = bus.once('t', () => {});
    assert.strictEqual(sub.isActive, true);
    bus.emit('t');
    assert.strictEqual(sub.isActive, false);
  });

  // ── unsubscribe ────────────────────────────────────────────────────────

  test('unsubscribe() prevents further calls', () => {
    const spy = sinon.spy();
    const sub = bus.on('t', spy);
    sub.unsubscribe();
    bus.emit('t');
    assert.strictEqual(spy.callCount, 0);
  });

  test('unsubscribe() is idempotent', () => {
    const sub = bus.on('t', () => {});
    sub.unsubscribe();
    sub.unsubscribe(); // should not throw
    assert.strictEqual(sub.isActive, false);
  });

  test('unsubscribing during emit is safe (snapshot iteration)', () => {
    const spy = sinon.spy();
    let sub2: ReturnType<typeof bus.on>;
    bus.on('t', () => {
      sub2!.unsubscribe();
    });
    sub2 = bus.on('t', spy);
    bus.emit('t');
    // spy still fires because emit iterates a snapshot
    assert.strictEqual(spy.callCount, 1);
  });

  // ── Subscription metadata ─────────────────────────────────────────────

  test('subscription exposes topic', () => {
    const sub = bus.on('my:topic', () => {});
    assert.strictEqual(sub.topic, 'my:topic');
  });

  test('subscription isActive reflects state', () => {
    const sub = bus.on('t', () => {});
    assert.strictEqual(sub.isActive, true);
    sub.unsubscribe();
    assert.strictEqual(sub.isActive, false);
  });

  // ── clear ──────────────────────────────────────────────────────────────

  test('clear(topic) removes only that topic', () => {
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.clear('a');
    assert.strictEqual(bus.count('a'), 0);
    assert.strictEqual(bus.count('b'), 1);
  });

  test('clear() removes all topics', () => {
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.clear();
    assert.strictEqual(bus.count(), 0);
  });

  // ── count ──────────────────────────────────────────────────────────────

  test('count(topic) returns handler count for a topic', () => {
    bus.on('t', () => {});
    bus.on('t', () => {});
    assert.strictEqual(bus.count('t'), 2);
  });

  test('count() returns total across all topics', () => {
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.on('b', () => {});
    assert.strictEqual(bus.count(), 3);
  });

  test('count() returns 0 for unknown topic', () => {
    assert.strictEqual(bus.count('nope'), 0);
  });

  test('count() returns 0 when bus is empty', () => {
    assert.strictEqual(bus.count(), 0);
  });

  // ── cleanup on last unsubscribe ────────────────────────────────────────

  test('unsubscribing last handler removes topic from internal map', () => {
    const sub = bus.on('t', () => {});
    sub.unsubscribe();
    assert.strictEqual(bus.count('t'), 0);
    // Verify emit still works (no stale set).
    bus.emit('t');
  });
});
