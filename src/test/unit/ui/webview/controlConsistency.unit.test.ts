/**
 * @fileoverview Tests for control behavior consistency.
 * 
 * Verifies that EventBus, SubscribableControl, and controls behave consistently
 * whether used from bundle or inline.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../ui/webview/eventBus';
import { SubscribableControl } from '../../../../ui/webview/subscribableControl';
import { DurationCounter } from '../../../../ui/webview/controls/durationCounter';
import { StatusBadge } from '../../../../ui/webview/controls/statusBadge';
import { LogViewer } from '../../../../ui/webview/controls/logViewer';
import { ProcessTree } from '../../../../ui/webview/controls/processTree';

suite('Control Consistency', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('EventBus behavior', () => {
    let bus: EventBus;

    setup(() => {
      bus = new EventBus();
    });

    test('subscribe() registers handler', () => {
      const handler = sandbox.stub();
      const sub = bus.on('test', handler);

      assert.ok(sub, 'Should return subscription');
      assert.strictEqual(typeof sub.unsubscribe, 'function', 'Should have unsubscribe method');
    });

    test('emit() delivers data to subscribers', () => {
      const handler = sandbox.stub();
      bus.on('test', handler);
      bus.emit('test', { data: 'value' });

      assert.ok(handler.calledOnce, 'Handler should be called');
      assert.deepStrictEqual(handler.firstCall.args[0], { data: 'value' }, 'Should pass data');
    });

    test('unsubscribe() removes handler', () => {
      const handler = sandbox.stub();
      const sub = bus.on('test', handler);

      sub.unsubscribe();
      bus.emit('test', 'data');

      assert.ok(handler.notCalled, 'Handler should not be called after unsubscribe');
    });

    test('clear() removes all handlers for topic', () => {
      const h1 = sandbox.stub();
      const h2 = sandbox.stub();
      bus.on('test', h1);
      bus.on('test', h2);

      bus.clear('test');
      bus.emit('test', 'data');

      assert.ok(h1.notCalled, 'First handler should not be called');
      assert.ok(h2.notCalled, 'Second handler should not be called');
    });

    test('clear() with no topic clears all', () => {
      const h1 = sandbox.stub();
      const h2 = sandbox.stub();
      bus.on('topic1', h1);
      bus.on('topic2', h2);

      bus.clear();
      bus.emit('topic1', 'data');
      bus.emit('topic2', 'data');

      assert.ok(h1.notCalled, 'Handler 1 should not be called');
      assert.ok(h2.notCalled, 'Handler 2 should not be called');
    });

    test('multiple subscribers on same topic all receive event', () => {
      const h1 = sandbox.stub();
      const h2 = sandbox.stub();
      const h3 = sandbox.stub();

      bus.on('test', h1);
      bus.on('test', h2);
      bus.on('test', h3);

      bus.emit('test', 'data');

      assert.ok(h1.calledOnce, 'Handler 1 should be called');
      assert.ok(h2.calledOnce, 'Handler 2 should be called');
      assert.ok(h3.calledOnce, 'Handler 3 should be called');
    });
  });

  suite('SubscribableControl behavior', () => {
    class TestControl extends SubscribableControl {
      update(_data?: any): void {
        // no-op for testing
      }

      // Expose protected methods for testing
      public testSubscribe(topic: string, handler: (d?: any) => void) {
        return this.subscribe(topic, handler);
      }

      public testPublishUpdate(data?: any) {
        return this.publishUpdate(data);
      }

      public testSubscribeToChild(childId: string, handler: () => void) {
        return this.subscribeToChild(childId, handler);
      }

      public get testControlId() {
        return this.controlId;
      }
    }

    let bus: EventBus;
    let control: TestControl;

    setup(() => {
      bus = new EventBus();
      control = new TestControl(bus, 'test-control');
    });

    test('subscribe() registers handler via bus', () => {
      const handler = sandbox.stub();
      control.testSubscribe('test', handler);

      bus.emit('test', 'data');
      assert.ok(handler.calledOnce, 'Handler should be called via bus');
    });

    test('publishUpdate() emits control-specific topic', () => {
      const handler = sandbox.stub();
      bus.on('control:test-control:updated', handler);

      control.testPublishUpdate({ key: 'value' });

      assert.ok(handler.calledOnce, 'Should emit control update topic');
      assert.deepStrictEqual(handler.firstCall.args[0], { key: 'value' }, 'Should pass data');
    });

    test('dispose() unsubscribes all handlers', () => {
      const h1 = sandbox.stub();
      const h2 = sandbox.stub();

      control.testSubscribe('topic1', h1);
      control.testSubscribe('topic2', h2);

      control.dispose();

      bus.emit('topic1', 'data');
      bus.emit('topic2', 'data');

      assert.ok(h1.notCalled, 'Handler 1 should not be called after dispose');
      assert.ok(h2.notCalled, 'Handler 2 should not be called after dispose');
    });

    test('subscribeToChild() batches updates with microtask', async () => {
      const handler = sandbox.stub();
      control.testSubscribeToChild('child-control', handler);

      // Emit multiple child updates in same tick
      bus.emit('control:child-control:updated', {});
      bus.emit('control:child-control:updated', {});
      bus.emit('control:child-control:updated', {});

      // Handler not called yet (batched)
      assert.ok(handler.notCalled, 'Handler should not be called synchronously');

      // Wait for microtask
      await new Promise<void>(resolve => queueMicrotask(resolve));

      // Handler called once (batched)
      assert.ok(handler.calledOnce, 'Handler should be called once after microtask');
    });

    test('controlId is accessible', () => {
      assert.strictEqual(control.testControlId, 'test-control', 'Should have controlId');
    });
  });

  suite('DurationCounter control', () => {
    let bus: EventBus;

    setup(() => {
      bus = new EventBus();
      // Mock DOM
      (global as any).document = {
        getElementById: sandbox.stub().returns({
          textContent: '',
          dataset: {},
        }),
      };
    });

    teardown(() => {
      delete (global as any).document;
    });

    test('can be instantiated', () => {
      const counter = new DurationCounter(bus, 'test-counter', 'elem-id');
      assert.ok(counter, 'Should create instance');
    });

    test('responds to update calls', () => {
      const counter = new DurationCounter(bus, 'test-counter', 'elem-id');
      // Should not throw
      counter.update({ startedAt: Date.now(), running: true });
    });
  });

  suite('StatusBadge control', () => {
    let bus: EventBus;

    setup(() => {
      bus = new EventBus();
      (global as any).document = {
        getElementById: sandbox.stub().returns({
          textContent: '',
          className: '',
        }),
      };
    });

    teardown(() => {
      delete (global as any).document;
    });

    test('can be instantiated', () => {
      const badge = new StatusBadge(bus, 'test-badge', 'elem-id');
      assert.ok(badge, 'Should create instance');
    });

    test('responds to update calls', () => {
      const badge = new StatusBadge(bus, 'test-badge', 'elem-id');
      badge.update({ status: 'running' });
      // Should not throw
    });
  });

  suite('LogViewer control', () => {
    let bus: EventBus;

    setup(() => {
      bus = new EventBus();
      (global as any).document = {
        getElementById: sandbox.stub().returns({
          innerHTML: '',
          scrollTop: 0,
          scrollHeight: 100,
        }),
      };
    });

    teardown(() => {
      delete (global as any).document;
    });

    test('can be instantiated', () => {
      const viewer = new LogViewer(bus, 'test-viewer', 'elem-id');
      assert.ok(viewer, 'Should create instance');
    });

    test('responds to update calls', () => {
      const viewer = new LogViewer(bus, 'test-viewer', 'elem-id');
      viewer.update({ content: 'log line 1\nlog line 2' });
      // Should not throw
    });
  });

  suite('ProcessTree control', () => {
    let bus: EventBus;

    setup(() => {
      bus = new EventBus();
      (global as any).document = {
        getElementById: sandbox.stub().returns({
          innerHTML: '',
        }),
      };
    });

    teardown(() => {
      delete (global as any).document;
    });

    test('can be instantiated', () => {
      const tree = new ProcessTree(bus, 'test-tree', 'elem-id', 'title-id');
      assert.ok(tree, 'Should create instance');
    });

    test('responds to update calls', () => {
      const tree = new ProcessTree(bus, 'test-tree', 'elem-id', 'title-id');
      tree.update({ running: false, tree: [] });
      // Should not throw
    });
  });

  suite('control integration', () => {
    let bus: EventBus;

    setup(() => {
      bus = new EventBus();
      (global as any).document = {
        getElementById: sandbox.stub().returns({
          textContent: '',
          className: '',
          innerHTML: '',
          dataset: {},
        }),
      };
    });

    teardown(() => {
      delete (global as any).document;
    });

    test('multiple controls can share same bus', () => {
      const counter = new DurationCounter(bus, 'counter', 'elem1');
      const badge = new StatusBadge(bus, 'badge', 'elem2');
      const viewer = new LogViewer(bus, 'viewer', 'elem3');

      // All should be independent
      counter.update({ startedAt: Date.now(), running: true });
      badge.update({ status: 'running' });
      viewer.update({ content: '' });
      // Should not interfere with each other
    });

    test('controls can communicate via bus', () => {
      const handler = sandbox.stub();
      
      class TestControl extends SubscribableControl {
        update(_data?: any): void {}
        public testSubscribe(topic: string, handler: (d?: any) => void) {
          return this.subscribe(topic, handler);
        }
      }

      const counter = new TestControl(bus, 'counter');
      counter.testSubscribe('custom:event', handler);

      bus.emit('custom:event', { data: 'test' });

      assert.ok(handler.calledOnce, 'Control should receive bus events');
    });
  });
});
