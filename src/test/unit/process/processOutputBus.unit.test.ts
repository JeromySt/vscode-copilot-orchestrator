import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProcessOutputBus } from '../../../process/processOutputBus';
import type { IOutputHandler, OutputSource } from '../../../interfaces/IOutputHandler';
import { OutputSources } from '../../../interfaces/IOutputHandler';

function makeHandler(overrides: Partial<IOutputHandler> & { name: string }): IOutputHandler {
  return {
    sources: [OutputSources.stdout],
    windowSize: 1,
    onLine: sinon.stub(),
    dispose: sinon.stub(),
    ...overrides,
  };
}

suite('ProcessOutputBus', () => {
  let sandbox: sinon.SinonSandbox;
  let bus: ProcessOutputBus;

  setup(() => {
    sandbox = sinon.createSandbox();
    bus = new ProcessOutputBus();
  });

  teardown(() => {
    bus.dispose();
    sandbox.restore();
  });

  suite('basic line dispatch', () => {
    test('should dispatch a complete line to a matching handler', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);
      bus.feed('hello world\n', OutputSources.stdout);

      assert.ok((handler.onLine as sinon.SinonStub).calledOnce);
      const [window, source] = (handler.onLine as sinon.SinonStub).firstCall.args;
      assert.deepStrictEqual(window, ['hello world']);
      assert.deepStrictEqual(source, OutputSources.stdout);
    });

    test('should dispatch multiple lines from a single chunk', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);
      bus.feed('line1\nline2\nline3\n', OutputSources.stdout);

      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 3);
    });

    test('should buffer partial lines until newline arrives', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);
      bus.feed('partial', OutputSources.stdout);
      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 0);

      bus.feed(' complete\n', OutputSources.stdout);
      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 1);
      const [window] = (handler.onLine as sinon.SinonStub).firstCall.args;
      assert.deepStrictEqual(window, ['partial complete']);
    });

    test('should handle \\r\\n line endings', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);
      bus.feed('line1\r\nline2\r\n', OutputSources.stdout);

      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 2);
    });

    test('should skip empty lines', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);
      bus.feed('line1\n\n\nline2\n', OutputSources.stdout);

      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 2);
    });
  });

  suite('handler error isolation', () => {
    test('should catch handler error and continue to next handler', () => {
      const badHandler = makeHandler({ name: 'bad' });
      (badHandler.onLine as sinon.SinonStub).throws(new Error('boom'));

      const goodHandler = makeHandler({ name: 'good' });

      bus.register(badHandler);
      bus.register(goodHandler);
      bus.feed('test line\n', OutputSources.stdout);

      assert.ok((badHandler.onLine as sinon.SinonStub).calledOnce);
      assert.ok((goodHandler.onLine as sinon.SinonStub).calledOnce);
    });

    test('should increment handlerErrors metric on handler throw', () => {
      const badHandler = makeHandler({ name: 'bad' });
      (badHandler.onLine as sinon.SinonStub).throws(new Error('boom'));

      bus.register(badHandler);
      bus.feed('test\n', OutputSources.stdout);

      assert.strictEqual(bus.getMetrics().handlerErrors, 1);
    });
  });

  suite('windowSize=1 fast path', () => {
    test('should pass single-element array without window allocation', () => {
      const handler = makeHandler({ name: 'h1', windowSize: 1 });
      bus.register(handler);

      bus.feed('a\nb\nc\n', OutputSources.stdout);

      // Each call gets exactly [line], not accumulated
      const calls = (handler.onLine as sinon.SinonStub).getCalls();
      assert.deepStrictEqual(calls[0].args[0], ['a']);
      assert.deepStrictEqual(calls[1].args[0], ['b']);
      assert.deepStrictEqual(calls[2].args[0], ['c']);
    });
  });

  suite('sliding window', () => {
    test('should provide window of correct size for windowSize>1', () => {
      const received: string[][] = [];
      const handler: IOutputHandler = {
        name: 'h1',
        sources: [OutputSources.stdout],
        windowSize: 3,
        onLine(window: ReadonlyArray<string>) { received.push([...window]); },
      };
      bus.register(handler);

      bus.feed('a\nb\nc\nd\n', OutputSources.stdout);

      assert.deepStrictEqual(received[0], ['a']);
      assert.deepStrictEqual(received[1], ['a', 'b']);
      assert.deepStrictEqual(received[2], ['a', 'b', 'c']);
      assert.deepStrictEqual(received[3], ['b', 'c', 'd']); // window slides
    });

    test('should pass only handler.windowSize lines when maxWin > handler.windowSize', () => {
      const bigReceived: string[][] = [];
      const smallReceived: string[][] = [];
      const bigHandler: IOutputHandler = {
        name: 'big',
        sources: [OutputSources.stdout],
        windowSize: 5,
        onLine(window: ReadonlyArray<string>) { bigReceived.push([...window]); },
      };
      const smallHandler: IOutputHandler = {
        name: 'small',
        sources: [OutputSources.stdout],
        windowSize: 2,
        onLine(window: ReadonlyArray<string>) { smallReceived.push([...window]); },
      };
      bus.register(bigHandler);
      bus.register(smallHandler);

      bus.feed('a\nb\nc\nd\ne\n', OutputSources.stdout);

      // smallHandler should always get at most 2 lines
      for (const win of smallReceived) {
        assert.ok(win.length <= 2, `expected <= 2, got ${win.length}`);
      }
      // On line 'e', small should get ['d', 'e']
      assert.deepStrictEqual(smallReceived[4], ['d', 'e']);
    });
  });

  suite('MAX_LINE_LENGTH forced break', () => {
    test('should force line break when buffer exceeds 65536 chars', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);

      // Feed a chunk larger than MAX_LINE_LENGTH without newline
      const longLine = 'x'.repeat(70_000);
      bus.feed(longLine, OutputSources.stdout);

      // The entire chunk should be pushed as a forced line
      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 1);
      const [window] = (handler.onLine as sinon.SinonStub).firstCall.args;
      assert.strictEqual(window[0].length, 70_000);
    });

    test('should continue buffering after forced break', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);

      const longLine = 'x'.repeat(70_000);
      bus.feed(longLine, OutputSources.stdout);
      bus.feed('next\n', OutputSources.stdout);

      assert.strictEqual((handler.onLine as sinon.SinonStub).callCount, 2);
      const [window] = (handler.onLine as sinon.SinonStub).secondCall.args;
      assert.deepStrictEqual(window, ['next']);
    });
  });

  suite('metrics counting', () => {
    test('should count linesBySource correctly', () => {
      const handler = makeHandler({
        name: 'h1',
        sources: [OutputSources.stdout, OutputSources.stderr],
      });
      bus.register(handler);

      bus.feed('a\nb\n', OutputSources.stdout);
      bus.feed('c\n', OutputSources.stderr);

      const metrics = bus.getMetrics();
      assert.strictEqual(metrics.linesBySource['stdout'], 2);
      assert.strictEqual(metrics.linesBySource['stderr'], 1);
    });

    test('should count handlerInvocations', () => {
      const h1 = makeHandler({ name: 'h1' });
      const h2 = makeHandler({ name: 'h2' });
      bus.register(h1);
      bus.register(h2);

      bus.feed('line\n', OutputSources.stdout);

      // Both handlers invoked once each
      assert.strictEqual(bus.getMetrics().handlerInvocations, 2);
    });

    test('should count handlerErrors', () => {
      const bad1 = makeHandler({ name: 'bad1' });
      const bad2 = makeHandler({ name: 'bad2' });
      (bad1.onLine as sinon.SinonStub).throws(new Error('err1'));
      (bad2.onLine as sinon.SinonStub).throws(new Error('err2'));
      bus.register(bad1);
      bus.register(bad2);

      bus.feed('line\n', OutputSources.stdout);

      assert.strictEqual(bus.getMetrics().handlerErrors, 2);
      assert.strictEqual(bus.getMetrics().handlerInvocations, 0);
    });
  });

  suite('multiple handlers on same source', () => {
    test('should invoke all handlers matching the source', () => {
      const h1 = makeHandler({ name: 'h1' });
      const h2 = makeHandler({ name: 'h2' });
      bus.register(h1);
      bus.register(h2);

      bus.feed('test\n', OutputSources.stdout);

      assert.ok((h1.onLine as sinon.SinonStub).calledOnce);
      assert.ok((h2.onLine as sinon.SinonStub).calledOnce);
    });
  });

  suite('handler on different source not called', () => {
    test('should not call handler registered for stderr when feeding stdout', () => {
      const stderrHandler = makeHandler({
        name: 'stderr-h',
        sources: [OutputSources.stderr],
      });
      bus.register(stderrHandler);

      bus.feed('stdout line\n', OutputSources.stdout);

      assert.strictEqual((stderrHandler.onLine as sinon.SinonStub).callCount, 0);
    });

    test('should not call handler registered for log-file when feeding stdout', () => {
      const logHandler = makeHandler({
        name: 'log-h',
        sources: [OutputSources.logFile('debug-log')],
      });
      bus.register(logHandler);

      bus.feed('stdout line\n', OutputSources.stdout);

      assert.strictEqual((logHandler.onLine as sinon.SinonStub).callCount, 0);
    });

    test('should dispatch log-file source to matching handler', () => {
      const logHandler = makeHandler({
        name: 'log-h',
        sources: [OutputSources.logFile('debug-log')],
      });
      bus.register(logHandler);

      bus.feed('log entry\n', OutputSources.logFile('debug-log'));

      assert.ok((logHandler.onLine as sinon.SinonStub).calledOnce);
    });
  });

  suite('line callback', () => {
    test('should fire line callback for every line', () => {
      const cb = sandbox.stub();
      bus.setLineCallback(cb);

      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);

      bus.feed('a\nb\nc\n', OutputSources.stdout);

      assert.strictEqual(cb.callCount, 3);
      assert.strictEqual(cb.firstCall.args[0], 'a');
      assert.deepStrictEqual(cb.firstCall.args[1], OutputSources.stdout);
      assert.strictEqual(cb.secondCall.args[0], 'b');
      assert.strictEqual(cb.thirdCall.args[0], 'c');
    });

    test('should work without line callback set', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);

      // Should not throw when no callback is set
      bus.feed('line\n', OutputSources.stdout);
      assert.ok((handler.onLine as sinon.SinonStub).calledOnce);
    });
  });

  suite('dispose()', () => {
    test('should call handler.dispose() on all handlers', () => {
      const h1 = makeHandler({ name: 'h1' });
      const h2 = makeHandler({ name: 'h2' });
      bus.register(h1);
      bus.register(h2);

      bus.dispose();

      assert.ok((h1.dispose as sinon.SinonStub).calledOnce);
      assert.ok((h2.dispose as sinon.SinonStub).calledOnce);
    });

    test('should handle handlers without dispose gracefully', () => {
      const handler: IOutputHandler = {
        name: 'no-dispose',
        sources: [OutputSources.stdout],
        windowSize: 1,
        onLine: sandbox.stub(),
        // no dispose method
      };
      bus.register(handler);

      // Should not throw
      bus.dispose();
    });

    test('should clear internal state after dispose', () => {
      const handler = makeHandler({ name: 'h1' });
      bus.register(handler);
      bus.feed('line\n', OutputSources.stdout);

      bus.dispose();

      assert.deepStrictEqual(bus.getHandlerNames(), []);
      assert.strictEqual(bus.getHandler('h1'), undefined);
    });
  });

  suite('getHandler()', () => {
    test('should return registered handler by name', () => {
      const handler = makeHandler({ name: 'my-handler' });
      bus.register(handler);

      const retrieved = bus.getHandler('my-handler');
      assert.strictEqual(retrieved, handler);
    });

    test('should return undefined for unknown name', () => {
      assert.strictEqual(bus.getHandler('nonexistent'), undefined);
    });
  });

  suite('getHandlerNames()', () => {
    test('should return all registered handler names', () => {
      bus.register(makeHandler({ name: 'a' }));
      bus.register(makeHandler({ name: 'b' }));
      bus.register(makeHandler({ name: 'c' }));

      const names = bus.getHandlerNames();
      assert.deepStrictEqual(names.sort(), ['a', 'b', 'c']);
    });

    test('should return empty array when no handlers registered', () => {
      assert.deepStrictEqual(bus.getHandlerNames(), []);
    });
  });

  suite('no handlers for source', () => {
    test('should not throw when feeding a source with no handlers', () => {
      bus.feed('data\n', OutputSources.stdout);
      // No handlers registered — should silently skip
      assert.deepStrictEqual(bus.getMetrics().linesBySource, {});
    });
  });
});
