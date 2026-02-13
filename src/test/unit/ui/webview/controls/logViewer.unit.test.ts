/**
 * @fileoverview Unit tests for LogViewer control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { LogViewer } from '../../../../../ui/webview/controls/logViewer';

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
  return {
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 200,
    clientHeight: 100,
    querySelector: function() {
      // Parse existing pre tag content
      const match = this.innerHTML.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
      if (match) {
        const self = this;
        return {
          get textContent() { return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); },
          set textContent(v: string) {
            self.innerHTML = `<pre class="log-content">${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
          },
        };
      }
      return null;
    },
  };
}

suite('LogViewer', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to LOG_UPDATE', () => {
    const lv = new LogViewer(bus, 'lv', 'viewer');
    assert.strictEqual(bus.count(Topics.LOG_UPDATE), 1);
    lv.dispose();
  });

  test('update with no data is a no-op', () => {
    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update(undefined);
    lv.dispose();
  });

  test('update with empty content is a no-op', () => {
    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: '' });
    lv.dispose();
  });

  test('update replaces content by default', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'line 1\nline 2' });

    assert.ok(el.innerHTML.includes('line 1'));
    assert.ok(el.innerHTML.includes('line 2'));
    lv.dispose();
  });

  test('skips update if content unchanged', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'same' });
    const html1 = el.innerHTML;

    lv.update({ content: 'same' });
    assert.strictEqual(el.innerHTML, html1);
    lv.dispose();
  });

  test('append mode adds content', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'line 1\n' });
    lv.update({ content: 'line 2\n', append: true });

    assert.ok(el.innerHTML.includes('log-content'));
    lv.dispose();
  });

  test('auto-scrolls when user was at bottom', () => {
    const el = makeEl();
    el.scrollHeight = 200;
    el.clientHeight = 100;
    el.scrollTop = 100; // at bottom (200 - 100 - 100 = 0 < 50)
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'new content' });

    assert.strictEqual(el.scrollTop, el.scrollHeight);
    lv.dispose();
  });

  test('does not auto-scroll when user scrolled up', () => {
    const el = makeEl();
    el.scrollHeight = 500;
    el.clientHeight = 100;
    el.scrollTop = 0; // scrolled to top (500 - 0 - 100 = 400 > 50)
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'new content' });

    assert.strictEqual(el.scrollTop, 0);
    lv.dispose();
  });

  test('responds to bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    bus.emit(Topics.LOG_UPDATE, { content: 'from bus' });

    assert.ok(el.innerHTML.includes('from bus'));
    lv.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('lv'), spy);

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'test' });
    assert.strictEqual(spy.callCount, 1);
    lv.dispose();
  });

  test('clear() resets content', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'some log' });
    lv.clear();

    assert.ok(el.innerHTML.includes('log-placeholder'));
    lv.dispose();
  });

  test('escapes HTML in content', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ viewer: el });

    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: '<script>alert(1)</script>' });

    assert.ok(!el.innerHTML.includes('<script>alert'));
    assert.ok(el.innerHTML.includes('&lt;script&gt;'));
    lv.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.update({ content: 'test' });
    lv.dispose();
  });

  test('clear with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.clear();
    lv.dispose();
  });

  test('dispose unsubscribes', () => {
    const lv = new LogViewer(bus, 'lv', 'viewer');
    lv.dispose();
    assert.strictEqual(bus.count(Topics.LOG_UPDATE), 0);
  });
});
