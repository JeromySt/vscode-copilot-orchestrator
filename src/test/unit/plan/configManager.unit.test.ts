/**
 * @fileoverview Unit tests for PlanConfigManager
 */
import * as assert from 'assert';
import { PlanConfigManager } from '../../../plan/configManager';
import type { IConfigProvider } from '../../../interfaces/IConfigProvider';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

class MockConfigProvider implements IConfigProvider {
  private data: Map<string, any> = new Map();

  set(section: string, key: string, value: any): void {
    this.data.set(`${section}.${key}`, value);
  }

  getConfig<T>(section: string, key: string, defaultValue: T): T {
    const k = `${section}.${key}`;
    return this.data.has(k) ? this.data.get(k) as T : defaultValue;
  }
}

suite('PlanConfigManager', () => {
  let quiet: { restore: () => void };

  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  test('returns defaults when no provider', () => {
    const cfg = new PlanConfigManager();
    assert.strictEqual(cfg.getConfig('section', 'key', 42), 42);
    assert.strictEqual(cfg.getConfig('section', 'key', 'hello'), 'hello');
  });

  test('returns defaults when provider has no value', () => {
    const provider = new MockConfigProvider();
    const cfg = new PlanConfigManager(provider);
    assert.strictEqual(cfg.getConfig('section', 'key', 'default'), 'default');
  });

  test('returns provider value when set', () => {
    const provider = new MockConfigProvider();
    provider.set('section', 'key', 'custom');
    const cfg = new PlanConfigManager(provider);
    assert.strictEqual(cfg.getConfig('section', 'key', 'default'), 'custom');
  });

  test('pushOnSuccess defaults to false', () => {
    const cfg = new PlanConfigManager();
    assert.strictEqual(cfg.pushOnSuccess, false);
  });

  test('pushOnSuccess returns provider value', () => {
    const provider = new MockConfigProvider();
    provider.set('copilotOrchestrator.merge', 'pushOnSuccess', true);
    const cfg = new PlanConfigManager(provider);
    assert.strictEqual(cfg.pushOnSuccess, true);
  });

  test('mergePrefer defaults to theirs', () => {
    const cfg = new PlanConfigManager();
    assert.strictEqual(cfg.mergePrefer, 'theirs');
  });

  test('mergePrefer returns provider value', () => {
    const provider = new MockConfigProvider();
    provider.set('copilotOrchestrator.merge', 'prefer', 'ours');
    const cfg = new PlanConfigManager(provider);
    assert.strictEqual(cfg.mergePrefer, 'ours');
  });

  test('getConfig with boolean type', () => {
    const provider = new MockConfigProvider();
    provider.set('s', 'k', false);
    const cfg = new PlanConfigManager(provider);
    assert.strictEqual(cfg.getConfig('s', 'k', true), false);
  });

  test('getConfig with number type', () => {
    const provider = new MockConfigProvider();
    provider.set('s', 'k', 99);
    const cfg = new PlanConfigManager(provider);
    assert.strictEqual(cfg.getConfig('s', 'k', 0), 99);
  });
});
