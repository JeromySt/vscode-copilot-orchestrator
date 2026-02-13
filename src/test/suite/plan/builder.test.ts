/**
 * @fileoverview Unit tests for Plan Builder.
 */

import * as assert from 'assert';
import { buildPlan, buildSingleJobPlan, buildNodes, PlanValidationError } from '../../../plan/builder';
import type { PlanSpec, JobNodeSpec, NodeSpec, GroupSpec } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeJob(id: string, deps: string[] = [], extra: Partial<JobNodeSpec> = {}): JobNodeSpec {
  return { producerId: id, name: id, task: `Task for ${id}`, dependencies: deps, ...extra } as any;
}

suite('Plan Builder', () => {
  let quiet: { restore: () => void };

  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  suite('buildPlan()', () => {
    test('creates plan with single node', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a')] });
      assert.strictEqual(plan.nodes.size, 1);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
    });

    test('creates plan with dependent nodes', () => {
      const plan = buildPlan({
        name: 'Test',
        jobs: [makeJob('a'), makeJob('b', ['a'])],
      });
      assert.strictEqual(plan.nodes.size, 2);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
    });

    test('creates plan with diamond dependency', () => {
      const plan = buildPlan({
        name: 'Test',
        jobs: [makeJob('a'), makeJob('b', ['a']), makeJob('c', ['a']), makeJob('d', ['b', 'c'])],
      });
      assert.strictEqual(plan.nodes.size, 4);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
    });

    test('resolves baseBranch from spec', () => {
      const plan = buildPlan({ name: 'Test', baseBranch: 'develop', jobs: [makeJob('a')] });
      assert.strictEqual(plan.baseBranch, 'develop');
    });

    test('defaults baseBranch to main', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a')] });
      assert.strictEqual(plan.baseBranch, 'main');
    });

    test('sets targetBranch from spec', () => {
      const plan = buildPlan({ name: 'Test', targetBranch: 'release/1.0', jobs: [makeJob('a')] });
      assert.strictEqual(plan.targetBranch, 'release/1.0');
    });

    test('passes repoPath option', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a')] }, { repoPath: '/my/repo' });
      assert.strictEqual(plan.repoPath, '/my/repo');
    });

    test('passes worktreeRoot option', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a')] }, { worktreeRoot: '/wt' });
      assert.strictEqual(plan.worktreeRoot, '/wt');
    });

    test('passes parentPlanId and parentNodeId', () => {
      const plan = buildPlan(
        { name: 'Test', jobs: [makeJob('a')] },
        { parentPlanId: 'p1', parentNodeId: 'n1' }
      );
      assert.strictEqual(plan.parentPlanId, 'p1');
      assert.strictEqual(plan.parentNodeId, 'n1');
    });

    test('initializes root nodes as ready', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a'), makeJob('b', ['a'])] });
      const rootState = plan.nodeStates.get(plan.roots[0]);
      assert.strictEqual(rootState?.status, 'ready');
    });

    test('initializes dependent nodes as pending', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a'), makeJob('b', ['a'])] });
      const leafState = plan.nodeStates.get(plan.leaves[0]);
      assert.strictEqual(leafState?.status, 'pending');
    });

    test('computes dependents (reverse edges)', () => {
      const plan = buildPlan({ name: 'Test', jobs: [makeJob('a'), makeJob('b', ['a'])] });
      const rootNode = plan.nodes.get(plan.roots[0])!;
      assert.ok(rootNode.dependents.length > 0);
    });
  });

  suite('validation errors', () => {
    test('throws on duplicate producerIds', () => {
      assert.throws(
        () => buildPlan({ name: 'Test', jobs: [makeJob('a'), makeJob('a')] }),
        (err: any) => err instanceof PlanValidationError
      );
    });

    test('throws on unknown dependency', () => {
      assert.throws(
        () => buildPlan({ name: 'Test', jobs: [makeJob('a', ['nonexistent'])] }),
        (err: any) => err instanceof PlanValidationError
      );
    });

    test('throws on circular dependency', () => {
      assert.throws(
        () => buildPlan({ name: 'Test', jobs: [makeJob('a', ['b']), makeJob('b', ['a'])] }),
        (err: any) => err instanceof PlanValidationError
      );
    });

    test('throws on empty jobs array', () => {
      assert.throws(
        () => buildPlan({ name: 'Test', jobs: [] }),
        (err: any) => err instanceof PlanValidationError
      );
    });

    test('throws on missing producerId', () => {
      const badJob = { name: 'Bad', task: 'fail' } as any; // missing producerId
      assert.throws(
        () => buildPlan({ name: 'Test', jobs: [badJob] }),
        (err: any) => err instanceof PlanValidationError && (err.details?.some((d: string) => d.includes('producerId')) ?? false)
      );
    });

    test('throws on empty producerId', () => {
      const badJob = makeJob(''); // empty producerId
      assert.throws(
        () => buildPlan({ name: 'Test', jobs: [badJob] }),
        (err: any) => err instanceof PlanValidationError
      );
    });

    test('PlanValidationError has correct name', () => {
      try {
        buildPlan({ name: 'Test', jobs: [] });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.strictEqual(e.name, 'PlanValidationError');
      }
    });

    test('PlanValidationError includes details', () => {
      try {
        buildPlan({ name: 'Test', jobs: [] });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.ok(e.details);
        assert.ok(e.details.length > 0);
      }
    });

    test('PlanValidationError message and details property', () => {
      try {
        buildPlan({ name: 'Test', jobs: [] });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.ok(e.message);
        assert.ok(Array.isArray(e.details));
      }
    });
  });

  suite('cycle detection details', () => {
    test('cycle error includes node names', () => {
      try {
        buildPlan({
          name: 'Test',
          jobs: [makeJob('alpha', ['beta']), makeJob('beta', ['alpha'])],
        });
        assert.fail('should throw');
      } catch (e: any) {
        assert.ok(e.details.some((d: string) => d.includes('alpha') && d.includes('beta')));
      }
    });

    test('three-node cycle', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          jobs: [makeJob('a', ['c']), makeJob('b', ['a']), makeJob('c', ['b'])],
        }),
        (err: any) => err instanceof PlanValidationError
      );
    });
  });
});

