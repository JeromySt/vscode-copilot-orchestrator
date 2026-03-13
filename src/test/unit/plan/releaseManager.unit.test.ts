/**
 * @fileoverview Unit tests for DefaultReleaseManager
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultReleaseManager } from '../../../plan/releaseManager';
import type { ReleaseDefinition } from '../../../plan/types/release';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    get: sinon.stub().returns(undefined),
    getAll: sinon.stub().returns([]),
    enqueue: sinon.stub(),
    cancel: sinon.stub(),
    delete: sinon.stub(),
    pause: sinon.stub(),
    resume: sinon.stub(),
    getStateMachine: sinon.stub().returns({ computePlanStatus: () => 'succeeded' }),
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
    run: sinon.stub().resolves({ success: true, sessionId: 'test', metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } }),
    isAvailable: sinon.stub().returns(true),
  };
}

function createMockIsolatedRepos(): any {
  return {
    createIsolatedRepo: sinon.stub().resolves({ 
      releaseId: 'rel-1', 
      clonePath: '/repo/.orchestrator/release/release-v1', 
      isReady: true,
      currentBranch: 'main'
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
  };
}

function createMockReleaseStore(): any {
  return {
    saveRelease: sinon.stub().resolves(),
    loadRelease: sinon.stub().resolves(undefined),
    loadAllReleases: sinon.stub().resolves([]),
    deleteRelease: sinon.stub().resolves(),
    saveMonitorCycles: sinon.stub().resolves(),
    loadMonitorCycles: sinon.stub().resolves([]),
  };
}

suite('ReleaseManager', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  suite('createRelease', () => {
    test('creates with valid plans', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', baseBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      assert.strictEqual(release.name, 'Release v1.0');
      assert.strictEqual(release.status, 'drafting');
      assert.deepStrictEqual(release.planIds, ['plan-1']);
      assert.ok(store.saveRelease.calledOnce);
    });

    test('rejects non-existent plan IDs', async () => {
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(undefined) });
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore(),
      );

      await assert.rejects(
        async () => manager.createRelease({
          name: 'Release v1.0',
          planIds: ['nonexistent'],
          releaseBranch: 'release/v1.0',
        }),
        /Plan not found: nonexistent/
      );
    });

    test('rejects non-succeeded plans', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo' },
        status: 'running',
      };
      const planRunner = createMockPlanRunner({
        get: sinon.stub().returns(mockPlan),
        getStateMachine: sinon.stub().returns({ computePlanStatus: () => 'running' }),
      });
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore(),
      );

      await assert.rejects(
        async () => manager.createRelease({
          name: 'Release v1.0',
          planIds: ['plan-1'],
          releaseBranch: 'release/v1.0',
        }),
        /must be succeeded or partial/
      );
    });

    test('sets drafting status', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', baseBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore(),
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      assert.strictEqual(release.status, 'drafting');
    });

    test('emits releaseCreated', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', baseBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore(),
      );

      let emitted: ReleaseDefinition | undefined;
      manager.on('releaseCreated', (release: ReleaseDefinition) => {
        emitted = release;
      });

      await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      assert.ok(emitted);
      assert.strictEqual(emitted!.name, 'Release v1.0');
    });

    test('persists to store', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', baseBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const store = createMockReleaseStore();
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      assert.ok(store.saveRelease.calledOnce);
      const saved = store.saveRelease.firstCall.args[0] as ReleaseDefinition;
      assert.strictEqual(saved.name, 'Release v1.0');
    });
  });

  suite('startRelease', () => {
    test('creates isolated clone under .orchestrator/release/', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const isolatedRepos = createMockIsolatedRepos();
      const git = createMockGitOps();
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        git,
        createMockCopilot(),
        isolatedRepos,
        createMockPRMonitor(),
        prFactory,
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(isolatedRepos.createIsolatedRepo.calledOnce);
      const call = isolatedRepos.createIsolatedRepo.firstCall;
      assert.strictEqual(call.args[0], release.id);
      assert.strictEqual(call.args[1], '/repo');
    });

    test('uses IRemotePRServiceFactory not gh/az directly', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        prFactory,
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(prFactory.getServiceForRepo.calledOnce);
    });

    test('merges each plan branch', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'feature-1' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const git = createMockGitOps();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        git,
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(git.merge.merge.calledOnce);
      const mergeCall = git.merge.merge.firstCall.args[0];
      assert.strictEqual(mergeCall.source, 'origin/feature-1');
      assert.strictEqual(mergeCall.fastForward, false);
    });

    test('pushes release branch', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const git = createMockGitOps();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        git,
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(git.repository.push.calledOnce);
      const pushCall = git.repository.push.firstCall.args[1];
      assert.strictEqual(pushCall.branch, 'release/v1.0');
    });

    test('creates PR via prService.createPR()', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        prFactory,
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      const prService = await prFactory.getServiceForRepo('/repo/.orchestrator/release/release-v1');
      assert.ok(prService.createPR.calledOnce);
      const prCall = prService.createPR.firstCall.args[0];
      assert.strictEqual(prCall.baseBranch, 'main');
      assert.strictEqual(prCall.headBranch, 'release/v1.0');
      assert.strictEqual(prCall.title, 'Release v1.0');
    });

    test('starts monitoring with isolated clone path', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const prMonitor = createMockPRMonitor();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        prMonitor,
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(prMonitor.startMonitoring.calledOnce);
      const call = prMonitor.startMonitoring.firstCall;
      assert.strictEqual(call.args[0], release.id);
      assert.strictEqual(call.args[1], 42);
      assert.strictEqual(call.args[2], '/repo/.orchestrator/release/release-v1');
      assert.strictEqual(call.args[3], 'release/v1.0');
    });

    test('handles merge conflict with Copilot CLI', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const git = createMockGitOps();
      git.merge.merge.resolves({ success: false });
      git.merge.listConflicts.resolves(['file1.ts', 'file2.ts']);
      git.merge.continueAfterResolve.resolves(true);
      
      const copilot = createMockCopilot();
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        git,
        copilot,
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(copilot.run.calledOnce);
      assert.ok(git.merge.continueAfterResolve.calledOnce);
    });

    test('emits status changes through phases', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const statuses: string[] = [];
      manager.on('releaseStatusChanged', (release: ReleaseDefinition) => {
        statuses.push(release.status);
      });

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await manager.startRelease(release.id);

      assert.ok(statuses.includes('merging'));
      assert.ok(statuses.includes('creating-pr'));
      assert.ok(statuses.includes('monitoring'));
    });

    test('sets failed on error', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const isolatedRepos = createMockIsolatedRepos();
      isolatedRepos.createIsolatedRepo.rejects(new Error('Failed to create clone'));
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        isolatedRepos,
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      await assert.rejects(
        async () => manager.startRelease(release.id),
        /Failed to create clone/
      );

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.status, 'failed');
      assert.strictEqual(updated?.error, 'Failed to create clone');
    });
  });

  suite('cancelRelease', () => {
    test('stops monitoring and updates status', async () => {
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const prMonitor = createMockPRMonitor();
      prMonitor.isMonitoring.returns(true);
      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        prMonitor,
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      // Manually set status to monitoring
      release.status = 'monitoring';

      const canceled = await manager.cancelRelease(release.id);

      assert.strictEqual(canceled, true);
      assert.ok(prMonitor.stopMonitoring.calledWith(release.id));
      
      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.status, 'canceled');
    });
  });

  suite('concurrent releases', () => {
    test('multiple releases use separate clones', async () => {
      const mockPlan1 = {
        id: 'plan-1',
        spec: { name: 'Plan 1', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const mockPlan2 = {
        id: 'plan-2',
        spec: { name: 'Plan 2', repoPath: '/repo', targetBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({
        get: sinon.stub().callsFake((id: string) => {
          if (id === 'plan-1') return mockPlan1;
          if (id === 'plan-2') return mockPlan2;
          return undefined;
        }),
      });

      const isolatedRepos = createMockIsolatedRepos();
      isolatedRepos.createIsolatedRepo.callsFake((releaseId: string) => {
        return Promise.resolve({
          releaseId,
          clonePath: `/repo/.orchestrator/release/release-${releaseId}`,
          isReady: true,
          currentBranch: 'main',
        });
      });

      const store = createMockReleaseStore();
      
      const manager = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        isolatedRepos,
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release1 = await manager.createRelease({
        name: 'Release v1.0',
        planIds: ['plan-1'],
        releaseBranch: 'release/v1.0',
      });

      const release2 = await manager.createRelease({
        name: 'Release v2.0',
        planIds: ['plan-2'],
        releaseBranch: 'release/v2.0',
      });

      await manager.startRelease(release1.id);
      await manager.startRelease(release2.id);

      assert.strictEqual(isolatedRepos.createIsolatedRepo.callCount, 2);
      
      const call1 = isolatedRepos.createIsolatedRepo.getCall(0);
      const call2 = isolatedRepos.createIsolatedRepo.getCall(1);
      
      assert.strictEqual(call1.args[0], release1.id);
      assert.strictEqual(call2.args[0], release2.id);
      assert.notStrictEqual(call1.args[0], call2.args[0]);
    });
  });
});
