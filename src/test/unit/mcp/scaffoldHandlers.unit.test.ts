/**
 * @fileoverview Unit tests for MCP scaffold handlers.
 *
 * Tests the MCP tool handlers for the scaffolding workflow including
 * plan creation, node addition, and finalization.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { handleScaffoldPlan } from '../../../mcp/handlers/plan/scaffoldPlanHandler';
import { handleAddPlanJob } from '../../../mcp/handlers/plan/addJobHandler';
import { handleFinalizePlan } from '../../../mcp/handlers/plan/finalizePlanHandler';
import { handlePausePlan, handleResumePlan } from '../../../mcp/handlers/plan/pauseResumeHandler';
import type { PlanHandlerContext } from '../../../mcp/handlers/utils';

suite('MCP Scaffold Handlers', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: PlanHandlerContext;
  let mockPlanRepository: any;
  let mockPlanRunner: any;
  let mockGit: any;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockPlanRepository = {
      scaffold: sandbox.stub(),
      addNode: sandbox.stub(),
      finalize: sandbox.stub(),
      getDefinition: sandbox.stub(),
      saveState: sandbox.stub(),
    };

    mockPlanRunner = {
      _state: {
        events: {
          emitPlanUpdated: sandbox.stub(),
        },
        stateMachineFactory: sandbox.stub(),
        stateMachines: new Map(),
      },
      _lifecycle: {
        setupStateMachineListeners: sandbox.stub(),
      },
      enqueue: sandbox.stub(),
      registerPlan: sandbox.stub(),
      get: sandbox.stub(),
      pause: sandbox.stub(),
      resume: sandbox.stub(),
    };

    mockGit = {
      getCurrentBranch: sandbox.stub().resolves('main'),
      branchExists: sandbox.stub().resolves(true),
      branches: {
        currentOrNull: sandbox.stub().resolves('main'),
        isDefaultBranch: sandbox.stub().resolves(false),
        exists: sandbox.stub().resolves(true),
        create: sandbox.stub().resolves(),
      },
    };

    mockContext = {
      PlanRepository: mockPlanRepository,
      PlanRunner: mockPlanRunner,
      git: mockGit,
      workspacePath: '/test/workspace',
    } as any;
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleScaffoldPlan', () => {
    test('should create plan in scaffolding state', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });

      const args = {
        name: 'Test Plan',
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        maxParallel: 4
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, planId);
      assert.ok(result.message.includes('Plan scaffold'));
      
      assert.ok(mockPlanRepository.scaffold.calledOnce);
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      assert.strictEqual(scaffoldArgs[0], 'Test Plan');
      assert.strictEqual(scaffoldArgs[1].baseBranch, 'main');
      assert.strictEqual(scaffoldArgs[1].targetBranch, 'feature-branch');
    });

    test('should handle scaffold errors', async () => {
      mockPlanRepository.scaffold.rejects(new Error('Scaffold failed'));

      const args = {
        name: 'Test Plan',
        baseBranch: 'main'
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Scaffold failed'));
    });

    test('should validate input schema', async () => {
      const args = {
        // Missing required 'name' field
        baseBranch: 'main'
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("Missing required field 'name'"));
    });

    test('should resolve baseBranch when not provided', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });
      mockGit.branches.currentOrNull.resolves('develop');

      const args = {
        name: 'Test Plan'
        // baseBranch not provided - should use current branch
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, true);
      
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      assert.strictEqual(scaffoldArgs[1].baseBranch, 'develop');
    });

    test('should protect default branch when targetBranch equals baseBranch', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });
      // Mark 'main' as a default branch so resolveTargetBranch generates a feature branch
      mockGit.branches.isDefaultBranch.resolves(true);

      const args = {
        name: 'My Test Plan',
        baseBranch: 'main',
        targetBranch: 'main',
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, true);
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      // targetBranch should NOT be 'main' — it must be a generated feature branch
      assert.notStrictEqual(scaffoldArgs[1].targetBranch, 'main');
      assert.ok(scaffoldArgs[1].targetBranch.includes('copilot_plan/'), 
        `Expected feature branch, got: ${scaffoldArgs[1].targetBranch}`);
    });
  });

  suite('handleAddPlanJob', () => {
    test('should add node and return nodeId', async () => {
      // Mock plan exists and is in scaffolding state
      const mockPlanDef = {
        id: 'test-plan',
        status: 'scaffolding',
        jobs: [],
        spec: { status: 'scaffolding' }
      };
      mockPlanRepository.getDefinition.resolves(mockPlanDef);

      // addNode returns a rebuilt PlanInstance
      const rebuiltPlan = {
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
      };
      mockPlanRepository.addNode.resolves(rebuiltPlan);

      // PlanRunner.get returns an in-memory plan to update
      const existingPlan = {
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        stateVersion: 0,
      };
      mockPlanRunner.get.returns(existingPlan);

      const args = {
        planId: 'test-plan',
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Do something',
        work: {
          type: 'shell',
          command: 'npm test'
        }
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.ok(result.jobId);
      assert.ok(result.message.includes('added to scaffolding plan'));
      
      assert.ok(mockPlanRepository.addNode.calledOnce);
      const addNodeArgs = mockPlanRepository.addNode.firstCall.args;
      assert.strictEqual(addNodeArgs[0], 'test-plan');
      assert.strictEqual(addNodeArgs[1].producerId, 'producer-1');
      assert.strictEqual(addNodeArgs[1].name, 'Test Node');
    });

    test('should reject when plan not in scaffolding state', async () => {
      const mockPlanDef = {
        id: 'test-plan',
        status: 'pending',
        spec: { status: 'pending' }
      };
      mockPlanRepository.getDefinition.resolves(mockPlanDef);
      // addNode throws for non-scaffolding plans
      mockPlanRepository.addNode.rejects(new Error("Plan must be in 'scaffolding' status."));

      const args = {
        planId: 'test-plan',
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Do something',
        work: 'npm test'
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('scaffolding'));
    });

    test('should pass work spec through to repository addNode', async () => {
      // Mock plan exists and is in scaffolding state
      const mockPlanDef = {
        id: 'test-plan',
        status: 'scaffolding',
        spec: { status: 'scaffolding' }
      };
      mockPlanRepository.getDefinition.resolves(mockPlanDef);

      const rebuiltPlan = {
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
      };
      mockPlanRepository.addNode.resolves(rebuiltPlan);
      mockPlanRunner.get.returns({
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        stateVersion: 0,
      });

      const args = {
        planId: 'test-plan',
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Do something',
        work: {
          type: 'shell',
          command: 'npm test'
        }
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, true);
      // The work spec should be passed through to the repository
      const nodeSpec = mockPlanRepository.addNode.firstCall.args[1];
      assert.deepStrictEqual(nodeSpec.work, { type: 'shell', command: 'npm test' });
    });

    test('should handle add node errors', async () => {
      const mockPlanDef = {
        id: 'test-plan',
        status: 'scaffolding',
        spec: { status: 'scaffolding' }
      };
      mockPlanRepository.getDefinition.resolves(mockPlanDef);
      mockPlanRepository.addNode.rejects(new Error('Duplicate producerId'));

      const args = {
        planId: 'test-plan',
        producerId: 'producer-1',
        name: 'Test Node',
        task: 'Do something',
        work: 'npm test'
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Duplicate producerId'));
    });

    test('should validate input schema', async () => {
      const args = {
        planId: 'test-plan',
        // Missing required producer_id
        name: 'Test Node',
        task: 'Do something'
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("Missing required field 'producer_id'"));
    });
  });

  suite('handleFinalizePlan', () => {
    test('should call finalize and return plan structure', async () => {
      const mockPlan = {
        id: 'test-plan',
        spec: {
          name: 'Test Plan',
          status: 'pending'
        },
        jobs: new Map([['node-1', { id: 'node-1', producerId: 'producer-1', name: 'Node 1' }]]),
        nodeStates: new Map(),
        producerIdToNodeId: new Map([['producer-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        targetBranch: 'feature/test',
      };

      mockPlanRepository.finalize.resolves(mockPlan);

      // The handler updates the existing in-memory plan
      const existingPlan = {
        id: 'test-plan',
        spec: { status: 'scaffolding', name: 'Test Plan' },
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        stateVersion: 0, isPaused: true,
        baseBranch: 'main', targetBranch: 'feature/test',
      };
      mockPlanRunner.get.returns(existingPlan);

      const args = {
        planId: 'test-plan',
        startPaused: false
      };

      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, 'test-plan');
      assert.ok(result.jobMapping);
      
      assert.ok(mockPlanRepository.finalize.calledWith('test-plan'));
    });

    test('should reject when plan not in scaffolding state', async () => {
      mockPlanRepository.finalize.rejects(new Error('Cannot finalize plan in status \'pending\''));

      const args = {
        planId: 'test-plan'
      };

      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('finalize'));
    });

    test('should validate input schema', async () => {
      const args = {
        // Missing required planId
        startPaused: false
      };

      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("Missing required field 'planId'"));
    });

    test('should handle finalize errors', async () => {
      mockPlanRepository.finalize.rejects(new Error('Circular dependency'));

      const args = {
        planId: 'test-plan'
      };

      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Circular dependency'));
    });

    test('should emit planUpdated event', async () => {
      const mockPlan = {
        id: 'test-plan',
        spec: {
          name: 'Test Plan',
          status: 'pending'
        },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        targetBranch: 'feature/test',
      };

      mockPlanRepository.finalize.resolves(mockPlan);
      mockPlanRunner.get.returns({
        spec: { status: 'scaffolding' },
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        stateVersion: 0, isPaused: true,
      });

      const args = {
        planId: 'test-plan'
      };

      await handleFinalizePlan(args, mockContext);

      assert.ok(mockPlanRunner._state.events.emitPlanUpdated.calledWith('test-plan'));
    });

    test('should recreate state machine with finalized nodes', async () => {
      const mockPlan = {
        id: 'test-plan',
        spec: {
          name: 'Test Plan',
          status: 'pending'
        },
        jobs: new Map([['node-1', { id: 'node-1', producerId: 'producer-1', name: 'Node 1' }]]),
        nodeStates: new Map([['node-1', { status: 'pending' }]]),
        producerIdToNodeId: new Map([['producer-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        targetBranch: 'feature/test',
      };

      mockPlanRepository.finalize.resolves(mockPlan);
      
      const existingPlan = {
        id: 'test-plan',
        spec: { status: 'scaffolding', name: 'Test Plan' },
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        stateVersion: 0, isPaused: true,
        baseBranch: 'main', targetBranch: 'feature/test',
      };
      mockPlanRunner.get.returns(existingPlan);
      
      // Mock state machine factory returns a state machine
      const mockStateMachine = { id: 'sm-1' };
      mockPlanRunner._state.stateMachineFactory.returns(mockStateMachine);

      const args = { planId: 'test-plan', startPaused: true };
      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, true);
      // State machine factory should be called with the updated plan
      assert.ok(mockPlanRunner._state.stateMachineFactory.calledOnce);
      // State machine should be stored in the map
      assert.ok(mockPlanRunner._state.stateMachines.has('test-plan'));
      assert.strictEqual(mockPlanRunner._state.stateMachines.get('test-plan'), mockStateMachine);
      // Listeners should be set up
      assert.ok(mockPlanRunner._lifecycle.setupStateMachineListeners.calledWith(mockStateMachine));
    });

    test('should respect startPaused=false flag', async () => {
      const mockPlan = {
        id: 'test-plan',
        spec: { name: 'Test Plan', status: 'pending' },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        targetBranch: 'feature/test',
      };

      mockPlanRepository.finalize.resolves(mockPlan);
      
      const existingPlan = {
        spec: { status: 'scaffolding' },
        jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
        roots: [], leaves: [], groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        stateVersion: 0, isPaused: true,
      };
      mockPlanRunner.get.returns(existingPlan);

      const args = { planId: 'test-plan', startPaused: false };
      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.paused, false);
      // The existing plan's isPaused should be set to false
      assert.strictEqual(existingPlan.isPaused, false);
    });

    test('should fallback to registerPlan when existing plan not found', async () => {
      const mockPlan = {
        id: 'test-plan',
        spec: { name: 'Test Plan', status: 'pending' },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        targetBranch: 'feature/test',
        baseBranch: 'main',
      };

      mockPlanRepository.finalize.resolves(mockPlan);
      mockPlanRunner.get.returns(undefined); // No existing plan

      const args = { planId: 'test-plan' };
      const result = await handleFinalizePlan(args, mockContext);

      assert.strictEqual(result.success, true);
      // Should register the finalized plan as new
      assert.ok(mockPlanRunner.registerPlan.calledOnce);
      assert.ok(mockPlanRunner.registerPlan.calledWith(mockPlan));
    });
  });

  suite('handleAddPlanJob - delegation', () => {
    test('should delegate to repository and replace in-memory plan topology', async () => {
      const mockPlanDef = {
        id: 'test-plan',
        status: 'scaffolding',
        spec: { status: 'scaffolding' }
      };
      mockPlanRepository.getDefinition.resolves(mockPlanDef);

      // The rebuilt plan from repository.addNode
      const rebuiltNodes = new Map([
        ['node-1', { id: 'node-1', producerId: 'producer-1', name: 'Node 1' }],
        ['node-2', { id: 'node-2', producerId: 'producer-2', name: 'Node 2' }]
      ]);
      const rebuiltNodeStates = new Map([
        ['node-1', { status: 'pending' }],
        ['node-2', { status: 'pending' }]
      ]);
      const rebuiltProducerMap = new Map([
        ['producer-1', 'node-1'],
        ['producer-2', 'node-2']
      ]);
      const rebuiltGroups = new Map([['group-1', { id: 'group-1', name: 'Group 1' }]]);
      const rebuiltGroupStates = new Map([['group-1', { status: 'pending' }]]);
      const rebuiltGroupPaths = new Map([['root/group-1', 'group-1']]);

      const rebuiltPlan = {
        jobs: rebuiltNodes,
        nodeStates: rebuiltNodeStates,
        producerIdToNodeId: rebuiltProducerMap,
        roots: ['node-1'],
        leaves: ['node-2'],
        groups: rebuiltGroups,
        groupStates: rebuiltGroupStates,
        groupPathToId: rebuiltGroupPaths,
      };
      mockPlanRepository.addNode.resolves(rebuiltPlan);

      // The existing in-memory plan
      const existingPlan = {
        jobs: new Map([['node-1', { id: 'node-1' }]]),
        nodeStates: new Map([['node-1', { status: 'pending' }]]),
        producerIdToNodeId: new Map([['producer-1', 'node-1']]),
        roots: ['node-1'],
        leaves: ['node-1'],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        stateVersion: 5,
      };
      mockPlanRunner.get.returns(existingPlan);

      const args = {
        planId: 'test-plan',
        producerId: 'producer-2',
        name: 'Node 2',
        task: 'Do more work',
        dependencies: ['producer-1'],
        group: 'root/group-1',
        work: 'npm run build',
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.jobId, 'producer-2');

      // Verify repository.addNode was called with correct args
      assert.ok(mockPlanRepository.addNode.calledOnce);
      const addNodeArgs = mockPlanRepository.addNode.firstCall.args;
      assert.strictEqual(addNodeArgs[0], 'test-plan');
      assert.strictEqual(addNodeArgs[1].producerId, 'producer-2');
      assert.deepStrictEqual(addNodeArgs[1].dependencies, ['producer-1']);
      assert.strictEqual(addNodeArgs[1].group, 'root/group-1');

      // Verify in-memory plan was replaced with rebuilt data
      assert.strictEqual(existingPlan.jobs.size, 2);
      assert.ok(existingPlan.jobs.has('node-2'));
      assert.strictEqual(existingPlan.nodeStates.size, 2);
      assert.strictEqual(existingPlan.roots.length, 1);
      assert.strictEqual(existingPlan.leaves.length, 1);
      assert.strictEqual(existingPlan.stateVersion, 6);
      // Groups should be updated
      assert.strictEqual(existingPlan.groups.size, 1);
      assert.ok(existingPlan.groups.has('group-1'));

      // Verify planUpdated event emitted
      assert.ok(mockPlanRunner._state.events.emitPlanUpdated.calledWith('test-plan'));
    });

    test('should handle missing existing plan gracefully', async () => {
      const mockPlanDef = {
        id: 'test-plan',
        status: 'scaffolding',
        spec: { status: 'scaffolding' }
      };
      mockPlanRepository.getDefinition.resolves(mockPlanDef);

      const rebuiltPlan = {
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
      };
      mockPlanRepository.addNode.resolves(rebuiltPlan);

      // No existing plan in PlanRunner
      mockPlanRunner.get.returns(undefined);

      const args = {
        planId: 'test-plan',
        producerId: 'producer-1',
        name: 'Node 1',
        task: 'Do something',
        work: 'npm test',
      };

      const result = await handleAddPlanJob(args, mockContext);

      // Should still succeed even without in-memory plan
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.jobId, 'producer-1');
    });

    test('should return error when plan not found', async () => {
      mockPlanRepository.getDefinition.resolves(null);

      const args = {
        planId: 'nonexistent-plan',
        producerId: 'producer-1',
        name: 'Node 1',
        task: 'Do something',
        work: 'npm test',
      };

      const result = await handleAddPlanJob(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes("'nonexistent-plan' not found"));
    });
  });

  suite('handleScaffoldPlan - resolveTargetBranch', () => {
    test('should use current branch as target when on non-default branch', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });
      
      // Current branch is a feature branch (not default)
      mockGit.branches.currentOrNull.resolves('feature/existing');
      mockGit.branches.isDefaultBranch.resolves(false);

      const args = {
        name: 'Test Plan',
        baseBranch: 'main',
        // No targetBranch specified
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, true);
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      // Should adopt current feature branch as target
      assert.strictEqual(scaffoldArgs[1].targetBranch, 'feature/existing');
    });

    test('should generate feature branch when on default branch without target', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });
      
      // Current branch is main (default)
      mockGit.branches.currentOrNull.resolves('main');
      mockGit.branches.isDefaultBranch.resolves(true);

      const args = {
        name: 'My Test Plan',
        baseBranch: 'main',
        // No targetBranch specified
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, true);
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      // Should generate a copilot_plan/ prefixed branch
      assert.ok(scaffoldArgs[1].targetBranch.includes('copilot_plan/'));
    });

    test('should use explicit targetBranch when not a default branch', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });
      
      mockGit.branches.isDefaultBranch.withArgs('feature/custom', '/test/workspace').resolves(false);
      mockGit.branches.exists.resolves(false);

      const args = {
        name: 'Test Plan',
        baseBranch: 'main',
        targetBranch: 'feature/custom',
      };

      const result = await handleScaffoldPlan(args, mockContext);

      assert.strictEqual(result.success, true);
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      assert.strictEqual(scaffoldArgs[1].targetBranch, 'feature/custom');
    });

    test('should use configProvider branch prefix when available', async () => {
      const planId = 'test-plan-id';
      mockPlanRepository.scaffold.resolves({ id: planId });
      
      mockGit.branches.currentOrNull.resolves('main');
      mockGit.branches.isDefaultBranch.resolves(true);

      const mockConfigProvider = {
        getConfig: sandbox.stub().returns('custom-prefix'),
      };

      const contextWithConfig = {
        ...mockContext,
        configProvider: mockConfigProvider,
      };

      const args = {
        name: 'Test Plan',
        baseBranch: 'main',
        targetBranch: 'main', // Same as base - will be protected
      };

      const result = await handleScaffoldPlan(args, contextWithConfig);

      assert.strictEqual(result.success, true);
      const scaffoldArgs = mockPlanRepository.scaffold.firstCall.args;
      // Should use custom prefix from config
      assert.ok(scaffoldArgs[1].targetBranch.startsWith('custom-prefix/'));
    });
  });

  suite('handlePausePlan and handleResumePlan', () => {
    test('handlePausePlan should pause a running plan', async () => {
      mockPlanRunner.pause.returns(true);

      const args = { id: 'test-plan' };
      const result = await handlePausePlan(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('has been paused'));
      assert.ok(mockPlanRunner.pause.calledWith('test-plan'));
    });

    test('handlePausePlan should return failure when pause fails', async () => {
      mockPlanRunner.pause.returns(false);

      const args = { id: 'test-plan' };
      const result = await handlePausePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Failed to pause'));
    });

    test('handlePausePlan should require id field', async () => {
      const args = {}; // Missing id

      const result = await handlePausePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id is required'));
    });

    test('handleResumePlan should resume a paused plan', async () => {
      mockPlanRunner.get.returns({ 
        id: 'test-plan',
        spec: { status: 'pending' }, // Not scaffolding
      });
      mockPlanRunner.resume.resolves(true);

      const args = { id: 'test-plan' };
      const result = await handleResumePlan(args, mockContext);

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('has been resumed'));
      assert.ok(mockPlanRunner.resume.calledWith('test-plan'));
    });

    test('handleResumePlan should return failure when resume fails', async () => {
      mockPlanRunner.get.returns({ 
        id: 'test-plan',
        spec: { status: 'pending' },
      });
      mockPlanRunner.resume.resolves(false);

      const args = { id: 'test-plan' };
      const result = await handleResumePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Failed to resume'));
    });

    test('handleResumePlan should require id field', async () => {
      const args = {}; // Missing id

      const result = await handleResumePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id is required'));
    });

    test('handleResumePlan should block scaffolding plans', async () => {
      // Plan is still in scaffolding state
      mockPlanRunner.get.returns({ 
        id: 'test-plan',
        spec: { status: 'scaffolding' },
      });

      const args = { id: 'test-plan' };
      const result = await handleResumePlan(args, mockContext);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('still under construction'));
      assert.ok(result.error.includes('finalize_copilot_plan'));
      // resume should NOT be called
      assert.ok(mockPlanRunner.resume.notCalled);
    });

    test('handleResumePlan should allow resuming when plan not found in memory', async () => {
      // Plan not found in PlanRunner.get() - could be loading
      mockPlanRunner.get.returns(undefined);
      mockPlanRunner.resume.resolves(true);

      const args = { id: 'test-plan' };
      const result = await handleResumePlan(args, mockContext);

      // Should proceed to resume (let PlanRunner handle missing plan)
      assert.strictEqual(result.success, true);
      assert.ok(mockPlanRunner.resume.calledWith('test-plan'));
    });
  });
});
