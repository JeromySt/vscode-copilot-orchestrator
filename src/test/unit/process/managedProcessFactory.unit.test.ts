import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { ManagedProcessFactory } from '../../../process/managedProcessFactory';
import type { IOutputHandlerRegistry, HandlerContext } from '../../../interfaces/IOutputHandlerRegistry';
import type { IProcessSpawner, ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import type { IEnvironment } from '../../../interfaces/IEnvironment';
import type { IOutputHandler } from '../../../interfaces/IOutputHandler';
import { OutputSources } from '../../../interfaces/IOutputHandler';

function makeFakeProc(): ChildProcessLike {
  const emitter = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  return Object.assign(emitter, {
    pid: 1234,
    exitCode: null as number | null,
    killed: false,
    stdout: stdoutEmitter as any,
    stderr: stderrEmitter as any,
    kill: sinon.stub().returns(true),
  }) as any;
}

function makeHandler(name: string): IOutputHandler {
  return {
    name,
    sources: [OutputSources.stdout],
    windowSize: 1,
    onLine: sinon.stub(),
    dispose: sinon.stub(),
  };
}

suite('ManagedProcessFactory', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRegistry: IOutputHandlerRegistry;
  let mockSpawner: IProcessSpawner;
  let mockEnvironment: IEnvironment;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRegistry = {
      registerFactory: sandbox.stub(),
      createHandlers: sandbox.stub().returns([]),
    };
    mockSpawner = {
      spawn: sandbox.stub().returns(makeFakeProc()),
    };
    mockEnvironment = {
      env: {},
      platform: 'linux',
      cwd: () => '/home/user',
    };
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('create', () => {
    test('should create a ManagedProcess with bus and handlers', () => {
      const handler = makeHandler('test-h');
      (mockRegistry.createHandlers as sinon.SinonStub).returns([handler]);

      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const proc = makeFakeProc();
      const managed = factory.create(proc, { label: 'copilot' });

      assert.ok(managed);
      assert.strictEqual(managed.pid, 1234);
      assert.deepStrictEqual(managed.bus.getHandlerNames(), ['test-h']);
    });

    test('should pass context to registry.createHandlers', () => {
      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const proc = makeFakeProc();

      factory.create(proc, {
        label: 'copilot',
        planId: 'p1',
        nodeId: 'n1',
        worktreePath: '/work',
      });

      const call = (mockRegistry.createHandlers as sinon.SinonStub).firstCall;
      assert.deepStrictEqual(call.args[0], {
        processLabel: 'copilot',
        planId: 'p1',
        nodeId: 'n1',
        worktreePath: '/work',
      });
    });

    test('should set timestamps.requested and timestamps.created', () => {
      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const proc = makeFakeProc();
      const managed = factory.create(proc, { label: 'copilot' });

      assert.ok(managed.timestamps.requested != null);
      assert.ok(managed.timestamps.created != null);
      assert.ok(managed.timestamps.requested <= managed.timestamps.created);
    });

    test('should register multiple handlers on bus', () => {
      const h1 = makeHandler('h1');
      const h2 = makeHandler('h2');
      (mockRegistry.createHandlers as sinon.SinonStub).returns([h1, h2]);

      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const managed = factory.create(makeFakeProc(), { label: 'copilot' });

      assert.deepStrictEqual(managed.bus.getHandlerNames().sort(), ['h1', 'h2']);
    });

    test('should handle empty logSources by default', () => {
      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const managed = factory.create(makeFakeProc(), { label: 'copilot' });

      assert.deepStrictEqual(managed.diagnostics().tailerMetrics, []);
    });

    test('should pass platform from environment to ManagedProcess', () => {
      mockEnvironment = { ...mockEnvironment, platform: 'win32' };
      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const proc = makeFakeProc();
      const managed = factory.create(proc, { label: 'copilot' });

      // Verify platform pass-through by calling kill — should use taskkill
      managed.kill();
      assert.ok((mockSpawner.spawn as sinon.SinonStub).calledOnce);
      assert.strictEqual((mockSpawner.spawn as sinon.SinonStub).firstCall.args[0], 'taskkill');
    });

    test('should work when registry returns no handlers', () => {
      (mockRegistry.createHandlers as sinon.SinonStub).returns([]);
      const factory = new ManagedProcessFactory(mockRegistry, mockSpawner, mockEnvironment);
      const managed = factory.create(makeFakeProc(), { label: 'copilot' });

      assert.deepStrictEqual(managed.bus.getHandlerNames(), []);
    });
  });
});
