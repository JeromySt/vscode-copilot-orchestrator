/**
 * @fileoverview Unit tests for PlanScheduler
 *
 * Tests cover:
 * - Single job scheduling
 * - Multiple parallel jobs
 * - Jobs with dependencies (dependency resolution)
 * - MaxParallel enforcement (plan-level and global)
 * - Priority ordering (nodes with more dependents first)
 * - Cancel behavior (cancelled / blocked nodes excluded)
 * - Sub-plan coordination nodes (don't consume execution slots)
 * - Edge cases (empty plans, unknown nodes, all slots used)
 */

import * as assert from 'assert';
import { PlanScheduler } from '../../../plan/scheduler';
import { PlanStateMachine } from '../../../plan/stateMachine';
import {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  NodeStatus,
  PlanSpec,
} from '../../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
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
  hasWork: boolean = true,
): JobNode {
  const node: JobNode = {
    id,
    producerId: id,
    name: id,
    type: 'job',
    task: `Task ${id}`,
    dependencies: deps,
    dependents,
  };
  if (hasWork) {
    node.work = `@agent implement ${id}`;
  }
  return node;
}

function makeState(status: NodeStatus = 'pending'): NodeExecutionState {
  return { status, version: 0, attempts: 0 };
}

/**
 * Build a minimal PlanInstance with the given topology.
 * Each entry is `[nodeId, dependencyIds[], options?]`.
 * Dependents are computed automatically.
 */
function buildPlan(
  topology: Array<[string, string[]]>,
  overrides?: Partial<PlanInstance>,
  nodeFactory?: (id: string, deps: string[], dependents: string[]) => PlanNode,
): PlanInstance {
  const nodes = new Map<string, PlanNode>();
  const nodeStates = new Map<string, NodeExecutionState>();
  const producerIdToNodeId = new Map<string, string>();
  const dependentsMap = new Map<string, string[]>();

  for (const [id] of topology) {
    dependentsMap.set(id, []);
  }

  for (const [id, deps] of topology) {
    for (const dep of deps) {
      dependentsMap.get(dep)!.push(id);
    }
  }

  const roots: string[] = [];
  const leaves: string[] = [];

  for (const [id, deps] of topology) {
    const dependents = dependentsMap.get(id) || [];
    const factory = nodeFactory || makeJobNode;
    nodes.set(id, factory(id, deps, dependents));
    nodeStates.set(id, makeState());
    producerIdToNodeId.set(id, id);
    if (deps.length === 0) {roots.push(id);}
    if (dependents.length === 0) {leaves.push(id);}
  }

  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    nodes,
    producerIdToNodeId,
    roots,
    leaves,
    nodeStates,
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: 1000,
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
    ...overrides,
  };
}

/**
 * Transition root nodes to 'ready' so the scheduler can pick them.
 */
