/**
 * @fileoverview Coverage tests for createStubProcessSpawner in compositionTest.ts
 */
import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as Tokens from '../../core/tokens';
import { createTestContainer } from '../helpers/compositionTest';
import type { IProcessSpawner } from '../../interfaces';

suite('compositionTest - stubProcessSpawner coverage', () => {
  test('stub spawner returns a mock process object', () => {
    const container = createTestContainer();
    const spawner = container.resolve<IProcessSpawner>(Tokens.IProcessSpawner);
    const proc = spawner.spawn('echo', ['hello'], {});

    assert.strictEqual(proc.pid, 12345);
    assert.strictEqual(proc.exitCode, null);
    assert.strictEqual(proc.killed, false);
    assert.strictEqual(proc.stdout, null);
    assert.strictEqual(proc.stderr, null);
    assert.strictEqual(typeof proc.kill, 'function');
    assert.strictEqual(typeof proc.on, 'function');
  });

  test('stub spawner kill returns true', () => {
    const container = createTestContainer();
    const spawner = container.resolve<IProcessSpawner>(Tokens.IProcessSpawner);
    const proc = spawner.spawn('test', [], {});
    assert.strictEqual(proc.kill(), true);
  });

  test('stub spawner on returns object', () => {
    const container = createTestContainer();
    const spawner = container.resolve<IProcessSpawner>(Tokens.IProcessSpawner);
    const proc = spawner.spawn('test', [], {});
    const result = proc.on('exit', () => {});
    assert.ok(result !== undefined);
  });
});
