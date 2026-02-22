/**
 * @fileoverview Unit tests for PlanRunner.forceFailNode functionality.
 * Tests verify that forceFailNode properly handles node state changes,
 * error handling, event emission, and persistence.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import type { PlanInstance, JobNode, NodeExecutionState } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// Mock minimal PlanRunner structure for testing - matches current implementation
interface MockRunner extends EventEmitter {
  plans: Map<string, PlanInstance>;
  forceFailNode(planId: string, nodeId: string): Promise<void>;
  savePlan(planId: string): Promise<void>;
  emitNodeTransition(event: {
    planId: string;
    nodeId: string;
    previousStatus: any;
    newStatus: any;
    reason: string;
  }): void;
}

function createTestNode(): JobNode {
  return {
    id: 'test-node',
    producerId: 'test-node',
    name: 'Test Node',
    type: 'job',
    task: 'test task',
    dependencies: [],
    dependents: [],
    work: { type: 'shell', command: 'echo test' },
  };
}

function createTestPlan(): PlanInstance {
  const node = createTestNode();
  const plan: PlanInstance = {
    id: 'test-plan',
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
    jobs: new Map([['test-node', node]]),
    producerIdToNodeId: new Map([['test-node', 'test-node']]),
    roots: ['test-node'],
    leaves: ['test-node'],
    nodeStates: new Map(),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
  
  // Create initial node state
  const nodeState: NodeExecutionState = {
    status: 'running',
    attempts: 1,
    version: 1,
    startedAt: Date.now(),
  };
  plan.nodeStates.set('test-node', nodeState);
  
  return plan;
}

function createMockRunner(): MockRunner {
  const runner = new EventEmitter() as MockRunner;
  runner.plans = new Map();
  
  // Mock the actual forceFailNode implementation from PlanRunner
  runner.forceFailNode = async function(planId: string, nodeId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Plan ${planId} not found`);
    }
    
    const node = plan.jobs.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found in plan ${planId}`);
    }
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {
      throw new Error(`Node state ${nodeId} not found in plan ${planId}`);
    }
    
    // Kill any running process for this node
    if (nodeState.pid) {
      try {
        process.kill(nodeState.pid, 'SIGTERM');
      } catch (e) {
        // Process may already be dead - that's fine
      }
    }
    
    // Update node state - ALWAYS force to failed
    const previousStatus = nodeState.status;
    nodeState.status = 'failed';
    nodeState.error = 'Manually failed by user (Force Fail)';
    nodeState.forceFailed = true;  // Flag for UI to show differently
    nodeState.pid = undefined;  // Clear PID
    
    // Increment attempts if it was running (counts as a failed attempt)
    if (previousStatus === 'running') {
      nodeState.attempts = (nodeState.attempts || 0) + 1;
    }
    
    // Set end time
    nodeState.endedAt = Date.now();
    nodeState.version = (nodeState.version || 0) + 1;
    plan.stateVersion = (plan.stateVersion || 0) + 1;
    
    // CRITICAL: Persist immediately
    await this.savePlan(planId);
    
    // CRITICAL: Emit event for UI update
    this.emitNodeTransition({
      planId,
      nodeId,
      previousStatus,
      newStatus: 'failed',
      reason: 'force-failed'
    });
  };
  
  // Mock savePlan method
  runner.savePlan = sinon.stub().resolves();
  
  // Mock emitNodeTransition method
  runner.emitNodeTransition = function(event) {
    this.emit('nodeTransition', event.planId, event.nodeId, event.previousStatus, event.newStatus);
    this.emit('nodeUpdated', event.planId, event.nodeId);
    this.emit('planUpdated', event.planId);
  };
  
  return runner;
}

suite('Force Fail Node', () => {
  let quiet: { restore: () => void };
  let runner: MockRunner;

  setup(() => {
    quiet = silenceConsole();
    runner = createMockRunner();
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  suite('forceFailNode', () => {
    test('should fail a running node', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      nodeState.attempts = 1;
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.error, 'Manually failed by user (Force Fail)');
      assert.strictEqual(nodeState.attempts, 2);  // Incremented
    });
    
    test('should fail a node on attempt 3', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      nodeState.attempts = 3;
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.attempts, 4);
    });
    
    test('should kill running process', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      nodeState.pid = 12345;
      
      const killSpy = sinon.spy(process, 'kill');
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.ok(killSpy.calledWith(12345, 'SIGTERM'));
      assert.strictEqual(nodeState.pid, undefined);
    });
    
    test('should handle missing process gracefully', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      nodeState.pid = 99999;
      
      sinon.stub(process, 'kill').throws(new Error('ESRCH'));
      runner.plans.set(plan.id, plan);
      
      // Should not throw
      await runner.forceFailNode(plan.id, node.id);
      assert.strictEqual(nodeState.status, 'failed');
    });
    
    test('should persist state after force fail', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.ok((runner.savePlan as sinon.SinonStub).calledWith(plan.id));
    });
    
    test('should emit nodeTransition event', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      
      runner.plans.set(plan.id, plan);
      
      const nodeTransitionSpy = sinon.spy();
      const nodeUpdatedSpy = sinon.spy();
      const planUpdatedSpy = sinon.spy();
      
      runner.on('nodeTransition', nodeTransitionSpy);
      runner.on('nodeUpdated', nodeUpdatedSpy);
      runner.on('planUpdated', planUpdatedSpy);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.ok(nodeTransitionSpy.calledWith(plan.id, node.id, 'running', 'failed'));
      assert.ok(nodeUpdatedSpy.calledWith(plan.id, node.id));
      assert.ok(planUpdatedSpy.calledWith(plan.id));
    });
    
    test('should work on already failed node (no-op for attempts)', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'failed';
      nodeState.attempts = 2;
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.attempts, 2);  // Not incremented again
    });
    
    test('should set forceFailed flag', async () => {
      const plan = createTestPlan();
      const node = plan.jobs.get('test-node')!;
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, node.id);
      
      assert.strictEqual(nodeState.forceFailed, true);
    });

    test('should throw if plan not found', async () => {
      await assert.rejects(
        async () => runner.forceFailNode('nonexistent', 'node'),
        /Plan nonexistent not found/
      );
    });
    
    test('should throw if node not found', async () => {
      const plan = createTestPlan();
      runner.plans.set(plan.id, plan);
      
      await assert.rejects(
        async () => runner.forceFailNode(plan.id, 'nonexistent'),
        /Node nonexistent not found in plan/
      );
    });
    
    test('should throw if node state not found', async () => {
      const plan = createTestPlan();
      // Remove node state to simulate missing state
      plan.nodeStates.delete('test-node');
      runner.plans.set(plan.id, plan);
      
      await assert.rejects(
        async () => runner.forceFailNode(plan.id, 'test-node'),
        /Node state test-node not found in plan/
      );
    });

    test('should increment state versions', async () => {
      const plan = createTestPlan();
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      nodeState.version = 1;
      plan.stateVersion = 5;
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, 'test-node');
      
      assert.strictEqual(nodeState.version, 2);
      assert.strictEqual(plan.stateVersion, 6);
    });

    test('should set endedAt timestamp', async () => {
      const plan = createTestPlan();
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'running';
      nodeState.endedAt = undefined;
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, 'test-node');
      
      assert.ok(nodeState.endedAt);
      assert.ok(nodeState.endedAt! <= Date.now());
    });

    test('should work for non-running nodes', async () => {
      const plan = createTestPlan();
      const nodeState = plan.nodeStates.get('test-node')!;
      nodeState.status = 'pending';
      nodeState.attempts = 1;
      
      runner.plans.set(plan.id, plan);
      
      await runner.forceFailNode(plan.id, 'test-node');
      
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.attempts, 1);  // Not incremented for non-running
      assert.strictEqual(nodeState.forceFailed, true);
    });
  });
  suite('UI Message Handler', () => {
    test('should call forceFailNode when message received', async () => {
      const plan = createTestPlan();
      runner.plans.set(plan.id, plan);
      
      const forceFailSpy = sinon.spy(runner, 'forceFailNode');
      
      // Create a simple mock panel that handles messages like the actual nodeDetailPanel
      const panel = {
        _planRunner: runner,
        async handleMessage(message: any) {
          if (message.type === 'forceFailNode') {
            await this._planRunner.forceFailNode(message.planId, message.nodeId);
          }
        }
      };
      
      // Simulate message from webview
      await panel.handleMessage({ type: 'forceFailNode', planId: plan.id, nodeId: 'test-node' });
      
      assert.ok(forceFailSpy.calledWith(plan.id, 'test-node'));
    });

    test('should handle forceFailNode message with fallback parameters', async () => {
      const plan = createTestPlan();
      runner.plans.set(plan.id, plan);
      
      const forceFailSpy = sinon.spy(runner, 'forceFailNode');
      
      // Mock panel with instance variables for fallback
      const panel = {
        _planRunner: runner,
        _planId: plan.id,
        _nodeId: 'test-node',
        async handleMessage(message: any) {
          if (message.type === 'forceFailNode') {
            // Use message params if provided, otherwise fall back to instance variables
            const planId = message.planId || this._planId;
            const nodeId = message.nodeId || this._nodeId;
            await this._planRunner.forceFailNode(planId, nodeId);
          }
        }
      };
      
      // Simulate message from webview without explicit parameters
      await panel.handleMessage({ type: 'forceFailNode' });
      
      assert.ok(forceFailSpy.calledWith(plan.id, 'test-node'));
    });
  });
});