/**
 * @fileoverview Tests for PlanStateMachine (src/plan/stateMachine.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanStateMachine } from '../../../plan/stateMachine';
import {
  PlanInstance,
  NodeExecutionState,
  JobNode,
  NodeStatus,
  isValidTransition,
  isTerminal,
  GroupInstance,
  GroupExecutionState,
} from '../../../plan/types';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
  sinon.stub(console, 'info');
}

/** Create a minimal plan with N independent nodes. */
function createPlan(nodeCount: number = 1): PlanInstance {
  const nodes = new Map<string, JobNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  const producerIdToNodeId = new Map<string, string>();
  const roots: string[] = [];
  const leaves: string[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const id = `node-${i}`;
    nodes.set(id, {
      id,
      producerId: `job-${i}`,
      name: `Job ${i}`,
      type: 'job',
      task: `task ${i}`,
      dependencies: [],
      dependents: [],
    });
    nodeStates.set(id, { status: 'pending', version: 0, attempts: 0 });
    producerIdToNodeId.set(`job-${i}`, id);
    roots.push(id);
    leaves.push(id);
  }

  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    nodes: nodes as any,
    producerIdToNodeId,
    roots,
    leaves,
    nodeStates,
    groups: new Map<string, GroupInstance>(),
    groupStates: new Map<string, GroupExecutionState>(),
    groupPathToId: new Map<string, string>(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '.wt',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

/** Create a plan with a dependency chain: A -> B -> C */
function createChainPlan(): PlanInstance {
  const plan = createPlan(0);

  const nodeA: JobNode = { id: 'a', producerId: 'a', name: 'A', type: 'job', task: 'a', dependencies: [], dependents: ['b'] };
  const nodeB: JobNode = { id: 'b', producerId: 'b', name: 'B', type: 'job', task: 'b', dependencies: ['a'], dependents: ['c'] };
  const nodeC: JobNode = { id: 'c', producerId: 'c', name: 'C', type: 'job', task: 'c', dependencies: ['b'], dependents: [] };

  plan.nodes.set('a', nodeA);
  plan.nodes.set('b', nodeB);
  plan.nodes.set('c', nodeC);
  plan.nodeStates.set('a', { status: 'pending', version: 0, attempts: 0 });
  plan.nodeStates.set('b', { status: 'pending', version: 0, attempts: 0 });
  plan.nodeStates.set('c', { status: 'pending', version: 0, attempts: 0 });
  plan.roots = ['a'];
  plan.leaves = ['c'];

  return plan;
}

suite('PlanStateMachine', () => {
  setup(() => {
    silenceConsole();
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // isValidTransition / isTerminal (type helpers)
  // =========================================================================

  suite('type helpers', () => {
    test('valid transitions from pending', () => {
      assert.ok(isValidTransition('pending', 'ready'));
      assert.ok(isValidTransition('pending', 'blocked'));
      assert.ok(isValidTransition('pending', 'canceled'));
      assert.ok(!isValidTransition('pending', 'running'));
      assert.ok(!isValidTransition('pending', 'succeeded'));
    });

    test('valid transitions from ready', () => {
      assert.ok(isValidTransition('ready', 'scheduled'));
      assert.ok(isValidTransition('ready', 'blocked'));
      assert.ok(isValidTransition('ready', 'canceled'));
      assert.ok(!isValidTransition('ready', 'pending'));
    });

    test('valid transitions from running', () => {
      assert.ok(isValidTransition('running', 'succeeded'));
      assert.ok(isValidTransition('running', 'failed'));
      assert.ok(isValidTransition('running', 'canceled'));
      assert.ok(!isValidTransition('running', 'pending'));
    });

    test('terminal states have no valid transitions', () => {
      for (const terminal of ['succeeded', 'failed', 'blocked', 'canceled'] as NodeStatus[]) {
        assert.ok(isTerminal(terminal));
        assert.ok(!isValidTransition(terminal, 'pending'));
        assert.ok(!isValidTransition(terminal, 'running'));
      }
    });

    test('non-terminal states are not terminal', () => {
      for (const status of ['pending', 'ready', 'scheduled', 'running'] as NodeStatus[]) {
        assert.ok(!isTerminal(status));
      }
    });
  });

  // =========================================================================
  // transition
  // =========================================================================

  suite('transition', () => {
    test('valid transition succeeds', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      const result = sm.transition('node-0', 'ready');
      assert.strictEqual(result, true);
      assert.strictEqual(sm.getNodeStatus('node-0'), 'ready');
    });

    test('invalid transition is rejected', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      const result = sm.transition('node-0', 'running');
      assert.strictEqual(result, false);
      assert.strictEqual(sm.getNodeStatus('node-0'), 'pending');
    });

    test('transition for unknown node returns false', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.transition('nonexistent', 'ready'), false);
    });

    test('emits transition event', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      let eventReceived = false;
      sm.on('transition', (evt) => {
        eventReceived = true;
        assert.strictEqual(evt.from, 'pending');
        assert.strictEqual(evt.to, 'ready');
        assert.strictEqual(evt.nodeId, 'node-0');
      });
      sm.transition('node-0', 'ready');
      assert.ok(eventReceived);
    });

    test('sets startedAt on running transition', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      const state = sm.getNodeState('node-0');
      assert.ok(state?.startedAt);
    });

    test('sets endedAt on terminal transition', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'succeeded');
      const state = sm.getNodeState('node-0');
      assert.ok(state?.endedAt);
    });

    test('increments version on transition', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getNodeState('node-0')?.version, 0);
      sm.transition('node-0', 'ready');
      assert.strictEqual(sm.getNodeState('node-0')?.version, 1);
    });

    test('increments plan stateVersion on transition', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(plan.stateVersion, 0);
      sm.transition('node-0', 'ready');
      assert.strictEqual(plan.stateVersion, 1);
    });
  });

  // =========================================================================
  // dependency propagation
  // =========================================================================

  suite('dependency propagation', () => {
    test('dependent becomes ready when dependency succeeds', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);

      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // B should now be ready since A succeeded
      assert.strictEqual(sm.getNodeStatus('b'), 'ready');
    });

    test('downstream nodes get blocked when dependency fails', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);

      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      assert.strictEqual(sm.getNodeStatus('b'), 'blocked');
      assert.strictEqual(sm.getNodeStatus('c'), 'blocked');
    });
  });

  // =========================================================================
  // areDependenciesMet / hasDependencyFailed
  // =========================================================================

  suite('areDependenciesMet', () => {
    test('returns true for root node with no dependencies', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      assert.ok(sm.areDependenciesMet('a'));
    });

    test('returns false when dependencies are pending', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      assert.ok(!sm.areDependenciesMet('b'));
    });

    test('returns true when all dependencies succeeded', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.ok(sm.areDependenciesMet('b'));
    });
  });

  suite('hasDependencyFailed', () => {
    test('returns false when no dependencies failed', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      assert.ok(!sm.hasDependencyFailed('b'));
    });

    test('returns true when a dependency is failed', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.ok(sm.hasDependencyFailed('b'));
    });
  });

  // =========================================================================
  // getNodesByStatus / getReadyNodes
  // =========================================================================

  suite('getNodesByStatus', () => {
    test('returns nodes in given status', () => {
      const plan = createPlan(3);
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-1', 'ready');

      const readyNodes = sm.getNodesByStatus('ready');
      assert.strictEqual(readyNodes.length, 2);
      assert.ok(readyNodes.includes('node-0'));
      assert.ok(readyNodes.includes('node-1'));
    });
  });

  suite('getReadyNodes', () => {
    test('returns ready nodes', () => {
      const plan = createPlan(2);
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      const ready = sm.getReadyNodes();
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0], 'node-0');
    });
  });

  // =========================================================================
  // computePlanStatus
  // =========================================================================

  suite('computePlanStatus', () => {
    test('returns pending when all nodes pending', () => {
      const plan = createPlan(2);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.computePlanStatus(), 'pending');
    });

    test('returns running when a node is running', () => {
      const plan = createPlan(2);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      assert.strictEqual(sm.computePlanStatus(), 'running');
    });

    test('returns succeeded when all nodes succeeded', () => {
      const plan = createPlan(2);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      for (const nodeId of ['node-0', 'node-1']) {
        sm.transition(nodeId, 'ready');
        sm.transition(nodeId, 'scheduled');
        sm.transition(nodeId, 'running');
        sm.transition(nodeId, 'succeeded');
      }
      assert.strictEqual(sm.computePlanStatus(), 'succeeded');
    });

    test('returns failed when a node failed', () => {
      const plan = createPlan(1);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'failed');
      assert.strictEqual(sm.computePlanStatus(), 'failed');
    });

    test('returns partial when some succeeded and some failed', () => {
      const plan = createPlan(2);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'succeeded');

      sm.transition('node-1', 'ready');
      sm.transition('node-1', 'scheduled');
      sm.transition('node-1', 'running');
      sm.transition('node-1', 'failed');

      assert.strictEqual(sm.computePlanStatus(), 'partial');
    });
  });

  // =========================================================================
  // getStatusCounts
  // =========================================================================

  suite('getStatusCounts', () => {
    test('counts all statuses', () => {
      const plan = createPlan(3);
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');

      const counts = sm.getStatusCounts();
      assert.strictEqual(counts.ready, 1);
      assert.strictEqual(counts.pending, 2);
    });
  });

  // =========================================================================
  // cancelAll
  // =========================================================================

  suite('cancelAll', () => {
    test('cancels all non-terminal nodes', () => {
      const plan = createPlan(3);
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'succeeded');

      sm.cancelAll();

      assert.strictEqual(sm.getNodeStatus('node-0'), 'succeeded'); // already terminal
      assert.strictEqual(sm.getNodeStatus('node-1'), 'canceled');
      assert.strictEqual(sm.getNodeStatus('node-2'), 'canceled');
    });
  });

  // =========================================================================
  // resetNodeToPending
  // =========================================================================

  suite('resetNodeToPending', () => {
    test('resets failed node to ready when deps are met', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);

      // A succeeds
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // B fails
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      // Reset B
      const result = sm.resetNodeToPending('b');
      assert.ok(result);
      assert.strictEqual(sm.getNodeStatus('b'), 'ready');
    });

    test('returns false for unknown node', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.resetNodeToPending('nonexistent'), false);
    });
  });

  // =========================================================================
  // plan completion
  // =========================================================================

  suite('plan completion', () => {
    test('emits planComplete when all nodes reach terminal state', () => {
      const plan = createPlan(1);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (evt) => { completionEvent = evt; });

      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'succeeded');

      assert.ok(completionEvent);
      assert.strictEqual(completionEvent.status, 'succeeded');
    });
  });

  // =========================================================================
  // getBaseCommitsForNode
  // =========================================================================

  suite('getBaseCommitsForNode', () => {
    test('returns empty array for root node', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      assert.deepStrictEqual(sm.getBaseCommitsForNode('a'), []);
    });

    test('returns commit from succeeded dependency', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      plan.nodeStates.get('a')!.completedCommit = 'abc123';
      plan.nodeStates.get('a')!.status = 'succeeded';

      const commits = sm.getBaseCommitsForNode('b');
      assert.deepStrictEqual(commits, ['abc123']);
    });

    test('returns empty for unknown node', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      assert.deepStrictEqual(sm.getBaseCommitsForNode('unknown'), []);
    });
  });

  // =========================================================================
  // getBaseCommitForNode (deprecated)
  // =========================================================================

  suite('getBaseCommitForNode', () => {
    test('returns first commit from dependency', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      plan.nodeStates.get('a')!.completedCommit = 'abc123';
      plan.nodeStates.get('a')!.status = 'succeeded';
      assert.strictEqual(sm.getBaseCommitForNode('b'), 'abc123');
    });

    test('returns undefined for root node', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getBaseCommitForNode('a'), undefined);
    });
  });

  // =========================================================================
  // getEffectiveEndedAt
  // =========================================================================

  suite('getEffectiveEndedAt', () => {
    test('returns undefined when plan is still running', () => {
      const plan = createPlan(1);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      assert.strictEqual(sm.getEffectiveEndedAt(), undefined);
    });

    test('returns endedAt when all nodes succeeded', () => {
      const plan = createPlan(1);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'succeeded');
      const ended = sm.getEffectiveEndedAt();
      assert.ok(typeof ended === 'number');
    });

    test('falls back to plan.endedAt', () => {
      const plan = createPlan(1);
      plan.startedAt = Date.now();
      plan.endedAt = 12345;
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'canceled');
      // Node has no endedAt set before the cancel - but cancel sets it
      const ended = sm.getEffectiveEndedAt();
      assert.ok(typeof ended === 'number');
    });
  });

  // =========================================================================
  // computeEffectiveEndedAt
  // =========================================================================

  suite('computeEffectiveEndedAt', () => {
    test('returns undefined when no nodes ended', () => {
      const plan = createPlan(1);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.computeEffectiveEndedAt(), undefined);
    });

    test('returns max endedAt across all nodes', () => {
      const plan = createPlan(2);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      sm.transition('node-0', 'ready');
      sm.transition('node-0', 'scheduled');
      sm.transition('node-0', 'running');
      sm.transition('node-0', 'succeeded');
      sm.transition('node-1', 'ready');
      sm.transition('node-1', 'scheduled');
      sm.transition('node-1', 'running');
      sm.transition('node-1', 'succeeded');
      const ended = sm.computeEffectiveEndedAt();
      assert.ok(typeof ended === 'number');
    });
  });

  // =========================================================================
  // group state management
  // =========================================================================

  suite('group state', () => {
    function createGroupPlan(): PlanInstance {
      const plan = createPlan(0);
      const groupId = 'group-1';

      const nodeA: JobNode = { id: 'ga', producerId: 'ga', name: 'GA', type: 'job', task: 'a', dependencies: [], dependents: [], groupId };
      const nodeB: JobNode = { id: 'gb', producerId: 'gb', name: 'GB', type: 'job', task: 'b', dependencies: [], dependents: [], groupId };
      plan.nodes.set('ga', nodeA);
      plan.nodes.set('gb', nodeB);
      plan.nodeStates.set('ga', { status: 'pending', version: 0, attempts: 0 });
      plan.nodeStates.set('gb', { status: 'pending', version: 0, attempts: 0 });
      plan.roots = ['ga', 'gb'];
      plan.leaves = ['ga', 'gb'];

      const group: GroupInstance = {
        id: groupId,
        name: 'Group 1',
        path: 'Group 1',
        childGroupIds: [],
        nodeIds: ['ga', 'gb'],
        allNodeIds: ['ga', 'gb'],
        totalNodes: 2,
      };
      plan.groups.set(groupId, group);
      plan.groupStates.set(groupId, {
        status: 'pending',
        version: 0,
        runningCount: 0,
        succeededCount: 0,
        failedCount: 0,
        blockedCount: 0,
        canceledCount: 0,
      });

      return plan;
    }

    test('group becomes running when a node starts running', () => {
      const plan = createGroupPlan();
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      sm.transition('ga', 'ready');
      sm.transition('ga', 'scheduled');
      sm.transition('ga', 'running');

      const gs = plan.groupStates.get('group-1')!;
      assert.strictEqual(gs.status, 'running');
      assert.strictEqual(gs.runningCount, 1);
    });

    test('group becomes succeeded when all nodes succeed', () => {
      const plan = createGroupPlan();
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      for (const nid of ['ga', 'gb']) {
        sm.transition(nid, 'ready');
        sm.transition(nid, 'scheduled');
        sm.transition(nid, 'running');
        sm.transition(nid, 'succeeded');
      }

      const gs = plan.groupStates.get('group-1')!;
      assert.strictEqual(gs.status, 'succeeded');
      assert.strictEqual(gs.succeededCount, 2);
    });

    test('group becomes failed when a node fails', () => {
      const plan = createGroupPlan();
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      sm.transition('ga', 'ready');
      sm.transition('ga', 'scheduled');
      sm.transition('ga', 'running');
      sm.transition('ga', 'failed');

      sm.transition('gb', 'ready');
      sm.transition('gb', 'scheduled');
      sm.transition('gb', 'running');
      sm.transition('gb', 'succeeded');

      const gs = plan.groupStates.get('group-1')!;
      assert.strictEqual(gs.status, 'failed');
    });

    test('group becomes canceled when all nodes canceled', () => {
      const plan = createGroupPlan();
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      sm.transition('ga', 'canceled');
      sm.transition('gb', 'canceled');

      const gs = plan.groupStates.get('group-1')!;
      assert.strictEqual(gs.status, 'canceled');
    });

    test('group with child groups aggregates status', () => {
      const plan = createGroupPlan();
      plan.startedAt = Date.now();
      const parentGroupId = 'parent-group';
      const childGroupId = 'group-1';

      // Update child group to have parent
      const childGroup = plan.groups.get(childGroupId)!;
      childGroup.parentGroupId = parentGroupId;

      // Create parent group
      const parentGroup: GroupInstance = {
        id: parentGroupId,
        name: 'Parent',
        path: 'Parent',
        childGroupIds: [childGroupId],
        nodeIds: [],
        allNodeIds: ['ga', 'gb'],
        totalNodes: 2,
      };
      plan.groups.set(parentGroupId, parentGroup);
      plan.groupStates.set(parentGroupId, {
        status: 'pending',
        version: 0,
        runningCount: 0,
        succeededCount: 0,
        failedCount: 0,
        blockedCount: 0,
        canceledCount: 0,
      });

      const sm = new PlanStateMachine(plan);
      sm.transition('ga', 'ready');
      sm.transition('ga', 'scheduled');
      sm.transition('ga', 'running');

      // Parent should also be running
      const parentState = plan.groupStates.get(parentGroupId)!;
      assert.strictEqual(parentState.status, 'running');
    });
  });

  // =========================================================================
  // resetNodeToPending with unblocking
  // =========================================================================

  suite('resetNodeToPending unblocking', () => {
    test('unblocks downstream nodes when failed node is retried', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);

      // A succeeds, B fails, C gets blocked
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      assert.strictEqual(sm.getNodeStatus('c'), 'blocked');

      // Reset B - should unblock C
      sm.resetNodeToPending('b');
      assert.strictEqual(sm.getNodeStatus('c'), 'pending');
    });

    test('emits nodeReady when reset to ready', () => {
      const plan = createChainPlan();
      const sm = new PlanStateMachine(plan);

      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      let readyEmitted = false;
      sm.on('nodeReady', (_planId, nodeId) => {
        if (nodeId === 'b') {readyEmitted = true;}
      });

      sm.resetNodeToPending('b');
      assert.ok(readyEmitted);
    });
  });
});
