/**
 * @fileoverview Tests for snapshot-validation node, OnFailureConfig, and builder injection.
 * The snapshot-validation node is a regular JobNode identified by producerId '__snapshot-validation__'.
 */
import * as assert from 'assert';
import { suite, test } from 'mocha';
import { buildPlan } from '../../../plan/builder';
import type { PlanSpec, OnFailureConfig, JobNode, JobExecutionResult, WorkSpec, PlanNode } from '../../../plan/types';
import { normalizeWorkSpec } from '../../../plan/types';

suite('Snapshot Validation Node', () => {
  suite('OnFailureConfig type and normalizeWorkSpec', () => {
    test('OnFailureConfig fields are optional', () => {
      const config: OnFailureConfig = {};
      assert.strictEqual(config.noAutoHeal, undefined);
      assert.strictEqual(config.message, undefined);
      assert.strictEqual(config.resumeFromPhase, undefined);
    });

    test('OnFailureConfig accepts all fields', () => {
      const config: OnFailureConfig = {
        noAutoHeal: true,
        message: 'Target branch dirty',
        resumeFromPhase: 'prechecks',
      };
      assert.strictEqual(config.noAutoHeal, true);
      assert.strictEqual(config.message, 'Target branch dirty');
      assert.strictEqual(config.resumeFromPhase, 'prechecks');
    });

    test('normalizeWorkSpec converts on_failure to onFailure (snake_case)', () => {
      const spec: any = {
        type: 'shell',
        command: 'npm test',
        on_failure: {
          no_auto_heal: true,
          message: 'Must pass tests',
          resume_from_phase: 'work',
        },
      };
      const result = normalizeWorkSpec(spec);
      assert.ok(result);
      assert.deepStrictEqual(result!.onFailure, {
        noAutoHeal: true,
        message: 'Must pass tests',
        resumeFromPhase: 'work',
      });
    });

    test('normalizeWorkSpec preserves existing onFailure (camelCase)', () => {
      const spec: any = {
        type: 'shell',
        command: 'npm test',
        onFailure: { noAutoHeal: true, message: 'test' },
      };
      const result = normalizeWorkSpec(spec);
      assert.ok(result);
      assert.strictEqual(result!.onFailure!.noAutoHeal, true);
      assert.strictEqual(result!.onFailure!.message, 'test');
    });

    test('normalizeWorkSpec handles string specs (no onFailure)', () => {
      const result = normalizeWorkSpec('npm test');
      assert.ok(result);
      assert.strictEqual(result!.type, 'shell');
      assert.strictEqual(result!.onFailure, undefined);
    });
  });

  suite('Builder injection', () => {
    test('buildPlan always injects snapshot-validation node', () => {
      const spec: PlanSpec = {
        name: 'Test',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'Build', dependencies: [] }],
      };
      const plan = buildPlan(spec);

      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__');
      assert.ok(svNodeId, 'Snapshot-validation node must exist');
      const svNode = plan.nodes.get(svNodeId!)!;
      assert.strictEqual(svNode.type, 'job');
      assert.strictEqual(svNode.name, 'Snapshot Validation');
      assert.strictEqual(svNode.group, undefined, 'SV node should not have a group when plan has no groups');
    });

    test('snapshot-validation node gets group when plan has groups', () => {
      const spec: PlanSpec = {
        name: 'Test',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'Build', dependencies: [], group: 'Backend' }],
      };
      const plan = buildPlan(spec);

      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__');
      assert.ok(svNodeId);
      const svNode = plan.nodes.get(svNodeId!)!;
      assert.strictEqual(svNode.group, 'Final Merge Validation');
    });

    test('snapshot-validation node depends on all original leaves', () => {
      const spec: PlanSpec = {
        name: 'Multi',
        baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'A', dependencies: [] },
          { producerId: 'b', task: 'B', dependencies: [] },
          { producerId: 'c', task: 'C', dependencies: ['a'] },
        ],
      };
      const plan = buildPlan(spec);

      const bId = plan.producerIdToNodeId.get('b')!;
      const cId = plan.producerIdToNodeId.get('c')!;
      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__')!;
      const svNode = plan.nodes.get(svNodeId)!;

      assert.ok(svNode.dependencies.includes(bId), 'Should depend on leaf b');
      assert.ok(svNode.dependencies.includes(cId), 'Should depend on leaf c');
      assert.strictEqual(svNode.dependencies.length, 2);
    });

    test('snapshot-validation node is the sole leaf', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        jobs: [
          { producerId: 'a', task: 'X', dependencies: [] },
          { producerId: 'b', task: 'Y', dependencies: [] },
        ],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.leaves.length, 1);

      const leafNode = plan.nodes.get(plan.leaves[0])!;
      assert.strictEqual(leafNode.producerId, '__snapshot-validation__');
    });

    test('snapshot-validation node gets verifyRiSpec as work', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        verifyRiSpec: 'npm test',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__')!;
      const svNode = plan.nodes.get(svNodeId)!;
      assert.strictEqual(svNode.work, 'npm test');
    });

    test('targetBranch defaults to baseBranch when not specified', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'develop',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.targetBranch, 'develop');
    });

    test('targetBranch uses spec value when specified', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        targetBranch: 'release/v1',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.strictEqual(plan.targetBranch, 'release/v1');
    });

    test('creates Final Merge Validation group when plan has groups', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [], group: 'Build' }],
      };
      const plan = buildPlan(spec);
      assert.ok(plan.groupPathToId.has('Final Merge Validation'));
      const groupId = plan.groupPathToId.get('Final Merge Validation')!;
      const group = plan.groups.get(groupId)!;
      assert.strictEqual(group.name, 'Final Merge Validation');
      assert.strictEqual(group.nodeIds.length, 1);
      assert.strictEqual(group.totalNodes, 1);
    });

    test('does not create group when plan has no groups', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      assert.ok(!plan.groupPathToId.has('Final Merge Validation'));
      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__')!;
      const svNode = plan.nodes.get(svNodeId)!;
      assert.strictEqual(svNode.group, undefined);
      assert.strictEqual(svNode.groupId, undefined);
    });

    test('original leaves have snapshot-validation as dependent', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      const aId = plan.producerIdToNodeId.get('a')!;
      const aNode = plan.nodes.get(aId)!;
      const svId = plan.producerIdToNodeId.get('__snapshot-validation__')!;
      assert.ok(aNode.dependents.includes(svId));
    });

    test('assignedWorktreePath is initially undefined', () => {
      const spec: PlanSpec = {
        name: 'P',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
      };
      const plan = buildPlan(spec);
      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__')!;
      const svNode = plan.nodes.get(svNodeId)!;
      assert.strictEqual(svNode.assignedWorktreePath, undefined);
    });
  });

  suite('JobExecutionResult failure control fields', () => {
    test('result can carry noAutoHeal', () => {
      const result: JobExecutionResult = {
        success: false,
        error: 'test',
        noAutoHeal: true,
      };
      assert.strictEqual(result.noAutoHeal, true);
    });

    test('result can carry failureMessage', () => {
      const result: JobExecutionResult = {
        success: false,
        error: 'test',
        failureMessage: 'User must fix target branch',
      };
      assert.strictEqual(result.failureMessage, 'User must fix target branch');
    });

    test('result can carry overrideResumeFromPhase', () => {
      const result: JobExecutionResult = {
        success: false,
        error: 'test',
        overrideResumeFromPhase: 'prechecks',
      };
      assert.strictEqual(result.overrideResumeFromPhase, 'prechecks');
    });
  });

  suite('Persistence round-trip', () => {
    test('snapshot-validation node with assignedWorktreePath survives serialize/deserialize', () => {
      const { PlanPersistence } = require('../../../plan/persistence');
      const fs = require('fs');
      const path = require('path');
      const os = require('os');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-persist-'));
      const persistence = new PlanPersistence(tmpDir);

      const spec: PlanSpec = {
        name: 'Persist Test',
        baseBranch: 'main',
        jobs: [{ producerId: 'a', task: 'Build', dependencies: [] }],
      };
      const plan = buildPlan(spec);

      // Simulate snapshot creation setting assignedWorktreePath
      const svNodeId = plan.producerIdToNodeId.get('__snapshot-validation__')!;
      const svNode = plan.nodes.get(svNodeId)!;
      svNode.assignedWorktreePath = '/tmp/snapshot-worktree';

      persistence.save(plan);

      const loaded = persistence.load(plan.id);
      assert.ok(loaded);

      const loadedSvNode = loaded!.nodes.get(svNodeId)!;
      assert.strictEqual(loadedSvNode.name, 'Snapshot Validation');
      assert.strictEqual(loadedSvNode.assignedWorktreePath, '/tmp/snapshot-worktree');
      assert.strictEqual(loadedSvNode.group, undefined, 'SV node should not have group in ungrouped plan');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
