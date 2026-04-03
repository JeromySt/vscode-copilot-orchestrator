/**
 * @fileoverview Unit tests for archivePlanHandler module
 * Tests the archive_copilot_plan MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan' },
    targetBranch: 'copilot_plan/test',
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, any>): any {
  return {
    PlanRunner: {
      get: sinon.stub().returns(makeMockPlan()),
      getStatus: sinon.stub().returns({ status: 'succeeded' }),
    },
    PlanArchiver: {
      canArchive: sinon.stub().returns(true),
      archive: sinon.stub().resolves({
        planId: 'plan-1',
        success: true,
        cleanedWorktrees: ['/repo/.worktrees/plan-1/node-1'],
        cleanedBranches: ['copilot_plan/test'],
      }),
      ...overrides,
    },
  };
}

suite('handleArchivePlan', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleArchivePlan', () => {
    test('returns error for missing planId', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      const result = await handleArchivePlan({}, ctx);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('returns error when plan is not archivable', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx({ canArchive: sinon.stub().returns(false) });
      
      const result = await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Cannot archive plan'));
    });

    test('returns success with cleanup counts', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      const result = await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.planId, 'plan-1');
      assert.strictEqual(result.cleanedWorktrees, 1);
      assert.strictEqual(result.cleanedBranches, 1);
      assert.ok(result.message.includes('archived'));
      assert.ok(result.message.includes('1 worktrees'));
      assert.ok(result.message.includes('1 branches'));
    });

    test('passes force option to archiver', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      await handleArchivePlan({ planId: 'plan-1', force: true }, ctx);
      
      assert.ok(ctx.PlanArchiver.archive.calledWith('plan-1', { force: true, deleteRemoteBranches: false }));
    });

    test('passes deleteRemoteBranches option', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      await handleArchivePlan({ planId: 'plan-1', deleteRemoteBranches: true }, ctx);
      
      assert.ok(ctx.PlanArchiver.archive.calledWith('plan-1', { force: false, deleteRemoteBranches: true }));
    });

    test('returns full worktree and branch lists', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      const result = await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      assert.strictEqual(result.success, true);
      assert.ok(Array.isArray(result.worktrees));
      assert.ok(Array.isArray(result.branches));
      assert.strictEqual(result.worktrees.length, 1);
      assert.strictEqual(result.branches.length, 1);
    });

    test('handles archive operation failure', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx({
        archive: sinon.stub().resolves({
          planId: 'plan-1',
          success: false,
          cleanedWorktrees: [],
          cleanedBranches: [],
          error: 'Permission denied',
        }),
      });
      
      const result = await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Permission denied'));
    });

    test('returns error when archiver not available', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = {
        PlanRunner: {
          get: sinon.stub().returns(makeMockPlan()),
          getStatus: sinon.stub().returns({ status: 'succeeded' }),
        },
        PlanArchiver: undefined,
      };
      
      const result = await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not available'));
    });

    test('includes plan status in error message for non-archivable plans', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx({ canArchive: sinon.stub().returns(false) });
      ctx.PlanRunner.getStatus.returns({ status: 'running' });
      
      const result = await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('running'));
    });

    test('defaults force to false', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      const callArgs = ctx.PlanArchiver.archive.firstCall.args[1];
      assert.strictEqual(callArgs.force, false);
    });

    test('defaults deleteRemoteBranches to false', async () => {
      const { handleArchivePlan } = require('../../../mcp/handlers/plan/archivePlanHandler');
      const ctx = makeCtx();
      
      await handleArchivePlan({ planId: 'plan-1' }, ctx);
      
      const callArgs = ctx.PlanArchiver.archive.firstCall.args[1];
      assert.strictEqual(callArgs.deleteRemoteBranches, false);
    });
  });
});
