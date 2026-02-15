/**
 * @fileoverview Unit tests for DurationCounter control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { DurationCounter } from '../../../../../ui/webview/controls/durationCounter';
import { formatDurationMs } from '../../../../../ui/templates/helpers';

// ── Minimal DOM mock ─────────────────────────────────────────────────────

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

suite('DurationCounter', () => {
  let bus: EventBus;
  let clock: sinon.SinonFakeTimers;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
    clock = sinon.useFakeTimers({ now: 1000000 });
  });

  teardown(() => {
    clock.restore();
    if (restoreDoc) { restoreDoc(); }
  });

  // ── formatDurationMs (replacement for formatElapsed) ──────────────────

  test('formatDurationMs: 0 ms → "< 1s"', () => {
    assert.strictEqual(formatDurationMs(0), '< 1s');
  });

  test('formatDurationMs: negative → "< 1s"', () => {
    assert.strictEqual(formatDurationMs(-1000), '< 1s');
  });

  test('formatDurationMs: 30000 ms → "30s"', () => {
    assert.strictEqual(formatDurationMs(30000), '30s');
  });

  test('formatDurationMs: 90000 ms → "1m 30s"', () => {
    assert.strictEqual(formatDurationMs(90000), '1m 30s');
  });

  test('formatDurationMs: 3661000 ms → "1h 1m" (seconds dropped at hour level)', () => {
    assert.strictEqual(formatDurationMs(3661000), '1h 1m');
  });

  test('formatDurationMs: exact minutes → shows "2m 0s"', () => {
    assert.strictEqual(formatDurationMs(120000), '2m 0s');
  });

  test('formatDurationMs: exact hours → shows "2h 0m"', () => {
    assert.strictEqual(formatDurationMs(7200000), '2h 0m');
  });

  // ── basic update ───────────────────────────────────────────────────────

  test('update with no data is a no-op', () => {
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update(undefined);
    dc.dispose();
  });

  test('update with running=false unsubscribes from PULSE', () => {
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: false, startedAt: undefined });
    assert.strictEqual(bus.count(Topics.PULSE), 0);
    dc.dispose();
  });

  test('update with running=true subscribes to PULSE', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: 1000000 });
    assert.strictEqual(bus.count(Topics.PULSE), 1);
    dc.dispose();
  });

  test('update sets element text to formatted duration', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const dc = new DurationCounter(bus, 'dc', 'el');

    clock.tick(5000); // now = 1005000
    dc.update({ running: true, startedAt: 1000000 });
    assert.strictEqual(el.textContent, '5s');
    dc.dispose();
  });

  test('update with no startedAt sets "--"', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: undefined });
    assert.strictEqual(el.textContent, '--');
    dc.dispose();
  });

  // ── PULSE subscription ─────────────────────────────────────────────────

  test('PULSE tick updates element', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: 1000000 });

    clock.tick(10000);
    bus.emit(Topics.PULSE);
    assert.strictEqual(el.textContent, '10s');
    dc.dispose();
  });

  test('stopping running removes PULSE subscription', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: 1000000 });
    assert.strictEqual(bus.count(Topics.PULSE), 1);

    dc.update({ running: false, startedAt: 1000000 });
    assert.strictEqual(bus.count(Topics.PULSE), 0);
    dc.dispose();
  });

  // ── publishUpdate ──────────────────────────────────────────────────────

  test('publishes control update on tick', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('dc'), spy);

    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: 1000000 });
    assert.strictEqual(spy.callCount, 1);
    dc.dispose();
  });

  // ── dispose ────────────────────────────────────────────────────────────

  test('dispose removes PULSE subscription', () => {
    const el = { textContent: '' };
    restoreDoc = mockDocument({ el });
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: 1000000 });
    assert.strictEqual(bus.count(Topics.PULSE), 1);

    dc.dispose();
    assert.strictEqual(bus.count(Topics.PULSE), 0);
  });

  test('dispose is idempotent', () => {
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.dispose();
    dc.dispose();
    assert.strictEqual(dc.isDisposed, true);
  });

  // ── no element ─────────────────────────────────────────────────────────

  test('tick with missing element is a no-op', () => {
    restoreDoc = mockDocument({});
    const dc = new DurationCounter(bus, 'dc', 'el');
    dc.update({ running: true, startedAt: 1000000 });
    bus.emit(Topics.PULSE);
    dc.dispose();
  });
});
