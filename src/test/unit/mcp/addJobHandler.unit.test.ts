/**
 * @fileoverview Unit tests for addJobHandler module
 * Tests the add_copilot_plan_job MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';


function makeMockPlan(): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', status: 'scaffolding' },
    jobs: new Map(),
    nodeStates: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
  };
}

function makeCtx(overrides?: Record<string, any>): any {
  const plan = makeMockPlan();
  return {
    PlanRunner: {
      get: sinon.stub().returns(plan),
      ...overrides,
    },
    PlanRepository: {
      getDefinition: sinon.stub().resolves({}),
      addNode: sinon.stub().resolves(plan),
    },
    workspacePath: '/workspace',
  };
}

suite('addJobHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let validateStub: sinon.SinonStub;
  let validateFoldersStub: sinon.SinonStub;
  let validateUrlsStub: sinon.SinonStub;
  let validateModelsStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Stub the validator sub-module directly (not the barrel's getter-based re-exports)
    // so the handler picks up stubs through the barrel's getter delegation
    const validator = require('../../../mcp/validation/validator');
    validateStub = sandbox.stub(validator, 'validateInput').returns({ valid: true });
    validateFoldersStub = sandbox.stub(validator, 'validateAllowedFolders').resolves({ valid: true });
    validateUrlsStub = sandbox.stub(validator, 'validateAllowedUrls').resolves({ valid: true });
    validateModelsStub = sandbox.stub(validator, 'validateAgentModels').resolves({ valid: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleAddPlanJob', () => {
    test('should return error when validation fails', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      validateStub.returns({ valid: false, error: 'Invalid input' });
      const result = await handleAddPlanJob({ planId: 'plan-1', producerId: 'job-1', task: 'test' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid input'));
    });

    test('should return error when plan not found', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const ctx = makeCtx();
      ctx.PlanRepository.getDefinition.resolves(null);
      const result = await handleAddPlanJob({ planId: 'not-found', producerId: 'job-1', task: 'test' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return error when model validation fails', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      validateModelsStub.resolves({ valid: false, error: 'Invalid model' });
      const result = await handleAddPlanJob({ 
        planId: 'plan-1', 
        producerId: 'job-1', 
        task: 'test',
        work: { agent: { model: 'invalid' } },
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid model'));
    });

    test('should return error when folder validation fails', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      validateFoldersStub.resolves({ valid: false, error: 'Invalid folder' });
      const result = await handleAddPlanJob({ 
        planId: 'plan-1', 
        producerId: 'job-1', 
        task: 'test',
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid folder'));
    });

    test('should return error when URL validation fails', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      validateUrlsStub.resolves({ valid: false, error: 'Invalid URL' });
      const result = await handleAddPlanJob({ 
        planId: 'plan-1', 
        producerId: 'job-1', 
        task: 'test',
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid URL'));
    });

    test('should add job successfully', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const ctx = makeCtx();
      const result = await handleAddPlanJob({ 
        planId: 'plan-1',
        producerId: 'job-1',
        task: 'Test task',
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.jobId, 'job-1');
      assert.ok(result.message.includes('added'));
      assert.ok(ctx.PlanRepository.addNode.calledOnce);
    });

    test('should pass all job parameters to addNode', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const ctx = makeCtx();
      await handleAddPlanJob({ 
        planId: 'plan-1',
        producerId: 'job-1',
        name: 'Job Name',
        task: 'Test task',
        dependencies: ['job-0'],
        group: 'mygroup',
        work: { agent: { instructions: 'test' } },
        prechecks: { command: 'check' },
        postchecks: { command: 'verify' },
        autoHeal: false,
        expectsNoChanges: true,
      }, ctx);
      
      const addNodeCall = ctx.PlanRepository.addNode.firstCall;
      const nodeSpec = addNodeCall.args[1];
      assert.strictEqual(nodeSpec.producerId, 'job-1');
      assert.strictEqual(nodeSpec.name, 'Job Name');
      assert.strictEqual(nodeSpec.task, 'Test task');
      assert.deepStrictEqual(nodeSpec.dependencies, ['job-0']);
      assert.strictEqual(nodeSpec.group, 'mygroup');
      assert.ok(nodeSpec.work);
      assert.ok(nodeSpec.prechecks);
      assert.ok(nodeSpec.postchecks);
      assert.strictEqual(nodeSpec.autoHeal, false);
      assert.strictEqual(nodeSpec.expectsNoChanges, true);
    });

    test('should update in-memory plan topology', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const plan = makeMockPlan();
      const rebuiltPlan = makeMockPlan();
      rebuiltPlan.jobs.set('node-1', { id: 'node-1', name: 'New Job' });
      
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      ctx.PlanRepository.addNode.resolves(rebuiltPlan);
      
      await handleAddPlanJob({ planId: 'plan-1', producerId: 'job-1', task: 'test' }, ctx);
      
      assert.strictEqual(plan.jobs.size, 1);
      assert.ok(plan.jobs.has('node-1'));
    });

    test('should copy definition from rebuilt plan for spec hydration', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const plan = makeMockPlan();
      assert.strictEqual(plan.definition, undefined);

      const mockDefinition = { getWorkSpec: sinon.stub(), getPrechecksSpec: sinon.stub(), getPostchecksSpec: sinon.stub() };
      const rebuiltPlan = makeMockPlan();
      rebuiltPlan.definition = mockDefinition;

      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      ctx.PlanRepository.addNode.resolves(rebuiltPlan);

      await handleAddPlanJob({ planId: 'plan-1', producerId: 'job-1', task: 'test' }, ctx);
      assert.strictEqual(plan.definition, mockDefinition, 'definition must be copied from rebuiltPlan to existingPlan');
    });

    test('should emit planUpdated event', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const plan = makeMockPlan();
      const mockEvents = { emitPlanUpdated: sinon.stub() };
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      (ctx.PlanRunner as any)._state = { events: mockEvents };
      
      await handleAddPlanJob({ planId: 'plan-1', producerId: 'job-1', task: 'test' }, ctx);
      assert.ok(mockEvents.emitPlanUpdated.calledWith('plan-1'));
    });

    test('should handle addNode errors', async () => {
      const { handleAddPlanJob } = require('../../../mcp/handlers/plan/addJobHandler');
      const ctx = makeCtx();
      ctx.PlanRepository.addNode.rejects(new Error('Add failed'));
      const result = await handleAddPlanJob({ planId: 'plan-1', producerId: 'job-1', task: 'test' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Add failed'));
    });
  });
});
