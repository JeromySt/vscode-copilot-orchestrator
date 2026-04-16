/**
 * @fileoverview Unit tests for the agent CLI check module.
 *
 * Tests cover:
 * - cliCheckCore: isCopilotCliAvailable, checkCopilotCliAsync, resetCliCache, isCliCachePopulated
 * - cliCheck: ensureCopilotCliInteractive, registerCopilotCliCheck
 *
 * All child_process and VS Code APIs are stubbed via sinon.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as cp from 'child_process';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if cp.spawn can be stubbed by sinon.
 * In some Node.js environments, spawn is non-configurable and cannot be stubbed.
 * We try to stub it once to check.
 */
function canStubSpawn(): boolean {
  try {
    const stub = sinon.stub(cp, 'spawn');
    stub.restore();
    return true;
  } catch {
    return false;
  }
}

/** Flag indicating if spawn can be stubbed in this environment */
const spawnStubbable = canStubSpawn();


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
   
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
   
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

/**
 * Create a fake ChildProcess that can be controlled in tests.
 * Emits 'close', 'exit', or 'error' as directed.
 */
function fakeProc(exitCode: number | null = 0): cp.ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;

  // Schedule the exit event on the next tick so callers can attach listeners first
  if (exitCode !== null) {
    process.nextTick(() => {
      proc.emit('close', exitCode);
    });
  }

  return proc as cp.ChildProcess;
}

/** Create a fake proc that emits 'error' instead of 'close'. */
function fakeErrorProc(err: Error = new Error('spawn ENOENT')): cp.ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = undefined;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;

  process.nextTick(() => {
    proc.emit('error', err);
  });

  return proc as cp.ChildProcess;
}

// ---------------------------------------------------------------------------
// cliCheckCore tests
// ---------------------------------------------------------------------------

suite('Agent CLI Check Core', function() {
  let spawnStub: sinon.SinonStub;
  let quiet: { restore: () => void };

  // We need fresh module state for each test because cliCheckCore caches results
  let cliCheckCore: typeof import('../../../agent/cliCheckCore');

  setup(function() {
    if (!spawnStubbable) {
      this.skip();
      return;
    }
    quiet = silenceConsole();
    spawnStub = sinon.stub(cp, 'spawn');

    // Clear the module cache to get fresh state for cliCheckCore
    const modulePath = require.resolve('../../../agent/cliCheckCore');
    delete require.cache[modulePath];
    cliCheckCore = require('../../../agent/cliCheckCore');
  });

  teardown(() => {
    sinon.restore();
    if (quiet) {quiet.restore();}
  });

  // =========================================================================
  // resetCliCache / isCliCachePopulated
  // =========================================================================

  suite('Cache management', () => {
    test('cache is not populated on fresh load', () => {
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), false);
    });

    test('resetCliCache clears a populated cache', async () => {
      // Populate cache by running checkCopilotCliAsync
      spawnStub.callsFake(() => fakeProc(0));
      await cliCheckCore.checkCopilotCliAsync();

      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);

      cliCheckCore.resetCliCache();
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), false);
    });
  });

  // =========================================================================
  // isCopilotCliAvailable
  // =========================================================================

  suite('isCopilotCliAvailable()', () => {
    test('returns true optimistically on first call (before cache populated)', () => {
      // Before any check completes, should return true optimistically
      spawnStub.callsFake(() => {
        // Return a proc that never closes (simulating long-running check)
        const proc = new EventEmitter() as any;
        proc.pid = 1;
        proc.kill = sinon.stub();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        return proc;
      });

      const result = cliCheckCore.isCopilotCliAvailable();
      assert.strictEqual(result, true, 'should return true optimistically on first call');
    });

    test('returns cached value when cache is populated (true)', async () => {
      // First, populate the cache with true
      spawnStub.callsFake(() => fakeProc(0));
      await cliCheckCore.checkCopilotCliAsync();

      assert.strictEqual(cliCheckCore.isCopilotCliAvailable(), true);
    });

    test('returns cached value when cache is populated (false)', async () => {
      // Populate the cache with false (all commands fail)
      spawnStub.callsFake(() => fakeErrorProc());
      await cliCheckCore.checkCopilotCliAsync();

      assert.strictEqual(cliCheckCore.isCopilotCliAvailable(), false);
    });
  });

  // =========================================================================
  // checkCopilotCliAsync
  // =========================================================================

  suite('checkCopilotCliAsync()', () => {
    test('returns true when first command (gh copilot --help) succeeds', async () => {
      spawnStub.callsFake(() => fakeProc(0));

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, true);
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);
    });

    test('returns false when all commands fail', async () => {
      spawnStub.callsFake(() => fakeErrorProc());

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, false);
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);
    });

    test('returns true when later command succeeds (copilot --help)', async () => {
      let callCount = 0;
      spawnStub.callsFake((..._args: any[]) => {
        callCount++;
        // First two calls fail (gh copilot --help, gh extension list),
        // third succeeds (copilot --help)
        if (callCount <= 2) {
          return fakeErrorProc();
        }
        return fakeProc(0);
      });

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, true);
    });

    test('handles non-zero exit code as command not found', async () => {
      spawnStub.callsFake(() => fakeProc(1));

      // When gh copilot exits with code 1, it tries gh extension list
      // We need the extension list to also fail, then try other commands
      const result = await cliCheckCore.checkCopilotCliAsync();
      // All commands return exit code 1, so should be false
      assert.strictEqual(result, false);
    });

    test('updates cache after check', async () => {
      spawnStub.callsFake(() => fakeProc(0));

      assert.strictEqual(cliCheckCore.isCliCachePopulated(), false);
      await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);
    });

    test('hasGhCopilotAsync parses extension list output', async () => {
      let callCount = 0;
      spawnStub.callsFake((..._args: any[]) => {
        callCount++;
        if (callCount === 1) {
          // gh copilot --help fails
          return fakeErrorProc();
        }
        if (callCount === 2) {
          // gh extension list succeeds and includes gh-copilot
          const proc = new EventEmitter() as any;
          proc.pid = 99;
          proc.kill = sinon.stub();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = null;

          process.nextTick(() => {
            proc.stdout.emit('data', Buffer.from('github/gh-copilot\ngithub/gh-other\n'));
            proc.emit('close', 0);
          });

          return proc;
        }
        return fakeErrorProc();
      });

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, true, 'should detect gh-copilot from extension list');
    });
  });
});

// ---------------------------------------------------------------------------
