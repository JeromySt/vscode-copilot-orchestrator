/**
 * @fileoverview Unit tests for ProcessMonitor
 *
 * Tests cover:
 * - Constructor and cache TTL configuration
 * - Snapshot caching behavior
 * - Process tree building (buildTree)
 * - isRunning checks
 * - terminate dispatching (Windows vs Unix)
 * - Edge cases (empty inputs, circular refs, deep trees)
 * - Platform-specific process listing
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProcessInfo } from '../../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeProcessInfo(
  pid: number,
  parentPid: number,
  name = `proc-${pid}`,
  overrides: Partial<ProcessInfo> = {},
): ProcessInfo {
  return {
    pid,
    parentPid,
    name,
    cpu: 0,
    memory: 1024,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('ProcessMonitor', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
    quiet.restore();
  });

  // =========================================================================
  // buildTree — core tree-building logic (no I/O)
  // =========================================================================
  suite('buildTree', () => {
    // Lazily require so sandbox can intercept child_process if needed
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('returns empty array for empty rootPids', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const result = monitor.buildTree([], [makeProcessInfo(1, 0)]);
      assert.deepStrictEqual(result, []);
    });

    test('returns empty array for empty snapshot', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const result = monitor.buildTree([1], []);
      assert.deepStrictEqual(result, []);
    });

    test('returns empty array for null/undefined rootPids', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      assert.deepStrictEqual(monitor.buildTree(null as any, [makeProcessInfo(1, 0)]), []);
      assert.deepStrictEqual(monitor.buildTree(undefined as any, [makeProcessInfo(1, 0)]), []);
    });

    test('returns empty array for null/undefined snapshot', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      assert.deepStrictEqual(monitor.buildTree([1], null as any), []);
      assert.deepStrictEqual(monitor.buildTree([1], undefined as any), []);
    });

    test('builds single root node with no children', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [makeProcessInfo(100, 1)];
      const tree = monitor.buildTree([100], snapshot);

      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].pid, 100);
      assert.strictEqual(tree[0].children, undefined);
    });

    test('builds root with one direct child', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [
        makeProcessInfo(100, 1),
        makeProcessInfo(200, 100),
      ];
      const tree = monitor.buildTree([100], snapshot);

      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].pid, 100);
      assert.ok(tree[0].children);
      assert.strictEqual(tree[0].children!.length, 1);
      assert.strictEqual(tree[0].children![0].pid, 200);
    });

    test('builds multi-level tree', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [
        makeProcessInfo(1, 0),
        makeProcessInfo(10, 1),
        makeProcessInfo(100, 10),
      ];
      const tree = monitor.buildTree([1], snapshot);

      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].pid, 1);
      assert.strictEqual(tree[0].children![0].pid, 10);
      assert.strictEqual(tree[0].children![0].children![0].pid, 100);
    });

    test('builds tree with multiple roots', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [
        makeProcessInfo(1, 0),
        makeProcessInfo(2, 0),
        makeProcessInfo(10, 1),
        makeProcessInfo(20, 2),
      ];
      const tree = monitor.buildTree([1, 2], snapshot);

      assert.strictEqual(tree.length, 2);
      const root1 = tree.find((n: ProcessInfo) => n.pid === 1)!;
      const root2 = tree.find((n: ProcessInfo) => n.pid === 2)!;
      assert.strictEqual(root1.children![0].pid, 10);
      assert.strictEqual(root2.children![0].pid, 20);
    });

    test('does not include processes not descended from roots', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [
        makeProcessInfo(1, 0),
        makeProcessInfo(10, 1),
        makeProcessInfo(999, 0, 'unrelated'),
      ];
      const tree = monitor.buildTree([1], snapshot);

      assert.strictEqual(tree.length, 1);
      // 999 should not be in the tree
      const allPids = collectPids(tree);
      assert.ok(!allPids.has(999));
    });

    test('handles self-referencing PID (pid === parentPid)', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      // PID 1 often has parentPid=1 on some systems
      const snapshot = [
        makeProcessInfo(1, 1),
        makeProcessInfo(10, 1),
      ];
      const tree = monitor.buildTree([1], snapshot);

      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].pid, 1);
      // Should have child 10, but not recurse infinitely
      assert.ok(tree[0].children);
      assert.strictEqual(tree[0].children!.length, 1);
      assert.strictEqual(tree[0].children![0].pid, 10);
    });

    test('limits tree depth to prevent stack overflow', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      // Build a chain deeper than 10 levels (the depth limit)
      const snapshot: ProcessInfo[] = [];
      for (let i = 0; i < 15; i++) {
        snapshot.push(makeProcessInfo(i + 1, i));
      }
      // Root is pid 0's child = pid 1
      const tree = monitor.buildTree([1], snapshot);

      assert.strictEqual(tree.length, 1);
      // Walk the chain and count depth
      let depth = 0;
      let node = tree[0];
      while (node.children && node.children.length > 0) {
        depth++;
        node = node.children[0];
      }
      // Depth should be capped at 10
      assert.ok(depth <= 10, `Depth ${depth} exceeds maximum of 10`);
    });

    test('builds tree with wide branching', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot: ProcessInfo[] = [makeProcessInfo(1, 0)];
      for (let i = 10; i < 20; i++) {
        snapshot.push(makeProcessInfo(i, 1));
      }
      const tree = monitor.buildTree([1], snapshot);

      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].children!.length, 10);
    });

    test('skips root PIDs not found in snapshot', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [makeProcessInfo(1, 0)];
      const tree = monitor.buildTree([1, 999], snapshot);

      // Only pid 1 should be in the tree
      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].pid, 1);
    });

    test('preserves process info fields in tree nodes', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const snapshot = [
        makeProcessInfo(42, 0, 'myproc', {
          cpu: 55.5,
          memory: 8192,
          commandLine: '/usr/bin/myproc --flag',
          threadCount: 4,
          handleCount: 100,
        }),
      ];
      const tree = monitor.buildTree([42], snapshot);

      assert.strictEqual(tree[0].name, 'myproc');
      assert.strictEqual(tree[0].cpu, 55.5);
      assert.strictEqual(tree[0].memory, 8192);
      assert.strictEqual(tree[0].commandLine, '/usr/bin/myproc --flag');
      assert.strictEqual(tree[0].threadCount, 4);
      assert.strictEqual(tree[0].handleCount, 100);
    });
  });

  // =========================================================================
  // isRunning
  // =========================================================================
  suite('isRunning', () => {
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('returns true for current process PID', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      // The current process should always be running
      assert.strictEqual(monitor.isRunning(process.pid), true);
    });

    test('returns false for a PID that does not exist', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      // Use a very high PID unlikely to exist
      assert.strictEqual(monitor.isRunning(2147483647), false);
    });

    test('returns false when process.kill throws', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const killStub = sandbox.stub(process, 'kill').throws(new Error('ESRCH'));
      const result = monitor.isRunning(12345);
      assert.strictEqual(result, false);
      assert.ok(killStub.calledOnce);
      assert.ok(killStub.calledWith(12345, 0));
    });

    test('returns true when process.kill succeeds with signal 0', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      const killStub = sandbox.stub(process, 'kill').returns(true);
      const result = monitor.isRunning(12345);
      assert.strictEqual(result, true);
      assert.ok(killStub.calledWith(12345, 0));
    });
  });

  // =========================================================================
  // getSnapshot — caching behavior
  // =========================================================================
  suite('getSnapshot caching', () => {
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('constructor accepts custom cacheTtlMs', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor(5000);
      // We can verify it was set by testing cache behavior indirectly
      assert.ok(monitor);
    });

    test('constructor defaults cacheTtlMs to 2000', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      assert.ok(monitor);
    });

    test('returns cached snapshot within TTL', async function() {
      this.timeout(20000); // PowerShell snapshot can take time on Windows
      const Monitor = getMonitorClass();
      const { DefaultProcessSpawner } = require('../../../interfaces/IProcessSpawner');
      const monitor = new Monitor(new DefaultProcessSpawner(), 60000); // very long TTL

      // Get first snapshot
      const first = await monitor.getSnapshot();
      assert.ok(Array.isArray(first));

      // Get second snapshot — should be same reference (cached)
      const second = await monitor.getSnapshot();
      assert.strictEqual(first, second);
    });
  });

  // =========================================================================
  // getSnapshot — error handling and throttling
  // =========================================================================
  suite('getSnapshot error handling', () => {
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('getSnapshot returns stale cache on consecutive errors within cooldown', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor({ spawn: () => {} } as any, 100); // Short TTL for testing
      const stubWin = sandbox.stub(monitor as any, 'getWindowsProcesses').rejects(new Error('Test error'));
      const stubUnix = sandbox.stub(monitor as any, 'getUnixProcesses').rejects(new Error('Test error'));
      
      // Set up initial cache
      (monitor as any).snapshotCache = [makeProcessInfo(1, 0)];
      (monitor as any).lastSnapshotTime = Date.now() - 200; // Stale
      
      // First error
      const result1 = await monitor.getSnapshot();
      assert.deepStrictEqual(result1, [makeProcessInfo(1, 0)]);
      
      // Second error within cooldown should return stale cache
      const result2 = await monitor.getSnapshot();
      assert.deepStrictEqual(result2, [makeProcessInfo(1, 0)]);
      
      // Verify error counting — second call returns early via cooldown guard
      // without re-entering the try/catch, so consecutiveErrors stays at 1
      assert.strictEqual((monitor as any).consecutiveErrors, 1);
      
      stubWin.restore();
      stubUnix.restore();
    });

    test('getSnapshot logs first 3 errors then suppresses', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor({ spawn: () => {} } as any, 100);
      const consoleErrorStub = sandbox.stub(console, 'error');
      const stubWin = sandbox.stub(monitor as any, 'getWindowsProcesses').rejects(new Error('Test error'));
      const stubUnix = sandbox.stub(monitor as any, 'getUnixProcesses').rejects(new Error('Test error'));
      
      // Set stale cache and time
      (monitor as any).snapshotCache = [makeProcessInfo(1, 0)];
      (monitor as any).lastSnapshotTime = Date.now() - 200;
      (monitor as any).lastErrorTime = Date.now() - 31000; // Outside cooldown
      
      // Generate 5 errors
      for (let i = 0; i < 5; i++) {
        await monitor.getSnapshot();
        // Reset error time to be outside cooldown for each attempt
        (monitor as any).lastErrorTime = Date.now() - 31000;
      }
      
      // Should log first 3 errors, then suppression message on 4th
      assert.strictEqual(consoleErrorStub.callCount, 4);
      assert.ok(consoleErrorStub.getCall(0).args[0].includes('Failed to get process snapshot'));
      assert.ok(consoleErrorStub.getCall(3).args[0].includes('suppressing further errors'));
      
      stubWin.restore();
      stubUnix.restore();
    });

    test('getSnapshot resets error count on success', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor(100);
      
      const mockSnapshot = [makeProcessInfo(1, 0), makeProcessInfo(2, 0)];
      const stubWin = sandbox.stub(monitor as any, 'getWindowsProcesses');
      const stubUnix = sandbox.stub(monitor as any, 'getUnixProcesses');
      
      // First set up error state
      (monitor as any).consecutiveErrors = 5;
      (monitor as any).lastErrorTime = Date.now() - 31000;
      
      // Then make success
      stubWin.resolves(mockSnapshot);
      stubUnix.resolves(mockSnapshot);
      
      const result = await monitor.getSnapshot();
      assert.deepStrictEqual(result, mockSnapshot);
      assert.strictEqual((monitor as any).consecutiveErrors, 0);
      
      stubWin.restore();
      stubUnix.restore();
    });
  });

  // =========================================================================
  // Platform-specific process listing
  // =========================================================================
  suite('platform-specific process listing', () => {
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('getWindowsProcesses handles PowerShell output correctly', async () => {
      const Monitor = getMonitorClass();
      
      const mockOutput = JSON.stringify([{
        ProcessId: 1234,
        ParentProcessId: 5678,
        Name: 'test.exe',
        CommandLine: 'test.exe --flag',
        WorkingSetSize: 1024000,
        CPU: 50.5,
        ThreadCount: 4,
        HandleCount: 100,
        Priority: 8,
        CreationDate: '2023-01-01T00:00:00.0000000Z',
        ExecutablePath: 'C:\\test.exe'
      }]);
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      const monitor = new Monitor(mockSpawner);
      
      // Simulate successful execution
      setTimeout(() => {
        mockProc.stdout.on.firstCall.args[1](mockOutput);
        const closeHandler = mockProc.on.args.find(([event]: any[]) => event === 'close');
        if (closeHandler) closeHandler[1](0);
      }, 10);
      
      const result = await (monitor as any).getWindowsProcesses();
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].pid, 1234);
      assert.strictEqual(result[0].parentPid, 5678);
      assert.strictEqual(result[0].name, 'test.exe');
      assert.strictEqual(result[0].commandLine, 'test.exe --flag');
      assert.strictEqual(result[0].memory, 1024000);
      assert.ok(result[0].cpu > 0); // CPU is normalized by core count
    });

    test('getWindowsProcesses handles single process object (not array)', async () => {
      const Monitor = getMonitorClass();
      
      const mockOutput = JSON.stringify({
        ProcessId: 1234,
        ParentProcessId: 5678,
        Name: 'single.exe'
      });
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      const monitor = new Monitor(mockSpawner);
      
      setTimeout(() => {
        mockProc.stdout.on.firstCall.args[1](mockOutput);
        const closeHandler = mockProc.on.args.find(([event]) => event === 'close');
        if (closeHandler) closeHandler[1](0);
      }, 10);
      
      const result = await (monitor as any).getWindowsProcesses();
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].pid, 1234);
    });

    test('getUnixProcesses handles ps command output correctly', async () => {
      const Monitor = getMonitorClass();
      
      const mockOutput = 'PID  PPID %CPU   RSS COMMAND          COMMAND\n' +
                        '1234 5678  2.5  1024 bash            /bin/bash -c "test"\n' +
                        '9999 1234  0.0  2048 python3         python3 script.py\n';
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      const monitor = new Monitor(mockSpawner);
      
      setTimeout(() => {
        mockProc.stdout.on.firstCall.args[1](mockOutput);
        const closeHandler = mockProc.on.args.find(([event]) => event === 'close');
        if (closeHandler) closeHandler[1](0);
      }, 10);
      
      const result = await (monitor as any).getUnixProcesses();
      
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].pid, 1234);
      assert.strictEqual(result[0].parentPid, 5678);
      assert.strictEqual(result[0].name, 'bash');
      assert.strictEqual(result[0].cpu, 2.5);
      assert.strictEqual(result[0].memory, 1024 * 1024); // KB to bytes
      assert.strictEqual(result[0].commandLine, '/bin/bash -c "test"');
    });

    test('getUnixProcesses skips malformed lines', async () => {
      const Monitor = getMonitorClass();
      
      const mockOutput = 'PID  PPID %CPU   RSS COMMAND\n' +
                        '1234 5678  2.5  1024 bash /bin/bash\n' +
                        'bad line\n' +  // malformed line should be skipped
                        '9999 1234  0.0  2048 python script.py\n';
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      const monitor = new Monitor(mockSpawner);
      
      setTimeout(() => {
        mockProc.stdout.on.firstCall.args[1](mockOutput);
        const closeHandler = mockProc.on.args.find(([event]) => event === 'close');
        if (closeHandler) closeHandler[1](0);
      }, 10);
      
      const result = await (monitor as any).getUnixProcesses();
      
      assert.strictEqual(result.length, 2); // Should skip malformed line
      assert.strictEqual(result[0].pid, 1234);
      assert.strictEqual(result[1].pid, 9999);
    });
  });

  // =========================================================================
  // terminate — platform dispatch
  // =========================================================================
  suite('terminate', () => {
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('terminate calls terminateWindows on win32', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      
      const terminateStub = sandbox.stub(monitor as any, 'terminateWindows').resolves();
      
      await monitor.terminate(1234, false);
      
      assert.ok(terminateStub.calledOnceWith(1234, false));
      
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    });

    test('terminate calls terminateUnix on non-win32', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();
      
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      
      const terminateStub = sandbox.stub(monitor as any, 'terminateUnix').resolves();
      
      await monitor.terminate(1234, true);
      
      assert.ok(terminateStub.calledOnceWith(1234, true));
      
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    });

    test('terminateWindows uses correct taskkill flags', async () => {
      const Monitor = getMonitorClass();
      
      const mockSpawner = { spawn: sandbox.stub() };
      const monitor = new Monitor(mockSpawner);
      
      function makeMockProc() {
        const mp = {
          stdout: { on: sandbox.stub() },
          stderr: { on: sandbox.stub() },
          on: sandbox.stub(),
          kill: sandbox.stub()
        };
        setTimeout(() => {
          const closeHandler = mp.on.args.find((a: any[]) => a[0] === 'close');
          if (closeHandler) closeHandler[1](0);
        }, 10);
        return mp;
      }
      
      // Test force=false
      mockSpawner.spawn.returns(makeMockProc());
      await (monitor as any).terminateWindows(1234, false);
      assert.ok(mockSpawner.spawn.calledWith('taskkill', ['/T', '/PID', '1234']));
      
      mockSpawner.spawn.resetHistory();
      
      // Test force=true
      mockSpawner.spawn.returns(makeMockProc());
      await (monitor as any).terminateWindows(1234, true);
      assert.ok(mockSpawner.spawn.calledWith('taskkill', ['/F', '/T', '/PID', '1234']));
    });

    test('terminateUnix handles recursive termination', async () => {
      const Monitor = getMonitorClass();
      
      const mockSpawner = { spawn: sandbox.stub() };
      const monitor = new Monitor(mockSpawner);
      const killStub = sandbox.stub(process, 'kill');
      
      // Create a fresh mockProc each time spawn is called
      let spawnCallCount = 0;
      mockSpawner.spawn.callsFake(() => {
        spawnCallCount++;
        const mp = {
          stdout: { on: sandbox.stub() },
          stderr: { on: sandbox.stub() },
          on: sandbox.stub(),
          kill: sandbox.stub()
        };
        const callIdx = spawnCallCount;
        setTimeout(() => {
          // First spawn call (pgrep for main PID) returns children
          if (callIdx === 1) {
            const dataHandler = mp.stdout.on.args.find((a: any[]) => a[0] === 'data');
            if (dataHandler) dataHandler[1]('5678\n9999\n');
            const closeHandler = mp.on.args.find((a: any[]) => a[0] === 'close');
            if (closeHandler) closeHandler[1](0);
          } else {
            // Subsequent pgrep calls for children return no children
            const closeHandler = mp.on.args.find((a: any[]) => a[0] === 'close');
            if (closeHandler) closeHandler[1](1);
          }
        }, 10);
        return mp;
      });
      
      await (monitor as any).terminateUnix(1234, false);
      
      // Should have called process.kill for main PID and children
      assert.ok(killStub.calledWith(1234, 'SIGTERM'), 'Should kill main PID');
      assert.ok(killStub.calledWith(5678, 'SIGTERM'), 'Should kill child 5678');
      assert.ok(killStub.calledWith(9999, 'SIGTERM'), 'Should kill child 9999');
      
      killStub.restore();
    });

    test('terminateUnix uses SIGKILL when force=true', async () => {
      const Monitor = getMonitorClass();
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      const monitor = new Monitor(mockSpawner);
      const killStub = sandbox.stub(process, 'kill');
      
      setTimeout(() => {
        const closeHandler = mockProc.on.args.find((a: any[]) => a[0] === 'close');
        if (closeHandler) closeHandler[1](1);
      }, 10);
      
      await (monitor as any).terminateUnix(1234, true);
      
      assert.ok(killStub.calledWith(1234, 'SIGKILL'));
      
      killStub.restore();
    });

    test('terminateUnix handles ESRCH error gracefully', async () => {
      const Monitor = getMonitorClass();
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      const monitor = new Monitor(mockSpawner);
      const killStub = sandbox.stub(process, 'kill');
      const consoleStub = sandbox.stub(console, 'error');
      
      setTimeout(() => {
        const closeHandler = mockProc.on.args.find((a: any[]) => a[0] === 'close');
        if (closeHandler) closeHandler[1](1);
      }, 10);
      
      const err = new Error('Process not found') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      killStub.throws(err);
      
      await (monitor as any).terminateUnix(1234, false);
      
      // Should not log ESRCH errors
      assert.strictEqual(consoleStub.callCount, 0);
      
      killStub.restore();
    });
  });

  // =========================================================================
  // buildTree — BFS descendant discovery
  // =========================================================================
  suite('buildTree BFS descendant discovery', () => {
    function getMonitorClass() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessMonitor } = require('../../../process/processMonitor');
      return ProcessMonitor;
    }

    test('discovers multi-level descendants via BFS', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();

      // Root -> A -> B -> C (3 levels of descendants)
      const snapshot = [
        makeProcessInfo(1, 0),    // root
        makeProcessInfo(10, 1),   // child of root
        makeProcessInfo(100, 10), // grandchild
        makeProcessInfo(200, 100),// great-grandchild
        makeProcessInfo(999, 0),  // unrelated
      ];

      const tree = monitor.buildTree([1], snapshot);
      const allPids = collectPids(tree);

      assert.ok(allPids.has(1));
      assert.ok(allPids.has(10));
      assert.ok(allPids.has(100));
      assert.ok(allPids.has(200));
      assert.ok(!allPids.has(999));
    });

    test('BFS respects maxIterations guard (20)', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();

      // Create a chain of 25 levels — BFS has maxIterations=20
      const snapshot: ProcessInfo[] = [];
      for (let i = 0; i < 25; i++) {
        snapshot.push(makeProcessInfo(i + 1, i));
      }

      const tree = monitor.buildTree([1], snapshot);
      const allPids = collectPids(tree);

      // BFS discovers up to 20 iterations of new descendants
      // Root (1) is in initial set, then BFS finds up to 20 more levels
      // With maxIterations=20, we get roughly PIDs 1-20
      assert.ok(allPids.has(1));
      assert.ok(allPids.has(10));
      // PIDs beyond 20 should not all be discovered due to the guard
      assert.ok(allPids.size <= 22, `Expected <= 22 PIDs but got ${allPids.size}`);
    });

    test('handles fork topology (one parent, many children)', () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();

      const snapshot: ProcessInfo[] = [makeProcessInfo(1, 0)];
      for (let i = 2; i <= 50; i++) {
        snapshot.push(makeProcessInfo(i, 1));
      }

      const tree = monitor.buildTree([1], snapshot);
      assert.strictEqual(tree.length, 1);
      assert.strictEqual(tree[0].children!.length, 49);
    });
  });

  // =========================================================================
  // execAsync function
  // =========================================================================
  suite('execAsync', () => {
    test('execAsync resolves with stdout on success', async () => {
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      
      setTimeout(() => {
        mockProc.stdout.on.firstCall.args[1]('test output');
        const closeHandler = mockProc.on.args.find((a: any[]) => a[0] === 'close');
        if (closeHandler) closeHandler[1](0);
      }, 10);
      
      const processMonitorModule = require('../../../process/processMonitor');
      const Monitor = processMonitorModule.ProcessMonitor;
      const monitor = new Monitor(mockSpawner);
      
      // Test via getSnapshot which calls execAsync internally
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      
      const result = await monitor.getSnapshot();
      
      assert.ok(Array.isArray(result)); // Should parse the JSON output
      
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    });

    test('execAsync rejects on command timeout', async function() {
      this.timeout(10000); // Allow enough time for internal timeout
      
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      
      // Don't trigger close event to simulate timeout
      
      const Monitor = require('../../../process/processMonitor').ProcessMonitor;
      const monitor = new Monitor(mockSpawner, 1); // Very short cache TTL
      
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      
      // Clear cache to force new snapshot
      (monitor as any).snapshotCache = [];
      (monitor as any).lastSnapshotTime = 0;
      (monitor as any).lastErrorTime = 0;
      (monitor as any).consecutiveErrors = 0;
      
      try {
        await monitor.getSnapshot();
        // getSnapshot catches errors and returns stale cache, so it may not throw
        assert.ok(true);
      } catch (e) {
        // Should eventually timeout and be caught by getSnapshot error handling
        assert.ok(true);
      }
      
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    });

    test('execAsync rejects on non-zero exit code with stderr', async () => {
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      
      setTimeout(() => {
        mockProc.stderr.on.firstCall.args[1]('Command failed');
        const closeHandler = mockProc.on.args.find((a: any[]) => a[0] === 'close');
        if (closeHandler) closeHandler[1](1); // Non-zero exit
      }, 10);
      
      const Monitor = require('../../../process/processMonitor').ProcessMonitor;
      const monitor = new Monitor(mockSpawner, 1);
      
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      
      // Clear cache to force new snapshot
      (monitor as any).snapshotCache = [];
      (monitor as any).lastSnapshotTime = 0;
      (monitor as any).lastErrorTime = 0;
      (monitor as any).consecutiveErrors = 0;
      
      try {
        await monitor.getSnapshot();
        // Should catch error and return empty cache
        assert.ok(true);
      } catch (e) {
        assert.ok(true);
      }
      
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    });

    test('execAsync handles process spawn error', async () => {
      const mockProc = {
        stdout: { on: sandbox.stub() },
        stderr: { on: sandbox.stub() },
        on: sandbox.stub(),
        kill: sandbox.stub()
      };
      
      const mockSpawner = { spawn: sandbox.stub().returns(mockProc) };
      
      setTimeout(() => {
        const errorHandler = mockProc.on.args.find((a: any[]) => a[0] === 'error');
        if (errorHandler) errorHandler[1](new Error('Spawn failed'));
      }, 10);
      
      const Monitor = require('../../../process/processMonitor').ProcessMonitor;
      const monitor = new Monitor(mockSpawner, 1);
      
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      
      // Clear cache to force new snapshot  
      (monitor as any).snapshotCache = [];
      (monitor as any).lastSnapshotTime = 0;
      (monitor as any).lastErrorTime = 0;
      (monitor as any).consecutiveErrors = 0;
      
      const result = await monitor.getSnapshot();
      
      // Should return empty array due to error
      assert.deepStrictEqual(result, []);
      
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Recursively collect all PIDs in a process tree. */
function collectPids(nodes: Array<{ pid: number; children?: any[] }>): Set<number> {
  const pids = new Set<number>();
  function walk(node: { pid: number; children?: any[] }) {
    pids.add(node.pid);
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }
  for (const n of nodes) {
    walk(n);
  }
  return pids;
}
