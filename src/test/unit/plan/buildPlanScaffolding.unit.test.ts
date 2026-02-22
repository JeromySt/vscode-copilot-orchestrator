/**
 * @fileoverview Unit tests for buildPlan with 0 jobs (scaffolding support).
 *
 * Verifies that buildPlan() produces a valid plan even with 0 user-defined
 * jobs. The auto-injected SV node should be the sole root and leaf.
 * Subsequent calls with more jobs should include the SV node naturally.
 */

import * as assert from 'assert';
import { buildPlan } from '../../../plan/builder';
import type { PlanSpec } from '../../../plan/types/plan';

const SV_PRODUCER_ID = '__snapshot-validation__';

suite('buildPlan scaffolding (0-job support)', () => {
  test('should produce valid plan with 0 user jobs', () => {
    const spec: PlanSpec = {
      name: 'Empty Scaffold',
      baseBranch: 'main',
      targetBranch: 'feature/test',
      jobs: [],
    };

    const plan = buildPlan(spec);

    // Should have exactly 1 node: the auto-injected SV
    assert.strictEqual(plan.jobs.size, 1, 'Should have exactly the SV node');
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID);
    assert.ok(svNodeId, 'SV node should be registered');
    const svNode = plan.jobs.get(svNodeId!)!;
    assert.strictEqual(svNode.name, 'Snapshot Validation');
    assert.strictEqual(svNode.producerId, SV_PRODUCER_ID);
    assert.deepStrictEqual(svNode.dependencies, [], 'SV should have no deps in empty plan');
  });

  test('SV node should be root and leaf in empty plan', () => {
    const plan = buildPlan({ name: 'Test', baseBranch: 'main', jobs: [] });
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;

    assert.deepStrictEqual(plan.roots, [svNodeId]);
    assert.deepStrictEqual(plan.leaves, [svNodeId]);
  });

  test('SV node status should be ready in empty plan (it is a root)', () => {
    const plan = buildPlan({ name: 'Test', baseBranch: 'main', jobs: [] });
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const state = plan.nodeStates.get(svNodeId)!;
    assert.strictEqual(state.status, 'ready');
  });

  test('SV should depend on all user leaves when jobs are present', () => {
    const spec: PlanSpec = {
      name: 'Two Leaves',
      baseBranch: 'main',
      targetBranch: 'feature/x',
      jobs: [
        { producerId: 'alpha', task: 'Do alpha', dependencies: [] },
        { producerId: 'beta', task: 'Do beta', dependencies: [] },
      ],
    };

    const plan = buildPlan(spec);
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const svNode = plan.jobs.get(svNodeId)!;

    // Both alpha and beta are leaves; SV should depend on both
    const alphaId = plan.producerIdToNodeId.get('alpha')!;
    const betaId = plan.producerIdToNodeId.get('beta')!;
    assert.ok(svNode.dependencies.includes(alphaId));
    assert.ok(svNode.dependencies.includes(betaId));
    assert.strictEqual(svNode.dependencies.length, 2);
  });

  test('SV task should mention target branch', () => {
    const plan = buildPlan({
      name: 'Test',
      baseBranch: 'main',
      targetBranch: 'feature/deploy',
      jobs: [],
    });
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const svNode = plan.jobs.get(svNodeId)!;
    assert.ok(svNode.task.includes('feature/deploy'), `Expected target branch in task, got: ${svNode.task}`);
  });

  test('SV should NOT be in a group when plan has no groups', () => {
    const plan = buildPlan({ name: 'Test', baseBranch: 'main', jobs: [] });
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const svNode = plan.jobs.get(svNodeId)! as any;
    assert.strictEqual(svNode.group, undefined);
  });

  test('SV should have "Final Merge Validation" group when plan has groups', () => {
    const plan = buildPlan({
      name: 'Test',
      baseBranch: 'main',
      jobs: [
        { producerId: 'a', task: 'A', dependencies: [], group: 'Backend' },
      ],
    });
    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const svNode = plan.jobs.get(svNodeId)! as any;
    assert.strictEqual(svNode.group, 'Final Merge Validation');
  });

  test('diamond dependency pattern produces correct SV deps', () => {
    const spec: PlanSpec = {
      name: 'Diamond',
      baseBranch: 'main',
      jobs: [
        { producerId: 'root', task: 'Root', dependencies: [] },
        { producerId: 'left', task: 'Left', dependencies: ['root'] },
        { producerId: 'right', task: 'Right', dependencies: ['root'] },
        { producerId: 'merge', task: 'Merge', dependencies: ['left', 'right'] },
      ],
    };
    const plan = buildPlan(spec);

    const svNodeId = plan.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const svNode = plan.jobs.get(svNodeId)!;
    const mergeId = plan.producerIdToNodeId.get('merge')!;

    // Only 'merge' is a leaf — SV depends on it alone
    assert.deepStrictEqual(svNode.dependencies, [mergeId]);
  });

  test('incremental rebuild produces valid plan each time', () => {
    // Simulates the scaffolding flow: 0 jobs → 1 job → 2 jobs
    const spec0: PlanSpec = { name: 'Test', baseBranch: 'main', jobs: [] };
    const plan0 = buildPlan(spec0);
    assert.strictEqual(plan0.jobs.size, 1); // Just SV

    const spec1: PlanSpec = { name: 'Test', baseBranch: 'main', jobs: [
      { producerId: 'a', task: 'A', dependencies: [] },
    ]};
    const plan1 = buildPlan(spec1);
    assert.strictEqual(plan1.jobs.size, 2); // a + SV

    const spec2: PlanSpec = { name: 'Test', baseBranch: 'main', jobs: [
      { producerId: 'a', task: 'A', dependencies: [] },
      { producerId: 'b', task: 'B', dependencies: ['a'] },
    ]};
    const plan2 = buildPlan(spec2);
    assert.strictEqual(plan2.jobs.size, 3); // a + b + SV

    // SV should depend on only 'b' (the leaf)
    const svNodeId = plan2.producerIdToNodeId.get(SV_PRODUCER_ID)!;
    const bNodeId = plan2.producerIdToNodeId.get('b')!;
    const svNode = plan2.jobs.get(svNodeId)!;
    assert.deepStrictEqual(svNode.dependencies, [bNodeId]);
  });
});
