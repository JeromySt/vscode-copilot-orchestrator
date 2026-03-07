/**
 * @fileoverview Unit tests for releaseHandlers module
 * Tests all release-centric MCP tool handlers.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

// Mock helper functions
function makeMockReleaseManager(overrides?: Record<string, any>): any {
  return {
    createRelease: sinon.stub().resolves(makeMockRelease()),
    startRelease: sinon.stub().resolves(),
    cancelRelease: sinon.stub().resolves(true),
    getRelease: sinon.stub().returns(undefined),
    getAllReleases: sinon.stub().returns([]),
    getReleasesByStatus: sinon.stub().returns([]),
    getReleaseProgress: sinon.stub().returns(undefined),
    deleteRelease: sinon.stub().returns(true),
    cleanupIsolatedRepos: sinon.stub().resolves(),
    on: sinon.stub(),
    ...overrides,
  };
}

function makeMockRelease(overrides?: Record<string, any>): any {
  return {
    id: 'release-1',
    name: 'Test Release',
    planIds: ['plan-1', 'plan-2'],
    releaseBranch: 'release/test',
    targetBranch: 'main',
    repoPath: '/workspace',
    status: 'drafting',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMockProgress(overrides?: Record<string, any>): any {
  return {
    phase: 'merging',
    currentStep: 'Merging plan commits',
    completedSteps: 2,
    totalSteps: 5,
    ...overrides,
  };
}

function makeCtx(releaseManagerOverrides?: Record<string, any>): any {
  return {
    releaseManager: makeMockReleaseManager(releaseManagerOverrides),
    workspacePath: '/workspace',
  };
}

suite('releaseHandlers', () => {
  let sandbox: sinon.SinonSandbox;
  let validateStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Stub the validator sub-module directly (barrel re-exports use getters)
    const validator = require('../../../mcp/validation/validator');
    validateStub = sandbox.stub(validator, 'validateInput').returns({ valid: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleCreateRelease', () => {
    test('should create release with valid plans', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease();
      const ctx = makeCtx({
        createRelease: sinon.stub().resolves(mockRelease),
      });

      const result = await handleCreateRelease({
        name: 'Test Release',
        planIds: ['plan-1', 'plan-2'],
        releaseBranch: 'release/test',
        targetBranch: 'main',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.strictEqual(result.status, 'drafting');
      assert.ok(result.message.includes('Test Release'));
      assert.ok(result.message.includes('release-1'));
      assert.ok(ctx.releaseManager.createRelease.calledOnce);
    });

    test('should return error for missing name', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: name' });

      const result = await handleCreateRelease({
        planIds: ['plan-1'],
        releaseBranch: 'release/test',
      }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('name'));
    });

    test('should return error for missing planIds', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: planIds' });

      const result = await handleCreateRelease({
        name: 'Test Release',
        releaseBranch: 'release/test',
      }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planIds'));
    });

    test('should return error for empty planIds array', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'planIds must not be empty' });

      const result = await handleCreateRelease({
        name: 'Test Release',
        planIds: [],
        releaseBranch: 'release/test',
      }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return error for non-existent plans', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        createRelease: sinon.stub().rejects(new Error('Plan not found: plan-999')),
      });

      const result = await handleCreateRelease({
        name: 'Test Release',
        planIds: ['plan-999'],
        releaseBranch: 'release/test',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should return error for non-succeeded plans', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        createRelease: sinon.stub().rejects(new Error('Plan plan-1 status is failed, not succeeded')),
      });

      const result = await handleCreateRelease({
        name: 'Test Release',
        planIds: ['plan-1'],
        releaseBranch: 'release/test',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('failed'));
    });

    test('should auto-start when autoStart=true', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease();
      const ctx = makeCtx({
        createRelease: sinon.stub().resolves(mockRelease),
        startRelease: sinon.stub().resolves(),
      });

      const result = await handleCreateRelease({
        name: 'Test Release',
        planIds: ['plan-1', 'plan-2'],
        releaseBranch: 'release/test',
        autoStart: true,
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(ctx.releaseManager.startRelease.calledOnce);
      assert.ok(ctx.releaseManager.startRelease.calledWith('release-1'));
      assert.ok(result.message.includes('started'));
    });

    test('should return error when release manager not available', async () => {
      const { handleCreateRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx();
      ctx.releaseManager = undefined;

      const result = await handleCreateRelease({
        name: 'Test Release',
        planIds: ['plan-1'],
        releaseBranch: 'release/test',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Release manager not available'));
    });
  });

  suite('handleStartRelease', () => {
    test('should start release with valid releaseId', async () => {
      const { handleStartRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        startRelease: sinon.stub().resolves(),
      });

      const result = await handleStartRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.ok(result.message.includes('started'));
      assert.ok(ctx.releaseManager.startRelease.calledOnce);
      assert.ok(ctx.releaseManager.startRelease.calledWith('release-1'));
    });

    test('should return error for missing releaseId', async () => {
      const { handleStartRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: releaseId' });

      const result = await handleStartRelease({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('releaseId'));
    });

    test('should return error for non-existent release', async () => {
      const { handleStartRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        startRelease: sinon.stub().rejects(new Error('Release not found: release-999')),
      });

      const result = await handleStartRelease({
        releaseId: 'release-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return error for non-drafting release', async () => {
      const { handleStartRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        startRelease: sinon.stub().rejects(new Error('Release already started')),
      });

      const result = await handleStartRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('already started'));
    });

    test('should return error when release manager not available', async () => {
      const { handleStartRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx();
      ctx.releaseManager = undefined;

      const result = await handleStartRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Release manager not available'));
    });
  });

  suite('handleGetReleaseStatus', () => {
    test('should return status with progress', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({ status: 'merging', startedAt: Date.now() });
      const mockProgress = makeMockProgress();
      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(mockProgress),
      });

      const result = await handleGetReleaseStatus({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.release.id, 'release-1');
      assert.strictEqual(result.release.status, 'merging');
      assert.ok(result.progress);
      assert.strictEqual(result.progress.phase, 'merging');
      assert.ok(ctx.releaseManager.getRelease.calledOnce);
      assert.ok(ctx.releaseManager.getReleaseProgress.calledOnce);
    });

    test('should return error for missing releaseId', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: releaseId' });

      const result = await handleGetReleaseStatus({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('releaseId'));
    });

    test('should return not-found for unknown release', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        getRelease: sinon.stub().returns(undefined),
      });

      const result = await handleGetReleaseStatus({
        releaseId: 'release-999',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return status without progress when progress unavailable', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({ status: 'succeeded', endedAt: Date.now() });
      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(undefined),
      });

      const result = await handleGetReleaseStatus({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.release.status, 'succeeded');
      assert.strictEqual(result.progress, null);
    });

    test('should return error when release manager not available', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx();
      ctx.releaseManager = undefined;

      const result = await handleGetReleaseStatus({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Release manager not available'));
    });
  });

  suite('handleCancelRelease', () => {
    test('should cancel active release', async () => {
      const { handleCancelRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        cancelRelease: sinon.stub().resolves(true),
      });

      const result = await handleCancelRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.ok(result.message.includes('canceled'));
      assert.ok(ctx.releaseManager.cancelRelease.calledOnce);
      assert.ok(ctx.releaseManager.cancelRelease.calledWith('release-1'));
    });

    test('should return error for missing releaseId', async () => {
      const { handleCancelRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing required field: releaseId' });

      const result = await handleCancelRelease({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('releaseId'));
    });

    test('should return error for already-completed release', async () => {
      const { handleCancelRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        cancelRelease: sinon.stub().resolves(false),
      });

      const result = await handleCancelRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found or already in terminal status'));
    });

    test('should return error when cancel throws exception', async () => {
      const { handleCancelRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        cancelRelease: sinon.stub().rejects(new Error('Internal error')),
      });

      const result = await handleCancelRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Internal error'));
    });

    test('should return error when release manager not available', async () => {
      const { handleCancelRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx();
      ctx.releaseManager = undefined;

      const result = await handleCancelRelease({
        releaseId: 'release-1',
      }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Release manager not available'));
    });
  });

  suite('handleListReleases', () => {
    test('should return all releases', async () => {
      const { handleListReleases } = require('../../../mcp/handlers/plan/releaseHandlers');
      const release1 = makeMockRelease({ id: 'release-1', name: 'Release 1' });
      const release2 = makeMockRelease({ id: 'release-2', name: 'Release 2', status: 'succeeded' });
      const ctx = makeCtx({
        getAllReleases: sinon.stub().returns([release1, release2]),
      });

      const result = await handleListReleases({}, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releases.length, 2);
      assert.strictEqual(result.count, 2);
      assert.strictEqual(result.releases[0].id, 'release-1');
      assert.strictEqual(result.releases[1].id, 'release-2');
      assert.ok(ctx.releaseManager.getAllReleases.calledOnce);
    });

    test('should return empty array when none', async () => {
      const { handleListReleases } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        getAllReleases: sinon.stub().returns([]),
      });

      const result = await handleListReleases({}, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releases.length, 0);
      assert.strictEqual(result.count, 0);
    });

    test('should filter by status when provided', async () => {
      const { handleListReleases } = require('../../../mcp/handlers/plan/releaseHandlers');
      const release1 = makeMockRelease({ id: 'release-1', status: 'drafting' });
      const ctx = makeCtx({
        getReleasesByStatus: sinon.stub().returns([release1]),
      });

      const result = await handleListReleases({ status: 'drafting' }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releases.length, 1);
      assert.strictEqual(result.releases[0].status, 'drafting');
      assert.ok(ctx.releaseManager.getReleasesByStatus.calledOnce);
      assert.ok(ctx.releaseManager.getReleasesByStatus.calledWith('drafting'));
    });

    test('should sanitize release output fields', async () => {
      const { handleListReleases } = require('../../../mcp/handlers/plan/releaseHandlers');
      const release = makeMockRelease({
        id: 'release-1',
        name: 'Test',
        planIds: ['p1'],
        releaseBranch: 'release/test',
        targetBranch: 'main',
        status: 'succeeded',
        prNumber: 123,
        prUrl: 'https://github.com/org/repo/pull/123',
        createdAt: 1000000,
        startedAt: 1000100,
        endedAt: 1000200,
        error: undefined,
      });
      const ctx = makeCtx({
        getAllReleases: sinon.stub().returns([release]),
      });

      const result = await handleListReleases({}, ctx);

      assert.strictEqual(result.success, true);
      const sanitized = result.releases[0];
      assert.strictEqual(sanitized.id, 'release-1');
      assert.strictEqual(sanitized.name, 'Test');
      assert.deepStrictEqual(sanitized.planIds, ['p1']);
      assert.strictEqual(sanitized.releaseBranch, 'release/test');
      assert.strictEqual(sanitized.targetBranch, 'main');
      assert.strictEqual(sanitized.status, 'succeeded');
      assert.strictEqual(sanitized.prNumber, 123);
      assert.strictEqual(sanitized.prUrl, 'https://github.com/org/repo/pull/123');
      assert.strictEqual(sanitized.createdAt, 1000000);
      assert.strictEqual(sanitized.startedAt, 1000100);
      assert.strictEqual(sanitized.endedAt, 1000200);
      assert.strictEqual(sanitized.error, undefined);
    });

    test('should return error when release manager not available', async () => {
      const { handleListReleases } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx();
      ctx.releaseManager = undefined;

      const result = await handleListReleases({}, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Release manager not available'));
    });

    test('should handle exceptions gracefully', async () => {
      const { handleListReleases } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        getAllReleases: sinon.stub().throws(new Error('Database error')),
      });

      const result = await handleListReleases({}, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Database error'));
    });
  });
});
