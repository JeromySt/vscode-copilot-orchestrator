import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { handleReshapePlan } from '../../../../../mcp/handlers/plan/reshapePlanHandler';
import type { PlanInstance, PlanNode, NodeExecutionState } from '../../../../../plan/types';

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

function makeCtx(plan: PlanInstance | undefined, overrides: Record<string, any> = {}): any {
  return {
    PlanRunner: {
      getPlan: sinon.stub().returns(plan),
      get: sinon.stub().returns(plan),
      savePlan: sinon.stub(),
      emit: sinon.stub(),
      ...overrides,
    },
    workspacePath: '/test',
    git: {},
  };
}

suite('reshapePlanHandler', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  suite('validation', () => {
    test('requires planId', async () => {
      const ctx = makeCtx(undefined);
      const result = await handleReshapePlan({ operations: [] }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('requires operations', async () => {
      const ctx = makeCtx(undefined);
      const result = await handleReshapePlan({ planId: 'p1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('operations'));
    });

    test('rejects empty operations array', async () => {
      const ctx = makeCtx(undefined);
      const result = await handleReshapePlan({ planId: 'p1', operations: [] }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('non-empty'));
    });

    test('returns error when plan not found', async () => {
      const ctx = makeCtx(undefined);
      const result = await handleReshapePlan({
        planId: 'nonexistent',
        operations: [{ type: 'add_node', spec: { producer_id: 'x', task: 'test', dependencies: [] } }],
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });
  });

  // -----------------------------------------------------------------------
  // add_node operations
  // -----------------------------------------------------------------------
  suite('add_node', () => {
    test('successfully adds a node', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{
          type: 'add_node',
          spec: { producer_id: 'new-node', task: 'do work', dependencies: [] },
        }],
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].success, true);
      assert.ok(result.results[0].nodeId);
      assert.strictEqual(result.topology.nodeCount, 1);
      assert.ok(ctx.PlanRunner.savePlan.calledOnce);
    });

    test('reports error when spec is missing', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'add_node' }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('spec is required'));
    });
  });

  // -----------------------------------------------------------------------
  // remove_node operations
  // -----------------------------------------------------------------------
  suite('remove_node', () => {
    test('removes node by nodeId', async () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'remove_node', nodeId: 'a-id' }],
      }, ctx);

      assert.strictEqual(result.results[0].success, true);
      assert.strictEqual(result.topology.nodeCount, 0);
    });

    test('removes node by producer_id', async () => {
      const a = makeNode('a-id', { producerId: 'my-producer' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'remove_node', producer_id: 'my-producer' }],
      }, ctx);

      assert.strictEqual(result.results[0].success, true);
    });

    test('reports error when node not found', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'remove_node', producer_id: 'no-such-node' }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('not found'));
    });
  });

  // -----------------------------------------------------------------------
  // update_deps operations
  // -----------------------------------------------------------------------
  suite('update_deps', () => {
    test('updates dependencies successfully', async () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: [] });
      const b = makeNode('b-id', { producerId: 'b', dependencies: [], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'update_deps', nodeId: 'b-id', dependencies: ['a-id'] }],
      }, ctx);

      assert.strictEqual(result.results[0].success, true);
    });

    test('reports error when nodeId missing', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'update_deps', dependencies: ['a-id'] }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('required'));
    });

    test('resolves dependencies via producer_id', async () => {
      const a = makeNode('a-id', { producerId: 'a-producer', dependents: [] });
      const b = makeNode('b-id', { producerId: 'b-producer', dependencies: [], dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      states.set('b-id', makeState('pending'));
      const plan = makePlan([a, b], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'update_deps', nodeId: 'b-id', dependencies: ['a-producer'] }],
      }, ctx);

      assert.strictEqual(result.results[0].success, true);
    });

    test('reports error when dependency not found', async () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'update_deps', nodeId: 'a-id', dependencies: ['no-such'] }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('not found'));
    });
  });

  // -----------------------------------------------------------------------
  // add_before / add_after
  // -----------------------------------------------------------------------
  suite('add_before', () => {
    test('adds node before existing', async () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{
          type: 'add_before',
          existingNodeId: 'a-id',
          spec: { producer_id: 'before-a', task: 'pre-work', dependencies: [] },
        }],
      }, ctx);

      assert.strictEqual(result.results[0].success, true);
      assert.ok(result.results[0].nodeId);
    });

    test('reports error when existingNodeId missing', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{
          type: 'add_before',
          spec: { producer_id: 'x', task: 'test', dependencies: [] },
        }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('required'));
    });

    test('reports error when node not found', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{
          type: 'add_before',
          existingNodeId: 'nonexistent',
          spec: { producer_id: 'x', task: 'test', dependencies: [] },
        }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('not found'));
    });
  });

  suite('update_deps edge cases', () => {
    test('update_deps rejects SV node', async () => {
      const svNode = makeNode('sv-id', { producerId: '__snapshot-validation__', name: 'Snapshot Validation' });
      const plan = makePlan([svNode], new Map([['sv-id', makeState('completed')]]));
      const ctx = makeCtx(plan);
      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'update_deps', nodeId: 'sv-id', dependencies: [] }],
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.results[0].error?.includes('auto-managed'));
    });

    test('update_deps with missing node returns error', async () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('completed')]]));
      const ctx = makeCtx(plan);
      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'update_deps', nodeId: 'nonexistent', dependencies: [] }],
      }, ctx);
      assert.ok(result.results[0].error?.includes('not found'));
    });
  });

  suite('add_after edge cases', () => {
    test('add_after with missing node returns error', async () => {
      const node = makeNode('n1');
      const plan = makePlan([node], new Map([['n1', makeState('completed')]]));
      const ctx = makeCtx(plan);
      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'add_after', existingNodeId: 'nonexistent', spec: { name: 'test', task: 'do stuff' } }],
      }, ctx);
      assert.ok(result.results[0].error?.includes('not found'));
    });
  });

  suite('add_after', () => {
    test('adds node after existing', async () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('succeeded', { completedCommit: 'abc' }));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{
          type: 'add_after',
          existingNodeId: 'a-id',
          spec: { producer_id: 'after-a', task: 'post-work', dependencies: [] },
        }],
      }, ctx);

      assert.strictEqual(result.results[0].success, true);
      assert.ok(result.results[0].nodeId);
    });

    test('reports error when existingNodeId missing', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{
          type: 'add_after',
          spec: { producer_id: 'x', task: 'test', dependencies: [] },
        }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('required'));
    });
  });

  // -----------------------------------------------------------------------
  // Unknown operation type
  // -----------------------------------------------------------------------
  suite('unknown operation', () => {
    test('reports error for unknown type', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [{ type: 'bogus_op' }],
      }, ctx);

      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('Unknown operation type'));
    });
  });

  // -----------------------------------------------------------------------
  // Mixed results
  // -----------------------------------------------------------------------
  suite('mixed results', () => {
    test('multiple operations with partial failures', async () => {
      const a = makeNode('a-id', { producerId: 'a' });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [
          // This should succeed
          { type: 'add_node', spec: { producer_id: 'new-1', task: 'work', dependencies: [] } },
          // This should fail — nonexistent node
          { type: 'remove_node', producer_id: 'nonexistent' },
          // This should succeed
          { type: 'add_node', spec: { producer_id: 'new-2', task: 'more work', dependencies: [] } },
        ],
      }, ctx);

      assert.strictEqual(result.success, false); // overall false because one failed
      assert.strictEqual(result.results.length, 3);
      assert.strictEqual(result.results[0].success, true);
      assert.strictEqual(result.results[1].success, false);
      assert.strictEqual(result.results[2].success, true);
    });

    test('all operations succeed', async () => {
      const plan = makePlan([], new Map());
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [
          { type: 'add_node', spec: { producer_id: 'a', task: 'work', dependencies: [] } },
          { type: 'add_node', spec: { producer_id: 'b', task: 'work', dependencies: ['a'] } },
        ],
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.topology.nodeCount, 2);
    });
  });

  // -----------------------------------------------------------------------
  // Plan completed
  // -----------------------------------------------------------------------
  suite('plan completed', () => {
    test('operations fail on completed plan', async () => {
      const plan = makePlan([], new Map(), {
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [
          { type: 'add_node', spec: { producer_id: 'x', task: 'test', dependencies: [] } },
        ],
      }, ctx);

      // The add_node should fail because plan is not modifiable
      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('not in a modifiable state'));
    });
  });

  // -----------------------------------------------------------------------
  // Topology summary
  // -----------------------------------------------------------------------
  suite('topology summary', () => {
    test('includes node details in response', async () => {
      const a = makeNode('a-id', { producerId: 'a', dependents: [] });
      const states = new Map<string, NodeExecutionState>();
      states.set('a-id', makeState('pending'));
      const plan = makePlan([a], states);
      const ctx = makeCtx(plan);

      const result = await handleReshapePlan({
        planId: 'plan-1',
        operations: [
          { type: 'add_node', spec: { producer_id: 'b', task: 'test', dependencies: [] } },
        ],
      }, ctx);

      assert.ok(result.topology);
      assert.strictEqual(result.topology.nodeCount, 2);
      assert.ok(Array.isArray(result.topology.roots));
      assert.ok(Array.isArray(result.topology.leaves));
      assert.ok(Array.isArray(result.topology.nodes));
      assert.strictEqual(result.topology.nodes.length, 2);

      const nodeB = result.topology.nodes.find((n: any) => n.producerId === 'b');
      assert.ok(nodeB);
      assert.ok(nodeB.id);
      assert.strictEqual(nodeB.name, 'b');
    });
  });
});
