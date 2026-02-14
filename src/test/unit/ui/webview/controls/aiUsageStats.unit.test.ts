/**
 * @fileoverview Unit tests for AiUsageStats control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { AiUsageStats } from '../../../../../ui/webview/controls/aiUsageStats';
import { formatTokenCount } from '../../../../../plan/metricsAggregator';

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
  return { innerHTML: '', style: { display: '' } };
}

suite('AiUsageStats', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  // ── formatTokenCount ───────────────────────────────────────────────────

  test('formatTokenCount: small number', () => {
    assert.strictEqual(formatTokenCount(500), '500');
  });

  test('formatTokenCount: thousands', () => {
    assert.strictEqual(formatTokenCount(1500), '1.5k');
  });

  test('formatTokenCount: millions', () => {
    assert.strictEqual(formatTokenCount(2500000), '2.5m');
  });

  test('formatTokenCount: exact thousand', () => {
    assert.strictEqual(formatTokenCount(1000), '1.0k');
  });

  // ── basic operations ───────────────────────────────────────────────────

  test('subscribes to AI_USAGE_UPDATE', () => {
    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    assert.strictEqual(bus.count(Topics.AI_USAGE_UPDATE), 1);
    aus.dispose();
  });

  test('update with no data is a no-op', () => {
    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update(undefined);
    aus.dispose();
  });

  test('update shows premium requests', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({ premiumRequests: 42 });

    assert.ok(el.innerHTML.includes('42 req'));
    assert.ok(el.innerHTML.includes('🎫'));
    aus.dispose();
  });

  test('update shows API time', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({ apiTimeSeconds: 125 });

    assert.ok(el.innerHTML.includes('2m 5s'));
    assert.ok(el.innerHTML.includes('⏱'));
    aus.dispose();
  });

  test('update shows session time', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({ sessionTimeSeconds: 3661 });

    assert.ok(el.innerHTML.includes('1h 1m 1s'));
    aus.dispose();
  });

  test('update shows model breakdown', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({
      modelBreakdown: [
        { model: 'gpt-4', inputTokens: 15000, outputTokens: 5000, cachedTokens: 2000, premiumRequests: 3 },
      ],
    });

    assert.ok(el.innerHTML.includes('gpt-4'));
    assert.ok(el.innerHTML.includes('15.0k'));
    assert.ok(el.innerHTML.includes('5.0k'));
    assert.ok(el.innerHTML.includes('2.0k cached'));
    assert.ok(el.innerHTML.includes('3 req'));
    aus.dispose();
  });

  test('update hides element when no data', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({});

    assert.strictEqual(el.style.display, 'none');
    aus.dispose();
  });

  test('responds to bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    bus.emit(Topics.AI_USAGE_UPDATE, { premiumRequests: 10 });

    assert.ok(el.innerHTML.includes('10 req'));
    aus.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('aus'), spy);

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({ premiumRequests: 1 });
    assert.strictEqual(spy.callCount, 1);
    aus.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({ premiumRequests: 5 });
    aus.dispose();
  });

  test('model breakdown without optional fields', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({
      modelBreakdown: [
        { model: 'claude', inputTokens: 100, outputTokens: 50 },
      ],
    });

    assert.ok(el.innerHTML.includes('claude'));
    assert.ok(!el.innerHTML.includes('cached'));
    assert.ok(!el.innerHTML.includes('req'));
    aus.dispose();
  });

  test('escapes model name HTML', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({
      modelBreakdown: [
        { model: '<b>bad</b>', inputTokens: 1, outputTokens: 1 },
      ],
    });

    assert.ok(!el.innerHTML.includes('<b>bad</b>'));
    assert.ok(el.innerHTML.includes('&lt;b&gt;'));
    aus.dispose();
  });

  test('short duration format', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ metrics: el });

    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.update({ apiTimeSeconds: 30 });

    assert.ok(el.innerHTML.includes('30s'));
    aus.dispose();
  });

  test('dispose unsubscribes', () => {
    const aus = new AiUsageStats(bus, 'aus', 'metrics');
    aus.dispose();
    assert.strictEqual(bus.count(Topics.AI_USAGE_UPDATE), 0);
  });
});
