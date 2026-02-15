/**
 * @fileoverview Unit tests for DefaultJobExecutor.getAllProcessStats()
 * 
 * Tests cover:
 * - Execution key mapping with attemptNumber
 * - Multiple attempts for the same node
 * - Execution cleanup after job completion
 * - Agent work without process vs shell work with process
 */

import * as assert from 'assert';
import * as sinon from 'sinon';

// Stub dependencies for DefaultJobExecutor constructor
const stubSpawner = { spawn: () => ({ pid: undefined, exitCode: null, killed: false, stdout: null, stderr: null, kill: () => true, on: () => ({}) }) } as any;
const stubValidator = { validate: async () => ({ isValid: true }) } as any;
const stubMonitor = { getSnapshot: async () => [], buildTree: () => [], isRunning: () => false, terminate: async () => {} } as any;

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('DefaultJobExecutor - getAllProcessStats', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  /**
   * Test 1: Execution key mapping
   * Verifies that getAllProcessStats correctly finds an execution
   * using the activeExecutionsByNode map with attemptNumber.
   */
  test('finds execution by planId:nodeId with attemptNumber', async () => {
    // Clear require cache to get a fresh executor
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor to avoid OS-level queries
    const mockSnapshot = [
      { pid: 1234, ppid: 1000, name: 'node', cpu: 10, memory: 100 },
      { pid: 1235, ppid: 1234, name: 'child', cpu: 5, memory: 50 }
    ];
    sandbox.stub(executor['processMonitor'], 'getSnapshot').resolves(mockSnapshot);
    sandbox.stub(executor['processMonitor'], 'isRunning').returns(true);
    sandbox.stub(executor['processMonitor'], 'buildTree').returns([
      { pid: 1234, name: 'node', children: [
        { pid: 1235, name: 'child', children: [] }
      ]}
    ]);

    // Simulate an active execution with attemptNumber
    const executionKey = 'plan1:node1:1';
    const nodeKey = 'plan1:node1';
    const mockProcess = { pid: 1234, killed: false } as any;
    
    executor['activeExecutions'].set(executionKey, {
      planId: 'plan1',
      nodeId: 'node1',
      process: mockProcess,
      aborted: false,
      startTime: Date.now() - 5000
    });
    executor['activeExecutionsByNode'].set(nodeKey, executionKey);

    // Call getAllProcessStats
    const result = await executor.getAllProcessStats([{
      planId: 'plan1',
      nodeId: 'node1',
      nodeName: 'Test Job'
    }]);

    // Verify the execution was found and returned
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].nodeId, 'node1');
    assert.strictEqual(result[0].nodeName, 'Test Job');
    assert.strictEqual(result[0].pid, 1234);
    assert.strictEqual(result[0].running, true);
    assert.ok(result[0].tree.length > 0);
    assert.ok(result[0].duration !== null && result[0].duration >= 5000);
  });

  /**
   * Test 2: Multiple attempts for the same node
   * Verifies that when a node has multiple attempts (e.g., retry),
   * getAllProcessStats returns the latest execution.
   */
  test('returns latest execution when multiple attempts exist for same node', async () => {
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor
    sandbox.stub(executor['processMonitor'], 'getSnapshot').resolves([
      { pid: 2000, ppid: 1000, name: 'attempt2', cpu: 10, memory: 100 }
    ]);
    sandbox.stub(executor['processMonitor'], 'isRunning').returns(true);
    sandbox.stub(executor['processMonitor'], 'buildTree').returns([
      { pid: 2000, name: 'attempt2', children: [] }
    ]);

    const nodeKey = 'plan2:node2';
    
    // First attempt (attempt 1)
    const executionKey1 = 'plan2:node2:1';
    executor['activeExecutions'].set(executionKey1, {
      planId: 'plan2',
      nodeId: 'node2',
      process: { pid: 1999, killed: false } as any,
      aborted: false,
      startTime: Date.now() - 10000
    });

    // Second attempt (attempt 2) - this should be the active one
    const executionKey2 = 'plan2:node2:2';
    executor['activeExecutions'].set(executionKey2, {
      planId: 'plan2',
      nodeId: 'node2',
      process: { pid: 2000, killed: false } as any,
      aborted: false,
      startTime: Date.now() - 3000
    });

    // Only the latest attempt is tracked in activeExecutionsByNode
    executor['activeExecutionsByNode'].set(nodeKey, executionKey2);

    // Call getAllProcessStats
    const result = await executor.getAllProcessStats([{
      planId: 'plan2',
      nodeId: 'node2',
      nodeName: 'Retry Job'
    }]);

    // Verify only the latest attempt (2) is returned
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 2000, 'Should return attempt 2 with pid 2000');
    assert.ok(result[0].duration !== null && result[0].duration >= 3000);
    assert.ok(result[0].duration! < 10000, 'Duration should reflect attempt 2, not attempt 1');
  });

  /**
   * Test 3: Execution cleanup
   * Verifies that after cleanup, getAllProcessStats no longer returns
   * the execution.
   */
  test('returns empty after execution cleanup', async () => {
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor
    sandbox.stub(executor['processMonitor'], 'getSnapshot').resolves([]);

    const executionKey = 'plan3:node3:1';
    const nodeKey = 'plan3:node3';
    
    // Create an active execution
    executor['activeExecutions'].set(executionKey, {
      planId: 'plan3',
      nodeId: 'node3',
      process: { pid: 3000, killed: false } as any,
      aborted: false,
      startTime: Date.now()
    });
    executor['activeExecutionsByNode'].set(nodeKey, executionKey);

    // Verify it's found before cleanup
    let result = await executor.getAllProcessStats([{
      planId: 'plan3',
      nodeId: 'node3',
      nodeName: 'Cleanup Test'
    }]);
    assert.strictEqual(result.length, 1);

    // Simulate cleanup (what happens in finally block of execute())
    executor['activeExecutions'].delete(executionKey);
    executor['activeExecutionsByNode'].delete(nodeKey);

    // Verify it's no longer found after cleanup
    result = await executor.getAllProcessStats([{
      planId: 'plan3',
      nodeId: 'node3',
      nodeName: 'Cleanup Test'
    }]);
    assert.strictEqual(result.length, 0);
  });

  /**
   * Test 4: Agent work without process
   * Verifies that agent work (isAgentWork=true) returns stats even
   * without a process, while shell work requires a process.
   */
  test('handles agent work without process and shell work with process', async () => {
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor
    const mockSnapshot = [
      { pid: 4001, ppid: 1000, name: 'shell', cpu: 10, memory: 100 }
    ];
    sandbox.stub(executor['processMonitor'], 'getSnapshot').resolves(mockSnapshot);
    sandbox.stub(executor['processMonitor'], 'isRunning').returns(true);
    sandbox.stub(executor['processMonitor'], 'buildTree').returns([
      { pid: 4001, name: 'shell', children: [] }
    ]);

    // Agent work without a process yet (isAgentWork=true, no process)
    const agentKey = 'plan4:agent1:1';
    const agentNodeKey = 'plan4:agent1';
    executor['activeExecutions'].set(agentKey, {
      planId: 'plan4',
      nodeId: 'agent1',
      aborted: false,
      startTime: Date.now() - 2000,
      isAgentWork: true
      // No process field
    });
    executor['activeExecutionsByNode'].set(agentNodeKey, agentKey);

    // Shell work with a process
    const shellKey = 'plan4:shell1:1';
    const shellNodeKey = 'plan4:shell1';
    executor['activeExecutions'].set(shellKey, {
      planId: 'plan4',
      nodeId: 'shell1',
      process: { pid: 4001, killed: false } as any,
      aborted: false,
      startTime: Date.now() - 3000
    });
    executor['activeExecutionsByNode'].set(shellNodeKey, shellKey);

    // Call getAllProcessStats for both
    const result = await executor.getAllProcessStats([
      { planId: 'plan4', nodeId: 'agent1', nodeName: 'Agent Work' },
      { planId: 'plan4', nodeId: 'shell1', nodeName: 'Shell Work' }
    ]);

    // Verify both are returned
    assert.strictEqual(result.length, 2);

    // Find agent and shell results
    const agentResult = result.find((r: any) => r.nodeId === 'agent1');
    const shellResult = result.find((r: any) => r.nodeId === 'shell1');

    // Agent work: no pid, but still running with isAgentWork flag
    assert.ok(agentResult, 'Agent work should be returned');
    assert.strictEqual(agentResult!.pid, null);
    assert.strictEqual(agentResult!.running, true);
    assert.strictEqual(agentResult!.isAgentWork, true);
    assert.deepStrictEqual(agentResult!.tree, []);
    assert.ok(agentResult!.duration !== null && agentResult!.duration >= 2000);

    // Shell work: has pid and process tree
    assert.ok(shellResult, 'Shell work should be returned');
    assert.strictEqual(shellResult!.pid, 4001);
    assert.strictEqual(shellResult!.running, true);
    assert.ok(shellResult!.tree.length > 0);
    assert.ok(shellResult!.duration !== null && shellResult!.duration >= 3000);
  });

  /**
   * Test 5: Shell work without process is skipped
   * Verifies that non-agent work without a process is not returned.
   */
  test('skips non-agent work without process', async () => {
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor
    sandbox.stub(executor['processMonitor'], 'getSnapshot').resolves([]);

    // Non-agent work without a process (should be skipped)
    const executionKey = 'plan5:node5:1';
    const nodeKey = 'plan5:node5';
    executor['activeExecutions'].set(executionKey, {
      planId: 'plan5',
      nodeId: 'node5',
      aborted: false,
      startTime: Date.now()
      // No process, no isAgentWork flag
    });
    executor['activeExecutionsByNode'].set(nodeKey, executionKey);

    // Call getAllProcessStats
    const result = await executor.getAllProcessStats([{
      planId: 'plan5',
      nodeId: 'node5',
      nodeName: 'No Process Job'
    }]);

    // Verify it's not returned
    assert.strictEqual(result.length, 0);
  });

  /**
   * Test 6: Returns empty for unknown planId/nodeId
   * Verifies that requesting stats for non-existent executions returns empty.
   */
  test('returns empty for unknown planId/nodeId', async () => {
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor
    sandbox.stub(executor['processMonitor'], 'getSnapshot').resolves([]);

    // Call with unknown execution
    const result = await executor.getAllProcessStats([{
      planId: 'unknown',
      nodeId: 'unknown',
      nodeName: 'Unknown'
    }]);

    // Verify empty result
    assert.strictEqual(result.length, 0);
  });

  /**
   * Test 7: Handles process monitor errors gracefully
   * Verifies that errors from ProcessMonitor (snapshot, buildTree) don't crash getAllProcessStats.
   */
  test('handles ProcessMonitor errors gracefully', async () => {
    delete require.cache[require.resolve('../../../plan/executor')];
    const { DefaultJobExecutor } = require('../../../plan/executor');
    const executor = new DefaultJobExecutor(stubSpawner, stubValidator, stubMonitor);
    
    // Mock ProcessMonitor to have errors
    sandbox.stub(executor['processMonitor'], 'getSnapshot').rejects(new Error('snapshot failed'));
    sandbox.stub(executor['processMonitor'], 'isRunning').returns(false); // Process not running
    sandbox.stub(executor['processMonitor'], 'buildTree').throws(new Error('buildTree failed'));

    // Create an active execution
    const executionKey = 'plan6:node6:1';
    const nodeKey = 'plan6:node6';
    executor['activeExecutions'].set(executionKey, {
      planId: 'plan6',
      nodeId: 'node6',
      process: { pid: 6000, killed: false } as any,
      aborted: false,
      startTime: Date.now()
    });
    executor['activeExecutionsByNode'].set(nodeKey, executionKey);

    // Call getAllProcessStats - should not throw
    const result = await executor.getAllProcessStats([{
      planId: 'plan6',
      nodeId: 'node6',
      nodeName: 'Error Test'
    }]);

    // Should return the execution even when process is not running (code checks `running || pid`)
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].nodeId, 'node6');
    assert.strictEqual(result[0].pid, 6000);
    assert.strictEqual(result[0].running, false);
  });
});
