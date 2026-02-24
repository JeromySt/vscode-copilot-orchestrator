/**
 * @fileoverview Unit tests for worktree cleanup logic
 *
 * Tests the "consumption acknowledgment" model where worktrees are cleaned up
 * as soon as all consumers have consumed (FI'd from) the node's output,
 * rather than waiting for consumers to fully succeed.
 *
 * Key behaviors:
 * - consumedByDependents tracking
 * - allConsumersConsumed logic
 * - Leaf node cleanup after RI merge
 * - Non-leaf node cleanup after all dependents FI
 */

import * as assert from 'assert';
import {
  PlanInstance,
  JobNode,
  NodeExecutionState,
} from '../../../plan/types';

// ---------------------------------------------------------------------------
// Mock helpers - we test the logic in isolation without full PlanRunner
// ---------------------------------------------------------------------------

/**
 * Check if all consumers have consumed a node's output.
 * This mirrors the logic from PlanRunner.allConsumersConsumed()
 */
function allConsumersConsumed(
  plan: { targetBranch?: string; leaves: string[] },
  node: { dependents: string[] },
  state: { mergedToTarget?: boolean; consumedByDependents?: string[] }
): boolean {
  // Leaf nodes (no DAG dependents) - consumer is the targetBranch
  if (node.dependents.length === 0) {
    // No target branch = no consumer = safe to cleanup
    if (!plan.targetBranch) {
      return true;
    }
    // Has target branch - check if merge succeeded
    return state.mergedToTarget === true;
  }

  // Non-leaf nodes - consumers are dependents
  // Check if all dependents have acknowledged consumption (completed FI)
  const consumedBy = state.consumedByDependents || [];
  return node.dependents.every(depId => consumedBy.includes(depId));
}

/**
 * Acknowledge consumption - adds consumer to dependency's consumedByDependents
 */