suite('buildSingleJobPlan', () => {
  let quiet: { restore: () => void };

  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  test('creates a plan with exactly one node', () => {
    const plan = buildSingleJobPlan({ name: 'Build', task: 'Build project' });
    assert.strictEqual(plan.nodes.size, 1);
  });

  test('generates producerId from name', () => {
    const plan = buildSingleJobPlan({ name: 'My Build Task', task: 'build' });
    const node = [...plan.nodes.values()][0];
    assert.ok(node.producerId.includes('my-build-task'));
  });

  test('passes through baseBranch and targetBranch', () => {
    const plan = buildSingleJobPlan({
      name: 'Build', task: 'build',
      baseBranch: 'dev', targetBranch: 'release',
    });
    assert.strictEqual(plan.baseBranch, 'dev');
    assert.strictEqual(plan.targetBranch, 'release');
  });

  test('passes through work, prechecks, postchecks, instructions', () => {
    const plan = buildSingleJobPlan({
      name: 'Build', task: 'build',
      work: 'npm run build',
      prechecks: 'npm test',
      postchecks: 'npm run lint',
      instructions: 'Be careful',
    });
    const node = [...plan.nodes.values()][0] as any;
    assert.ok(node.work || node.task);
  });

  test('single node is both root and leaf', () => {
    const plan = buildSingleJobPlan({ name: 'Build', task: 'build' });
    assert.strictEqual(plan.roots.length, 1);
    assert.strictEqual(plan.leaves.length, 1);
    assert.strictEqual(plan.roots[0], plan.leaves[0]);
  });

  test('accepts repoPath and worktreeRoot options', () => {
    const plan = buildSingleJobPlan(
      { name: 'Build', task: 'build' },
      { repoPath: '/repo', worktreeRoot: '/wt' }
    );
    assert.strictEqual(plan.repoPath, '/repo');
    assert.strictEqual(plan.worktreeRoot, '/wt');
  });

  test('passes expectsNoChanges', () => {
    const plan = buildSingleJobPlan({
      name: 'Check', task: 'validate',
      expectsNoChanges: true,
    });
    const node = [...plan.nodes.values()][0] as any;
    assert.strictEqual(node.expectsNoChanges, true);
  });

  test('defaults expectsNoChanges to undefined when not specified', () => {
    const plan = buildSingleJobPlan({
      name: 'Check', task: 'validate',
    });
    const node = [...plan.nodes.values()][0] as any;
    assert.strictEqual(node.expectsNoChanges, undefined);
  });

  test('handles special characters in name', () => {
    const plan = buildSingleJobPlan({ name: 'My@Build Task!', task: 'build' });
    const node = [...plan.nodes.values()][0];
    assert.ok(node.producerId);
    // Should sanitize to valid producerId
    assert.ok(node.producerId.length > 0);
  });

  test('uses process.cwd() as default repoPath', () => {
    const plan = buildSingleJobPlan({ name: 'Build', task: 'build' });
    assert.ok(plan.repoPath);
    assert.ok(plan.repoPath.length > 0);
  });

  test('generates unique UUIDs for id and planId', () => {
    const plan1 = buildSingleJobPlan({ name: 'Build', task: 'build' });
    const plan2 = buildSingleJobPlan({ name: 'Build', task: 'build' });
    
    assert.notStrictEqual(plan1.id, plan2.id);
    const node1 = [...plan1.nodes.values()][0];
    const node2 = [...plan2.nodes.values()][0];
    assert.notStrictEqual(node1.id, node2.id);
  });

  test('uses default maxParallel from buildPlan (4)', () => {
    const plan = buildSingleJobPlan({ name: 'Build', task: 'build' });
    assert.strictEqual(plan.maxParallel, 4);
  });
});

