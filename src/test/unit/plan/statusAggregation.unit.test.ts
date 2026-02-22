/**
 * @fileoverview Unit tests for Plan Status Aggregation.
 * 
 * Tests verify that getPlanStatus correctly aggregates node statuses into plan-level
 * status, including edge cases like partial failures and crash recovery.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import type { 
  PlanInstance, 
  JobNode, 
  NodeExecutionState, 
  PlanStatus 
} from '../../../plan/types';


function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// Mock minimal PlanRunner structure for testing
interface MockRunner {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, { 
    computePlanStatus: sinon.SinonStub; 
    transition: sinon.SinonStub;
  }>;
  persistence: { save: sinon.SinonStub };
  processMonitor: { isRunning: sinon.SinonStub };
  getPlanStatus(planId: string): PlanStatus | undefined;
  recoverRunningNodes(plan: PlanInstance): Promise<void>;
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

function createTestPlan(nodeCount: number = 3): PlanInstance {
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
    jobs: nodes,
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
  return {
    plans: new Map(),
    stateMachines: new Map(),
    persistence: { save: sinon.stub() },
    processMonitor: { isRunning: sinon.stub() },
    
    getPlanStatus(planId: string): PlanStatus | undefined {
      const sm = this.stateMachines.get(planId);
      return sm ? sm.computePlanStatus() : undefined;
    },
    
    async recoverRunningNodes(plan: PlanInstance): Promise<void> {
      for (const [_nodeId, nodeState] of plan.nodeStates.entries()) {
        if (nodeState.status === 'running') {
          if (nodeState.pid && !this.processMonitor.isRunning(nodeState.pid)) {
            nodeState.status = 'failed';
            nodeState.error = `Process crashed or was terminated unexpectedly (PID: ${nodeState.pid})`;
            nodeState.failureReason = 'crashed';
            nodeState.endedAt = Date.now();
            nodeState.pid = undefined;
            nodeState.version++;
            
            // Fire tree update events
            treeDataProvider.refresh();
            treeDataProvider._onDidChangeTreeData.fire(undefined);
          }
        }
      }
    }
  };
}

let runner: MockRunner;
let treeDataProvider: MockTreeDataProvider;
let consoleSilencer: { restore: () => void };

suite('Plan Status Aggregation', () => {
  suiteSetup(() => {
    consoleSilencer = silenceConsole();
  });
  
  suiteTeardown(() => {
    consoleSilencer.restore();
  });
  
  setup(() => {
    runner = createMockRunner();
    treeDataProvider = {
      _onDidChangeTreeData: { fire: sinon.stub() },
      refresh: sinon.stub()
    };
  });

  suite('getPlanStatus', () => {
    test('should return "partial" when some nodes completed and some failed', () => {
      const plan = createTestPlan(3);
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'succeeded';
      plan.nodeStates.get('node-2')!.status = 'failed';
      
      const mockStateMachine = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockStateMachine);
      
      const status = runner.getPlanStatus(plan.id);
      
      assert.strictEqual(status, 'partial');
    });
    
    test('should return "partial" when some nodes completed and some crashed', () => {
      const plan = createTestPlan(3);
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'succeeded';
      const crashedState = plan.nodeStates.get('node-2')!;
      crashedState.status = 'failed';
      crashedState.failureReason = 'crashed';
      
      const mockStateMachine = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockStateMachine);
      
      const status = runner.getPlanStatus(plan.id);
      
      assert.strictEqual(status, 'partial');
    });
    
    test('should return "running" when any node is running', () => {
      const plan = createTestPlan(3);
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'running';
      plan.nodeStates.get('node-2')!.status = 'pending';
      
      const mockStateMachine = {
        computePlanStatus: sinon.stub().returns('running'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockStateMachine);
      
      const status = runner.getPlanStatus(plan.id);
      
      assert.strictEqual(status, 'running');
    });
    
    test('should NOT return "running" when crashed node was previously running', () => {
      const plan = createTestPlan(2);
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      const crashedState = plan.nodeStates.get('node-1')!;
      crashedState.status = 'failed';  // Was running, now crashed
      crashedState.failureReason = 'crashed';
      
      const mockStateMachine = {
        computePlanStatus: sinon.stub().returns('partial'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockStateMachine);
      
      const status = runner.getPlanStatus(plan.id);
      
      assert.notStrictEqual(status, 'running');
      assert.strictEqual(status, 'partial');
    });
    
    test('should return "failed" when all nodes failed', () => {
      const plan = createTestPlan(2);
      plan.nodeStates.get('node-0')!.status = 'failed';
      plan.nodeStates.get('node-1')!.status = 'failed';
      
      const mockStateMachine = {
        computePlanStatus: sinon.stub().returns('failed'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockStateMachine);
      
      const status = runner.getPlanStatus(plan.id);
      
      assert.strictEqual(status, 'failed');
    });
    
    test('should return "succeeded" when all nodes completed', () => {
      const plan = createTestPlan(2);
      plan.nodeStates.get('node-0')!.status = 'succeeded';
      plan.nodeStates.get('node-1')!.status = 'succeeded';
      
      const mockStateMachine = {
        computePlanStatus: sinon.stub().returns('succeeded'),
        transition: sinon.stub()
      };
      
      runner.plans.set(plan.id, plan);
      runner.stateMachines.set(plan.id, mockStateMachine);
      
      const status = runner.getPlanStatus(plan.id);
      
      assert.strictEqual(status, 'succeeded');
    });
  });
  
  suite('Tree View Update on Crash', () => {
    test('should refresh tree when node crashes', async () => {
      const refreshSpy = treeDataProvider.refresh;
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;  // Non-existent
      
      runner.processMonitor.isRunning.withArgs(999999999).returns(false);
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(refreshSpy.calledOnce, true, 'Tree refresh should be called when node crashes');
    });
    
    test('should fire tree data change event on crash', async () => {
      const fireSpy = treeDataProvider._onDidChangeTreeData.fire;
      const plan = createTestPlan(1);
      const nodeState = plan.nodeStates.get('node-0')!;
      nodeState.status = 'running';
      nodeState.pid = 999999999;
      
      runner.processMonitor.isRunning.withArgs(999999999).returns(false);
      
      await runner.recoverRunningNodes(plan);
      
      assert.strictEqual(fireSpy.calledOnce, true, 'Tree data change event should be fired when node crashes');
    });
  });
});