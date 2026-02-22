/**
 * @fileoverview Unit tests for finalizePlanHandler module
 * Tests the finalize_copilot_plan MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';


function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', status: 'scaffolding' },
    jobs: new Map(),
    nodeStates: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
    targetBranch: 'copilot_plan/test',
    baseBranch: 'main',
    isPaused: false,
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, any>): any {
  const plan = makeMockPlan();
  plan.jobs.set('node-1', { id: 'node-1', producerId: 'job-1', name: 'Job 1' });
  plan.producerIdToNodeId.set('job-1', 'node-1');
  
  return {
    PlanRunner: {
      get: sinon.stub().returns(plan),
      registerPlan: sinon.stub(),
      ...overrides,
    },
    PlanRepository: {
      finalize: sinon.stub().resolves(plan),
    },
    workspacePath: '/workspace',
  };
}

suite('finalizePlanHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let validateStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    const validator = require('../../../mcp/validation/validator');
    validateStub = sandbox.stub(validator, 'validateInput').returns({ valid: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleFinalizePlan', () => {
    test('should return error when validation fails', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      validateStub.returns({ valid: false, error: 'Invalid input' });
      const result = await handleFinalizePlan({ planId: 'plan-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid input'));
    });

    test('should finalize plan successfully', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, 'plan-1');
      assert.ok(result.message.includes('finalized'));
      assert.ok(ctx.PlanRepository.finalize.calledWith('plan-1'));
    });

    test('should transition plan status from scaffolding to pending', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual((plan.spec as any).status, 'pending');
    });

    test('should default to paused state', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.isPaused, true);
      assert.strictEqual(result.paused, true);
      assert.ok(result.message.includes('PAUSED'));
    });

    test('should respect startPaused=false', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      const result = await handleFinalizePlan({ planId: 'plan-1', startPaused: false }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.isPaused, false);
      assert.strictEqual(result.paused, false);
    });

    test('should update in-memory plan topology', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const finalizedPlan = makeMockPlan();
      finalizedPlan.jobs.set('node-2', { id: 'node-2', name: 'New Job' });
      finalizedPlan.roots = ['node-1', 'node-2'];
      
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      ctx.PlanRepository.finalize.resolves(finalizedPlan);
      
      await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(plan.jobs.size, 1); // Updated but based on finalized
      assert.deepStrictEqual(plan.roots, ['node-1', 'node-2']);
    });

    test('should return jobMapping', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.jobMapping);
      assert.strictEqual(result.jobMapping['job-1'], 'node-1');
    });

    test('should return status summary', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.status);
      assert.strictEqual(result.status.status, 'paused');
      assert.strictEqual(result.status.nodes, 1);
    });

    test('should recreate state machine', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const mockSm = { on: sinon.stub() };
      const smFactory = sinon.stub().returns(mockSm);
      const setupListeners = sinon.stub();
      const stateMachines = new Map();
      
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      (ctx.PlanRunner as any)._state = {
        stateMachineFactory: smFactory,
        stateMachines,
      };
      (ctx.PlanRunner as any)._lifecycle = {
        setupStateMachineListeners: setupListeners,
      };
      
      await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.ok(smFactory.calledWith(plan));
      assert.ok(setupListeners.calledWith(mockSm));
      assert.strictEqual(stateMachines.get('plan-1'), mockSm);
    });

    test('should emit planUpdated event', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const mockEvents = { emitPlanUpdated: sinon.stub() };
      const ctx = makeCtx({ get: sinon.stub().returns(plan) });
      (ctx.PlanRunner as any)._state = { events: mockEvents };
      
      await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.ok(mockEvents.emitPlanUpdated.calledWith('plan-1'));
    });

    test('should handle finalize errors', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      ctx.PlanRepository.finalize.rejects(new Error('Finalize failed'));
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Finalize failed'));
    });

    test('should register plan if not in memory', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ get: sinon.stub().returns(undefined) });
      ctx.PlanRepository.finalize.resolves(plan);
      
      await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.ok(ctx.PlanRunner.registerPlan.calledWith(plan));
    });
  });
});
