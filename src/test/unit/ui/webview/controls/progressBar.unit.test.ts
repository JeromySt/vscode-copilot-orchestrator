/**
 * @fileoverview Unit tests for ProgressBar control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { ProgressBar } from '../../../../../ui/webview/controls/progressBar';

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
  return { className: '', style: { width: '' } };
}

suite('ProgressBar', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to PLAN_STATE_CHANGE', () => {
    const pb = new ProgressBar(bus, 'pb', 'fill');
    assert.strictEqual(bus.count(Topics.PLAN_STATE_CHANGE), 1);
    pb.dispose();
  });

  test('update with no data is a no-op', () => {
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update(undefined);
    pb.dispose();
  });

  test('update sets width percentage', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update({ progress: 75, status: 'running' });

    assert.strictEqual(el.style.width, '75%');
    pb.dispose();
  });

  test('clamps progress to 0-100', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const pb = new ProgressBar(bus, 'pb', 'fill');

    pb.update({ progress: -10, status: 'running' });
    assert.strictEqual(el.style.width, '0%');

    pb.update({ progress: 150, status: 'running' });
    assert.strictEqual(el.style.width, '100%');
    pb.dispose();
  });

  test('status=failed sets failed class', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update({ progress: 50, status: 'failed' });

    assert.strictEqual(el.className, 'progress-fill failed');
    pb.dispose();
  });

  test('status=succeeded sets succeeded class', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update({ progress: 100, status: 'succeeded' });

    assert.strictEqual(el.className, 'progress-fill succeeded');
    pb.dispose();
  });

  test('status=running has no extra class', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update({ progress: 50, status: 'running' });

    assert.strictEqual(el.className, 'progress-fill');
    pb.dispose();
  });

  test('responds to bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const pb = new ProgressBar(bus, 'pb', 'fill');
    bus.emit(Topics.PLAN_STATE_CHANGE, { progress: 60, status: 'running' });

    assert.strictEqual(el.style.width, '60%');
    pb.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ fill: el });
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('pb'), spy);

    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update({ progress: 50, status: 'running' });
    assert.strictEqual(spy.callCount, 1);
    pb.dispose();
  });

  test('dispose unsubscribes', () => {
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.dispose();
    assert.strictEqual(bus.count(Topics.PLAN_STATE_CHANGE), 0);
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const pb = new ProgressBar(bus, 'pb', 'fill');
    pb.update({ progress: 50, status: 'running' });
    pb.dispose();
  });
});
