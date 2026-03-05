/**
 * @fileoverview Unit tests for prLifecycleHandlers module
 * Tests all PR lifecycle MCP tool handlers.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

// Mock helper functions
function makeMockPRLifecycleManager(overrides?: Record<string, any>): any {
  return {
    listAvailablePRs: sinon.stub().resolves([]),
    adoptPR: sinon.stub().resolves({ success: true, managedPR: makeMockManagedPR() }),
    getManagedPR: sinon.stub().returns(undefined),
    getManagedPRByNumber: sinon.stub().returns(undefined),
    getAllManagedPRs: sinon.stub().returns([]),
    getManagedPRsByStatus: sinon.stub().returns([]),
    startMonitoring: sinon.stub().resolves(),
    stopMonitoring: sinon.stub().resolves(),
    abandonPR: sinon.stub().resolves({ success: true }),
    promotePR: sinon.stub().resolves({ success: true }),
    demotePR: sinon.stub().resolves({ success: true }),
    removePR: sinon.stub().resolves({ success: true }),
    on: sinon.stub(),
    ...overrides,
  };
}

function makeMockManagedPR(overrides?: Record<string, any>): any {
  return {
    id: 'pr-managed-1',
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    title: 'Test PR',
    baseBranch: 'main',
    headBranch: 'feature/test',
    status: 'adopted',
    providerType: 'github',
    repoPath: '/workspace',
    workingDirectory: '/workspace',
    adoptedAt: Date.now(),
    ...overrides,
  };
}

function makeMockAvailablePR(overrides?: Record<string, any>): any {
  return {
    prNumber: 42,
    title: 'Test PR',
    baseBranch: 'main',
    headBranch: 'feature/test',
    author: 'testuser',
    state: 'open',
    url: 'https://github.com/org/repo/pull/42',
    isManaged: false,
    ...overrides,
  };
}

function makeCtx(prLifecycleManagerOverrides?: Record<string, any>): any {
  return {
    prLifecycleManager: makeMockPRLifecycleManager(prLifecycleManagerOverrides),
    workspacePath: '/workspace',
  };
}

suite('prLifecycleHandlers', () => {
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

  suite('handleListAvailablePRs', () => {
    test('should list available PRs with valid input', async () => {
      const { handleListAvailablePRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockPR1 = makeMockAvailablePR({ prNumber: 1 });
      const mockPR2 = makeMockAvailablePR({ prNumber: 2, isManaged: true });
      const ctx = makeCtx({
        listAvailablePRs: sinon.stub().resolves([mockPR1, mockPR2]),
      });

      const result = await handleListAvailablePRs({
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.prs.length, 2);
      assert.strictEqual(result.prs[0].prNumber, 1);
      assert.strictEqual(result.prs[1].prNumber, 2);
      assert.ok(result.message.includes('2'));
      assert.ok(result.message.includes('1 already managed'));
      assert.ok(ctx.prLifecycleManager.listAvailablePRs.calledOnce);
    });

    test('should pass optional filters to manager', async () => {
      const { handleListAvailablePRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        listAvailablePRs: sinon.stub().resolves([]),
      });

      await handleListAvailablePRs({
        repoPath: '/workspace',
        baseBranch: 'develop',
        state: 'closed',
        limit: 50,
      }, ctx);

      const callArgs = ctx.prLifecycleManager.listAvailablePRs.firstCall.args[0];
      assert.strictEqual(callArgs.repoPath, '/workspace');
      assert.strictEqual(callArgs.baseBranch, 'develop');
      assert.strictEqual(callArgs.state, 'closed');
      assert.strictEqual(callArgs.limit, 50);
    });

    test('should return error for missing repoPath', async () => {
      const { handleListAvailablePRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: repoPath' });

      const result = await handleListAvailablePRs({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('repoPath'));
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleListAvailablePRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleListAvailablePRs({
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleListAvailablePRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        listAvailablePRs: sinon.stub().rejects(new Error('Remote API error')),
      });

      const result = await handleListAvailablePRs({
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Remote API error'));
    });

    test('should return empty array when no PRs found', async () => {
      const { handleListAvailablePRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        listAvailablePRs: sinon.stub().resolves([]),
      });

      const result = await handleListAvailablePRs({
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.prs.length, 0);
      assert.ok(result.message.includes('0'));
    });
  });

  suite('handleAdoptPR', () => {
    test('should adopt PR with valid input', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockManagedPR = makeMockManagedPR({ id: 'pr-1', prNumber: 42 });
      const ctx = makeCtx({
        adoptPR: sinon.stub().resolves({ success: true, managedPR: mockManagedPR }),
      });

      const result = await handleAdoptPR({
        prNumber: 42,
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPR.id, 'pr-1');
      assert.strictEqual(result.managedPR.prNumber, 42);
      assert.ok(result.message.includes('PR #42'));
      assert.ok(result.message.includes('pr-1'));
      assert.ok(ctx.prLifecycleManager.adoptPR.calledOnce);
    });

    test('should pass optional fields to manager', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();

      await handleAdoptPR({
        prNumber: 42,
        repoPath: '/workspace',
        workingDirectory: '/workspace/pr-42',
        releaseId: 'release-1',
        priority: 2,
      }, ctx);

      const callArgs = ctx.prLifecycleManager.adoptPR.firstCall.args[0];
      assert.strictEqual(callArgs.prNumber, 42);
      assert.strictEqual(callArgs.repoPath, '/workspace');
      assert.strictEqual(callArgs.workingDirectory, '/workspace/pr-42');
      assert.strictEqual(callArgs.releaseId, 'release-1');
      assert.strictEqual(callArgs.priority, 2);
    });

    test('should return error for missing prNumber', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: prNumber' });

      const result = await handleAdoptPR({
        repoPath: '/workspace',
      }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('prNumber'));
    });

    test('should return error for missing repoPath', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: repoPath' });

      const result = await handleAdoptPR({
        prNumber: 42,
      }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('repoPath'));
    });

    test('should return error when manager returns failure', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        adoptPR: sinon.stub().resolves({ success: false, error: 'PR not found' }),
      });

      const result = await handleAdoptPR({
        prNumber: 999,
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleAdoptPR({
        prNumber: 42,
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleAdoptPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        adoptPR: sinon.stub().rejects(new Error('PR already adopted')),
      });

      const result = await handleAdoptPR({
        prNumber: 42,
        repoPath: '/workspace',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR already adopted'));
    });
  });

  suite('handleGetManagedPR', () => {
    test('should get managed PR with valid id', async () => {
      const { handleGetManagedPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockPR = makeMockManagedPR({ id: 'pr-1' });
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(mockPR),
      });

      const result = await handleGetManagedPR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPR.id, 'pr-1');
      assert.ok(ctx.prLifecycleManager.getManagedPR.calledOnce);
      assert.ok(ctx.prLifecycleManager.getManagedPR.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handleGetManagedPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handleGetManagedPR({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when PR not found', async () => {
      const { handleGetManagedPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(undefined),
      });

      const result = await handleGetManagedPR({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
      assert.ok(result.error.includes('pr-999'));
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleGetManagedPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleGetManagedPR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleGetManagedPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        getManagedPR: sinon.stub().throws(new Error('Database error')),
      });

      const result = await handleGetManagedPR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Database error'));
    });
  });

  suite('handleListManagedPRs', () => {
    test('should list all managed PRs without filter', async () => {
      const { handleListManagedPRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const pr1 = makeMockManagedPR({ id: 'pr-1' });
      const pr2 = makeMockManagedPR({ id: 'pr-2', status: 'monitoring' });
      const ctx = makeCtx({
        getAllManagedPRs: sinon.stub().returns([pr1, pr2]),
      });

      const result = await handleListManagedPRs({}, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPRs.length, 2);
      assert.strictEqual(result.managedPRs[0].id, 'pr-1');
      assert.strictEqual(result.managedPRs[1].id, 'pr-2');
      assert.ok(result.message.includes('2 managed PRs'));
      assert.ok(ctx.prLifecycleManager.getAllManagedPRs.calledOnce);
    });

    test('should filter by status when provided', async () => {
      const { handleListManagedPRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const pr1 = makeMockManagedPR({ id: 'pr-1', status: 'monitoring' });
      const ctx = makeCtx({
        getManagedPRsByStatus: sinon.stub().returns([pr1]),
      });

      const result = await handleListManagedPRs({
        status: 'monitoring',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPRs.length, 1);
      assert.strictEqual(result.managedPRs[0].status, 'monitoring');
      assert.ok(result.message.includes("with status 'monitoring'"));
      assert.ok(ctx.prLifecycleManager.getManagedPRsByStatus.calledOnce);
      assert.ok(ctx.prLifecycleManager.getManagedPRsByStatus.calledWith('monitoring'));
    });

    test('should return empty array when no PRs found', async () => {
      const { handleListManagedPRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        getAllManagedPRs: sinon.stub().returns([]),
      });

      const result = await handleListManagedPRs({}, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPRs.length, 0);
      assert.ok(result.message.includes('0 managed PRs'));
    });

    test('should use singular form for single PR', async () => {
      const { handleListManagedPRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const pr1 = makeMockManagedPR({ id: 'pr-1' });
      const ctx = makeCtx({
        getAllManagedPRs: sinon.stub().returns([pr1]),
      });

      const result = await handleListManagedPRs({}, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('1 managed PR'));
      assert.ok(!result.message.includes('1 managed PRs'));
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleListManagedPRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleListManagedPRs({}, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleListManagedPRs } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        getAllManagedPRs: sinon.stub().throws(new Error('Storage error')),
      });

      const result = await handleListManagedPRs({}, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Storage error'));
    });
  });

  suite('handlePromotePR', () => {
    test('should promote PR with valid id', async () => {
      const { handlePromotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        promotePR: sinon.stub().resolves({ success: true, message: 'PR promoted to priority 2' }),
      });

      const result = await handlePromotePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message);
      assert.ok(ctx.prLifecycleManager.promotePR.calledOnce);
      assert.ok(ctx.prLifecycleManager.promotePR.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handlePromotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handlePromotePR({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when manager returns failure', async () => {
      const { handlePromotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        promotePR: sinon.stub().resolves({ success: false, error: 'Already at max priority' }),
      });

      const result = await handlePromotePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handlePromotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handlePromotePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handlePromotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        promotePR: sinon.stub().rejects(new Error('PR not found')),
      });

      const result = await handlePromotePR({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR not found'));
    });
  });

  suite('handleDemotePR', () => {
    test('should demote PR with valid id', async () => {
      const { handleDemotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        demotePR: sinon.stub().resolves({ success: true, message: 'PR demoted to priority 0' }),
      });

      const result = await handleDemotePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message);
      assert.ok(ctx.prLifecycleManager.demotePR.calledOnce);
      assert.ok(ctx.prLifecycleManager.demotePR.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handleDemotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handleDemotePR({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when manager returns failure', async () => {
      const { handleDemotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        demotePR: sinon.stub().resolves({ success: false, error: 'Already at min priority' }),
      });

      const result = await handleDemotePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleDemotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleDemotePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleDemotePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        demotePR: sinon.stub().rejects(new Error('PR not found')),
      });

      const result = await handleDemotePR({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR not found'));
    });
  });

  suite('handleAbandonPR', () => {
    test('should abandon PR with valid id', async () => {
      const { handleAbandonPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        abandonPR: sinon.stub().resolves({ success: true, message: 'PR abandoned' }),
      });

      const result = await handleAbandonPR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message);
      assert.ok(ctx.prLifecycleManager.abandonPR.calledOnce);
      assert.ok(ctx.prLifecycleManager.abandonPR.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handleAbandonPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handleAbandonPR({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when manager returns failure', async () => {
      const { handleAbandonPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        abandonPR: sinon.stub().resolves({ success: false, error: 'PR not found' }),
      });

      const result = await handleAbandonPR({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleAbandonPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleAbandonPR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleAbandonPR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        abandonPR: sinon.stub().rejects(new Error('Failed to close PR')),
      });

      const result = await handleAbandonPR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Failed to close PR'));
    });
  });

  suite('handleStartPRMonitoring', () => {
    test('should start monitoring with valid id', async () => {
      const { handleStartPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockPR = makeMockManagedPR({ id: 'pr-1', prNumber: 42 });
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(mockPR),
        startMonitoring: sinon.stub().resolves(),
      });

      const result = await handleStartPRMonitoring({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('PR #42'));
      assert.ok(result.message.includes('Monitoring started'));
      assert.ok(ctx.prLifecycleManager.getManagedPR.calledOnce);
      assert.ok(ctx.prLifecycleManager.startMonitoring.calledOnce);
      assert.ok(ctx.prLifecycleManager.startMonitoring.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handleStartPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handleStartPRMonitoring({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when PR not found', async () => {
      const { handleStartPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(undefined),
      });

      const result = await handleStartPRMonitoring({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
      assert.ok(result.error.includes('pr-999'));
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleStartPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleStartPRMonitoring({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleStartPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockPR = makeMockManagedPR({ id: 'pr-1' });
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(mockPR),
        startMonitoring: sinon.stub().rejects(new Error('Monitoring already active')),
      });

      const result = await handleStartPRMonitoring({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Monitoring already active'));
    });
  });

  suite('handleStopPRMonitoring', () => {
    test('should stop monitoring with valid id', async () => {
      const { handleStopPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockPR = makeMockManagedPR({ id: 'pr-1', prNumber: 42, status: 'monitoring' });
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(mockPR),
        stopMonitoring: sinon.stub().resolves(),
      });

      const result = await handleStopPRMonitoring({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('PR #42'));
      assert.ok(result.message.includes('Monitoring stopped'));
      assert.ok(ctx.prLifecycleManager.getManagedPR.calledOnce);
      assert.ok(ctx.prLifecycleManager.stopMonitoring.calledOnce);
      assert.ok(ctx.prLifecycleManager.stopMonitoring.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handleStopPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handleStopPRMonitoring({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when PR not found', async () => {
      const { handleStopPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(undefined),
      });

      const result = await handleStopPRMonitoring({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
      assert.ok(result.error.includes('pr-999'));
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleStopPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleStopPRMonitoring({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleStopPRMonitoring } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const mockPR = makeMockManagedPR({ id: 'pr-1' });
      const ctx = makeCtx({
        getManagedPR: sinon.stub().returns(mockPR),
        stopMonitoring: sinon.stub().rejects(new Error('PR not monitoring')),
      });

      const result = await handleStopPRMonitoring({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR not monitoring'));
    });
  });

  suite('handleRemovePR', () => {
    test('should remove PR with valid id', async () => {
      const { handleRemovePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        removePR: sinon.stub().resolves({ success: true, message: 'PR removed from management' }),
      });

      const result = await handleRemovePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.message);
      assert.ok(ctx.prLifecycleManager.removePR.calledOnce);
      assert.ok(ctx.prLifecycleManager.removePR.calledWith('pr-1'));
    });

    test('should return error for missing id', async () => {
      const { handleRemovePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: id' });

      const result = await handleRemovePR({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('id'));
    });

    test('should return error when manager returns failure', async () => {
      const { handleRemovePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        removePR: sinon.stub().resolves({ success: false, error: 'PR not found' }),
      });

      const result = await handleRemovePR({
        id: 'pr-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return error when prLifecycleManager not available', async () => {
      const { handleRemovePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx();
      ctx.prLifecycleManager = undefined;

      const result = await handleRemovePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PR lifecycle manager not available'));
    });

    test('should handle manager exceptions', async () => {
      const { handleRemovePR } = require('../../../mcp/handlers/plan/prLifecycleHandlers');
      const ctx = makeCtx({
        removePR: sinon.stub().rejects(new Error('Cleanup failed')),
      });

      const result = await handleRemovePR({
        id: 'pr-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Cleanup failed'));
    });
  });
});
