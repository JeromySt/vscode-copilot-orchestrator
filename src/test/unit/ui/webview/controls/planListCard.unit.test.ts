/**
 * @fileoverview Unit tests for PlanListCard control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { PlanListCard } from '../../../../../ui/webview/controls/planListCard';

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
  return { innerHTML: '', className: '' };
}

suite('PlanListCard', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to PLAN_STATE_CHANGE', () => {
    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    assert.strictEqual(bus.count(Topics.PLAN_STATE_CHANGE), 1);
    plc.dispose();
  });

  test('ignores updates for different planId', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    bus.emit(Topics.PLAN_STATE_CHANGE, {
      planId: 'plan-2', planName: 'Other', status: 'running',
      progress: 50, totalNodes: 10, succeededNodes: 5, failedNodes: 0, runningNodes: 3,
    });

    assert.strictEqual(el.innerHTML, '');
    plc.dispose();
  });

  test('update with no data is safe', () => {
    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update(undefined);
    plc.dispose();
  });

  test('update renders plan card content', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'My Plan', status: 'running',
      progress: 60, totalNodes: 8, succeededNodes: 4, failedNodes: 1, runningNodes: 2,
    });

    assert.ok(el.innerHTML.includes('My Plan'));
    assert.ok(el.innerHTML.includes('running'));
    assert.ok(el.innerHTML.includes('▶'));
    assert.ok(el.innerHTML.includes('60%'));
    assert.ok(el.innerHTML.includes('8 nodes'));
    assert.ok(el.innerHTML.includes('✓4'));
    assert.ok(el.innerHTML.includes('✗1'));
    assert.ok(el.innerHTML.includes('▶2'));
    assert.strictEqual(el.className, 'plan-list-card running');
    plc.dispose();
  });

  test('update with succeeded status shows check icon', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'Done', status: 'succeeded',
      progress: 100, totalNodes: 3, succeededNodes: 3, failedNodes: 0, runningNodes: 0,
    });

    assert.ok(el.innerHTML.includes('✓'));
    assert.strictEqual(el.className, 'plan-list-card succeeded');
    plc.dispose();
  });

  test('update with failed status shows cross icon', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'Broken', status: 'failed',
      progress: 30, totalNodes: 5, succeededNodes: 1, failedNodes: 2, runningNodes: 0,
    });

    assert.ok(el.innerHTML.includes('✗'));
    assert.strictEqual(el.className, 'plan-list-card failed');
    plc.dispose();
  });

  test('clamps progress to 0-100', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'Test', status: 'running',
      progress: 150, totalNodes: 1, succeededNodes: 0, failedNodes: 0, runningNodes: 1,
    });

    assert.ok(el.innerHTML.includes('100%'));
    plc.dispose();
  });

  test('responds to matching bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    bus.emit(Topics.PLAN_STATE_CHANGE, {
      planId: 'plan-1', planName: 'Bus Plan', status: 'pending',
      progress: 0, totalNodes: 2, succeededNodes: 0, failedNodes: 0, runningNodes: 0,
    });

    assert.ok(el.innerHTML.includes('Bus Plan'));
    plc.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('plc'), spy);

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'Test', status: 'running',
      progress: 50, totalNodes: 1, succeededNodes: 0, failedNodes: 0, runningNodes: 1,
    });
    assert.strictEqual(spy.callCount, 1);
    plc.dispose();
  });

  test('escapes HTML in plan name', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: '<script>evil</script>', status: 'running',
      progress: 0, totalNodes: 1, succeededNodes: 0, failedNodes: 0, runningNodes: 0,
    });

    assert.ok(!el.innerHTML.includes('<script>evil'));
    assert.ok(el.innerHTML.includes('&lt;script&gt;'));
    plc.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'Test', status: 'running',
      progress: 50, totalNodes: 1, succeededNodes: 0, failedNodes: 0, runningNodes: 1,
    });
    plc.dispose();
  });

  test('dispose unsubscribes', () => {
    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.dispose();
    assert.strictEqual(bus.count(Topics.PLAN_STATE_CHANGE), 0);
  });

  test('unknown status uses default icon', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ card: el });

    const plc = new PlanListCard(bus, 'plc', 'card', 'plan-1');
    plc.update({
      planId: 'plan-1', planName: 'Test', status: 'weird',
      progress: 0, totalNodes: 1, succeededNodes: 0, failedNodes: 0, runningNodes: 0,
    });

    assert.ok(el.innerHTML.includes('○'));
    plc.dispose();
  });
});
