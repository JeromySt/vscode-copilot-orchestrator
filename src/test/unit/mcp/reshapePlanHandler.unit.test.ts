/**
 * @fileoverview Unit tests for reshapePlanHandler module
 * Tests the reshape_copilot_plan MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function makeMockPlan(overrides?: Record<string, any>): any {
  const jobs = new Map();
  const nodeStates = new Map();
  const producerIdToNodeId = new Map();
  
  jobs.set('node-1', {
    id: 'node-1',
    producerId: 'job-1',
    name: 'Job 1',
    type: 'job',
    dependencies: [],
    dependents: [],
  });
  
  nodeStates.set('node-1', { status: 'pending' });
  producerIdToNodeId.set('job-1', 'node-1');
  
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan' },
    jobs,
    nodeStates,
    producerIdToNodeId,
    roots: ['node-1'],
    leaves: ['node-1'],
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, any>): any {
  const plan = makeMockPlan();
  return {
    PlanRunner: {
      getPlan: sinon.stub().returns(plan),
      savePlan: sinon.stub(),
      emit: sinon.stub(),
      ...overrides,
    },
    PlanRepository: {
      addNode: sinon.stub().resolves(plan),
      removeNode: sinon.stub().resolves(plan),
      updateNode: sinon.stub().resolves(plan),
      saveState: sinon.stub().resolves(),
    },
    workspacePath: '/workspace',
  };
}

suite('reshapePlanHandler', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleReshapePlan', () => {
    test('should return error when planId is missing', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const result = await handleReshapePlan({ operations: [] }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when operations is missing', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const result = await handleReshapePlan({ planId: 'plan-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('operations'));
    });

    test('should return error when operations is empty array', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const result = await handleReshapePlan({ planId: 'plan-1', operations: [] }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('non-empty'));
    });

    test('should return error when plan not found', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const ctx = makeCtx({ getPlan: sinon.stub().returns(undefined) });
      const result = await handleReshapePlan({ 
        planId: 'not-found', 
        operations: [{ type: 'add_node', spec: { producerId: 'j1', task: 't' } }],
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should add node via repository for scaffolding plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{
          type: 'add_node',
          spec: { producerId: 'job-2', task: 'New task', dependencies: [] },
        }],
      }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.ok(ctx.PlanRepository.addNode.calledWith('plan-1'));
      assert.strictEqual(result.results[0].operation, 'add_node');
      assert.strictEqual(result.results[0].success, true);
    });

    test('should remove node via repository for scaffolding plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'remove_node', producerId: 'job-1' }],
      }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.ok(ctx.PlanRepository.removeNode.calledWith('plan-1', 'job-1'));
    });

    test('should update deps via repository for scaffolding plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'update_deps', nodeId: 'node-1', dependencies: [] }],
      }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.ok(ctx.PlanRepository.updateNode.called);
    });

    test('should prevent removing snapshot validation node', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      plan.jobs.set('sv-node', {
        id: 'sv-node',
        producerId: '__snapshot-validation__',
        name: 'SV',
        type: 'snapshot-validation',
        dependencies: [],
        dependents: [],
      });
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'remove_node', producerId: '__snapshot-validation__' }],
      }, ctx);
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('auto-managed'));
    });

    test('should use in-memory reshaper for running plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{
          type: 'add_node',
          spec: { producerId: 'job-2', task: 'New', dependencies: [] },
        }],
      }, ctx);
      
      assert.strictEqual(result.success, true);
      // For running plans, repository.addNode should NOT be called
      assert.ok(!ctx.PlanRepository.addNode.called);
    });

    test('should return topology summary', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'add_node', spec: { producerId: 'j2', task: 't', dependencies: [] } }],
      }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.ok(result.topology);
      assert.ok(result.topology.nodes);
      assert.ok(Array.isArray(result.topology.roots));
      assert.ok(Array.isArray(result.topology.leaves));
    });

    test('should process multiple operations in sequence', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [
          { type: 'add_node', spec: { producerId: 'j2', task: 't', dependencies: [] } },
          { type: 'add_node', spec: { producerId: 'j3', task: 't2', dependencies: [] } },
        ],
      }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 2);
    });

    test('should continue processing operations after failure', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      ctx.PlanRepository.addNode.onFirstCall().rejects(new Error('Add failed'));
      ctx.PlanRepository.addNode.onSecondCall().resolves(plan);
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [
          { type: 'add_node', spec: { producerId: 'j2', task: 't', dependencies: [] } },
          { type: 'add_node', spec: { producerId: 'j3', task: 't2', dependencies: [] } },
        ],
      }, ctx);
      
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].success, false);
      assert.strictEqual(result.results[1].success, true);
    });

    test('should emit planUpdated event', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan({ spec: { status: 'scaffolding' } });
      const mockEvents = { emitPlanUpdated: sinon.stub() };
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      (ctx.PlanRunner as any)._state = { events: mockEvents };
      
      await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'add_node', spec: { producerId: 'j2', task: 't', dependencies: [] } }],
      }, ctx);
      
      assert.ok(mockEvents.emitPlanUpdated.calledWith('plan-1'));
    });

    test('should save plan state for running plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'add_node', spec: { producerId: 'j2', task: 't', dependencies: [] } }],
      }, ctx);
      
      assert.ok(ctx.PlanRunner.savePlan.calledWith('plan-1'));
      assert.ok(ctx.PlanRunner.emit.calledWith('planUpdated', 'plan-1'));
    });

    test('should handle add_before operation for running plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{
          type: 'add_before',
          existingNodeId: 'node-1',
          spec: { producerId: 'j0', task: 'before', dependencies: [] },
        }],
      }, ctx);
      
      // This tests the running plan path; the reshaper will handle add_before
      assert.ok(result.results);
    });

    test('should handle add_after operation for running plans', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{
          type: 'add_after',
          existingNodeId: 'node-1',
          spec: { producerId: 'j2', task: 'after', dependencies: [] },
        }],
      }, ctx);
      
      assert.ok(result.results);
    });

    test('should reject unknown operation types', async () => {
      const { handleReshapePlan } = require('../../../mcp/handlers/plan/reshapePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      
      const result = await handleReshapePlan({ 
        planId: 'plan-1',
        operations: [{ type: 'unknown_op' as any }],
      }, ctx);
      
      assert.strictEqual(result.results[0].success, false);
      assert.ok(result.results[0].error.includes('Unknown') || result.results[0].error.includes('not supported'));
    });
  });
});
