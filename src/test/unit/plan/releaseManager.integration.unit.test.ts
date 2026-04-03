/**
 * @fileoverview Integration Unit Tests for DefaultReleaseManager
 * 
 * Tests the complete release lifecycle including state machine integration,
 * preparation tasks, plan addition, and PR adoption.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultReleaseManager } from '../../../plan/releaseManager';
import type { ReleaseDefinition } from '../../../plan/types/release';
import type { CreateReleaseOptions } from '../../../interfaces/IReleaseManager';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    get: sinon.stub().returns({
      id: 'plan-1',
      spec: { repoPath: '/workspace' },
      repoPath: '/workspace',
    }),
    getAll: sinon.stub().returns([]),
    enqueue: sinon.stub(),
    cancel: sinon.stub(),
    delete: sinon.stub(),
    pause: sinon.stub(),
    resume: sinon.stub(),
    getStateMachine: sinon.stub().returns({
      computePlanStatus: sinon.stub().returns('succeeded'),
    }),
    on: sinon.stub(),
    off: sinon.stub(),
    ...overrides,
  };
}

function createMockGitOps(): any {
  return {
    branches: {
      current: sinon.stub().resolves('main'),
      create: sinon.stub().resolves(),
      checkout: sinon.stub().resolves(),
      exists: sinon.stub().resolves(true),
    },
    repository: {
      fetch: sinon.stub().resolves(),
      push: sinon.stub().resolves(true),
      hasChanges: sinon.stub().resolves(false),
      stageAll: sinon.stub().resolves(),
      commit: sinon.stub().resolves(),
      getHead: sinon.stub().resolves('abc123'),
    },
    merge: {
      merge: sinon.stub().resolves({ success: true }),
      listConflicts: sinon.stub().resolves([]),
      continueAfterResolve: sinon.stub().resolves(true),
      abort: sinon.stub().resolves(),
    },
    worktrees: {
      createDetachedWithTiming: sinon.stub().resolves(),
    },
  };
}

function createMockCopilot(): any {
  return {
    run: sinon.stub().resolves({
      success: true,
      sessionId: 'test',
      metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 },
    }),
    isAvailable: sinon.stub().returns(true),
  };
}

function createMockIsolatedRepos(): any {
  return {
    createIsolatedRepo: sinon.stub().resolves({
      releaseId: 'rel-1',
      clonePath: '/repo/.orchestrator/release/release-v1',
      isReady: true,
      currentBranch: 'main',
    }),
    getRepoPath: sinon.stub().resolves('/repo/.orchestrator/release/release-v1'),
    getRepoInfo: sinon.stub().resolves(null),
    removeIsolatedRepo: sinon.stub().resolves(true),
    cleanupAll: sinon.stub().resolves(0),
    listActive: sinon.stub().resolves([]),
  };
}

function createMockPRMonitor(): any {
  return {
    startMonitoring: sinon.stub().resolves(),
    stopMonitoring: sinon.stub(),
    isMonitoring: sinon.stub().returns(false),
    getMonitorCycles: sinon.stub().returns([]),
  };
}

function createMockPRServiceFactory(): any {
  const mockPRService = {
    createPR: sinon.stub().resolves({ prNumber: 42, prUrl: 'https://github.com/test/repo/pull/42' }),
    getPRChecks: sinon.stub().resolves([]),
    getPRComments: sinon.stub().resolves([]),
    getSecurityAlerts: sinon.stub().resolves([]),
    replyToComment: sinon.stub().resolves(),
    resolveThread: sinon.stub().resolves(),
  };

  return {
    getServiceForRepo: sinon.stub().resolves(mockPRService),
    mockPRService,
  };
}

function createMockReleaseStore(): any {
  return {
    saveRelease: sinon.stub().resolves(),
    loadRelease: sinon.stub().resolves(null),
    deleteRelease: sinon.stub().resolves(true),
    listReleases: sinon.stub().resolves([]),
  };
}

suite('DefaultReleaseManager - Integration', () => {
  let sandbox: sinon.SinonSandbox;
  let silence: ReturnType<typeof silenceConsole>;

  setup(() => {
    sandbox = sinon.createSandbox();
    silence = silenceConsole();
  });

  teardown(() => {
    sandbox.restore();
    silence.restore();
  });

  suite('createRelease - from-branch flow', () => {
    test('should create release with repoPath', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      const copilot = createMockCopilot();
      const isolatedRepos = createMockIsolatedRepos();
      const prMonitor = createMockPRMonitor();
      const prServiceFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();

      const manager = new DefaultReleaseManager(
        planRunner,
        git,
        copilot,
        isolatedRepos,
        prMonitor,
        prServiceFactory,
        store
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        targetBranch: 'main',
        repoPath: '/workspace',
      };

      const release = await manager.createRelease(options);

      assert.strictEqual(release.name, 'Release v1.0.0');
      assert.strictEqual(release.flowType, 'from-branch');
      assert.strictEqual(release.source, 'from-branch');
      assert.deepStrictEqual(release.planIds, []);
      assert.strictEqual(release.releaseBranch, 'release/v1.0.0');
      assert.strictEqual(release.targetBranch, 'main');
      assert.strictEqual(release.repoPath, '/workspace');
      assert.strictEqual(release.status, 'drafting');
      assert.ok(release.id);
      assert.ok(release.createdAt);
      assert.strictEqual(release.stateHistory.length, 1);
    });

    test('should fail if repoPath missing when planIds empty', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        // repoPath missing
      };

      await assert.rejects(
        async () => manager.createRelease(options),
        (error: any) => {
          assert.ok(error.message.includes('repoPath is required'));
          return true;
        }
      );
    });

    test('should default targetBranch to current branch', async () => {
      const git = createMockGitOps();
      git.branches.current.resolves('develop');

      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        git,
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
        // targetBranch not specified
      };

      const release = await manager.createRelease(options);

      assert.strictEqual(release.targetBranch, 'develop');
    });

    test('should default to main if current branch detection fails', async () => {
      const git = createMockGitOps();
      git.branches.current.rejects(new Error('Not a git repo'));

      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        git,
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      };

      const release = await manager.createRelease(options);

      assert.strictEqual(release.targetBranch, 'main');
    });
  });

  suite('createRelease - from-plans flow', () => {
    test('should create release with planIds', async () => {
      const planRunner = createMockPlanRunner();
      planRunner.get.withArgs('plan-1').returns({
        id: 'plan-1',
        spec: { repoPath: '/workspace' },
        repoPath: '/workspace',
      });
      planRunner.get.withArgs('plan-2').returns({
        id: 'plan-2',
        spec: { repoPath: '/workspace' },
        repoPath: '/workspace',
      });

      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: ['plan-1', 'plan-2'],
        releaseBranch: 'release/v1.0.0',
        targetBranch: 'main',
      };

      const release = await manager.createRelease(options);

      assert.strictEqual(release.flowType, 'from-plans');
      assert.strictEqual(release.source, 'from-plans');
      assert.deepStrictEqual(release.planIds, ['plan-1', 'plan-2']);
      assert.strictEqual(release.repoPath, '/workspace');
    });

    test('should validate all plans exist', async () => {
      const planRunner = createMockPlanRunner();
      planRunner.get.withArgs('plan-1').returns({
        id: 'plan-1',
        spec: { repoPath: '/workspace' },
        repoPath: '/workspace',
      });
      planRunner.get.withArgs('plan-2').returns(undefined);

      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: ['plan-1', 'plan-2'],
        releaseBranch: 'release/v1.0.0',
      };

      await assert.rejects(
        async () => manager.createRelease(options),
        (error: any) => {
          assert.ok(error.message.includes('Plan not found'));
          assert.ok(error.message.includes('plan-2'));
          return true;
        }
      );
    });

    test('should validate plans are in terminal states', async () => {
      const planRunner = createMockPlanRunner();
      planRunner.get.returns({
        id: 'plan-1',
        spec: { repoPath: '/workspace' },
        repoPath: '/workspace',
      });
      planRunner.getStateMachine.returns({
        computePlanStatus: sinon.stub().returns('running'),
      });

      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const options: CreateReleaseOptions = {
        name: 'Release v1.0.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0.0',
      };

      await assert.rejects(
        async () => manager.createRelease(options),
        (error: any) => {
          assert.ok(error.message.includes('must be succeeded or partial'));
          assert.ok(error.message.includes('running'));
          return true;
        }
      );
    });
  });

  suite('prepareRelease', () => {
    test('should initialize preparation tasks', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      // Call prepareRelease via transitionToState
      const success = await manager.transitionToState(release.id, 'preparing');
      assert.strictEqual(success, true);

      const updated = manager.getRelease(release.id);
      assert.ok(updated);
      assert.strictEqual(updated.status, 'preparing');
      assert.ok(updated.preparationTasks);
      assert.ok(updated.preparationTasks.length > 0);

      // Check that tasks were generated
      const changelogTask = updated.preparationTasks.find(t => t.id === 'update-changelog');
      assert.ok(changelogTask);
      assert.strictEqual(changelogTask.status, 'pending');
    });

    test('should transition to preparing from drafting', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      assert.strictEqual(release.status, 'drafting');

      const success = await manager.transitionToState(release.id, 'preparing');
      assert.strictEqual(success, true);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.status, 'preparing');
    });
  });

  suite('addPlansToRelease', () => {
    test('should add plans to release in drafting', async () => {
      const planRunner = createMockPlanRunner();
      planRunner.get.withArgs('plan-3').returns({
        id: 'plan-3',
        spec: { repoPath: '/workspace' },
        repoPath: '/workspace',
      });

      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0.0',
      });

      await manager.addPlansToRelease(release.id, ['plan-3']);

      const updated = manager.getRelease(release.id);
      assert.deepStrictEqual(updated?.planIds, ['plan-1', 'plan-3']);
    });

    test('should add plans to release in preparing', async () => {
      const planRunner = createMockPlanRunner();
      planRunner.get.withArgs('plan-3').returns({
        id: 'plan-3',
        spec: { repoPath: '/workspace' },
        repoPath: '/workspace',
      });

      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0.0',
      });

      await manager.transitionToState(release.id, 'preparing');
      await manager.addPlansToRelease(release.id, ['plan-3']);

      const updated = manager.getRelease(release.id);
      assert.deepStrictEqual(updated?.planIds, ['plan-1', 'plan-3']);
    });

    test('should validate added plans exist', async () => {
      const planRunner = createMockPlanRunner();
      planRunner.get.withArgs('invalid').returns(undefined);

      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0.0',
      });

      await assert.rejects(
        async () => manager.addPlansToRelease(release.id, ['invalid']),
        (error: any) => {
          assert.ok(error.message.includes('Plan not found'));
          assert.ok(error.message.includes('invalid'));
          return true;
        }
      );
    });
  });

  suite('adoptExistingPR', () => {
    test('should adopt existing PR and transition to pr-active', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      await manager.adoptPR(release.id, 123);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.prNumber, 123);
      assert.strictEqual(updated?.status, 'pr-active');
    });

    test('should fail if release not found', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      await assert.rejects(
        async () => manager.adoptPR('invalid-id', 123),
        (error: any) => {
          assert.ok(error.message.includes('not found'));
          return true;
        }
      );
    });
  });

  suite('state machine integration', () => {
    test('should emit events on transitions', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const statusChangedSpy = sinon.spy();
      manager.on('releaseStatusChanged', statusChangedSpy);

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      await manager.transitionToState(release.id, 'preparing');

      assert.ok(statusChangedSpy.called);
      const updated = statusChangedSpy.lastCall.args[0];
      assert.strictEqual(updated.status, 'preparing');
    });

    test('should validate state transitions via state machine', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      // Invalid transition: drafting -> succeeded (must go through intermediate states)
      const success = await manager.transitionToState(release.id, 'succeeded');
      assert.strictEqual(success, false);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.status, 'drafting'); // Unchanged
    });

    test('should record state history', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      await manager.transitionToState(release.id, 'preparing');
      await manager.transitionToState(release.id, 'canceled');

      const updated = manager.getRelease(release.id);
      assert.ok(updated);
      assert.ok(updated.stateHistory.length >= 3);

      const lastTransition = updated.stateHistory[updated.stateHistory.length - 1];
      assert.strictEqual(lastTransition.from, 'preparing');
      assert.strictEqual(lastTransition.to, 'canceled');
    });
  });

  suite('getReleasesByStatus', () => {
    test('should filter releases by status', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const rel1 = await manager.createRelease({
        name: 'Release 1',
        planIds: [],
        releaseBranch: 'release/v1',
        repoPath: '/workspace',
      });

      const rel2 = await manager.createRelease({
        name: 'Release 2',
        planIds: [],
        releaseBranch: 'release/v2',
        repoPath: '/workspace',
      });

      await manager.transitionToState(rel2.id, 'preparing');

      const drafting = manager.getReleasesByStatus('drafting');
      const preparing = manager.getReleasesByStatus('preparing');

      assert.strictEqual(drafting.length, 1);
      assert.strictEqual(drafting[0].id, rel1.id);
      assert.strictEqual(preparing.length, 1);
      assert.strictEqual(preparing[0].id, rel2.id);
    });
  });

  suite('deleteRelease', () => {
    test('should delete terminal release', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      await manager.transitionToState(release.id, 'canceled');

      const deleted = manager.deleteRelease(release.id);
      assert.strictEqual(deleted, true);

      const found = manager.getRelease(release.id);
      assert.strictEqual(found, undefined);
    });

    test('should not delete non-terminal release', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore()
      );

      const release = await manager.createRelease({
        name: 'Release v1.0.0',
        planIds: [],
        releaseBranch: 'release/v1.0.0',
        repoPath: '/workspace',
      });

      const deleted = manager.deleteRelease(release.id);
      assert.strictEqual(deleted, false);

      const found = manager.getRelease(release.id);
      assert.ok(found);
    });
  });
});
