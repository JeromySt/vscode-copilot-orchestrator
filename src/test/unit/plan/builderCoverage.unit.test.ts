/**
 * @fileoverview Additional unit tests for builder.ts to achieve 95% coverage.
 * 
 * Covers:
 * - 0-job plans (SV as sole root+leaf)
 * - SV node added to roots when dependencies.length === 0
 * - Group auto-creation hierarchy
 * - Cycle detection edge cases
 * - Duplicate producerId validation
 * - verifyRiSpec pass-through
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { buildPlan, buildNodes, PlanValidationError } from '../../../plan/builder';
import type { PlanSpec, JobNodeSpec, NodeSpec } from '../../../plan/types';

const SV_PRODUCER_ID = '__snapshot-validation__';

function makeJob(id: string, deps: string[] = [], extra: Partial<JobNodeSpec> = {}): JobNodeSpec {
  return { producerId: id, name: id, task: `Task for ${id}`, dependencies: deps, ...extra } as any;
}

suite('Builder Coverage Tests', () => {
  suite('0-job plans', () => {
    test('0-job plan has exactly 1 node (SV)', () => {
      const spec: PlanSpec = { name: 'Empty', baseBranch: 'main', jobs: [] };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.jobs.size, 1);
      assert.ok(plan.producerIdToNodeId.has(SV_PRODUCER_ID));
    });

    test('SV is both root and leaf in 0-job plan', () => {
      const spec: PlanSpec = { name: 'Empty', baseBranch: 'main', jobs: [] };
      const plan = buildPlan(spec);
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      
      assert.deepStrictEqual(plan.roots, [svId], 'SV should be the only root');
      assert.deepStrictEqual(plan.leaves, [svId], 'SV should be the only leaf');
    });

    test('SV node status is ready in 0-job plan', () => {
      const spec: PlanSpec = { name: 'Empty', baseBranch: 'main', jobs: [] };
      const plan = buildPlan(spec);
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const state = plan.nodeStates.get(svId)!;
      
      assert.strictEqual(state.status, 'ready', 'SV node should be ready when it has no dependencies');
    });

    test('SV has no dependencies in 0-job plan', () => {
      const spec: PlanSpec = { name: 'Empty', baseBranch: 'main', jobs: [] };
      const plan = buildPlan(spec);
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const svNode = plan.jobs.get(svId)!;
      
      assert.deepStrictEqual(svNode.dependencies, []);
    });
  });

  suite('SV node roots array addition', () => {
    test('SV is added to roots when dependencies.length === 0', () => {
      // 0-job plan: SV has no deps, so it's added to roots
      const plan = buildPlan({ name: 'Test', baseBranch: 'main', jobs: [] });
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      
      assert.ok(plan.roots.includes(svId), 'SV should be in roots array');
    });

    test('SV is NOT in roots when it has dependencies', () => {
      // Plan with jobs: SV depends on leaves, so it's NOT a root
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [makeJob('a')],
      });
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const aId = plan.producerIdToNodeId.get('a')!;
      
      // 'a' is the root, SV is not
      assert.ok(plan.roots.includes(aId), 'Job a should be a root');
      assert.ok(!plan.roots.includes(svId), 'SV should NOT be a root when it has dependencies');
    });
  });

  suite('Group auto-creation hierarchy', () => {
    test('auto-creates single-level group from job group path', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [makeJob('a', [], { group: 'backend' })],
      });
      
      assert.ok(plan.groupPathToId.has('backend'));
      const groupId = plan.groupPathToId.get('backend')!;
      const group = plan.groups.get(groupId)!;
      assert.strictEqual(group.name, 'backend');
      assert.strictEqual(group.path, 'backend');
      assert.strictEqual(group.parentGroupId, undefined);
    });

    test('auto-creates multi-level group hierarchy from job group path', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [makeJob('a', [], { group: 'services/auth/oauth' })],
      });
      
      // All three levels should be created
      assert.ok(plan.groupPathToId.has('services'));
      assert.ok(plan.groupPathToId.has('services/auth'));
      assert.ok(plan.groupPathToId.has('services/auth/oauth'));
      
      // Parent-child relationships
      const servicesId = plan.groupPathToId.get('services')!;
      const authId = plan.groupPathToId.get('services/auth')!;
      const oauthId = plan.groupPathToId.get('services/auth/oauth')!;
      
      const servicesGroup = plan.groups.get(servicesId)!;
      const authGroup = plan.groups.get(authId)!;
      const oauthGroup = plan.groups.get(oauthId)!;
      
      assert.strictEqual(servicesGroup.parentGroupId, undefined);
      assert.strictEqual(authGroup.parentGroupId, servicesId);
      assert.strictEqual(oauthGroup.parentGroupId, authId);
      
      // childGroupIds should be populated
      assert.ok(servicesGroup.childGroupIds.includes(authId));
      assert.ok(authGroup.childGroupIds.includes(oauthId));
    });

    test('multiple jobs share auto-created parent group', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [
          makeJob('a', [], { group: 'services/api' }),
          makeJob('b', [], { group: 'services/web' }),
        ],
      });
      
      // 'services' should be auto-created once, shared by both
      const servicesId = plan.groupPathToId.get('services')!;
      const apiId = plan.groupPathToId.get('services/api')!;
      const webId = plan.groupPathToId.get('services/web')!;
      
      const servicesGroup = plan.groups.get(servicesId)!;
      assert.strictEqual(servicesGroup.childGroupIds.length, 2);
      assert.ok(servicesGroup.childGroupIds.includes(apiId));
      assert.ok(servicesGroup.childGroupIds.includes(webId));
    });

    test('group allNodeIds includes nodes from all descendants', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [
          makeJob('a', [], { group: 'parent/child' }),
          makeJob('b', [], { group: 'parent' }),
        ],
      });
      
      const parentId = plan.groupPathToId.get('parent')!;
      const childId = plan.groupPathToId.get('parent/child')!;
      const parentGroup = plan.groups.get(parentId)!;
      const childGroup = plan.groups.get(childId)!;
      
      // Child group has 1 node (a)
      assert.strictEqual(childGroup.nodeIds.length, 1);
      assert.strictEqual(childGroup.totalNodes, 1);
      
      // Parent group has 'b' directly, and 'a' through allNodeIds
      assert.strictEqual(parentGroup.nodeIds.length, 1); // just 'b'
      assert.strictEqual(parentGroup.allNodeIds.length, 2); // 'a' + 'b'
      assert.strictEqual(parentGroup.totalNodes, 2);
    });

    test('group state is initialized correctly for auto-created groups', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [makeJob('a', [], { group: 'auto/created' })],
      });
      
      const autoId = plan.groupPathToId.get('auto')!;
      const createdId = plan.groupPathToId.get('auto/created')!;
      
      const autoState = plan.groupStates.get(autoId)!;
      const createdState = plan.groupStates.get(createdId)!;
      
      for (const state of [autoState, createdState]) {
        assert.strictEqual(state.status, 'pending');
        assert.strictEqual(state.version, 0);
        assert.strictEqual(state.runningCount, 0);
        assert.strictEqual(state.succeededCount, 0);
        assert.strictEqual(state.failedCount, 0);
        assert.strictEqual(state.blockedCount, 0);
        assert.strictEqual(state.canceledCount, 0);
      }
    });

    test('does not duplicate parent in childGroupIds when multiple jobs share hierarchy', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [
          makeJob('a', [], { group: 'shared/leaf' }),
          makeJob('b', [], { group: 'shared/leaf' }),
        ],
      });
      
      const sharedId = plan.groupPathToId.get('shared')!;
      const leafId = plan.groupPathToId.get('shared/leaf')!;
      
      const sharedGroup = plan.groups.get(sharedId)!;
      
      // childGroupIds should have 'leaf' only once
      const leafCount = sharedGroup.childGroupIds.filter(id => id === leafId).length;
      assert.strictEqual(leafCount, 1, 'Leaf group should appear only once in childGroupIds');
    });
  });

  suite('Cycle detection', () => {
    test('detects simple 2-node cycle', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('a', ['b']), makeJob('b', ['a'])],
        }),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Circular dependency')));
          return true;
        }
      );
    });

    test('detects 3-node cycle', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [
            makeJob('a', ['c']),
            makeJob('b', ['a']),
            makeJob('c', ['b']),
          ],
        }),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          return true;
        }
      );
    });

    test('cycle error message includes producer IDs', () => {
      try {
        buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('alpha', ['beta']), makeJob('beta', ['alpha'])],
        });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.details?.some((d: string) => d.includes('alpha')));
        assert.ok(err.details?.some((d: string) => d.includes('beta')));
      }
    });

    test('self-referencing node is detected as cycle', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('self', ['self'])],
        }),
        PlanValidationError
      );
    });

    test('long cycle chain is detected', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [
            makeJob('a', ['e']),
            makeJob('b', ['a']),
            makeJob('c', ['b']),
            makeJob('d', ['c']),
            makeJob('e', ['d']),
          ],
        }),
        PlanValidationError
      );
    });

    test('partial cycle in larger graph is detected', () => {
      // Graph: root -> a -> b -> c -> a (cycle), d depends on root
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [
            makeJob('root'),
            makeJob('a', ['root', 'c']), // c -> a creates cycle
            makeJob('b', ['a']),
            makeJob('c', ['b']),
            makeJob('d', ['root']), // unrelated
          ],
        }),
        PlanValidationError
      );
    });
  });

  suite('Duplicate producerId validation', () => {
    test('throws on duplicate producerId', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('dup'), makeJob('dup')],
        }),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Duplicate producerId')));
          return true;
        }
      );
    });

    test('error message includes the duplicate producerId name', () => {
      try {
        buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('my-duplicate-id'), makeJob('my-duplicate-id')],
        });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.details?.some((d: string) => d.includes('my-duplicate-id')));
      }
    });

    test('triple duplicate is detected', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('x'), makeJob('x'), makeJob('x')],
        }),
        PlanValidationError
      );
    });

    test('multiple different duplicates are all reported', () => {
      try {
        buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [
            makeJob('a'), makeJob('a'),
            makeJob('b'), makeJob('b'),
          ],
        });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.details?.some((d: string) => d.includes("'a'")));
        assert.ok(err.details?.some((d: string) => d.includes("'b'")));
      }
    });
  });

  suite('verifyRiSpec pass-through', () => {
    test('verifyRiSpec string is passed to SV node work', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        verifyRiSpec: 'npm test',
        jobs: [makeJob('a')],
      });
      
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const svNode = plan.jobs.get(svId)!;
      
      assert.strictEqual(svNode.work, 'npm test');
    });

    test('verifyRiSpec object is passed to SV node work', () => {
      const verifySpec = {
        type: 'shell' as const,
        command: 'npm run integration-test',
      };
      
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        verifyRiSpec: verifySpec,
        jobs: [makeJob('a')],
      });
      
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const svNode = plan.jobs.get(svId)!;
      
      assert.deepStrictEqual(svNode.work, verifySpec);
    });

    test('verifyRiSpec agent spec is passed to SV node work', () => {
      const agentSpec = {
        type: 'agent' as const,
        modelTier: 'premium' as const,
        instructions: 'Run comprehensive integration tests',
      };
      
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        verifyRiSpec: agentSpec,
        jobs: [makeJob('a')],
      });
      
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const svNode = plan.jobs.get(svId)!;
      
      assert.deepStrictEqual(svNode.work, agentSpec);
    });

    test('verifyRiSpec is undefined when not specified', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [makeJob('a')],
      });
      
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const svNode = plan.jobs.get(svId)!;
      
      assert.strictEqual(svNode.work, undefined);
    });

    test('verifyRiSpec works with 0-job plan', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        verifyRiSpec: 'npm run verify',
        jobs: [],
      });
      
      const svId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
      const svNode = plan.jobs.get(svId)!;
      
      assert.strictEqual(svNode.work, 'npm run verify');
    });
  });

  suite('maxParallel default', () => {
    test('maxParallel defaults to 0 (unlimited)', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        jobs: [makeJob('a')],
      });
      
      assert.strictEqual(plan.maxParallel, 0);
    });

    test('maxParallel respects spec value', () => {
      const plan = buildPlan({
        name: 'Test',
        baseBranch: 'main',
        maxParallel: 8,
        jobs: [makeJob('a')],
      });
      
      assert.strictEqual(plan.maxParallel, 8);
    });
  });

  suite('buildNodes cycle detection', () => {
    function makeNodeSpec(id: string, deps: string[] = []): NodeSpec {
      return { producerId: id, name: id, task: `Task ${id}`, dependencies: deps } as any;
    }

    test('detects 2-node cycle in buildNodes', () => {
      assert.throws(
        () => buildNodes([makeNodeSpec('a', ['b']), makeNodeSpec('b', ['a'])]),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Circular dependency')));
          return true;
        }
      );
    });

    test('detects 3-node cycle in buildNodes', () => {
      assert.throws(
        () => buildNodes([
          makeNodeSpec('a', ['c']),
          makeNodeSpec('b', ['a']),
          makeNodeSpec('c', ['b']),
        ]),
        PlanValidationError
      );
    });

    test('buildNodes cycle error includes producer IDs', () => {
      try {
        buildNodes([makeNodeSpec('x', ['y']), makeNodeSpec('y', ['x'])]);
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.details?.some((d: string) => d.includes('x')));
        assert.ok(err.details?.some((d: string) => d.includes('y')));
      }
    });

    test('buildNodes throws on duplicate producerId', () => {
      assert.throws(
        () => buildNodes([makeNodeSpec('dup'), makeNodeSpec('dup')]),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('Duplicate')));
          return true;
        }
      );
    });

    test('buildNodes throws when all nodes have dependencies (no roots)', () => {
      // This creates a cycle since all nodes depend on each other
      assert.throws(
        () => buildNodes([
          makeNodeSpec('a', ['b']),
          makeNodeSpec('b', ['a']),
        ]),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          return true;
        }
      );
    });
  });

  suite('Missing producerId field', () => {
    test('throws when job is missing producerId field entirely', () => {
      const badJob = { name: 'Bad', task: 'fail', dependencies: [] } as any;
      assert.throws(
        () => buildPlan({ name: 'Test', baseBranch: 'main', jobs: [badJob] }),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('producerId')));
          return true;
        }
      );
    });

    test('throws when job has undefined producerId', () => {
      const badJob = { producerId: undefined, name: 'Bad', task: 'fail', dependencies: [] } as any;
      assert.throws(
        () => buildPlan({ name: 'Test', baseBranch: 'main', jobs: [badJob] }),
        PlanValidationError
      );
    });

    test('buildNodes throws when node is missing producerId', () => {
      assert.throws(
        () => buildNodes([{ name: 'Bad', task: 'fail', dependencies: [] } as any]),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('producerId')));
          return true;
        }
      );
    });
  });

  suite('Unknown dependency reference', () => {
    test('throws when referencing non-existent dependency', () => {
      assert.throws(
        () => buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('a', ['nonexistent'])],
        }),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('unknown dependency')));
          return true;
        }
      );
    });

    test('error message includes the unknown dependency name', () => {
      try {
        buildPlan({
          name: 'Test',
          baseBranch: 'main',
          jobs: [makeJob('mynode', ['mystery-dep'])],
        });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.details?.some((d: string) => d.includes('mystery-dep')));
        assert.ok(err.details?.some((d: string) => d.includes('mynode')));
      }
    });

    test('buildNodes throws on unknown dependency', () => {
      assert.throws(
        () => buildNodes([{ producerId: 'a', task: 'X', dependencies: ['unknown'] } as any]),
        (err: any) => {
          assert.ok(err instanceof PlanValidationError);
          assert.ok(err.details?.some((d: string) => d.includes('unknown dependency')));
          return true;
        }
      );
    });
  });
});
