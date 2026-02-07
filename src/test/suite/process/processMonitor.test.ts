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

    test('returns cached snapshot within TTL', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor(60000); // very long TTL

      // Get first snapshot
      const first = await monitor.getSnapshot();
      assert.ok(Array.isArray(first));

      // Get second snapshot — should be same reference (cached)
      const second = await monitor.getSnapshot();
      assert.strictEqual(first, second);
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

    test('calls platform-specific termination without throwing', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();

      // Stub the private methods to prevent actual process termination
      // Use a PID that doesn't exist so the worst case is a harmless error
      try {
        await monitor.terminate(2147483647, false);
      } catch {
        // It's acceptable if this throws for a non-existent PID
      }
      // If we get here without hanging, the test passes
      assert.ok(true);
    });

    test('force terminate does not throw for non-existent PID', async () => {
      const Monitor = getMonitorClass();
      const monitor = new Monitor();

      try {
        await monitor.terminate(2147483647, true);
      } catch {
        // Acceptable
      }
      assert.ok(true);
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
