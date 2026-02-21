/**
 * @fileoverview State Machine Coverage Tests
 * 
 * Focused tests on group state management gaps:
 * - resetNodeToPending() with group state updates
 * - unblockDownstream() with group state propagation
 * - recomputeGroupState() pending branch (pending > 0 && failed === 0 && blocked === 0)
 * - Group status cascade through retry scenarios
 * - checkPlanCompletion() terminal state combinations
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import { PlanStateMachine } from '../../../plan/stateMachine';
import type {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  GroupInstance,
  GroupExecutionState,
} from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeJobNode(
  id: string,
  deps: string[] = [],
  dependents: string[] = [],
  groupId?: string
): JobNode {
  return {
    id,
    producerId: id,
    name: id,
    type: 'job',
    task: `Task ${id}`,
    dependencies: deps,
    dependents,
    groupId,
  };
}

function makeNodeState(status: string = 'pending'): NodeExecutionState {
  return {
    status: status as any,
    version: 0,
    attempts: 0,
  };
}

function makeGroupState(): GroupExecutionState {
  return {
    status: 'pending',
    version: 0,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    blockedCount: 0,
    canceledCount: 0,
  };
}

/**
 * Build a plan with phase-based groups.
 * Creates groups phase5 and phase6, where phase6 depends on phase5.
 * 
 * Topology:
 * - phase5: jobs a, b
 * - phase6: job c (depends on a from phase5)
 */
