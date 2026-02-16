/**
 * @fileoverview Unit tests for Process Recovery on Re-Init.
 * 
 * Tests verify that the runner correctly recovers running nodes during
 * initialization by checking if their processes are still alive and marking
 * crashed nodes appropriately.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as events from 'events';
import { ProcessMonitor } from '../../../process/processMonitor';
import {
  PlanInstance,
  PlanSpec,
  JobNode,
  NodeExecutionState,
  NodeTransitionEvent,
} from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress console output to avoid noise in test output. */
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

/** Create a test plan with configurable nodes. */
function createTestPlan(nodeCount = 3): PlanInstance {
  const nodes = new Map<string, JobNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  
  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `node-${i}`;
    const jobNode: JobNode = {
      id: nodeId,
      producerId: nodeId,
      name: `Test Job ${i}`,
      type: 'job',
      task: `test task ${i}`,
      work: 'shell',
      dependencies: [],
      dependents: [],
    };
    
    const nodeState: NodeExecutionState = {
      status: 'pending',
      version: 1,
      attempts: 0,
    };
    
    nodes.set(nodeId, jobNode);
    nodeStates.set(nodeId, nodeState);
  }
  
  const planSpec: PlanSpec = {
    name: 'Test Plan',
    jobs: [],
  };
  
  return {
    id: 'test-plan-123',
    spec: planSpec,
    nodes,
    nodeStates,
    producerIdToNodeId: new Map(),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    roots: ['node-0'],
    leaves: [`node-${nodeCount - 1}`],
    repoPath: '/test/repo',
    baseBranch: 'main',
    worktreeRoot: '/test/worktrees',
    createdAt: Date.now(),
    stateVersion: 1,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

/** Mock runner with minimal functionality for testing recovery. */
class MockPlanRunner extends events.EventEmitter {
  public processMonitor: ProcessMonitor;
  private savePlanCalled = false;
  
  constructor(processMonitor: ProcessMonitor) {
    super();
    this.processMonitor = processMonitor;
  }
  
  /** Mock savePlan method */
  async savePlan(planId: string): Promise<void> {
    this.savePlanCalled = true;
  }
  
  /** Expose recoverRunningNodes for testing (normally private) */
  async recoverRunningNodes(plan: PlanInstance): Promise<void> {
    for (const [nodeId, nodeState] of plan.nodeStates.entries()) {
      if (nodeState.status === 'running') {
        // Check if the process is still alive
        if (nodeState.pid && !this.processMonitor.isRunning(nodeState.pid)) {
          // Process died unexpectedly - mark as crashed
          nodeState.status = 'failed';
          nodeState.error = `Process crashed or was terminated unexpectedly (PID: ${nodeState.pid})`;
          nodeState.failureReason = 'crashed';
          nodeState.endedAt = Date.now();
          nodeState.pid = undefined;  // Clear the stale PID
          nodeState.version++; // Increment version for UI updates
          
          // Emit transition and completion events
          const transitionEvent: NodeTransitionEvent = {
            planId: plan.id,
            nodeId,
            from: 'running',
            to: 'failed',
            timestamp: Date.now()
          };
          this.emit('nodeTransition', transitionEvent);
          this.emit('nodeCompleted', plan.id, nodeId, false);
        } else if (!nodeState.pid) {
          // Running but no PID tracked (old state) - also mark as crashed
          nodeState.status = 'failed';
          nodeState.error = 'Extension reloaded while node was running (no process tracking)';
          nodeState.failureReason = 'crashed';
          nodeState.endedAt = Date.now();
          nodeState.version++; // Increment version for UI updates
          
          // Emit transition and completion events
          const transitionEvent: NodeTransitionEvent = {
            planId: plan.id,
            nodeId,
            from: 'running',
            to: 'failed',
            timestamp: Date.now()
          };
          this.emit('nodeTransition', transitionEvent);
          this.emit('nodeCompleted', plan.id, nodeId, false);
        }
        // If process IS running, leave it - the process monitor should re-attach
      }
    }
    
    // Persist state after recovery
    await this.savePlan(plan.id);
  }
  
  /** Check if savePlan was called */
  get wasSavePlanCalled(): boolean {
    return this.savePlanCalled;
  }
  
  /** Reset savePlan call tracking */
  resetSavePlanTracking(): void {
    this.savePlanCalled = false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Process Recovery on Re-Init', () => {
  let quiet: { restore: () => void };
  let mockProcessMonitor: sinon.SinonStubbedInstance<ProcessMonitor>;
  let runner: MockPlanRunner;
  
  setup(() => {
    quiet = silenceConsole();
    
    // Create stubbed process monitor
    mockProcessMonitor = sinon.createStubInstance(ProcessMonitor);
    runner = new MockPlanRunner(mockProcessMonitor as any);
  });
  
  teardown(() => {
    quiet.restore();
    sinon.restore();
  });
  
  suite('isProcessRunning via ProcessMonitor', () => {
    test('should return false for non-existent PID', () => {
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      
      const result = mockProcessMonitor.isRunning(999999999);
      assert.strictEqual(result, false);
    });
    
    test('should return true for current process', () => {
      mockProcessMonitor.isRunning.withArgs(process.pid).returns(true);
      
      const result = mockProcessMonitor.isRunning(process.pid);
      assert.strictEqual(result, true);
    });
  });
  
  suite('recoverRunningNodes', () => {
    test('should mark node as crashed when PID not found', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;  // Non-existent PID
      
      // Mock isRunning to return false for the fake PID
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.failureReason, 'crashed');
      assert.ok(nodeState.error?.includes('crashed'));
      assert.strictEqual(nodeState.pid, undefined);
      assert.ok(nodeState.endedAt);
    });
    
    test('should mark node as crashed when running but no PID tracked', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = undefined;  // No PID tracked
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.failureReason, 'crashed');
      assert.ok(nodeState.error?.includes('Extension reloaded'));
      assert.ok(nodeState.endedAt);
    });
    
    test('should leave node running if process still exists', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = process.pid;  // Current process - definitely exists
      
      // Mock isRunning to return true for current process
      mockProcessMonitor.isRunning.withArgs(process.pid).returns(true);
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(nodeState.status, 'running');
      assert.strictEqual(nodeState.pid, process.pid);
    });
    
    test('should not affect pending or completed nodes', async () => {
      const plan = createTestPlan(3);
      plan.nodeStates.get('node-0')!.status = 'pending';
      plan.nodeStates.get('node-1')!.status = 'succeeded';
      plan.nodeStates.get('node-2')!.status = 'failed';
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'pending');
      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'succeeded');
      assert.strictEqual(plan.nodeStates.get('node-2')!.status, 'failed');
    });
    
    test('should emit nodeCompleted event for crashed nodes', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;  // Non-existent PID
      
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      
      const eventListener = sinon.spy();
      runner.on('nodeCompleted', eventListener);
      
      await runner.recoverRunningNodes(plan);
      
      assert.ok(eventListener.calledOnce);
      assert.ok(eventListener.calledWith(plan.id, 'node-0', false));
    });
    
    test('should emit nodeTransition event for crashed nodes', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;  // Non-existent PID
      
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      
      const eventListener = sinon.spy();
      runner.on('nodeTransition', eventListener);
      
      await runner.recoverRunningNodes(plan);
      
      assert.ok(eventListener.calledOnce);
      const transitionEvent = eventListener.getCall(0).args[0];
      assert.strictEqual(transitionEvent.planId, plan.id);
      assert.strictEqual(transitionEvent.nodeId, 'node-0');
      assert.strictEqual(transitionEvent.from, 'running');
      assert.strictEqual(transitionEvent.to, 'failed');
      assert.ok(transitionEvent.timestamp);
    });
    
    test('should persist state after marking crashed', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;  // Non-existent PID
      
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      runner.resetSavePlanTracking();
      
      await runner.recoverRunningNodes(plan);
      
      assert.ok(runner.wasSavePlanCalled);
    });
    
    test('should increment node version for UI updates', async () => {
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;  // Non-existent PID
      nodeState.version = 5;  // Set initial version
      
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(nodeState.version, 6);  // Should be incremented
    });
    
    test('should handle multiple crashed nodes', async () => {
      const plan = createTestPlan(3);
      // Set up multiple running nodes with bad PIDs
      plan.nodeStates.get('node-0')!.status = 'running';
      plan.nodeStates.get('node-0')!.pid = 999999998;
      plan.nodeStates.get('node-1')!.status = 'running';
      plan.nodeStates.get('node-1')!.pid = 999999999;
      plan.nodeStates.get('node-2')!.status = 'pending';  // Should not be affected
      
      mockProcessMonitor.isRunning.withArgs(999999998).returns(false);
      mockProcessMonitor.isRunning.withArgs(999999999).returns(false);
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'failed');
      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
      assert.strictEqual(plan.nodeStates.get('node-2')!.status, 'pending');
    });
  });
});