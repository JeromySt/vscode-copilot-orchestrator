import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { ManagedProcess } from '../../../process/managedProcess';
import { ProcessOutputBus } from '../../../process/processOutputBus';
import type { ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { OutputSources } from '../../../interfaces/IOutputHandler';
import type { OutputSource } from '../../../interfaces/IOutputHandler';
import type { ProcessTimestamps } from '../../../interfaces/IManagedProcess';

/** Create a fake ChildProcessLike backed by EventEmitter */
function makeFakeProc(overrides?: Partial<ChildProcessLike>): ChildProcessLike & EventEmitter {
  const emitter = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  const proc = Object.assign(emitter, {
    pid: 1234,
    exitCode: null as number | null,
    killed: false,
    stdout: stdoutEmitter as any,
    stderr: stderrEmitter as any,
    kill: sinon.stub().returns(true),
    ...overrides,
  });

  return proc as any;
}

function makeTimestamps(partial?: Partial<ProcessTimestamps>): ProcessTimestamps {
  return { requested: 100, created: 110, ...partial };
}

suite('ManagedProcess', () => {
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

  suite('stdout wiring', () => {
    test('should feed stdout data to bus', () => {
      const proc = makeFakeProc();
      const feedSpy = sandbox.spy(bus, 'feed');
      new ManagedProcess(proc, bus, [], makeTimestamps());

      proc.stdout!.emit('data', Buffer.from('hello\n'));

      assert.ok(feedSpy.calledOnce);
      assert.strictEqual(feedSpy.firstCall.args[0], 'hello\n');
      assert.deepStrictEqual(feedSpy.firstCall.args[1], OutputSources.stdout);
    });
  });

  suite('stderr wiring', () => {
    test('should feed stderr data to bus', () => {
      const proc = makeFakeProc();
      const feedSpy = sandbox.spy(bus, 'feed');
      new ManagedProcess(proc, bus, [], makeTimestamps());

      proc.stderr!.emit('data', Buffer.from('error\n'));

      assert.ok(feedSpy.calledOnce);
      assert.strictEqual(feedSpy.firstCall.args[0], 'error\n');
      assert.deepStrictEqual(feedSpy.firstCall.args[1], OutputSources.stderr);
    });
  });

  suite('handles null stdout/stderr', () => {
    test('should not throw when stdout is null', () => {
      const proc = makeFakeProc({ stdout: null });
      assert.doesNotThrow(() => {
        new ManagedProcess(proc, bus, [], makeTimestamps());
      });
    });

    test('should not throw when stderr is null', () => {
      const proc = makeFakeProc({ stderr: null });
      assert.doesNotThrow(() => {
        new ManagedProcess(proc, bus, [], makeTimestamps());
      });
    });
  });

  suite('timestamps', () => {
    test('should set running timestamp on first stdout data', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      assert.strictEqual(mp.timestamps.running, undefined);
      proc.stdout!.emit('data', Buffer.from('data\n'));
      assert.ok(mp.timestamps.running != null);
    });

    test('should set running timestamp on first stderr data', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      proc.stderr!.emit('data', Buffer.from('err\n'));
      assert.ok(mp.timestamps.running != null);
    });

    test('should not overwrite running timestamp on subsequent data', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      proc.stdout!.emit('data', Buffer.from('first\n'));
      const firstRunning = mp.timestamps.running;
      proc.stdout!.emit('data', Buffer.from('second\n'));
      assert.strictEqual(mp.timestamps.running, firstRunning);
    });

    test('should set exited timestamp on exit', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      proc.emit('exit', 0, null);
      assert.ok(mp.timestamps.exited != null);
    });

    test('should set killed timestamp on exit if killRequested was set', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      mp.kill();
      assert.ok(mp.timestamps.killRequested != null);

      proc.emit('exit', null, 'SIGTERM');
      assert.ok(mp.timestamps.killed != null);
    });

    test('should set exited on error event', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      proc.emit('error', new Error('spawn failed'));
      assert.ok(mp.timestamps.exited != null);
    });
  });

  suite('durations', () => {
    test('should compute total duration after exit', () => {
      const ts = makeTimestamps({ requested: 100 });
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], ts);

      proc.emit('exit', 0, null);

      assert.ok(mp.durations.total != null);
      assert.ok(mp.durations.total! > 0);
    });

    test('should compute spawnLatency from timestamps', () => {
      const ts = makeTimestamps({ requested: 100, created: 120 });
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], ts);

      assert.strictEqual(mp.durations.spawnLatency, 20);
    });

    test('should return undefined for durations when timestamps missing', () => {
      const ts: ProcessTimestamps = { requested: 100 };
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], ts);

      assert.strictEqual(mp.durations.total, undefined);
      assert.strictEqual(mp.durations.startupLatency, undefined);
      assert.strictEqual(mp.durations.processLifetime, undefined);
      assert.strictEqual(mp.durations.killLatency, undefined);
    });
  });

  suite('kill() platform dispatch', () => {
    test('should use taskkill on win32 when spawner is provided', () => {
      const proc = makeFakeProc();
      const mockSpawner: IProcessSpawner = {
        spawn: sandbox.stub().returns(makeFakeProc()),
      };
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), mockSpawner, 'win32');

      const result = mp.kill();

      assert.strictEqual(result, true);
      assert.ok((mockSpawner.spawn as sinon.SinonStub).calledOnce);
      const args = (mockSpawner.spawn as sinon.SinonStub).firstCall.args;
      assert.strictEqual(args[0], 'taskkill');
      assert.deepStrictEqual(args[1], ['/pid', '1234', '/f', '/t']);
    });

    test('should fall back to proc.kill on unix', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), undefined, 'linux');

      mp.kill('SIGTERM');

      assert.ok((proc.kill as sinon.SinonStub).calledWith('SIGTERM'));
    });

    test('should set killRequested timestamp', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), undefined, 'linux');

      mp.kill();
      assert.ok(mp.timestamps.killRequested != null);
    });

    test('should return false when taskkill throws on win32', () => {
      const proc = makeFakeProc();
      const mockSpawner: IProcessSpawner = {
        spawn: sandbox.stub().throws(new Error('taskkill failed')),
      };
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), mockSpawner, 'win32');

      const result = mp.kill();
      assert.strictEqual(result, false);
    });

    test('should fall back to proc.kill on win32 when no spawner', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), undefined, 'win32');

      mp.kill('SIGTERM');
      assert.ok((proc.kill as sinon.SinonStub).calledWith('SIGTERM'));
    });

    test('should fall back to proc.kill on win32 when no pid', () => {
      const proc = makeFakeProc({ pid: undefined });
      const mockSpawner: IProcessSpawner = {
        spawn: sandbox.stub().returns(makeFakeProc()),
      };
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), mockSpawner, 'win32');

      mp.kill('SIGTERM');
      assert.ok((proc.kill as sinon.SinonStub).calledWith('SIGTERM'));
      assert.ok(!(mockSpawner.spawn as sinon.SinonStub).called);
    });

    test('should escalate SIGTERM to SIGKILL after timeout on unix', async () => {
      const clock = sandbox.useFakeTimers();
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), undefined, 'linux');

      mp.kill('SIGTERM');

      // First call is the SIGTERM
      assert.ok((proc.kill as sinon.SinonStub).calledOnce);
      assert.ok((proc.kill as sinon.SinonStub).calledWith('SIGTERM'));

      // After 5 seconds, SIGKILL should be sent
      await clock.tickAsync(5000);

      assert.strictEqual((proc.kill as sinon.SinonStub).callCount, 2);
      assert.ok((proc.kill as sinon.SinonStub).secondCall.calledWith('SIGKILL'));

      clock.restore();
    });

    test('should not escalate to SIGKILL when signal is already SIGKILL', async () => {
      const clock = sandbox.useFakeTimers();
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps(), undefined, 'linux');

      mp.kill('SIGKILL');

      // Only one kill call (SIGKILL)
      assert.ok((proc.kill as sinon.SinonStub).calledOnce);

      // After 5 seconds, no escalation
      await clock.tickAsync(5000);
      assert.strictEqual((proc.kill as sinon.SinonStub).callCount, 1);

      clock.restore();
    });
  });

  suite('diagnostics()', () => {
    test('should return snapshot with all fields', () => {
      const proc = makeFakeProc();
      const handler = {
        name: 'test-handler',
        sources: [OutputSources.stdout],
        windowSize: 1,
        onLine: sandbox.stub(),
      };
      bus.register(handler);
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      const diag = mp.diagnostics();

      assert.strictEqual(diag.pid, 1234);
      assert.strictEqual(diag.exitCode, null);
      assert.strictEqual(diag.killed, false);
      assert.deepStrictEqual(diag.handlerNames, ['test-handler']);
      assert.ok(diag.timestamps);
      assert.ok(diag.durations !== undefined);
      assert.ok(diag.busMetrics !== undefined);
      assert.ok(Array.isArray(diag.tailerMetrics));
    });

    test('should include tailer metrics when log sources present', () => {
      const proc = makeFakeProc();
      // Use a file type to avoid mkdirSync
      sandbox.stub(require('fs'), 'mkdirSync');
      const mp = new ManagedProcess(proc, bus, [
        { name: 'debug', type: 'file', path: '/tmp/test.log', watch: false, pollIntervalMs: 60000 },
      ], makeTimestamps());

      const diag = mp.diagnostics();
      assert.strictEqual(diag.tailerMetrics.length, 1);

      // Clean up: trigger exit to stop tailers
      proc.emit('exit', 0, null);
    });
  });

  suite('on() delegation', () => {
    test('should delegate "line" event to internal emitter', () => {
      const proc = makeFakeProc();
      const handler = {
        name: 'h',
        sources: [OutputSources.stdout],
        windowSize: 1,
        onLine: sandbox.stub(),
      };
      bus.register(handler);
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      const lineCallback = sandbox.stub();
      mp.on('line', lineCallback);

      proc.stdout!.emit('data', Buffer.from('hello\n'));

      assert.ok(lineCallback.calledOnce);
      assert.strictEqual(lineCallback.firstCall.args[0], 'hello');
      assert.deepStrictEqual(lineCallback.firstCall.args[1], OutputSources.stdout);
    });

    test('should delegate other events to proc', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      const exitCallback = sandbox.stub();
      mp.on('exit', exitCallback);

      proc.emit('exit', 0, null);

      assert.ok(exitCallback.calledOnce);
    });

    test('should return this for chaining', () => {
      const proc = makeFakeProc();
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());

      const result = mp.on('line', () => {});
      assert.strictEqual(result, mp);
    });
  });

  suite('error cleanup', () => {
    test('should stop tailers on error event', () => {
      const proc = makeFakeProc();
      sandbox.stub(require('fs'), 'mkdirSync');
      const mp = new ManagedProcess(proc, bus, [
        { name: 'debug', type: 'file', path: '/tmp/test.log', watch: false, pollIntervalMs: 60000 },
      ], makeTimestamps());

      // Verify tailer was created (diagnostics shows 1 tailer)
      assert.strictEqual(mp.diagnostics().tailerMetrics.length, 1);

      proc.emit('error', new Error('spawn ENOENT'));

      // Tailer stop was called — no assertion on internals, just that it doesn't throw
      assert.ok(mp.timestamps.exited != null);
    });
  });

  suite('property delegation', () => {
    test('should delegate pid to proc', () => {
      const proc = makeFakeProc({ pid: 5678 });
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());
      assert.strictEqual(mp.pid, 5678);
    });

    test('should delegate exitCode to proc', () => {
      const proc = makeFakeProc();
      (proc as any).exitCode = 42;
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());
      assert.strictEqual(mp.exitCode, 42);
    });

    test('should delegate killed to proc', () => {
      const proc = makeFakeProc();
      (proc as any).killed = true;
      const mp = new ManagedProcess(proc, bus, [], makeTimestamps());
      assert.strictEqual(mp.killed, true);
    });
  });
});
