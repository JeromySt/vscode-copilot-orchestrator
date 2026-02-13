/**
 * @fileoverview Unit tests for AttemptCard control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { AttemptCard } from '../../../../../ui/webview/controls/attemptCard';

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
  const badge = { textContent: '' };
  const statusEl = { textContent: '', className: '' };
  const errorEl = { style: { display: 'none' }, querySelector: () => ({ textContent: '' }) };
  const body = { style: { display: 'none' } };
  const chevron = { textContent: '▶' };
  const header = { setAttribute: sinon.spy() };

  return {
    querySelector(sel: string) {
      if (sel === '.attempt-badge') { return badge; }
      if (sel === '.attempt-status') { return statusEl; }
      if (sel === '.attempt-error') { return errorEl; }
      if (sel === '.attempt-body') { return body; }
      if (sel === '.chevron') { return chevron; }
      if (sel === '.attempt-header') { return header; }
      return null;
    },
    _badge: badge,
    _status: statusEl,
    _error: errorEl,
    _body: body,
    _chevron: chevron,
    _header: header,
  };
}

suite('AttemptCard', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to ATTEMPT_UPDATE', () => {
    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    assert.strictEqual(bus.count(Topics.ATTEMPT_UPDATE), 1);
    ac.dispose();
  });

  test('ignores updates for different attempt number', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    bus.emit(Topics.ATTEMPT_UPDATE, { attemptNumber: 2, status: 'failed' });

    assert.strictEqual(el._badge.textContent, '');
    ac.dispose();
  });

  test('update with no data is safe', () => {
    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.update(undefined);
    ac.dispose();
  });

  test('update sets badge and status', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.update({ attemptNumber: 1, status: 'succeeded' });

    assert.strictEqual(el._badge.textContent, '#1');
    assert.strictEqual(el._status.textContent, 'succeeded');
    assert.ok(el._status.className.includes('status-succeeded'));
    ac.dispose();
  });

  test('update shows error', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.update({ attemptNumber: 1, status: 'failed', error: 'Something broke' });

    assert.strictEqual(el._error.style.display, 'block');
    ac.dispose();
  });

  test('expand shows body', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.expand();

    assert.strictEqual(el._body.style.display, 'block');
    assert.strictEqual(el._chevron.textContent, '▼');
    assert.ok(el._header.setAttribute.calledWith('data-expanded', 'true'));
    assert.strictEqual(ac.isExpanded(), true);
    ac.dispose();
  });

  test('collapse hides body', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.expand();
    ac.collapse();

    assert.strictEqual(el._body.style.display, 'none');
    assert.strictEqual(el._chevron.textContent, '▶');
    assert.strictEqual(ac.isExpanded(), false);
    ac.dispose();
  });

  test('toggle switches state', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    assert.strictEqual(ac.isExpanded(), false);

    ac.toggle();
    assert.strictEqual(ac.isExpanded(), true);

    ac.toggle();
    assert.strictEqual(ac.isExpanded(), false);
    ac.dispose();
  });

  test('update with expanded=true expands card', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.update({ attemptNumber: 1, status: 'failed', expanded: true });

    assert.strictEqual(ac.isExpanded(), true);
    ac.dispose();
  });

  test('update with expanded=false collapses card', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.expand();
    ac.update({ attemptNumber: 1, status: 'failed', expanded: false });

    assert.strictEqual(ac.isExpanded(), false);
    ac.dispose();
  });

  test('responds to bus events for matching attempt', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const ac = new AttemptCard(bus, 'ac', 'card', 2);
    bus.emit(Topics.ATTEMPT_UPDATE, { attemptNumber: 2, status: 'failed' });

    assert.strictEqual(el._badge.textContent, '#2');
    ac.dispose();
  });

  test('publishes control update', () => {
    const el = makeCardEl();
    restoreDoc = mockDocument({ card: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('ac'), spy);

    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.update({ attemptNumber: 1, status: 'succeeded' });
    assert.strictEqual(spy.callCount, 1);
    ac.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.update({ attemptNumber: 1, status: 'running' });
    ac.dispose();
  });

  test('expand/collapse with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.expand();
    ac.collapse();
    ac.dispose();
  });

  test('dispose unsubscribes', () => {
    const ac = new AttemptCard(bus, 'ac', 'card', 1);
    ac.dispose();
    assert.strictEqual(bus.count(Topics.ATTEMPT_UPDATE), 0);
  });
});
