/**
 * @fileoverview Unit tests for Release MCP Tool Handlers
 * 
 * Tests all release-centric MCP tool handlers including
 * prepare_copilot_release, execute_release_task, add_plans_to_release,
 * and get_copilot_release_status.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeMockReleaseManager(overrides?: Record<string, any>): any {
  return {
    createRelease: sinon.stub().resolves(makeMockRelease()),
    startRelease: sinon.stub().resolves(),
    cancelRelease: sinon.stub().resolves(true),
    getRelease: sinon.stub().returns(undefined),
    getAllReleases: sinon.stub().returns([]),
    getReleasesByStatus: sinon.stub().returns([]),
    getReleaseProgress: sinon.stub().returns(undefined),
    transitionToState: sinon.stub().resolves(true),
    executePreparationTask: sinon.stub().resolves(),
    skipPreparationTask: sinon.stub().resolves(),
    addPlansToRelease: sinon.stub().resolves(),
    adoptPR: sinon.stub().resolves(),
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
    flowType: 'from-plans',
    source: 'from-plans',
    planIds: ['plan-1', 'plan-2'],
    releaseBranch: 'release/test',
    targetBranch: 'main',
    repoPath: '/workspace',
    status: 'drafting',
    stateHistory: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMockProgress(overrides?: Record<string, any>): any {
  return {
    status: 'merging',
    currentStep: 'Merging plan commits',
    mergeProgress: {
      merged: 2,
      total: 5,
      results: [],
    },
    ...overrides,
  };
}

function makeCtx(releaseManagerOverrides?: Record<string, any>): any {
  return {
    releaseManager: makeMockReleaseManager(releaseManagerOverrides),
    workspacePath: '/workspace',
  };
}

suite('releaseMCPTools', () => {
  let sandbox: sinon.SinonSandbox;
  let validateStub: sinon.SinonStub;
  let silence: ReturnType<typeof silenceConsole>;

  setup(() => {
    sandbox = sinon.createSandbox();
    silence = silenceConsole();
    const validator = require('../../../mcp/validation/validator');
    validateStub = sandbox.stub(validator, 'validateInput').returns({ valid: true });
  });

  teardown(() => {
    sandbox.restore();
    silence.restore();
  });

  suite('handlePrepareRelease', () => {
    test('should transition release to preparing', async () => {
      const { handlePrepareRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({ status: 'preparing' });
      const ctx = makeCtx({
        transitionToState: sinon.stub().resolves(true),
        getRelease: sinon.stub().returns(mockRelease),
      });

      const result = await handlePrepareRelease({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.ok(result.message.includes('preparing'));
      assert.ok(ctx.releaseManager.transitionToState.calledWith('release-1', 'preparing'));
    });

    test('should return error if release not found', async () => {
      const { handlePrepareRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        transitionToState: sinon.stub().resolves(false),
        getRelease: sinon.stub().returns(undefined),
      });

      const result = await handlePrepareRelease({ releaseId: 'invalid' }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return error if transition fails', async () => {
      const { handlePrepareRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({ status: 'merging' });
      const ctx = makeCtx({
        transitionToState: sinon.stub().resolves(false),
        getRelease: sinon.stub().returns(mockRelease),
      });

      const result = await handlePrepareRelease({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Cannot transition'));
    });

    test('should validate input schema', async () => {
      const { handlePrepareRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing releaseId' });

      const result = await handlePrepareRelease({}, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Missing releaseId'));
    });

    test('should return error if release manager not available', async () => {
      const { handlePrepareRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = { releaseManager: undefined };

      const result = await handlePrepareRelease({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not available'));
    });
  });

  suite('handleExecuteReleaseTask', () => {
    test('should execute preparation task', async () => {
      const { handleExecuteReleaseTask } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        executePreparationTask: sinon.stub().resolves(),
      });

      const result = await handleExecuteReleaseTask(
        { releaseId: 'release-1', taskId: 'update-changelog' },
        ctx
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.strictEqual(result.taskId, 'update-changelog');
      assert.ok(result.message.includes('executed successfully'));
      assert.ok(ctx.releaseManager.executePreparationTask.calledWith('release-1', 'update-changelog'));
    });

    test('should handle execution failure', async () => {
      const { handleExecuteReleaseTask } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        executePreparationTask: sinon.stub().rejects(new Error('Task execution failed')),
      });

      const result = await handleExecuteReleaseTask(
        { releaseId: 'release-1', taskId: 'update-changelog' },
        ctx
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Task execution failed'));
    });

    test('should validate input schema', async () => {
      const { handleExecuteReleaseTask } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'Missing taskId' });

      const result = await handleExecuteReleaseTask({ releaseId: 'release-1' }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Missing taskId'));
    });

    test('should return error if release manager not available', async () => {
      const { handleExecuteReleaseTask } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = { releaseManager: undefined };

      const result = await handleExecuteReleaseTask(
        { releaseId: 'release-1', taskId: 'task-1' },
        ctx
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not available'));
    });
  });

  suite('handleSkipReleaseTask', () => {
    test('should skip preparation task', async () => {
      const { handleSkipReleaseTask } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        skipPreparationTask: sinon.stub().resolves(),
      });

      const result = await handleSkipReleaseTask(
        { releaseId: 'release-1', taskId: 'update-docs' },
        ctx
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.strictEqual(result.taskId, 'update-docs');
      assert.ok(result.message.includes('skipped'));
      assert.ok(ctx.releaseManager.skipPreparationTask.calledWith('release-1', 'update-docs'));
    });

    test('should handle skip failure', async () => {
      const { handleSkipReleaseTask } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        skipPreparationTask: sinon.stub().rejects(new Error('Cannot skip required task')),
      });

      const result = await handleSkipReleaseTask(
        { releaseId: 'release-1', taskId: 'run-checks' },
        ctx
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Cannot skip required task'));
    });
  });

  suite('handleAddPlansToRelease', () => {
    test('should add plans to release', async () => {
      const { handleAddPlansToRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        addPlansToRelease: sinon.stub().resolves(),
      });

      const result = await handleAddPlansToRelease(
        { releaseId: 'release-1', planIds: ['plan-3', 'plan-4'] },
        ctx
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.releaseId, 'release-1');
      assert.deepStrictEqual(result.planIds, ['plan-3', 'plan-4']);
      assert.ok(result.message.includes('2 plan(s)'));
      assert.ok(ctx.releaseManager.addPlansToRelease.calledWith('release-1', ['plan-3', 'plan-4']));
    });

    test('should handle addition failure', async () => {
      const { handleAddPlansToRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        addPlansToRelease: sinon.stub().rejects(new Error('Plan not found')),
      });

      const result = await handleAddPlansToRelease(
        { releaseId: 'release-1', planIds: ['invalid'] },
        ctx
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should validate input schema', async () => {
      const { handleAddPlansToRelease } = require('../../../mcp/handlers/plan/releaseHandlers');
      validateStub.returns({ valid: false, error: 'planIds must be an array' });

      const result = await handleAddPlansToRelease({ releaseId: 'release-1' }, makeCtx());

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planIds must be an array'));
    });
  });

  suite('handleGetReleaseStatus - updated response', () => {
    test('should return status with preparation tasks', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({
        status: 'preparing',
        preparationTasks: [
          {
            id: 'update-changelog',
            type: 'update-changelog',
            title: 'Update CHANGELOG',
            description: 'Update changelog',
            status: 'completed',
            required: true,
            automatable: true,
          },
          {
            id: 'run-checks',
            type: 'run-checks',
            title: 'Run Checks',
            description: 'Run build and tests',
            status: 'pending',
            required: true,
            automatable: true,
          },
        ],
      });

      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(null),
      });

      // Inject state machine mock
      (ctx.releaseManager as any).stateMachines = new Map([
        [
          'release-1',
          {
            release: mockRelease,
            canTransition: sinon.stub().callsFake((status: string) => {
              if (status === 'ready-for-pr' || status === 'canceled') {
                return { valid: true };
              }
              return { valid: false };
            }),
          },
        ],
      ]);

      const result = await handleGetReleaseStatus({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.release.id, 'release-1');
      assert.strictEqual(result.release.status, 'preparing');
      assert.ok(Array.isArray(result.release.preparationTasks));
      assert.strictEqual(result.release.preparationTasks.length, 2);
      assert.strictEqual(result.release.preparationTasks[0].id, 'update-changelog');
      assert.strictEqual(result.release.preparationTasks[0].status, 'completed');
    });

    test('should return status with state history', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({
        status: 'merging',
        stateHistory: [
          { from: 'drafting', to: 'drafting', timestamp: 1000, reason: 'Created' },
          { from: 'drafting', to: 'preparing', timestamp: 2000, reason: 'User requested' },
          { from: 'preparing', to: 'merging', timestamp: 3000, reason: 'Tasks complete' },
        ],
      });

      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(null),
      });

      (ctx.releaseManager as any).stateMachines = new Map([
        ['release-1', { release: mockRelease, canTransition: () => ({ valid: false }) }],
      ]);

      const result = await handleGetReleaseStatus({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(Array.isArray(result.release.stateHistory));
      assert.strictEqual(result.release.stateHistory.length, 3);
      assert.strictEqual(result.release.stateHistory[2].to, 'merging');
    });

    test('should return available transitions', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({ status: 'drafting' });

      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(null),
      });

      const mockCanTransition = sinon.stub();
      // Set up responses for all possible transitions
      mockCanTransition.returns({ valid: false }); // Default
      mockCanTransition.withArgs('preparing').returns({ valid: true });
      mockCanTransition.withArgs('canceled').returns({ valid: true });

      (ctx.releaseManager as any).stateMachines = new Map([
        ['release-1', { release: mockRelease, canTransition: mockCanTransition }],
      ]);

      const result = await handleGetReleaseStatus({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(Array.isArray(result.release.availableTransitions));
      // Should include only valid transitions
      assert.ok(result.release.availableTransitions.includes('preparing'), 'Should include preparing');
      assert.ok(result.release.availableTransitions.includes('canceled'), 'Should include canceled');
      // Should not include invalid transitions
      assert.ok(!result.release.availableTransitions.includes('merging'), 'Should not include merging');
    });

    test('should return PR details if available', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({
        status: 'pr-active',
        prNumber: 123,
        prUrl: 'https://github.com/test/repo/pull/123',
      });

      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(null),
      });

      (ctx.releaseManager as any).stateMachines = new Map([
        ['release-1', { release: mockRelease, canTransition: () => ({ valid: false }) }],
      ]);

      const result = await handleGetReleaseStatus({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.release.prNumber, 123);
      assert.strictEqual(result.release.prUrl, 'https://github.com/test/repo/pull/123');
    });

    test('should return progress information', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease({ status: 'merging' });
      const mockProgress = makeMockProgress();

      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(mockProgress),
      });

      (ctx.releaseManager as any).stateMachines = new Map([
        ['release-1', { release: mockRelease, canTransition: () => ({ valid: false }) }],
      ]);

      const result = await handleGetReleaseStatus({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.progress);
      assert.strictEqual(result.progress.status, 'merging');
      assert.strictEqual(result.progress.currentStep, 'Merging plan commits');
    });

    test('should return error if release not found', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const ctx = makeCtx({
        getRelease: sinon.stub().returns(undefined),
      });

      const result = await handleGetReleaseStatus({ releaseId: 'invalid' }, ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should handle missing state machine gracefully', async () => {
      const { handleGetReleaseStatus } = require('../../../mcp/handlers/plan/releaseHandlers');
      const mockRelease = makeMockRelease();

      const ctx = makeCtx({
        getRelease: sinon.stub().returns(mockRelease),
        getReleaseProgress: sinon.stub().returns(null),
      });

      // No state machine available
      (ctx.releaseManager as any).stateMachines = undefined;

      const result = await handleGetReleaseStatus({ releaseId: 'release-1' }, ctx);

      assert.strictEqual(result.success, true);
      assert.ok(Array.isArray(result.release.availableTransitions));
      assert.strictEqual(result.release.availableTransitions.length, 0);
    });
  });
});
