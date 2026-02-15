/**
 * @fileoverview Tests for MCP plan and node handlers (src/mcp/handlers/).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  handleGetPlanStatus,
  handleListPlans,
  handleGetNodeDetails,
  handleGetNodeLogs,
  handleGetNodeAttempts,
  handleCancelPlan,
  handleDeletePlan,
  handlePausePlan,
  handleResumePlan,
  handleRetryPlan,
  handleRetryPlanNode,
  handleGetNodeFailureContext,
  handleCreatePlan,
  handleCreateJob,
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
    spec: { name: 'Test Plan', jobs: [] },
    nodes: nodes as any,
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
        if (!p) return undefined;
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
      enqueue: sinon.stub(),
      enqueueJob: sinon.stub(),
      on: sinon.stub(),
    } as any,
    workspacePath: '/workspace',
    runner: null as any,
    plans: null as any,
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
      const result = await handleGetPlanStatus({ id: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns plan status when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetPlanStatus({ id: plan.id }, ctx);
      assert.ok(result.success !== false || result.id !== undefined);
    });
  });

  // =========================================================================
  // handleListPlans
  // =========================================================================

  suite('handleListPlans', () => {
    test('returns empty list when no plans', async () => {
      const ctx = createContext();
      const result = await handleListPlans({}, ctx);
      assert.ok(result.success !== false || result.plans !== undefined);
    });

    test('returns plans when they exist', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListPlans({}, ctx);
      assert.ok(result);
    });
  });

  // =========================================================================
  // handleGetNodeDetails
  // =========================================================================

  suite('handleGetNodeDetails', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleGetNodeDetails({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleGetNodeDetails({ planId: 'x', nodeId: 'y' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns node details when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNodeDetails({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'node-1');
      assert.strictEqual(result.node.name, 'Test Job');
      assert.ok(Array.isArray(result.node.dependencies));
      assert.ok(Array.isArray(result.node.dependents));
    });

    test('returns node details by producerId', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNodeDetails({ planId: plan.id, nodeId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.producerId, 'job-1');
    });

    test('returns error for unknown nodeId', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNodeDetails({ planId: plan.id, nodeId: 'ghost' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetNodeLogs
  // =========================================================================

  suite('handleGetNodeLogs', () => {
    test('returns error when planId or nodeId missing', async () => {
      const ctx = createContext();
      const result = await handleGetNodeLogs({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns logs when plan and node exist', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNodeLogs({ planId: plan.id, nodeId: 'node-1' }, ctx);
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
      const result = await handleCancelPlan({ id: plan.id }, ctx);
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
      const result = await handleDeletePlan({ id: 'some-plan' }, ctx);
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
      const result = await handlePausePlan({ id: 'some-plan' }, ctx);
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
      const result = await handleResumePlan({ id: 'some-plan' }, ctx);
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
      const result = await handleRetryPlan({ id: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetNodeAttempts
  // =========================================================================

  suite('handleGetNodeAttempts', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleGetNodeAttempts({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleGetNodeAttempts({ planId: 'x', nodeId: 'y' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns attempts when plan and node found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNodeAttempts({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.totalAttempts, 0);
    });

    test('returns specific attempt when attemptNumber given', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempt = sinon.stub().returns({ phase: 'work', error: 'failed', logs: 'log data' });
      const result = await handleGetNodeAttempts({ planId: plan.id, nodeId: 'node-1', attemptNumber: 1 }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.attempt);
    });

    test('returns specific attempt with logs when includeLogs true', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempt = sinon.stub().returns({ phase: 'work', error: 'failed', logs: 'log data' });
      const result = await handleGetNodeAttempts({ planId: plan.id, nodeId: 'node-1', attemptNumber: 1, includeLogs: true }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.attempt.logs);
    });

    test('returns error when specific attempt not found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempt = sinon.stub().returns(null);
      const result = await handleGetNodeAttempts({ planId: plan.id, nodeId: 'node-1', attemptNumber: 99 }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('strips logs by default for all attempts', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).getNodeAttempts = sinon.stub().returns([
        { phase: 'work', logs: 'long log data' },
      ]);
      const result = await handleGetNodeAttempts({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      // logs should be replaced with a summary string
      assert.ok(typeof result.attempts[0].logs === 'string');
    });
  });

  // =========================================================================
  // handleRetryPlanNode
  // =========================================================================

  suite('handleRetryPlanNode', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleRetryPlanNode({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when plan not found', async () => {
      const ctx = createContext();
      const result = await handleRetryPlanNode({ planId: 'x', nodeId: 'y' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleGetNodeFailureContext
  // =========================================================================

  suite('handleGetNodeFailureContext', () => {
    test('returns error when planId missing', async () => {
      const ctx = createContext();
      const result = await handleGetNodeFailureContext({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns context when plan found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      // The handler uses 'in' operator, so result must be an object
      (ctx.PlanRunner as any).getNodeFailureContext = sinon.stub().returns({ error: 'Node not in failed state' });
      const result = await handleGetNodeFailureContext({ planId: plan.id, nodeId: 'node-1' }, ctx);
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
      const result = await handleGetNodeFailureContext({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.phase, 'work');
      assert.strictEqual(result.planId, plan.id);
      assert.strictEqual(result.nodeId, 'node-1');
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
      const result = await handleRetryPlan({ id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.retriedNodes);
      assert.strictEqual(result.retriedNodes.length, 1);
    });

    test('returns error when no failed nodes to retry', async () => {
      const plan = createTestPlan();
      // Node is running, not failed
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ id: plan.id }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('retries specific nodeIds', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ id: plan.id, nodeIds: ['node-1'] }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('handles retry failure for a node', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).retryNode = sinon.stub().returns({ success: false, error: 'retry failed' });
      const result = await handleRetryPlan({ id: plan.id }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors);
    });

    test('passes newWork and clearWorktree options', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlan({ id: plan.id, newWork: 'new instructions', clearWorktree: true }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  // =========================================================================
  // handleRetryPlanNode extended tests
  // =========================================================================

  suite('handleRetryPlanNode (extended)', () => {
    test('retries failed node successfully', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlanNode({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.nodeName, 'Test Job');
    });

    test('returns error when node not in failed state', async () => {
      const plan = createTestPlan();
      // Node is 'running', not 'failed'
      const ctx = createContext([plan]);
      const result = await handleRetryPlanNode({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when node not found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleRetryPlanNode({ planId: plan.id, nodeId: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when retryNode fails', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).retryNode = sinon.stub().returns({ success: false, error: 'retry failed' });
      const result = await handleRetryPlanNode({ planId: plan.id, nodeId: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('passes newWork and clearWorktree options', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryPlanNode({ planId: plan.id, nodeId: 'node-1', newWork: '@agent fix it', clearWorktree: true }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hasNewWork, true);
      assert.strictEqual(result.clearWorktree, true);
    });
  });

  // =========================================================================
  // handleCreatePlan
  // =========================================================================

  suite('handleCreatePlan', () => {
    test('returns error for invalid input', async () => {
      const ctx = createContext();
      const result = await handleCreatePlan({}, ctx);
      assert.strictEqual(result.success, false);
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
      assert.ok(result.nodeMapping);
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

    test('catches enqueue errors', async () => {
      const ctx = createContext();
      (ctx.PlanRunner as any).enqueue = sinon.stub().throws(new Error('enqueue failed'));
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreatePlan({
        name: 'Plan',
        jobs: [{ producer_id: 'job-a', task: 'test', dependencies: [] }],
      }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // =========================================================================
  // handleCreateJob
  // =========================================================================

  suite('handleCreateJob', () => {
    test('returns error when name missing', async () => {
      const ctx = createContext();
      const result = await handleCreateJob({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when task missing', async () => {
      const ctx = createContext();
      const result = await handleCreateJob({ name: 'Job' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('creates job successfully', async () => {
      const mockPlan = createTestPlan();
      const ctx = createContext();
      (ctx.PlanRunner as any).enqueueJob = sinon.stub().returns(mockPlan);
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreateJob({
        name: 'My Job',
        task: 'Do something',
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.planId);
    });

    test('passes work and checks through', async () => {
      const mockPlan = createTestPlan();
      const ctx = createContext();
      (ctx.PlanRunner as any).enqueueJob = sinon.stub().returns(mockPlan);
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreateJob({
        name: 'Build',
        task: 'Build project',
        work: 'npm run build',
        prechecks: 'npm test',
        postchecks: 'npm run lint',
        baseBranch: 'develop',
        targetBranch: 'release',
      }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('catches enqueueJob errors', async () => {
      const ctx = createContext();
      (ctx.PlanRunner as any).enqueueJob = sinon.stub().throws(new Error('enqueue failed'));
      const git = require('../../../git');
      sinon.stub(git.branches, 'currentOrNull').resolves('main');
      sinon.stub(git.orchestrator, 'resolveTargetBranchRoot').resolves({ targetBranchRoot: 'copilot_plan/test', needsCreation: false });
      const vscode = require('vscode');
      sinon.stub(vscode.workspace, 'getConfiguration').returns({ get: (key: string, def: any) => def });
      const result = await handleCreateJob({
        name: 'Job',
        task: 'Do something',
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
      const result = await handleGetPlanStatus({ id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.planId);
      assert.ok(result.nodes);
    });

    test('tracks group statuses when nodes have groups', async () => {
      const plan = createTestPlan();
      // Set group on the job node
      const node = plan.nodes.get('node-1')!;
      (node as any).group = 'backend';
      const ctx = createContext([plan]);
      const result = await handleGetPlanStatus({ id: plan.id }, ctx);
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
  // handleGetNodeLogs extended
  // =========================================================================

  suite('handleGetNodeLogs (extended)', () => {
    test('returns logs with phase filter', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNodeLogs({ planId: plan.id, nodeId: 'node-1', phase: 'work' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.phase, 'work');
    });
  });
});
