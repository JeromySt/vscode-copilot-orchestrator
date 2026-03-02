/**
 * @fileoverview Unit tests for scaffoldPlanHandler module
 * Tests the scaffold_copilot_plan MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function makeCtx(overrides?: Record<string, any>): any {
  return {
    PlanRunner: {
      registerPlan: sinon.stub(),
      ...overrides,
    },
    PlanRepository: {
      scaffold: sinon.stub().resolves({ id: 'plan-1', spec: { name: 'Test' } }),
    },
    workspacePath: '/workspace',
    git: {
      getDefaultBranch: sinon.stub().resolves('main'),
      branchExists: sinon.stub().resolves(false),
    },
    configProvider: {
      getConfig: sinon.stub().returns(undefined),
    },
  };
}

suite('scaffoldPlanHandler', () => {
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

  suite('handleScaffoldPlan', () => {
    test('should return error when validation fails', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      validateStub.returns({ valid: false, error: 'Invalid input' });
      const result = await handleScaffoldPlan({ name: 'Test' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid input'));
    });

    test('should scaffold plan successfully', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      const result = await handleScaffoldPlan({ name: 'Test Plan' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, 'plan-1');
      assert.ok(result.message.includes('scaffold'));
      assert.ok(ctx.PlanRunner.registerPlan.calledOnce);
    });

    test('should return specsDir in response', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      const result = await handleScaffoldPlan({ name: 'Test Plan' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.specsDir);
      assert.ok(result.specsDir.includes('plan-1'));
    });

    test('should handle scaffold errors', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      ctx.PlanRepository.scaffold.rejects(new Error('Scaffold failed'));
      const result = await handleScaffoldPlan({ name: 'Test Plan' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Scaffold failed'));
    });

    test('should pass baseBranch to scaffold', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      await handleScaffoldPlan({ name: 'Test', baseBranch: 'develop' }, ctx);
      assert.ok(ctx.PlanRepository.scaffold.calledOnce);
      const opts = ctx.PlanRepository.scaffold.firstCall.args[1];
      assert.ok(opts.baseBranch);
    });

    test('should pass maxParallel to scaffold', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      await handleScaffoldPlan({ name: 'Test', maxParallel: 8 }, ctx);
      assert.ok(ctx.PlanRepository.scaffold.calledOnce);
      const opts = ctx.PlanRepository.scaffold.firstCall.args[1];
      assert.strictEqual(opts.maxParallel, 8);
    });

    test('should pass env to scaffold', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      await handleScaffoldPlan({ name: 'Test', env: { FOO: 'bar' } }, ctx);
      assert.ok(ctx.PlanRepository.scaffold.calledOnce);
      const opts = ctx.PlanRepository.scaffold.firstCall.args[1];
      assert.deepStrictEqual(opts.env, { FOO: 'bar' });
    });

    test('should pass resumeAfterPlan to scaffold', async () => {
      const { handleScaffoldPlan } = require('../../../mcp/handlers/plan/scaffoldPlanHandler');
      const ctx = makeCtx();
      await handleScaffoldPlan({ name: 'Test', resumeAfterPlan: 'dep-plan' }, ctx);
      assert.ok(ctx.PlanRepository.scaffold.calledOnce);
      const opts = ctx.PlanRepository.scaffold.firstCall.args[1];
      assert.strictEqual(opts.resumeAfterPlan, 'dep-plan');
    });
  });
});
