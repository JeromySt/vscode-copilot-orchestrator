/**
 * @fileoverview Unit tests for updatePlanHandler module
 * Tests the update_copilot_plan MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan' },
    env: {},
    maxParallel: 4,
    isPaused: false,
    ...overrides,
  };
}

function makeCtx(runnerOverrides?: Record<string, any>): any {
  return {
    PlanRunner: {
      getPlan: sinon.stub().returns(undefined),
      savePlan: sinon.stub(),
      ...runnerOverrides,
    },
    workspacePath: '/workspace',
  };
}

suite('updatePlanHandler', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleUpdatePlan', () => {
    test('should return error when planId is missing', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const result = await handleUpdatePlan({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when plan not found', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const result = await handleUpdatePlan({ planId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return message when no changes specified', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('No changes'));
    });

    test('should update env vars', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        env: { FOO: 'bar', BAZ: 'qux' },
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(plan.env, { FOO: 'bar', BAZ: 'qux' });
      assert.ok(result.updated.includes('env'));
      assert.ok(ctx.PlanRunner.savePlan.calledWith('plan-1'));
    });

    test('should update maxParallel', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        maxParallel: 8,
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.maxParallel, 8);
      assert.ok(result.updated.includes('maxParallel'));
    });

    test('should update both env and maxParallel', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        env: { TEST: 'value' },
        maxParallel: 2,
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.updated.includes('env'));
      assert.ok(result.updated.includes('maxParallel'));
      assert.strictEqual(result.env.TEST, 'value');
      assert.strictEqual(result.maxParallel, 2);
    });

    test('should set resumeAfterPlan and auto-pause', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const depPlan = makeMockPlan({ id: 'dep-plan' });
      const getPlanStub = sinon.stub();
      getPlanStub.withArgs('plan-1').returns(plan);
      getPlanStub.withArgs('dep-plan').returns(depPlan);
      
      const ctx = makeCtx({ getPlan: getPlanStub });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        resumeAfterPlan: 'dep-plan',
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.resumeAfterPlan, 'dep-plan');
      assert.strictEqual(plan.isPaused, true);
      assert.ok(result.updated.includes('resumeAfterPlan'));
      assert.ok(result.updated.includes('isPaused'));
    });

    test('should not auto-pause if already paused', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan({ isPaused: true });
      const depPlan = makeMockPlan({ id: 'dep-plan' });
      const getPlanStub = sinon.stub();
      getPlanStub.withArgs('plan-1').returns(plan);
      getPlanStub.withArgs('dep-plan').returns(depPlan);
      
      const ctx = makeCtx({ getPlan: getPlanStub });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        resumeAfterPlan: 'dep-plan',
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.updated.includes('resumeAfterPlan'));
      assert.ok(!result.updated.includes('isPaused'));
    });

    test('should clear resumeAfterPlan when empty string provided', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan({ resumeAfterPlan: 'dep-plan' });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        resumeAfterPlan: '',
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(plan.resumeAfterPlan, undefined);
      assert.ok(result.updated.some((u: string) => u.includes('cleared')));
    });

    test('should return error when dependency plan not found', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        resumeAfterPlan: 'not-found',
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Dependency plan not found'));
    });

    test('should return all updated fields in response', async () => {
      const { handleUpdatePlan } = require('../../../mcp/handlers/plan/updatePlanHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlan({ 
        planId: 'plan-1',
        env: { KEY: 'val' },
        maxParallel: 10,
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, 'plan-1');
      assert.strictEqual(result.updated.length, 2);
      assert.deepStrictEqual(result.env, { KEY: 'val' });
      assert.strictEqual(result.maxParallel, 10);
    });
  });
});
