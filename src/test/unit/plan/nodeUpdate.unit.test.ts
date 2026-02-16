/**
 * @fileoverview Unit tests for PlanRunner.updateNode functionality.
 * Tests verify that updateNode properly handles stage updates,
 * execution state reset, dependency management, and event emission.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import type { PlanInstance, JobNode, NodeExecutionState, WorkSpec } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// Mock minimal PlanRunner structure for testing
interface MockRunner extends EventEmitter {
  plans: Map<string, PlanInstance>;
  stateMachines: Map<string, { 
    getReadyNodes: sinon.SinonStub;
    resetNodeToPending: sinon.SinonStub;
  }>;
  persistence: { save: sinon.SinonStub };
  startPump: sinon.SinonStub;
  updateNode(planId: string, nodeId: string, updates: {
    prechecks?: WorkSpec;
    work?: WorkSpec;
    postchecks?: WorkSpec;
    resetToStage?: 'prechecks' | 'work' | 'postchecks';
  }): Promise<void>;
  resetNodeExecutionState(
    node: JobNode,
    nodeState: NodeExecutionState,
    resetTo: 'prechecks' | 'work' | 'postchecks'
  ): void;
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
    nodes: new Map([['test-node', node]]),
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
  runner.stateMachines = new Map();
  runner.persistence = { save: sinon.stub() };
  runner.startPump = sinon.stub();
  
  // Mock state machine
  const mockStateMachine = {
    getReadyNodes: sinon.stub().returns(['test-node']),
    resetNodeToPending: sinon.stub(),
  };
  runner.stateMachines.set('test-plan', mockStateMachine);
  
  // Add updateNode method with actual implementation logic
  runner.updateNode = async function(planId: string, nodeId: string, updates) {
    const plan = this.plans.get(planId);
    if (!plan) {throw new Error(`Plan ${planId} not found`);}
    
    const node = plan.nodes.get(nodeId);
    if (!node) {throw new Error(`Node ${nodeId} not found`);}
    
    const nodeState = plan.nodeStates.get(nodeId);
    if (!nodeState) {throw new Error(`Node state ${nodeId} not found`);}
    
    // Determine which stage to reset to
    let resetTo: 'prechecks' | 'work' | 'postchecks' | null = updates.resetToStage || null;
    
    // If no explicit reset, find earliest updated stage
    if (!resetTo) {
      if (updates.prechecks) {resetTo = 'prechecks';}
      else if (updates.work) {resetTo = 'work';}
      else if (updates.postchecks) {resetTo = 'postchecks';}
    }
    
    // Apply spec updates to job node
    if (node.type === 'job') {
      const jobNode = node as JobNode;
      
      if (updates.prechecks) {
        jobNode.prechecks = updates.prechecks;
      }
      if (updates.work) {
        jobNode.work = updates.work;
      }
      if (updates.postchecks) {
        jobNode.postchecks = updates.postchecks;
      }
    }
    
    // Reset execution state based on resetTo
    if (resetTo) {
      this.resetNodeExecutionState(node as JobNode, nodeState, resetTo);
      
      // Clear plan.endedAt so it gets recalculated when the plan completes
      if (plan.endedAt) {
        plan.endedAt = undefined;
      }
      
      // Check if ready to run (all dependencies succeeded)
      const sm = this.stateMachines.get(planId);
      if (sm) {
        const readyNodes = sm.getReadyNodes();
        if (!readyNodes.includes(nodeId)) {
          // Transition to ready/pending based on dependency state
          sm.resetNodeToPending(nodeId);
        }
      }
      
      // Ensure pump is running to process the node
      this.startPump();
    }
    
    // Persist and emit
    this.persistence.save(plan);
    this.emit('planUpdate', planId, 'node-updated');
  };
  
  // Add resetNodeExecutionState method
  runner.resetNodeExecutionState = function(
    node: JobNode,
    nodeState: NodeExecutionState,
    resetTo: 'prechecks' | 'work' | 'postchecks'
  ): void {
    const stageOrder = ['prechecks', 'work', 'postchecks'];
    const _resetIndex = stageOrder.indexOf(resetTo);
    
    // Clear success markers for resetTo stage and all subsequent stages
    if (nodeState.stepStatuses) {
      // Map user-facing stages to internal step status phases
      const phaseMapping = {
        'prechecks': ['prechecks', 'work', 'commit', 'postchecks', 'merge-ri'],
        'work': ['work', 'commit', 'postchecks', 'merge-ri'], 
        'postchecks': ['postchecks', 'merge-ri']
      };
      
      const phasesToClear = phaseMapping[resetTo] || [];
      for (const phase of phasesToClear) {
        if (nodeState.stepStatuses[phase as keyof typeof nodeState.stepStatuses]) {
          nodeState.stepStatuses[phase as keyof typeof nodeState.stepStatuses] = undefined;
        }
      }
    }
    
    // Set status back to pending (or running if plan is active)
    nodeState.status = 'pending';
    nodeState.error = undefined;
    nodeState.endedAt = undefined;
    nodeState.startedAt = undefined;
    
    // Clear phase-specific state
    if (resetTo === 'prechecks' || resetTo === 'work') {
      nodeState.completedCommit = undefined;
      nodeState.workSummary = undefined;
    }
    if (resetTo === 'prechecks') {
      // Clear all phase outputs when resetting to prechecks
      nodeState.aggregatedWorkSummary = undefined;
    }
    
    // Set resume point 
    nodeState.resumeFromPhase = resetTo as any;
    
    // Increment attempts
    nodeState.attempts = (nodeState.attempts || 0) + 1;
  };
  
  return runner;
}

suite('Node Update with Stage Reset', () => {
  let runner: MockRunner;
  let plan: PlanInstance;
  let node: JobNode;
  let nodeState: NodeExecutionState;
  let consoleSilencer: { restore: () => void };

  setup(() => {
    consoleSilencer = silenceConsole();
    runner = createMockRunner();
    plan = createTestPlan();
    node = plan.nodes.get('test-node') as JobNode;
    nodeState = plan.nodeStates.get('test-node') as NodeExecutionState;
    runner.plans.set('test-plan', plan);
  });

  teardown(() => {
    consoleSilencer.restore();
    sinon.restore();
  });

  suite('updateNode', () => {
    test('should reset to work stage when work is updated', async () => {
      // Node passed work but failed postchecks
      nodeState.status = 'failed';
      nodeState.stepStatuses = {
        prechecks: 'success',
        work: 'success',
        postchecks: 'failed'
      };
      
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New instructions' }
      });
      
      // Work and postchecks should be reset, prechecks preserved
      assert.strictEqual(nodeState.stepStatuses!.prechecks, 'success');
      assert.strictEqual(nodeState.stepStatuses!.work, undefined);
      assert.strictEqual(nodeState.stepStatuses!.postchecks, undefined);
      assert.strictEqual(nodeState.status, 'pending');
    });
    
    test('should reset to prechecks when prechecks are updated', async () => {
      nodeState.stepStatuses = {
        prechecks: 'success',
        work: 'success'
      };
      
      await runner.updateNode(plan.id, node.id, {
        prechecks: { type: 'shell', command: 'new precheck' }
      });
      
      // All phases should be reset
      assert.strictEqual(nodeState.stepStatuses!.prechecks, undefined);
      assert.strictEqual(nodeState.stepStatuses!.work, undefined);
    });
    
    test('should only reset postchecks when only postchecks updated', async () => {
      nodeState.stepStatuses = {
        work: 'success',
        postchecks: 'failed'
      };
      
      await runner.updateNode(plan.id, node.id, {
        postchecks: { type: 'shell', command: 'new postcheck' }
      });
      
      // Work should be preserved, postchecks reset
      assert.strictEqual(nodeState.stepStatuses!.work, 'success');
      assert.strictEqual(nodeState.stepStatuses!.postchecks, undefined);
    });
    
    test('should support updating multiple stages at once', async () => {
      // Initialize stepStatuses
      nodeState.stepStatuses = {};
      
      await runner.updateNode(plan.id, node.id, {
        prechecks: { type: 'shell', command: 'new precheck' },
        work: { type: 'agent', instructions: 'New' },
        postchecks: { type: 'shell', command: 'new postcheck' }
      });
      
      // All should be reset
      assert.strictEqual(nodeState.stepStatuses!.prechecks, undefined);
      assert.strictEqual(nodeState.stepStatuses!.work, undefined);
      assert.strictEqual(nodeState.stepStatuses!.postchecks, undefined);
      assert.deepStrictEqual(node.prechecks, { type: 'shell', command: 'new precheck' });
      assert.strictEqual((node.work as any).instructions, 'New');
      assert.deepStrictEqual(node.postchecks, { type: 'shell', command: 'new postcheck' });
    });
    
    test('should allow explicit resetToStage override', async () => {
      nodeState.stepStatuses = {
        prechecks: 'success',
        work: 'success',
        postchecks: 'success'
      };
      
      // Update only postchecks but reset from work
      await runner.updateNode(plan.id, node.id, {
        postchecks: { type: 'shell', command: 'new postcheck' },
        resetToStage: 'work'
      });
      
      assert.strictEqual(nodeState.stepStatuses!.prechecks, 'success');
      assert.strictEqual(nodeState.stepStatuses!.work, undefined);
      assert.strictEqual(nodeState.stepStatuses!.postchecks, undefined);
    });
    
    test('should increment attempts count on update', async () => {
      nodeState.attempts = 2;
      
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'Retry' }
      });
      
      assert.strictEqual(nodeState.attempts, 3);
    });
    
    test('should emit node-updated event', async () => {
      const listener = sinon.stub();
      runner.on('planUpdate', listener);
      
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New' }
      });
      
      sinon.assert.calledWith(listener, plan.id, 'node-updated');
    });
    
    test('should clear plan endedAt when updating node', async () => {
      plan.endedAt = Date.now();
      
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New' }
      });
      
      assert.strictEqual(plan.endedAt, undefined);
    });
    
    test('should set resumeFromPhase correctly', async () => {
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New' }
      });
      
      assert.strictEqual(nodeState.resumeFromPhase, 'work');
    });
    
    test('should reset node status and clear error', async () => {
      nodeState.status = 'failed';
      nodeState.error = 'Previous error';
      nodeState.endedAt = Date.now();
      nodeState.startedAt = Date.now() - 1000;
      
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New' }
      });
      
      assert.strictEqual(nodeState.status, 'pending');
      assert.strictEqual(nodeState.error, undefined);
      assert.strictEqual(nodeState.endedAt, undefined);
      assert.strictEqual(nodeState.startedAt, undefined);
    });
    
    test('should call persistence save', async () => {
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New' }
      });
      
      sinon.assert.calledWith(runner.persistence.save, plan);
    });
    
    test('should start pump after update', async () => {
      await runner.updateNode(plan.id, node.id, {
        work: { type: 'agent', instructions: 'New' }
      });
      
      sinon.assert.called(runner.startPump);
    });
    
    test('should throw error if plan not found', async () => {
      await assert.rejects(
        () => runner.updateNode('invalid-plan', node.id, { work: { type: 'agent', instructions: 'New' } }),
        /Plan invalid-plan not found/
      );
    });
    
    test('should throw error if node not found', async () => {
      await assert.rejects(
        () => runner.updateNode(plan.id, 'invalid-node', { work: { type: 'agent', instructions: 'New' } }),
        /Node invalid-node not found/
      );
    });
    
    test('should throw error if node state not found', async () => {
      plan.nodeStates.delete('test-node');
      
      await assert.rejects(
        () => runner.updateNode(plan.id, node.id, { work: { type: 'agent', instructions: 'New' } }),
        /Node state test-node not found/
      );
    });
  });
});