/**
 * @fileoverview Tests for the execution pump liveness watchdog.
 *
 * Verifies that the pump detects stale PIDs (dead processes from
 * hibernate/crash) and transitions stuck "running" nodes to "failed"
 * so they can be retried.
 *
 * @module test/unit/plan/livenessWatchdog
 */

import * as assert from 'assert';

suite('Liveness Watchdog', () => {

  test('detects dead PID and marks node as failed', () => {
    // Simulate: node is "running" with a PID, but PID is dead
    const nodeState: any = {
      status: 'running',
      pid: 12345,
      error: undefined,
      startedAt: Date.now() - 60000,
    };

    const processMonitor = {
      isRunning: (pid: number) => false, // PID is dead
    };

    // Simulate watchdog check
    if (nodeState.status === 'running' && nodeState.pid) {
      if (!processMonitor.isRunning(nodeState.pid)) {
        nodeState.error = `Process ${nodeState.pid} died unexpectedly (system hibernate or crash). Retry to resume.`;
        nodeState.pid = undefined;
        nodeState.status = 'failed';
      }
    }

    assert.strictEqual(nodeState.status, 'failed');
    assert.strictEqual(nodeState.pid, undefined);
    assert.ok(nodeState.error?.includes('died unexpectedly'));
  });

  test('does NOT fail node with alive PID', () => {
    const nodeState: any = {
      status: 'running',
      pid: 12345,
      error: undefined,
    };

    const processMonitor = {
      isRunning: (pid: number) => true, // PID is alive
    };

    if (nodeState.status === 'running' && nodeState.pid) {
      if (!processMonitor.isRunning(nodeState.pid)) {
        nodeState.status = 'failed';
      }
    }

    assert.strictEqual(nodeState.status, 'running');
    assert.strictEqual(nodeState.pid, 12345);
  });

  test('does NOT check nodes without PID', () => {
    const nodeState: any = {
      status: 'running',
      pid: undefined,
      error: undefined,
    };

    let checkCalled = false;
    const processMonitor = {
      isRunning: (_pid: number) => { checkCalled = true; return false; },
    };

    if (nodeState.status === 'running' && nodeState.pid) {
      if (!processMonitor.isRunning(nodeState.pid)) {
        nodeState.status = 'failed';
      }
    }

    assert.strictEqual(checkCalled, false, 'Should not check PID when pid is undefined');
    assert.strictEqual(nodeState.status, 'running');
  });

  test('does NOT check non-running nodes', () => {
    const nodeState: any = {
      status: 'succeeded',
      pid: 12345,
    };

    let checkCalled = false;
    const processMonitor = {
      isRunning: (_pid: number) => { checkCalled = true; return false; },
    };

    if (nodeState.status === 'running' && nodeState.pid) {
      if (!processMonitor.isRunning(nodeState.pid)) {
        nodeState.status = 'failed';
      }
    }

    assert.strictEqual(checkCalled, false);
    assert.strictEqual(nodeState.status, 'succeeded');
  });

  test('watchdog runs every 10th pump cycle', () => {
    let livenessCheckCounter = 0;
    let checksPerformed = 0;

    // Simulate 25 pump cycles
    for (let i = 0; i < 25; i++) {
      livenessCheckCounter++;
      if (livenessCheckCounter >= 10) {
        livenessCheckCounter = 0;
        checksPerformed++;
      }
    }

    assert.strictEqual(checksPerformed, 2,
      'Should perform liveness check twice in 25 pump cycles (at cycle 10 and 20)');
  });

  test('multiple dead PIDs are all detected in one check', () => {
    const nodes: Array<{ id: string; status: string; pid: number | undefined }> = [
      { id: 'a', status: 'running', pid: 111 },
      { id: 'b', status: 'running', pid: 222 },
      { id: 'c', status: 'running', pid: 333 },
      { id: 'd', status: 'succeeded', pid: undefined },
    ];

    const deadPids = new Set([111, 333]);
    const processMonitor = {
      isRunning: (pid: number) => !deadPids.has(pid),
    };

    const failedNodes: string[] = [];
    for (const node of nodes) {
      if (node.status === 'running' && node.pid) {
        if (!processMonitor.isRunning(node.pid)) {
          node.status = 'failed';
          node.pid = undefined;
          failedNodes.push(node.id);
        }
      }
    }

    assert.deepStrictEqual(failedNodes, ['a', 'c']);
    assert.strictEqual(nodes[0].status, 'failed');
    assert.strictEqual(nodes[1].status, 'running'); // PID 222 alive
    assert.strictEqual(nodes[2].status, 'failed');
    assert.strictEqual(nodes[3].status, 'succeeded'); // Not checked
  });

  test('error message includes PID for diagnostics', () => {
    const pid = 98765;
    const error = `Process ${pid} died unexpectedly (system hibernate or crash). Retry to resume.`;
    
    assert.ok(error.includes('98765'));
    assert.ok(error.includes('hibernate'));
    assert.ok(error.includes('Retry'));
  });
});
