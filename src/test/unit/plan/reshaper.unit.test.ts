import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import {
  addNode,
  removeNode,
  updateNodeDependencies,
  addNodeBefore,
  addNodeAfter,
  hasCycle,
  recomputeRootsAndLeaves,
} from '../../../plan/reshaper';
import type { PlanInstance, PlanNode, NodeExecutionState, JobNodeSpec } from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, opts: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    producerId: opts.producerId ?? id,
    name: opts.name ?? id,
    type: 'job',
    task: opts.task ?? 'do stuff',
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
    work: opts.work,
    prechecks: opts.prechecks,
    postchecks: opts.postchecks,
    instructions: opts.instructions,
    baseBranch: opts.baseBranch,
    expectsNoChanges: opts.expectsNoChanges,
    autoHeal: opts.autoHeal,
    group: opts.group,
  } as PlanNode;
}

function makeState(status: string, extras: Partial<NodeExecutionState> = {}): NodeExecutionState {
  return {
    status: status as any,
    version: 0,
    attempts: 0,
    ...extras,
  } as NodeExecutionState;
}

function makeSpec(producerId: string, deps: string[] = [], extras: Partial<JobNodeSpec> = {}): JobNodeSpec {
  return {
    producerId,
    task: `task for ${producerId}`,
    dependencies: deps,
    ...extras,
  };
}

/**
 * Create a minimal PlanInstance with optional pre-populated nodes.
 * By default the plan is "started" (modifiable).
 */
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
    nodes: nodesMap,
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

