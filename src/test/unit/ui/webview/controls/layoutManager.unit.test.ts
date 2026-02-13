/**
 * @fileoverview Unit tests for LayoutManager control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { LayoutManager } from '../../../../../ui/webview/controls/layoutManager';

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

function makeContainer(transform: string | null = 'scale(1.5)'): any {
  const svgEl = {
    getAttribute: sinon.stub().returns(transform),
    setAttribute: sinon.spy(),
  };
  return {
    scrollTop: 42,
    scrollLeft: 17,
    querySelector: () => svgEl,
    _svg: svgEl,
  };
}

suite('LayoutManager', () => {
  let bus: EventBus;
  let restoreDoc: () => void;
  let rafCallbacks: (() => void)[];
  let fakeRaf: (cb: () => void) => number;

  setup(() => {
    bus = new EventBus();
    rafCallbacks = [];
    fakeRaf = (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  function flushRaf(): void {
    const cbs = rafCallbacks.slice();
    rafCallbacks.length = 0;
    for (const cb of cbs) { cb(); }
  }

  test('subscribes to LAYOUT_CHANGE', () => {
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    assert.strictEqual(bus.count(Topics.LAYOUT_CHANGE), 1);
    lm.dispose();
  });

  test('saveState captures transform, scroll, and selected node', () => {
    const container = makeContainer('scale(2)');
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.setSelectedNode('node-1');
    const state = lm.saveState();

    assert.strictEqual(state.transform, 'scale(2)');
    assert.strictEqual(state.scrollTop, 42);
    assert.strictEqual(state.scrollLeft, 17);
    assert.strictEqual(state.selectedNodeId, 'node-1');
    lm.dispose();
  });

  test('restoreState applies transform and scroll', () => {
    const container = makeContainer();
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.restoreState({ transform: 'scale(3)', scrollTop: 100, scrollLeft: 50, selectedNodeId: 'n2' });

    assert.ok(container._svg.setAttribute.calledWith('transform', 'scale(3)'));
    assert.strictEqual(container.scrollTop, 100);
    assert.strictEqual(container.scrollLeft, 50);
    lm.dispose();
  });

  test('restoreState with null transform skips setAttribute', () => {
    const container = makeContainer();
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.restoreState({ transform: null, scrollTop: 0, scrollLeft: 0, selectedNodeId: null });

    assert.strictEqual(container._svg.setAttribute.callCount, 0);
    lm.dispose();
  });

  test('restoreState with no argument uses last saved state', () => {
    const container = makeContainer('scale(1.5)');
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.saveState();
    container.scrollTop = 999;
    lm.restoreState();

    assert.strictEqual(container.scrollTop, 42);
    lm.dispose();
  });

  test('restoreState with no saved state is a no-op', () => {
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.restoreState(); // should not throw
    lm.dispose();
  });

  // ── debounce ──────────────────────────────────────────────────────────

  test('LAYOUT_CHANGE debounces via requestAnimationFrame', () => {
    const container = makeContainer();
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    bus.emit(Topics.LAYOUT_CHANGE);
    bus.emit(Topics.LAYOUT_CHANGE);
    bus.emit(Topics.LAYOUT_CHANGE);

    assert.strictEqual(rafCallbacks.length, 1);
    lm.dispose();
  });

  test('flushing RAF invokes render and emits LAYOUT_COMPLETE', async () => {
    const container = makeContainer();
    restoreDoc = mockDocument({ container });

    const spy = sinon.spy();
    bus.on(Topics.LAYOUT_COMPLETE, spy);

    const renderSpy = sinon.spy();
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.setRenderCallback(renderSpy);

    bus.emit(Topics.LAYOUT_CHANGE);
    assert.strictEqual(spy.callCount, 0);

    flushRaf();
    await Promise.resolve();
    assert.strictEqual(renderSpy.callCount, 1);
    assert.strictEqual(spy.callCount, 1);
    lm.dispose();
  });

  test('render preserves and restores zoom state', async () => {
    const container = makeContainer('scale(2)');
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.setRenderCallback(() => {
      // Simulate Mermaid re-render clearing the SVG
      container._svg.getAttribute = sinon.stub().returns(null);
    });

    bus.emit(Topics.LAYOUT_CHANGE);
    flushRaf();
    await Promise.resolve();

    // After re-render, the original transform should be restored
    assert.ok(container._svg.setAttribute.calledWith('transform', 'scale(2)'));
    lm.dispose();
  });

  test('update() triggers re-render schedule', () => {
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.update();
    assert.strictEqual(rafCallbacks.length, 1);
    lm.dispose();
  });

  test('getLastState returns saved state', () => {
    const container = makeContainer('t1');
    restoreDoc = mockDocument({ container });

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    assert.strictEqual(lm.getLastState(), null);

    lm.saveState();
    const state = lm.getLastState();
    assert.ok(state);
    assert.strictEqual(state!.transform, 't1');
    lm.dispose();
  });

  test('setSelectedNode updates selected node id', () => {
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.setSelectedNode('n1');
    const container = makeContainer();
    restoreDoc = mockDocument({ container });

    const state = lm.saveState();
    assert.strictEqual(state.selectedNodeId, 'n1');
    lm.dispose();
  });

  test('RAF callback after dispose is a no-op', () => {
    const container = makeContainer();
    restoreDoc = mockDocument({ container });

    const spy = sinon.spy();
    bus.on(Topics.LAYOUT_COMPLETE, spy);

    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    bus.emit(Topics.LAYOUT_CHANGE);
    lm.dispose();
    flushRaf();

    assert.strictEqual(spy.callCount, 0);
  });

  test('dispose unsubscribes all', () => {
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.dispose();
    assert.strictEqual(bus.count(Topics.LAYOUT_CHANGE), 0);
  });

  test('saveState with missing container returns defaults', () => {
    restoreDoc = mockDocument({});
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    const state = lm.saveState();

    assert.strictEqual(state.transform, null);
    assert.strictEqual(state.scrollTop, 0);
    assert.strictEqual(state.scrollLeft, 0);
    lm.dispose();
  });

  test('restoreState with missing container is safe', () => {
    restoreDoc = mockDocument({});
    const lm = new LayoutManager(bus, 'lm', 'container', 'svg', fakeRaf);
    lm.restoreState({ transform: 't', scrollTop: 1, scrollLeft: 1, selectedNodeId: null });
    lm.dispose();
  });
});
