/**
 * @fileoverview Unit tests for WebViewSubscriptionManager
 *
 * Tests the pub/sub bridge between webview panels and extension host event
 * producers, including subscribe, tick, pause, resume, and dispose.
 *
 * @module test/unit/ui/webViewSubscriptionManager
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { WebViewSubscriptionManager } from '../../../ui/webViewSubscriptionManager';
import type { EventProducer } from '../../../ui/webViewSubscriptionManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebview(): { postMessage: sinon.SinonStub } {
  return { postMessage: sinon.stub() };
}

function makeProducer(
  type: string,
  fullContent: any = { data: 'full' },
  deltaContent: any = { data: 'delta' },
): EventProducer<number> & { readFull: sinon.SinonStub; readDelta: sinon.SinonStub } {
  return {
    type,
    readFull: sinon.stub().returns({ content: fullContent, cursor: 1 }),
    readDelta: sinon.stub().returns({ content: deltaContent, cursor: 2 }),
  };
}

// ---------------------------------------------------------------------------
// WebViewSubscriptionManager
// ---------------------------------------------------------------------------

suite('WebViewSubscriptionManager', () => {
  let sandbox: sinon.SinonSandbox;
  let manager: WebViewSubscriptionManager;

  setup(() => {
    sandbox = sinon.createSandbox();
    manager = new WebViewSubscriptionManager();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('registerProducer', () => {
    test('registers a producer by type', () => {
      const producer = makeProducer('testType');
      manager.registerProducer(producer);
      // Verify by subscribing — if unknown type, subscribe returns null
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'testType', 'key1', 'tag1');
      assert.ok(id !== null);
    });
  });

  suite('subscribe', () => {
    test('returns null for unknown producer type', () => {
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'unknownType', 'key', 'tag');
      assert.strictEqual(id, null);
    });

    test('returns a subscription ID for known producer', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      assert.ok(typeof id === 'string');
      assert.ok(id!.startsWith('sub-'));
    });

    test('sends initial full content on subscribe', () => {
      const producer = makeProducer('myType', { value: 42 });
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      assert.ok(webview.postMessage.calledOnce);
      const msg = webview.postMessage.firstCall.args[0];
      assert.strictEqual(msg.type, 'subscriptionData');
      assert.strictEqual(msg.subscriptionId, id);
      assert.strictEqual(msg.tag, 'tag1');
      assert.strictEqual(msg.full, true);
      assert.deepStrictEqual(msg.content, { value: 42 });
    });

    test('does not send message when readFull returns null', () => {
      const producer: EventProducer<number> = {
        type: 'nullType',
        readFull: sinon.stub().returns(null),
        readDelta: sinon.stub().returns(null),
      };
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'nullType', 'key1', 'tag1');
      assert.ok(webview.postMessage.notCalled);
    });

    test('increments subscription IDs', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id1 = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      const id2 = manager.subscribe('panel1', webview as any, 'myType', 'key2', 'tag2');
      assert.notStrictEqual(id1, id2);
    });

    test('totalCount and activeCount increase on subscribe', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      assert.strictEqual(manager.totalCount, 0);
      assert.strictEqual(manager.activeCount, 0);
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      assert.strictEqual(manager.totalCount, 1);
      assert.strictEqual(manager.activeCount, 1);
    });

    test('handles postMessage throwing (disposed webview)', () => {
      const producer = makeProducer('myType', { val: 1 });
      manager.registerProducer(producer);
      const webview = { postMessage: sinon.stub().throws(new Error('disposed')) };
      // Should not throw
      assert.doesNotThrow(() => {
        manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      });
    });
  });

  suite('tick', () => {
    test('calls readDelta on active subscriptions and sends delta', () => {
      const producer = makeProducer('myType', { full: true }, { delta: true });
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      webview.postMessage.resetHistory();

      manager.tick();

      assert.ok(webview.postMessage.calledOnce);
      const msg = webview.postMessage.firstCall.args[0];
      assert.strictEqual(msg.type, 'subscriptionData');
      assert.strictEqual(msg.subscriptionId, id);
      assert.strictEqual(msg.full, false);
      assert.deepStrictEqual(msg.content, { delta: true });
    });

    test('skips paused subscriptions', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      manager.pausePanel('panel1');
      webview.postMessage.resetHistory();

      manager.tick();

      assert.ok(webview.postMessage.notCalled);
    });

    test('skips subscriptions with null cursor', () => {
      const producer: EventProducer<number> = {
        type: 'noData',
        readFull: sinon.stub().returns(null), // no initial cursor
        readDelta: sinon.stub().returns({ content: 'x', cursor: 1 }),
      };
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'noData', 'key', 'tag');
      webview.postMessage.resetHistory();

      manager.tick();

      // readDelta should NOT be called — cursor is null
      assert.ok((producer.readDelta as sinon.SinonStub).notCalled);
    });

    test('does not send when readDelta returns null', () => {
      const producer: EventProducer<number> = {
        type: 'noChange',
        readFull: sinon.stub().returns({ content: 'x', cursor: 5 }),
        readDelta: sinon.stub().returns(null),
      };
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'noChange', 'key', 'tag');
      webview.postMessage.resetHistory();

      manager.tick();

      assert.ok(webview.postMessage.notCalled);
    });

    test('updates cursor after tick', async () => {
      // Producer: first delta returns cursor=2, second returns null (no further change)
      const producer: EventProducer<number> = {
        type: 'advancing',
        readFull: sinon.stub().returns({ content: 'x', cursor: 1 }),
        readDelta: sinon.stub()
          .onFirstCall().returns({ content: 'y', cursor: 2 })
          .onSecondCall().returns(null),
      };
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'advancing', 'key', 'tag');
      webview.postMessage.resetHistory();

      await manager.tick(); // delivers delta with cursor 2
      await manager.tick(); // no change — cursor 2 matches

      assert.ok(webview.postMessage.calledOnce);
      // readDelta second call should have cursor=2
      const secondCallCursor = (producer.readDelta as sinon.SinonStub).secondCall.args[1];
      assert.strictEqual(secondCallCursor, 2);
    });

    test('handles postMessage throwing on tick (disposed webview)', () => {
      const producer = makeProducer('myType', { full: true }, { delta: true });
      manager.registerProducer(producer);
      const webview = { postMessage: sinon.stub().throws(new Error('disposed')) };
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');

      assert.doesNotThrow(() => manager.tick());
    });
  });

  suite('pausePanel', () => {
    test('paused panel subscriptions do not receive tick updates', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      webview.postMessage.resetHistory();

      manager.pausePanel('panel1');
      manager.tick();

      assert.ok(webview.postMessage.notCalled);
    });

    test('activeCount decreases when panel is paused', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      assert.strictEqual(manager.activeCount, 1);

      manager.pausePanel('panel1');
      assert.strictEqual(manager.activeCount, 0);
      assert.strictEqual(manager.totalCount, 1);
    });
  });

  suite('resumePanel', () => {
    test('resumed panel gets catch-up delta if data changed during pause', () => {
      const producer = makeProducer('myType', { full: true }, { catchUp: true });
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      manager.pausePanel('panel1');
      webview.postMessage.resetHistory();

      manager.resumePanel('panel1');

      // readDelta called to check for catch-up
      assert.ok(webview.postMessage.calledOnce);
      const msg = webview.postMessage.firstCall.args[0];
      assert.strictEqual(msg.full, false);
      assert.deepStrictEqual(msg.content, { catchUp: true });
    });

    test('resumed panel does not receive message if nothing changed', () => {
      const producer: EventProducer<number> = {
        type: 'noChange',
        readFull: sinon.stub().returns({ content: 'x', cursor: 5 }),
        readDelta: sinon.stub().returns(null),
      };
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'noChange', 'key', 'tag');
      manager.pausePanel('panel1');
      webview.postMessage.resetHistory();

      manager.resumePanel('panel1');

      assert.ok(webview.postMessage.notCalled);
    });

    test('activeCount increases on resume', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      manager.pausePanel('panel1');
      assert.strictEqual(manager.activeCount, 0);

      manager.resumePanel('panel1');
      assert.strictEqual(manager.activeCount, 1);
    });

    test('resumePanel only resumes paused subs (not active)', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1'); // active
      webview.postMessage.resetHistory();

      // Calling resumePanel on already-active panel should not trigger catch-up
      manager.resumePanel('panel1');
      assert.ok(webview.postMessage.notCalled);
    });

    test('handles postMessage throwing on resume (disposed webview)', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = { postMessage: sinon.stub().throws(new Error('disposed')) };
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      manager.pausePanel('panel1');

      assert.doesNotThrow(() => manager.resumePanel('panel1'));
    });
  });

  suite('unsubscribe', () => {
    test('removes specific subscription', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1')!;
      assert.strictEqual(manager.totalCount, 1);

      manager.unsubscribe(id);
      assert.strictEqual(manager.totalCount, 0);
    });

    test('no tick after unsubscribe', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1')!;
      manager.unsubscribe(id);
      webview.postMessage.resetHistory();

      manager.tick();
      assert.ok(webview.postMessage.notCalled);
    });
  });

  suite('disposePanel', () => {
    test('removes all subscriptions for panel', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');
      manager.subscribe('panel1', webview as any, 'myType', 'key2', 'tag2');
      assert.strictEqual(manager.totalCount, 2);

      manager.disposePanel('panel1');
      assert.strictEqual(manager.totalCount, 0);
    });

    test('does not remove subscriptions for other panels', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview1 = makeWebview();
      const webview2 = makeWebview();
      manager.subscribe('panel1', webview1 as any, 'myType', 'key1', 'tag1');
      manager.subscribe('panel2', webview2 as any, 'myType', 'key2', 'tag2');
      assert.strictEqual(manager.totalCount, 2);

      manager.disposePanel('panel1');
      assert.strictEqual(manager.totalCount, 1);
    });
  });

  suite('endSubscription', () => {
    test('sends subscriptionEnd message and removes subscription', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1')!;
      webview.postMessage.resetHistory();

      manager.endSubscription(id);

      assert.ok(webview.postMessage.calledOnce);
      const msg = webview.postMessage.firstCall.args[0];
      assert.strictEqual(msg.type, 'subscriptionEnd');
      assert.strictEqual(msg.subscriptionId, id);
      assert.strictEqual(msg.tag, 'tag1');
      assert.strictEqual(manager.totalCount, 0);
    });

    test('silently handles unknown subscription ID', () => {
      assert.doesNotThrow(() => manager.endSubscription('sub-999'));
    });

    test('handles postMessage throwing on endSubscription', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = { postMessage: sinon.stub().throws(new Error('disposed')) };
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1')!;

      assert.doesNotThrow(() => manager.endSubscription(id));
    });
  });

  suite('findSubscription', () => {
    test('finds existing subscription by panel, type, key', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      const id = manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1')!;

      const found = manager.findSubscription('panel1', 'myType', 'key1');
      assert.strictEqual(found, id);
    });

    test('returns undefined when no match', () => {
      const found = manager.findSubscription('panel1', 'myType', 'key1');
      assert.strictEqual(found, undefined);
    });

    test('does not return subscription for different panel', () => {
      const producer = makeProducer('myType');
      manager.registerProducer(producer);
      const webview = makeWebview();
      manager.subscribe('panel1', webview as any, 'myType', 'key1', 'tag1');

      const found = manager.findSubscription('panel2', 'myType', 'key1');
      assert.strictEqual(found, undefined);
    });
  });

  suite('multiple panels', () => {
    test('tick delivers to all active panels independently', () => {
      const producer = makeProducer('myType', { full: 1 }, { delta: 1 });
      manager.registerProducer(producer);
      const webview1 = makeWebview();
      const webview2 = makeWebview();
      manager.subscribe('panel1', webview1 as any, 'myType', 'key1', 'tag1');
      manager.subscribe('panel2', webview2 as any, 'myType', 'key1', 'tag1');
      webview1.postMessage.resetHistory();
      webview2.postMessage.resetHistory();

      manager.tick();

      assert.ok(webview1.postMessage.calledOnce);
      assert.ok(webview2.postMessage.calledOnce);
    });

    test('pausing one panel does not affect another', () => {
      const producer = makeProducer('myType', { full: 1 }, { delta: 1 });
      manager.registerProducer(producer);
      const webview1 = makeWebview();
      const webview2 = makeWebview();
      manager.subscribe('panel1', webview1 as any, 'myType', 'key1', 'tag1');
      manager.subscribe('panel2', webview2 as any, 'myType', 'key1', 'tag1');
      manager.pausePanel('panel1');
      webview1.postMessage.resetHistory();
      webview2.postMessage.resetHistory();

      manager.tick();

      assert.ok(webview1.postMessage.notCalled);
      assert.ok(webview2.postMessage.calledOnce);
    });
  });
});
