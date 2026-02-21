/**
 * @fileoverview Unit tests for DAG utilities
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

suite('dagUtils', () => {
  suite('detectCycles', () => {
    test('should detect no cycle in acyclic graph', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['b'] }
      ];
      
      const result = detectCycles(jobs);
      assert.strictEqual(result, null);
    });

    test('should detect simple cycle', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['b'] },
        { producerId: 'b', dependencies: ['a'] }
      ];
      
      const result = detectCycles(jobs);
      assert.ok(result);
      assert.ok(result!.includes('Circular dependency'));
      assert.ok(result!.includes('a'));
      assert.ok(result!.includes('b'));
    });

    test('should detect self-reference cycle', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['a'] }
      ];
      
      const result = detectCycles(jobs);
      assert.ok(result);
      assert.ok(result!.includes('Circular dependency'));
    });

    test('should detect cycle in complex graph', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['b'] },
        { producerId: 'd', dependencies: ['c', 'a'] },
        { producerId: 'e', dependencies: ['d'] },
        { producerId: 'f', dependencies: ['e', 'b'] }
      ];
      
      // No cycle
      assert.strictEqual(detectCycles(jobs), null);
      
      // Add cycle
      jobs[1].dependencies.push('d');
      const result = detectCycles(jobs);
      assert.ok(result);
      assert.ok(result!.includes('Circular dependency'));
    });
  });

  suite('computeRootsAndLeaves', () => {
    test('should identify roots and leaves in simple graph', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['a'] }
      ];
      
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots, ['a']);
      assert.deepStrictEqual(leaves.sort(), ['b', 'c'].sort());
    });

    test('should handle multiple roots', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: [] },
        { producerId: 'c', dependencies: ['a', 'b'] }
      ];
      
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots.sort(), ['a', 'b'].sort());
      assert.deepStrictEqual(leaves, ['c']);
    });

    test('should handle single node as both root and leaf', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] }
      ];
      
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots, ['a']);
      assert.deepStrictEqual(leaves, ['a']);
    });

    test('should handle diamond graph', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['a'] },
        { producerId: 'd', dependencies: ['b', 'c'] }
      ];
      
      const { roots, leaves } = computeRootsAndLeaves(jobs);
      assert.deepStrictEqual(roots, ['a']);
      assert.deepStrictEqual(leaves, ['d']);
    });
  });

  suite('validateAllDepsExist', () => {
    test('should pass for valid dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['b'] }
      ];
      
      assert.doesNotThrow(() => validateAllDepsExist(jobs));
    });

    test('should throw for unknown dependency', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['unknown'] }
      ];
      
      assert.throws(
        () => validateAllDepsExist(jobs),
        /unknown dependency/i
      );
    });

    test('should throw for multiple unknown dependencies', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: ['x'] },
        { producerId: 'b', dependencies: ['y'] }
      ];
      
      assert.throws(
        () => validateAllDepsExist(jobs),
        (err: any) => {
          return err.message.includes('x') && err.message.includes('y');
        }
      );
    });
  });

  suite('computeDependents', () => {
    test('should compute reverse edges', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['a'] }
      ];
      
      const dependents = computeDependents(jobs);
      assert.deepStrictEqual(dependents.get('a')?.sort(), ['b', 'c'].sort());
      assert.deepStrictEqual(dependents.get('b'), []);
      assert.deepStrictEqual(dependents.get('c'), []);
    });

    test('should handle multiple dependents per node', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: ['a'] },
        { producerId: 'c', dependencies: ['b'] },
        { producerId: 'd', dependencies: ['b'] }
      ];
      
      const dependents = computeDependents(jobs);
      assert.deepStrictEqual(dependents.get('a'), ['b']);
      assert.deepStrictEqual(dependents.get('b')?.sort(), ['c', 'd'].sort());
      assert.deepStrictEqual(dependents.get('c'), []);
      assert.deepStrictEqual(dependents.get('d'), []);
    });

    test('should initialize empty arrays for all nodes', () => {
      const jobs: DagJob[] = [
        { producerId: 'a', dependencies: [] },
        { producerId: 'b', dependencies: [] }
      ];
      
      const dependents = computeDependents(jobs);
      assert.ok(dependents.has('a'));
      assert.ok(dependents.has('b'));
      assert.deepStrictEqual(dependents.get('a'), []);
      assert.deepStrictEqual(dependents.get('b'), []);
    });
  });
});