function buildPhaseGroupPlan(): PlanInstance {
  const nodes = new Map<string, PlanNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  const groups = new Map<string, GroupInstance>();
  const groupStates = new Map<string, GroupExecutionState>();
  const groupPathToId = new Map<string, string>();
  const producerIdToNodeId = new Map<string, string>();

  // Create groups
  const phase5: GroupInstance = {
    id: 'phase5',
    name: 'Phase 5',
    path: 'phase5',
    parentGroupId: undefined,
    childGroupIds: [],
    nodeIds: ['a', 'b'],
    allNodeIds: ['a', 'b'],
    totalNodes: 2,
  };
  
  const phase6: GroupInstance = {
    id: 'phase6',
    name: 'Phase 6',
    path: 'phase6',
    parentGroupId: undefined,
    childGroupIds: [],
    nodeIds: ['c'],
    allNodeIds: ['c'],
    totalNodes: 1,
  };

  groups.set('phase5', phase5);
  groups.set('phase6', phase6);
  groupPathToId.set('phase5', 'phase5');
  groupPathToId.set('phase6', 'phase6');

  groupStates.set('phase5', makeGroupState());
  groupStates.set('phase6', makeGroupState());

  // Create nodes: a and b in phase5, c in phase6 depends on a
  nodes.set('a', makeJobNode('a', [], ['c'], 'phase5'));
  nodes.set('b', makeJobNode('b', [], [], 'phase5'));
  nodes.set('c', makeJobNode('c', ['a'], [], 'phase6'));

  nodeStates.set('a', makeNodeState('ready'));
  nodeStates.set('b', makeNodeState('ready'));
  nodeStates.set('c', makeNodeState('pending'));

  producerIdToNodeId.set('a', 'a');
  producerIdToNodeId.set('b', 'b');
  producerIdToNodeId.set('c', 'c');

  return {
    id: 'plan-1',
    spec: { name: 'Phase Group Test', jobs: [] },
    jobs: nodes,
    producerIdToNodeId,
    roots: ['a', 'b'],
    leaves: ['b', 'c'],
    nodeStates,
    groups,
    groupStates,
    groupPathToId,
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/wt',
    createdAt: 1000,
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

/**
 * Build a plan with parent-child group hierarchy.
 * 
 * Structure:
 * - parent-group contains: job a, child-group
 * - child-group contains: job b (depends on a)
 */
function buildNestedGroupPlan(): PlanInstance {
  const nodes = new Map<string, PlanNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  const groups = new Map<string, GroupInstance>();
  const groupStates = new Map<string, GroupExecutionState>();
  const groupPathToId = new Map<string, string>();
  const producerIdToNodeId = new Map<string, string>();

  const parentGroup: GroupInstance = {
    id: 'parent-group',
    name: 'Parent',
    path: 'parent',
    parentGroupId: undefined,
    childGroupIds: ['child-group'],
    nodeIds: ['a'],
    allNodeIds: ['a', 'b'],
    totalNodes: 2,
  };

  const childGroup: GroupInstance = {
    id: 'child-group',
    name: 'Child',
    path: 'parent/child',
    parentGroupId: 'parent-group',
    childGroupIds: [],
    nodeIds: ['b'],
    allNodeIds: ['b'],
    totalNodes: 1,
  };

  groups.set('parent-group', parentGroup);
  groups.set('child-group', childGroup);
  groupPathToId.set('parent', 'parent-group');
  groupPathToId.set('parent/child', 'child-group');

  groupStates.set('parent-group', makeGroupState());
  groupStates.set('child-group', makeGroupState());

  nodes.set('a', makeJobNode('a', [], ['b'], 'parent-group'));
  nodes.set('b', makeJobNode('b', ['a'], [], 'child-group'));

  nodeStates.set('a', makeNodeState('ready'));
  nodeStates.set('b', makeNodeState('pending'));

  producerIdToNodeId.set('a', 'a');
  producerIdToNodeId.set('b', 'b');

  return {
    id: 'plan-1',
    spec: { name: 'Nested Group Test', jobs: [] },
    jobs: nodes,
    producerIdToNodeId,
    roots: ['a'],
    leaves: ['b'],
    nodeStates,
    groups,
    groupStates,
    groupPathToId,
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/wt',
    createdAt: 1000,
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('State Machine - Group Coverage', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // resetNodeToPending() with group state updates
  // =========================================================================
  suite('resetNodeToPending', () => {
    test('updates group state after resetting failed node', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Run job 'a' to failure
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      const groupBefore = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupBefore.status, 'failed');
      assert.strictEqual(groupBefore.failedCount, 1);

      // Reset the node
      const result = sm.resetNodeToPending('a');
      assert.ok(result);

      // Verify node state
      const nodeState = plan.nodeStates.get('a')!;
      assert.strictEqual(nodeState.status, 'ready'); // deps are met

      // Verify group state updated
      const groupAfter = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupAfter.failedCount, 0);
      // Group should be back to running or pending (has pending/ready nodes)
      assert.ok(['pending', 'running'].includes(groupAfter.status));
    });

    test('resets to pending when dependencies not met', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Block 'c' by failing 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      const cState = plan.nodeStates.get('c')!;
      assert.strictEqual(cState.status, 'blocked');

      // Try to reset 'c' (but 'a' is still failed)
      const result = sm.resetNodeToPending('c');
      assert.ok(result);

      // Should go to pending (not ready) since dependency 'a' is still failed
      const cStateAfter = plan.nodeStates.get('c')!;
      assert.strictEqual(cStateAfter.status, 'pending');
    });

    test('emits nodeReady event when reset node is ready', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Fail 'b' (no dependencies)
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      let readyEmitted = false;
      sm.on('nodeReady', (planId, nodeId) => {
        if (nodeId === 'b') {
          readyEmitted = true;
        }
      });

      sm.resetNodeToPending('b');
      assert.ok(readyEmitted, 'nodeReady should be emitted for ready node');
    });

    test('resets to ready when dependencies are met', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Run 'a' to success
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // c becomes ready and then fails
      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'failed');

      // Reset 'c' (dependencies are met)
      const result = sm.resetNodeToPending('c');
      assert.ok(result);

      const cState = plan.nodeStates.get('c')!;
      assert.strictEqual(cState.status, 'ready');
    });
  });

  // =========================================================================
  // unblockDownstream() with group state propagation
  // =========================================================================
  suite('unblockDownstream', () => {
    test('updates group state for each unblocked dependent', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Fail 'a' which blocks 'c'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      const cState = plan.nodeStates.get('c')!;
      assert.strictEqual(cState.status, 'blocked');

      const phase6Before = plan.groupStates.get('phase6')!;
      assert.strictEqual(phase6Before.blockedCount, 1);

      // Reset 'a' which should unblock 'c'
      sm.resetNodeToPending('a');

      const cStateAfter = plan.nodeStates.get('c')!;
      assert.strictEqual(cStateAfter.status, 'pending');

      // Verify phase6 group state updated
      const phase6After = plan.groupStates.get('phase6')!;
      assert.strictEqual(phase6After.blockedCount, 0);
      assert.strictEqual(phase6After.status, 'pending');
    });

    test('recursively unblocks further downstream nodes', () => {
      // Build a longer chain: a → b → c
      const nodes = new Map<string, PlanNode>();
      const nodeStates = new Map<string, NodeExecutionState>();
      const groups = new Map<string, GroupInstance>();
      const groupStates = new Map<string, GroupExecutionState>();
      const groupPathToId = new Map<string, string>();
      const producerIdToNodeId = new Map<string, string>();

      const g1: GroupInstance = {
        id: 'g1',
        name: 'G1',
        path: 'g1',
        parentGroupId: undefined,
        childGroupIds: [],
        nodeIds: ['a', 'b', 'c'],
        allNodeIds: ['a', 'b', 'c'],
        totalNodes: 3,
      };
      groups.set('g1', g1);
      groupStates.set('g1', makeGroupState());
      groupPathToId.set('g1', 'g1');

      nodes.set('a', makeJobNode('a', [], ['b'], 'g1'));
      nodes.set('b', makeJobNode('b', ['a'], ['c'], 'g1'));
      nodes.set('c', makeJobNode('c', ['b'], [], 'g1'));

      nodeStates.set('a', makeNodeState('ready'));
      nodeStates.set('b', makeNodeState('pending'));
      nodeStates.set('c', makeNodeState('pending'));

      producerIdToNodeId.set('a', 'a');
      producerIdToNodeId.set('b', 'b');
      producerIdToNodeId.set('c', 'c');

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Chain Test', jobs: [] },
        jobs: nodes,
        producerIdToNodeId,
        roots: ['a'],
        leaves: ['c'],
        nodeStates,
        groups,
        groupStates,
        groupPathToId,
        repoPath: '/repo',
        baseBranch: 'main',
        worktreeRoot: '/wt',
        createdAt: 1000,
        stateVersion: 0,
        cleanUpSuccessfulWork: true,
        maxParallel: 4,
      };

      const sm = new PlanStateMachine(plan);

      // Fail 'a' which blocks 'b' and 'c'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      assert.strictEqual(nodeStates.get('b')!.status, 'blocked');
      assert.strictEqual(nodeStates.get('c')!.status, 'blocked');

      // Reset 'a' should unblock both 'b' and 'c'
      sm.resetNodeToPending('a');

      assert.strictEqual(nodeStates.get('b')!.status, 'pending');
      assert.strictEqual(nodeStates.get('c')!.status, 'pending');

      // Group should reflect the unblocking
      const g1State = groupStates.get('g1')!;
      assert.strictEqual(g1State.blockedCount, 0);
    });

    test('does not unblock if other dependencies are still failed', () => {
      // Build a plan where 'c' depends on both 'a' and 'b'
      const nodes = new Map<string, PlanNode>();
      const nodeStates = new Map<string, NodeExecutionState>();
      const groups = new Map<string, GroupInstance>();
      const groupStates = new Map<string, GroupExecutionState>();
      const groupPathToId = new Map<string, string>();
      const producerIdToNodeId = new Map<string, string>();

      const g1: GroupInstance = {
        id: 'g1',
        name: 'G1',
        path: 'g1',
        parentGroupId: undefined,
        childGroupIds: [],
        nodeIds: ['a', 'b', 'c'],
        allNodeIds: ['a', 'b', 'c'],
        totalNodes: 3,
      };
      groups.set('g1', g1);
      groupStates.set('g1', makeGroupState());
      groupPathToId.set('g1', 'g1');

      nodes.set('a', makeJobNode('a', [], ['c'], 'g1'));
      nodes.set('b', makeJobNode('b', [], ['c'], 'g1'));
      nodes.set('c', makeJobNode('c', ['a', 'b'], [], 'g1'));

      nodeStates.set('a', makeNodeState('ready'));
      nodeStates.set('b', makeNodeState('ready'));
      nodeStates.set('c', makeNodeState('pending'));

      producerIdToNodeId.set('a', 'a');
      producerIdToNodeId.set('b', 'b');
      producerIdToNodeId.set('c', 'c');

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Multi-Dep Test', jobs: [] },
        jobs: nodes,
        producerIdToNodeId,
        roots: ['a', 'b'],
        leaves: ['c'],
        nodeStates,
        groups,
        groupStates,
        groupPathToId,
        repoPath: '/repo',
        baseBranch: 'main',
        worktreeRoot: '/wt',
        createdAt: 1000,
        stateVersion: 0,
        cleanUpSuccessfulWork: true,
        maxParallel: 4,
      };

      const sm = new PlanStateMachine(plan);

      // Fail both 'a' and 'b'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      assert.strictEqual(nodeStates.get('c')!.status, 'blocked');

      // Reset only 'a' - 'c' should remain blocked (b is still failed)
      sm.resetNodeToPending('a');

      const cState = nodeStates.get('c')!;
      assert.strictEqual(cState.status, 'blocked');
    });
  });

  // =========================================================================
  // recomputeGroupState() - pending branch
  // =========================================================================
  suite('recomputeGroupState - pending branch', () => {
    test('group reverts to pending when pending > 0 && failed === 0 && blocked === 0 with no startedAt', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Fail job 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      const groupBefore = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupBefore.status, 'failed');

      // Reset 'a' to pending
      sm.resetNodeToPending('a');

      // Now we have pending nodes with no failures
      const groupAfter = plan.groupStates.get('phase5')!;
      // Should be pending or running (no startedAt means pending)
      assert.ok(['pending', 'running'].includes(groupAfter.status));
      assert.strictEqual(groupAfter.failedCount, 0);
    });

    test('group reverts to running when pending > 0 && failed === 0 && blocked === 0 with startedAt', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Run 'b' to success
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      // Run 'a' to failure (group has startedAt now)
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      const groupBefore = plan.groupStates.get('phase5')!;
      assert.ok(groupBefore.startedAt);
      assert.strictEqual(groupBefore.status, 'failed');

      // Reset 'a'
      sm.resetNodeToPending('a');

      const groupAfter = plan.groupStates.get('phase5')!;
      // Should be running (has startedAt, pending nodes, no failures)
      assert.strictEqual(groupAfter.status, 'running');
      assert.ok(groupAfter.startedAt);
    });

    test('group clears endedAt when reverting to pending/running', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Complete both jobs
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      const groupBefore = plan.groupStates.get('phase5')!;
      assert.ok(groupBefore.endedAt);

      // Reset 'a' - group should clear endedAt
      sm.resetNodeToPending('a');

      const groupAfter = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupAfter.endedAt, undefined);
    });

    test('group clears startedAt when reverting to pending (no minStartedAt)', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Fail 'a' without setting startedAt
      plan.nodeStates.get('a')!.status = 'failed' as any;
      plan.groupStates.get('phase5')!.status = 'failed';
      plan.groupStates.get('phase5')!.failedCount = 1;

      // Reset 'a'
      sm.resetNodeToPending('a');

      const groupAfter = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupAfter.status, 'pending');
      assert.strictEqual(groupAfter.startedAt, undefined);
    });
  });

  // =========================================================================
  // Group status cascade through retry
  // =========================================================================
  suite('Group cascade on retry', () => {
    test('retry node in phase5 → phase5 resets → phase6 unblocks → phase6 resets', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Run phase5: 'a' fails, 'b' succeeds
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      // Phase5 should be failed
      const phase5Before = plan.groupStates.get('phase5')!;
      assert.strictEqual(phase5Before.status, 'failed');

      // Phase6's 'c' should be blocked
      const cBefore = plan.nodeStates.get('c')!;
      assert.strictEqual(cBefore.status, 'blocked');

      const phase6Before = plan.groupStates.get('phase6')!;
      assert.strictEqual(phase6Before.status, 'failed'); // blocked child

      // Retry 'a' in phase5
      sm.resetNodeToPending('a');

      // Phase5 should reset (has pending/ready nodes, no failures)
      const phase5After = plan.groupStates.get('phase5')!;
      assert.ok(['pending', 'running'].includes(phase5After.status));
      assert.strictEqual(phase5After.failedCount, 0);

      // Phase6's 'c' should be unblocked
      const cAfter = plan.nodeStates.get('c')!;
      assert.strictEqual(cAfter.status, 'pending');

      // Phase6 should reset
      const phase6After = plan.groupStates.get('phase6')!;
      assert.strictEqual(phase6After.status, 'pending');
      assert.strictEqual(phase6After.blockedCount, 0);
    });

    test('nested group child failure propagates to parent, retry resets both', () => {
      const plan = buildNestedGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Run 'a' to success
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // Run 'b' to failure (in child group)
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      // Child group should be failed
      const childBefore = plan.groupStates.get('child-group')!;
      assert.strictEqual(childBefore.status, 'failed');

      // Parent group should be failed (aggregates child)
      const parentBefore = plan.groupStates.get('parent-group')!;
      assert.strictEqual(parentBefore.status, 'failed');

      // Retry 'b'
      sm.resetNodeToPending('b');

      // Child group should reset
      const childAfter = plan.groupStates.get('child-group')!;
      assert.ok(['pending', 'running'].includes(childAfter.status));

      // Parent group should reset
      const parentAfter = plan.groupStates.get('parent-group')!;
      assert.ok(['pending', 'running', 'succeeded'].includes(parentAfter.status));
    });

    test('multiple node retries correctly update group counts', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      // Fail both 'a' and 'b'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      const groupBefore = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupBefore.failedCount, 2);

      // Retry 'a'
      sm.resetNodeToPending('a');

      const groupAfterFirst = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupAfterFirst.failedCount, 1);
      assert.strictEqual(groupAfterFirst.status, 'failed'); // 'b' still failed

      // Retry 'b'
      sm.resetNodeToPending('b');

      const groupAfterSecond = plan.groupStates.get('phase5')!;
      assert.strictEqual(groupAfterSecond.failedCount, 0);
      assert.ok(['pending', 'running'].includes(groupAfterSecond.status));
    });
  });

  // =========================================================================
  // checkPlanCompletion() - terminal states
  // =========================================================================
  suite('checkPlanCompletion', () => {
    test('emits planComplete when all nodes succeed', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (event) => {
        completionEvent = event;
      });

      // Run all to success
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'succeeded');

      assert.ok(completionEvent);
      assert.strictEqual(completionEvent.planId, 'plan-1');
      assert.strictEqual(completionEvent.status, 'succeeded');
    });

    test('emits planComplete when at least one node fails', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (event) => {
        completionEvent = event;
      });

      // Fail 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      // Complete 'b'
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      // 'c' is blocked, which is terminal
      assert.ok(completionEvent);
      assert.ok(['failed', 'partial'].includes(completionEvent.status));
    });

    test('emits planComplete when all nodes canceled', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (event) => {
        completionEvent = event;
      });

      // Cancel all
      sm.transition('a', 'canceled');
      sm.transition('b', 'canceled');
      // 'c' stays pending (not canceled, but no running nodes)

      // Eventually 'c' may be canceled or remain pending
      // But with 2 canceled, if 'c' is still pending, plan is not terminal yet
      // Let's cancel 'c' too
      sm.transition('c', 'canceled');

      assert.ok(completionEvent);
      assert.strictEqual(completionEvent.status, 'canceled');
    });

    test('sets plan.endedAt when complete', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      assert.strictEqual(plan.endedAt, undefined);

      // Run to completion
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'succeeded');

      assert.ok(plan.endedAt);
      assert.strictEqual(typeof plan.endedAt, 'number');
    });

    test('mixed terminal states result in failed or partial status', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (event) => {
        completionEvent = event;
      });

      // 'a' succeeds
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // 'b' fails
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');

      // 'c' succeeds
      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'succeeded');

      assert.ok(completionEvent);
      // Mixed success and failure typically results in 'partial'
      assert.ok(['failed', 'partial'].includes(completionEvent.status));
    });

    test('blocked nodes are terminal and trigger completion check', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (event) => {
        completionEvent = event;
      });

      // Fail 'a' which blocks 'c'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      // Complete 'b'
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      // 'c' is blocked - plan should be complete
      assert.ok(completionEvent);
    });

    test('plan not complete if any node is still pending/ready/running', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      let completionEvent: any = null;
      sm.on('planComplete', (event) => {
        completionEvent = event;
      });

      // Only complete 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // 'b' and 'c' remain pending/ready
      assert.strictEqual(completionEvent, null);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  suite('Edge cases', () => {
    test('resetNodeToPending on unknown node returns false', () => {
      const plan = buildPhaseGroupPlan();
      const sm = new PlanStateMachine(plan);

      const result = sm.resetNodeToPending('unknown-node');
      assert.strictEqual(result, false);
    });

    test('group with no nodes handles state recomputation gracefully', () => {
      const plan = buildPhaseGroupPlan();
      // Create an empty group
      const emptyGroup: GroupInstance = {
        id: 'empty',
        name: 'Empty',
        path: 'empty',
        parentGroupId: undefined,
        childGroupIds: [],
        nodeIds: [],
        allNodeIds: [],
        totalNodes: 0,
      };
      plan.groups.set('empty', emptyGroup);
      plan.groupStates.set('empty', makeGroupState());

      const sm = new PlanStateMachine(plan);

      // Transition a node - should not crash
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');

      // Empty group should remain pending
      const emptyState = plan.groupStates.get('empty')!;
      assert.strictEqual(emptyState.status, 'pending');
    });

    test('group status priority: running > failed/blocked > succeeded > canceled', () => {
      const nodes = new Map<string, PlanNode>();
      const nodeStates = new Map<string, NodeExecutionState>();
      const groups = new Map<string, GroupInstance>();
      const groupStates = new Map<string, GroupExecutionState>();
      const groupPathToId = new Map<string, string>();
      const producerIdToNodeId = new Map<string, string>();

      const g1: GroupInstance = {
        id: 'g1',
        name: 'G1',
        path: 'g1',
        parentGroupId: undefined,
        childGroupIds: [],
        nodeIds: ['a', 'b', 'c'],
        allNodeIds: ['a', 'b', 'c'],
        totalNodes: 3,
      };
      groups.set('g1', g1);
      groupStates.set('g1', makeGroupState());
      groupPathToId.set('g1', 'g1');

      nodes.set('a', makeJobNode('a', [], [], 'g1'));
      nodes.set('b', makeJobNode('b', [], [], 'g1'));
      nodes.set('c', makeJobNode('c', [], [], 'g1'));

      nodeStates.set('a', makeNodeState('ready'));
      nodeStates.set('b', makeNodeState('ready'));
      nodeStates.set('c', makeNodeState('ready'));

      producerIdToNodeId.set('a', 'a');
      producerIdToNodeId.set('b', 'b');
      producerIdToNodeId.set('c', 'c');

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Priority Test', jobs: [] },
        jobs: nodes,
        producerIdToNodeId,
        roots: ['a', 'b', 'c'],
        leaves: ['a', 'b', 'c'],
        nodeStates,
        groups,
        groupStates,
        groupPathToId,
        repoPath: '/repo',
        baseBranch: 'main',
        worktreeRoot: '/wt',
        createdAt: 1000,
        stateVersion: 0,
        cleanUpSuccessfulWork: true,
        maxParallel: 4,
      };

      const sm = new PlanStateMachine(plan);

      // 'a' running, 'b' succeeded, 'c' failed
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'failed');

      // Group should be running (running has priority)
      const gs = plan.groupStates.get('g1')!;
      assert.strictEqual(gs.status, 'running');
    });
  });
});