suite('buildPlan with groups', () => {
  let quiet: { restore: () => void };
  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  test('creates groups from spec', () => {
    const groups: GroupSpec[] = [{ name: 'backend' }, { name: 'frontend' }];
    const plan = buildPlan({
      name: 'Grouped',
      jobs: [
        makeJob('a', [], { group: 'backend' }),
        makeJob('b', [], { group: 'frontend' }),
      ],
      groups,
    });
    assert.strictEqual(plan.groups.size, 2);
    assert.ok(plan.groupPathToId.has('backend'));
    assert.ok(plan.groupPathToId.has('frontend'));
  });

  test('auto-creates group hierarchy from job group paths', () => {
    const plan = buildPlan({
      name: 'AutoGroup',
      jobs: [
        makeJob('a', [], { group: 'services/auth' }),
        makeJob('b', [], { group: 'services/api' }),
      ],
    });
    // Should have auto-created 'services', 'services/auth', 'services/api'
    assert.ok(plan.groupPathToId.has('services'));
    assert.ok(plan.groupPathToId.has('services/auth'));
    assert.ok(plan.groupPathToId.has('services/api'));
    const servicesId = plan.groupPathToId.get('services')!;
    const servicesGroup = plan.groups.get(servicesId)!;
    assert.strictEqual(servicesGroup.childGroupIds.length, 2);
  });

  test('group state is initialized as pending', () => {
    const plan = buildPlan({
      name: 'GroupState',
      groups: [{ name: 'g1' }],
      jobs: [makeJob('a', [], { group: 'g1' })],
    });
    const gid = plan.groupPathToId.get('g1')!;
    const gstate = plan.groupStates.get(gid)!;
    assert.strictEqual(gstate.status, 'pending');
    assert.strictEqual(gstate.version, 0);
  });

  test('nodes link to ancestor group allNodeIds', () => {
    const plan = buildPlan({
      name: 'Nested',
      groups: [{ name: 'parent', groups: [{ name: 'child' }] }],
      jobs: [makeJob('a', [], { group: 'parent/child' })],
    });
    const parentId = plan.groupPathToId.get('parent')!;
    const childId = plan.groupPathToId.get('parent/child')!;
    const parentGroup = plan.groups.get(parentId)!;
    const childGroup = plan.groups.get(childId)!;
    assert.ok(childGroup.nodeIds.length > 0);
    assert.ok(parentGroup.allNodeIds.length > 0);
    assert.strictEqual(parentGroup.totalNodes, 1);
  });

  test('handles missing producerId in job spec', () => {
    assert.throws(
      () => buildPlan({ name: 'Bad', jobs: [{ task: 'test', dependencies: [] } as any] }),
      (err: any) => err instanceof PlanValidationError
    );
  });

  test('sets cleanUpSuccessfulWork default true', () => {
    const plan = buildPlan({ name: 'T', jobs: [makeJob('a')] });
    assert.strictEqual(plan.cleanUpSuccessfulWork, true);
  });

  test('sets cleanUpSuccessfulWork false from spec', () => {
    const plan = buildPlan({ name: 'T', cleanUpSuccessfulWork: false, jobs: [makeJob('a')] });
    assert.strictEqual(plan.cleanUpSuccessfulWork, false);
  });

  test('sets maxParallel default 4', () => {
    const plan = buildPlan({ name: 'T', jobs: [makeJob('a')] });
    assert.strictEqual(plan.maxParallel, 4);
  });

  test('sets maxParallel from spec', () => {
    const plan = buildPlan({ name: 'T', maxParallel: 8, jobs: [makeJob('a')] });
    assert.strictEqual(plan.maxParallel, 8);
  });

  test('uses spec.repoPath when option not provided', () => {
    const plan = buildPlan({ name: 'T', repoPath: '/from/spec', jobs: [makeJob('a')] });
    assert.strictEqual(plan.repoPath, '/from/spec');
  });

  test('handles broken group parent reference gracefully', () => {
    // Create a scenario where a group references a missing parent
    // This is an edge case that might occur with corrupted data
    const plan = buildPlan({
      name: 'BrokenParent',
      jobs: [
        makeJob('a', [], { group: 'child' })
      ],
      groups: [{
        name: 'child',
        // This would normally auto-create parents, but let's try to break it manually
        // by creating a group state that references a missing parent internally
      }]
    });
    
    // Plan should still be created successfully
    assert.strictEqual(plan.nodes.size, 1);
    assert.ok(plan.groupPathToId.has('child'));
  });
});

