/**
 * @fileoverview Unit tests for PhaseTabBar control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { PhaseTabBar, phaseStatusIcon } from '../../../../../ui/webview/controls/phaseTabBar';

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
  const buttons: any[] = [];
  return {
    innerHTML: '',
    querySelectorAll: function() { return buttons; },
    _setButtons(btns: any[]) { buttons.length = 0; buttons.push(...btns); },
  };
}

function makeButton(phase: string, hasActive = false): any {
  const classes = new Set<string>(hasActive ? ['phase-tab', 'active'] : ['phase-tab']);
  return {
    getAttribute: (attr: string) => attr === 'data-phase' ? phase : null,
    classList: {
      add(c: string) { classes.add(c); },
      remove(c: string) { classes.delete(c); },
      contains(c: string) { return classes.has(c); },
    },
    _classes: classes,
  };
}

suite('PhaseTabBar', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  // ── phaseStatusIcon ────────────────────────────────────────────────────

  test('phaseStatusIcon: success → ✓', () => {
    assert.strictEqual(phaseStatusIcon('success'), '✓');
  });

  test('phaseStatusIcon: failed → ✗', () => {
    assert.strictEqual(phaseStatusIcon('failed'), '✗');
  });

  test('phaseStatusIcon: running → ⟳', () => {
    assert.strictEqual(phaseStatusIcon('running'), '⟳');
  });

  test('phaseStatusIcon: skipped → ⊘', () => {
    assert.strictEqual(phaseStatusIcon('skipped'), '⊘');
  });

  test('phaseStatusIcon: unknown → ○', () => {
    assert.strictEqual(phaseStatusIcon('unknown'), '○');
  });

  // ── basic operations ───────────────────────────────────────────────────

  test('subscribes to NODE_STATE_CHANGE and LOG_PHASE_CHANGE', () => {
    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 1);
    assert.strictEqual(bus.count(Topics.LOG_PHASE_CHANGE), 1);
    ptb.dispose();
  });

  test('initial active phase is "all"', () => {
    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    assert.strictEqual(ptb.getActivePhase(), 'all');
    ptb.dispose();
  });

  test('update with no data is a no-op', () => {
    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.update(undefined);
    ptb.dispose();
  });

  test('update renders tabs with status icons', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ tabs: el });

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.update({
      phaseStatus: { work: 'success', prechecks: 'failed' },
    });

    assert.ok(el.innerHTML.includes('Full Log'));
    assert.ok(el.innerHTML.includes('Work'));
    assert.ok(el.innerHTML.includes('✓'));
    assert.ok(el.innerHTML.includes('✗'));
    ptb.dispose();
  });

  test('update with activePhase sets active tab', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ tabs: el });

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.update({ phaseStatus: {}, activePhase: 'work' });

    assert.ok(el.innerHTML.includes('active'));
    assert.strictEqual(ptb.getActivePhase(), 'work');
    ptb.dispose();
  });

  test('setActivePhase updates active class on buttons', () => {
    const el = makeEl();
    const allBtn = makeButton('all', true);
    const workBtn = makeButton('work', false);
    el._setButtons([allBtn, workBtn]);
    restoreDoc = mockDocument({ tabs: el });

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.setActivePhase('work');

    assert.ok(!allBtn._classes.has('active'));
    assert.ok(workBtn._classes.has('active'));
    assert.strictEqual(ptb.getActivePhase(), 'work');
    ptb.dispose();
  });

  test('responds to LOG_PHASE_CHANGE', () => {
    const el = makeEl();
    el._setButtons([]);
    restoreDoc = mockDocument({ tabs: el });

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    bus.emit(Topics.LOG_PHASE_CHANGE, { phase: 'prechecks' });

    assert.strictEqual(ptb.getActivePhase(), 'prechecks');
    ptb.dispose();
  });

  test('responds to NODE_STATE_CHANGE', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ tabs: el });

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    bus.emit(Topics.NODE_STATE_CHANGE, { phaseStatus: { work: 'running' } });

    assert.ok(el.innerHTML.includes('Work'));
    ptb.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ tabs: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('ptb'), spy);

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.update({ phaseStatus: {} });
    assert.strictEqual(spy.callCount, 1);
    ptb.dispose();
  });

  test('setActivePhase publishes update', () => {
    const el = makeEl();
    el._setButtons([]);
    restoreDoc = mockDocument({ tabs: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('ptb'), spy);

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.setActivePhase('work');
    assert.strictEqual(spy.callCount, 1);
    ptb.dispose();
  });

  test('custom phases can be provided', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ tabs: el });

    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs', [
      { id: 'custom', name: 'Custom', icon: '★' },
    ]);
    ptb.update({ phaseStatus: { custom: 'success' } });

    assert.ok(el.innerHTML.includes('Custom'));
    ptb.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.update({ phaseStatus: {} });
    ptb.dispose();
  });

  test('setActivePhase with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.setActivePhase('work');
    ptb.dispose();
  });

  test('dispose unsubscribes', () => {
    const ptb = new PhaseTabBar(bus, 'ptb', 'tabs');
    ptb.dispose();
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 0);
    assert.strictEqual(bus.count(Topics.LOG_PHASE_CHANGE), 0);
  });
});
