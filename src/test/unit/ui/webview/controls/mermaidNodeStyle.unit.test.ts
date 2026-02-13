/**
 * @fileoverview Unit tests for MermaidNodeStyle control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { MermaidNodeStyle } from '../../../../../ui/webview/controls/mermaidNodeStyle';

function mockDocument(querySelectorResult: any = null): () => void {
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    getElementById() { return null; },
    querySelector(selector: string) { return querySelectorResult; },
  };
  return () => {
    if (prev === undefined) { delete (globalThis as any).document; }
    else { (globalThis as any).document = prev; }
  };
}

function makeSvgNode(withRect = true): any {
  const rect = withRect ? { setAttribute: sinon.spy() } : null;
  return {
    setAttribute: sinon.spy(),
    querySelector: () => rect,
    _rect: rect,
  };
}

suite('MermaidNodeStyle', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to NODE_STATE_CHANGE', () => {
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 1);
    mns.dispose();
  });

  test('ignores updates for different sanitizedId', () => {
    const node = makeSvgNode();
    restoreDoc = mockDocument(node);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');

    bus.emit(Topics.NODE_STATE_CHANGE, { sanitizedId: 'nodeB', status: 'running' });
    assert.strictEqual(node.setAttribute.callCount, 0);
    mns.dispose();
  });

  test('updates SVG fill and stroke for matching node', () => {
    const node = makeSvgNode();
    restoreDoc = mockDocument(node);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');

    bus.emit(Topics.NODE_STATE_CHANGE, { sanitizedId: 'nodeA', status: 'running' });
    assert.ok(node._rect.setAttribute.calledWith('fill', '#1a3a2a'));
    assert.ok(node._rect.setAttribute.calledWith('stroke', '#4ec9b0'));
    assert.ok(node.setAttribute.calledWith('opacity', '1'));
    mns.dispose();
  });

  test('updates opacity for pending status', () => {
    const node = makeSvgNode();
    restoreDoc = mockDocument(node);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');

    mns.update({ sanitizedId: 'nodeA', status: 'pending' });
    assert.ok(node.setAttribute.calledWith('opacity', '0.6'));
    mns.dispose();
  });

  test('updates for failed status', () => {
    const node = makeSvgNode();
    restoreDoc = mockDocument(node);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');

    mns.update({ sanitizedId: 'nodeA', status: 'failed' });
    assert.ok(node._rect.setAttribute.calledWith('fill', '#3a1a1a'));
    assert.ok(node._rect.setAttribute.calledWith('stroke', '#f44747'));
    mns.dispose();
  });

  test('handles node without rect', () => {
    const node = makeSvgNode(false);
    restoreDoc = mockDocument(node);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');

    mns.update({ sanitizedId: 'nodeA', status: 'running' });
    assert.ok(node.setAttribute.calledWith('opacity', '1'));
    mns.dispose();
  });

  test('handles missing SVG node', () => {
    restoreDoc = mockDocument(null);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');
    mns.update({ sanitizedId: 'nodeA', status: 'running' });
    mns.dispose();
  });

  test('update with no data is safe', () => {
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');
    mns.update(undefined);
    mns.dispose();
  });

  test('publishes control update', () => {
    const node = makeSvgNode();
    restoreDoc = mockDocument(node);
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('mns'), spy);

    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');
    mns.update({ sanitizedId: 'nodeA', status: 'running' });
    assert.strictEqual(spy.callCount, 1);
    mns.dispose();
  });

  test('uses fallback colors for unknown status', () => {
    const node = makeSvgNode();
    restoreDoc = mockDocument(node);
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');

    mns.update({ sanitizedId: 'nodeA', status: 'weird' });
    assert.ok(node._rect.setAttribute.calledWith('fill', '#2d2d2d'));
    assert.ok(node._rect.setAttribute.calledWith('stroke', '#555'));
    mns.dispose();
  });

  test('dispose unsubscribes', () => {
    const mns = new MermaidNodeStyle(bus, 'mns', 'nodeA');
    mns.dispose();
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 0);
  });
});
