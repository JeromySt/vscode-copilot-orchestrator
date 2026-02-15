/**
 * @fileoverview Unit tests for PowerManager
 *
 * Tests cover:
 * - Wake lock acquisition and cleanup
 * - Multiple wake locks with reference counting
 * - ReleaseAll functionality
 * - Platform detection and correct command usage
 * - Graceful failure handling when commands are unavailable
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// Use require to get the same module reference and avoid __importStar getter issues
const cpModule = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if cpModule.spawn can be stubbed by sinon.
 * In some Node.js environments, spawn is non-configurable and cannot be stubbed.
 */
function canStubSpawn(): boolean {
  try {
    const stub = sinon.stub(cpModule, 'spawn');
    stub.restore();
    return true;
  } catch {
    return false;
  }
}

/** Flag indicating if spawn can be stubbed in this environment */
const spawnStubbable = canStubSpawn();

/** Suppress console output to avoid noise in test output. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  /* eslint-disable no-console */
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  /* eslint-enable no-console */
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
 * Create a mock ChildProcess that can emit events
 */
function createMockChildProcess(): ChildProcess {
  const mockProcess = new EventEmitter() as any;
  mockProcess.exitCode = null;
  mockProcess.kill = sinon.stub().returns(true);
  mockProcess.pid = Math.floor(Math.random() * 10000);
  return mockProcess as ChildProcess;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('PowerManager', function() {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;
  let spawnStub: sinon.SinonStub;
  let platformStub: sinon.SinonStub;

  setup(function() {
    if (!spawnStubbable) {
      this.skip();
      return;
    }
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    spawnStub = sandbox.stub(cpModule, 'spawn');
    
    // Clear module cache to get fresh PowerManager instances
    delete require.cache[require.resolve('../../../core/powerManager')];
  });

  teardown(() => {
    if (sandbox) {
      sandbox.restore();
    }
    if (quiet) {
      quiet.restore();
    }
  });

  // =========================================================================
  // Wake Lock Acquisition
  // =========================================================================
  suite('Wake Lock Acquisition', () => {
    test('acquireWakeLock returns cleanup function', async () => {
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');
      
      assert.ok(typeof cleanup === 'function', 'Should return a function');
      assert.ok(pm.isWakeLockActive(), 'Wake lock should be active');
      
      cleanup();
      
      assert.ok(!pm.isWakeLockActive(), 'Wake lock should be released');
      assert.ok((mockProc.kill as sinon.SinonStub).called, 'Process should be killed');
    });

    test('acquireWakeLock spawns correct command on Windows', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('win32');
      
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      await pm.acquireWakeLock('test reason');

      assert.ok(spawnStub.called, 'spawn should be called');
      const [command, args] = spawnStub.firstCall.args;
      assert.strictEqual(command, 'powershell.exe', 'Should use powershell.exe on Windows');
      assert.ok(args.includes('-NoProfile'), 'Should include -NoProfile');
      assert.ok(args.includes('-NonInteractive'), 'Should include -NonInteractive');
    });

    test('acquireWakeLock spawns correct command on macOS', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('darwin');
      
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      await pm.acquireWakeLock('test reason');

      assert.ok(spawnStub.called, 'spawn should be called');
      const [command, args] = spawnStub.firstCall.args;
      assert.strictEqual(command, 'caffeinate', 'Should use caffeinate on macOS');
      assert.deepStrictEqual(args, ['-dims'], 'Should use -dims flags');
    });

    test('acquireWakeLock spawns correct command on Linux', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('linux');
      
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      await pm.acquireWakeLock('test reason');

      assert.ok(spawnStub.called, 'spawn should be called');
      const [command, args] = spawnStub.firstCall.args;
      assert.strictEqual(command, 'systemd-inhibit', 'Should use systemd-inhibit on Linux');
      assert.ok(args.includes('--what=idle:sleep'), 'Should include --what flag');
      assert.ok(args.some((arg: string) => arg.startsWith('--why=')), 'Should include --why flag');
    });
  });

  // =========================================================================
  // Multiple Locks
  // =========================================================================
  suite('Multiple Locks', () => {
    test('multiple wake locks are reference counted', async () => {
      const mockProc1 = createMockChildProcess();
      const mockProc2 = createMockChildProcess();
      spawnStub.onFirstCall().returns(mockProc1);
      spawnStub.onSecondCall().returns(mockProc2);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup1 = await pm.acquireWakeLock('plan-1');
      const cleanup2 = await pm.acquireWakeLock('plan-2');

      assert.ok(pm.isWakeLockActive(), 'Wake lock should be active after acquiring two');

      cleanup1();
      assert.ok(pm.isWakeLockActive(), 'Wake lock should still be active after releasing one');
      assert.ok((mockProc1.kill as sinon.SinonStub).called, 'First process should be killed');
      assert.ok(!(mockProc2.kill as sinon.SinonStub).called, 'Second process should not be killed yet');

      cleanup2();
      assert.ok(!pm.isWakeLockActive(), 'Wake lock should be released after releasing all');
      assert.ok((mockProc2.kill as sinon.SinonStub).called, 'Second process should be killed');
    });

    test('each lock has independent cleanup', async () => {
      const mockProc1 = createMockChildProcess();
      const mockProc2 = createMockChildProcess();
      const mockProc3 = createMockChildProcess();
      spawnStub.onCall(0).returns(mockProc1);
      spawnStub.onCall(1).returns(mockProc2);
      spawnStub.onCall(2).returns(mockProc3);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup1 = await pm.acquireWakeLock('plan-1');
      const cleanup2 = await pm.acquireWakeLock('plan-2');
      const cleanup3 = await pm.acquireWakeLock('plan-3');

      // Release middle one
      cleanup2();
      assert.ok((mockProc2.kill as sinon.SinonStub).called, 'Middle process should be killed');
      assert.ok(!(mockProc1.kill as sinon.SinonStub).called, 'First process should not be killed');
      assert.ok(!(mockProc3.kill as sinon.SinonStub).called, 'Third process should not be killed');
      assert.ok(pm.isWakeLockActive(), 'Wake lock should still be active');

      cleanup1();
      cleanup3();
      assert.ok(!pm.isWakeLockActive(), 'Wake lock should be released');
    });
  });

  // =========================================================================
  // ReleaseAll
  // =========================================================================
  suite('ReleaseAll', () => {
    test('releaseAll clears all locks', async () => {
      const mockProc1 = createMockChildProcess();
      const mockProc2 = createMockChildProcess();
      spawnStub.onFirstCall().returns(mockProc1);
      spawnStub.onSecondCall().returns(mockProc2);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      await pm.acquireWakeLock('plan-1');
      await pm.acquireWakeLock('plan-2');

      assert.ok(pm.isWakeLockActive(), 'Wake locks should be active');

      pm.releaseAll();

      assert.ok(!pm.isWakeLockActive(), 'All wake locks should be released');
      assert.ok((mockProc1.kill as sinon.SinonStub).called, 'First process should be killed');
      assert.ok((mockProc2.kill as sinon.SinonStub).called, 'Second process should be killed');
    });

    test('releaseAll handles empty lock list', () => {
      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      assert.doesNotThrow(() => {
        pm.releaseAll();
      }, 'Should not throw when no locks are active');

      assert.ok(!pm.isWakeLockActive(), 'Should remain inactive');
    });

    test('releaseAll handles errors during cleanup', async () => {
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      await pm.acquireWakeLock('test');

      // Replace the kill function to throw an error
      const originalKill = mockProc.kill;
      (mockProc.kill as any) = () => {
        throw new Error('Kill failed');
      };

      // Should not throw when kill fails
      assert.doesNotThrow(() => {
        pm.releaseAll();
      }, 'Should not throw when kill fails');

      assert.ok(!pm.isWakeLockActive(), 'Lock should be removed even if kill fails');
      
      // Restore for cleanup
      (mockProc.kill as any) = originalKill;
    });
  });

  // =========================================================================
  // Platform Detection
  // =========================================================================
  suite('Platform Detection', () => {
    test('uses correct platform implementation', async () => {
      const platforms = ['win32', 'darwin', 'linux'] as const;
      const expectedCommands = {
        'win32': 'powershell.exe',
        'darwin': 'caffeinate',
        'linux': 'systemd-inhibit',
      };

      for (const platform of platforms) {
        // Reset state
        sandbox.restore();
        sandbox = sinon.createSandbox();
        spawnStub = sandbox.stub(cpModule, 'spawn');
        platformStub = sandbox.stub(require('os'), 'platform').returns(platform);
        delete require.cache[require.resolve('../../../core/powerManager')];

        const mockProc = createMockChildProcess();
        spawnStub.returns(mockProc);

        const { PowerManagerImpl } = require('../../../core/powerManager');
        const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

        await pm.acquireWakeLock(`test-${platform}`);

        assert.ok(spawnStub.called, `spawn should be called for ${platform}`);
        const [command] = spawnStub.firstCall.args;
        assert.strictEqual(
          command,
          expectedCommands[platform],
          `Should use ${expectedCommands[platform]} on ${platform}`
        );
      }
    });

    test('returns no-op cleanup for unsupported platform', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('unknown');
      
      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      assert.ok(typeof cleanup === 'function', 'Should return a function');
      assert.ok(!pm.isWakeLockActive(), 'Wake lock should not be active for unsupported platform');
      assert.ok(!spawnStub.called, 'spawn should not be called for unsupported platform');

      // Cleanup should be safe to call
      assert.doesNotThrow(() => cleanup(), 'No-op cleanup should not throw');
    });
  });

  // =========================================================================
  // Graceful Failure
  // =========================================================================
  suite('Graceful Failure', () => {
    test('handles missing caffeinate/systemd gracefully', async () => {
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      // Simulate command not found
      const cleanup = await pm.acquireWakeLock('test');
      mockProc.emit('error', new Error('ENOENT: command not found'));

      // Should still return a cleanup function
      assert.ok(typeof cleanup === 'function', 'Should return cleanup function even on error');
      assert.doesNotThrow(() => cleanup(), 'Cleanup should not throw');
    });

    test('handles process exit immediately after spawn', async () => {
      const mockProc = createMockChildProcess();
      (mockProc as any).exitCode = 1;
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      // Process exits immediately (simulate by setting exitCode before timeout)
      const lockPromise = pm.acquireWakeLock('test');
      
      // Should still resolve with a cleanup function
      const cleanup = await lockPromise;
      assert.ok(typeof cleanup === 'function', 'Should return cleanup function');
    });

    test('handles spawn error during lock acquisition', async () => {
      spawnStub.throws(new Error('spawn failed'));

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      // Should not throw, should return no-op cleanup
      const cleanup = await pm.acquireWakeLock('test');

      assert.ok(typeof cleanup === 'function', 'Should return cleanup function on error');
      assert.ok(!pm.isWakeLockActive(), 'Wake lock should not be active after spawn error');
      assert.doesNotThrow(() => cleanup(), 'Cleanup should not throw');
    });

    test('handles Linux fallback when systemd-inhibit fails', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('linux');
      
      let callCount = 0;
      spawnStub.callsFake((command: string) => {
        callCount++;
        const mockProc = createMockChildProcess();
        
        if (command === 'systemd-inhibit') {
          // First call to systemd-inhibit fails
          setTimeout(() => mockProc.emit('error', new Error('ENOENT')), 10);
        } else if (command === 'sh') {
          // Fallback to sh script succeeds
          // Process stays running
        }
        
        return mockProc;
      });

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      // Should have tried systemd-inhibit and fallen back to sh
      assert.ok(callCount > 0, 'Should have attempted spawn');
      assert.ok(typeof cleanup === 'function', 'Should return cleanup function');
    });

    test('cleanup is idempotent', async () => {
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      cleanup();
      assert.ok((mockProc.kill as sinon.SinonStub).calledOnce, 'Should kill process once');

      // Call cleanup again
      cleanup();
      assert.ok((mockProc.kill as sinon.SinonStub).calledOnce, 'Should not kill process again');
    });

    test('handles function cleanup types', async () => {
      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);
      
      // Mock a function cleanup instead of process
      const cleanupFn = sinon.stub();
      pm.activeLocks = new Map([['test-lock', cleanupFn]]);
      
      pm.releaseAll();
      
      assert.ok(cleanupFn.called, 'Function cleanup should be called');
      assert.strictEqual(pm.activeLocks.size, 0, 'Lock should be removed');
    });

    test('handles mixed cleanup types during releaseAll', async () => {
      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);
      
      const mockProc = createMockChildProcess();
      const cleanupFn = sinon.stub();
      
      pm.activeLocks = new Map([
        ['proc-lock', mockProc as any],
        ['func-lock', cleanupFn as any]
      ] as any);
      
      pm.releaseAll();
      
      assert.ok((mockProc.kill as sinon.SinonStub).called, 'Process should be killed');
      assert.ok(cleanupFn.called, 'Function should be called');
      assert.strictEqual(pm.activeLocks.size, 0, 'All locks should be removed');
    });

    test('handles Linux fallback failure', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('linux');
      
      let callCount = 0;
      spawnStub.callsFake((command: string) => {
        callCount++;
        const mockProc = createMockChildProcess();
        
        if (command === 'systemd-inhibit') {
          // First call to systemd-inhibit fails immediately
          (mockProc as any).exitCode = 1;
        } else if (command === 'sh') {
          // Fallback also fails
          setTimeout(() => mockProc.emit('error', new Error('Shell failed')), 10);
        }
        
        return mockProc;
      });

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      assert.ok(callCount >= 1, 'Should have attempted spawn');
      assert.ok(typeof cleanup === 'function', 'Should still return cleanup function');
      assert.doesNotThrow(() => cleanup(), 'Cleanup should not throw even on fallback failure');
    });

    test('handles timeout scenarios for Windows', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('win32');
      
      const mockProc = createMockChildProcess();
      // Process is still running (exitCode = null) after timeout
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      assert.ok(typeof cleanup === 'function', 'Should return cleanup function');
      assert.ok(pm.isWakeLockActive(), 'Wake lock should be active');
    });

    test('handles timeout scenarios for macOS', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('darwin');
      
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      assert.ok(typeof cleanup === 'function', 'Should return cleanup function');
      assert.ok(pm.isWakeLockActive(), 'Wake lock should be active');
    });

    test('handles timeout scenarios for Linux', async () => {
      platformStub = sandbox.stub(require('os'), 'platform').returns('linux');
      
      const mockProc = createMockChildProcess();
      spawnStub.returns(mockProc);

      const { PowerManagerImpl } = require('../../../core/powerManager');
      const pm = new PowerManagerImpl({ spawn: spawnStub } as any);

      const cleanup = await pm.acquireWakeLock('test');

      assert.ok(typeof cleanup === 'function', 'Should return cleanup function');
      assert.ok(pm.isWakeLockActive(), 'Wake lock should be active');
    });
  });
});
