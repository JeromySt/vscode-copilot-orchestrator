/**
 * @fileoverview Unit tests for StatusBadge control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { StatusBadge } from '../../../../../ui/webview/controls/statusBadge';

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

function makeEl(): any {
  const classes = new Set<string>();
  return {
    textContent: '',
    classList: {
      add(c: string) { classes.add(c); },
      remove(c: string) { classes.delete(c); },
      contains(c: string) { return classes.has(c); },
    },
    _classes: classes,
  };
}

suite('StatusBadge', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to NODE_STATE_CHANGE by default', () => {
    const badge = new StatusBadge(bus, 'sb', 'el');
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 1);
    badge.dispose();
  });

  test('subscribes to custom topic when provided', () => {
    const badge = new StatusBadge(bus, 'sb', 'el', Topics.PLAN_STATE_CHANGE);
    assert.strictEqual(bus.count(Topics.PLAN_STATE_CHANGE), 1);
    badge.dispose();
  });

  test('update with no data is a no-op', () => {
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update(undefined);
    assert.strictEqual(badge.getStatus(), '');
    badge.dispose();
  });

  test('update with empty status is a no-op', () => {
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update({ status: '' });
    assert.strictEqual(badge.getStatus(), '');
    badge.dispose();
  });

  test('update sets text and CSS class', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ el });
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update({ status: 'running' });

    assert.strictEqual(el.textContent, '▶ running');
    assert.ok(el._classes.has('running'));
    assert.strictEqual(badge.getStatus(), 'running');
    badge.dispose();
  });

  test('update replaces old status class', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ el });
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update({ status: 'running' });
    assert.ok(el._classes.has('running'));

    badge.update({ status: 'succeeded' });
    assert.ok(!el._classes.has('running'));
    assert.ok(el._classes.has('succeeded'));
    badge.dispose();
  });

  test('responds to bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ el });
    const badge = new StatusBadge(bus, 'sb', 'el');
    bus.emit(Topics.NODE_STATE_CHANGE, { status: 'failed' });

    assert.strictEqual(el.textContent, '✗ failed');
    assert.ok(el._classes.has('failed'));
    badge.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ el });
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('sb'), spy);

    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update({ status: 'running' });
    assert.strictEqual(spy.callCount, 1);
    badge.dispose();
  });

  test('handles unknown status gracefully', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ el });
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update({ status: 'unknown' });

    assert.strictEqual(el.textContent, ' unknown');
    assert.ok(el._classes.has('unknown'));
    badge.dispose();
  });

  test('each known status has correct icon', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ el });
    const badge = new StatusBadge(bus, 'sb', 'el');

    const expected: Record<string, string> = {
      pending: '○', running: '▶', succeeded: '✓', failed: '✗', paused: '⏸',
    };
    for (const [status, icon] of Object.entries(expected)) {
      badge.update({ status });
      assert.strictEqual(el.textContent, `${icon} ${status}`);
    }
    badge.dispose();
  });

  test('dispose unsubscribes from bus', () => {
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.dispose();
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 0);
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const badge = new StatusBadge(bus, 'sb', 'el');
    badge.update({ status: 'running' });
    assert.strictEqual(badge.getStatus(), 'running');
    badge.dispose();
  });
});
