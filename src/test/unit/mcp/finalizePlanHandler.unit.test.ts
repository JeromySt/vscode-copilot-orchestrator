/**
 * @fileoverview Unit tests for finalizePlanHandler module
 * Tests the finalize_copilot_plan MCP tool handler.
 * The handler delegates to finalizePlanInRunner (tested in finalizePlanHelper.unit.test.ts)
 * and formats the response.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', status: 'scaffolding' },
    jobs: new Map([['node-1', { id: 'node-1', producerId: 'job-1', name: 'Job 1' }]]),
    nodeStates: new Map([['node-1', { status: 'ready', version: 0, attempts: 0 }]]),
    producerIdToNodeId: new Map([['job-1', 'node-1']]),
    roots: ['node-1'],
    leaves: ['node-1'],
    targetBranch: 'copilot_plan/test',
    baseBranch: 'main',
    isPaused: false,
    stateVersion: 0,
    ...overrides,
  };
}

function makeCtx(runnerOverrides?: Record<string, any>): any {
  const plan = makeMockPlan();
  return {
    PlanRunner: {
      get: sinon.stub().returns(plan),
      delete: sinon.stub().returns(true),
      registerPlan: sinon.stub(),
      resume: sinon.stub().resolves(true),
      ...runnerOverrides,
    },
    PlanRepository: {
      finalize: sinon.stub().resolves(makeMockPlan({ spec: { name: 'Test Plan', status: 'pending' } })),
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

    test('should default to paused state', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.paused, true);
    });

    test('should respect startPaused=false', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1', startPaused: false }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.paused, false);
    });

    test('should return jobMapping', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.ok(result.jobMapping);
      assert.strictEqual(result.jobMapping['job-1'], 'node-1');
    });

    test('should return status summary', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.ok(result.status);
      assert.strictEqual(result.status.nodes, 1);
    });

    test('should return plan name and branches', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.name, 'Test Plan');
      assert.strictEqual(result.baseBranch, 'main');
    });

    test('handles finalize errors', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx();
      ctx.PlanRepository.finalize.rejects(new Error('DAG cycle detected'));
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('DAG cycle'));
    });

    test('returns error when plan not found', async () => {
      const { handleFinalizePlan } = require('../../../mcp/handlers/plan/finalizePlanHandler');
      const ctx = makeCtx({ get: sinon.stub().returns(undefined) });
      const result = await handleFinalizePlan({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });
});
