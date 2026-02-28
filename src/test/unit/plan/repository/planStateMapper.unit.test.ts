/**
 * @fileoverview Unit tests for planStateMapper module.
 * 
 * Tests state reconstruction utilities including buildPlanInstance,
 * buildNodeStates, normalizeNodeStatus, and loadNodeSpecs.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { 
  buildPlanInstance, 
  buildNodeStates, 
  normalizeNodeStatus, 
  loadNodeSpecs 
} from '../../../../plan/repository/planStateMapper';
import type { StoredPlanMetadata } from '../../../../interfaces/IPlanRepositoryStore';

suite('planStateMapper', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('normalizeNodeStatus', () => {
    test('should return valid status unchanged', () => {
      assert.strictEqual(normalizeNodeStatus('pending'), 'pending');
      assert.strictEqual(normalizeNodeStatus('ready'), 'ready');
      assert.strictEqual(normalizeNodeStatus('running'), 'running');
      assert.strictEqual(normalizeNodeStatus('succeeded'), 'succeeded');
      assert.strictEqual(normalizeNodeStatus('failed'), 'failed');
      assert.strictEqual(normalizeNodeStatus('canceled'), 'canceled');
      assert.strictEqual(normalizeNodeStatus('blocked'), 'blocked');
      assert.strictEqual(normalizeNodeStatus('skipped'), 'skipped');
    });

    test('should return pending for invalid status', () => {
      assert.strictEqual(normalizeNodeStatus('invalid'), 'pending');
      assert.strictEqual(normalizeNodeStatus(''), 'pending');
      assert.strictEqual(normalizeNodeStatus('unknown'), 'pending');
    });
  });

  suite('buildNodeStates', () => {
    test('should build empty map from empty record', () => {
      const result = buildNodeStates({});
      assert.ok(result instanceof Map);
      assert.strictEqual(result.size, 0);
    });

    test('should build map with normalized statuses', () => {
      const rawStates = {
        'node1': { status: 'running', version: 1, attempts: 2 },
        'node2': { status: 'invalid', version: 0, attempts: 0 },
      };

      const result = buildNodeStates(rawStates);
      
      assert.strictEqual(result.size, 2);
      assert.strictEqual(result.get('node1')?.status, 'running');
      assert.strictEqual(result.get('node1')?.version, 1);
      assert.strictEqual(result.get('node1')?.attempts, 2);
      assert.strictEqual(result.get('node2')?.status, 'pending'); // normalized
    });
  });

  suite('buildPlanInstance', () => {
    test('should reconstruct scaffolding plan with inline specs', () => {
      const mockStore: any = {
        readNodeSpec: sandbox.stub(),
        hasNodeSpec: sandbox.stub(),
      };

      const metadata: StoredPlanMetadata = {
        id: 'plan-1',
        spec: {
          name: 'Test Plan',
          jobs: [
            {
              id: 'node-1',
              producerId: 'job-1',
              name: 'Job 1',
              task: 'Do something',
              dependencies: [],
              work: { agent: { model: 'gpt-5', prompt: 'Test' } },
            },
          ],
          status: 'scaffolding',
        },
        jobs: [],
        producerIdToNodeId: { 'job-1': 'node-1' },
        roots: ['node-1'],
        leaves: ['node-1'],
        nodeStates: {
          'node-1': { status: 'ready', version: 0, attempts: 0 },
        },
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: Date.now(),
      } as any;

      const plan = buildPlanInstance(metadata, {
        store: mockStore,
        repoPath: '/repo',
        worktreeRoot: '/worktrees',
      });

      assert.strictEqual(plan.id, 'plan-1');
      assert.strictEqual(plan.spec.name, 'Test Plan');
      assert.strictEqual(plan.jobs.size, 1);
      
      const node = plan.jobs.get('node-1');
      assert.ok(node);
      assert.strictEqual(node.producerId, 'job-1');
      assert.strictEqual(node.name, 'Job 1');
      assert.ok(node.work);
      assert.strictEqual(plan.roots.length, 1);
      assert.strictEqual(plan.leaves.length, 1);
    });

    test('should reconstruct finalized plan without inline specs', () => {
      const mockStore: any = {
        readNodeSpec: sandbox.stub(),
        hasNodeSpec: sandbox.stub(),
      };

      const metadata: StoredPlanMetadata = {
        id: 'plan-2',
        spec: {
          name: 'Finalized Plan',
          jobs: [], // Specs on disk
          status: 'pending',
        },
        jobs: [
          {
            id: 'node-1',
            producerId: 'job-1',
            name: 'Job 1',
            task: 'Do something',
            dependencies: [],
            hasWork: true,
            hasPrechecks: false,
            hasPostchecks: false,
          },
        ],
        producerIdToNodeId: { 'job-1': 'node-1' },
        roots: ['node-1'],
        leaves: ['node-1'],
        nodeStates: {
          'node-1': { status: 'pending', version: 0, attempts: 0 },
        },
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: Date.now(),
      } as any;

      const plan = buildPlanInstance(metadata, {
        store: mockStore,
        repoPath: '/repo',
        worktreeRoot: '/worktrees',
      });

      assert.strictEqual(plan.id, 'plan-2');
      assert.strictEqual(plan.jobs.size, 1);
      
      const node = plan.jobs.get('node-1');
      assert.ok(node);
      assert.strictEqual(node.producerId, 'job-1');
      // Specs are not loaded inline in buildPlanInstance for finalized plans
      assert.strictEqual(node.work, undefined);
    });

    test('should compute dependents from dependencies', () => {
      const mockStore: any = {
        readNodeSpec: sandbox.stub(),
        hasNodeSpec: sandbox.stub(),
      };

      const metadata: StoredPlanMetadata = {
        id: 'plan-3',
        spec: {
          name: 'DAG Plan',
          jobs: [
            { id: 'node-1', producerId: 'job-1', name: 'Job 1', task: 'Task 1', dependencies: [] },
            { id: 'node-2', producerId: 'job-2', name: 'Job 2', task: 'Task 2', dependencies: ['node-1'] },
          ],
          status: 'scaffolding',
        },
        jobs: [],
        producerIdToNodeId: { 'job-1': 'node-1', 'job-2': 'node-2' },
        roots: ['node-1'],
        leaves: ['node-2'],
        nodeStates: {},
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: Date.now(),
      } as any;

      const plan = buildPlanInstance(metadata, {
        store: mockStore,
        repoPath: '/repo',
        worktreeRoot: '/worktrees',
      });

      const node1 = plan.jobs.get('node-1');
      const node2 = plan.jobs.get('node-2');
      
      assert.ok(node1);
      assert.ok(node2);
      assert.strictEqual(node1.dependents.length, 1);
      assert.strictEqual(node1.dependents[0], 'node-2');
      assert.strictEqual(node2.dependencies.length, 1);
      assert.strictEqual(node2.dependencies[0], 'node-1');
    });
  });

  suite('loadNodeSpecs', () => {
    test('should load no specs when flags are false', async () => {
      const mockStore: any = {
        readNodeSpec: sandbox.stub(),
      };

      const result = await loadNodeSpecs(mockStore, 'plan-1', 'node-1', false, false, false);

      assert.deepStrictEqual(result, {});
      assert.ok(!mockStore.readNodeSpec.called);
    });

    test('should load work spec when hasWork is true', async () => {
      const mockStore: any = {
        readNodeSpec: sandbox.stub().resolves({ agent: { model: 'gpt-5', prompt: 'Test' } }),
      };

      const result = await loadNodeSpecs(mockStore, 'plan-1', 'node-1', true, false, false);

      assert.ok(result.work);
      assert.strictEqual(mockStore.readNodeSpec.callCount, 1);
      assert.ok(mockStore.readNodeSpec.calledWith('plan-1', 'node-1', 'work'));
    });

    test('should load all specs when all flags are true', async () => {
      const mockStore: any = {
        readNodeSpec: sandbox.stub()
          .onFirstCall().resolves({ agent: { model: 'gpt-5', prompt: 'Work' } })
          .onSecondCall().resolves({ agent: { model: 'gpt-5', prompt: 'Precheck' } })
          .onThirdCall().resolves({ agent: { model: 'gpt-5', prompt: 'Postcheck' } }),
      };

      const result = await loadNodeSpecs(mockStore, 'plan-1', 'node-1', true, true, true);

      assert.ok(result.work);
      assert.ok(result.prechecks);
      assert.ok(result.postchecks);
      assert.strictEqual(mockStore.readNodeSpec.callCount, 3);
    });
  });
});
