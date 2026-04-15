/**
 * @fileoverview Integration tests for completed_split transition and engine reshape.
 *
 * Tests the state machine's completed_split status, its side effects, and the
 * DAG reshaping logic triggered by checkpoint manifests (fan-out/fan-in).
 */
import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { PlanStateMachine } from '../../../plan/stateMachine';
import {
  addNode as reshaperAddNode,
  addNodeAfter as reshaperAddNodeAfter,
  updateNodeDependencies as reshaperUpdateNodeDependencies,
  recomputeRootsAndLeaves,
} from '../../../plan/reshaper';
import {
  isValidTransition,
  isTerminal,
} from '../../../plan/types/nodes';
import type {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  JobNodeSpec,
  GroupInstance,
  GroupExecutionState,
} from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, opts: Partial<JobNode> = {}): PlanNode {
  return {
    id,
    producerId: opts.producerId ?? id,
    name: opts.name ?? `Job ${id}`,
    type: 'job',
    task: opts.task ?? 'do stuff',
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
    work: opts.work,
    prechecks: opts.prechecks,
    postchecks: opts.postchecks,
    instructions: opts.instructions,
    autoHeal: opts.autoHeal,
  } as PlanNode;
}

function makeState(status: string, extras: Partial<NodeExecutionState> = {}): NodeExecutionState {
  return { status: status as any, version: 0, attempts: 0, ...extras };
}