suite('reshaper', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  // -----------------------------------------------------------------------
  // recomputeRootsAndLeaves
  // -----------------------------------------------------------------------
  suite('recomputeRootsAndLeaves', () => {
    test('computes roots and leaves correctly', () => {
      const a = makeNode('a', { dependencies: [], dependents: ['b'] });
      const b = makeNode('b', { dependencies: ['a'], dependents: ['c'] });
      const c = makeNode('c', { dependencies: ['b'], dependents: [] });
      const plan = makePlan([a, b, c]);

      recomputeRootsAndLeaves(plan);

      assert.deepStrictEqual(plan.roots, ['a']);
      assert.deepStrictEqual(plan.leaves, ['c']);
    });

    test('single node is both root and leaf', () => {
      const a = makeNode('a', { dependencies: [], dependents: [] });
      const plan = makePlan([a]);

      recomputeRootsAndLeaves(plan);

      assert.deepStrictEqual(plan.roots, ['a']);
      assert.deepStrictEqual(plan.leaves, ['a']);
    });

    test('multiple roots and leaves', () => {
      const a = makeNode('a', { dependencies: [], dependents: ['c'] });
      const b = makeNode('b', { dependencies: [], dependents: ['c'] });
      const c = makeNode('c', { dependencies: ['a', 'b'], dependents: [] });
      const d = makeNode('d', { dependencies: [], dependents: [] });
      const plan = makePlan([a, b, c, d]);

      recomputeRootsAndLeaves(plan);

      assert.deepStrictEqual(plan.roots.sort(), ['a', 'b', 'd']);
      assert.deepStrictEqual(plan.leaves.sort(), ['c', 'd']);
    });
  });

  // -----------------------------------------------------------------------
  // hasCycle
  // -----------------------------------------------------------------------
  suite('hasCycle', () => {
    test('returns false for valid edge', () => {
      // a -> b (a depends on b)
      const a = makeNode('a', { dependencies: ['b'], dependents: [] });
      const b = makeNode('b', { dependencies: [], dependents: ['a'] });
      const plan = makePlan([a, b]);

      // Adding c -> a (c depends on a) — no cycle
      assert.strictEqual(hasCycle(plan, 'c', 'a'), false);
    });

    test('returns true when edge would create cycle', () => {
      // a depends on b, b depends on c
      const a = makeNode('a', { dependencies: ['b'], dependents: [] });
      const b = makeNode('b', { dependencies: ['c'], dependents: ['a'] });
      const c = makeNode('c', { dependencies: [], dependents: ['b'] });
      const plan = makePlan([a, b, c]);

      // Adding c -> a means "c depends on a", but a already depends on b which depends on c — cycle
      assert.strictEqual(hasCycle(plan, 'c', 'a'), true);
    });

    test('returns false when no cycle', () => {
      const a = makeNode('a', { dependencies: [], dependents: [] });
      const b = makeNode('b', { dependencies: [], dependents: [] });
      const plan = makePlan([a, b]);

      assert.strictEqual(hasCycle(plan, 'a', 'b'), false);
    });

    test('self-loop is a cycle', () => {
      const a = makeNode('a', { dependencies: [], dependents: [] });
      const plan = makePlan([a]);

      // hasCycle checks if toId can reach fromId via dependencies
      // fromId=a, toId=a => starts BFS at a, immediately equals a => true
      assert.strictEqual(hasCycle(plan, 'a', 'a'), true);
    });
  });

  // -----------------------------------------------------------------------
  // addNode
  // -----------------------------------------------------------------------
  suite('addNode', () => {
    test('successfully adds a node with no dependencies', () => {
      const plan = makePlan([], new Map());

      const result = addNode(plan, makeSpec('new-node'));

      assert.strictEqual(result.success, true);
      assert.ok(result.nodeId);
      assert.strictEqual(plan.nodes.size, 1);
      assert.ok(plan.producerIdToNodeId.has('new-node'));

      const node = plan.nodes.get(result.nodeId!);
      assert.ok(node);
      assert.deepStrictEqual(node!.dependencies, []);
      assert.strictEqual(node!.task, 'task for new-node');

      const state = plan.nodeStates.get(result.nodeId!);
      assert.strictEqual(state!.status, 'ready');
    });

    test('successfully adds a node with dependencies', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc123' }));
      const plan = makePlan([a], states);

      const result = addNode(plan, makeSpec('new-node', ['a']));

      assert.strictEqual(result.success, true);
      assert.ok(result.nodeId);

      const node = plan.nodes.get(result.nodeId!);
      assert.deepStrictEqual(node!.dependencies, ['a-id']);

      // a should have the new node as dependent
      assert.ok(a.dependents.includes(result.nodeId!));

      // Since dep is succeeded, new node should be ready
      const state = plan.nodeStates.get(result.nodeId!);
      assert.strictEqual(state!.status, 'ready');
    });

    test('node is pending when dependency is not succeeded', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);

      const result = addNode(plan, makeSpec('new-node', ['a']));

      assert.strictEqual(result.success, true);
      const state = plan.nodeStates.get(result.nodeId!);
      assert.strictEqual(state!.status, 'pending');
    });

    test('fails when plan is not modifiable (ended)', () => {
      const plan = makePlan([], new Map(), {
        startedAt: Date.now(),
        endedAt: Date.now(),
      });

      const result = addNode(plan, makeSpec('new-node'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('not in a modifiable state'));
    });

    test('succeeds when plan is paused', () => {
      const plan = makePlan([], new Map(), {
        isPaused: true,
        startedAt: Date.now(),
      });

      const result = addNode(plan, makeSpec('new-node'));

      assert.strictEqual(result.success, true);
    });

    test('fails when dependency not found', () => {
      const plan = makePlan([], new Map());

      const result = addNode(plan, makeSpec('new-node', ['nonexistent']));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'nonexistent' not found"));
    });

    test('fails when dependency is not available (cleaned up, no commit)', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('failed', { worktreeCleanedUp: true }));
      const plan = makePlan([a], states);

      const result = addNode(plan, makeSpec('new-node', ['a']));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('no available worktree'));
    });

    test('dependency is available with worktree', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('running', { worktreePath: '/wt/a' }));
      const plan = makePlan([a], states);

      const result = addNode(plan, makeSpec('new-node', ['a']));

      assert.strictEqual(result.success, true);
    });

    test('fails when producer ID already exists', () => {
      const a = makeNode('a-id', { producerId: 'existing' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);

      const result = addNode(plan, makeSpec('existing'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'existing' already exists"));
    });

    test('recomputes roots and leaves after adding', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      const plan = makePlan([a], states);
      recomputeRootsAndLeaves(plan);
      assert.deepStrictEqual(plan.roots, ['a-id']);
      assert.deepStrictEqual(plan.leaves, ['a-id']);

      const result = addNode(plan, makeSpec('b', ['a']));

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(plan.roots, ['a-id']);
      assert.deepStrictEqual(plan.leaves, [result.nodeId]);
    });

    test('increments stateVersion', () => {
      const plan = makePlan([], new Map());
      const before = plan.stateVersion;

      addNode(plan, makeSpec('x'));

      assert.strictEqual(plan.stateVersion, before + 1);
    });
  });

  // -----------------------------------------------------------------------
  // removeNode
  // -----------------------------------------------------------------------
  suite('removeNode', () => {
    test('successfully removes a pending node', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);

      const result = removeNode(plan, 'a-id');

      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.nodes.size, 0);
      assert.strictEqual(plan.nodeStates.size, 0);
      assert.strictEqual(plan.producerIdToNodeId.has('a'), false);
    });

    test('successfully removes a ready node', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('ready'));
      const plan = makePlan([a], states);

      const result = removeNode(plan, 'a-id');

      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.nodes.size, 0);
    });

    test('fails when node not found', () => {
      const plan = makePlan([], new Map());

      const result = removeNode(plan, 'nonexistent');

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'nonexistent' not found"));
    });

    test('fails when node is running', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('running'));
      const plan = makePlan([a], states);

      const result = removeNode(plan, 'a-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'running'"));
    });

    test('fails when node is succeeded', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded'));
      const plan = makePlan([a], states);

      const result = removeNode(plan, 'a-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'succeeded'"));
    });

    test('fails when dependent node is non-pending (running)', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      states.set('b-id', makeState('running'));
      const plan = makePlan([a, b], states);

      const result = removeNode(plan, 'a-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'running'"));
    });

    test('succeeds when all dependents are pending', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      const result = removeNode(plan, 'a-id');

      assert.strictEqual(result.success, true);
      // b should have a-id removed from its dependencies
      assert.deepStrictEqual(b.dependencies, []);
    });

    test('removes from upstream dependents lists', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      removeNode(plan, 'b-id');

      assert.deepStrictEqual(a.dependents, []);
    });

    test('recomputes roots and leaves', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);
      recomputeRootsAndLeaves(plan);

      removeNode(plan, 'b-id');

      assert.deepStrictEqual(plan.roots, ['a-id']);
      assert.deepStrictEqual(plan.leaves, ['a-id']);
    });

    test('increments stateVersion', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const before = plan.stateVersion;

      removeNode(plan, 'a-id');

      assert.strictEqual(plan.stateVersion, before + 1);
    });
  });

  // -----------------------------------------------------------------------
  // updateNodeDependencies
  // -----------------------------------------------------------------------
  suite('updateNodeDependencies', () => {
    test('successfully updates dependencies', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['c-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependents: [] });
      const c = makeNode('c-id', { producerId: 'c', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('succeeded', { completedCommit: 'def' }));
      states.set('c-id', makeState('pending'));
      const plan = makePlan([a, b, c], states);

      const result = updateNodeDependencies(plan, 'c-id', ['b-id']);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(c.dependencies, ['b-id']);
      // c removed from a's dependents
      assert.deepStrictEqual(a.dependents, []);
      // c added to b's dependents
      assert.ok(b.dependents.includes('c-id'));
    });

    test('node becomes ready when all new deps succeeded', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: [] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      // Remove dependencies (empty) -> should become ready
      updateNodeDependencies(plan, 'b-id', []);

      const state = plan.nodeStates.get('b-id')!;
      assert.strictEqual(state.status, 'ready');
    });

    test('node becomes pending when new deps not succeeded', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: [] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: [], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      states.set('b-id', makeState('ready'));
      const plan = makePlan([a, b], states);

      updateNodeDependencies(plan, 'b-id', ['a-id']);

      const state = plan.nodeStates.get('b-id')!;
      assert.strictEqual(state.status, 'pending');
    });

    test('fails when node not found', () => {
      const plan = makePlan([], new Map());

      const result = updateNodeDependencies(plan, 'nonexistent', []);

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'nonexistent' not found"));
    });

    test('fails when node is not in modifiable state', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('running'));
      const plan = makePlan([a], states);

      const result = updateNodeDependencies(plan, 'a-id', []);

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'running'"));
    });

    test('fails when dependency node not found', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);

      const result = updateNodeDependencies(plan, 'a-id', ['nonexistent']);

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'nonexistent' not found"));
    });

    test('fails when dependency would create cycle', () => {
      // Self-dependency: update a to depend on itself — trivial cycle detected
      // by isReachableViaUpstream(plan, a, a, excluded={a}): start=target => true
      const a = makeNode('a-id', { producerId: 'a', dependencies: [], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);

      const result = updateNodeDependencies(plan, 'a-id', ['a-id']);

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('cycle'));
    });

    test('fails when dependency not available', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: [] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: [], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('failed', { worktreeCleanedUp: true }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      const result = updateNodeDependencies(plan, 'b-id', ['a-id']);

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('no available worktree'));
    });

    test('increments stateVersion', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const before = plan.stateVersion;

      updateNodeDependencies(plan, 'a-id', []);

      assert.strictEqual(plan.stateVersion, before + 1);
    });
  });

  // -----------------------------------------------------------------------
  // addNodeBefore
  // -----------------------------------------------------------------------
  suite('addNodeBefore', () => {
    test('inserts node before existing node', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      const result = addNodeBefore(plan, 'b-id', makeSpec('new-before'));

      assert.strictEqual(result.success, true);
      assert.ok(result.nodeId);

      // b should now depend on the new node
      assert.deepStrictEqual(b.dependencies, [result.nodeId]);

      // new node should have b as dependent
      const newNode = plan.nodes.get(result.nodeId!)!;
      assert.ok(newNode.dependents.includes('b-id'));
    });

    test('new node inherits spec dependencies', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      const result = addNodeBefore(plan, 'b-id', makeSpec('new-before', ['a']));

      assert.strictEqual(result.success, true);
      const newNode = plan.nodes.get(result.nodeId!)!;
      assert.ok(newNode.dependencies.includes('a-id'));
    });

    test('fails when existing node not found', () => {
      const plan = makePlan([], new Map());

      const result = addNodeBefore(plan, 'nonexistent', makeSpec('new'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'nonexistent' not found"));
    });

    test('fails when existing node is not modifiable', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('running'));
      const plan = makePlan([a], states);

      const result = addNodeBefore(plan, 'a-id', makeSpec('new'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'running'"));
    });

    test('fails when plan is not modifiable', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states, { startedAt: Date.now(), endedAt: Date.now() });

      const result = addNodeBefore(plan, 'a-id', makeSpec('new'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('not in a modifiable state'));
    });

    test('fails when producer ID already exists', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);

      const result = addNodeBefore(plan, 'a-id', makeSpec('a'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'a' already exists"));
    });
  });

  // -----------------------------------------------------------------------
  // addNodeAfter
  // -----------------------------------------------------------------------
  suite('addNodeAfter', () => {
    test('inserts node after existing node', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);

      const result = addNodeAfter(plan, 'a-id', makeSpec('new-after'));

      assert.strictEqual(result.success, true);
      assert.ok(result.nodeId);

      // new node should depend on a
      const newNode = plan.nodes.get(result.nodeId!)!;
      assert.ok(newNode.dependencies.includes('a-id'));

      // b (modifiable dependent) should now depend on new node instead of a
      assert.ok(b.dependencies.includes(result.nodeId!));
      assert.ok(!b.dependencies.includes('a-id'));

      // a should have new node as dependent, b removed
      assert.ok(a.dependents.includes(result.nodeId!));
    });

    test('transfers only modifiable dependents', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id', 'c-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: [] });
      const c = makeNode('c-id', { producerId: 'c', dependencies: ['a-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      states.set('c-id', makeState('running'));
      const plan = makePlan([a, b, c], states);

      const result = addNodeAfter(plan, 'a-id', makeSpec('new-after'));

      assert.strictEqual(result.success, true);
      // Only b (pending) should be transferred, not c (running)
      const newNode = plan.nodes.get(result.nodeId!)!;
      assert.deepStrictEqual(newNode.dependents, ['b-id']);
      // c should still depend on a
      assert.ok(c.dependencies.includes('a-id'));
    });

    test('fails when existing node not found', () => {
      const plan = makePlan([], new Map());

      const result = addNodeAfter(plan, 'nonexistent', makeSpec('new'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'nonexistent' not found"));
    });

    test('fails when plan is not modifiable', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states, { startedAt: Date.now(), endedAt: Date.now() });

      const result = addNodeAfter(plan, 'a-id', makeSpec('new'));

      assert.strictEqual(result.success, false);
    });

    test('fails when existing node is not available', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('failed', { worktreeCleanedUp: true }));
      const plan = makePlan([a], states);

      const result = addNodeAfter(plan, 'a-id', makeSpec('new'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('no available worktree'));
    });

    test('fails when producer ID already exists', () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      const plan = makePlan([a], states);

      const result = addNodeAfter(plan, 'a-id', makeSpec('a'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("'a' already exists"));
    });
  });

  // -----------------------------------------------------------------------
  // Multiple sequential operations
  // -----------------------------------------------------------------------
  suite('multiple sequential operations', () => {
    test('add then remove', () => {
      const plan = makePlan([], new Map());

      const addResult = addNode(plan, makeSpec('x'));
      assert.strictEqual(addResult.success, true);
      assert.strictEqual(plan.nodes.size, 1);

      const removeResult = removeNode(plan, addResult.nodeId!);
      assert.strictEqual(removeResult.success, true);
      assert.strictEqual(plan.nodes.size, 0);
    });

    test('add two nodes then update deps', () => {
      const plan = makePlan([], new Map());

      const r1 = addNode(plan, makeSpec('first'));
      assert.strictEqual(r1.success, true);

      const r2 = addNode(plan, makeSpec('second'));
      assert.strictEqual(r2.success, true);

      // Make second depend on first
      const updateResult = updateNodeDependencies(plan, r2.nodeId!, [r1.nodeId!]);
      assert.strictEqual(updateResult.success, true);

      const secondNode = plan.nodes.get(r2.nodeId!)!;
      assert.deepStrictEqual(secondNode.dependencies, [r1.nodeId!]);
    });

    test('add chain: a -> b -> c', () => {
      const plan = makePlan([], new Map());

      const ra = addNode(plan, makeSpec('a'));
      const rb = addNode(plan, makeSpec('b', ['a']));
      const rc = addNode(plan, makeSpec('c', ['b']));

      assert.strictEqual(ra.success, true);
      assert.strictEqual(rb.success, true);
      assert.strictEqual(rc.success, true);

      assert.strictEqual(plan.nodes.size, 3);
      recomputeRootsAndLeaves(plan);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  suite('edge cases', () => {
    test('single-node plan: add and remove', () => {
      const plan = makePlan([], new Map());

      const r = addNode(plan, makeSpec('solo'));
      assert.strictEqual(r.success, true);
      assert.strictEqual(plan.nodes.size, 1);

      const rm = removeNode(plan, r.nodeId!);
      assert.strictEqual(rm.success, true);
      assert.strictEqual(plan.nodes.size, 0);
      assert.deepStrictEqual(plan.roots, []);
      assert.deepStrictEqual(plan.leaves, []);
    });

    test('all completed except one — can modify the pending one', () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: ['b-id'] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: ['a-id'], dependents: ['c-id'] });
      const c = makeNode('c-id', { producerId: 'c', dependencies: ['b-id'], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('succeeded', { completedCommit: 'def' }));
      states.set('c-id', makeState('pending'));
      const plan = makePlan([a, b, c], states);

      // Can update deps of the only pending node
      const result = updateNodeDependencies(plan, 'c-id', ['a-id']);
      assert.strictEqual(result.success, true);

      // c should now be ready since a is succeeded
      const state = plan.nodeStates.get('c-id')!;
      assert.strictEqual(state.status, 'ready');
    });

    test('plan not yet started is modifiable', () => {
      const plan = makePlan([], new Map(), { startedAt: undefined });

      const result = addNode(plan, makeSpec('x'));
      assert.strictEqual(result.success, true);
    });

    test('removeNode with no producerId', () => {
      const a = makeNode('a-id', { producerId: undefined as any });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      // Manually fix producerIdToNodeId since makeNode auto-sets it
      plan.producerIdToNodeId.clear();

      const result = removeNode(plan, 'a-id');
      assert.strictEqual(result.success, true);
    });
  });
});
