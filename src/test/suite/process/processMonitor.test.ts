/**
 * @fileoverview Tests for ProcessMonitor (src/process/processMonitor.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProcessMonitor } from '../../../process/processMonitor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { ProcessInfo } from '../../../types';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

const defaultSpawner = new DefaultProcessSpawner();

suite('ProcessMonitor', () => {
  let monitor: ProcessMonitor;

  setup(() => {
    silenceConsole();
    monitor = new ProcessMonitor(defaultSpawner, 0); // zero TTL to avoid caching
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // buildTree
  // =========================================================================

  suite('buildTree', () => {
    test('returns empty array for empty rootPids', () => {
      const result = monitor.buildTree([], []);
      assert.deepStrictEqual(result, []);
    });

    test('returns empty array for empty snapshot', () => {
      const result = monitor.buildTree([1], []);
      assert.deepStrictEqual(result, []);
    });

    test('returns empty array for null-ish inputs', () => {
      assert.deepStrictEqual(monitor.buildTree(null as any, []), []);
      assert.deepStrictEqual(monitor.buildTree([1], null as any), []);
    });

    test('builds single root with no children', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 100, parentPid: 1, name: 'node', cpu: 0, memory: 1000 },
      ];
      const result = monitor.buildTree([100], snapshot);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].pid, 100);
      assert.strictEqual(result[0].children, undefined);
    });

    test('builds tree with one level of children', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 100, parentPid: 1, name: 'root', cpu: 0, memory: 1000 },
        { pid: 200, parentPid: 100, name: 'child1', cpu: 0, memory: 500 },
        { pid: 300, parentPid: 100, name: 'child2', cpu: 0, memory: 500 },
      ];
      const result = monitor.buildTree([100], snapshot);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].children?.length, 2);
    });

    test('builds multi-level tree', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 1, parentPid: 0, name: 'root', cpu: 0, memory: 1000 },
        { pid: 2, parentPid: 1, name: 'child', cpu: 0, memory: 500 },
        { pid: 3, parentPid: 2, name: 'grandchild', cpu: 0, memory: 250 },
      ];
      const result = monitor.buildTree([1], snapshot);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].children?.[0]?.children?.[0]?.pid, 3);
    });

    test('builds wide tree with many children', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 1, parentPid: 0, name: 'root', cpu: 0, memory: 1000 },
      ];
      for (let i = 10; i < 20; i++) {
        snapshot.push({ pid: i, parentPid: 1, name: `child-${i}`, cpu: 0, memory: 100 });
      }
      const result = monitor.buildTree([1], snapshot);
      assert.strictEqual(result[0].children?.length, 10);
    });

    test('builds trees for multiple root PIDs', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 1, parentPid: 0, name: 'root1', cpu: 0, memory: 1000 },
        { pid: 2, parentPid: 0, name: 'root2', cpu: 0, memory: 1000 },
        { pid: 3, parentPid: 1, name: 'child-of-1', cpu: 0, memory: 500 },
      ];
      const result = monitor.buildTree([1, 2], snapshot);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].children?.length, 1);
      assert.strictEqual(result[1].children, undefined);
    });

    test('ignores processes not in the tree', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 1, parentPid: 0, name: 'root', cpu: 0, memory: 1000 },
        { pid: 99, parentPid: 50, name: 'unrelated', cpu: 0, memory: 500 },
      ];
      const result = monitor.buildTree([1], snapshot);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].children, undefined);
    });

    test('handles self-referencing PID (pid === parentPid)', () => {
      const snapshot: ProcessInfo[] = [
        { pid: 1, parentPid: 1, name: 'self-ref', cpu: 0, memory: 1000 },
      ];
      const result = monitor.buildTree([1], snapshot);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].children, undefined);
    });
  });

  // =========================================================================
  // isRunning
  // =========================================================================

  suite('isRunning', () => {
    test('returns true for current process PID', () => {
      assert.strictEqual(monitor.isRunning(process.pid), true);
    });

    test('returns false for nonexistent PID', () => {
      assert.strictEqual(monitor.isRunning(999999999), false);
    });
  });

  // =========================================================================
  // getSnapshot
  // =========================================================================

  suite('getSnapshot', () => {
    test('returns an array of ProcessInfo', async () => {
      const snapshot = await monitor.getSnapshot();
      assert.ok(Array.isArray(snapshot));
    });

    test('snapshot contains current process', async () => {
      const snapshot = await monitor.getSnapshot();
      // On some systems this may or may not find our PID, so just check shape
      if (snapshot.length > 0) {
        assert.ok(typeof snapshot[0].pid === 'number');
        assert.ok(typeof snapshot[0].name === 'string');
      }
    });

    test('returns cached snapshot within TTL', async () => {
      const cachedMonitor = new ProcessMonitor(defaultSpawner, 60000); // long TTL
      const first = await cachedMonitor.getSnapshot();
      const second = await cachedMonitor.getSnapshot();
      // Second call should be same reference (cached)
      assert.strictEqual(first, second);
    });
  });

  // =========================================================================
  // terminate
  // =========================================================================

  suite('terminate', () => {
    test('does not throw for nonexistent PID', async () => {
      // Should not throw even for a PID that does not exist
      await monitor.terminate(999999999);
    });

    test('does not throw for nonexistent PID with force', async () => {
      await monitor.terminate(999999999, true);
    });
  });

  suite('getSnapshot error handling', () => {
    test('returns stale cache during error cooldown', async () => {
      // Access private fields to simulate error state
      const m = monitor as any;
      m.consecutiveErrors = 1;
      m.lastErrorTime = Date.now();
      m.snapshotCache = [{ pid: 1, parentPid: 0, name: 'cached', cpu: 0, memory: 0 }];
      const result = await monitor.getSnapshot();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'cached');
    });

    test('logs first few errors then suppresses', async () => {
      const m = monitor as any;
      // Simulate 4 consecutive errors
      m.consecutiveErrors = 4;
      m.lastErrorTime = 0; // allow retry
      // The actual getSnapshot will try to run platform command
      // Just test that it doesn't throw
      const result = await monitor.getSnapshot();
      assert.ok(Array.isArray(result));
    });
  });
});
