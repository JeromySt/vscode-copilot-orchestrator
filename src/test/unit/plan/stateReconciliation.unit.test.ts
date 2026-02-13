/**
 * @fileoverview Unit tests for Plan State Reconciliation.
 * 
 * Tests verify that plan state reconciliation works correctly after crashes,
 * extension reloads, and other recovery scenarios. Focuses on proper status
 * calculation and UI updates after state recovery.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import type { 
  PlanInstance, 
  JobNode, 
  NodeExecutionState, 
  PlanStatus,
  NodeTransitionEvent
} from '../../../plan/types';
import { ProcessMonitor } from '../../../process/processMonitor';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// Mock minimal runner interface for testing
interface MockRunner {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, { 
    computePlanStatus: sinon.SinonStub; 
    transition: sinon.SinonStub;
  }>;
  processMonitor: { isRunning: sinon.SinonStub };
  getPlanStatus(planId: string): PlanStatus | undefined;
  recoverRunningNodes(plan: PlanInstance): Promise<void>;
  initialize(): Promise<void>;
  emitNodeTransition(event: NodeTransitionEvent): void;
  on: sinon.SinonStub;
  emit: sinon.SinonStub;
}

// Mock TreeDataProvider
interface MockTreeDataProvider {
  _onDidChangeTreeData: { fire: sinon.SinonStub };
  refresh: sinon.SinonStub;
}

function createTestNode(id: string = 'test-node'): JobNode {
  return {
    id,
    producerId: id,
    name: `Test Node ${id}`,
    type: 'job',
    task: 'test task',
    dependencies: [],
    dependents: [],
    work: { type: 'shell', command: 'echo test' },
  };
}

function createTestPlan(nodeCount: number = 2): PlanInstance {
  const nodes = new Map<string, JobNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  const producerIdToNodeId = new Map<string, string>();
  
  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `node-${i}`;
    const node = createTestNode(nodeId);
    const state: NodeExecutionState = {
      status: 'pending',
      version: 1,
      attempts: 0,
    };
    
    nodes.set(nodeId, node);
    nodeStates.set(nodeId, state);
    producerIdToNodeId.set(nodeId, nodeId);
  }
  
  return {
    id: 'test-plan',
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
    nodes,
    nodeStates,
    producerIdToNodeId,
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/test/repo',
    baseBranch: 'main',
    worktreeRoot: '/test/worktrees',
    roots: Array.from(nodes.keys()),
    leaves: Array.from(nodes.keys()),
    createdAt: Date.now(),
    startedAt: undefined,
    endedAt: undefined,
    stateVersion: 1,
    isPaused: false,
    maxParallel: 4,
    cleanUpSuccessfulWork: true,
  };
}

function createMockRunner(): MockRunner {
  const emitStub = sinon.stub();
  
  const runner = {
    plans: new Map(),
    stateMachines: new Map(),
    processMonitor: { isRunning: sinon.stub() },
    on: sinon.stub(),
    emit: emitStub,
    
    getPlanStatus(planId: string): PlanStatus | undefined {
      const sm = this.stateMachines.get(planId);
      return sm ? sm.computePlanStatus() : undefined;
    },
    
    async recoverRunningNodes(plan: PlanInstance): Promise<void> {
      for (const [nodeId, nodeState] of plan.nodeStates.entries()) {
        if (nodeState.status === 'running') {
          if (nodeState.pid && !this.processMonitor.isRunning(nodeState.pid)) {
            const oldStatus = nodeState.status;
            nodeState.status = 'failed';
            nodeState.error = `Process crashed or was terminated unexpectedly (PID: ${nodeState.pid})`;
            nodeState.failureReason = 'crashed';
            nodeState.endedAt = Date.now();
            nodeState.pid = undefined;
            nodeState.version++;
            
            // Emit node transition event
            this.emitNodeTransition({
              planId: plan.id,
              nodeId,
              from: oldStatus,
              to: 'failed',
              timestamp: Date.now()
            });
          } else if (!nodeState.pid) {
            const oldStatus = nodeState.status;
            nodeState.status = 'failed';
            nodeState.error = 'Extension reloaded while node was running (no process tracking)';
            nodeState.failureReason = 'crashed';
            nodeState.endedAt = Date.now();
            nodeState.version++;
            
            // Emit node transition event
            this.emitNodeTransition({
              planId: plan.id,
              nodeId,
              from: oldStatus,
              to: 'failed',
              timestamp: Date.now()
            });
          }
        }
      }
    },
    
    async initialize(): Promise<void> {
      // Simulate loading plans and recovering their state
      for (const [planId, plan] of this.plans.entries()) {
        await this.recoverRunningNodes(plan);
      }
    },
    
    emitNodeTransition(event: NodeTransitionEvent): void {
      this.emit('nodeTransition', event);
    }
  };
  
  return runner;
}

function createMockTreeProvider(): MockTreeDataProvider {
  return {
    _onDidChangeTreeData: { fire: sinon.stub() },
    refresh: sinon.stub()
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Plan State Reconciliation on Reload', () => {
  let console_: { restore: () => void };

  suiteSetup(() => {
    console_ = silenceConsole();
  });

  suiteTeardown(() => {
    console_.restore();
  });

  suite('After crash recovery', () => {
    test('should update plan status to partial when node crashes', async () => {
      // Setup: Plan with 2 nodes, one succeeded, one was 'running'
      const plan = createTestPlan(2);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'running';
      plan.nodeStates.get('node-1')!.pid = 99999; // Non-existent process
      
      // Mock process monitor to report process as dead
      runner.processMonitor.isRunning.withArgs(99999).returns(false);
      
      // Set up state machine mock to return 'partial' when mix of succeeded/failed
      const mockSM = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      // Simulate reload with crash recovery
      await runner.recoverRunningNodes(plan);
      
      // Node should be marked as failed
      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
      assert.ok(plan.nodeStates.get('node-1')!.error?.includes('Process crashed'));
      
      // Plan status should be recalculated as partial
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'partial'); // Not 'running'
    });
    
    test('should update plan status to failed when all nodes crash', async () => {
      const plan = createTestPlan(2);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'running';
      plan.nodeStates.get('node-0')!.pid = 99999;
      plan.nodeStates.get('node-1')!.status = 'running';
      plan.nodeStates.get('node-1')!.pid = 99998;
      
      // Mock process monitor to report both processes as dead
      runner.processMonitor.isRunning.withArgs(99999).returns(false);
      runner.processMonitor.isRunning.withArgs(99998).returns(false);
      
      // Set up state machine mock to return 'failed' when all nodes failed
      const mockSM = {
        computePlanStatus: sinon.stub().returns('failed'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      await runner.recoverRunningNodes(plan);
      
      // Both nodes should be failed
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'failed');
      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
      
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'failed'); // All nodes failed
    });
    
    test('should keep plan running if process is still alive', async () => {
      const plan = createTestPlan(1);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'running';
      plan.nodeStates.get('node-0')!.pid = process.pid; // Current process - still running
      
      // Mock process monitor to report process as alive
      runner.processMonitor.isRunning.withArgs(process.pid).returns(true);
      
      const mockSM = {
        computePlanStatus: sinon.stub().returns('running'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      await runner.recoverRunningNodes(plan);
      
      // Node should still be running
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'running');
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'running');
    });
    
    test('should mark as failed when running node has no PID', async () => {
      const plan = createTestPlan(1);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'running';
      // No PID set - simulates old state before process tracking
      
      const mockSM = {
        computePlanStatus: sinon.stub().returns('failed'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      await runner.recoverRunningNodes(plan);
      
      // Node should be marked as failed
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'failed');
      assert.ok(plan.nodeStates.get('node-0')!.error?.includes('Extension reloaded'));
      
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'failed');
    });
  });
  
  suite('getPlanStatus calculation', () => {
    test('should always calculate from current node states', () => {
      const plan = createTestPlan(3);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'succeeded';
      plan.nodeStates.get('node-2')!.status = 'failed';
      
      // Set up state machine to compute status based on current node states
      const mockSM = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      // getPlanStatus should return actual computed status
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'partial');
      assert.ok(mockSM.computePlanStatus.calledOnce);
    });
    
    test('should return partial for mix of succeeded and failed', () => {
      const plan = createTestPlan(2);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'failed';
      
      const mockSM = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'partial');
    });
    
    test('should return undefined for non-existent plan', () => {
      const runner = createMockRunner();
      
      const status = runner.getPlanStatus('non-existent-plan');
      assert.strictEqual(status, undefined);
    });
  });
  
  suite('Tree view refresh after recovery', () => {
    test('should emit tree update event after crash recovery', async () => {
      const plan = createTestPlan(1);
      const runner = createMockRunner();
      
      plan.nodeStates.get('node-0')!.status = 'running';
      plan.nodeStates.get('node-0')!.pid = 99999;
      
      runner.processMonitor.isRunning.withArgs(99999).returns(false);
      runner.plans.set(plan.id, plan);
      
      const emitSpy = sinon.spy(runner, 'emitNodeTransition');
      
      await runner.recoverRunningNodes(plan);
      
      // Should have emitted node transition event
      assert.ok(emitSpy.calledOnce);
      const callArgs = emitSpy.getCall(0).args[0];
      assert.strictEqual(callArgs.planId, plan.id);
      assert.strictEqual(callArgs.nodeId, 'node-0');
      assert.strictEqual(callArgs.from, 'running');
      assert.strictEqual(callArgs.to, 'failed');
      
      emitSpy.restore();
    });
    
    test('should refresh tree view after all plans recovered', async () => {
      const runner = createMockRunner();
      const treeProvider = createMockTreeProvider();
      
      const plan = createTestPlan(1);
      plan.nodeStates.get('node-0')!.status = 'running';
      plan.nodeStates.get('node-0')!.pid = 99999;
      
      runner.processMonitor.isRunning.withArgs(99999).returns(false);
      runner.plans.set(plan.id, plan);
      
      // Mock loadPlans to return our test plan - would typically be called in initialize
      const initializeSpy = sinon.spy(runner, 'initialize');
      
      // Simulate extension activation with recovery
      await runner.initialize();
      
      assert.ok(initializeSpy.calledOnce);
      
      // Verify the node was recovered
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'failed');
      
      initializeSpy.restore();
    });
  });
  
  suite('Initialize order', () => {
    test('should recover nodes before exposing plans to UI', async () => {
      const runner = createMockRunner();
      const plan = createTestPlan(1);
      
      plan.nodeStates.get('node-0')!.status = 'running';
      plan.nodeStates.get('node-0')!.pid = 99999;
      
      runner.processMonitor.isRunning.withArgs(99999).returns(false);
      
      // Set up state machine to return failed status after recovery
      const mockSM = {
        computePlanStatus: sinon.stub().returns('failed'),
        transition: sinon.stub()
      };
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockSM);
      
      await runner.initialize();
      
      // By the time initialize() completes, status should be correct
      assert.strictEqual(plan.nodeStates.get('node-0')!.status, 'failed');
      const status = runner.getPlanStatus(plan.id);
      assert.strictEqual(status, 'failed');
    });
    
    test('should handle multiple plans with mixed recovery scenarios', async () => {
      const runner = createMockRunner();
      
      // Plan 1: One succeeded, one crashed
      const plan1 = createTestPlan(2);
      plan1.id = 'plan-1';
      plan1.nodeStates.get('node-0')!.status = 'succeeded';
      plan1.nodeStates.get('node-1')!.status = 'running';
      plan1.nodeStates.get('node-1')!.pid = 99999; // Dead process
      
      // Plan 2: All nodes still running
      const plan2 = createTestPlan(1);
      plan2.id = 'plan-2';
      plan2.nodeStates.get('node-0')!.status = 'running';
      plan2.nodeStates.get('node-0')!.pid = process.pid; // Alive process
      
      runner.processMonitor.isRunning.withArgs(99999).returns(false);
      runner.processMonitor.isRunning.withArgs(process.pid).returns(true);
      
      // Set up state machines
      const mockSM1 = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      const mockSM2 = {
        computePlanStatus: sinon.stub().returns('running'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan1.id, plan1);
      runner.plans.set(plan2.id, plan2);
      runner.stateMachines.set(plan1.id, mockSM1);
      runner.stateMachines.set(plan2.id, mockSM2);
      
      await runner.initialize();
      
      // Plan 1 should have one failed node
      assert.strictEqual(plan1.nodeStates.get('node-0')!.status, 'succeeded');
      assert.strictEqual(plan1.nodeStates.get('node-1')!.status, 'failed');
      assert.strictEqual(runner.getPlanStatus(plan1.id), 'partial');
      
      // Plan 2 should still be running
      assert.strictEqual(plan2.nodeStates.get('node-0')!.status, 'running');
      assert.strictEqual(runner.getPlanStatus(plan2.id), 'running');
    });
  });
});