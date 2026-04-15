import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { OutputHandlerRegistry } from '../../../process/outputHandlerRegistry';
import type { IOutputHandlerFactory, HandlerContext } from '../../../interfaces/IOutputHandlerRegistry';
import type { IOutputHandler } from '../../../interfaces/IOutputHandler';
import { OutputSources } from '../../../interfaces/IOutputHandler';

function makeFactory(overrides: Partial<IOutputHandlerFactory> & { name: string }): IOutputHandlerFactory {
  return {
    processFilter: ['*'],
    create: sinon.stub().returns({
      name: overrides.name + '-handler',
      sources: [OutputSources.stdout],
      windowSize: 1,
      onLine: sinon.stub(),
    }),
    ...overrides,
  };
}

function makeContext(label = 'copilot'): HandlerContext {
  return { processLabel: label, planId: 'plan-1', nodeId: 'node-1', worktreePath: '/work' };
}

suite('OutputHandlerRegistry', () => {
  let sandbox: sinon.SinonSandbox;
  let registry: OutputHandlerRegistry;

  setup(() => {
    sandbox = sinon.createSandbox();
    registry = new OutputHandlerRegistry();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('registerFactory', () => {
    test('should store a factory by name', () => {
      const factory = makeFactory({ name: 'stats' });
      registry.registerFactory(factory);

      const handlers = registry.createHandlers(makeContext());
      assert.strictEqual(handlers.length, 1);
    });

    test('should overwrite factory with same name', () => {
      const factory1 = makeFactory({ name: 'stats' });
      const factory2 = makeFactory({ name: 'stats' });
      registry.registerFactory(factory1);
      registry.registerFactory(factory2);

      registry.createHandlers(makeContext());
      assert.ok(!(factory1.create as sinon.SinonStub).called);
      assert.ok((factory2.create as sinon.SinonStub).calledOnce);
    });
  });

  suite('createHandlers', () => {
    test('should match factory with wildcard processFilter', () => {
      const factory = makeFactory({ name: 'wildcard', processFilter: ['*'] });
      registry.registerFactory(factory);

      const handlers = registry.createHandlers(makeContext('git'));
      assert.strictEqual(handlers.length, 1);
      assert.ok((factory.create as sinon.SinonStub).calledOnce);
    });

    test('should match factory with exact processFilter', () => {
      const factory = makeFactory({ name: 'copilot-only', processFilter: ['copilot'] });
      registry.registerFactory(factory);

      const handlers = registry.createHandlers(makeContext('copilot'));
      assert.strictEqual(handlers.length, 1);
    });

    test('should not match factory when label does not match processFilter', () => {
      const factory = makeFactory({ name: 'copilot-only', processFilter: ['copilot'] });
      registry.registerFactory(factory);

      const handlers = registry.createHandlers(makeContext('git'));
      assert.strictEqual(handlers.length, 0);
      assert.ok(!(factory.create as sinon.SinonStub).called);
    });

    test('should filter out undefined returns from factories', () => {
      const factory = makeFactory({ name: 'skip' });
      (factory.create as sinon.SinonStub).returns(undefined);
      registry.registerFactory(factory);

      const handlers = registry.createHandlers(makeContext());
      assert.strictEqual(handlers.length, 0);
    });

    test('should return handlers from multiple matching factories', () => {
      registry.registerFactory(makeFactory({ name: 'f1', processFilter: ['*'] }));
      registry.registerFactory(makeFactory({ name: 'f2', processFilter: ['copilot'] }));
      registry.registerFactory(makeFactory({ name: 'f3', processFilter: ['git'] }));

      const handlers = registry.createHandlers(makeContext('copilot'));
      // f1 (wildcard) + f2 (copilot match) = 2, f3 skipped
      assert.strictEqual(handlers.length, 2);
    });

    test('should pass full context to factory.create', () => {
      const factory = makeFactory({ name: 'ctx-check' });
      registry.registerFactory(factory);

      const ctx = makeContext('copilot');
      registry.createHandlers(ctx);

      const call = (factory.create as sinon.SinonStub).firstCall;
      assert.deepStrictEqual(call.args[0], ctx);
    });

    test('should return empty array when no factories registered', () => {
      const handlers = registry.createHandlers(makeContext());
      assert.deepStrictEqual(handlers, []);
    });

    test('should support factory with multiple labels in processFilter', () => {
      const factory = makeFactory({ name: 'multi', processFilter: ['copilot', 'git'] });
      registry.registerFactory(factory);

      assert.strictEqual(registry.createHandlers(makeContext('copilot')).length, 1);
      assert.strictEqual(registry.createHandlers(makeContext('git')).length, 1);
      assert.strictEqual(registry.createHandlers(makeContext('gh')).length, 0);
    });
  });
});
