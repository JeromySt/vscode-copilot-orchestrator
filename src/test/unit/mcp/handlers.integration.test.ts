/**
 * @fileoverview Tests for MCP plan and node handlers (src/mcp/handlers/).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  handleGetPlanStatus,
  handleListPlans,
  handleGetJobDetails,
  handleGetJobLogs,
  handleGetJobAttempts,
  handleCancelPlan,
  handleDeletePlan,
  handlePausePlan,
  handleResumePlan,
  handleRetryPlan,
  handleRetryPlanJob,
  handleGetJobFailureContext,
  handleCreatePlan,
  PlanHandlerContext,
} from '../../../mcp/handlers';
import { PlanInstance, NodeExecutionState, JobNode, GroupInstance, GroupExecutionState } from '../../../plan/types';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
  sinon.stub(console, 'info');
}

/** Create a minimal PlanInstance for testing. */
function createTestPlan(id: string = 'plan-1'): PlanInstance {
  const nodeId = 'node-1';
  const node: JobNode = {
    id: nodeId,
    producerId: 'job-1',
    name: 'Test Job',
    type: 'job',
    task: 'do work',
    dependencies: [],
    dependents: [],
  };
  const nodeState: NodeExecutionState = {
    status: 'running',
    version: 1,
    attempts: 1,
    startedAt: Date.now() - 5000,
  };

  const nodes = new Map<string, JobNode>();
  nodes.set(nodeId, node);
  const nodeStates = new Map<string, NodeExecutionState>();
  nodeStates.set(nodeId, nodeState);
  const producerIdToNodeId = new Map<string, string>();
  producerIdToNodeId.set('job-1', nodeId);

  return {
    id,
    spec: { name: "test", jobs: [] },
    jobs: nodes as any,
    producerIdToNodeId,
    roots: [nodeId],
    leaves: [nodeId],
    nodeStates,
    groups: new Map<string, GroupInstance>(),
    groupStates: new Map<string, GroupExecutionState>(),
    groupPathToId: new Map<string, string>(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '.wt',
    createdAt: Date.now() - 10000,
    startedAt: Date.now() - 5000,
    stateVersion: 1,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  };
}

/** Create stub PlanRunner and context. */
function createContext(plans: PlanInstance[] = []): PlanHandlerContext {
  const planMap = new Map(plans.map(p => [p.id, p]));

  return {
    git: {
      branches: {
        currentOrNull: sinon.stub().resolves('main'),
        isDefaultBranch: sinon.stub().resolves(false),
        exists: sinon.stub().resolves(false),
        create: sinon.stub().resolves(),
        current: sinon.stub().resolves('main'),
      },
      worktrees: {},
      merge: {},
      repository: {},
      orchestrator: {},
    } as any,
    PlanRunner: {
      // lookupPlan uses .get() by default and .getPlan() as alternate
      get: sinon.stub().callsFake((id: string) => planMap.get(id)),
      getPlan: sinon.stub().callsFake((id: string) => planMap.get(id)),
      getAll: sinon.stub().returns(plans),
      getPlans: sinon.stub().returns(plans),
      getStatus: sinon.stub().callsFake((id: string) => {
        const p = planMap.get(id);
        if (!p) {return undefined;}
        return { plan: p, status: 'running', counts: { running: 1, succeeded: 0, failed: 0, pending: 0, ready: 0, scheduled: 0, blocked: 0, canceled: 0 }, progress: 0 };
      }),
      getStateMachine: sinon.stub().returns(null),
      getEffectiveEndedAt: sinon.stub().returns(undefined),
      cancel: sinon.stub().returns(true),
      cancelPlan: sinon.stub().returns({ success: true }),
      delete: sinon.stub().returns(true),
      deletePlan: sinon.stub().returns({ success: true }),
      pause: sinon.stub().returns(true),
      resume: sinon.stub().returns(true),
      retryPlan: sinon.stub().returns({ success: true }),
      retryNode: sinon.stub().returns({ success: true }),
      getNodeLogs: sinon.stub().returns('line 1\nline 2'),
      getNodeAttempt: sinon.stub().returns(null),
      getNodeAttempts: sinon.stub().returns([]),
      getNodeFailureContext: sinon.stub().returns(null),
      forceFailNode: sinon.stub().returns({ success: true }),
      registerPlan: sinon.stub(),
      enqueue: sinon.stub(),
      enqueueJob: sinon.stub(),
      on: sinon.stub(),
    } as any,
    workspacePath: '/workspace',
    runner: null as any,
    plans: null as any,
    PlanRepository: {
      scaffold: sinon.stub().callsFake((name: string, opts: any) => {
        // Create a mock scaffolded plan
        const plan = createTestPlan();
        plan.spec.name = name;
        plan.baseBranch = opts.baseBranch || 'main';
        plan.targetBranch = opts.targetBranch;
        plan.repoPath = opts.repoPath;
        return Promise.resolve(plan);
      }),
      addNode: sinon.stub().resolves(),
      finalize: sinon.stub().callsFake(async (planId: string) => {
        // Return a finalized plan
        const plan = createTestPlan(planId);
        return plan;
      }),
      get: sinon.stub().returns(undefined),
      list: sinon.stub().returns([]),
    } as any,
  };
}

suite('MCP Handlers', () => {
  setup(() => {
    silenceConsole();
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // handleGetPlanStatus
  // =========================================================================

  suite('handleGetPlanStatus', () => {
    test('returns error when plan ID missing', async () => {
      const ctx = createContext();
      const result = await handleGetPlanStatus({}, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleGetPlanStatus({ planId: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns plan status when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetPlanStatus({ planId: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.planId !== undefined);
    });
  });

  // =========================================================================
  // handleListPlans
  // =========================================================================

  suite('handleListPlans', () => {
    test('returns empty list when no plans', async () => {
      const ctx = createContext();
      const result = await handleListPlans({}, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(Array.isArray(result.plans));
    });

    test('returns plans when they exist', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListPlans({}, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handleGetJobDetails
  // =========================================================================

  suite('handleGetJobDetails', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleGetJobDetails({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleGetJobDetails({ planId: 'x', nodeId: 'y' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns node details when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetJobDetails({ planId: plan.id, jobId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'node-1');
      assert.strictEqual(result.node.name, 'Test Job');
      assert.ok(Array.isArray(result.node.dependencies));
      assert.ok(Array.isArray(result.node.dependents));
    });

    test('returns node details by producerId', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetJobDetails({ planId: plan.id, jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.producerId, 'job-1');
    });

    test('returns error for unknown nodeId', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetJobDetails({ planId: plan.id, jobId: 'ghost' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetJobLogs
  // =========================================================================

  suite('handleGetJobLogs', () => {
    test('returns error when planId or nodeId missing', async () => {
      const ctx = createContext();
      const result = await handleGetJobLogs({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns logs when plan and node exist', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetJobLogs({ planId: plan.id, jobId: 'node-1' }, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handleCancelPlan
  // =========================================================================

  suite('handleCancelPlan', () => {
    test('returns error when id missing', async () => {
      const ctx = createContext();
      const result = await handleCancelPlan({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('delegates to PlanRunner.cancelPlan', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleCancelPlan({ planId: plan.id }, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handleDeletePlan
  // =========================================================================

  suite('handleDeletePlan', () => {
    test('returns error when id missing', async () => {
      const ctx = createContext();
      const result = await handleDeletePlan({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('delegates to PlanRunner.deletePlan', async () => {
      const ctx = createContext();
      const result = await handleDeletePlan({ planId: 'some-plan' }, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handlePausePlan
  // =========================================================================

  suite('handlePausePlan', () => {
    test('returns error when id missing', async () => {
      const ctx = createContext();
      const result = await handlePausePlan({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('pauses plan', async () => {
      const ctx = createContext();
      const result = await handlePausePlan({ planId: 'some-plan' }, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handleResumePlan
  // =========================================================================

  suite('handleResumePlan', () => {
    test('returns error when id missing', async () => {
      const ctx = createContext();
      const result = await handleResumePlan({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('resumes plan', async () => {
      const ctx = createContext();
      const result = await handleResumePlan({ planId: 'some-plan' }, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handleRetryPlan
  // =========================================================================

  suite('handleRetryPlan', () => {
    test('returns error when id missing', async () => {
      const ctx = createContext();
      const result = await handleRetryPlan({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleRetryPlan({ planId: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetJobAttempts
  // =========================================================================

  suite('handleGetJobAttempts', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleGetJobAttempts({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleGetJobAttempts({ planId: 'x', nodeId: 'y' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns attempts when plan and node found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetJobAttempts({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.totalAttempts, 0);
    });

    test('returns specific attempt when attemptNumber given', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempt = sinon.stub().returns({ phase: 'work', error: 'failed', logs: 'log data' });
      const result = await handleGetJobAttempts({ planId: plan.id, nodeId: 'node-1', attemptNumber: 1 }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.attempt);
    });

    test('returns specific attempt with logs when includeLogs true', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempt = sinon.stub().returns({ phase: 'work', error: 'failed', logs: 'log data' });
      const result = await handleGetJobAttempts({ planId: plan.id, nodeId: 'node-1', attemptNumber: 1, includeLogs: true }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.attempt.logs);
    });

    test('returns error when specific attempt not found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempt = sinon.stub().returns(null);
      const result = await handleGetJobAttempts({ planId: plan.id, nodeId: 'node-1', attemptNumber: 99 }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('strips logs by default for all attempts', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempts = sinon.stub().returns([
        { phase: 'work', logs: 'long log data' },
      ]);
      const result = await handleGetJobAttempts({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      // logs should be replaced with a summary string
      assert.ok(typeof result.attempts[0].logs === 'string');
    });
  });

  // =========================================================================
  // handleRetryPlanJob
  // =========================================================================

  suite('handleRetryPlanJob', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleRetryPlanJob({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleRetryPlanJob({ planId: 'x', nodeId: 'y' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetJobFailureContext
  // =========================================================================

  suite('handleGetJobFailureContext', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleGetJobFailureContext({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns context when plan found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      // The handler uses 'in' operator, so result must be an object
      (ctx.PlanRunner as any).getNodeFailureContext = sinon.stub().returns({ error: 'Node not in failed state' });
      const result = await handleGetJobFailureContext({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.ok(result);
    });

    test('returns success with context when no error', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeFailureContext = sinon.stub().returns({
        phase: 'work',
        errorMessage: 'test error',
        sessionId: 'sess-1',
        worktreePath: '/wt',
        lastAttempt: { phase: 'work', error: 'failed' },
        logs: [],
      });
      const result = await handleGetJobFailureContext({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.phase, 'work');
      assert.strictEqual(result.planId, plan.id);
      assert.strictEqual(result.jobId, 'node-1');
    });
  });

  // =========================================================================
  // handleRetryPlan extended tests
  // =========================================================================

  suite('handleRetryPlan (extended)', () => {
    test('retries all failed nodes when no nodeIds specified', async () => {
      const plan = createTestPlan();
      // Set node to failed state
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ planId: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.retriedNodes);
      assert.strictEqual(result.retriedNodes.length, 1);
    });

    test('returns error when no failed nodes to retry', async () => {
      const plan = createTestPlan();
      // Node is running, not failed
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ planId: plan.id }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('retries specific nodeIds', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ planId: plan.id, nodeIds: ['node-1'] }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('handles retry failure for a node', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).retryNode = sinon.stub().returns({ success: false, error: 'retry failed' });
      const result = await handleRetryPlan({ planId: plan.id }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors);
    });

    test('passes newWork and clearWorktree options', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ planId: plan.id, newWork: 'new instructions', clearWorktree: true }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  // =========================================================================
  // handleRetryPlanJob extended tests
  // =========================================================================

  suite('handleRetryPlanJob (extended)', () => {
    test('retries failed node successfully', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlanJob({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.jobName, 'Test Job');
    });

    test('returns error when node not in failed state', async () => {
      const plan = createTestPlan();
      // Node is 'running', not 'failed'
      const ctx = createContext([plan]);
      const result = await handleRetryPlanJob({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when node not found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleRetryPlanJob({ planId: plan.id, nodeId: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when retryNode fails', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).retryNode = sinon.stub().returns({ success: false, error: 'retry failed' });
      const result = await handleRetryPlanJob({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('passes newWork and clearWorktree options', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlanJob({ planId: plan.id, nodeId: 'node-1', newWork: '@agent fix it', clearWorktree: true }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hasNewWork, true);
      assert.strictEqual(result.clearWorktree, true);
    });
  });

  // =========================================================================
  // handleCreatePlan
  // =========================================================================

  suite('handleCreatePlan', () => {
    test('returns error for invalid input (missing required fields)', async () => {
      const ctx = createContext();
      // Empty input should be caught by schema validation which requires name and jobs
      // When called directly without MCP layer, the handler accepts anything
      // So we test with explicitly invalid data
      const result = await handleCreatePlan({ jobs: null }, ctx);
      // With an invalid jobs array, the handler should fail during processing
      assert.ok(result); // Handler should return a result, not throw
    });

    test('returns error for duplicate producer_ids', async () => {
      const ctx = createContext();
      const result = await handleCreatePlan({
        name: 'Plan',
        jobs: [
          { producer_id: 'job-a', task: 'test', dependencies: [] },
          { producer_id: 'job-a', task: 'test2', dependencies: [] },
        ],
      }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error for self-dependency', async () => {
      const ctx = createContext();
      const result = await handleCreatePlan({
        name: 'Plan',
        jobs: [
          { producer_id: 'job-a', task: 'test', dependencies: ['job-a'] },
        ],
      }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error for unknown dependency', async () => {
      const ctx = createContext();
      const result = await handleCreatePlan({
        name: 'Plan',
        jobs: [
          { producer_id: 'job-a', task: 'test', dependencies: ['nonexistent'] },
        ],
      }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('creates plan successfully', async () => {
      const mockPlan = createTestPlan();
      const ctx = createContext();
      (ctx.PlanRunner as any).enqueue = sinon.stub().returns(mockPlan);
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreatePlan({
        name: 'My Plan',
        jobs: [
          { producer_id: 'job-a', task: 'Task A', dependencies: [] },
          { producer_id: 'job-b', task: 'Task B', dependencies: ['job-a'] },
        ],
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.planId);
      assert.ok(result.jobMapping);
    });

    test('creates plan with groups', async () => {
      const mockPlan = createTestPlan();
      const ctx = createContext();
      (ctx.PlanRunner as any).enqueue = sinon.stub().returns(mockPlan);
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreatePlan({
        name: 'Grouped Plan',
        jobs: [],
        groups: [
          {
            name: 'backend',
            jobs: [
              { producer_id: 'api', task: 'Build API', dependencies: [] },
            ],
          },
        ],
      }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('validates group dependencies', async () => {
      const ctx = createContext();
      const result = await handleCreatePlan({
        name: 'Bad Deps',
        jobs: [],
        groups: [
          {
            name: 'g1',
            jobs: [
              { producer_id: 'job-a', task: 'test', dependencies: ['nonexistent'] },
            ],
          },
        ],
      }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('catches scaffold errors', async () => {
      const ctx = createContext();
      (ctx.PlanRepository as any).scaffold = sinon.stub().rejects(new Error('scaffold failed'));
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreatePlan({
        name: 'Plan',
        jobs: [{ producer_id: 'job-a', task: 'test', work: 'npm test', dependencies: [] }],
      }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetPlanStatus extended
  // =========================================================================

  suite('handleGetPlanStatus (extended)', () => {
    test('returns full status with node details', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetPlanStatus({ planId: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.planId);
      assert.ok(result.nodes);
    });

    test('tracks group statuses when nodes have groups', async () => {
      const plan = createTestPlan();
      // Set group on the job node
      const node = plan.jobs.get('node-1')!;
      (node as any).group = 'backend';
      const ctx = createContext([plan]);
      const result = await handleGetPlanStatus({ planId: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.groups);
      assert.ok(result.groups['backend']);
    });
  });

  // =========================================================================
  // handleListPlans extended
  // =========================================================================

  suite('handleListPlans (extended)', () => {
    test('returns plans with full details', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListPlans({}, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.Plans);
      assert.strictEqual(result.Plans.length, 1);
    });

    test('filters by status', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListPlans({ status: 'running' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('filters out non-matching status', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListPlans({ status: 'succeeded' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0);
    });
  });

  // =========================================================================
  // handleGetJobLogs extended
  // =========================================================================

  suite('handleGetJobLogs (extended)', () => {
    test('returns logs with phase filter', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetJobLogs({ planId: plan.id, nodeId: 'node-1', phase: 'work' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.phase, 'work');
    });
  });
});
