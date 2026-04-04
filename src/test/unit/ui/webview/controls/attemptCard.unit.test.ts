/**
 * @fileoverview Unit tests for AttemptCard control (list-based rebuild)
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { AttemptCard } from '../../../../../ui/webview/controls/attemptCard';

function mockDocument(containerEl?: any): () => void {
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    getElementById(id: string) { return null; },
    querySelector(sel: string) {
      if (containerEl && sel === '.attempt-history-container') return containerEl;
      return null;
    },
  };
  return () => {
    if (prev === undefined) { delete (globalThis as any).document; }
    else { (globalThis as any).document = prev; }
  };
}

function makeContainer(): any {
  let innerHTML = '';
  const listeners: any[] = [];
  return {
    get innerHTML() { return innerHTML; },
    set innerHTML(v: string) { innerHTML = v; },
    querySelectorAll(sel: string) {
      // Return empty array — handlers are tested separately
      return [];
    },
  };
}

// Mock the vscode API that AttemptCard uses for subscribeLog messages
function mockVscode(): () => void {
  const prev = (globalThis as any).vscode;
  (globalThis as any).vscode = { postMessage: () => {} };
  return () => {
    if (prev === undefined) { delete (globalThis as any).vscode; }
    else { (globalThis as any).vscode = prev; }
  };
}

suite('AttemptCard', () => {
  let bus: EventBus;
  let restoreDoc: (() => void) | undefined;
  let restoreVscode: (() => void) | undefined;

  setup(() => {
    bus = new EventBus();
    restoreVscode = mockVscode();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); restoreDoc = undefined; }
    if (restoreVscode) { restoreVscode(); restoreVscode = undefined; }
  });

  test('subscribes to ATTEMPT_UPDATE', () => {
    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    assert.strictEqual(bus.count(Topics.ATTEMPT_UPDATE), 1);
    ac.dispose();
  });

  test('rebuild renders attempt cards on ATTEMPT_UPDATE', () => {
    const container = makeContainer();
    restoreDoc = mockDocument(container);

    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, {
      attempts: [
        { attemptNumber: 1, status: 'succeeded', startedAt: Date.now() - 5000, endedAt: Date.now() },
        { attemptNumber: 2, status: 'running', startedAt: Date.now() - 1000 },
      ],
    });

    // Should render cards (latest first)
    assert.ok(container.innerHTML.includes('data-attempt="2"'), 'should include attempt 2 card');
    assert.ok(container.innerHTML.includes('data-attempt="1"'), 'should include attempt 1 card');
    assert.ok(container.innerHTML.indexOf('data-attempt="2"') < container.innerHTML.indexOf('data-attempt="1"'), 'attempt 2 should come before attempt 1');
    ac.dispose();
  });

  test('rebuild shows attempt count in header', () => {
    const container = makeContainer();
    restoreDoc = mockDocument(container);

    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, {
      attempts: [
        { attemptNumber: 1, status: 'failed', startedAt: Date.now() - 10000, endedAt: Date.now() - 5000 },
        { attemptNumber: 2, status: 'succeeded', startedAt: Date.now() - 4000, endedAt: Date.now() },
      ],
    });

    assert.ok(container.innerHTML.includes('Attempt History (2)'));
    ac.dispose();
  });

  test('rebuild renders status-specific styling', () => {
    const container = makeContainer();
    restoreDoc = mockDocument(container);

    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, {
      attempts: [
        { attemptNumber: 1, status: 'failed', startedAt: Date.now(), endedAt: Date.now(), error: 'Something broke', failedPhase: 'work', exitCode: 1 },
      ],
    });

    assert.ok(container.innerHTML.includes('#f48771'), 'should include failed status color');
    assert.ok(container.innerHTML.includes('Something broke'));
    assert.ok(container.innerHTML.includes('work'));
    ac.dispose();
  });

  test('rebuild renders trigger type badges', () => {
    const container = makeContainer();
    restoreDoc = mockDocument(container);

    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, {
      attempts: [
        { attemptNumber: 1, status: 'failed', triggerType: 'initial', startedAt: Date.now(), endedAt: Date.now() },
        { attemptNumber: 2, status: 'running', triggerType: 'auto-heal', startedAt: Date.now() },
      ],
    });

    assert.ok(container.innerHTML.includes('Auto-Heal'));
    ac.dispose();
  });

  test('rebuild renders step status indicators', () => {
    const container = makeContainer();
    restoreDoc = mockDocument(container);

    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, {
      attempts: [{
        attemptNumber: 1,
        status: 'running',
        startedAt: Date.now(),
        stepStatuses: { 'merge-fi': 'success', prechecks: 'success', work: 'running' },
      }],
    });

    assert.ok(container.innerHTML.includes('step-icon success'), 'should show success step icons');
    assert.ok(container.innerHTML.includes('step-icon running'), 'should show running step icon');
    ac.dispose();
  });

  test('rebuild with no container is safe', () => {
    restoreDoc = mockDocument(undefined);
    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, { attempts: [{ attemptNumber: 1, status: 'running', startedAt: Date.now() }] });
    // Should not throw
    ac.dispose();
  });

  test('rebuild with empty attempts clears container', () => {
    const container = makeContainer();
    restoreDoc = mockDocument(container);

    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    bus.emit(Topics.ATTEMPT_UPDATE, { attempts: [] });

    assert.ok(container.innerHTML.includes('Attempt History (0)'));
    ac.dispose();
  });

  test('legacy methods are safe no-ops', () => {
    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    ac.update(undefined);
    ac.expand();
    ac.collapse();
    ac.toggle();
    assert.strictEqual(ac.isExpanded(), false);
    ac.dispose();
  });

  test('dispose unsubscribes', () => {
    const ac = new AttemptCard(bus, 'ac', '.attempt-history-container');
    ac.dispose();
    assert.strictEqual(bus.count(Topics.ATTEMPT_UPDATE), 0);
  });
});
