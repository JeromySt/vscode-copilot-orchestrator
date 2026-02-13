/**
 * @fileoverview Comprehensive tests for legacy adapters.
 * Covers all adapt* functions in legacyAdapters.ts.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as modelDiscovery from '../../../agent/modelDiscovery';

function makeMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    enqueue: sinon.stub(),
    enqueueJob: sinon.stub(),
    get: sinon.stub().returns(undefined),
    getPlan: sinon.stub().returns(undefined),
    getAll: sinon.stub().returns([]),
    getStatus: sinon.stub().returns(undefined),
    getStateMachine: sinon.stub().returns(undefined),
    cancel: sinon.stub().returns(true),
    delete: sinon.stub().resolves(true),
    pause: sinon.stub().returns(true),
    resume: sinon.stub().resolves(true),
    retryNode: sinon.stub().resolves({ success: true }),
    forceFailNode: sinon.stub().resolves(),
    getEffectiveEndedAt: sinon.stub().returns(undefined),
    ...overrides,
  };
}

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan' },
    nodes: new Map(),
    producerIdToNodeId: new Map(),
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: new Map(),
    baseBranch: 'main',
    targetBranch: 'feature/test',
    createdAt: Date.now(),
    startedAt: undefined,
    endedAt: undefined,
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

suite('Legacy Adapters', () => {
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

  suite('adaptGetPlanStatus', () => {
    test('should delegate to handleGetGroupStatus and add planId', async () => {
      const { adaptGetPlanStatus } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build', type: 'job' });
      plan.nodeStates.set('n1', { status: 'succeeded', attempts: 1 });
      const ctx = makeCtx({
        getStatus: sinon.stub().returns({
          plan, status: 'succeeded',
          counts: { succeeded: 1 }, progress: 1.0,
        }),
      });
      const result = await adaptGetPlanStatus({ id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, result.groupId);
    });

    test('should return error when plan not found', async () => {
      const { adaptGetPlanStatus } = require('../../../mcp/handlers/legacyAdapters');
      const result = await adaptGetPlanStatus({ id: 'missing' }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

  suite('adaptListPlans', () => {
    test('should delegate to handleListGroups and add Plans array', async () => {
      const { adaptListPlans } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan({ createdAt: 1000 });
      const sm = { computePlanStatus: sinon.stub().returns('running'), getStatusCounts: sinon.stub().returns({}) };
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await adaptListPlans({}, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.Plans);
      assert.ok(result.Plans.length > 0);
      assert.ok(result.Plans[0].id);
    });
  });

  suite('adaptCancelPlan', () => {
    test('should delegate to handleCancelGroup', async () => {
      const { adaptCancelPlan } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await adaptCancelPlan({ id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('adaptDeletePlan', () => {
    test('should delegate to handleDeleteGroup', async () => {
      const { adaptDeletePlan } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan), delete: sinon.stub().resolves(true) });
      const result = await adaptDeletePlan({ id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('adaptRetryPlan', () => {
    test('should delegate to handleRetryGroup with mapped args', async () => {
      const { adaptRetryPlan } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await adaptRetryPlan({ id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('adaptGetNodeDetails', () => {
    test('should delegate to handleGetNode with mapped args', async () => {
      const { adaptGetNodeDetails } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      const node = { id: 'n1', producerId: 'build', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.nodes.set('n1', node);
      plan.nodeStates.set('n1', { status: 'running', attempts: 1 });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await adaptGetNodeDetails({ planId: 'plan-1', nodeId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('adaptRetryPlanNode', () => {
    test('should delegate to handleRetryNode', async () => {
      const { adaptRetryPlanNode } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await adaptRetryPlanNode({ planId: 'plan-1', nodeId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('adaptGetNodeFailureContext', () => {
    test('should delegate to handleNodeFailureContext', async () => {
      const { adaptGetNodeFailureContext } = require('../../../mcp/handlers/legacyAdapters');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed', error: 'err', lastAttempt: {} });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await adaptGetNodeFailureContext({ planId: 'plan-1', nodeId: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });
});
