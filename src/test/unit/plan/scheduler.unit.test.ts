/**
 * @fileoverview Unit tests for PlanScheduler
 */
import * as assert from 'assert';
import { PlanScheduler } from '../../../plan/scheduler';
import { PlanStateMachine } from '../../../plan/stateMachine';
import type { PlanInstance, JobNode, NodeExecutionState, PlanNode } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeNode(id: string, deps: string[] = [], dependents: string[] = []): JobNode {
  return {
    id, producerId: id, name: id, type: 'job', task: `Task ${id}`,
    work: { type: 'shell', command: 'echo test' },
    dependencies: deps, dependents,
  };
}

function makeState(status: string = 'pending'): NodeExecutionState {
  return { status: status as any, version: 0, attempts: 0 };
}

function buildPlan(
  topology: Array<[string, string[]]>,
  overrides?: Partial<PlanInstance>,
): PlanInstance {
  const nodes = new Map<string, PlanNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  const producerIdToNodeId = new Map<string, string>();
  const dependentsMap = new Map<string, string[]>();

  for (const [id] of topology) dependentsMap.set(id, []);
  for (const [id, deps] of topology) {
    for (const dep of deps) dependentsMap.get(dep)!.push(id);
  }

  const roots: string[] = [];
  const leaves: string[] = [];

  for (const [id, deps] of topology) {
    const dependents = dependentsMap.get(id) || [];
    nodes.set(id, makeNode(id, deps, dependents));
    nodeStates.set(id, makeState(deps.length === 0 ? 'ready' : 'pending'));
    producerIdToNodeId.set(id, id);
    if (deps.length === 0) roots.push(id);
    if (dependents.length === 0) leaves.push(id);
  }

  return {
    id: 'plan-1', spec: { name: 'Test Plan', jobs: [] }, nodes, producerIdToNodeId,
    roots, leaves, nodeStates, groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
    repoPath: '/repo', baseBranch: 'main', worktreeRoot: '/worktrees',
    createdAt: 1000, stateVersion: 0, cleanUpSuccessfulWork: true, maxParallel: 4,
    ...overrides,
  };
}

suite('PlanScheduler', () => {
  let quiet: { restore: () => void };
  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  test('constructor uses default globalMaxParallel', () => {
    const scheduler = new PlanScheduler();
    assert.strictEqual(scheduler.getGlobalMaxParallel(), 8);
  });

  test('constructor respects globalMaxParallel option', () => {
    const scheduler = new PlanScheduler({ globalMaxParallel: 16 });
    assert.strictEqual(scheduler.getGlobalMaxParallel(), 16);
  });

  test('setGlobalMaxParallel updates value', () => {
    const scheduler = new PlanScheduler();
    scheduler.setGlobalMaxParallel(32);
    assert.strictEqual(scheduler.getGlobalMaxParallel(), 32);
  });

  suite('selectNodes', () => {
    test('returns empty when no ready nodes', () => {
      const scheduler = new PlanScheduler();
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      plan.nodeStates.get('a')!.status = 'running';
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(result, []);
    });

    test('returns ready nodes up to capacity', () => {
      const scheduler = new PlanScheduler();
      const plan = buildPlan([['a', []], ['b', []], ['c', []]]);
      plan.maxParallel = 2;
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm);
      assert.strictEqual(result.length, 2);
    });

    test('respects plan maxParallel', () => {
      const scheduler = new PlanScheduler({ globalMaxParallel: 10 });
      const plan = buildPlan([['a', []], ['b', []], ['c', []]]);
      plan.maxParallel = 1;
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm);
      assert.strictEqual(result.length, 1);
    });

    test('respects global capacity', () => {
      const scheduler = new PlanScheduler({ globalMaxParallel: 1 });
      const plan = buildPlan([['a', []], ['b', []]]);
      plan.maxParallel = 10;
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm, 0);
      assert.strictEqual(result.length, 1);
    });

    test('returns empty when global capacity exhausted', () => {
      const scheduler = new PlanScheduler({ globalMaxParallel: 2 });
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm, 2);
      assert.deepStrictEqual(result, []);
    });

    test('returns empty when plan capacity exhausted', () => {
      const scheduler = new PlanScheduler();
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a']]]);
      plan.maxParallel = 2;
      plan.nodeStates.get('a')!.status = 'running';
      plan.nodeStates.get('b')!.status = 'running';
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(result, []);
    });

    test('prioritizes nodes with more dependents', () => {
      const scheduler = new PlanScheduler();
      // 'a' has 2 dependents, 'b' has 1 dependent, 'c' has 0
      const plan = buildPlan([['a', []], ['b', []], ['c', []], ['d', ['a']], ['e', ['a']], ['f', ['b']]]);
      plan.maxParallel = 2;
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm);
      assert.strictEqual(result.length, 2);
      // 'a' should come first (2 dependents)
      assert.strictEqual(result[0], 'a');
    });

    test('scheduled nodes count toward running capacity', () => {
      const scheduler = new PlanScheduler();
      const plan = buildPlan([['a', []], ['b', []], ['c', []]]);
      plan.maxParallel = 2;
      plan.nodeStates.get('a')!.status = 'scheduled';
      const sm = new PlanStateMachine(plan);
      const result = scheduler.selectNodes(plan, sm);
      assert.strictEqual(result.length, 1);
    });
  });
});
