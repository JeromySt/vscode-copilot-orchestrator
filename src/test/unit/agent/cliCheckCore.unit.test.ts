/**
 * @fileoverview Unit tests for checkCopilotAuthAsync in cliCheckCore.
 *
 * Tests the complete authentication checking flow including different CLI variants
 * and auth states as specified in the task instructions.
 */

import * as assert from 'assert';
import { suite, test, teardown } from 'mocha';
import type { IProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { checkCopilotAuthAsync } from '../../../agent/cliCheckCore';
import { EventEmitter } from 'events';

/**
 * Creates a mock process spawner that simulates command success/failure.
 * Commands in successCommands set will exit with code 0, others with code 1.
 */
function createMockSpawner(successCommands: Set<string>): IProcessSpawner {
  return {
    spawn(command: string, _args?: string[], _options?: any) {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      proc.pid = 1234;

      const exitCode = successCommands.has(command) ? 0 : 1;
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

  test('should return authenticated=true method=gh when gh auth status succeeds', async () => {
    const spawner = createMockSpawner(new Set(['gh auth status']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: true, method: 'gh' });
  });

  test('should return authenticated=true method=standalone when copilot auth status succeeds', async () => {
    const spawner = createMockSpawner(new Set(['copilot auth status']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: true, method: 'standalone' });
  });

  test('should return authenticated=false method=gh when gh is installed but not authed', async () => {
    const spawner = createMockSpawner(new Set(['gh --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'gh' });
  });

  test('should return authenticated=false method=standalone when copilot is installed but not authed', async () => {
    const spawner = createMockSpawner(new Set(['copilot --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'standalone' });
  });

  test('should return authenticated=false method=unknown when nothing is installed', async () => {
    const spawner = createMockSpawner(new Set());
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'unknown' });
  });

  test('should prefer gh auth over standalone when both succeed', async () => {
    const spawner = createMockSpawner(new Set(['gh auth status', 'copilot auth status']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: true, method: 'gh' });
  });

  test('should prefer gh version over copilot version for unauthenticated detection', async () => {
    const spawner = createMockSpawner(new Set(['gh --version', 'copilot --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.deepStrictEqual(result, { authenticated: false, method: 'gh' });
  });

  test('should handle partial CLI installation (standalone auth fails, fallback to version check)', async () => {
    const spawner = createMockSpawner(new Set(['copilot --version']));
    const result = await checkCopilotAuthAsync(spawner);
    assert.strictEqual(result.authenticated, false);
    assert.strictEqual(result.method, 'standalone');
  });

  test('should check authentication before version commands', async () => {
    const callOrder: string[] = [];
    const trackingSpawner: IProcessSpawner = {
      spawn(command: string, _args?: string[], _options?: any) {
        callOrder.push(command);
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => {};
        proc.pid = 1234;
        setImmediate(() => proc.emit('close', 1));
        return proc;
      }
    };

    await checkCopilotAuthAsync(trackingSpawner);
    
    assert.ok(callOrder.indexOf('gh auth status') < callOrder.indexOf('gh --version'),
      'gh auth status should be checked before gh --version');
    assert.ok(callOrder.indexOf('copilot auth status') < callOrder.indexOf('copilot --version'),
      'copilot auth status should be checked before copilot --version');
  });
});