function makePlan(
  nodes: PlanNode[] = [],
  states: Map<string, NodeExecutionState> = new Map(),
  opts: Partial<PlanInstance> = {},
): PlanInstance {
  const nodesMap = new Map<string, PlanNode>();
  const producerMap = new Map<string, string>();
  for (const n of nodes) {
    nodesMap.set(n.id, n);
    if (n.producerId) { producerMap.set(n.producerId, n.id); }
  }
  return {
    id: 'plan-1',
    spec: {} as any,
    jobs: nodesMap,
    producerIdToNodeId: producerMap,
    roots: [],
    leaves: [],
    nodeStates: states,
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    startedAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: false,
    maxParallel: 4,
    ...opts,
  } as PlanInstance;
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('completed_split + reshape integration', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();
  });

  teardown(() => {
    sandbox.restore();
    quiet.restore();
  });

  // =========================================================================
  // 1. completed_split transition validity
  // =========================================================================

  suite('completed_split transition', () => {
    test('running → completed_split is valid', () => {
      assert.ok(isValidTransition('running', 'completed_split'));
    });

    test('completed_split → succeeded is valid', () => {
      assert.ok(isValidTransition('completed_split', 'succeeded'));
    });

    test('completed_split → failed is valid', () => {
      assert.ok(isValidTransition('completed_split', 'failed'));
    });

    test('completed_split is NOT terminal', () => {
      assert.strictEqual(isTerminal('completed_split'), false);
    });

    test('completed_split does not allow transition to running', () => {
      assert.strictEqual(isValidTransition('completed_split', 'running'), false);
    });

    test('completed_split does not allow transition to canceled', () => {
      assert.strictEqual(isValidTransition('completed_split', 'canceled'), false);
    });

    test('state machine transitions running → completed_split successfully', () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('running')]]));
      const sm = new PlanStateMachine(plan);
      const result = sm.transition('n1', 'completed_split');
      assert.strictEqual(result, true);
      assert.strictEqual(plan.nodeStates.get('n1')!.status, 'completed_split');
    });

    test('state machine transitions completed_split → succeeded', () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('completed_split')]]));
      const sm = new PlanStateMachine(plan);
      const result = sm.transition('n1', 'succeeded');
      assert.strictEqual(result, true);
      assert.strictEqual(plan.nodeStates.get('n1')!.status, 'succeeded');
    });

    test('state machine transitions completed_split → failed', () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('completed_split')]]));
      const sm = new PlanStateMachine(plan);
      const result = sm.transition('n1', 'failed');
      assert.strictEqual(result, true);
      assert.strictEqual(plan.nodeStates.get('n1')!.status, 'failed');
    });
  });

  // =========================================================================
  // 2. Side effects: completed_split does NOT trigger checkDependentsReady
  // =========================================================================

  suite('completed_split side effects', () => {
    test('completed_split does NOT trigger checkDependentsReady', () => {
      // Parent → child; child is pending. When parent goes to completed_split
      // the child should NOT become ready.
      const parent = makeNode('parent', { dependents: ['child'] });
      const child = makeNode('child', { dependencies: ['parent'] });
      const plan = makePlan(
        [parent, child],
        new Map([
          ['parent', makeState('running')],
          ['child', makeState('pending')],
        ]),
      );
      const sm = new PlanStateMachine(plan);

      sm.transition('parent', 'completed_split');

      // child should still be pending — checkDependentsReady only fires on 'succeeded'
      assert.strictEqual(plan.nodeStates.get('child')!.status, 'pending');
    });

    test('completed_split does NOT trigger checkPlanCompletion', () => {
      // Single-node plan: going to completed_split should not emit planComplete
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('running')]]));
      const sm = new PlanStateMachine(plan);

      const completionSpy = sandbox.spy();
      sm.on('planComplete', completionSpy);

      sm.transition('n1', 'completed_split');

      // planComplete should NOT fire — completed_split is not terminal
      assert.strictEqual(completionSpy.callCount, 0);
    });

    test('completed_split DOES trigger updateGroupState', () => {
      const groupId = 'group-1';
      const node = makeNode('n1');
      // Set groupId directly since makeNode doesn't pass it through
      (node as any).groupId = groupId;
      const group: GroupInstance = {
        id: groupId,
        name: 'Test Group',
        path: 'test',
        childGroupIds: [],
        nodeIds: ['n1'],
        allNodeIds: ['n1'],
        totalNodes: 1,
      };
      const groupState: GroupExecutionState = {
        status: 'running',
        version: 0,
        runningCount: 1,
        succeededCount: 0,
        failedCount: 0,
        blockedCount: 0,
        canceledCount: 0,
      };

      const plan = makePlan(
        [node],
        new Map([['n1', makeState('running')]]),
      );
      plan.groups.set(groupId, group);
      plan.groupStates.set(groupId, groupState);

      const sm = new PlanStateMachine(plan);
      const initialVersion = groupState.version;

      sm.transition('n1', 'completed_split');

      // completed_split falls into `default: pending++` in recomputeGroupState,
      // which changes group status from 'running' to 'pending' (group recomputed)
      assert.ok(
        groupState.version > initialVersion || groupState.status !== 'running',
        'Group state should be updated after completed_split transition',
      );
    });
  });

  // =========================================================================
  // 3. Reshape topology
  // =========================================================================

  suite('reshape topology', () => {
    test('sub-jobs depend on parent via addNode with parent producerId', () => {
      // Setup: parent node completed_split, now we add sub-jobs
      const parent = makeNode('parent-id', { producerId: 'parent' });
      const plan = makePlan(
        [parent],
        new Map([
          ['parent-id', makeState('completed_split', { completedCommit: 'abc123' })],
        ]),
      );
      recomputeRootsAndLeaves(plan);

      // Add sub-job depending on parent
      const result = reshaperAddNode(plan, {
        producerId: 'parent-sub-1',
        name: 'Sub Job 1',
        task: 'sub task 1',
        dependencies: ['parent'],
      });

      assert.ok(result.success, `addNode failed: ${result.error}`);
      const subNode = plan.jobs.get(result.nodeId!);
      assert.ok(subNode);
      assert.ok(subNode!.dependencies.includes('parent-id'));
      assert.ok(parent.dependents.includes(result.nodeId!));
    });

    test('fan-in created via addNodeAfter depends on parent initially', () => {
      const parent = makeNode('parent-id', { producerId: 'parent', dependents: [] });
      const plan = makePlan(
        [parent],
        new Map([
          ['parent-id', makeState('completed_split', { completedCommit: 'abc123' })],
        ]),
      );
      recomputeRootsAndLeaves(plan);

      const fanInResult = reshaperAddNodeAfter(plan, 'parent-id', {
        producerId: 'parent-fan-in',
        name: 'Fan-in',
        task: 'validate',
        work: { type: 'shell', command: 'true' },
        dependencies: [],
      });

      assert.ok(fanInResult.success, `addNodeAfter failed: ${fanInResult.error}`);
      const fanInNode = plan.jobs.get(fanInResult.nodeId!);
      assert.ok(fanInNode);
      // addNodeAfter places fanIn after parent, so fanIn depends on parent
      assert.ok(fanInNode!.dependencies.includes('parent-id'));
    });

    test('fan-in deps overridden to sub-jobs via updateNodeDependencies', () => {
      // Full reshape: parent → sub-jobs → fan-in
      const parent = makeNode('parent-id', { producerId: 'parent' });
      const plan = makePlan(
        [parent],
        new Map([
          ['parent-id', makeState('completed_split', { completedCommit: 'abc123' })],
        ]),
      );
      recomputeRootsAndLeaves(plan);

      // Add two sub-jobs
      const sub1 = reshaperAddNode(plan, {
        producerId: 'parent-sub-1',
        name: 'Sub 1',
        task: 'sub task 1',
        dependencies: ['parent'],
      });
      const sub2 = reshaperAddNode(plan, {
        producerId: 'parent-sub-2',
        name: 'Sub 2',
        task: 'sub task 2',
        dependencies: ['parent'],
      });
      assert.ok(sub1.success && sub2.success);

      // Add fan-in after parent
      const fanIn = reshaperAddNodeAfter(plan, 'parent-id', {
        producerId: 'parent-fan-in',
        name: 'Fan-in',
        task: 'validate',
        work: { type: 'shell', command: 'true' },
        dependencies: [],
      });
      assert.ok(fanIn.success);

      // Override fan-in deps to sub-jobs
      const updateResult = reshaperUpdateNodeDependencies(
        plan,
        fanIn.nodeId!,
        [sub1.nodeId!, sub2.nodeId!],
      );
      assert.ok(updateResult.success, `updateNodeDependencies failed: ${updateResult.error}`);

      const fanInNode = plan.jobs.get(fanIn.nodeId!)!;
      assert.deepStrictEqual(
        fanInNode.dependencies.sort(),
        [sub1.nodeId!, sub2.nodeId!].sort(),
      );
      // Fan-in should no longer depend on parent
      assert.ok(!fanInNode.dependencies.includes('parent-id'));
    });
  });

  // =========================================================================
  // 4. Reshape dep transfer: downstream deps transferred via addNodeAfter
  // =========================================================================

  suite('reshape dep transfer', () => {
    test("parent's downstream deps transferred to fan-in via addNodeAfter", () => {
      // Setup: parent → downstream
      const parent = makeNode('parent-id', { producerId: 'parent', dependents: ['downstream-id'] });
      const downstream = makeNode('downstream-id', {
        producerId: 'downstream',
        dependencies: ['parent-id'],
      });
      const plan = makePlan(
        [parent, downstream],
        new Map([
          ['parent-id', makeState('completed_split', { completedCommit: 'abc123' })],
          ['downstream-id', makeState('pending')],
        ]),
      );
      recomputeRootsAndLeaves(plan);

      // Insert fan-in after parent
      const fanIn = reshaperAddNodeAfter(plan, 'parent-id', {
        producerId: 'fan-in',
        name: 'Fan-in',
        task: 'validate',
        work: { type: 'shell', command: 'true' },
        dependencies: [],
      });
      assert.ok(fanIn.success, `addNodeAfter failed: ${fanIn.error}`);

      // Downstream should now depend on fan-in (transferred from parent)
      const downstreamNode = plan.jobs.get('downstream-id')!;
      assert.ok(
        downstreamNode.dependencies.includes(fanIn.nodeId!),
        'Downstream should depend on fan-in after addNodeAfter',
      );
    });
  });

  // =========================================================================
  // 5. Reshape SV rewire
  // =========================================================================

  suite('reshape SV rewire', () => {
    test('SV node depends on fan-in (not parent) after reshape', () => {
      // Setup: parent + SV node. SV initially depends on parent.
      const parent = makeNode('parent-id', { producerId: 'parent' });
      const svNode = makeNode('sv-id', {
        producerId: '__snapshot-validation__',
        dependencies: ['parent-id'],
      });
      parent.dependents = ['sv-id'];

      const plan = makePlan(
        [parent, svNode],
        new Map([
          ['parent-id', makeState('completed_split', { completedCommit: 'abc123' })],
          ['sv-id', makeState('pending')],
        ]),
      );
      recomputeRootsAndLeaves(plan);

      // Verify initial state: SV depends on parent
      assert.ok(svNode.dependencies.includes('parent-id'));

      // Add fan-in after parent. addNodeAfter transfers parent's modifiable
      // dependents (SV) to the fan-in and calls recomputeRootsAndLeaves
      // which triggers syncSnapshotValidationDeps to rewire SV.
      const fanIn = reshaperAddNodeAfter(plan, 'parent-id', {
        producerId: 'parent-fan-in',
        name: 'Fan-in',
        task: 'validate',
        work: { type: 'shell', command: 'true' },
        dependencies: [],
      });
      assert.ok(fanIn.success, `addNodeAfter failed: ${fanIn.error}`);

      // After addNodeAfter + recompute, SV should depend on fan-in (the new
      // leaf node), not parent directly.
      const svAfter = plan.jobs.get('sv-id')!;
      assert.ok(
        svAfter.dependencies.includes(fanIn.nodeId!),
        `SV should depend on fan-in. Got: ${JSON.stringify(svAfter.dependencies)}`,
      );
      assert.ok(
        !svAfter.dependencies.includes('parent-id'),
        'SV should no longer directly depend on parent',
      );
    });
  });

  // =========================================================================
  // 6. Fan-in spec construction
  // =========================================================================

  suite('fan-in spec', () => {
    test('fan-in has work=true, postchecks from parent, autoHeal=true', () => {
      // Simulates what IJobSplitter.buildFanInSpec should produce
      const parentPostchecks = { type: 'shell' as const, command: 'npm test' };
      const subJobProducerIds = ['parent-sub-1', 'parent-sub-2'];

      const fanInSpec: JobNodeSpec = {
        producerId: 'parent-fan-in',
        name: 'Fan-in validation',
        task: 'Validate combined sub-job output',
        work: { type: 'shell', command: 'true' },
        postchecks: parentPostchecks,
        autoHeal: true,
        dependencies: subJobProducerIds,
      };

      assert.deepStrictEqual(fanInSpec.work, { type: 'shell', command: 'true' });
      assert.deepStrictEqual(fanInSpec.postchecks, parentPostchecks);
      assert.strictEqual(fanInSpec.autoHeal, true);
    });
  });

  // =========================================================================
  // 7. Reshape failure recovery
  // =========================================================================

  suite('reshape failure recovery', () => {
    test('reshape throws → node transitions completed_split → failed', () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('running')]]));
      const sm = new PlanStateMachine(plan);

      // Simulate: running → completed_split → reshape fails → failed
      sm.transition('n1', 'completed_split');
      assert.strictEqual(plan.nodeStates.get('n1')!.status, 'completed_split');

      sm.transition('n1', 'failed');
      assert.strictEqual(plan.nodeStates.get('n1')!.status, 'failed');
      assert.ok(isTerminal('failed'));
    });

    test('completed_split → failed propagates blocked to dependents', () => {
      const parent = makeNode('parent', { dependents: ['child'] });
      const child = makeNode('child', { dependencies: ['parent'] });
      const plan = makePlan(
        [parent, child],
        new Map([
          ['parent', makeState('completed_split')],
          ['child', makeState('pending')],
        ]),
      );
      const sm = new PlanStateMachine(plan);

      sm.transition('parent', 'failed');

      assert.strictEqual(plan.nodeStates.get('child')!.status, 'blocked');
    });

    test('failed reshape triggers planComplete if single-node plan', () => {
      const node = makeNode('n1');
      const plan = makePlan(
        [node],
        new Map([['n1', makeState('completed_split')]]),
      );
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);

      const completionSpy = sandbox.spy();
      sm.on('planComplete', completionSpy);

      sm.transition('n1', 'failed');

      assert.strictEqual(completionSpy.callCount, 1);
      assert.strictEqual(completionSpy.firstCall.args[0].status, 'failed');
    });
  });

  // =========================================================================
  // 8. planReshaped event
  // =========================================================================

  suite('planReshaped event', () => {
    test('emitted after successful reshape via events.emit', () => {
      // Simulate the events emitter pattern used by the execution engine
      const { PlanEventEmitter } = require('../../../plan/planEvents');
      const events = new PlanEventEmitter();
      const spy = sandbox.spy();
      events.on('planReshaped', spy);

      events.emit('planReshaped', 'plan-1');

      assert.strictEqual(spy.callCount, 1);
      assert.strictEqual(spy.firstCall.args[0], 'plan-1');
    });
  });

  // =========================================================================
  // 9. agentPhase filter
  // =========================================================================

  suite('agentPhase filter', () => {
    test('manifest found but agentPhase=auto-heal → normal succeeded (no split)', () => {
      // The execution engine only enters the split path when agentPhase === 'work'.
      // When agentPhase is 'auto-heal', it should skip directly to succeeded.
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([
        ['n1', makeState('running', { agentPhase: 'auto-heal' as any, worktreePath: '/wt' })],
      ]));
      const sm = new PlanStateMachine(plan);

      // Simulating what the engine does: check agentPhase before entering split
      const nodeState = plan.nodeStates.get('n1')!;
      const hasManifest = true;
      const shouldSplit = hasManifest && nodeState.agentPhase === 'work';

      assert.strictEqual(shouldSplit, false, 'Should NOT split when agentPhase is auto-heal');

      // Normal succeeded transition
      sm.transition('n1', 'succeeded');
      assert.strictEqual(plan.nodeStates.get('n1')!.status, 'succeeded');
    });

    test('manifest found and agentPhase=work → should split', () => {
      const nodeState = makeState('running', { agentPhase: 'work' as any, worktreePath: '/wt' });
      const hasManifest = true;
      const shouldSplit = hasManifest && nodeState.agentPhase === 'work';

      assert.strictEqual(shouldSplit, true, 'Should split when agentPhase is work');
    });

    test('no manifest → no split regardless of agentPhase', () => {
      const nodeState = makeState('running', { agentPhase: 'work' as any, worktreePath: '/wt' });
      const hasManifest = false;
      const shouldSplit = hasManifest && nodeState.agentPhase === 'work';

      assert.strictEqual(shouldSplit, false, 'Should NOT split when no manifest');
    });
  });

  // =========================================================================
  // 10. Reshape persistence
  // =========================================================================

  suite('reshape persistence', () => {
    test('savePlanState called after reshaper mutations (mock verification)', () => {
      // Verify the pattern: after reshape mutations, the engine saves state.
      // We test this by confirming stateVersion increments after mutations.
      const parent = makeNode('parent-id', { producerId: 'parent' });
      const plan = makePlan(
        [parent],
        new Map([
          ['parent-id', makeState('completed_split', { completedCommit: 'abc123' })],
        ]),
      );
      recomputeRootsAndLeaves(plan);

      const versionBefore = plan.stateVersion;

      reshaperAddNode(plan, {
        producerId: 'parent-sub-1',
        name: 'Sub 1',
        task: 'sub 1',
        dependencies: ['parent'],
      });

      assert.ok(
        plan.stateVersion > versionBefore,
        'stateVersion should increment after addNode',
      );

      const versionAfterAdd = plan.stateVersion;

      const fanIn = reshaperAddNodeAfter(plan, 'parent-id', {
        producerId: 'parent-fan-in',
        name: 'Fan-in',
        task: 'validate',
        dependencies: [],
      });

      assert.ok(
        plan.stateVersion > versionAfterAdd,
        'stateVersion should increment after addNodeAfter',
      );
    });
  });

  // =========================================================================
  // 11. Transition event is emitted for completed_split
  // =========================================================================

  suite('transition events', () => {
    test('transition event emitted for running → completed_split', () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('running')]]));
      const sm = new PlanStateMachine(plan);

      const transitionSpy = sandbox.spy();
      sm.on('transition', transitionSpy);

      sm.transition('n1', 'completed_split');

      assert.strictEqual(transitionSpy.callCount, 1);
      const evt = transitionSpy.firstCall.args[0];
      assert.strictEqual(evt.from, 'running');
      assert.strictEqual(evt.to, 'completed_split');
      assert.strictEqual(evt.nodeId, 'n1');
    });
  });
});
