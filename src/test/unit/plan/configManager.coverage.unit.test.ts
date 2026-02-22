/**
 * Coverage tests for src/plan/configManager.ts
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanConfigManager } from '../../../plan/configManager';

suite('configManager - coverage', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns default when no provider', () => {
    const manager = new PlanConfigManager();
    assert.strictEqual(manager.getConfig('section', 'key', 'default'), 'default');
  });

  test('uses provider when available', () => {
    const mockProvider: any = {
      getConfig: sandbox.stub().returns('value')
    };
    const manager = new PlanConfigManager(mockProvider);
    const result = manager.getConfig('section', 'key', 'default');
    assert.strictEqual(result, 'value');
    assert.ok(mockProvider.getConfig.calledWith('section', 'key', 'default'));
  });

  test('pushOnSuccess returns default false when no provider', () => {
    const manager = new PlanConfigManager();
    assert.strictEqual(manager.pushOnSuccess, false);
  });

  test('pushOnSuccess uses provider', () => {
    const mockProvider: any = {
      getConfig: sandbox.stub().returns(true)
    };
    const manager = new PlanConfigManager(mockProvider);
    assert.strictEqual(manager.pushOnSuccess, true);
    assert.ok(mockProvider.getConfig.calledWith('copilotOrchestrator.merge', 'pushOnSuccess', false));
  });

  test('mergePrefer returns default theirs when no provider', () => {
    const manager = new PlanConfigManager();
    assert.strictEqual(manager.mergePrefer, 'theirs');
  });

  test('mergePrefer uses provider', () => {
    const mockProvider: any = {
      getConfig: sandbox.stub().returns('ours')
    };
    const manager = new PlanConfigManager(mockProvider);
    assert.strictEqual(manager.mergePrefer, 'ours');
    assert.ok(mockProvider.getConfig.calledWith('copilotOrchestrator.merge', 'prefer', 'theirs'));
  });
});