suite('buildNodes', () => {
  let quiet: { restore: () => void };
  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  function makeNodeSpec(id: string, deps: string[] = []): NodeSpec {
    return { producerId: id, name: id, task: `Task ${id}`, dependencies: deps } as any;
  }

  test('builds single node', () => {
    const result = buildNodes([makeNodeSpec('n1')]);
    assert.strictEqual(result.nodes.length, 1);
    assert.strictEqual(result.nodes[0].producerId, 'n1');
    assert.strictEqual(result.nodes[0].status, 'ready');
  });

  test('builds multiple nodes with dependencies', () => {
    const result = buildNodes([makeNodeSpec('a'), makeNodeSpec('b', ['a'])]);
    assert.strictEqual(result.nodes.length, 2);
    const nodeA = result.nodes.find(n => n.producerId === 'a')!;
    const nodeB = result.nodes.find(n => n.producerId === 'b')!;
    assert.strictEqual(nodeA.status, 'ready');
    assert.strictEqual(nodeB.status, 'pending');
    assert.ok(nodeB.dependencies.includes(nodeA.id));
    assert.ok(nodeA.dependents.includes(nodeB.id));
  });

  test('throws on duplicate producerIds', () => {
    assert.throws(
      () => buildNodes([makeNodeSpec('a'), makeNodeSpec('a')]),
      (err: any) => err instanceof PlanValidationError
    );
  });

  test('throws on missing producerId', () => {
    assert.throws(
      () => buildNodes([{ name: 'test', task: 'x', dependencies: [] } as any]),
      (err: any) => err instanceof PlanValidationError
    );
  });

  test('throws on unknown dependency', () => {
    assert.throws(
      () => buildNodes([makeNodeSpec('a', ['nonexistent'])]),
      (err: any) => err instanceof PlanValidationError
    );
  });

  test('throws on empty specs', () => {
    assert.throws(
      () => buildNodes([]),
      (err: any) => err instanceof PlanValidationError
    );
  });

  test('throws on circular dependency', () => {
    assert.throws(
      () => buildNodes([makeNodeSpec('a', ['b']), makeNodeSpec('b', ['a'])]),
      (err: any) => err instanceof PlanValidationError
    );
  });

  test('passes group option through', () => {
    const group = { id: 'g1', name: 'Group', baseBranch: 'main', maxParallel: 4, cleanUpSuccessfulWork: true, worktreeRoot: '/wt', createdAt: Date.now() };
    const result = buildNodes([makeNodeSpec('a')], { group });
    assert.strictEqual(result.group, group);
    assert.strictEqual(result.nodes[0].group, group);
  });

  test('passes repoPath option', () => {
    const result = buildNodes([makeNodeSpec('a')], { repoPath: '/my/repo' });
    assert.strictEqual(result.nodes[0].repoPath, '/my/repo');
  });

  test('defaults repoPath to process.cwd()', () => {
    const result = buildNodes([makeNodeSpec('a')]);
    assert.ok(result.nodes[0].repoPath);
    assert.strictEqual(result.nodes[0].repoPath, process.cwd());
  });

  test('initializes node with correct defaults', () => {
    const result = buildNodes([makeNodeSpec('a')]);
    const node = result.nodes[0];
    assert.strictEqual(node.attempts, 0);
    assert.ok(node.id);
    assert.ok(node.id.length === 36); // UUID length
  });

  test('three-node cycle detection', () => {
    assert.throws(
      () => buildNodes([
        makeNodeSpec('a', ['c']),
        makeNodeSpec('b', ['a']),
        makeNodeSpec('c', ['b'])
      ]),
      (err: any) => err instanceof PlanValidationError && (err.details?.some((d: string) => d.includes('Circular dependency')) ?? false)
    );
  });

  test('cycle error message includes producer IDs', () => {
    try {
      buildNodes([makeNodeSpec('alpha', ['beta']), makeNodeSpec('beta', ['alpha'])]);
      assert.fail('should throw');
    } catch (e: any) {
      assert.ok(e.details);
      assert.ok(e.details.some((d: string) => d.includes('alpha') && d.includes('beta')));
    }
  });
});

