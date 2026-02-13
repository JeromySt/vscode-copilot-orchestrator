/**
 * @fileoverview Unit tests for ProcessTree control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { ProcessTree } from '../../../../../ui/webview/controls/processTree';

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
  return { innerHTML: '', textContent: '' };
}

suite('ProcessTree', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to PROCESS_STATS', () => {
    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    assert.strictEqual(bus.count(Topics.PROCESS_STATS), 1);
    pt.dispose();
  });

  test('update with no data is a no-op', () => {
    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update(undefined);
    pt.dispose();
  });

  test('shows agent starting indicator', () => {
    const treeEl = makeEl();
    const titleEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl, title: titleEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({ running: true, isAgentWork: true, duration: 5000 });

    assert.ok(treeEl.innerHTML.includes('Agent starting'));
    assert.ok(treeEl.innerHTML.includes('5s'));
    pt.dispose();
  });

  test('shows no active process when not running', () => {
    const treeEl = makeEl();
    const titleEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl, title: titleEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({ running: false });

    assert.ok(treeEl.innerHTML.includes('No active process'));
    assert.strictEqual(titleEl.textContent, 'Processes');
    pt.dispose();
  });

  test('shows PID when running with empty tree', () => {
    const treeEl = makeEl();
    const titleEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl, title: titleEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({ running: true, pid: 1234, tree: [] });

    assert.ok(treeEl.innerHTML.includes('PID 1234'));
    pt.dispose();
  });

  test('renders process tree with children', () => {
    const treeEl = makeEl();
    const titleEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl, title: titleEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({
      running: true,
      pid: 100,
      tree: [{
        pid: 100, name: 'node', cpu: 50, memory: 1048576,
        children: [{ pid: 101, name: 'child', cpu: 10, memory: 524288 }],
      }],
    });

    assert.ok(treeEl.innerHTML.includes('node'));
    assert.ok(treeEl.innerHTML.includes('child'));
    assert.ok(treeEl.innerHTML.includes('↳'));
    assert.ok(titleEl.textContent.includes('2'));
    pt.dispose();
  });

  test('responds to bus events', () => {
    const treeEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    bus.emit(Topics.PROCESS_STATS, { running: false });
    assert.ok(treeEl.innerHTML.includes('No active process'));
    pt.dispose();
  });

  test('publishes control update', () => {
    const treeEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('pt'), spy);

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({ running: false });
    assert.strictEqual(spy.callCount, 1);
    pt.dispose();
  });

  test('update with missing tree element is safe', () => {
    restoreDoc = mockDocument({});
    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({ running: true, pid: 100, tree: [] });
    pt.dispose();
  });

  test('agent starting without duration', () => {
    const treeEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({ running: true, isAgentWork: true });
    assert.ok(treeEl.innerHTML.includes('Agent starting'));
    assert.ok(!treeEl.innerHTML.includes('undefined'));
    pt.dispose();
  });

  test('escapes HTML in process names', () => {
    const treeEl = makeEl();
    const titleEl = makeEl();
    restoreDoc = mockDocument({ tree: treeEl, title: titleEl });

    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.update({
      running: true,
      pid: 1,
      tree: [{ pid: 1, name: '<script>alert(1)</script>', cpu: 0, memory: 0 }],
    });

    assert.ok(!treeEl.innerHTML.includes('<script>'));
    assert.ok(treeEl.innerHTML.includes('&lt;script&gt;'));
    pt.dispose();
  });

  test('dispose unsubscribes', () => {
    const pt = new ProcessTree(bus, 'pt', 'tree', 'title');
    pt.dispose();
    assert.strictEqual(bus.count(Topics.PROCESS_STATS), 0);
  });
});
