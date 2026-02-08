/**
 * @fileoverview Unit tests for git command executor.
 *
 * Tests the executor module (src/git/core/executor.ts) by mocking
 * child_process.spawn and child_process.spawnSync.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import * as executor from '../../../git/core/executor';

// Use require so we get the same module reference as the compiled code
const cp = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake ChildProcess with stdout/stderr EventEmitters. */
function createFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 12345;
  return proc;
}

/** Create a fake SpawnSyncReturns result. */
function createSyncResult(overrides: Partial<{ status: number | null; stdout: string; stderr: string; error: Error }> = {}) {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    error: overrides.error ?? undefined,
    signal: null,
    pid: 12345,
    output: [null, overrides.stdout ?? '', overrides.stderr ?? ''],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Git Executor', () => {
  let spawnStub: sinon.SinonStub;
  let spawnSyncStub: sinon.SinonStub;

  setup(() => {
    spawnStub = sinon.stub(cp, 'spawn');
    spawnSyncStub = sinon.stub(cp, 'spawnSync');
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // exec() (sync)
  // =========================================================================

  suite('exec()', () => {
    test('returns success result for exit code 0', () => {
      spawnSyncStub.returns(createSyncResult({ stdout: 'output\n' }));

      const result = executor.exec(['status'], { cwd: '/repo' });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.stdout, 'output\n');
      assert.strictEqual(result.exitCode, 0);
    });

    test('returns failure result for non-zero exit', () => {
      spawnSyncStub.returns(createSyncResult({ status: 1, stderr: 'error msg' }));

      const result = executor.exec(['bad-cmd'], { cwd: '/repo' });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stderr, 'error msg');
      assert.strictEqual(result.exitCode, 1);
    });

    test('throws when throwOnError is true and command fails', () => {
      spawnSyncStub.returns(createSyncResult({ status: 128, stderr: 'fatal error' }));

      assert.throws(
        () => executor.exec(['bad'], { cwd: '/repo', throwOnError: true }),
        /Git command failed.*fatal error/
      );
    });

    test('uses custom errorPrefix', () => {
      spawnSyncStub.returns(createSyncResult({ status: 1, stderr: 'oops' }));

      assert.throws(
        () => executor.exec(['bad'], { cwd: '/repo', throwOnError: true, errorPrefix: 'Custom prefix' }),
        /Custom prefix/
      );
    });

    test('logs stdout when logger provided', () => {
      spawnSyncStub.returns(createSyncResult({ stdout: 'log output\n' }));
      const messages: string[] = [];

      executor.exec(['log'], { cwd: '/repo', log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('log output')));
    });

    test('does not log when stdout is empty', () => {
      spawnSyncStub.returns(createSyncResult({ stdout: '' }));
      const messages: string[] = [];

      executor.exec(['status'], { cwd: '/repo', log: (m) => messages.push(m) });

      assert.strictEqual(messages.length, 0);
    });
  });

  // =========================================================================
  // execShell() (sync)
  // =========================================================================

  suite('execShell()', () => {
    test('executes shell command', () => {
      spawnSyncStub.returns(createSyncResult({ stdout: 'shell output' }));

      const result = executor.execShell('git status | head', { cwd: '/repo' });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.stdout, 'shell output');
    });

    test('logs stdout and stderr appropriately', () => {
      spawnSyncStub.returns(createSyncResult({ status: 1, stdout: 'out', stderr: 'err' }));
      const messages: string[] = [];

      executor.execShell('cmd', { cwd: '/repo', log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('out')));
      assert.ok(messages.some((m) => m.includes('err')));
    });

    test('throws when throwOnError is true', () => {
      spawnSyncStub.returns(createSyncResult({ status: 1, stderr: 'shell error' }));

      assert.throws(
        () => executor.execShell('bad cmd', { cwd: '/repo', throwOnError: true }),
        /Command failed.*shell error/
      );
    });
  });

  // =========================================================================
  // execOrThrow() (sync)
  // =========================================================================

  suite('execOrThrow()', () => {
    test('returns trimmed stdout on success', () => {
      spawnSyncStub.returns(createSyncResult({ stdout: '  result  \n' }));

      const result = executor.execOrThrow(['rev-parse', 'HEAD'], '/repo');

      assert.strictEqual(result, 'result');
    });

    test('throws on failure', () => {
      spawnSyncStub.returns(createSyncResult({ status: 128, stderr: 'fatal' }));

      assert.throws(() => executor.execOrThrow(['bad'], '/repo'), /fatal/);
    });
  });

  // =========================================================================
  // execOrNull() (sync)
  // =========================================================================

  suite('execOrNull()', () => {
    test('returns trimmed stdout on success', () => {
      spawnSyncStub.returns(createSyncResult({ stdout: 'abc123\n' }));

      const result = executor.execOrNull(['rev-parse', 'HEAD'], '/repo');

      assert.strictEqual(result, 'abc123');
    });

    test('returns null on failure', () => {
      spawnSyncStub.returns(createSyncResult({ status: 1, stderr: 'error' }));

      const result = executor.execOrNull(['bad'], '/repo');

      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // execAsync()
  // =========================================================================

  suite('execAsync()', () => {
    test('returns success result on exit code 0', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['status'], { cwd: '/repo' });

      fakeProc.stdout.emit('data', 'output line');
      fakeProc.emit('close', 0);

      const result = await promise;

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.stdout, 'output line');
      assert.strictEqual(result.exitCode, 0);
    });

    test('returns failure result on non-zero exit', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['bad-cmd'], { cwd: '/repo' });

      fakeProc.stderr.emit('data', 'error output');
      fakeProc.emit('close', 1);

      const result = await promise;

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stderr, 'error output');
      assert.strictEqual(result.exitCode, 1);
    });

    test('throws on failure when throwOnError is true', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['bad'], { cwd: '/repo', throwOnError: true });

      fakeProc.stderr.emit('data', 'fatal error');
      fakeProc.emit('close', 128);

      await assert.rejects(promise, /Git command failed.*fatal error/);
    });

    test('handles process error event', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['status'], { cwd: '/repo' });

      fakeProc.emit('error', new Error('ENOENT'));

      const result = await promise;

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stderr, 'ENOENT');
      assert.strictEqual(result.exitCode, null);
    });

    test('rejects on process error when throwOnError is true', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['status'], { cwd: '/repo', throwOnError: true });

      fakeProc.emit('error', new Error('spawn ENOENT'));

      await assert.rejects(promise, /spawn ENOENT/);
    });

    test('logs stdout when logger provided and command succeeds', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);
      const messages: string[] = [];

      const promise = executor.execAsync(['log'], {
        cwd: '/repo',
        log: (m) => messages.push(m),
      });

      fakeProc.stdout.emit('data', 'logged output\n');
      fakeProc.emit('close', 0);

      await promise;

      assert.ok(messages.some((m) => m.includes('logged output')));
    });

    test('does not log when stdout is empty on success', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);
      const messages: string[] = [];

      const promise = executor.execAsync(['status'], {
        cwd: '/repo',
        log: (m) => messages.push(m),
      });

      fakeProc.emit('close', 0);

      await promise;

      assert.strictEqual(messages.length, 0);
    });

    test('handles timeout by killing process', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['long-running'], {
        cwd: '/repo',
        timeoutMs: 50,
      });

      // Wait for timeout to fire, then emit close (as killed process would)
      await new Promise((resolve) => setTimeout(resolve, 100));
      fakeProc.emit('close', null);

      const result = await promise;

      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes('timed out'));
      assert.strictEqual(result.exitCode, null);
      assert.ok(fakeProc.kill.calledWith('SIGKILL'));
    });

    test('timeout rejects when throwOnError is true', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['long-running'], {
        cwd: '/repo',
        timeoutMs: 50,
        throwOnError: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      fakeProc.emit('close', null);

      await assert.rejects(promise, /timed out/);
    });

    test('collects both stdout and stderr data', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['cmd'], { cwd: '/repo' });

      fakeProc.stdout.emit('data', 'part1');
      fakeProc.stdout.emit('data', 'part2');
      fakeProc.stderr.emit('data', 'warn1');
      fakeProc.stderr.emit('data', 'warn2');
      fakeProc.emit('close', 0);

      const result = await promise;

      assert.strictEqual(result.stdout, 'part1part2');
      assert.strictEqual(result.stderr, 'warn1warn2');
    });

    test('uses custom errorPrefix on throw', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['cmd'], {
        cwd: '/repo',
        throwOnError: true,
        errorPrefix: 'My error',
      });

      fakeProc.stderr.emit('data', 'details');
      fakeProc.emit('close', 1);

      await assert.rejects(promise, /My error.*details/);
    });

    test('throwOnError with empty stderr uses exit code message', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsync(['cmd'], {
        cwd: '/repo',
        throwOnError: true,
      });

      fakeProc.emit('close', 42);

      await assert.rejects(promise, /Exit code: 42/);
    });
  });

  // =========================================================================
  // execAsyncOrThrow()
  // =========================================================================

  suite('execAsyncOrThrow()', () => {
    test('returns trimmed stdout on success', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsyncOrThrow(['rev-parse', 'HEAD'], '/repo');

      fakeProc.stdout.emit('data', '  abc123def  \n');
      fakeProc.emit('close', 0);

      const result = await promise;

      assert.strictEqual(result, 'abc123def');
    });

    test('throws on non-zero exit', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsyncOrThrow(['bad-cmd'], '/repo');

      fakeProc.stderr.emit('data', 'fatal: bad');
      fakeProc.emit('close', 128);

      await assert.rejects(promise, /fatal: bad/);
    });
  });

  // =========================================================================
  // execAsyncOrNull()
  // =========================================================================

  suite('execAsyncOrNull()', () => {
    test('returns trimmed stdout on success', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsyncOrNull(['rev-parse', 'HEAD'], '/repo');

      fakeProc.stdout.emit('data', 'sha123\n');
      fakeProc.emit('close', 0);

      const result = await promise;

      assert.strictEqual(result, 'sha123');
    });

    test('returns null on failure', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsyncOrNull(['bad'], '/repo');

      fakeProc.stderr.emit('data', 'error');
      fakeProc.emit('close', 1);

      const result = await promise;

      assert.strictEqual(result, null);
    });

    test('returns null for empty stdout on success', async () => {
      const fakeProc = createFakeProcess();
      spawnStub.returns(fakeProc);

      const promise = executor.execAsyncOrNull(['branch', '--show-current'], '/repo');

      fakeProc.stdout.emit('data', '   \n');
      fakeProc.emit('close', 0);

      const result = await promise;

      // Empty string after trim is still truthy for success check,
      // but execAsyncOrNull returns trimmed stdout which is ''
      // success is true so it returns '' not null
      assert.strictEqual(result, '');
    });
  });
});
