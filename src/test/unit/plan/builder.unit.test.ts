/**
 * @fileoverview Unit tests for Plan builder - covers buildPlan, buildSingleJobPlan, buildNodes, detectCycles
 */
import * as assert from 'assert';
import { buildPlan, buildSingleJobPlan, buildNodes, PlanValidationError } from '../../../plan/builder';
import type { PlanSpec, GroupSpec } from '../../../plan/types';

suite('Plan Builder (extended coverage)', () => {
  suite('buildPlan', () => {
    test('builds a simple single-node plan', () => {
      const spec: PlanSpec = {
        name: 'Simple Plan',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'Build', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.ok(plan.id);
      assert.strictEqual(plan.nodes.size, 1);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
      assert.strictEqual(plan.baseBranch, 'main');
    });

    test('builds a multi-node plan with dependencies', () => {
      const spec: PlanSpec = {
        name: 'Multi Plan',
        baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'Build', dependencies: [] },
          { producerId: 'b', task: 'Test', dependencies: ['a'] },
          { producerId: 'c', task: 'Deploy', dependencies: ['b'] },
        ],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.nodes.size, 3);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
    });

    test('root nodes start as ready', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: [] },
          { producerId: 'b', task: 'Y', dependencies: ['a'] },
        ],
      };
      const plan = buildPlan(spec);
      const rootId = plan.producerIdToNodeId.get('a')!;
      const depId = plan.producerIdToNodeId.get('b')!;
      assert.strictEqual(plan.nodeStates.get(rootId)!.status, 'ready');
      assert.strictEqual(plan.nodeStates.get(depId)!.status, 'pending');
    });

    test('throws on duplicate producerId', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: [] },
          { producerId: 'a', task: 'Y', dependencies: [] },
        ],
      };
      assert.throws(() => buildPlan(spec), (err: any) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details!.some((d: string) => d.includes('Duplicate')));
        return true;
      });
    });

    test('throws on unknown dependency reference', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: ['nonexistent'] },
        ],
      };
      assert.throws(() => buildPlan(spec), (err: any) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details!.some((d: string) => d.includes('unknown dependency')));
        return true;
      });
    });

    test('throws on circular dependency', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: ['b'] },
          { producerId: 'b', task: 'Y', dependencies: ['a'] },
        ],
      };
      assert.throws(() => buildPlan(spec), (err: any) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details!.some((d: string) => d.includes('Circular')));
        return true;
      });
    });

    test('throws when no nodes', () => {
      const spec: PlanSpec = { name: 'P', baseBranch: 'main', jobs: [] };
      assert.throws(() => buildPlan(spec), PlanValidationError);
    });

    test('throws on missing producerId', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [{ producerId: '', task: 'X', dependencies: [] }],
      };
      assert.throws(() => buildPlan(spec), PlanValidationError);
    });

    test('uses default baseBranch when not specified', () => {
      const spec: PlanSpec = {
        name: 'P',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.baseBranch, 'main');
    });

    test('uses default maxParallel when not specified', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.maxParallel, 4);
    });

    test('respects custom maxParallel', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main', maxParallel: 8,
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.maxParallel, 8);
    });

    test('sets cleanUpSuccessfulWork to true by default', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.cleanUpSuccessfulWork, true);
    });

    test('supports parentPlanId and parentNodeId options', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec, { parentPlanId: 'parent-1', parentNodeId: 'node-1' });
      assert.strictEqual(plan.parentPlanId, 'parent-1');
      assert.strictEqual(plan.parentNodeId, 'node-1');
    });

    test('supports targetBranch in spec', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main', targetBranch: 'feature',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.targetBranch, 'feature');
    });

    test('builds groups from spec', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        groups: [{ name: 'frontend' }],
        jobs: [{ producerId: 'a', task: 'X', dependencies: [], group: 'frontend' }],
      };
      const plan = buildPlan(spec);
      assert.ok(plan.groups.size > 0);
      assert.ok(plan.groupStates.size > 0);
    });

    test('auto-creates group hierarchy when job references nested group', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [], group: 'frontend/components' }],
      };
      const plan = buildPlan(spec);
      assert.ok(plan.groupPathToId.has('frontend'));
      assert.ok(plan.groupPathToId.has('frontend/components'));
    });

    test('nested groups reference from spec', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        groups: [{ name: 'backend', groups: [{ name: 'api' }] }],
        jobs: [{ producerId: 'a', task: 'X', dependencies: [], group: 'backend/api' }],
      };
      const plan = buildPlan(spec);
      assert.ok(plan.groupPathToId.has('backend'));
      assert.ok(plan.groupPathToId.has('backend/api'));
      const nodeId = plan.producerIdToNodeId.get('a')!;
      const node = plan.nodes.get(nodeId)!;
      assert.ok(node.groupId);
    });

    test('preserves job node fields', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [{
          producerId: 'a', task: 'Build', name: 'Custom Name',
          work: 'npm run build',
          prechecks: 'npm run lint',
          postchecks: 'npm test',
          instructions: 'Build it',
          baseBranch: 'develop',
          expectsNoChanges: true,
          autoHeal: true,
          dependencies: [],
        }],
      };
      const plan = buildPlan(spec);
      const nodeId = plan.producerIdToNodeId.get('a')!;
      const node = plan.nodes.get(nodeId)! as any;
      assert.strictEqual(node.name, 'Custom Name');
      assert.strictEqual(node.work, 'npm run build');
      assert.strictEqual(node.prechecks, 'npm run lint');
      assert.strictEqual(node.postchecks, 'npm test');
      assert.strictEqual(node.instructions, 'Build it');
      assert.strictEqual(node.baseBranch, 'develop');
      assert.strictEqual(node.expectsNoChanges, true);
      assert.strictEqual(node.autoHeal, true);
    });

    test('computes dependents (reverse edges) correctly', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: [] },
          { producerId: 'b', task: 'Y', dependencies: ['a'] },
        ],
      };
      const plan = buildPlan(spec);
      const aId = plan.producerIdToNodeId.get('a')!;
      const bId = plan.producerIdToNodeId.get('b')!;
      const aNode = plan.nodes.get(aId)!;
      assert.ok(aNode.dependents.includes(bId));
    });

    test('multiple roots and multiple leaves', () => {
      const spec: PlanSpec = {
        name: 'P', baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: [] },
          { producerId: 'b', task: 'Y', dependencies: [] },
          { producerId: 'c', task: 'Z', dependencies: ['a'] },
        ],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.roots.length, 2);
      assert.strictEqual(plan.leaves.length, 2); // b and c
    });
  });

  suite('buildSingleJobPlan', () => {
    test('creates a plan with one node', () => {
      const plan = buildSingleJobPlan({ name: 'My Job', task: 'do stuff' });
      assert.strictEqual(plan.nodes.size, 1);
      assert.strictEqual(plan.roots.length, 1);
    });

    test('generates producerId from name', () => {
      const plan = buildSingleJobPlan({ name: 'Build & Test!', task: 'go' });
      assert.strictEqual(plan.producerIdToNodeId.size, 1);
      const [producerId] = plan.producerIdToNodeId.keys();
      assert.ok(!producerId.includes('!'));
      assert.ok(!producerId.includes('&'));
    });

    test('passes through all optional fields', () => {
      const plan = buildSingleJobPlan({
        name: 'Job', task: 'x',
        work: 'npm run build',
        prechecks: 'npm run lint',
        postchecks: 'npm test',
        instructions: 'do it',
        baseBranch: 'develop',
        targetBranch: 'feature',
        repoPath: '/my/repo',
        expectsNoChanges: true,
        autoHeal: false,
      });
      const node = [...plan.nodes.values()][0] as any;
      assert.strictEqual(node.work, 'npm run build');
      assert.strictEqual(node.prechecks, 'npm run lint');
      assert.strictEqual(node.postchecks, 'npm test');
      assert.strictEqual(node.expectsNoChanges, true);
      assert.strictEqual(plan.targetBranch, 'feature');
    });

    test('supports repoPath and worktreeRoot options', () => {
      const plan = buildSingleJobPlan(
        { name: 'J', task: 'x' },
        { repoPath: '/custom/repo', worktreeRoot: '/custom/wt' },
      );
      assert.strictEqual(plan.repoPath, '/custom/repo');
      assert.strictEqual(plan.worktreeRoot, '/custom/wt');
    });
  });

  suite('buildNodes', () => {
    test('builds nodes from specs', () => {
      const result = buildNodes([
        { producerId: 'a', task: 'Build', dependencies: [] },
        { producerId: 'b', task: 'Test', dependencies: ['a'] },
      ]);
      assert.strictEqual(result.nodes.length, 2);
    });

    test('root nodes start as ready', () => {
      const result = buildNodes([
        { producerId: 'a', task: 'X', dependencies: [] },
        { producerId: 'b', task: 'Y', dependencies: ['a'] },
      ]);
      const rootNode = result.nodes.find(n => n.producerId === 'a')!;
      const depNode = result.nodes.find(n => n.producerId === 'b')!;
      assert.strictEqual(rootNode.status, 'ready');
      assert.strictEqual(depNode.status, 'pending');
    });

    test('throws on duplicate producerId', () => {
      assert.throws(() => buildNodes([
        { producerId: 'a', task: 'X', dependencies: [] },
        { producerId: 'a', task: 'Y', dependencies: [] },
      ]), PlanValidationError);
    });

    test('throws on unknown dependency', () => {
      assert.throws(() => buildNodes([
        { producerId: 'a', task: 'X', dependencies: ['unknown'] },
      ]), PlanValidationError);
    });

    test('throws on empty specs', () => {
      assert.throws(() => buildNodes([]), PlanValidationError);
    });

    test('throws on cycle', () => {
      assert.throws(() => buildNodes([
        { producerId: 'a', task: 'X', dependencies: ['b'] },
        { producerId: 'b', task: 'Y', dependencies: ['a'] },
      ]), PlanValidationError);
    });

    test('throws on missing producerId', () => {
      assert.throws(() => buildNodes([
        { producerId: '', task: 'X', dependencies: [] },
      ]), PlanValidationError);
    });

    test('computes dependents correctly', () => {
      const result = buildNodes([
        { producerId: 'a', task: 'X', dependencies: [] },
        { producerId: 'b', task: 'Y', dependencies: ['a'] },
      ]);
      const aNode = result.nodes.find(n => n.producerId === 'a')!;
      const bNode = result.nodes.find(n => n.producerId === 'b')!;
      assert.ok(aNode.dependents.includes(bNode.id));
    });

    test('passes group through', () => {
      const group = { id: 'g1', name: 'frontend', path: 'frontend', baseBranch: 'main', maxParallel: 4, cleanUpSuccessfulWork: true, worktreeRoot: '/wt', createdAt: Date.now() };
      const result = buildNodes(
        [{ producerId: 'a', task: 'X', dependencies: [] }],
        { group },
      );
      assert.strictEqual(result.group, group);
      assert.strictEqual(result.nodes[0].group, group);
    });

    test('uses default name from producerId', () => {
      const result = buildNodes([
        { producerId: 'my-node', task: 'X', dependencies: [] },
      ]);
      assert.strictEqual(result.nodes[0].name, 'my-node');
    });

    test('uses custom name when provided', () => {
      const result = buildNodes([
        { producerId: 'a', name: 'Custom Name', task: 'X', dependencies: [] },
      ]);
      assert.strictEqual(result.nodes[0].name, 'Custom Name');
    });
  });

  suite('PlanValidationError', () => {
    test('has correct name and details', () => {
      const err = new PlanValidationError('bad', ['detail1', 'detail2']);
      assert.strictEqual(err.name, 'PlanValidationError');
      assert.strictEqual(err.message, 'bad');
      assert.deepStrictEqual(err.details, ['detail1', 'detail2']);
    });
  });
});