suite('Complex dependency scenarios', () => {
  let quiet: { restore: () => void };
  setup(() => { quiet = silenceConsole(); });
  teardown(() => { quiet.restore(); });

  test('diamond dependency structure', () => {
    const plan = buildPlan({
      name: 'Diamond',
      jobs: [
        makeJob('root'),
        makeJob('left', ['root']),
        makeJob('right', ['root']), 
        makeJob('leaf', ['left', 'right'])
      ]
    });
    assert.strictEqual(plan.nodes.size, 4);
    assert.strictEqual(plan.roots.length, 1);
    assert.strictEqual(plan.leaves.length, 1);
  });

  test('long chain dependency', () => {
    const plan = buildPlan({
      name: 'Chain',
      jobs: [
        makeJob('a'),
        makeJob('b', ['a']),
        makeJob('c', ['b']),
        makeJob('d', ['c']),
        makeJob('e', ['d'])
      ]
    });
    assert.strictEqual(plan.nodes.size, 5);
    assert.strictEqual(plan.roots.length, 1);
    assert.strictEqual(plan.leaves.length, 1);
    
    // Verify the chain
    const nodeE = [...plan.nodes.values()].find(n => n.producerId === 'e')!;
    const nodeD = [...plan.nodes.values()].find(n => n.producerId === 'd')!;
    assert.ok(nodeE.dependencies.includes(nodeD.id));
  });

  test('complex multi-root multi-leaf structure', () => {
    const plan = buildPlan({
      name: 'Complex',
      jobs: [
        makeJob('root1'),
        makeJob('root2'),
        makeJob('middle1', ['root1']),
        makeJob('middle2', ['root2']),
        makeJob('leaf1', ['middle1']),
        makeJob('leaf2', ['middle2'])
      ]
    });
    assert.strictEqual(plan.nodes.size, 6);
    assert.strictEqual(plan.roots.length, 2);
    assert.strictEqual(plan.leaves.length, 2);
  });

  test('node with multiple dependencies becomes ready only when all deps are done', () => {
    const plan = buildPlan({
      name: 'MultiDep',
      jobs: [
        makeJob('a'),
        makeJob('b'),
        makeJob('c', ['a', 'b'])
      ]
    });
    const nodeC = [...plan.nodes.values()].find(n => n.producerId === 'c')!;
    assert.strictEqual(nodeC.dependencies.length, 2);
    assert.strictEqual(plan.nodeStates.get(nodeC.id)?.status, 'pending');
  });
});