function acknowledgeConsumption(
  consumerNode: { id: string; dependencies: string[] },
  nodeStates: Map<string, { consumedByDependents?: string[]; mergedToTarget?: boolean }>
): void {
  for (const depId of consumerNode.dependencies) {
    const depState = nodeStates.get(depId);
    if (depState) {
      if (!depState.consumedByDependents) {
        depState.consumedByDependents = [];
      }
      if (!depState.consumedByDependents.includes(consumerNode.id)) {
        depState.consumedByDependents.push(consumerNode.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Worktree Cleanup Logic', () => {
  suite('allConsumersConsumed', () => {
    test('leaf node with no targetBranch is ready for cleanup immediately', () => {
      const plan = { targetBranch: undefined, leaves: ['a'] };
      const node = { dependents: [] };
      const state = {};

      assert.strictEqual(allConsumersConsumed(plan, node, state), true);
    });

    test('leaf node with targetBranch waits for mergedToTarget', () => {
      const plan = { targetBranch: 'main', leaves: ['a'] };
      const node = { dependents: [] };

      // Not merged yet
      assert.strictEqual(allConsumersConsumed(plan, node, {}), false);
      assert.strictEqual(allConsumersConsumed(plan, node, { mergedToTarget: false }), false);

      // Merged
      assert.strictEqual(allConsumersConsumed(plan, node, { mergedToTarget: true }), true);
    });

    test('non-leaf node waits for all dependents to consume', () => {
      const plan = { targetBranch: 'main', leaves: ['c'] };
      const node = { dependents: ['b', 'c'] };

      // No consumers yet
      assert.strictEqual(allConsumersConsumed(plan, node, {}), false);

      // Only one consumer
      assert.strictEqual(
        allConsumersConsumed(plan, node, { consumedByDependents: ['b'] }),
        false
      );

      // All consumers
      assert.strictEqual(
        allConsumersConsumed(plan, node, { consumedByDependents: ['b', 'c'] }),
        true
      );

      // Order doesn't matter
      assert.strictEqual(
        allConsumersConsumed(plan, node, { consumedByDependents: ['c', 'b'] }),
        true
      );
    });

    test('non-leaf with single dependent', () => {
      const plan = { targetBranch: 'main', leaves: ['b'] };
      const node = { dependents: ['b'] };

      assert.strictEqual(allConsumersConsumed(plan, node, {}), false);
      assert.strictEqual(
        allConsumersConsumed(plan, node, { consumedByDependents: ['b'] }),
        true
      );
    });
  });

  suite('acknowledgeConsumption', () => {
    test('adds consumer to single dependency', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[] }>([
        ['a', {}],
      ]);
      const consumer = { id: 'b', dependencies: ['a'] };

      acknowledgeConsumption(consumer, nodeStates);

      assert.deepStrictEqual(nodeStates.get('a')?.consumedByDependents, ['b']);
    });

    test('adds consumer to multiple dependencies', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[] }>([
        ['a', {}],
        ['b', {}],
      ]);
      const consumer = { id: 'c', dependencies: ['a', 'b'] };

      acknowledgeConsumption(consumer, nodeStates);

      assert.deepStrictEqual(nodeStates.get('a')?.consumedByDependents, ['c']);
      assert.deepStrictEqual(nodeStates.get('b')?.consumedByDependents, ['c']);
    });

    test('multiple consumers accumulate', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[] }>([
        ['a', {}],
      ]);

      acknowledgeConsumption({ id: 'b', dependencies: ['a'] }, nodeStates);
      acknowledgeConsumption({ id: 'c', dependencies: ['a'] }, nodeStates);

      assert.deepStrictEqual(nodeStates.get('a')?.consumedByDependents, ['b', 'c']);
    });

    test('duplicate acknowledgment is idempotent', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[] }>([
        ['a', {}],
      ]);

      acknowledgeConsumption({ id: 'b', dependencies: ['a'] }, nodeStates);
      acknowledgeConsumption({ id: 'b', dependencies: ['a'] }, nodeStates);

      assert.deepStrictEqual(nodeStates.get('a')?.consumedByDependents, ['b']);
    });

    test('handles unknown dependency gracefully', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[] }>();
      const consumer = { id: 'b', dependencies: ['unknown'] };

      // Should not throw
      acknowledgeConsumption(consumer, nodeStates);
    });
  });

  suite('Cleanup timeline scenarios', () => {
    test('diamond DAG: A->B, A->C, B->D, C->D - A cleaned after B and C FI', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[] }>([
        ['a', {}],
        ['b', {}],
        ['c', {}],
        ['d', {}],
      ]);

      const nodeA = { dependents: ['b', 'c'] };
      const plan = { targetBranch: 'main', leaves: ['d'] };

      // A not ready yet
      assert.strictEqual(allConsumersConsumed(plan, nodeA, nodeStates.get('a')!), false);

      // B consumes A (FI completes)
      acknowledgeConsumption({ id: 'b', dependencies: ['a'] }, nodeStates);
      assert.strictEqual(allConsumersConsumed(plan, nodeA, nodeStates.get('a')!), false);

      // C consumes A (FI completes) - now A can be cleaned
      acknowledgeConsumption({ id: 'c', dependencies: ['a'] }, nodeStates);
      assert.strictEqual(allConsumersConsumed(plan, nodeA, nodeStates.get('a')!), true);
    });

    test('chain: A->B->C - each cleaned in order as next FIs', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[]; mergedToTarget?: boolean }>([
        ['a', {}],
        ['b', {}],
        ['c', { mergedToTarget: true }], // C is leaf, merged
      ]);

      const nodeA = { dependents: ['b'] };
      const nodeB = { dependents: ['c'] };
      const nodeC = { dependents: [] }; // leaf
      const plan = { targetBranch: 'main', leaves: ['c'] };

      // Initial state
      assert.strictEqual(allConsumersConsumed(plan, nodeA, nodeStates.get('a')!), false);
      assert.strictEqual(allConsumersConsumed(plan, nodeB, nodeStates.get('b')!), false);
      assert.strictEqual(allConsumersConsumed(plan, nodeC, nodeStates.get('c')!), true); // leaf merged

      // B consumes A
      acknowledgeConsumption({ id: 'b', dependencies: ['a'] }, nodeStates);
      assert.strictEqual(allConsumersConsumed(plan, nodeA, nodeStates.get('a')!), true);
      assert.strictEqual(allConsumersConsumed(plan, nodeB, nodeStates.get('b')!), false);

      // C consumes B
      acknowledgeConsumption({ id: 'c', dependencies: ['b'] }, nodeStates);
      assert.strictEqual(allConsumersConsumed(plan, nodeB, nodeStates.get('b')!), true);
    });

    test('parallel leaves: A->B, A->C (both leaves)', () => {
      const nodeStates = new Map<string, { consumedByDependents?: string[]; mergedToTarget?: boolean }>([
        ['a', {}],
        ['b', { mergedToTarget: true }],
        ['c', { mergedToTarget: false }],
      ]);

      const nodeA = { dependents: ['b', 'c'] };
      const nodeB = { dependents: [] }; // leaf
      const nodeC = { dependents: [] }; // leaf
      const plan = { targetBranch: 'main', leaves: ['b', 'c'] };

      // B merged, C not yet
      assert.strictEqual(allConsumersConsumed(plan, nodeB, nodeStates.get('b')!), true);
      assert.strictEqual(allConsumersConsumed(plan, nodeC, nodeStates.get('c')!), false);

      // B and C both FI from A
      acknowledgeConsumption({ id: 'b', dependencies: ['a'] }, nodeStates);
      acknowledgeConsumption({ id: 'c', dependencies: ['a'] }, nodeStates);

      // A can be cleaned once both consumers FI (regardless of their merge status)
      assert.strictEqual(allConsumersConsumed(plan, nodeA, nodeStates.get('a')!), true);
    });
  });

  suite('consumedByDependents persistence', () => {
    test('array format is JSON serializable', () => {
      const state = { consumedByDependents: ['a', 'b', 'c'] };
      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed.consumedByDependents, ['a', 'b', 'c']);
    });

    test('empty array serializes correctly', () => {
      const state = { consumedByDependents: [] };
      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed.consumedByDependents, []);
    });

    test('undefined consumedByDependents is omitted from JSON', () => {
      const state: { consumedByDependents?: string[] } = {};
      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.consumedByDependents, undefined);
    });
  });
});
