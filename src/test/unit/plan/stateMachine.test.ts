/**
 * @fileoverview Unit tests for PlanStateMachine
 *
 * Tests cover:
 * - Node state transitions (valid and invalid)
 * - Plan status computation
 * - Duration / timestamp calculations
 * - Error state handling & dependency propagation
 * - Retry (resetNodeToPending) scenarios
 * - Concurrent node execution
 * - Event emissions
 */

import * as assert from 'assert';
import { PlanStateMachine } from '../../../plan/stateMachine';
import {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  NodeStatus,
  NodeTransitionEvent,
  PlanCompletionEvent,
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

function makeNode(
  id: string,
  deps: string[] = [],
  dependents: string[] = [],
): JobNode {
  return {
    id,
    producerId: id,
    name: id,
    type: 'job',
    task: `Task ${id}`,
    dependencies: deps,
    dependents,
  };
}

function makeState(status: NodeStatus = 'pending'): NodeExecutionState {
  return { status, version: 0, attempts: 0 };
}

/**
 * Build a minimal PlanInstance with the given topology.
 * Each entry in `topology` is `[nodeId, dependencyIds[]]`.
 * Dependents are computed automatically.
 */
function buildPlan(
  topology: Array<[string, string[]]>,
  overrides?: Partial<PlanInstance>,
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
    nodes.set(id, makeNode(id, deps, dependents));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('PlanStateMachine', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // Node state transitions
  // =========================================================================
  suite('Node state transitions', () => {
    test('valid transition: pending → ready', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.ok(sm.transition('a', 'ready'));
      assert.strictEqual(sm.getNodeStatus('a'), 'ready');
    });

    test('valid full lifecycle: pending → ready → scheduled → running → succeeded', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.ok(sm.transition('a', 'ready'));
      assert.ok(sm.transition('a', 'scheduled'));
      assert.ok(sm.transition('a', 'running'));
      assert.ok(sm.transition('a', 'succeeded'));
      assert.strictEqual(sm.getNodeStatus('a'), 'succeeded');
    });

    test('valid transition: pending → canceled', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.ok(sm.transition('a', 'canceled'));
      assert.strictEqual(sm.getNodeStatus('a'), 'canceled');
    });

    test('valid transition: running → failed', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      assert.ok(sm.transition('a', 'failed'));
      assert.strictEqual(sm.getNodeStatus('a'), 'failed');
    });

    test('invalid transition: pending → running is rejected', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.transition('a', 'running'), false);
      assert.strictEqual(sm.getNodeStatus('a'), 'pending');
    });

    test('invalid transition: succeeded → failed is rejected (terminal)', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(sm.transition('a', 'failed'), false);
      assert.strictEqual(sm.getNodeStatus('a'), 'succeeded');
    });

    test('transition on unknown node returns false', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.transition('unknown', 'ready'), false);
    });

    test('transition applies optional updates', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed', { error: 'boom' });
      assert.strictEqual(sm.getNodeState('a')!.error, 'boom');
    });
  });

  // =========================================================================
  // Automatic timestamp management
  // =========================================================================
  suite('Timestamp management', () => {
    test('scheduledAt is set when entering scheduled', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      const state = sm.getNodeState('a')!;
      assert.ok(state.scheduledAt, 'scheduledAt should be set');
      assert.strictEqual(typeof state.scheduledAt, 'number');
    });

    test('startedAt is set when entering running', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      const state = sm.getNodeState('a')!;
      assert.ok(state.startedAt, 'startedAt should be set');
    });

    test('endedAt is set when entering terminal state', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      const state = sm.getNodeState('a')!;
      assert.ok(state.endedAt, 'endedAt should be set');
    });

    test('timestamps are not overwritten if already set', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled', { scheduledAt: 42 });
      assert.strictEqual(sm.getNodeState('a')!.scheduledAt, 42);
    });
  });

  // =========================================================================
  // Plan status computation
  // =========================================================================
  suite('computePlanStatus', () => {
    test('all pending → pending', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.computePlanStatus(), 'pending');
    });

    test('one running → running', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      assert.strictEqual(sm.computePlanStatus(), 'running');
    });

    test('one scheduled → running', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      assert.strictEqual(sm.computePlanStatus(), 'running');
    });

    test('all succeeded → succeeded', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(sm.computePlanStatus(), 'succeeded');
    });

    test('all failed → failed', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.strictEqual(sm.computePlanStatus(), 'failed');
    });

    test('mixed succeeded and failed → partial', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      // a succeeds
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // b fails
      sm.transition('b', 'ready');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');
      assert.strictEqual(sm.computePlanStatus(), 'partial');
    });

    test('canceled → canceled', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'canceled');
      assert.strictEqual(sm.computePlanStatus(), 'canceled');
    });

    test('all blocked → failed', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      // b gets blocked automatically
      assert.strictEqual(sm.getNodeStatus('b'), 'blocked');
      assert.strictEqual(sm.computePlanStatus(), 'failed');
    });

    test('pending with startedAt → running', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      plan.startedAt = Date.now();
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.computePlanStatus(), 'running');
    });
  });

  // =========================================================================
  // Dependency management
  // =========================================================================
  suite('Dependency management', () => {
    test('areDependenciesMet returns true for root nodes', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.ok(sm.areDependenciesMet('a'));
    });

    test('areDependenciesMet returns false when dependency pending', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.areDependenciesMet('b'), false);
    });

    test('areDependenciesMet returns true when all deps succeeded', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.ok(sm.areDependenciesMet('b'));
    });

    test('areDependenciesMet returns false for unknown node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.areDependenciesMet('nope'), false);
    });

    test('hasDependencyFailed returns true when dep failed', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.ok(sm.hasDependencyFailed('b'));
    });

    test('hasDependencyFailed returns true when dep blocked', () => {
      const plan = buildPlan([['a', []], ['b', ['a']], ['c', ['b']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      // b gets blocked, so c's dependency (b) is blocked
      assert.ok(sm.hasDependencyFailed('c'));
    });

    test('hasDependencyFailed returns false for unknown node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.hasDependencyFailed('nope'), false);
    });
  });

  // =========================================================================
  // Side effects: dependency propagation
  // =========================================================================
  suite('Dependency propagation', () => {
    test('succeeding node transitions pending dependent to ready', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('b'), 'ready');
    });

    test('dependent stays pending when only some deps succeeded', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a', 'b']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // b still pending → c should still be pending
      assert.strictEqual(sm.getNodeStatus('c'), 'pending');
    });

    test('dependent becomes ready when all deps succeed', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a', 'b']]]);
      const sm = new PlanStateMachine(plan);
      // a succeeds
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // b succeeds
      sm.transition('b', 'ready');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('c'), 'ready');
    });

    test('failing node blocks downstream nodes', () => {
      const plan = buildPlan([['a', []], ['b', ['a']], ['c', ['b']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.strictEqual(sm.getNodeStatus('b'), 'blocked');
      assert.strictEqual(sm.getNodeStatus('c'), 'blocked');
    });

    test('blocked node has error message', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      const state = sm.getNodeState('b')!;
      assert.ok(state.error);
      assert.ok(state.error!.toLowerCase().includes('blocked'), `Expected error to contain 'blocked', got: ${state.error}`);
    });

    test('already-terminal nodes are not blocked', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a', 'b']]]);
      const sm = new PlanStateMachine(plan);
      // b succeeds first
      sm.transition('b', 'ready');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');
      // a fails — c gets blocked, b stays succeeded
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.strictEqual(sm.getNodeStatus('b'), 'succeeded');
      assert.strictEqual(sm.getNodeStatus('c'), 'blocked');
    });
  });

  // =========================================================================
  // Ready nodes
  // =========================================================================
  suite('getReadyNodes / getNodesByStatus', () => {
    test('getReadyNodes returns nodes in ready state', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      const ready = sm.getReadyNodes();
      assert.deepStrictEqual(ready, ['a']);
    });

    test('getNodesByStatus returns correct nodes', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('b', 'ready');
      const pending = sm.getNodesByStatus('pending');
      const ready = sm.getNodesByStatus('ready');
      assert.deepStrictEqual(pending, ['c']);
      assert.strictEqual(ready.length, 2);
      assert.ok(ready.includes('a'));
      assert.ok(ready.includes('b'));
    });
  });

  // =========================================================================
  // Status counts
  // =========================================================================
  suite('getStatusCounts', () => {
    test('returns correct counts for mixed states', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // c becomes ready automatically
      sm.transition('b', 'ready');
      const counts = sm.getStatusCounts();
      assert.strictEqual(counts.succeeded, 1);
      assert.strictEqual(counts.ready, 2); // b and c
      assert.strictEqual(counts.pending, 0);
    });
  });

  // =========================================================================
  // cancelAll
  // =========================================================================
  suite('cancelAll', () => {
    test('cancels all non-terminal nodes', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // c becomes ready, b is pending
      sm.cancelAll();
      assert.strictEqual(sm.getNodeStatus('a'), 'succeeded'); // terminal, untouched
      assert.strictEqual(sm.getNodeStatus('b'), 'canceled');
      assert.strictEqual(sm.getNodeStatus('c'), 'canceled');
    });
  });

  // =========================================================================
  // Duration / effective endedAt
  // =========================================================================
  suite('Duration calculations', () => {
    test('computeEffectiveEndedAt returns max endedAt across nodes', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      plan.nodeStates.get('a')!.endedAt = 5000;
      plan.nodeStates.get('b')!.endedAt = 9000;
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.computeEffectiveEndedAt(), 9000);
    });

    test('computeEffectiveEndedAt returns undefined when no nodes ended', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.computeEffectiveEndedAt(), undefined);
    });

    test('getEffectiveEndedAt falls back to plan.endedAt', () => {
      const plan = buildPlan([['a', []]]);
      plan.endedAt = 7777;
      // Put node in terminal state so computePlanStatus doesn't return 'pending'
      plan.nodeStates.get('a')!.status = 'succeeded';
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getEffectiveEndedAt(), 7777);
    });

    test('getEffectiveEndedAt prefers computed value over stored', () => {
      const plan = buildPlan([['a', []]]);
      plan.endedAt = 5000;
      plan.nodeStates.get('a')!.endedAt = 9000;
      // Put node in terminal state so computePlanStatus doesn't return 'pending'
      plan.nodeStates.get('a')!.status = 'succeeded';
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getEffectiveEndedAt(), 9000);
    });
  });

  // =========================================================================
  // Base commits
  // =========================================================================
  suite('getBaseCommitsForNode', () => {
    test('returns empty array for root nodes', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.deepStrictEqual(sm.getBaseCommitsForNode('a'), []);
    });

    test('returns completed commits from dependencies', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      plan.nodeStates.get('a')!.completedCommit = 'abc123';
      const sm = new PlanStateMachine(plan);
      assert.deepStrictEqual(sm.getBaseCommitsForNode('b'), ['abc123']);
    });

    test('returns multiple commits for multi-dep node', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a', 'b']]]);
      plan.nodeStates.get('a')!.completedCommit = 'sha-a';
      plan.nodeStates.get('b')!.completedCommit = 'sha-b';
      const sm = new PlanStateMachine(plan);
      const commits = sm.getBaseCommitsForNode('c');
      assert.strictEqual(commits.length, 2);
      assert.ok(commits.includes('sha-a'));
      assert.ok(commits.includes('sha-b'));
    });

    test('skips deps without completedCommit', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a', 'b']]]);
      plan.nodeStates.get('a')!.completedCommit = 'sha-a';
      // b has no completedCommit
      const sm = new PlanStateMachine(plan);
      assert.deepStrictEqual(sm.getBaseCommitsForNode('c'), ['sha-a']);
    });

    test('returns empty for unknown node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.deepStrictEqual(sm.getBaseCommitsForNode('nope'), []);
    });

    test('deprecated getBaseCommitForNode returns first commit', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      plan.nodeStates.get('a')!.completedCommit = 'abc123';
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getBaseCommitForNode('b'), 'abc123');
    });

    test('deprecated getBaseCommitForNode returns undefined for root', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getBaseCommitForNode('a'), undefined);
    });
  });

  // =========================================================================
  // Retry – resetNodeToPending
  // =========================================================================
  suite('Retry scenarios', () => {
    test('resetNodeToPending resets failed node to ready when deps met', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.ok(sm.resetNodeToPending('a'));
      // No deps → should be ready
      assert.strictEqual(sm.getNodeStatus('a'), 'ready');
    });

    test('resetNodeToPending resets to pending when deps not met', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      // Force b to failed without propagation for test
      plan.nodeStates.get('b')!.status = 'failed' as NodeStatus;
      assert.ok(sm.resetNodeToPending('b'));
      // a is still pending → deps not met → b should be pending
      assert.strictEqual(sm.getNodeStatus('b'), 'pending');
    });

    test('resetNodeToPending unblocks downstream nodes', () => {
      const plan = buildPlan([['a', []], ['b', ['a']], ['c', ['b']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      // b and c are now blocked
      assert.strictEqual(sm.getNodeStatus('b'), 'blocked');
      assert.strictEqual(sm.getNodeStatus('c'), 'blocked');
      // Reset a
      sm.resetNodeToPending('a');
      assert.strictEqual(sm.getNodeStatus('a'), 'ready'); // root, no deps
      assert.strictEqual(sm.getNodeStatus('b'), 'pending'); // unblocked
      assert.strictEqual(sm.getNodeStatus('c'), 'pending'); // unblocked recursively
    });

    test('resetNodeToPending returns false for unknown node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.resetNodeToPending('nope'), false);
    });

    test('retry full lifecycle: fail then reset and succeed', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      // First attempt: a fails
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      assert.strictEqual(sm.getNodeStatus('b'), 'blocked');
      // Retry a
      sm.resetNodeToPending('a');
      assert.strictEqual(sm.getNodeStatus('a'), 'ready');
      assert.strictEqual(sm.getNodeStatus('b'), 'pending');
      // Second attempt: a succeeds
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('b'), 'ready');
    });
  });

  // =========================================================================
  // Concurrent node execution
  // =========================================================================
  suite('Concurrent node execution', () => {
    test('multiple independent nodes can run concurrently', () => {
      const plan = buildPlan([['a', []], ['b', []], ['c', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('b', 'ready');
      sm.transition('c', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('b', 'scheduled');
      sm.transition('c', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('b', 'running');
      sm.transition('c', 'running');
      assert.strictEqual(sm.getNodeStatus('a'), 'running');
      assert.strictEqual(sm.getNodeStatus('b'), 'running');
      assert.strictEqual(sm.getNodeStatus('c'), 'running');
      assert.strictEqual(sm.computePlanStatus(), 'running');
    });

    test('plan completes only when all concurrent nodes finish', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('b', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('b', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('b', 'running');
      sm.transition('a', 'succeeded');
      // b still running
      assert.strictEqual(sm.computePlanStatus(), 'running');
      sm.transition('b', 'succeeded');
      assert.strictEqual(sm.computePlanStatus(), 'succeeded');
    });

    test('diamond dependency: c waits for both a and b', () => {
      // a ─┐
      //    ├─→ c
      // b ─┘
      const plan = buildPlan([['a', []], ['b', []], ['c', ['a', 'b']]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('b', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // c still pending (b not done)
      assert.strictEqual(sm.getNodeStatus('c'), 'pending');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');
      // Now c should be ready
      assert.strictEqual(sm.getNodeStatus('c'), 'ready');
    });
  });

  // =========================================================================
  // Event emission
  // =========================================================================
  suite('Event emission', () => {
    test('transition emits transition event with correct data', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const events: NodeTransitionEvent[] = [];
      sm.on('transition', (e: NodeTransitionEvent) => events.push(e));
      sm.transition('a', 'ready');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].planId, 'plan-1');
      assert.strictEqual(events[0].nodeId, 'a');
      assert.strictEqual(events[0].from, 'pending');
      assert.strictEqual(events[0].to, 'ready');
      assert.strictEqual(typeof events[0].timestamp, 'number');
    });

    test('nodeReady event emitted when dependent becomes ready', () => {
      const plan = buildPlan([['a', []], ['b', ['a']]]);
      const sm = new PlanStateMachine(plan);
      const readyEvents: Array<{ planId: string; nodeId: string }> = [];
      sm.on('nodeReady', (planId: string, nodeId: string) => {
        readyEvents.push({ planId, nodeId });
      });
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.ok(readyEvents.length > 0);
      assert.ok(readyEvents.some(e => e.nodeId === 'b'));
    });

    test('planComplete event emitted when all nodes terminal', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      const completionEvents: PlanCompletionEvent[] = [];
      sm.on('planComplete', (e: PlanCompletionEvent) => completionEvents.push(e));
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(completionEvents.length, 1);
      assert.strictEqual(completionEvents[0].status, 'succeeded');
    });

    test('planComplete not emitted while nodes still active', () => {
      const plan = buildPlan([['a', []], ['b', []]]);
      const sm = new PlanStateMachine(plan);
      const completionEvents: PlanCompletionEvent[] = [];
      sm.on('planComplete', (e: PlanCompletionEvent) => completionEvents.push(e));
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      // b still pending
      assert.strictEqual(completionEvents.length, 0);
    });

    test('resetNodeToPending emits transition event', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      const events: NodeTransitionEvent[] = [];
      sm.on('transition', (e: NodeTransitionEvent) => events.push(e));
      sm.resetNodeToPending('a');
      assert.ok(events.length > 0);
      assert.strictEqual(events[0].from, 'failed');
      assert.strictEqual(events[0].to, 'ready');
    });

    test('resetNodeToPending emits nodeReady when reset to ready', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'failed');
      const readyEvents: string[] = [];
      sm.on('nodeReady', (_planId: string, nodeId: string) => readyEvents.push(nodeId));
      sm.resetNodeToPending('a');
      assert.ok(readyEvents.includes('a'));
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  suite('Edge cases', () => {
    test('getNodeStatus returns undefined for unknown node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getNodeStatus('missing'), undefined);
    });

    test('getNodeState returns undefined for unknown node', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(sm.getNodeState('missing'), undefined);
    });

    test('single node plan: happy path completes plan', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      let completed = false;
      sm.on('planComplete', () => { completed = true; });
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.ok(completed);
      assert.strictEqual(sm.computePlanStatus(), 'succeeded');
    });

    test('plan endedAt is set when plan completes', () => {
      const plan = buildPlan([['a', []]]);
      const sm = new PlanStateMachine(plan);
      assert.strictEqual(plan.endedAt, undefined);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.ok(plan.endedAt, 'plan.endedAt should be set after completion');
    });

    test('deeply chained dependencies propagate correctly', () => {
      // a → b → c → d
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
        ['c', ['b']],
        ['d', ['c']],
      ]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('b'), 'ready');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('c'), 'ready');
      sm.transition('c', 'scheduled');
      sm.transition('c', 'running');
      sm.transition('c', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('d'), 'ready');
    });

    test('failing mid-chain blocks all downstream', () => {
      // a → b → c → d
      const plan = buildPlan([
        ['a', []],
        ['b', ['a']],
        ['c', ['b']],
        ['d', ['c']],
      ]);
      const sm = new PlanStateMachine(plan);
      sm.transition('a', 'ready');
      sm.transition('a', 'scheduled');
      sm.transition('a', 'running');
      sm.transition('a', 'succeeded');
      assert.strictEqual(sm.getNodeStatus('b'), 'ready');
      sm.transition('b', 'scheduled');
      sm.transition('b', 'running');
      sm.transition('b', 'failed');
      assert.strictEqual(sm.getNodeStatus('c'), 'blocked');
      assert.strictEqual(sm.getNodeStatus('d'), 'blocked');
    });
  });
});
