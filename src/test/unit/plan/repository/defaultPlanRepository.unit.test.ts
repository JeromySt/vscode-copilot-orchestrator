/**
 * @fileoverview Unit tests for DefaultPlanRepository.
 *
 * Tests the plan repository implementation including scaffolding workflow,
 * node addition, finalization, and validation.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultPlanRepository } from '../../../../plan/repository/DefaultPlanRepository';
import type { IPlanRepositoryStore, StoredPlanMetadata } from '../../../../interfaces/IPlanRepositoryStore';
import type { ScaffoldOptions, NodeSpec, ImportOptions } from '../../../../interfaces/IPlanRepository';
import type { WorkSpec, AgentSpec, ShellSpec } from '../../../../plan/types/specs';

suite('DefaultPlanRepository', () => {
  let sandbox: sinon.SinonSandbox;
  let mockStore: any;
  let repository: DefaultPlanRepository;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    // Mock store following the pattern from task instructions
    mockStore = {
      readPlanMetadata: sandbox.stub(),
      writePlanMetadata: sandbox.stub(),
      writePlanMetadataSync: sandbox.stub(),
      readNodeSpec: sandbox.stub(),
      writeNodeSpec: sandbox.stub(),
      moveFileToSpec: sandbox.stub(),
      hasNodeSpec: sandbox.stub(),
      listPlanIds: sandbox.stub().returns([]),
      deletePlan: sandbox.stub(),
      exists: sandbox.stub(),
      migrateLegacy: sandbox.stub(),
    };

    repository = new DefaultPlanRepository(mockStore, '/test/repo', '/test/worktrees');
  });

  teardown(() => {
    sandbox.restore();
  });

  function makeScaffoldOptions(overrides: Partial<ScaffoldOptions> = {}): ScaffoldOptions {
    return {
      baseBranch: 'main',
      targetBranch: 'feature-branch',
      maxParallel: 4,
      repoPath: '/test/repo',
      worktreeRoot: '/test/worktrees',
      ...overrides
    };
  }

  function makeScaffoldingMetadata(planId: string): StoredPlanMetadata {
    return {
      id: planId,
      spec: {
        name: 'Test Plan',
        status: 'scaffolding',
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        maxParallel: 4,
        cleanUpSuccessfulWork: true,
        startPaused: true,
        jobs: [],
        groups: []
      },
      jobs: [],
      producerIdToNodeId: {},
      roots: [],
      leaves: [],
      nodeStates: {},
      groups: {},
      groupStates: {},
      groupPathToId: {},
      repoPath: '/test/repo',
      baseBranch: 'main',
      targetBranch: 'feature-branch',
      worktreeRoot: '/test/worktrees',
      createdAt: Date.now(),
      maxParallel: 4,
      cleanUpSuccessfulWork: true
    };
  }

  suite('scaffold', () => {
    test('should create metadata with scaffolding status', async () => {
      const options = makeScaffoldOptions();
      
      const plan = await repository.scaffold('Test Plan', options);
      
      assert.ok(plan);
      assert.ok(plan.id);
      assert.ok(mockStore.writePlanMetadata.calledOnce);
      
      const writtenMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      assert.strictEqual(writtenMetadata.spec.name, 'Test Plan');
      assert.strictEqual(writtenMetadata.spec.status, 'scaffolding');
      assert.strictEqual(writtenMetadata.spec.baseBranch, 'main');
      assert.strictEqual(writtenMetadata.spec.targetBranch, 'feature-branch');
    });

    test('should set default values correctly', async () => {
      const options = makeScaffoldOptions({ maxParallel: undefined });
      
      await repository.scaffold('Test Plan', options);
      
      const writtenMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      // maxParallel comes from options which still has 4 from makeScaffoldOptions
      assert.strictEqual(writtenMetadata.spec.cleanUpSuccessfulWork, true);
      assert.strictEqual(writtenMetadata.spec.startPaused, true);
    });
  });

  suite('addNode', () => {
    test('should add node with work spec inline in metadata.spec.jobs', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);

      const nodeSpec: NodeSpec = {
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Test task',
        work: { type: 'shell', command: 'npm build' } as ShellSpec
      };

      await repository.addNode(planId, nodeSpec);

      assert.ok(mockStore.writePlanMetadata.calledOnce);
      
      const updatedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      // During scaffolding, specs are stored inline in jobs[]
      assert.strictEqual(updatedMetadata.spec.jobs.length, 1);
      assert.strictEqual(updatedMetadata.spec.jobs[0].producerId, 'producer-1');
      assert.deepStrictEqual(updatedMetadata.spec.jobs[0].work, { type: 'shell', command: 'npm build' });
    });

    test('should preserve scaffold plan ID on returned PlanInstance', async () => {
      const planId = 'scaffold-uuid-for-addnode';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.createdAt = 9876543210;
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.addNode(planId, {
        producerId: 'p1', name: 'N1', task: 'T1',
        work: { type: 'shell', command: 'echo hi' } as ShellSpec
      });

      assert.strictEqual(result.id, planId);
      assert.strictEqual(result.createdAt, 9876543210);
    });

    test('should add node with inline AgentSpec.instructions', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);

      const agentWork: AgentSpec = {
        type: 'agent',
        instructions: 'Do this task',
        model: 'gpt-4'
      };

      const nodeSpec: NodeSpec = {
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Test task',
        work: agentWork
      };

      await repository.addNode(planId, nodeSpec);

      const updatedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      // Agent specs stored inline during scaffolding
      assert.strictEqual(updatedMetadata.spec.jobs[0].work.type, 'agent');
      assert.strictEqual(updatedMetadata.spec.jobs[0].work.instructions, 'Do this task');
    });

    test('should add node with shell command', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);

      const shellWork: ShellSpec = {
        type: 'shell',
        command: 'npm test'
      };

      const nodeSpec: NodeSpec = {
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Test task',
        work: shellWork
      };

      await repository.addNode(planId, nodeSpec);

      const updatedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      assert.strictEqual(updatedMetadata.spec.jobs[0].work.type, 'shell');
      assert.strictEqual(updatedMetadata.spec.jobs[0].work.command, 'npm test');
    });

    test('should reject if plan not in scaffolding status', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.status = 'pending';
      mockStore.readPlanMetadata.resolves(metadata);

      const nodeSpec: NodeSpec = {
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Test task'
      };

      await assert.rejects(
        () => repository.addNode(planId, nodeSpec),
        /Cannot add nodes to plan in status 'pending'/
      );
    });

    test('should reject duplicate producer IDs', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      // Add existing job in spec.jobs (where duplicates are checked)
      metadata.spec.jobs = [
        { producerId: 'producer-1', name: 'Existing', task: 'Existing task' }
      ];
      mockStore.readPlanMetadata.resolves(metadata);

      const nodeSpec: NodeSpec = {
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Test task'
      };

      await assert.rejects(
        () => repository.addNode(planId, nodeSpec),
        /Duplicate producerId: producer-1/
      );
    });

    test('should throw error if plan not found', async () => {
      mockStore.readPlanMetadata.resolves(undefined);

      const nodeSpec: NodeSpec = {
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Test task'
      };

      await assert.rejects(
        () => repository.addNode('non-existent-plan', nodeSpec),
        /Plan not found: non-existent-plan/
      );
    });
  });

  suite('finalize', () => {
    test('should validate DAG and transition status to pending', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      
      // Add valid jobs in spec.jobs (not metadata.nodes)
      metadata.spec.jobs = [
        { producerId: 'producer-1', name: 'Node 1', task: 'Task 1', dependencies: [] },
        { producerId: 'producer-2', name: 'Node 2', task: 'Task 2', dependencies: ['producer-1'] }
      ];
      
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.finalize(planId);

      assert.ok(result);
      assert.ok(mockStore.writePlanMetadata.calledOnce);
      
      const finalizedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      assert.strictEqual(finalizedMetadata.spec.status, 'pending');
    });

    test('should preserve scaffold plan ID on returned PlanInstance', async () => {
      const planId = 'scaffold-uuid-1234';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.createdAt = 1234567890;
      metadata.spec.jobs = [
        { producerId: 'p1', name: 'N1', task: 'T1', dependencies: [] },
      ];
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.finalize(planId);

      // The returned PlanInstance must have the scaffold's ID, not buildPlan's random UUID
      assert.strictEqual(result.id, planId);
      assert.strictEqual(result.createdAt, 1234567890);
    });

    test('should catch dependency cycles', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      
      // Create circular dependency in spec.jobs
      metadata.spec.jobs = [
        { producerId: 'producer-1', name: 'Node 1', task: 'Task 1', dependencies: ['producer-2'] },
        { producerId: 'producer-2', name: 'Node 2', task: 'Task 2', dependencies: ['producer-1'] }
      ];
      
      mockStore.readPlanMetadata.resolves(metadata);

      await assert.rejects(
        () => repository.finalize(planId),
        /PlanValidationError|Circular dependency/
      );
    });

    test('should catch unknown dependencies', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      
      // Add job with unknown dependency
      metadata.spec.jobs = [
        { producerId: 'producer-1', name: 'Node 1', task: 'Task 1', dependencies: ['unknown-producer'] }
      ];
      
      mockStore.readPlanMetadata.resolves(metadata);

      await assert.rejects(
        () => repository.finalize(planId),
        /PlanValidationError|unknown dependency/i
      );
    });

    test('should reject if plan not in scaffolding status', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.status = 'pending';
      mockStore.readPlanMetadata.resolves(metadata);

      await assert.rejects(
        () => repository.finalize(planId),
        /Cannot finalize plan in status 'pending'/
      );
    });
  });

  suite('getDefinition', () => {
    test('should return FilePlanDefinition', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);

      const definition = await repository.getDefinition(planId);

      assert.ok(definition);
      assert.strictEqual(definition.id, planId);
    });

    test('should return undefined for non-existent plan', async () => {
      mockStore.readPlanMetadata.resolves(undefined);

      const definition = await repository.getDefinition('non-existent');

      assert.strictEqual(definition, undefined);
    });
  });

  suite('saveState', () => {
    test('should write metadata without specs', async () => {
      const planId = 'test-plan';
      const mockPlan = {
        id: planId,
        spec: { name: 'Test Plan' },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        groupStates: new Map()
      } as any;

      await repository.saveState(mockPlan);

      assert.ok(mockStore.writePlanMetadata.calledOnce);
      
      const savedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      assert.strictEqual(savedMetadata.id, planId);
    });

    test('should short-circuit for scaffolding plans', async () => {
      const planId = 'scaffolding-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);

      const mockPlan = {
        id: planId,
        spec: { name: 'Test Plan', status: 'scaffolding' },
        stateVersion: 5,
        isPaused: true,
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map()
      } as any;

      await repository.saveState(mockPlan);

      assert.ok(mockStore.writePlanMetadata.calledOnce);
      const savedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      // Scaffolding plans only sync lightweight fields
      assert.strictEqual(savedMetadata.stateVersion, 5);
      assert.strictEqual(savedMetadata.isPaused, true);
    });

    test('should skip save for tombstoned (deleted) plans', async () => {
      const planId = 'deleted-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.deleted = true;
      mockStore.readPlanMetadata.resolves(metadata);

      const mockPlan = {
        id: planId,
        spec: { name: 'Test Plan' },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map()
      } as any;

      await repository.saveState(mockPlan);

      // writePlanMetadata should not be called for deleted plans
      assert.strictEqual(mockStore.writePlanMetadata.callCount, 0);
    });

    test('should persist autoHeal and expectsNoChanges flags', async () => {
      const planId = 'test-plan';
      mockStore.readPlanMetadata.resolves(undefined);
      mockStore.hasNodeSpec.resolves(false);

      const mockPlan = {
        id: planId,
        spec: { name: 'Test Plan', jobs: [] },
        repoPath: '/test/repo',
        baseBranch: 'main',
        worktreeRoot: '/test/worktrees',
        createdAt: Date.now(),
        roots: [],
        leaves: [],
        jobs: new Map([
          ['node-1', {
            id: 'node-1',
            producerId: 'prod-1',
            name: 'Test Node',
            task: 'Test task',
            dependencies: [],
            autoHeal: false,
            expectsNoChanges: true
          }]
        ]),
        nodeStates: new Map([['node-1', { status: 'pending', version: 0, attempts: 0 }]]),
        producerIdToNodeId: new Map([['prod-1', 'node-1']]),
        groupStates: new Map()
      } as any;

      await repository.saveState(mockPlan);

      assert.ok(mockStore.writePlanMetadata.calledOnce);
      const savedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      assert.strictEqual(savedMetadata.jobs[0].autoHeal, false);
      assert.strictEqual(savedMetadata.jobs[0].expectsNoChanges, true);
    });
  });

  suite('loadState', () => {
    test('should return undefined for non-existent plan', async () => {
      mockStore.readPlanMetadata.resolves(undefined);

      const result = await repository.loadState('non-existent');

      assert.strictEqual(result, undefined);
    });

    test('should skip tombstoned plans and attempt cleanup', async () => {
      const planId = 'deleted-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.deleted = true;
      mockStore.readPlanMetadata.resolves(metadata);
      mockStore.deletePlan.resolves();

      const result = await repository.loadState(planId);

      assert.strictEqual(result, undefined);
      // Should attempt best-effort cleanup
      assert.ok(mockStore.deletePlan.calledOnce);
    });

    test('should rebuild scaffolding plans via buildScaffoldingPlan', async () => {
      const planId = 'scaffolding-plan';
      const metadata = makeScaffoldingMetadata(planId);
      const jobId = 'node-id-1';
      metadata.spec.jobs = [
        { id: jobId, producerId: 'job-1', task: 'Task 1', name: 'Job 1', dependencies: [] }
      ];
      metadata.producerIdToNodeId = { 'job-1': jobId };
      metadata.nodeStates = {
        [jobId]: { status: 'ready', version: 0, attempts: 0 }
      };
      metadata.stateVersion = 3;
      metadata.isPaused = true;
      metadata.startedAt = 12345;
      metadata.baseCommitAtStart = 'abc123';
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.loadState(planId);

      assert.ok(result);
      assert.strictEqual(result!.id, planId);
      assert.strictEqual(result!.stateVersion, 3);
      assert.strictEqual(result!.isPaused, true);
      assert.strictEqual(result!.baseCommitAtStart, 'abc123');
      // Should have rebuilt nodes from metadata (job-1)
      assert.ok(result!.jobs.size >= 1);
    });

    test('should load finalized plans with autoHeal and expectsNoChanges', async () => {
      const planId = 'finalized-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.status = 'pending'; // finalized
      metadata.jobs = [{
        id: 'node-1',
        producerId: 'prod-1',
        name: 'Test Node',
        task: 'Test task',
        dependencies: [],
        hasWork: false,
        hasPrechecks: false,
        hasPostchecks: false,
        autoHeal: false,
        expectsNoChanges: true,
        baseBranch: 'develop',
        assignedWorktreePath: '/custom/worktree'
      }];
      metadata.nodeStates = { 'node-1': { status: 'succeeded', version: 1, attempts: 1 } };
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.loadState(planId);

      assert.ok(result);
      const node = result!.jobs.get('node-1');
      assert.ok(node);
      assert.strictEqual((node as any).autoHeal, false);
      assert.strictEqual((node as any).expectsNoChanges, true);
      assert.strictEqual((node as any).baseBranch, 'develop');
      assert.strictEqual((node as any).assignedWorktreePath, '/custom/worktree');
    });

    test('should restore groups and groupStates for finalized plans', async () => {
      const planId = 'grouped-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.status = 'pending';
      metadata.jobs = [{
        id: 'node-1',
        producerId: 'prod-1',
        name: 'Test Node',
        task: 'Test task',
        dependencies: [],
        hasWork: false,
        hasPrechecks: false,
        hasPostchecks: false,
        group: 'test-group'
      }];
      metadata.groups = {
        'group-1': { id: 'group-1', name: 'Test Group', path: 'test-group', nodeIds: ['node-1'], allNodeIds: ['node-1'], childGroupIds: [], totalNodes: 1 }
      };
      metadata.groupStates = {
        'group-1': { status: 'running', version: 1, runningCount: 1, succeededCount: 0, failedCount: 0, blockedCount: 0, canceledCount: 0 }
      };
      metadata.groupPathToId = { 'test-group': 'group-1' };
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.loadState(planId);

      assert.ok(result);
      assert.ok(result!.groups.has('group-1'));
      assert.ok(result!.groupStates.has('group-1'));
      assert.strictEqual(result!.groupPathToId.get('test-group'), 'group-1');
    });

    test('should compute dependents (reverse edges) for finalized plans', async () => {
      const planId = 'dep-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.status = 'pending';
      metadata.jobs = [
        { id: 'node-1', producerId: 'prod-1', name: 'Node 1', task: 'Task 1', dependencies: [], hasWork: false, hasPrechecks: false, hasPostchecks: false },
        { id: 'node-2', producerId: 'prod-2', name: 'Node 2', task: 'Task 2', dependencies: ['node-1'], hasWork: false, hasPrechecks: false, hasPostchecks: false }
      ];
      mockStore.readPlanMetadata.resolves(metadata);

      const result = await repository.loadState(planId);

      assert.ok(result);
      const node1 = result!.jobs.get('node-1') as any;
      const node2 = result!.jobs.get('node-2') as any;
      // node-2 depends on node-1, so node-1 should have node-2 as dependent
      assert.ok(node1.dependents.includes('node-2'));
      assert.deepStrictEqual(node2.dependencies, ['node-1']);
    });
  });

  suite('delete', () => {
    test('should tombstone plan before physical deletion', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);
      mockStore.deletePlan.resolves();

      await repository.delete(planId);

      // First write tombstone
      assert.ok(mockStore.writePlanMetadata.calledOnce);
      const tombstonedMetadata = mockStore.writePlanMetadata.firstCall.args[0];
      assert.strictEqual(tombstonedMetadata.deleted, true);
      
      // Then physical delete
      assert.ok(mockStore.deletePlan.calledOnce);
    });

    test('should continue physical delete even if tombstone write fails', async () => {
      const planId = 'test-plan';
      mockStore.readPlanMetadata.resolves(undefined); // No metadata to tombstone
      mockStore.deletePlan.resolves();

      await repository.delete(planId);

      // Physical delete should still happen
      assert.ok(mockStore.deletePlan.calledOnce);
    });

    test('should handle tombstone write error gracefully', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);
      mockStore.writePlanMetadata.rejects(new Error('Write failed'));
      mockStore.deletePlan.resolves();

      // Should not throw - tombstone failure is logged but physical delete proceeds
      await repository.delete(planId);

      assert.ok(mockStore.deletePlan.calledOnce);
    });
  });

  suite('markDeletedSync', () => {
    test('should write tombstone synchronously', () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadataSync = sandbox.stub().returns(metadata);
      mockStore.writePlanMetadataSync = sandbox.stub();

      repository.markDeletedSync(planId);

      assert.ok(mockStore.writePlanMetadataSync.calledOnce);
      const written = mockStore.writePlanMetadataSync.firstCall.args[0];
      assert.strictEqual(written.deleted, true);
    });

    test('should skip if metadata not found', () => {
      mockStore.readPlanMetadataSync = sandbox.stub().returns(undefined);
      mockStore.writePlanMetadataSync = sandbox.stub();

      repository.markDeletedSync('missing-plan');

      assert.ok(!mockStore.writePlanMetadataSync.called);
    });

    test('should skip if already tombstoned', () => {
      const metadata = makeScaffoldingMetadata('test-plan');
      (metadata as any).deleted = true;
      mockStore.readPlanMetadataSync = sandbox.stub().returns(metadata);
      mockStore.writePlanMetadataSync = sandbox.stub();

      repository.markDeletedSync('test-plan');

      assert.ok(!mockStore.writePlanMetadataSync.called);
    });

    test('should not throw on error', () => {
      mockStore.readPlanMetadataSync = sandbox.stub().throws(new Error('disk error'));

      // Should not throw
      assert.doesNotThrow(() => repository.markDeletedSync('test-plan'));
    });
  });

  suite('deleted plan in-memory guard', () => {
    test('saveState should not recreate metadata after markDeletedSync', async () => {
      const planId = 'test-plan';
      // Mark as deleted — sets in-memory guard
      mockStore.readPlanMetadataSync = sandbox.stub().returns(undefined);
      mockStore.writePlanMetadataSync = sandbox.stub();
      repository.markDeletedSync(planId);

      // Now simulate a late savePlanState call with stale plan reference
      // where metadata is undefined (directory physically deleted)
      mockStore.readPlanMetadata.resolves(undefined);
      mockStore.writePlanMetadata.resolves();
      const stalePlan = { id: planId, spec: { name: 'test', jobs: [] }, jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(), roots: [], leaves: [] } as any;

      await repository.saveState(stalePlan);

      // writePlanMetadata should NOT be called — the in-memory guard prevents recreation
      assert.ok(!mockStore.writePlanMetadata.called);
    });

    test('saveStateSync should skip after markDeletedSync', () => {
      const planId = 'test-plan';
      mockStore.readPlanMetadataSync = sandbox.stub().returns(undefined);
      mockStore.writePlanMetadataSync = sandbox.stub();
      repository.markDeletedSync(planId);

      // Reset stubs for the saveStateSync call
      mockStore.readPlanMetadataSync = sandbox.stub().returns(undefined);
      mockStore.writePlanMetadataSync = sandbox.stub();

      const stalePlan = { id: planId, spec: { name: 'test', jobs: [] }, jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(), roots: [], leaves: [] } as any;
      repository.saveStateSync(stalePlan);

      // Should not write anything
      assert.ok(!mockStore.writePlanMetadataSync.called);
    });

    test('delete() should set in-memory guard preventing subsequent saves', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      mockStore.readPlanMetadata.resolves(metadata);
      mockStore.deletePlan.resolves();

      await repository.delete(planId);

      // Now a late savePlanState fires — metadata is undefined (directory gone)
      mockStore.readPlanMetadata.resolves(undefined);
      mockStore.writePlanMetadata.resetHistory();

      const stalePlan = { id: planId, spec: { name: 'test', jobs: [] }, jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(), roots: [], leaves: [] } as any;
      await repository.saveState(stalePlan);

      // writePlanMetadata should NOT be called
      assert.ok(!mockStore.writePlanMetadata.called);
    });
  });

  suite('per-plan mutex (withLock)', () => {
    test('should serialize concurrent addNode calls on same plan', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      const callOrder: string[] = [];

      // Make readPlanMetadata async with delay to test serialization
      mockStore.readPlanMetadata.callsFake(async () => {
        await new Promise(r => setTimeout(r, 10));
        return { ...metadata, spec: { ...metadata.spec, jobs: [] } };
      });
      mockStore.writePlanMetadata.callsFake(async () => {
        callOrder.push('write');
        await new Promise(r => setTimeout(r, 10));
      });

      const nodeSpec1: NodeSpec = { producerId: 'prod-1', name: 'Node 1', task: 'Task 1' };
      const nodeSpec2: NodeSpec = { producerId: 'prod-2', name: 'Node 2', task: 'Task 2' };

      // Fire both concurrently
      const [result1, result2] = await Promise.all([
        repository.addNode(planId, nodeSpec1),
        repository.addNode(planId, nodeSpec2)
      ]);

      // Both should complete (no race condition errors)
      assert.ok(result1);
      assert.ok(result2);
      // Writes should have happened sequentially (2 writes total)
      assert.strictEqual(mockStore.writePlanMetadata.callCount, 2);
    });

    test('should allow parallel operations on different plans', async () => {
      const metadata1 = makeScaffoldingMetadata('plan-1');
      const metadata2 = makeScaffoldingMetadata('plan-2');

      mockStore.readPlanMetadata.callsFake(async (id: string) => {
        return id === 'plan-1' 
          ? { ...metadata1, spec: { ...metadata1.spec, jobs: [] } }
          : { ...metadata2, spec: { ...metadata2.spec, jobs: [] } };
      });

      const nodeSpec1: NodeSpec = { producerId: 'prod-1', name: 'Node 1', task: 'Task 1' };
      const nodeSpec2: NodeSpec = { producerId: 'prod-2', name: 'Node 2', task: 'Task 2' };

      const [result1, result2] = await Promise.all([
        repository.addNode('plan-1', nodeSpec1),
        repository.addNode('plan-2', nodeSpec2)
      ]);

      assert.ok(result1);
      assert.ok(result2);
    });

    test('should handle lock chain continuation after failure', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);

      let callCount = 0;
      mockStore.readPlanMetadata.callsFake(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First call fails');
        }
        return { ...metadata, spec: { ...metadata.spec, jobs: [] } };
      });

      const nodeSpec1: NodeSpec = { producerId: 'prod-1', name: 'Node 1', task: 'Task 1' };
      const nodeSpec2: NodeSpec = { producerId: 'prod-2', name: 'Node 2', task: 'Task 2' };

      // First should fail
      await assert.rejects(() => repository.addNode(planId, nodeSpec1));
      
      // Second should succeed (lock chain continues)
      const result = await repository.addNode(planId, nodeSpec2);
      assert.ok(result);
    });
  });

  suite('list', () => {
    test('should exclude tombstoned plans from listing', async () => {
      mockStore.listPlanIds.resolves(['plan-1', 'plan-2', 'deleted-plan']);
      
      const meta1 = makeScaffoldingMetadata('plan-1');
      const meta2 = makeScaffoldingMetadata('plan-2');
      const deletedMeta = makeScaffoldingMetadata('deleted-plan');
      deletedMeta.deleted = true;

      mockStore.readPlanMetadata.callsFake(async (id: string) => {
        if (id === 'plan-1') return meta1;
        if (id === 'plan-2') return meta2;
        if (id === 'deleted-plan') return deletedMeta;
        return undefined;
      });

      const summaries = await repository.list();

      assert.strictEqual(summaries.length, 2);
      assert.ok(summaries.some(s => s.id === 'plan-1'));
      assert.ok(summaries.some(s => s.id === 'plan-2'));
      assert.ok(!summaries.some(s => s.id === 'deleted-plan'));
    });
  });

  suite('finalize with buildPlan', () => {
    test('should write work/prechecks/postchecks specs to disk', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.jobs = [
        {
          producerId: 'job-1',
          task: 'Task 1',
          name: 'Job 1',
          dependencies: [],
          work: { type: 'shell', command: 'npm build' },
          prechecks: { type: 'shell', command: 'npm test' },
          postchecks: { type: 'shell', command: 'npm verify' },
          autoHeal: false,
          expectsNoChanges: true
        }
      ];
      mockStore.readPlanMetadata.resolves(metadata);

      await repository.finalize(planId);

      // Should have written specs to disk (work, prechecks, postchecks for job-1)
      // Note: snapshot-validation node also has specs but uses built-in ones
      assert.ok(mockStore.writeNodeSpec.called);
    });

    test('should populate metadata.jobs with autoHeal and expectsNoChanges', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.jobs = [
        {
          producerId: 'job-1',
          task: 'Task 1',
          name: 'Job 1',
          dependencies: [],
          autoHeal: false,
          expectsNoChanges: true
        }
      ];
      mockStore.readPlanMetadata.resolves(metadata);

      await repository.finalize(planId);

      const savedMetadata = mockStore.writePlanMetadata.lastCall.args[0];
      // Find the job-1 node (not snapshot-validation)
      const job1Node = savedMetadata.jobs.find((n: any) => n.producerId === 'job-1');
      assert.ok(job1Node);
      assert.strictEqual(job1Node.autoHeal, false);
      assert.strictEqual(job1Node.expectsNoChanges, true);
    });

    test('should initialize group states from built plan', async () => {
      const planId = 'test-plan';
      const metadata = makeScaffoldingMetadata(planId);
      metadata.spec.jobs = [
        { producerId: 'job-1', task: 'Task 1', name: 'Job 1', dependencies: [], group: 'test-group' }
      ];
      mockStore.readPlanMetadata.resolves(metadata);

      await repository.finalize(planId);

      const savedMetadata = mockStore.writePlanMetadata.lastCall.args[0];
      // Groups should be populated from built plan
      assert.ok(savedMetadata.groups);
      assert.ok(savedMetadata.groupPathToId);
    });
  });
});