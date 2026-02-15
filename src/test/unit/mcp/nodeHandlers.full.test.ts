/**
 * @fileoverview Comprehensive tests for nodeHandlers.ts
 * Covers handleGetNode, handleListNodes, handleRetryNode,
 * handleForceFailNode, handleNodeFailureContext, handleGetGroupStatus,
 * handleListGroups, handleCancelGroup, handleDeleteGroup, handleRetryGroup.
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

suite('Node Handlers', () => {
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

  suite('handleGetNode', () => {
    test('should return error when node_id missing', async () => {
      const { handleGetNode } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleGetNode({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should find node by direct ID', async () => {
      const { handleGetNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      const node = {
        id: 'n1', producerId: 'build', name: 'Build',
        type: 'job', dependencies: ['n0'], dependents: ['n2'],
        task: 'Build it', work: 'npm build', prechecks: 'lint', postchecks: 'test',
      };
      plan.nodes.set('n1', node);
      plan.nodes.set('n0', { id: 'n0', producerId: 'prep', name: 'Prep' });
      plan.nodes.set('n2', { id: 'n2', producerId: 'deploy', name: 'Deploy' });
      plan.nodeStates.set('n1', {
        status: 'succeeded', attempts: 1, scheduledAt: 100,
        startedAt: 200, endedAt: 300, baseCommit: 'abc',
        completedCommit: 'def', worktreePath: '/wt', mergedToTarget: true,
      });
      plan.producerIdToNodeId.set('build', 'n1');
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleGetNode({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'n1');
      assert.strictEqual(result.state.status, 'succeeded');
    });

    test('should find node by producer_id', async () => {
      const { handleGetNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      const node = { id: 'n1', producerId: 'build', name: 'Build', type: 'job', dependencies: [], dependents: [] };
      plan.nodes.set('n1', node);
      plan.nodeStates.set('n1', { status: 'pending', attempts: 0 });
      plan.producerIdToNodeId.set('build', 'n1');
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleGetNode({ node_id: 'build' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when node not found', async () => {
      const { handleGetNode } = require('../../../mcp/handlers/nodeHandlers');
      const ctx = makeCtx({ getAll: sinon.stub().returns([]) });
      const result = await handleGetNode({ node_id: 'missing' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleListNodes', () => {
    test('should return empty list when no plans', async () => {
      const { handleListNodes } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleListNodes({}, makeCtx());
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0);
    });

    test('should list all nodes', async () => {
      const { handleListNodes } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      const node = { id: 'n1', producerId: 'build', name: 'Build', type: 'job' };
      plan.nodes.set('n1', node);
      plan.nodeStates.set('n1', { status: 'running', attempts: 1, startedAt: 100 });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleListNodes({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
    });

    test('should filter by group_id', async () => {
      const { handleListNodes } = require('../../../mcp/handlers/nodeHandlers');
      const plan1 = makeMockPlan({ id: 'p1' });
      plan1.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build', type: 'job' });
      plan1.nodeStates.set('n1', { status: 'running' });
      const plan2 = makeMockPlan({ id: 'p2' });
      plan2.nodes.set('n2', { id: 'n2', producerId: 'test', name: 'Test', type: 'job' });
      plan2.nodeStates.set('n2', { status: 'pending' });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan1, plan2]) });
      const result = await handleListNodes({ group_id: 'p1' }, ctx);
      assert.strictEqual(result.count, 1);
    });

    test('should filter by status', async () => {
      const { handleListNodes } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build', type: 'job' });
      plan.nodeStates.set('n1', { status: 'failed' });
      plan.nodes.set('n2', { id: 'n2', producerId: 'test', name: 'Test', type: 'job' });
      plan.nodeStates.set('n2', { status: 'running' });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleListNodes({ status: 'failed' }, ctx);
      assert.strictEqual(result.count, 1);
    });

    test('should filter by group_name', async () => {
      const { handleListNodes } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan({ spec: { name: 'My Build Plan' } });
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build', type: 'job' });
      plan.nodeStates.set('n1', { status: 'running' });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleListNodes({ group_name: 'build' }, ctx);
      assert.strictEqual(result.count, 1);
      // Non-matching group_name
      const result2 = await handleListNodes({ group_name: 'zzzzz' }, ctx);
      assert.strictEqual(result2.count, 0);
    });
  });

  suite('handleGetGroupStatus', () => {
    test('should return error when group_id missing', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleGetGroupStatus({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when group not found', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleGetGroupStatus({ group_id: 'x' }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return group status', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build', type: 'job' });
      plan.nodeStates.set('n1', { status: 'succeeded', attempts: 1, startedAt: 100, endedAt: 200, completedCommit: 'abc', worktreePath: '/wt' });
      const ctx = makeCtx({
        getStatus: sinon.stub().returns({
          plan,
          status: 'succeeded',
          counts: { succeeded: 1 },
          progress: 1.0,
        }),
      });
      const result = await handleGetGroupStatus({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.progress, 100);
    });
  });

  suite('handleListGroups', () => {
    test('should return empty list', async () => {
      const { handleListGroups } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleListGroups({}, makeCtx());
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0);
    });

    test('should list groups', async () => {
      const { handleListGroups } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan({ createdAt: 1000 });
      const sm = { computePlanStatus: sinon.stub().returns('running'), getStatusCounts: sinon.stub().returns({}) };
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await handleListGroups({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
    });

    test('should filter groups by status', async () => {
      const { handleListGroups } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan({ createdAt: 1000 });
      const sm = { computePlanStatus: sinon.stub().returns('failed'), getStatusCounts: sinon.stub().returns({}) };
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await handleListGroups({ status: 'running' }, ctx);
      assert.strictEqual(result.count, 0);
    });
  });

  suite('handleCancelGroup', () => {
    test('should return error when group_id missing', async () => {
      const { handleCancelGroup } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleCancelGroup({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should cancel group', async () => {
      const { handleCancelGroup } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleCancelGroup({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when group not found', async () => {
      const { handleCancelGroup } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleCancelGroup({ group_id: 'x' }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleDeleteGroup', () => {
    test('should delete group', async () => {
      const { handleDeleteGroup } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan), delete: sinon.stub().resolves(true) });
      const result = await handleDeleteGroup({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when group not found', async () => {
      const { handleDeleteGroup } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleDeleteGroup({ group_id: 'x' }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleRetryGroup', () => {
    test('should return error when group_id missing', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleRetryGroup({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should retry failed nodes in group', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryGroup({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when no failed nodes', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodeStates.set('n1', { status: 'succeeded' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleRetryGroup({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('should handle retry error', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: false, error: 'fail' }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryGroup({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('should handle enqueue error', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed' });
      const ctx = makeCtx({
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().rejects(new Error('boom')),
      });
      const result = await handleRetryGroup({ group_id: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleRetryNode (node-centric)', () => {
    test('should return error when node_id missing', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleRetryNode({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should retry a node found across plans', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryNode({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should find node by producer_id', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      plan.producerIdToNodeId.set('build', 'n1');
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        retryNode: sinon.stub().resolves({ success: true }),
        resume: sinon.stub().resolves(true),
      });
      const result = await handleRetryNode({ node_id: 'build' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when node not found', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const ctx = makeCtx({ getAll: sinon.stub().returns([]) });
      const result = await handleRetryNode({ node_id: 'missing' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('should handle retry failure', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        retryNode: sinon.stub().resolves({ success: false, error: 'cannot retry' }),
      });
      const result = await handleRetryNode({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleForceFailNode', () => {
    test('should return error when node_id missing', async () => {
      const { handleForceFailNode } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleForceFailNode({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should force fail a node', async () => {
      const { handleForceFailNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        forceFailNode: sinon.stub().resolves(),
      });
      const result = await handleForceFailNode({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when node not found', async () => {
      const { handleForceFailNode } = require('../../../mcp/handlers/nodeHandlers');
      const ctx = makeCtx({ getAll: sinon.stub().returns([]) });
      const result = await handleForceFailNode({ node_id: 'missing' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('should handle forceFailNode error', async () => {
      const { handleForceFailNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        forceFailNode: sinon.stub().rejects(new Error('Cannot force fail')),
      });
      const result = await handleForceFailNode({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleNodeFailureContext', () => {
    test('should return error when node_id missing', async () => {
      const { handleNodeFailureContext } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleNodeFailureContext({}, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return failure context', async () => {
      const { handleNodeFailureContext } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      const node = { id: 'n1', producerId: 'build', name: 'Build' };
      plan.nodes.set('n1', node);
      plan.nodeStates.set('n1', {
        status: 'failed', error: 'Build error',
        attempts: 2, worktreePath: '/wt', copilotSessionId: 'sess-1',
        lastAttempt: { phase: 'work' },
      });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleNodeFailureContext({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.error, 'Build error');
    });

    test('should return error for non-failed node', async () => {
      const { handleNodeFailureContext } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build' });
      plan.nodeStates.set('n1', { status: 'running' });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleNodeFailureContext({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not in failed state'));
    });

    test('should return error when node not found', async () => {
      const { handleNodeFailureContext } = require('../../../mcp/handlers/nodeHandlers');
      const ctx = makeCtx({ getAll: sinon.stub().returns([]) });
      const result = await handleNodeFailureContext({ node_id: 'missing' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('should include executor logs when available', async () => {
      const { handleNodeFailureContext } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build' });
      plan.nodeStates.set('n1', { status: 'failed', error: 'err', lastAttempt: {} });
      const mockRunner = makeMockPlanRunner({ getAll: sinon.stub().returns([plan]) });
      mockRunner.executor = { getLogs: sinon.stub().returns([{ timestamp: 1, phase: 'work', type: 'error', message: 'fail' }]) };
      const ctx = { PlanRunner: mockRunner, workspacePath: '/ws', runner: null, plans: null };
      const result = await handleNodeFailureContext({ node_id: 'n1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.logs.length, 1);
    });
  });

  suite('handleRetryNode validation failures', () => {
    test('should return error when allowedFolders invalid', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleRetryNode({
        node_id: 'n1',
        work: { type: 'agent', allowedFolders: ['/nonexistent/path/xyz123'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test('should return error when allowedUrls invalid', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      const result = await handleRetryNode({
        node_id: 'n1',
        work: { type: 'agent', allowedUrls: ['ftp://evil.com'] },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });

    test.skip('should return error when agent model invalid', async () => {
      const { handleRetryNode } = require('../../../mcp/handlers/nodeHandlers');
      sinon.stub(modelDiscovery, 'getCachedModels').resolves({
        models: [{ id: 'gpt-5', vendor: 'openai' as const, family: 'gpt-5', tier: 'standard' as const }],
        rawChoices: ['gpt-5'],
        discoveredAt: Date.now(),
      });
      const result = await handleRetryNode({
        node_id: 'n1',
        newWork: { type: 'agent', agentModel: 'nonexistent-model-xyz' },
      }, makeCtx());
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleForceFailNode producer ID lookup', () => {
    test('should find node by producerId', async () => {
      const { handleForceFailNode } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1' });
      plan.producerIdToNodeId.set('build', 'n1');
      const ctx = makeCtx({
        getAll: sinon.stub().returns([plan]),
        forceFailNode: sinon.stub().resolves(),
      });
      const result = await handleForceFailNode({ node_id: 'build' }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('handleNodeFailureContext producer ID lookup', () => {
    test('should find node by producerId', async () => {
      const { handleNodeFailureContext } = require('../../../mcp/handlers/nodeHandlers');
      const plan = makeMockPlan();
      plan.nodes.set('n1', { id: 'n1', producerId: 'build', name: 'Build' });
      plan.producerIdToNodeId.set('build', 'n1');
      plan.nodeStates.set('n1', {
        status: 'failed', error: 'err', lastAttempt: { phase: 'work' },
        attempts: 1, worktreePath: '/wt', copilotSessionId: 'sess-1',
      });
      const ctx = makeCtx({ getAll: sinon.stub().returns([plan]) });
      const result = await handleNodeFailureContext({ node_id: 'build' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.nodeId, 'n1');
    });
  });
});