function readyRoots(plan: PlanInstance, sm: PlanStateMachine): void {
  for (const rootId of plan.roots) {
    sm.transition(rootId, 'ready');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('PlanScheduler', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // Construction & configuration
  // =========================================================================
  suite('Construction & configuration', () => {
    test('defaults globalMaxParallel to 8', () => {
      const scheduler = new PlanScheduler();
      assert.strictEqual(scheduler.getGlobalMaxParallel(), 8);
    });

    test('accepts custom globalMaxParallel', () => {
      const scheduler = new PlanScheduler({ globalMaxParallel: 3 });
      assert.strictEqual(scheduler.getGlobalMaxParallel(), 3);
    });

    test('setGlobalMaxParallel updates the value', () => {
      const scheduler = new PlanScheduler();
      scheduler.setGlobalMaxParallel(2);
      assert.strictEqual(scheduler.getGlobalMaxParallel(), 2);
    });
  });

  // =========================================================================
  // Single job scheduling
  // =========================================================================
  suite('Single job scheduling', () => {
    test('selects a single ready node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, ['a']);
    });

    test('returns empty array when no nodes are ready', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      // 'a' is still pending
      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, []);
    });

    test('does not re-select a node that is already running', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');

      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, []);
    });

    test('does not select succeeded nodes', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, []);
    });
  });

  // =========================================================================
  // Multiple parallel jobs
  // =========================================================================
  suite('Multiple parallel jobs', () => {
    test('selects all ready independent nodes within limits', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 3);
      assert.ok(selected.includes('a'));
      assert.ok(selected.includes('b'));
      assert.ok(selected.includes('c'));
    });

    test('selects remaining ready nodes after some finish', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
      ], { maxParallel: 1 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // First round: only 1 slot
      const first = scheduler.selectNodes(plan, sm);
      assert.strictEqual(first.length, 1);

      // Transition that node through to succeeded
      sm.transition(first[0], 'scheduled');
      sm.transition(first[0], 'running');
      sm.transition(first[0], 'succeeded');

      // Second round: slot freed
      const second = scheduler.selectNodes(plan, sm);
      assert.strictEqual(second.length, 1);
    });
  });

  // =========================================================================
  // MaxParallel enforcement
  // =========================================================================
  suite('MaxParallel enforcement', () => {
    test('respects plan-level maxParallel', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
        ['d', []],
      ], { maxParallel: 2 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 10 });

      readyRoots(plan, sm);

      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 2);
    });

    test('respects global maxParallel', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
      ], { maxParallel: 10 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 2 });

      readyRoots(plan, sm);

      // 1 already running globally
      const selected = scheduler.selectNodes(plan, sm, 1);
      assert.strictEqual(selected.length, 1);
    });

    test('uses the minimum of plan and global limits', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
        ['d', []],
        ['e', []],
      ], { maxParallel: 3 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 2 });

      readyRoots(plan, sm);

      const selected = scheduler.selectNodes(plan, sm, 0);
      assert.strictEqual(selected.length, 2); // global limit wins
    });

    test('returns empty when plan slots are full', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
      ], { maxParallel: 2 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Schedule and run 2 nodes to fill plan slots
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');

      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 0);
    });

    test('returns empty when global slots are full', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
      ], { maxParallel: 10 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 5 });

      readyRoots(plan, sm);

      // All 5 global slots occupied externally
      const selected = scheduler.selectNodes(plan, sm, 5);
      assert.strictEqual(selected.length, 0);
    });

    test('counts scheduled nodes towards plan capacity', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
      ], { maxParallel: 2 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // 'a' is scheduled (not yet running), still counts
      sm.transition('a', 'scheduled');

      // Only 1 slot left because 'a' is scheduled
      // But 'a' is no longer 'ready', so scheduler picks from b, c
      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 1);
    });

    test('frees slots when nodes reach terminal state', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
      ], { maxParallel: 1 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Run and fail 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      // Slot should be free now
      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 1);
    });
  });

  // =========================================================================
  // Dependency resolution
  // =========================================================================
  suite('Dependency resolution', () => {
    test('only selects nodes whose dependencies are met', () => {
      // a -> b (b depends on a)
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Only 'a' is ready; 'b' is pending
      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, ['a']);
    });

    test('selects dependent node after dependency succeeds', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Complete 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // 'b' should now be ready (state machine promotes it)
      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, ['b']);
    });

    test('does not select node when only some dependencies are met', () => {
      // a, b -> c (c depends on both a and b)
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', ['a', 'b']],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Complete only 'a'
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // 'c' should NOT be selected because 'b' hasn't succeeded
      const selected = scheduler.selectNodes(plan, sm);
      assert.ok(!selected.includes('c'));
      assert.ok(selected.includes('b'));
    });

    test('handles diamond dependency graph', () => {
      //   a
      //  / \
      // b   c
      //  \ /
      //   d
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
        ['c', ['a']],
        ['d', ['b', 'c']],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Round 1: only a
      let selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, ['a']);

      // Complete a -> b and c become ready
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // Round 2: b and c
      selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 2);
      assert.ok(selected.includes('b'));
      assert.ok(selected.includes('c'));

      // Complete b and c -> d becomes ready
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');
      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'succeeded');

      // Round 3: d
      selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, ['d']);
    });

    test('handles chain dependency (a -> b -> c)', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
        ['c', ['b']],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Round 1
      assert.deepStrictEqual(scheduler.selectNodes(plan, sm), ['a']);

      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');

      // Round 2
      assert.deepStrictEqual(scheduler.selectNodes(plan, sm), ['b']);

      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');

      // Round 3
      assert.deepStrictEqual(scheduler.selectNodes(plan, sm), ['c']);
    });
  });

  // =========================================================================
  // Priority handling
  // =========================================================================
  suite('Priority handling', () => {
    test('prioritizes nodes with more dependents', () => {
      // a has 2 dependents (c, d), b has 1 dependent (d)
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', ['a']],
        ['d', ['a', 'b']],
      ], { maxParallel: 1 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // 'a' has 2 dependents (c, d), 'b' has 1 (d) → 'a' first
      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 1);
      assert.strictEqual(selected[0], 'a');
    });

    test('selects highest-priority nodes first when limited by maxParallel', () => {
      // x has 3 dependents, y has 1, z has 0
      const plan = buildPlan([
        ['x', []],
        ['y', []],
        ['z', []],
        ['d1', ['x']],
        ['d2', ['x']],
        ['d3', ['x']],
        ['d4', ['y']],
      ], { maxParallel: 2 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 2);
      // x has 3 dependents → first, y has 1 → second, z has 0 → excluded
      assert.strictEqual(selected[0], 'x');
      assert.strictEqual(selected[1], 'y');
    });
  });

  // =========================================================================
  // Cancel / blocked behavior
  // =========================================================================
  suite('Cancel / blocked behavior', () => {
    test('does not select canceled nodes', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);
      sm.transition('a', 'canceled');

      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, ['b']);
    });

    test('does not select blocked nodes', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Fail 'a' → 'b' gets blocked by state machine
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');

      assert.strictEqual(sm.getNodeStatus('b'), 'blocked');
      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 0);
    });
  });

  // =========================================================================
  // Nodes without work
  // =========================================================================
  suite('Nodes without work', () => {
    test('job nodes without work spec do not consume slots', () => {
      // A job node created without work={...}
      const plan = buildPlan(
        [
          ['nowork', []],
          ['real1', []],
          ['real2', []],
        ],
        { maxParallel: 2 },
        (id, deps, dependents) => makeJobNode(id, deps, dependents, id !== 'nowork'),
      );

      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Mark nowork as running
      sm.transition('nowork', 'scheduled');
      sm.transition('nowork', 'running');

      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 2);
      assert.ok(selected.includes('real1'));
      assert.ok(selected.includes('real2'));
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  suite('Edge cases', () => {
    test('handles plan with no nodes', () => {
      const plan = buildPlan([]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      const selected = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(selected, []);
    });

    test('handles globalMaxParallel of 0', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 0 });

      readyRoots(plan, sm);

      // globalMaxParallel 0 falls back to default 8 due to || operator
      // This is the actual behavior: 0 is falsy, so || 8 applies
      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 1);
    });

    test('currentGlobalRunning defaults to 0', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 1 });

      readyRoots(plan, sm);

      // Without passing currentGlobalRunning, defaults to 0
      const selected = scheduler.selectNodes(plan, sm);
      assert.strictEqual(selected.length, 1);
    });

    test('many ready nodes with limited global capacity', () => {
      const topology: Array<[string, string[]]> = [];
      for (let i = 0; i < 20; i++) {
        topology.push([`n${i}`, []]);
      }
      const plan = buildPlan(topology, { maxParallel: 20 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 5 });

      readyRoots(plan, sm);

      const selected = scheduler.selectNodes(plan, sm, 0);
      assert.strictEqual(selected.length, 5);
    });

    test('setGlobalMaxParallel takes effect on next selectNodes call', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', []],
      ], { maxParallel: 10 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler({ globalMaxParallel: 1 });

      readyRoots(plan, sm);

      assert.strictEqual(scheduler.selectNodes(plan, sm).length, 1);

      scheduler.setGlobalMaxParallel(3);
      // Re-ready the remaining nodes (the first call doesn't change state)
      const selected = scheduler.selectNodes(plan, sm);
      // First selectNodes picked 1, but state machine doesn't transition them
      // so all 3 are still ready
      assert.strictEqual(selected.length, 3);
    });
  });

  // =========================================================================
  // Timing and ordering
  // =========================================================================
  suite('Timing and ordering', () => {
    test('scheduling across multiple pump cycles preserves correct order', () => {
      // a -> b -> c, with maxParallel=1
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
        ['c', ['b']],
      ], { maxParallel: 1 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      const executionOrder: string[] = [];

      readyRoots(plan, sm);

      // Simulate pump cycles
      for (let cycle = 0; cycle < 3; cycle++) {
        const selected = scheduler.selectNodes(plan, sm);
        for (const nodeId of selected) {
          executionOrder.push(nodeId);
          sm.transition(nodeId, 'scheduled');
          sm.transition(nodeId, 'running');
          sm.transition(nodeId, 'succeeded');
        }
      }

      assert.deepStrictEqual(executionOrder, ['a', 'b', 'c']);
    });

    test('parallel execution with staggered completion', () => {
      // a, b independent; c depends on a; d depends on b
      const plan = buildPlan([
        ['a', []],
        ['b', []],
        ['c', ['a']],
        ['d', ['b']],
      ], { maxParallel: 2 });
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      // Cycle 1: a and b selected
      const cycle1 = scheduler.selectNodes(plan, sm);
      assert.strictEqual(cycle1.length, 2);

      // Start both
      for (const id of cycle1) {
        sm.transition(id, 'scheduled');
        sm.transition(id, 'running');
      }

      // 'a' finishes first
      sm.transition('a', 'succeeded');

      // Cycle 2: c becomes ready (a done), b still running
      const cycle2 = scheduler.selectNodes(plan, sm);
      assert.strictEqual(cycle2.length, 1);
      assert.strictEqual(cycle2[0], 'c');

      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');

      // 'b' finishes
      sm.transition('b', 'succeeded');

      // Cycle 3: d becomes ready
      const cycle3 = scheduler.selectNodes(plan, sm);
      assert.strictEqual(cycle3.length, 1);
      assert.strictEqual(cycle3[0], 'd');
    });

    test('multiple selectNodes calls without state change return same result', () => {
      const plan = buildPlan([
        ['a', []],
        ['b', []],
      ]);
      const sm = new PlanStateMachine(plan);
      const scheduler = new PlanScheduler();

      readyRoots(plan, sm);

      const first = scheduler.selectNodes(plan, sm);
      const second = scheduler.selectNodes(plan, sm);
      assert.deepStrictEqual(first, second);
    });
  });
});
