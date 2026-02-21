/**
 * @fileoverview Unit tests for checkCopilotAuthAsync in cliCheckCore.
 *
 * Tests authentication checking logic using a mock process spawner
 * to simulate different CLI auth states.
 */

import * as assert from 'assert';
import { suite, test, teardown } from 'mocha';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { checkCopilotAuthAsync } from '../../../agent/cliCheckCore';
import { EventEmitter } from 'events';

/**
 * Creates a mock spawner where specific commands succeed or fail.
 */
function createMockSpawner(successCommands: Set<string>): IProcessSpawner {
  return {
    spawn(command: string, _args?: string[], _options?: any) {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      proc.pid = 1234;

      const fullCmd = command;
      const exitCode = successCommands.has(fullCmd) ? 0 : 1;
      setImmediate(() => proc.emit('close', exitCode));
      return proc;
    }
  };
}

suite('checkCopilotAuthAsync', () => {

  teardown(() => {
    const mod = require('../../../agent/cliCheckCore');
    mod.resetCliCache();
  });

  test('returns authenticated via gh when gh auth status succeeds', async () => {
    const spawner = createMockSpawner(new Set(['gh auth status']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: true, method: 'gh' });
  });

  test('returns authenticated via standalone when copilot auth status succeeds', async () => {
    const spawner = createMockSpawner(new Set(['copilot auth status']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: true, method: 'standalone' });
  });

  test('returns unauthenticated gh when gh --version succeeds but auth fails', async () => {
    const spawner = createMockSpawner(new Set(['gh --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'gh' });
  });

  test('returns unauthenticated standalone when copilot --version succeeds but auth fails', async () => {
    const spawner = createMockSpawner(new Set(['copilot --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'standalone' });
  });

  test('returns unknown when no CLI is found', async () => {
    const spawner = createMockSpawner(new Set());
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'unknown' });
  });

  test('prefers gh auth over standalone auth', async () => {
    // Both auth commands succeed, should return gh first
    const spawner = createMockSpawner(new Set(['gh auth status', 'copilot auth status']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: true, method: 'gh' });
  });

  test('prefers gh --version over copilot --version for unauthenticated', async () => {
    // Both version commands succeed but auth fails
    const spawner = createMockSpawner(new Set(['gh --version', 'copilot --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'gh' });
  });
});
