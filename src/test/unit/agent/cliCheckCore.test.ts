/**
 * @fileoverview Tests for cliCheckCore (src/agent/cliCheckCore.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  isCopilotCliAvailable,
  checkCopilotCliAsync,
  hasGhCopilotAsync,
  resetCliCache,
  isCliCachePopulated,
} from '../../../agent/cliCheckCore';

const cp = require('child_process');

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

suite('cliCheckCore', () => {
  let spawnStub: sinon.SinonStub;

  setup(() => {
    silenceConsole();
    resetCliCache();
    spawnStub = sinon.stub(cp, 'spawn');
  });

  teardown(() => {
    sinon.restore();
    resetCliCache();
  });

  function fakeProc(exitCode: number, stdout = '') {
    const proc: any = new (require('events').EventEmitter)();
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();
    proc.kill = sinon.stub();
    setTimeout(() => {
      if (stdout) {proc.stdout.emit('data', Buffer.from(stdout));}
      proc.emit('close', exitCode);
    }, 5);
    return proc;
  }

  function fakeErrorProc() {
    const proc: any = new (require('events').EventEmitter)();
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();
    proc.kill = sinon.stub();
    setTimeout(() => proc.emit('error', new Error('not found')), 5);
    return proc;
  }

  // =========================================================================
  // isCliCachePopulated / resetCliCache
  // =========================================================================

  suite('cache management', () => {
    test('cache is not populated initially', () => {
      assert.strictEqual(isCliCachePopulated(), false);
    });

    test('cache is populated after check', async () => {
      spawnStub.callsFake(() => fakeProc(0));
      await checkCopilotCliAsync();
      assert.strictEqual(isCliCachePopulated(), true);
    });

    test('resetCliCache clears cache', async () => {
      spawnStub.callsFake(() => fakeProc(0));
      await checkCopilotCliAsync();
      assert.strictEqual(isCliCachePopulated(), true);
      resetCliCache();
      assert.strictEqual(isCliCachePopulated(), false);
    });
  });

  // =========================================================================
  // isCopilotCliAvailable
  // =========================================================================

  suite('isCopilotCliAvailable', () => {
    test('returns false on first call when cache is empty', () => {
      spawnStub.callsFake(() => fakeErrorProc());
      const result = isCopilotCliAvailable();
      assert.strictEqual(result, false);
    });

    test('returns cached value on subsequent calls', async () => {
      spawnStub.callsFake(() => fakeErrorProc());
      await checkCopilotCliAsync();
      const result = isCopilotCliAvailable();
      assert.strictEqual(result, false);
    });

    test('returns true when CLI is available', async () => {
      spawnStub.callsFake(() => fakeProc(0));
      await checkCopilotCliAsync();
      const result = isCopilotCliAvailable();
      assert.strictEqual(result, true);
    });
  });

  // =========================================================================
  // checkCopilotCliAsync
  // =========================================================================

  suite('checkCopilotCliAsync', () => {
    test('returns true when gh copilot --help succeeds', async () => {
      spawnStub.callsFake(() => fakeProc(0));
      const result = await checkCopilotCliAsync();
      assert.strictEqual(result, true);
    });

    test('returns false when all commands fail', async () => {
      spawnStub.callsFake(() => fakeErrorProc());
      const result = await checkCopilotCliAsync();
      assert.strictEqual(result, false);
    });

    test('returns true when gh extension list contains copilot', async () => {
      let callCount = 0;
      spawnStub.callsFake((cmd: string, args: string[]) => {
        callCount++;
        // First call (gh copilot --help) fails
        if (callCount === 1) {return fakeErrorProc();}
        // Second call (gh extension list) succeeds with copilot extension
        if (args && args[0] === 'extension') {return fakeProc(0, 'github/gh-copilot');}
        return fakeErrorProc();
      });
      const result = await checkCopilotCliAsync();
      assert.strictEqual(result, true);
    });

    test('returns true when copilot standalone exists', async () => {
      let callCount = 0;
      spawnStub.callsFake(() => {
        callCount++;
        // First 2 commands fail, third (copilot --help) succeeds
        if (callCount <= 2) {return fakeErrorProc();}
        return fakeProc(0);
      });
      const result = await checkCopilotCliAsync();
      assert.strictEqual(result, true);
    });
  });

  // =========================================================================
  // cmdOkAsync — settle/timer correctness
  // =========================================================================

  suite('cmdOkAsync settle correctness', () => {
    test('resolves only once when close fires after error', async () => {
      // Process emits both 'error' and 'close' — should not double-resolve
      spawnStub.callsFake(() => {
        const proc: any = new (require('events').EventEmitter)();
        proc.stdout = new (require('events').EventEmitter)();
        proc.stderr = new (require('events').EventEmitter)();
        proc.kill = sinon.stub();
        setTimeout(() => {
          proc.emit('error', new Error('not found'));
          proc.emit('close', 1);
        }, 5);
        return proc;
      });
      // Should not hang or throw; must resolve cleanly to false
      const result = await checkCopilotCliAsync();
      assert.strictEqual(result, false);
    });

    test('timer is cleared when process closes before timeout', async () => {
      const clock = sinon.useFakeTimers();
      try {
        spawnStub.callsFake(() => {
          const proc: any = new (require('events').EventEmitter)();
          proc.stdout = new (require('events').EventEmitter)();
          proc.stderr = new (require('events').EventEmitter)();
          proc.kill = sinon.stub();
          // Close immediately (success) before the 15s timeout
          setImmediate(() => proc.emit('close', 0));
          return proc;
        });

        const promise = checkCopilotCliAsync();
        await clock.tickAsync(100);
        const result = await promise;

        // Verify process was NOT killed by the timeout
        assert.strictEqual(result, true);
        assert.ok(spawnStub.returnValues.every((p: any) => !p.kill.called),
          'kill should not have been called — timer should have been cleared on close');
      } finally {
        clock.restore();
      }
    });
  });

  suite('hasGhCopilotAsync settle correctness', () => {
    test('resolves only once when close fires after error', async () => {
      spawnStub.callsFake(() => {
        const proc: any = new (require('events').EventEmitter)();
        proc.stdout = new (require('events').EventEmitter)();
        proc.stderr = new (require('events').EventEmitter)();
        proc.kill = sinon.stub();
        setTimeout(() => {
          proc.emit('error', new Error('not found'));
          proc.emit('close', 1);
        }, 5);
        return proc;
      });

      const result = await hasGhCopilotAsync();
      assert.strictEqual(result, false);
    });

    test('timer is cleared when process closes before timeout', async () => {
      const clock = sinon.useFakeTimers();
      try {
        let proc: any;
        spawnStub.callsFake(() => {
          proc = new (require('events').EventEmitter)();
          proc.stdout = new (require('events').EventEmitter)();
          proc.stderr = new (require('events').EventEmitter)();
          proc.kill = sinon.stub();
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('github/gh-copilot\n'));
            proc.emit('close', 0);
          });
          return proc;
        });

        const promise = hasGhCopilotAsync();
        await clock.tickAsync(100);
        const result = await promise;

        assert.strictEqual(result, true);
        assert.ok(!proc.kill.called,
          'kill should not have been called — timer should have been cleared on close');
      } finally {
        clock.restore();
      }
    });
  });
});
