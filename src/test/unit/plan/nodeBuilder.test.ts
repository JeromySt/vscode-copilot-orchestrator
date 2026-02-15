/**
 * @fileoverview Unit tests for Node Builder (buildNodes)
 *
 * Tests cover:
 * - Building node instances from NodeSpec arrays
 * - Dependency resolution (producerId → UUID)
 * - Dependents computation (reverse edges)
 * - Root node detection (status = 'ready')
 * - Cycle detection
 * - Validation (missing producerId, duplicate IDs, unknown deps)
 * - Group assignment
 */

import * as assert from 'assert';
import { buildNodes, PlanValidationError } from '../../../plan/builder';
import type { NodeSpec, NodeInstance, GroupInfo } from '../../../plan/types';

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

function makeSpec(
  producerId: string,
  deps: string[] = [],
  overrides?: Partial<NodeSpec>,
): NodeSpec {
  return {
    producerId,
    task: `Task for ${producerId}`,
    dependencies: deps,
    ...overrides,
  };
}

function makeGroup(overrides?: Partial<GroupInfo>): GroupInfo {
  return {
    id: 'group-1',
    name: 'Test Group',
    baseBranch: 'main',
    maxParallel: 4,
    cleanUpSuccessfulWork: true,
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Node Builder (buildNodes)', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // BASIC BUILDING
  // =========================================================================
  suite('Basic building', () => {
    test('builds a single node', () => {
      const specs = [makeSpec('build')];
      const result = buildNodes(specs, { repoPath: '/repo' });

      assert.strictEqual(result.nodes.length, 1);
      const node = result.nodes[0];
      assert.strictEqual(node.producerId, 'build');
      assert.strictEqual(node.name, 'build');
      assert.strictEqual(node.task, 'Task for build');
      assert.strictEqual(node.status, 'ready');  // Root node
      assert.strictEqual(node.attempts, 0);
      assert.strictEqual(node.repoPath, '/repo');
      assert.deepStrictEqual(node.dependencies, []);
      assert.deepStrictEqual(node.dependents, []);
    });

    test('builds multiple independent nodes', () => {
      const specs = [makeSpec('build'), makeSpec('lint'), makeSpec('test')];
      const result = buildNodes(specs, { repoPath: '/repo' });

      assert.strictEqual(result.nodes.length, 3);
      // All are roots → 'ready'
      for (const node of result.nodes) {
        assert.strictEqual(node.status, 'ready');
        assert.deepStrictEqual(node.dependencies, []);
      }
    });

    test('uses custom name when provided', () => {
      const specs = [makeSpec('build', [], { name: 'Build Step' })];
      const result = buildNodes(specs);
      assert.strictEqual(result.nodes[0].name, 'Build Step');
    });

    test('carries work specs through', () => {
      const specs = [makeSpec('build', [], {
        work: 'npm run build',
        prechecks: 'npm run lint',
        postchecks: 'npm test',
        instructions: '# Build\n1. Run build',
      })];
      const result = buildNodes(specs);
      const node = result.nodes[0];
      assert.strictEqual(node.work, 'npm run build');
      assert.strictEqual(node.prechecks, 'npm run lint');
      assert.strictEqual(node.postchecks, 'npm test');
      assert.strictEqual(node.instructions, '# Build\n1. Run build');
    });
  });

  // =========================================================================
  // DEPENDENCY RESOLUTION
  // =========================================================================
  suite('Dependency resolution', () => {
    test('resolves dependencies by producerId', () => {
      const specs = [
        makeSpec('build', []),
        makeSpec('test', ['build']),
      ];
      const result = buildNodes(specs);

      const buildNode = result.nodes.find(n => n.producerId === 'build')!;
      const testNode = result.nodes.find(n => n.producerId === 'test')!;

      assert.strictEqual(testNode.dependencies.length, 1);
      assert.strictEqual(testNode.dependencies[0], buildNode.id);
    });

    test('computes dependents (reverse edges)', () => {
      const specs = [
        makeSpec('build', []),
        makeSpec('test', ['build']),
        makeSpec('deploy', ['test']),
      ];
      const result = buildNodes(specs);

      const buildNode = result.nodes.find(n => n.producerId === 'build')!;
      const testNode = result.nodes.find(n => n.producerId === 'test')!;
      const deployNode = result.nodes.find(n => n.producerId === 'deploy')!;

      assert.strictEqual(buildNode.dependents.length, 1);
      assert.strictEqual(buildNode.dependents[0], testNode.id);

      assert.strictEqual(testNode.dependents.length, 1);
      assert.strictEqual(testNode.dependents[0], deployNode.id);

      assert.strictEqual(deployNode.dependents.length, 0);
    });

    test('root nodes get ready status, non-roots get pending', () => {
      const specs = [
        makeSpec('build', []),
        makeSpec('test', ['build']),
      ];
      const result = buildNodes(specs);

      const buildNode = result.nodes.find(n => n.producerId === 'build')!;
      const testNode = result.nodes.find(n => n.producerId === 'test')!;

      assert.strictEqual(buildNode.status, 'ready');
      assert.strictEqual(testNode.status, 'pending');
    });

    test('handles diamond dependencies', () => {
      const specs = [
        makeSpec('build', []),
        makeSpec('lint', ['build']),
        makeSpec('test', ['build']),
        makeSpec('deploy', ['lint', 'test']),
      ];
      const result = buildNodes(specs);

      const deployNode = result.nodes.find(n => n.producerId === 'deploy')!;
      assert.strictEqual(deployNode.dependencies.length, 2);
      assert.strictEqual(deployNode.status, 'pending');
    });
  });

  // =========================================================================
  // GROUP ASSIGNMENT
  // =========================================================================
  suite('Group assignment', () => {
    test('assigns group to all nodes when provided', () => {
      const group = makeGroup();
      const specs = [makeSpec('build'), makeSpec('test')];
      const result = buildNodes(specs, { group });

      for (const node of result.nodes) {
        assert.ok(node.group);
        assert.strictEqual(node.group!.id, 'group-1');
        assert.strictEqual(node.group!.name, 'Test Group');
      }
      assert.deepStrictEqual(result.group, group);
    });

    test('nodes are ungrouped when no group provided', () => {
      const specs = [makeSpec('build')];
      const result = buildNodes(specs);

      assert.strictEqual(result.nodes[0].group, undefined);
      assert.strictEqual(result.group, undefined);
    });
  });

  // =========================================================================
  // VALIDATION
  // =========================================================================
  suite('Validation', () => {
    test('throws on empty specs', () => {
      assert.throws(
        () => buildNodes([]),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('at least one node')));
          return true;
        }
      );
    });

    test('throws on missing producerId', () => {
      const specs = [{ task: 'Build', dependencies: [] } as any];
      assert.throws(
        () => buildNodes(specs),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          return true;
        }
      );
    });

    test('throws on duplicate producerId', () => {
      const specs = [makeSpec('build'), makeSpec('build')];
      assert.throws(
        () => buildNodes(specs),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Duplicate')));
          return true;
        }
      );
    });

    test('throws on unknown dependency reference', () => {
      const specs = [makeSpec('test', ['nonexistent'])];
      assert.throws(
        () => buildNodes(specs),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('unknown dependency')));
          return true;
        }
      );
    });

    test('throws on circular dependency', () => {
      const specs = [
        makeSpec('aaa', ['bbb']),
        makeSpec('bbb', ['aaa']),
      ];
      assert.throws(
        () => buildNodes(specs),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Circular')));
          return true;
        }
      );
    });

    test('throws on three-node cycle', () => {
      const specs = [
        makeSpec('a', ['c']),
        makeSpec('b', ['a']),
        makeSpec('c', ['b']),
      ];
      assert.throws(
        () => buildNodes(specs),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Circular')));
          return true;
        }
      );
    });

    test('cycle error message includes producerId names', () => {
      const specs = [
        makeSpec('alpha', ['beta']),
        makeSpec('beta', ['alpha']),
      ];
      try {
        buildNodes(specs);
        assert.fail('should throw');
      } catch (err: any) {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details?.some((d: string) => d.includes('alpha') && d.includes('beta')));
      }
    });
  });

  suite('Edge cases', () => {
    test('handles empty producerId validation', () => {
      const specs = [makeSpec('')];
      assert.throws(
        () => buildNodes(specs),
        (err: any) => err instanceof PlanValidationError
      );
    });

    test('defaults repoPath to process.cwd()', () => {
      const specs = [makeSpec('build')];
      const result = buildNodes(specs);
      assert.strictEqual(result.nodes[0].repoPath, process.cwd());
    });

    test('passes repoPath option correctly', () => {
      const specs = [makeSpec('build')];
      const result = buildNodes(specs, { repoPath: '/custom/path' });
      assert.strictEqual(result.nodes[0].repoPath, '/custom/path');
    });

    test('passes group option correctly', () => {
      const group = {
        id: 'g1',
        name: 'Group1',
        baseBranch: 'main',
        maxParallel: 4,
        cleanUpSuccessfulWork: true,
        worktreeRoot: '/wt',
        createdAt: Date.now()
      };
      const specs = [makeSpec('build')];
      const result = buildNodes(specs, { group });
      assert.strictEqual(result.group, group);
      assert.strictEqual(result.nodes[0].group, group);
    });

    test('initializes node with correct defaults', () => {
      const specs = [makeSpec('build')];
      const result = buildNodes(specs);
      const node = result.nodes[0];
      assert.strictEqual(node.attempts, 0);
      assert.ok(node.id);
      assert.strictEqual(node.id.length, 36); // UUID length
    });

    test('properly handles node with all optional fields', () => {
      const specs = [makeSpec('build', [], {
        name: 'Custom Build',
        work: 'npm run build',
        prechecks: 'npm test',
        postchecks: 'npm run lint',
        instructions: 'Special instructions',
        baseBranch: 'develop'
      })];
      const result = buildNodes(specs);
      const node = result.nodes[0];
      assert.strictEqual(node.name, 'Custom Build');
      assert.strictEqual(node.work, 'npm run build');
      assert.strictEqual(node.prechecks, 'npm test');
      assert.strictEqual(node.postchecks, 'npm run lint');
      assert.strictEqual(node.instructions, 'Special instructions');
      assert.strictEqual(node.baseBranch, 'develop');
    });
  });
});
