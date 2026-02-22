/**
 * @fileoverview Comprehensive tests for plan handler files.
 * Covers createPlanHandler, getPlanHandler, jobDetailsHandler,
 * cancelDeleteHandler, pauseResumeHandler, retryJobHandler,
 * retryPlanHandler, updateJobHandler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as modelDiscovery from '../../../agent/modelDiscovery';

// Helpers
function makeMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    enqueue: sinon.stub().returns(makeMockPlan()),
    enqueueJob: sinon.stub().returns(makeMockPlan()),
    get: sinon.stub().returns(undefined),
    getPlan: sinon.stub().returns(undefined),
    getAll: sinon.stub().returns([]),
    getStatus: sinon.stub().returns(undefined),
    getStateMachine: sinon.stub().returns(undefined),
    getNodeLogs: sinon.stub().returns(''),
    getNodeAttempt: sinon.stub().returns(null),
    getNodeAttempts: sinon.stub().returns([]),
    cancel: sinon.stub().returns(true),
    delete: sinon.stub().returns(true),
    pause: sinon.stub().returns(true),
    resume: sinon.stub().resolves(true),
    retryNode: sinon.stub().resolves({ success: true }),
    getNodeFailureContext: sinon.stub().returns({ error: 'not found' }),
    getEffectiveEndedAt: sinon.stub().returns(undefined),
    forceFailNode: sinon.stub().resolves(),
    savePlan: sinon.stub(),
    emit: sinon.stub(),
    ...overrides,
  };
}

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    jobs: new Map(),
    producerIdToNodeId: new Map(),
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: new Map(),
    repoPath: '/workspace',
    baseBranch: 'main',
    targetBranch: 'copilot_plan/test',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    startedAt: undefined,
    endedAt: undefined,
    maxParallel: 4,
    cleanUpSuccessfulWork: true,
    isPaused: false,
    workSummary: undefined,
    ...overrides,
  };
}

function makeCtx(runnerOverrides?: Record<string, any>): any {
  return {
    PlanRunner: makeMockPlanRunner(runnerOverrides),
    workspacePath: '/mock/workspace',
    runner: null,
    plans: null,
  };
}

suite('Plan Handlers', () => {
  let modelStub: sinon.SinonStub;

  setup(() => {
    modelStub = sinon.stub(modelDiscovery, 'getCachedModels').resolves({
      models: [{ id: 'gpt-5', vendor: 'openai', family: 'gpt-5', tier: 'standard' }],
      rawChoices: ['gpt-5'],
      discoveredAt: Date.now(),
    });
  });

  teardown(() => {
    sinon.restore();
  });

  // ===== cancelDeleteHandler =====
  suite('handleCancelPlan', () => {
    test('should return error when id is missing', async () => {
      const { handleCancelPlan } = require('../../../mcp/handlers/plan/cancelDeleteHandler');
      const result = await handleCancelPlan({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId is required'));
    });

    test('should cancel plan successfully', async () => {
      const { handleCancelPlan } = require('../../../mcp/handlers/plan/cancelDeleteHandler');
      const ctx = makeCtx();
      const result = await handleCancelPlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('canceled'));
    });

    test('should handle cancel failure', async () => {
      const { handleCancelPlan } = require('../../../mcp/handlers/plan/cancelDeleteHandler');
      const ctx = makeCtx({ cancel: sinon.stub().returns(false) });
      const result = await handleCancelPlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Failed'));
    });
  });

  suite('handleDeletePlan', () => {
    test('should return error when id is missing', async () => {
      const { handleDeletePlan } = require('../../../mcp/handlers/plan/cancelDeleteHandler');
      const result = await handleDeletePlan({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should delete plan successfully', async () => {
      const { handleDeletePlan } = require('../../../mcp/handlers/plan/cancelDeleteHandler');
      const ctx = makeCtx();
      const result = await handleDeletePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('deleted'));
    });

    test('should handle delete failure', async () => {
      const { handleDeletePlan } = require('../../../mcp/handlers/plan/cancelDeleteHandler');
      const ctx = makeCtx({ delete: sinon.stub().returns(false) });
      const result = await handleDeletePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // ===== pauseResumeHandler =====
  suite('handlePausePlan', () => {
    test('should return error when id is missing', async () => {
      const { handlePausePlan } = require('../../../mcp/handlers/plan/pauseResumeHandler');
      const result = await handlePausePlan({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should pause plan successfully', async () => {
      const { handlePausePlan } = require('../../../mcp/handlers/plan/pauseResumeHandler');
      const ctx = makeCtx();
      const result = await handlePausePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('paused'));
    });

    test('should handle pause failure', async () => {
      const { handlePausePlan } = require('../../../mcp/handlers/plan/pauseResumeHandler');
      const ctx = makeCtx({ pause: sinon.stub().returns(false) });
      const result = await handlePausePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleResumePlan', () => {
    test('should return error when id is missing', async () => {
      const { handleResumePlan } = require('../../../mcp/handlers/plan/pauseResumeHandler');
      const result = await handleResumePlan({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should resume plan successfully', async () => {
      const { handleResumePlan } = require('../../../mcp/handlers/plan/pauseResumeHandler');
      const ctx = makeCtx();
      const result = await handleResumePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('resumed'));
    });

    test('should handle resume failure', async () => {
      const { handleResumePlan } = require('../../../mcp/handlers/plan/pauseResumeHandler');
      const ctx = makeCtx({ resume: sinon.stub().resolves(false) });
      const result = await handleResumePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // ===== getPlanHandler =====
  suite('handleGetPlanStatus', () => {
    test('should return error when id is missing', async () => {
      const { handleGetPlanStatus } = require('../../../mcp/handlers/plan/getPlanHandler');
      const result = await handleGetPlanStatus({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when plan not found', async () => {
      const { handleGetPlanStatus } = require('../../../mcp/handlers/plan/getPlanHandler');
      const ctx = makeCtx();
      const result = await handleGetPlanStatus({ planId: 'not-found' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should return plan status with nodes', async () => {
      const { handleGetPlanStatus } = require('../../../mcp/handlers/plan/getPlanHandler');
      const plan = makeMockPlan({
        targetBranch: 'feature/test',
      });
      const jobNode = {
        id: 'node-1', producerId: 'build', name: 'Build',
        type: 'job', dependencies: [], dependents: [],
        task: 'Build', work: 'npm build', group: 'backend',
      };
      plan.jobs.set('node-1', jobNode);
      plan.nodeStates.set('node-1', {
        status: 'succeeded', attempts: 1, startedAt: Date.now(),
        endedAt: Date.now(), completedCommit: 'abc123',
        mergedToTarget: true, worktreePath: '/wt/1',
      });

      const ctx = makeCtx({
        getStatus: sinon.stub().returns({
          plan,
          status: 'succeeded',
          counts: { succeeded: 1, failed: 0, running: 0, pending: 0 },
          progress: 1.0,
        }),
        getEffectiveEndedAt: sinon.stub().returns(Date.now()),
      });

      const result = await handleGetPlanStatus({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'succeeded');
      assert.strictEqual(result.progress, 100);
      assert.ok(result.nodes);
      assert.strictEqual(result.nodes.length, 1);
      assert.ok(result.groups);
      assert.ok(result.groups['backend']);
    });

    test('should handle nodes with various statuses in groups', async () => {
      const { handleGetPlanStatus } = require('../../../mcp/handlers/plan/getPlanHandler');
      const plan = makeMockPlan();
      // Add nodes with different statuses
      const statuses = ['succeeded', 'failed', 'running', 'pending', 'blocked', 'scheduled'];
      for (let i = 0; i < statuses.length; i++) {
        const node = { id: `n-${i}`, producerId: `job-${i}`, name: `Job ${i}`, type: 'job', dependencies: [], dependents: [], group: 'grp' };
        plan.jobs.set(`n-${i}`, node);
        plan.nodeStates.set(`n-${i}`, { status: statuses[i], attempts: 1 });
      }
      const ctx = makeCtx({
        getStatus: sinon.stub().returns({
          plan, status: 'running',
          counts: { succeeded: 1, failed: 1, running: 1, pending: 1 },
          progress: 0.5,
        }),
      });
      const result = await handleGetPlanStatus({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.groups);
    });
  });

  suite('handleListPlans', () => {
    test('should return empty list when no plans', async () => {
      const { handleListPlans } = require('../../../mcp/handlers/plan/getPlanHandler');
      const ctx = makeCtx();
      const result = await handleListPlans({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0);
    });

    test('should return plans sorted by creation time', async () => {
      const { handleListPlans } = require('../../../mcp/handlers/plan/getPlanHandler');
      const plan1 = makeMockPlan({ id: 'p1', createdAt: 1000 });
      const plan2 = makeMockPlan({ id: 'p2', createdAt: 2000 });
      const sm = { computePlanStatus: sinon.stub().returns('running'), getStatusCounts: sinon.stub().returns({}) };
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan1, plan2]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await handleListPlans({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 2);
    });

    test('should filter by status', async () => {
      const { handleListPlans } = require('../../../mcp/handlers/plan/getPlanHandler');
      const plan = makeMockPlan({ id: 'p1', createdAt: 1000 });
      const sm = { computePlanStatus: sinon.stub().returns('failed'), getStatusCounts: sinon.stub().returns({}) };
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await handleListPlans({ status: 'running' }, ctx);
      assert.strictEqual(result.count, 0);
    });
  });

  // ===== jobDetailsHandler =====
  suite('handleGetJobDetails', () => {
    test('should return error when planId/nodeId missing', async () => {
      const { handleGetJobDetails } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const result = await handleGetJobDetails({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when plan not found', async () => {
      const { handleGetJobDetails } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const result = await handleGetJobDetails({ planId: 'x', jobId: 'y' }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return node details by ID', async () => {
      const { handleGetJobDetails } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', producerId: 'build', name: 'Build', type: 'job', dependencies: [], dependents: [], task: 'Build it', work: 'npm build' };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'running', attempts: 1, scheduledAt: 100, startedAt: 200, worktreePath: '/wt' });
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      const result = await handleGetJobDetails({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'n1');
    });

    test('should lookup node by producer_id', async () => {
      const { handleGetJobDetails } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', producerId: 'build', name: 'Build', type: 'job', dependencies: [], dependents: [], task: 'T', work: 'W' };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'pending', attempts: 0 });
      plan.producerIdToNodeId.set('build', 'n1');
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      const result = await handleGetJobDetails({ planId: 'plan-1', jobId: 'build' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when node not found', async () => {
      const { handleGetJobDetails } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      const result = await handleGetJobDetails({ planId: 'plan-1', jobId: 'missing' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleGetJobLogs', () => {
    test('should return error when fields missing', async () => {
      const { handleGetJobLogs } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const result = await handleGetJobLogs({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return logs for a node', async () => {
      const { handleGetJobLogs } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'running' });
      const ctx = makeCtx({
        get: sinon.stub().returns(plan),
        getNodeLogs: sinon.stub().returns('log output'),
      });
      const result = await handleGetJobLogs({ planId: 'plan-1', jobId: 'n1', phase: 'work' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.logs, 'log output');
      assert.strictEqual(result.phase, 'work');
    });
  });

  suite('handleGetJobAttempts', () => {
    test('should return error when fields missing', async () => {
      const { handleGetJobAttempts } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const result = await handleGetJobAttempts({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return specific attempt', async () => {
      const { handleGetJobAttempts } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const attempt = { number: 1, status: 'failed', logs: 'error log' };
      const ctx = makeCtx({
        get: sinon.stub().returns(plan),
        getNodeAttempt: sinon.stub().returns(attempt),
      });
      const result = await handleGetJobAttempts({ planId: 'plan-1', jobId: 'n1', attemptNumber: 1 }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.attempt);
    });

    test('should return error for missing attempt', async () => {
      const { handleGetJobAttempts } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        get: sinon.stub().returns(plan),
        getNodeAttempt: sinon.stub().returns(null),
      });
      const result = await handleGetJobAttempts({ planId: 'plan-1', jobId: 'n1', attemptNumber: 99 }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('should return all attempts without logs by default', async () => {
      const { handleGetJobAttempts } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const attempts = [
        { number: 1, status: 'failed', logs: 'log1' },
        { number: 2, status: 'failed', logs: 'log2' },
      ];
      const ctx = makeCtx({
        get: sinon.stub().returns(plan),
        getNodeAttempts: sinon.stub().returns(attempts),
      });
      const result = await handleGetJobAttempts({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.totalAttempts, 2);
    });

    test('should include logs when includeLogs is true', async () => {
      const { handleGetJobAttempts } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const attempts = [{ number: 1, status: 'failed', logs: 'log1' }];
      const ctx = makeCtx({
        get: sinon.stub().returns(plan),
        getNodeAttempts: sinon.stub().returns(attempts),
      });
      const result = await handleGetJobAttempts({ planId: 'plan-1', jobId: 'n1', includeLogs: true }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts[0].logs, 'log1');
    });

    test('should include attempt with logs when includeLogs for single attempt', async () => {
      const { handleGetJobAttempts } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const attempt = { number: 1, status: 'failed', logs: 'log1' };
      const ctx = makeCtx({
        get: sinon.stub().returns(plan),
        getNodeAttempt: sinon.stub().returns(attempt),
      });
      const result = await handleGetJobAttempts({ planId: 'plan-1', jobId: 'n1', attemptNumber: 1, includeLogs: true }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempt.logs, 'log1');
    });
  });

  suite('handleGetJobFailureContext', () => {
    test('should return error when fields missing', async () => {
      const { handleGetJobFailureContext } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const result = await handleGetJobFailureContext({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return failure context', async () => {
      const { handleGetJobFailureContext } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build' };
      plan.jobs.set('n1', node);
      const ctx = makeCtx({
        getNodeFailureContext: sinon.stub().returns({
          phase: 'work', errorMessage: 'Build failed',
          sessionId: 'sess-1', worktreePath: '/wt',
          lastAttempt: {}, logs: 'error logs',
        }),
        getPlan: sinon.stub().returns(plan),
      });
      const result = await handleGetJobFailureContext({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.phase, 'work');
    });

    test('should return error on failure context error', async () => {
      const { handleGetJobFailureContext } = require('../../../mcp/handlers/plan/jobDetailsHandler');
      const ctx = makeCtx({
        getNodeFailureContext: sinon.stub().returns({ error: 'Node not found' }),
      });
      const result = await handleGetJobFailureContext({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // ===== createPlanHandler =====
  suite('handleCreatePlan', () => {
    test.skip('should create a plan successfully', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const plan = makeMockPlan({
        isPaused: false,
        jobs: new Map([['n1', {}]]),
        producerIdTojobId: new Map([['build', 'n1']]),
      });
      const ctx = makeCtx({ enqueue: sinon.stub().returns(plan) });
      const result = await handleCreatePlan({
        name: 'Test Plan',
        jobs: [{ producerId: 'build', task: 'Build it', dependencies: [] }],
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.planId);
    });

    test.skip('should create paused plan', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const plan = makeMockPlan({
        isPaused: true,
        jobs: new Map([['n1', {}]]),
        producerIdTojobId: new Map([['build', 'n1']]),
      });
      const ctx = makeCtx({ enqueue: sinon.stub().returns(plan) });
      const result = await handleCreatePlan({
        name: 'Test Plan',
        startPaused: true,
        jobs: [{ producerId: 'build', task: 'Build', dependencies: [] }],
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.paused, true);
    });

    test('should return error for duplicate producer_ids', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const result = await handleCreatePlan({
        name: 'Test',
        jobs: [
          { producerId: 'build', task: 'Build', dependencies: [] },
          { producerId: 'build', task: 'Build2', dependencies: [] },
        ],
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Duplicate'));
    });

    test('should return error for unknown dependency', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const result = await handleCreatePlan({
        name: 'Test',
        jobs: [
          { producerId: 'build', task: 'Build', dependencies: ['nonexistent'] },
        ],
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('unknown dependency'));
    });

    test('should return error for self-dependency', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const result = await handleCreatePlan({
        name: 'Test',
        jobs: [
          { producerId: 'build', task: 'Build', dependencies: ['build'] },
        ],
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('cannot depend on itself'));
    });

    test.skip('should handle groups with jobs', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const plan = makeMockPlan({
        jobs: new Map([['n1', {}], ['n2', {}]]),
        producerIdTojobId: new Map([['grp/build', 'n1'], ['grp/test', 'n2']]),
      });
      const ctx = makeCtx({ enqueue: sinon.stub().returns(plan) });
      const result = await handleCreatePlan({
        name: 'Grouped Plan',
        jobs: [],
        groups: [{
          name: 'grp',
          jobs: [
            { producerId: 'build', task: 'Build', dependencies: [] },
            { producerId: 'test', task: 'Test', dependencies: ['build'] },
          ],
        }],
      }, ctx);
      assert.strictEqual(result.success, true);
    });

    test.skip('should handle nested groups', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const plan = makeMockPlan({
        jobs: new Map([['n1', {}]]),
        producerIdTojobId: new Map([['phase1/sub/build', 'n1']]),
      });
      const ctx = makeCtx({ enqueue: sinon.stub().returns(plan) });
      const result = await handleCreatePlan({
        name: 'Nested Plan',
        jobs: [],
        groups: [{
          name: 'phase1',
          groups: [{
            name: 'sub',
            jobs: [{ producerId: 'build', task: 'Build', dependencies: [] }],
          }],
        }],
      }, ctx);
      assert.strictEqual(result.success, true);
    });

    test.skip('should handle enqueue throwing error', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const ctx = makeCtx({ enqueue: sinon.stub().throws(new Error('Enqueue failed')) });
      const result = await handleCreatePlan({
        name: 'Test',
        jobs: [{ producerId: 'build', task: 'Build', dependencies: [] }],
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Enqueue failed'));
    });

    test.skip('should validate group dependency across groups', async () => {
      const { handleCreatePlan } = require('../../../mcp/handlers/plan/createPlanHandler');
      const result = await handleCreatePlan({
        name: 'Cross Group',
        jobs: [],
        groups: [{
          name: 'grp1',
          jobs: [{ producerId: 'build', task: 'Build', dependencies: [] }],
        }, {
          name: 'grp2',
          jobs: [{ producerId: 'test', task: 'Test', dependencies: ['grp1/build'] }],
        }],
      }, makeCtx({ enqueue: sinon.stub().returns(makeMockPlan({
        jobs: new Map([['n1', {}], ['n2', {}]]),
        producerIdTojobId: new Map([['grp1/build', 'n1'], ['grp2/test', 'n2']]),
      })) }));
      assert.strictEqual(result.success, true);
    });
  });

  // ===== retryPlanHandler =====
  suite('handleRetryPlan', () => {
    test('should return error when id is missing', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const result = await handleRetryPlan({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when plan not found', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const result = await handleRetryPlan({ planId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should retry all failed nodes', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const plan = makeMockPlan();
      plan.jobs.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryPlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.retriedNodes.length, 1);
    });

    test('should retry specific nodes', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const plan = makeMockPlan();
      plan.jobs.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryPlan({ planId: 'plan-1', nodeIds: ['n1'] }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when no failed nodes', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const plan = makeMockPlan();
      plan.nodeStates.set('n1', { status: 'succeeded' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleRetryPlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('No failed jobs'));
    });

    test('should handle retry errors', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const plan = makeMockPlan();
      plan.jobs.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: false, error: 'Retry failed' }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryPlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors);
    });
  });

  // ===== retryJobHandler =====
  suite('handleRetryPlanJob', () => {
    test('should return error when fields missing', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const result = await handleRetryPlanJob({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when plan not found', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const result = await handleRetryPlanJob({ planId: 'x', jobId: 'y' }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should retry a failed node', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryPlanJob({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error for non-failed node', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'running' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleRetryPlanJob({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not in failed state'));
    });

    test('should handle retryNode failure', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: false, error: 'cannot retry' }),
      });
      const result = await handleRetryPlanJob({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  // ===== updateJobHandler =====
  suite('handleUpdatePlanJob', () => {
    test('should return error when fields missing', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const result = await handleUpdatePlanJob({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when no stage provided', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'pending' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('stage'));
    });

    test('should update work on a pending node', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [], work: 'old' };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'pending', stepStatuses: {} });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1', work: 'new' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should update prechecks and postchecks', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed', stepStatuses: { prechecks: 'done', work: 'done', postchecks: 'failed', commit: 'pending' } });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1', postchecks: 'npm test' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should reject update on running node', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'running' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1', work: 'new' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('running'));
    });

    test('should reject update on succeeded node', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'succeeded' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1', work: 'new' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('completed'));
    });

    test('should reject update on non-job node', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Group', type: 'group', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'pending' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1', work: 'new' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not a job'));
    });

    test('should handle resetToStage', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', {
        status: 'failed',
        stepStatuses: { prechecks: 'done', work: 'done', postchecks: 'failed', commit: 'pending', 'merge-ri': 'pending' },
      });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleUpdatePlanJob({
        planId: 'plan-1', jobId: 'n1', work: 'new', resetToStage: 'prechecks',
      }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should clear prechecks with null', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const node = { id: 'n1', name: 'Build', type: 'job', dependencies: [], dependents: [], prechecks: 'old' };
      plan.jobs.set('n1', node);
      plan.nodeStates.set('n1', { status: 'failed', stepStatuses: {} });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'n1', prechecks: null }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  // ===== Validation failure tests for retryPlanHandler =====
  suite('handleRetryPlan validation failures', () => {
    test('should return error when allowedFolders invalid', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const result = await handleRetryPlan({
        planId: 'plan-1',
        work: { type: 'agent', allowedFolders: ['/nonexistent/path/abc123'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when allowedUrls invalid', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      const result = await handleRetryPlan({
        planId: 'plan-1',
        work: { type: 'agent', allowedUrls: ['ftp://evil.com'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test.skip('should return error when agent model invalid', async () => {
      const { handleRetryPlan } = require('../../../mcp/handlers/plan/retryPlanHandler');
      sinon.stub(modelDiscovery, 'getCachedModels').resolves({
        models: [{ id: 'gpt-5', vendor: 'openai' as const, family: 'gpt-5', tier: 'standard' as const }],
        rawChoices: ['gpt-5'],
        discoveredAt: Date.now(),
      });
      const result = await handleRetryPlan({
        planId: 'plan-1',
        newWork: { type: 'agent', agentModel: 'nonexistent-model-xyz' },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

  // ===== Validation failure tests for retryJobHandler =====
  suite('handleRetryPlanJob validation failures', () => {
    test('should return error when allowedFolders invalid', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const result = await handleRetryPlanJob({
        planId: 'plan-1', jobId: 'n1',
        work: { type: 'agent', allowedFolders: ['/nonexistent/path/abc123'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when allowedUrls invalid', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      const result = await handleRetryPlanJob({
        planId: 'plan-1', jobId: 'n1',
        work: { type: 'agent', allowedUrls: ['ftp://evil.com'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test.skip('should return error when agent model invalid', async () => {
      const { handleRetryPlanJob } = require('../../../mcp/handlers/plan/retryJobHandler');
      sinon.stub(modelDiscovery, 'getCachedModels').resolves({
        models: [{ id: 'gpt-5', vendor: 'openai' as const, family: 'gpt-5', tier: 'standard' as const }],
        rawChoices: ['gpt-5'],
        discoveredAt: Date.now(),
      });
      const result = await handleRetryPlanJob({
        planId: 'plan-1', jobId: 'n1',
        newWork: { type: 'agent', agentModel: 'nonexistent-model-xyz' },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

  // ===== Validation failure tests for updateJobHandler =====
  suite('handleUpdatePlanJob validation failures', () => {
    test('should return error when allowedFolders invalid', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const result = await handleUpdatePlanJob({
        planId: 'plan-1', jobId: 'n1',
        work: { type: 'agent', allowedFolders: ['/nonexistent/path/abc123'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when allowedUrls invalid', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const result = await handleUpdatePlanJob({
        planId: 'plan-1', jobId: 'n1',
        work: { type: 'agent', allowedUrls: ['ftp://evil.com'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test.skip('should return error when agent model invalid', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      sinon.stub(modelDiscovery, 'getCachedModels').resolves({
        models: [{ id: 'gpt-5', vendor: 'openai' as const, family: 'gpt-5', tier: 'standard' as const }],
        rawChoices: ['gpt-5'],
        discoveredAt: Date.now(),
      });
      const result = await handleUpdatePlanJob({
        planId: 'plan-1', jobId: 'n1',
        work: { type: 'agent', agentModel: 'nonexistent-model-xyz' },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

});


