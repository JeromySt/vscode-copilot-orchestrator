/**
 * @fileoverview Unit tests for ConfigDisplay control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { ConfigDisplay } from '../../../../../ui/webview/controls/configDisplay';

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
  return { innerHTML: '' };
}

suite('ConfigDisplay', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to NODE_STATE_CHANGE', () => {
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 1);
    cd.dispose();
  });

  test('update with no data is a no-op', () => {
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update(undefined);
    cd.dispose();
  });

  test('update renders task', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'Build the widget' });

    assert.ok(el.innerHTML.includes('Task'));
    assert.ok(el.innerHTML.includes('Build the widget'));
    cd.dispose();
  });

  test('update renders work HTML', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test', workHtml: '<div>Work spec</div>' });

    assert.ok(el.innerHTML.includes('Work'));
    assert.ok(el.innerHTML.includes('Work spec'));
    cd.dispose();
  });

  test('update renders instructions', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test', instructions: 'Follow these steps' });

    assert.ok(el.innerHTML.includes('Instructions'));
    assert.ok(el.innerHTML.includes('Follow these steps'));
    cd.dispose();
  });

  test('update without optional fields omits them', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test' });

    assert.ok(!el.innerHTML.includes('Work'));
    assert.ok(!el.innerHTML.includes('Instructions'));
    cd.dispose();
  });

  test('escapes HTML in task and instructions', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: '<script>evil</script>', instructions: '<b>bold</b>' });

    assert.ok(!el.innerHTML.includes('<script>evil'));
    assert.ok(el.innerHTML.includes('&lt;script&gt;'));
    assert.ok(el.innerHTML.includes('&lt;b&gt;bold'));
    cd.dispose();
  });

  test('responds to bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    bus.emit(Topics.NODE_STATE_CHANGE, { task: 'From bus' });

    assert.ok(el.innerHTML.includes('From bus'));
    cd.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('cd'), spy);

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test' });
    assert.strictEqual(spy.callCount, 1);
    cd.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test' });
    cd.dispose();
  });

  test('dispose unsubscribes', () => {
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.dispose();
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 0);
  });

  test('renders all three fields together', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'build', workHtml: '<pre>spec</pre>', instructions: 'Do it right' });

    assert.ok(el.innerHTML.includes('build'));
    assert.ok(el.innerHTML.includes('spec'));
    assert.ok(el.innerHTML.includes('Do it right'));
    assert.ok(el.innerHTML.includes('config-item'));
    cd.dispose();
  });
});
