/**
 * @fileoverview Unit tests for planStatePersister module.
 * 
 * Tests state serialization utilities including serializePlanState,
 * serializePlanStateSync, and serializeNodeState.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { 
  serializePlanState, 
  serializePlanStateSync, 
  serializeNodeState 
} from '../../../../plan/repository/planStatePersister';
import type { PlanInstance, NodeExecutionState } from '../../../../plan/types/plan';

suite('planStatePersister', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('serializeNodeState', () => {
    test('should create a copy of node state', () => {
      const state: NodeExecutionState = {
        status: 'running',
        version: 5,
        attempts: 2,
      };

      const serialized = serializeNodeState(state);
      
      assert.deepStrictEqual(serialized, state);
      assert.notStrictEqual(serialized, state); // Different object
    });
  });

  suite('serializePlanState', () => {
    test('should serialize plan with in-memory specs', async () => {
      const mockStore: any = {
        hasNodeSpec: sandbox.stub().resolves(false),
      };

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], status: 'pending' },
        jobs: new Map([
          ['node-1', {
            id: 'node-1',
            producerId: 'job-1',
            name: 'Job 1',
            task: 'Task 1',
            type: 'job',
            dependencies: [],
            dependents: [],
            work: { agent: { model: 'gpt-5', prompt: 'Test' } },
          }],
        ]),
        nodeStates: new Map([
          ['node-1', { status: 'pending', version: 0, attempts: 0 }],
        ]),
        producerIdToNodeId: new Map([['job-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: 123456789,
        stateVersion: 1,
        isPaused: false,
      } as any;

      const result = await serializePlanState(plan, mockStore);

      assert.strictEqual(result.jobs.length, 1);
      assert.strictEqual(result.jobs[0].id, 'node-1');
      assert.strictEqual(result.jobs[0].producerId, 'job-1');
      assert.strictEqual(result.jobs[0].hasWork, true);
      assert.strictEqual(result.jobs[0].hasPrechecks, false);
      assert.strictEqual(result.jobs[0].hasPostchecks, false);
      assert.strictEqual(result.roots.length, 1);
      assert.strictEqual(result.leaves.length, 1);
      assert.strictEqual(result.stateVersion, 1);
      assert.strictEqual(result.isPaused, false);
    });

    test('should detect specs on disk even when not in memory', async () => {
      const mockStore: any = {
        hasNodeSpec: sandbox.stub().callsFake(
          (_planId: string, _nodeId: string, phase: string) => {
            if (phase === 'work') return Promise.resolve(true);
            if (phase === 'postchecks') return Promise.resolve(true);
            return Promise.resolve(false);
          }
        ),
      };

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], status: 'pending' },
        jobs: new Map([
          ['node-1', {
            id: 'node-1',
            producerId: 'job-1',
            name: 'Job 1',
            task: 'Task 1',
            type: 'job',
            dependencies: [],
            dependents: [],
            // No inline specs
          }],
        ]),
        nodeStates: new Map([
          ['node-1', { status: 'pending', version: 0, attempts: 0 }],
        ]),
        producerIdToNodeId: new Map([['job-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: 123456789,
        stateVersion: 1,
        isPaused: false,
      } as any;

      const result = await serializePlanState(plan, mockStore);

      assert.strictEqual(result.jobs[0].hasWork, true); // Found on disk
      assert.strictEqual(result.jobs[0].hasPrechecks, false);
      assert.strictEqual(result.jobs[0].hasPostchecks, true); // Found on disk
    });

    test('should serialize producerIdToNodeId map', async () => {
      const mockStore: any = {
        hasNodeSpec: sandbox.stub().resolves(false),
      };

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], status: 'pending' },
        jobs: new Map([
          ['node-1', { id: 'node-1', producerId: 'job-1', name: 'Job 1', task: 'Task 1', type: 'job', dependencies: [], dependents: [] }],
          ['node-2', { id: 'node-2', producerId: 'job-2', name: 'Job 2', task: 'Task 2', type: 'job', dependencies: [], dependents: [] }],
        ]),
        nodeStates: new Map(),
        producerIdToNodeId: new Map([
          ['job-1', 'node-1'],
          ['job-2', 'node-2'],
        ]),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: 123456789,
        stateVersion: 0,
        isPaused: false,
      } as any;

      const result = await serializePlanState(plan, mockStore);

      assert.strictEqual(result.producerIdToNodeId['job-1'], 'node-1');
      assert.strictEqual(result.producerIdToNodeId['job-2'], 'node-2');
    });
  });

  suite('serializePlanStateSync', () => {
    test('should serialize without checking disk', () => {
      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], status: 'pending' },
        jobs: new Map([
          ['node-1', {
            id: 'node-1',
            producerId: 'job-1',
            name: 'Job 1',
            task: 'Task 1',
            type: 'job',
            dependencies: [],
            dependents: [],
            work: { agent: { model: 'gpt-5', prompt: 'Test' } },
          }],
        ]),
        nodeStates: new Map([
          ['node-1', { status: 'running', version: 1, attempts: 1 }],
        ]),
        producerIdToNodeId: new Map([['job-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: 123456789,
        stateVersion: 2,
        isPaused: true,
      } as any;

      const result = serializePlanStateSync(plan);

      assert.strictEqual(result.jobs.length, 1);
      assert.strictEqual(result.jobs[0].hasWork, true);
      assert.strictEqual(result.stateVersion, 2);
      assert.strictEqual(result.isPaused, true);
      assert.strictEqual(result.nodeStates['node-1'].status, 'running');
    });

    test('should preserve flags from existing metadata', () => {
      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], status: 'pending' },
        jobs: new Map([
          ['node-1', {
            id: 'node-1',
            producerId: 'job-1',
            name: 'Job 1',
            task: 'Task 1',
            type: 'job',
            dependencies: [],
            dependents: [],
            // No inline specs
          }],
        ]),
        nodeStates: new Map(),
        producerIdToNodeId: new Map([['job-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: 123456789,
        stateVersion: 0,
        isPaused: false,
      } as any;

      const existingMetadata: any = {
        jobs: [
          {
            id: 'node-1',
            producerId: 'job-1',
            hasWork: true,
            hasPrechecks: false,
            hasPostchecks: true,
          },
        ],
      };

      const result = serializePlanStateSync(plan, existingMetadata);

      assert.strictEqual(result.jobs[0].hasWork, true); // From existing metadata
      assert.strictEqual(result.jobs[0].hasPrechecks, false);
      assert.strictEqual(result.jobs[0].hasPostchecks, true); // From existing metadata
    });

    test('should serialize group states', () => {
      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], status: 'pending' },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map([
          ['group-1', { status: 'running', version: 1, runningCount: 2, succeededCount: 0, failedCount: 0, blockedCount: 0, canceledCount: 0 }],
        ]),
        groupPathToId: new Map(),
        repoPath: '/repo',
        baseBranch: 'main',
        targetBranch: 'main',
        worktreeRoot: '/worktrees',
        createdAt: 123456789,
        stateVersion: 0,
        isPaused: false,
      } as any;

      const result = serializePlanStateSync(plan);

      assert.ok(result.groupStates);
      assert.strictEqual(result.groupStates['group-1'].status, 'running');
      assert.strictEqual(result.groupStates['group-1'].runningCount, 2);
    });
  });
});
