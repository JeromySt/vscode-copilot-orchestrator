import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { TaskCompleteHandler, TaskCompleteHandlerFactory } from '../../../../agent/handlers/taskCompleteHandler';
import { OutputSources } from '../../../../interfaces/IOutputHandler';

suite('TaskCompleteHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let handler: TaskCompleteHandler;

  setup(() => {
    sandbox = sinon.createSandbox();
    handler = new TaskCompleteHandler();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('metadata', () => {
    test('should have correct name', () => {
      assert.strictEqual(handler.name, 'task-complete');
    });

    test('should listen to stdout only', () => {
      assert.deepStrictEqual(handler.sources, [OutputSources.stdout]);
    });

    test('should have windowSize of 1', () => {
      assert.strictEqual(handler.windowSize, 1);
    });
  });

  suite('onLine', () => {
    test('should detect "Task complete" marker', () => {
      handler.onLine(['Task complete'], OutputSources.stdout);
      assert.strictEqual(handler.sawTaskComplete(), true);
    });

    test('should detect marker when embedded in surrounding text', () => {
      handler.onLine(['[INFO] Task complete - shutting down'], OutputSources.stdout);
      assert.strictEqual(handler.sawTaskComplete(), true);
    });

    test('should not be set before marker is seen', () => {
      assert.strictEqual(handler.sawTaskComplete(), false);
      handler.onLine(['some other output'], OutputSources.stdout);
      assert.strictEqual(handler.sawTaskComplete(), false);
    });

    test('should stay true once set', () => {
      handler.onLine(['Task complete'], OutputSources.stdout);
      handler.onLine(['more output'], OutputSources.stdout);
      assert.strictEqual(handler.sawTaskComplete(), true);
    });

    test('should not match partial text', () => {
      handler.onLine(['Task'], OutputSources.stdout);
      assert.strictEqual(handler.sawTaskComplete(), false);
    });
  });

  suite('TaskCompleteHandlerFactory', () => {
    test('should have correct name', () => {
      assert.strictEqual(TaskCompleteHandlerFactory.name, 'task-complete');
    });

    test('should filter for copilot processes', () => {
      assert.deepStrictEqual(TaskCompleteHandlerFactory.processFilter, ['copilot']);
    });

    test('should create a TaskCompleteHandler instance', () => {
      const created = TaskCompleteHandlerFactory.create({ processLabel: 'copilot' });
      assert.ok(created instanceof TaskCompleteHandler);
    });
  });
});
