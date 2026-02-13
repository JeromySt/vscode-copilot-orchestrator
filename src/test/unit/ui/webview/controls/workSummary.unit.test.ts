/**
 * @fileoverview Unit tests for WorkSummary control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { WorkSummary } from '../../../../../ui/webview/controls/workSummary';

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

suite('WorkSummary', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to WORK_SUMMARY', () => {
    const ws = new WorkSummary(bus, 'ws', 'summary');
    assert.strictEqual(bus.count(Topics.WORK_SUMMARY), 1);
    ws.dispose();
  });

  test('update with no data is a no-op', () => {
    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update(undefined);
    ws.dispose();
  });

  test('update renders commit and file counts', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 5, filesAdded: 3, filesModified: 2, filesDeleted: 1 });

    assert.ok(el.innerHTML.includes('5'));
    assert.ok(el.innerHTML.includes('+3'));
    assert.ok(el.innerHTML.includes('~2'));
    assert.ok(el.innerHTML.includes('-1'));
    assert.strictEqual(el.style.display, '');
    ws.dispose();
  });

  test('hides when all counts are zero', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 0, filesAdded: 0, filesModified: 0, filesDeleted: 0 });

    assert.strictEqual(el.style.display, 'none');
    ws.dispose();
  });

  test('shows when any count is non-zero', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 0, filesAdded: 1, filesModified: 0, filesDeleted: 0 });

    assert.strictEqual(el.style.display, '');
    assert.ok(el.innerHTML.includes('+1'));
    ws.dispose();
  });

  test('responds to bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const ws = new WorkSummary(bus, 'ws', 'summary');
    bus.emit(Topics.WORK_SUMMARY, { totalCommits: 1, filesAdded: 0, filesModified: 0, filesDeleted: 0 });

    assert.ok(el.innerHTML.includes('1'));
    ws.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('ws'), spy);

    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 1, filesAdded: 0, filesModified: 0, filesDeleted: 0 });
    assert.strictEqual(spy.callCount, 1);
    ws.dispose();
  });

  test('publishes update even when hiding', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('ws'), spy);

    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 0, filesAdded: 0, filesModified: 0, filesDeleted: 0 });
    assert.strictEqual(spy.callCount, 1);
    ws.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 1, filesAdded: 0, filesModified: 0, filesDeleted: 0 });
    ws.dispose();
  });

  test('dispose unsubscribes', () => {
    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.dispose();
    assert.strictEqual(bus.count(Topics.WORK_SUMMARY), 0);
  });

  test('renders correct CSS classes', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ summary: el });

    const ws = new WorkSummary(bus, 'ws', 'summary');
    ws.update({ totalCommits: 1, filesAdded: 1, filesModified: 1, filesDeleted: 1 });

    assert.ok(el.innerHTML.includes('work-summary-grid'));
    assert.ok(el.innerHTML.includes('work-stat'));
    assert.ok(el.innerHTML.includes('added'));
    assert.ok(el.innerHTML.includes('modified'));
    assert.ok(el.innerHTML.includes('deleted'));
    ws.dispose();
  });
});
