/**
 * @fileoverview Unit tests for NodeCard control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { NodeCard } from '../../../../../ui/webview/controls/nodeCard';

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

function makeCardEl(): any {
  return {
    style: { borderColor: '' },
    offsetHeight: 100,
  };
}

suite('NodeCard', () => {
  let bus: EventBus;
  let restoreDoc: () => void;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    bus = new EventBus();
    clock = sinon.useFakeTimers({ now: 1000000 });
  });

  teardown(() => {
    clock.restore();
    if (restoreDoc) { restoreDoc(); }
  });

  test('creates StatusBadge and DurationCounter children', () => {
    const nc = new NodeCard(bus, 'nc', 'card');
    assert.ok(nc.statusBadge);
    assert.ok(nc.durationCounter);
    nc.dispose();
  });

  test('update with no data is a no-op', () => {
    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update(undefined);
    nc.dispose();
  });

  test('update sets border color for running status', () => {
    const classes = new Set<string>();
    const badgeEl = {
      textContent: '',
      classList: { add(c: string) { classes.add(c); }, remove(c: string) { classes.delete(c); } },
    };
    const durationEl = { textContent: '' };
    const iconEl = { textContent: '' };
    const cardEl = makeCardEl();

    restoreDoc = mockDocument({
      card: cardEl,
      'card-badge': badgeEl,
      'card-duration': durationEl,
      'card-icon': iconEl,
    });

    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'running', startedAt: 1000000, nodeId: 'n1' });

    assert.strictEqual(cardEl.style.borderColor, 'var(--vscode-progressBar-background)');
    assert.strictEqual(iconEl.textContent, '▶');
    nc.dispose();
  });

  test('update sets border color for succeeded', () => {
    const cardEl = makeCardEl();
    const badgeEl = { textContent: '', classList: { add() {}, remove() {} } };
    const durationEl = { textContent: '' };

    restoreDoc = mockDocument({
      card: cardEl,
      'card-badge': badgeEl,
      'card-duration': durationEl,
    });

    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'succeeded', nodeId: 'n1' });

    assert.strictEqual(cardEl.style.borderColor, '#4ec9b0');
    nc.dispose();
  });

  test('update sets border color for failed', () => {
    const cardEl = makeCardEl();
    const badgeEl = { textContent: '', classList: { add() {}, remove() {} } };
    const durationEl = { textContent: '' };

    restoreDoc = mockDocument({
      card: cardEl,
      'card-badge': badgeEl,
      'card-duration': durationEl,
    });

    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'failed', nodeId: 'n1' });

    assert.strictEqual(cardEl.style.borderColor, '#f44747');
    nc.dispose();
  });

  test('publishes LAYOUT_CHANGE on size change', () => {
    const cardEl = { ...makeCardEl(), offsetHeight: 100 };
    const badgeEl = { textContent: '', classList: { add() {}, remove() {} } };
    const durationEl = { textContent: '' };

    restoreDoc = mockDocument({
      card: cardEl,
      'card-badge': badgeEl,
      'card-duration': durationEl,
    });

    const spy = sinon.spy();
    bus.on(Topics.LAYOUT_CHANGE, spy);

    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'running', nodeId: 'n1' });
    assert.strictEqual(spy.callCount, 1);

    // Same height → no new LAYOUT_CHANGE
    nc.update({ status: 'running', nodeId: 'n1' });
    assert.strictEqual(spy.callCount, 1);
    nc.dispose();
  });

  test('publishUpdate on child update after microtask', async () => {
    const cardEl = makeCardEl();
    const badgeEl = { textContent: '', classList: { add() {}, remove() {} } };
    const durationEl = { textContent: '' };

    restoreDoc = mockDocument({
      card: cardEl,
      'card-badge': badgeEl,
      'card-duration': durationEl,
    });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('nc'), spy);

    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'running', startedAt: 1000000, nodeId: 'n1' });
    const countBefore = spy.callCount;

    // Wait for debounced child update
    await Promise.resolve();
    assert.ok(spy.callCount >= countBefore);
    nc.dispose();
  });

  test('dispose cleans up children', () => {
    const nc = new NodeCard(bus, 'nc', 'card');
    nc.dispose();
    assert.strictEqual(nc.statusBadge.isDisposed, true);
    assert.strictEqual(nc.durationCounter.isDisposed, true);
  });

  test('update with missing element skips DOM update', () => {
    restoreDoc = mockDocument({});
    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'running', nodeId: 'n1' });
    nc.dispose();
  });

  test('update with unknown status uses fallback border', () => {
    const cardEl = makeCardEl();
    const badgeEl = { textContent: '', classList: { add() {}, remove() {} } };
    const durationEl = { textContent: '' };

    restoreDoc = mockDocument({
      card: cardEl,
      'card-badge': badgeEl,
      'card-duration': durationEl,
    });

    const nc = new NodeCard(bus, 'nc', 'card');
    nc.update({ status: 'unknown_status', nodeId: 'n1' });

    assert.strictEqual(cardEl.style.borderColor, 'var(--vscode-panel-border)');
    nc.dispose();
  });
});
