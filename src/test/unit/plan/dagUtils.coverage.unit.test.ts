/**
 * @fileoverview Additional coverage tests for dagUtils (src/plan/dagUtils.ts)
 * 
 * Covers edge cases and additional scenarios not in dagUtils.unit.test.ts.
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import {
  detectCycles,
  computeRootsAndLeaves,
  validateAllDepsExist,
  computeDependents,
  type DagJob
} from '../../../plan/dagUtils';

suite('dagUtils - Coverage', () => {
  suite('detectCycles - additional cases', () => {
    test('handles empty job list', () => {
      const jobs: DagJob[] = [];
      assert.strictEqual(detectCycles(jobs), null);
    });

    test('handles single node with no dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] }
      ];
      assert.strictEqual(detectCycles(jobs), null);
    });

    test('detects three-node cycle', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['b'] },
        { producerId: 'b', dependencies: ['c'] },
        { producerId: 'c', dependencies: ['a'] }
      ];
      const result = detectCycles(jobs);
      assert.ok(result);
      assert.ok(result!.includes('Circular dependency'));
    });

    test('handles multiple independent chains', () => {
      const jobs: DagJob[] = [
        { producerId: 'a1', dependencies: [] },
        { producerId: 'a2', dependencies: ['a1'] },
        { producerId: 'b1', dependencies: [] },
        { producerId: 'b2', dependencies: ['b1'] }
      ];
      assert.strictEqual(detectCycles(jobs), null);
    });

    test('detects cycle in second chain when first is clean', () => {
      const jobs: DagJob[] = [
        { producerId: 'a1', dependencies: [] },
        { producerId: 'a2', dependencies: ['a1'] },
        { producerId: 'b1', dependencies: ['b2'] },
        { producerId: 'b2', dependencies: ['b1'] }
      ];
      const result = detectCycles(jobs);
      assert.ok(result);
      assert.ok(result!.includes('Circular'));
    });

    test('handles node with reference to non-existent dependency (no cycle)', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['missing'] }
      ];
      // detectCycles only checks for cycles, not existence
      assert.strictEqual(detectCycles(jobs), null);
    });
  });

  suite('computeRootsAndLeaves - additional cases', () => {
    test('handles empty job list', () => {
      const jobs: DagJob[] = [];
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots, []);
      assert.deepStrictEqual(leaves, []);
    });

    test('handles all nodes as roots', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: [] },
        { producerId: 'c', dependencies: [] }
      ];
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.strictEqual(roots.length, 3);
      assert.strictEqual(leaves.length, 3);
      assert.ok(roots.includes('a'));
      assert.ok(roots.includes('b'));
      assert.ok(roots.includes('c'));
    });

    test('handles linear chain', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['b'] },
        { producerId: 'd', dependencies: ['c'] }
      ];
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots, ['a']);
      assert.deepStrictEqual(leaves, ['d']);
    });

    test('handles wide graph (many leaves)', () => {
      const jobs: DagJob[] = [
        { producerId: 'root', dependencies: [] },
        { producerId: 'leaf1', dependencies: ['root'] },
        { producerId: 'leaf2', dependencies: ['root'] },
        { producerId: 'leaf3', dependencies: ['root'] },
        { producerId: 'leaf4', dependencies: ['root'] }
      ];
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots, ['root']);
      assert.strictEqual(leaves.length, 4);
      assert.ok(leaves.includes('leaf1'));
      assert.ok(leaves.includes('leaf4'));
    });

    test('handles node that depends on multiple parents', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: [] },
        { producerId: 'c', dependencies: ['a', 'b'] }
      ];
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.strictEqual(roots.length, 2);
      assert.deepStrictEqual(leaves, ['c']);
    });
  });

  suite('validateAllDepsExist - additional cases', () => {
    test('passes for empty job list', () => {
      const jobs: DagJob[] = [];
      assert.doesNotThrow(() => validateAllDepsExist(jobs));
    });

    test('passes for single node with no dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] }
      ];
      assert.doesNotThrow(() => validateAllDepsExist(jobs));
    });

    test('passes for complex valid graph', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['a', 'b'] },
        { producerId: 'd', dependencies: ['c'] }
      ];
      assert.doesNotThrow(() => validateAllDepsExist(jobs));
    });

    test('throws with descriptive message for single missing dep', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['missing'] }
      ];
      assert.throws(
        () => validateAllDepsExist(jobs),
        (err: any) => {
          return err.message.includes("Job 'b'") && err.message.includes("'missing'");
        }
      );
    });

    test('throws listing all invalid dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['x'] },
        { producerId: 'b', dependencies: ['y', 'z'] }
      ];
      assert.throws(
        () => validateAllDepsExist(jobs),
        (err: any) => {
          return err.message.includes('x') && 
                 err.message.includes('y') && 
                 err.message.includes('z');
        }
      );
    });

    test('handles job referencing itself (not an existence error)', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['a'] }
      ];
      // Self-reference exists, so validation passes (cycle detection is separate)
      assert.doesNotThrow(() => validateAllDepsExist(jobs));
    });
  });

  suite('computeDependents - additional cases', () => {
    test('handles empty job list', () => {
      const jobs: DagJob[] = [];
      const dependents = computeDependents(jobs);
      assert.strictEqual(dependents.size, 0);
    });

    test('handles single node with no dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] }
      ];
      const dependents = computeDependents(jobs);
      assert.strictEqual(dependents.size, 1);
      assert.deepStrictEqual(dependents.get('a'), []);
    });

    test('handles linear chain', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['b'] }
      ];
      const dependents = computeDependents(jobs);
      assert.deepStrictEqual(dependents.get('a'), ['b']);
      assert.deepStrictEqual(dependents.get('b'), ['c']);
      assert.deepStrictEqual(dependents.get('c'), []);
    });

    test('handles diamond graph dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['a'] },
        { producerId: 'd', dependencies: ['b', 'c'] }
      ];
      const dependents = computeDependents(jobs);
      assert.strictEqual(dependents.get('a')!.length, 2);
      assert.ok(dependents.get('a')!.includes('b'));
      assert.ok(dependents.get('a')!.includes('c'));
      assert.deepStrictEqual(dependents.get('b'), ['d']);
      assert.deepStrictEqual(dependents.get('c'), ['d']);
      assert.deepStrictEqual(dependents.get('d'), []);
    });

    test('handles multiple consumers of same node', () => {
      const jobs: DagJob[] = [
        { producerId: 'shared', dependencies: [] },
        { producerId: 'consumer1', dependencies: ['shared'] },
        { producerId: 'consumer2', dependencies: ['shared'] },
        { producerId: 'consumer3', dependencies: ['shared'] }
      ];
      const dependents = computeDependents(jobs);
      assert.strictEqual(dependents.get('shared')!.length, 3);
      assert.ok(dependents.get('shared')!.includes('consumer1'));
      assert.ok(dependents.get('shared')!.includes('consumer2'));
      assert.ok(dependents.get('shared')!.includes('consumer3'));
    });

    test('handles job with reference to non-existent dependency', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['missing'] }
      ];
      const dependents = computeDependents(jobs);
      // 'missing' doesn't exist, so it won't have an entry
      assert.strictEqual(dependents.has('missing'), false);
      assert.deepStrictEqual(dependents.get('a'), []);
      assert.deepStrictEqual(dependents.get('b'), []);
    });

    test('initializes all nodes even if they have no dependents', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: [] },
        { producerId: 'c', dependencies: [] }
      ];
      const dependents = computeDependents(jobs);
      assert.strictEqual(dependents.size, 3);
      assert.ok(dependents.has('a'));
      assert.ok(dependents.has('b'));
      assert.ok(dependents.has('c'));
    });
  });
});
