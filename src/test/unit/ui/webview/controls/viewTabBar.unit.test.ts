/**
 * @fileoverview Unit tests for ViewTabBar control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { suite, test, setup, teardown } from 'mocha';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { ViewTabBar, ViewTab } from '../../../../../ui/webview/controls/viewTabBar';

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

function makeTabBarElement(): any {
  const buttons: any[] = [];
  
  const dagBtn = {
    dataset: { tab: 'dag' },
    classList: {
      _classes: new Set(['view-tab', 'active']),
      toggle(cls: string, force?: boolean) {
        if (force === true) this._classes.add(cls);
        else if (force === false) this._classes.delete(cls);
        else {
          if (this._classes.has(cls)) this._classes.delete(cls);
          else this._classes.add(cls);
        }
      },
      contains(cls: string) { return this._classes.has(cls); },
    },
    setAttribute: sinon.stub(),
    closest: (sel: string) => sel === '.view-tab' ? dagBtn : null,
  };
  
  const timelineBtn = {
    dataset: { tab: 'timeline' },
    classList: {
      _classes: new Set(['view-tab']),
      toggle(cls: string, force?: boolean) {
        if (force === true) this._classes.add(cls);
        else if (force === false) this._classes.delete(cls);
        else {
          if (this._classes.has(cls)) this._classes.delete(cls);
          else this._classes.add(cls);
        }
      },
      contains(cls: string) { return this._classes.has(cls); },
    },
    setAttribute: sinon.stub(),
    closest: (sel: string) => sel === '.view-tab' ? timelineBtn : null,
  };
  
  buttons.push(dagBtn, timelineBtn);
  
  const container: any = {
    _listeners: {} as any,
    addEventListener(event: string, handler: any) {
      this._listeners[event] = handler;
    },
    querySelectorAll(selector: string) {
      if (selector === '.view-tab') return buttons;
      return [];
    },
    _simulateClick(tab: ViewTab) {
      const btn = buttons.find(b => b.dataset.tab === tab);
      if (btn && this._listeners['click']) {
        const evt = { target: btn };
        this._listeners['click'](evt);
      }
    },
  };
  
  return container;
}

suite('ViewTabBar', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('should default to dag tab', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    assert.strictEqual(tabBar.getActiveTab(), 'dag', 'Should default to dag');
    tabBar.dispose();
  });

  test('should switch to timeline tab on click', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    // Simulate clicking the timeline tab
    container._simulateClick('timeline');
    
    assert.strictEqual(tabBar.getActiveTab(), 'timeline', 'Should switch to timeline');
    tabBar.dispose();
  });

  test('should publish update with activeTab on switch', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('tabs'), spy);
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    // Simulate clicking the timeline tab
    container._simulateClick('timeline');
    
    assert.strictEqual(spy.callCount, 1, 'Should publish update');
    assert.deepStrictEqual(spy.firstCall.args[0], { activeTab: 'timeline' }, 'Should include activeTab');
    tabBar.dispose();
  });

  test('should toggle active CSS class', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    const buttons = container.querySelectorAll('.view-tab');
    
    // Initially dag is active
    assert.ok(buttons[0].classList.contains('active'), 'Dag should be active initially');
    assert.ok(!buttons[1].classList.contains('active'), 'Timeline should not be active initially');
    
    // Switch to timeline
    container._simulateClick('timeline');
    
    assert.ok(!buttons[0].classList.contains('active'), 'Dag should not be active after switch');
    assert.ok(buttons[1].classList.contains('active'), 'Timeline should be active after switch');
    
    tabBar.dispose();
  });

  test('should not switch if already on selected tab', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('tabs'), spy);
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    // Click dag tab (already active)
    container._simulateClick('dag');
    
    assert.strictEqual(spy.callCount, 0, 'Should not publish update when clicking active tab');
    assert.strictEqual(tabBar.getActiveTab(), 'dag', 'Should remain on dag');
    tabBar.dispose();
  });

  test('should update aria-selected attributes', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    const buttons = container.querySelectorAll('.view-tab');
    
    // Switch to timeline
    container._simulateClick('timeline');
    
    // Verify setAttribute was called for aria-selected
    assert.ok(buttons[0].setAttribute.called, 'Should set aria-selected on dag');
    assert.ok(buttons[1].setAttribute.called, 'Should set aria-selected on timeline');
    
    tabBar.dispose();
  });

  test('getActiveTab returns current tab', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    assert.strictEqual(tabBar.getActiveTab(), 'dag', 'Should return dag initially');
    
    container._simulateClick('timeline');
    assert.strictEqual(tabBar.getActiveTab(), 'timeline', 'Should return timeline after switch');
    
    container._simulateClick('dag');
    assert.strictEqual(tabBar.getActiveTab(), 'dag', 'Should return dag after switch back');
    
    tabBar.dispose();
  });

  test('update method sets active tab', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    tabBar.update({ activeTab: 'timeline' });
    
    assert.strictEqual(tabBar.getActiveTab(), 'timeline', 'Should set active tab via update');
    tabBar.dispose();
  });

  test('update with undefined data is safe', () => {
    const container = makeTabBarElement();
    restoreDoc = mockDocument({ 'tab-bar': container });
    
    const tabBar = new ViewTabBar(bus, 'tabs', 'tab-bar');
    
    tabBar.update(undefined);
    
    assert.strictEqual(tabBar.getActiveTab(), 'dag', 'Should keep current tab');
    tabBar.dispose();
  });
});
