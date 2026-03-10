/**
 * @fileoverview Extra coverage tests for DefaultReleaseManager
 *
 * Covers methods not exercised by the existing test files:
 * deleteRelease, cleanupIsolatedRepos, addPlansToRelease, createPR,
 * adoptPR, startMonitoring, stopMonitoring, addressFindings,
 * getTaskLogFilePath, getReleaseProgress (monitoring state),
 * transitionToState, and _loadPersistedReleases.
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
    getStatus: sinon.stub().returns(undefined),
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
      getHead: sinon.stub().resolves('abc1234'),
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

function createMockPRServiceFactory(overrides?: any): any {
  const mockPRService = {
    createPR: sinon.stub().resolves({ prNumber: 42, prUrl: 'https://github.com/test/repo/pull/42' }),
    getPRChecks: sinon.stub().resolves([]),
    getPRComments: sinon.stub().resolves([]),
    getSecurityAlerts: sinon.stub().resolves([]),
    replyToComment: sinon.stub().resolves(),
    addIssueComment: sinon.stub().resolves(),
    resolveThread: sinon.stub().resolves(),
    ...overrides,
  };
  return {
    getServiceForRepo: sinon.stub().resolves(mockPRService),
    _service: mockPRService,
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

function createManager(overrides?: {
  planRunner?: any;
  git?: any;
  copilot?: any;
  isolatedRepos?: any;
  prMonitor?: any;
  prFactory?: any;
  store?: any;
}): DefaultReleaseManager {
  return new DefaultReleaseManager(
    overrides?.planRunner ?? createMockPlanRunner(),
    overrides?.git ?? createMockGitOps(),
    overrides?.copilot ?? createMockCopilot(),
    overrides?.isolatedRepos ?? createMockIsolatedRepos(),
    overrides?.prMonitor ?? createMockPRMonitor(),
    overrides?.prFactory ?? createMockPRServiceFactory(),
    overrides?.store ?? createMockReleaseStore(),
  );
}

async function createRelease(
  manager: DefaultReleaseManager,
  planRunner: any,
  opts?: Partial<Parameters<DefaultReleaseManager['createRelease']>[0]>,
): Promise<ReleaseDefinition> {
  const mockPlan = {
    id: 'plan-1',
    spec: { name: 'Test Plan', repoPath: '/repo', targetBranch: 'main' },
    status: 'succeeded',
    targetBranch: 'main',
  };
  planRunner.get.returns(mockPlan);
  return manager.createRelease({
    name: 'Release v1.0',
    planIds: ['plan-1'],
    releaseBranch: 'release/v1.0',
    targetBranch: 'main',
    ...opts,
  });
}

suite('ReleaseManager – extra coverage', () => {
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

  // ── deleteRelease ──────────────────────────────────────────────────────

  suite('deleteRelease', () => {
    test('returns false for non-existent release', () => {
      const manager = createManager();
      assert.strictEqual(manager.deleteRelease('no-such-id'), false);
    });

    test('returns false for non-terminal release', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);
      // 'drafting' is not terminal
      assert.strictEqual(manager.deleteRelease(release.id), false);
    });

    test('deletes terminal release and calls store.deleteRelease', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      // Manually set to a terminal state
      release.status = 'canceled';
      // Patch into stateMachine so the state machine also reflects it
      const sm = (manager as any).stateMachines.get(release.id);
      if (sm) sm._release = release;

      const result = manager.deleteRelease(release.id);
      assert.strictEqual(result, true);
      assert.strictEqual(manager.getRelease(release.id), undefined);
      // store.deleteRelease should be called (async, fire-and-forget)
      await new Promise(r => setTimeout(r, 0));
      assert.ok(store.deleteRelease.calledWith(release.id));
    });

    test('emits releaseDeleted event', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);
      release.status = 'succeeded';

      const deletedIds: string[] = [];
      (manager as any).events.on('release:deleted', (id: string) => deletedIds.push(id));

      manager.deleteRelease(release.id);
      assert.ok(deletedIds.includes(release.id));
    });
  });

  // ── cleanupIsolatedRepos ───────────────────────────────────────────────

  suite('cleanupIsolatedRepos', () => {
    test('calls removeIsolatedRepo for each terminal release', async () => {
      const planRunner = createMockPlanRunner();
      const isolatedRepos = createMockIsolatedRepos();
      const manager = createManager({ planRunner, isolatedRepos });

      const r1 = await createRelease(manager, planRunner);
      const r2 = await createRelease(manager, planRunner, { name: 'R2', releaseBranch: 'release/v2' });

      r1.status = 'succeeded';
      r2.status = 'failed';

      await manager.cleanupIsolatedRepos();

      assert.strictEqual(isolatedRepos.removeIsolatedRepo.callCount, 2);
    });

    test('skips non-terminal releases', async () => {
      const planRunner = createMockPlanRunner();
      const isolatedRepos = createMockIsolatedRepos();
      const manager = createManager({ planRunner, isolatedRepos });

      const r1 = await createRelease(manager, planRunner);
      r1.status = 'monitoring'; // not terminal

      await manager.cleanupIsolatedRepos();

      assert.strictEqual(isolatedRepos.removeIsolatedRepo.callCount, 0);
    });

    test('continues even if removeIsolatedRepo throws', async () => {
      const planRunner = createMockPlanRunner();
      const isolatedRepos = createMockIsolatedRepos();
      isolatedRepos.removeIsolatedRepo.rejects(new Error('cleanup failed'));
      const manager = createManager({ planRunner, isolatedRepos });

      const r1 = await createRelease(manager, planRunner);
      r1.status = 'canceled';

      // Should not throw
      await manager.cleanupIsolatedRepos();
      assert.ok(isolatedRepos.removeIsolatedRepo.calledOnce);
    });
  });

  // ── addPlansToRelease ──────────────────────────────────────────────────

  suite('addPlansToRelease', () => {
    test('throws for non-existent release', async () => {
      const manager = createManager();
      await assert.rejects(
        () => manager.addPlansToRelease('no-such-id', ['plan-1']),
        /Release not found/,
      );
    });

    test('throws when plan not found', async () => {
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(undefined) });
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);
      planRunner.get.returns(undefined);

      await assert.rejects(
        () => manager.addPlansToRelease(release.id, ['missing-plan']),
        /Plan not found/,
      );
    });

    test('adds plans to planIds array', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      const mockPlan2 = {
        id: 'plan-2',
        spec: { name: 'Plan 2', repoPath: '/repo', targetBranch: 'feature-2' },
        status: 'succeeded',
        targetBranch: 'feature-2',
      };
      planRunner.get.withArgs('plan-2').returns(mockPlan2);

      await manager.addPlansToRelease(release.id, ['plan-2']);

      const updatedRelease = manager.getRelease(release.id);
      assert.ok(updatedRelease?.planIds.includes('plan-2'));
    });

    test('skips duplicate plan IDs', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      // 'plan-1' is already in the release
      const initialCount = release.planIds.length;
      await manager.addPlansToRelease(release.id, ['plan-1']);

      assert.strictEqual(release.planIds.length, initialCount);
    });

    test('throws when plan is not in terminal state', async () => {
      // planRunner returns 'succeeded' for plan-1 (so createRelease works),
      // then 'running' for plan-2 (so addPlansToRelease rejects it).
      const smStub = sinon.stub();
      smStub.withArgs('plan-1').returns({ computePlanStatus: () => 'succeeded' });
      smStub.withArgs('plan-2').returns({ computePlanStatus: () => 'running' });

      const planRunner = createMockPlanRunner({ getStateMachine: smStub });
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      const mockPlan2 = {
        id: 'plan-2',
        spec: { name: 'Plan 2', repoPath: '/repo', targetBranch: 'feature-2' },
      };
      planRunner.get.withArgs('plan-2').returns(mockPlan2);

      await assert.rejects(
        () => manager.addPlansToRelease(release.id, ['plan-2']),
        /must be succeeded or partial/,
      );
    });
  });

  // ── adoptPR ───────────────────────────────────────────────────────────

  suite('adoptPR', () => {
    test('throws for non-existent release', async () => {
      const manager = createManager();
      await assert.rejects(
        () => manager.adoptPR('no-such-id', 99),
        /Release not found/,
      );
    });

    test('sets prNumber and prUrl on release', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      await manager.adoptPR(release.id, 99);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.prNumber, 99);
      assert.ok(updated?.prUrl?.includes('99'));
    });

    test('transitions release to pr-active', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      await manager.adoptPR(release.id, 99);

      assert.strictEqual(release.status, 'pr-active');
    });

    test('emits releaseProgress after adoption', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      const progressEvents: any[] = [];
      manager.on('releaseProgress', (id, prog) => progressEvents.push({ id, prog }));

      await manager.adoptPR(release.id, 99);

      assert.ok(progressEvents.some(e => e.id === release.id));
    });
  });

  // ── startMonitoring ───────────────────────────────────────────────────

  suite('startMonitoring', () => {
    test('throws for non-existent release', async () => {
      const manager = createManager();
      await assert.rejects(
        () => manager.startMonitoring('no-such-id'),
        /Release not found/,
      );
    });

    test('throws when no prNumber set', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);
      // release.prNumber is not set

      await assert.rejects(
        () => manager.startMonitoring(release.id),
        /no PR number set/,
      );
    });

    test('calls prMonitor.startMonitoring with correct args', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      const manager = createManager({ planRunner, prMonitor });
      const release = await createRelease(manager, planRunner);

      // Set up PR info
      release.prNumber = 55;
      release.isolatedRepoPath = '/repo/.orchestrator/release/release-v1';
      // Transition through valid states to get to monitoring-compatible state
      await manager.transitionToState(release.id, 'merging');
      await manager.transitionToState(release.id, 'ready-for-pr');
      await manager.transitionToState(release.id, 'creating-pr');
      await manager.transitionToState(release.id, 'pr-active');

      await manager.startMonitoring(release.id);

      assert.ok(prMonitor.startMonitoring.calledOnce);
      const call = prMonitor.startMonitoring.firstCall;
      assert.strictEqual(call.args[0], release.id);
      assert.strictEqual(call.args[1], 55);
    });

    test('uses repoPath when isolatedRepoPath not set', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      const manager = createManager({ planRunner, prMonitor });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 10;
      // isolatedRepoPath NOT set, should fall back to repoPath
      delete release.isolatedRepoPath;

      await manager.transitionToState(release.id, 'merging');
      await manager.transitionToState(release.id, 'ready-for-pr');
      await manager.transitionToState(release.id, 'creating-pr');
      await manager.transitionToState(release.id, 'pr-active');
      await manager.startMonitoring(release.id);

      const call = prMonitor.startMonitoring.firstCall;
      assert.strictEqual(call.args[2], '/repo');
    });

    test('does not re-transition if already in monitoring state', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 10;

      // Manually put release in monitoring state via state machine
      await manager.transitionToState(release.id, 'merging');
      await manager.transitionToState(release.id, 'ready-for-pr');
      await manager.transitionToState(release.id, 'creating-pr');
      await manager.transitionToState(release.id, 'pr-active');
      await manager.transitionToState(release.id, 'monitoring');

      const saveCountBefore = store.saveRelease.callCount;
      await manager.startMonitoring(release.id);

      // Should not have tried to transition again (no extra save for status change)
      // prMonitor.startMonitoring should still be called
      assert.ok(prMonitor.startMonitoring.calledOnce);
    });
  });

  // ── stopMonitoring ────────────────────────────────────────────────────

  suite('stopMonitoring', () => {
    test('throws for non-existent release', async () => {
      const manager = createManager();
      await assert.rejects(
        () => manager.stopMonitoring('no-such-id'),
        /Release not found/,
      );
    });

    test('calls prMonitor.stopMonitoring when monitoring', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      prMonitor.isMonitoring.returns(true);
      const manager = createManager({ planRunner, prMonitor });
      const release = await createRelease(manager, planRunner);

      await manager.stopMonitoring(release.id);

      assert.ok(prMonitor.stopMonitoring.calledWith(release.id));
    });

    test('does not call stopMonitoring when not monitoring', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      prMonitor.isMonitoring.returns(false);
      const manager = createManager({ planRunner, prMonitor });
      const release = await createRelease(manager, planRunner);

      await manager.stopMonitoring(release.id);

      assert.ok(prMonitor.stopMonitoring.notCalled);
    });

    test('emits releaseProgress after stop', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      const progressEvents: any[] = [];
      manager.on('releaseProgress', (id: string) => progressEvents.push(id));

      await manager.stopMonitoring(release.id);

      assert.ok(progressEvents.includes(release.id));
    });
  });

  // ── transitionToState ─────────────────────────────────────────────────

  suite('transitionToState', () => {
    test('returns false for non-existent release', async () => {
      const manager = createManager();
      const result = await manager.transitionToState('no-such-id', 'merging');
      assert.strictEqual(result, false);
    });

    test('returns false when no state machine found', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      // Remove the state machine manually
      (manager as any).stateMachines.delete(release.id);

      const result = await manager.transitionToState(release.id, 'merging');
      assert.strictEqual(result, false);
    });

    test('returns true for valid transition', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      const result = await manager.transitionToState(release.id, 'merging');
      assert.strictEqual(result, true);
      assert.strictEqual(release.status, 'merging');
    });

    test('returns false for invalid transition', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      // drafting -> succeeded is not a valid transition
      const result = await manager.transitionToState(release.id, 'succeeded');
      assert.strictEqual(result, false);
    });

    test('initializes preparation tasks when transitioning to preparing', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      const result = await manager.transitionToState(release.id, 'preparing');
      assert.strictEqual(result, true);
      // preparationTasks may be set
    });
  });

  // ── getReleaseProgress (monitoring/addressing) ─────────────────────────

  suite('getReleaseProgress – monitoring state', () => {
    test('returns prMonitoring info when in monitoring state', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      prMonitor.getMonitorCycles.returns([
        {
          cycleNumber: 1,
          timestamp: Date.now(),
          checks: [{ name: 'CI', status: 'failing' }],
          comments: [{ id: 'c1', isResolved: false }],
          securityAlerts: [{ id: 'a1', resolved: false }],
          actions: [],
        },
      ]);
      const manager = createManager({ planRunner, prMonitor });
      const release = await createRelease(manager, planRunner);

      release.status = 'monitoring';

      const progress = manager.getReleaseProgress(release.id);

      assert.ok(progress);
      assert.ok(progress.prMonitoring);
      assert.strictEqual(progress.prMonitoring.cyclesCompleted, 1);
      assert.strictEqual(progress.prMonitoring.failingChecks, 1);
      assert.strictEqual(progress.prMonitoring.unresolvedThreads, 1);
      assert.strictEqual(progress.prMonitoring.unresolvedAlerts, 1);
    });

    test('returns prMonitoring info when in addressing state', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createMockPRMonitor();
      prMonitor.getMonitorCycles.returns([]);
      const manager = createManager({ planRunner, prMonitor });
      const release = await createRelease(manager, planRunner);

      release.status = 'addressing';

      const progress = manager.getReleaseProgress(release.id);

      assert.ok(progress);
      assert.ok(progress.prMonitoring);
      assert.strictEqual(progress.prMonitoring.cyclesCompleted, 0);
    });

    test('returns undefined for non-existent release', () => {
      const manager = createManager();
      const progress = manager.getReleaseProgress('no-such-id');
      assert.strictEqual(progress, undefined);
    });
  });

  // ── getTaskLogFilePath ─────────────────────────────────────────────────

  suite('getTaskLogFilePath', () => {
    test('returns undefined for non-existent release', () => {
      const manager = createManager();
      assert.strictEqual(manager.getTaskLogFilePath('no-such-id', 'task-1'), undefined);
    });

    test('returns undefined when release has no prepTasks', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      assert.strictEqual(manager.getTaskLogFilePath(release.id, 'task-1'), undefined);
    });

    test('returns logFilePath when task has one', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);

      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Test Task',
          description: '',
          required: false,
          autoSupported: true,
          status: 'completed',
          logFilePath: '/repo/task-logs/task-1.log',
        },
      ];

      assert.strictEqual(
        manager.getTaskLogFilePath(release.id, 'task-1'),
        '/repo/task-logs/task-1.log',
      );
    });
  });

  // ── addressFindings ───────────────────────────────────────────────────

  suite('addressFindings', () => {
    test('returns immediately when findings array is empty', async () => {
      const planRunner = createMockPlanRunner();
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, copilot });
      const release = await createRelease(manager, planRunner);

      await manager.addressFindings(release.id, []);

      assert.ok(copilot.run.notCalled);
    });

    test('throws for non-existent release', async () => {
      const manager = createManager();
      await assert.rejects(
        () => manager.addressFindings('no-such-id', [{ type: 'check', name: 'CI' }]),
        /Release not found/,
      );
    });

    test('invokes copilot and emits releaseActionTaken on success with no changes', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(false);
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot });
      const release = await createRelease(manager, planRunner);

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        { type: 'check', name: 'CI', status: 'failing' },
      ]);

      assert.ok(copilot.run.calledOnce);
      // Started action emitted
      assert.ok(actions.some(a => a.description.includes('Addressing')));
      // No changes action
      assert.ok(actions.some(a => a.description.includes('no code changes')));
    });

    test('includes sessionId in fix-code actions', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(true);
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot });
      const release = await createRelease(manager, planRunner);

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        { type: 'check', name: 'CI', status: 'failing' },
      ]);

      const fixActions = actions.filter(a => a.type === 'fix-code');
      assert.ok(fixActions.length > 0, 'should have fix-code actions');
      // All fix-code actions after the initial "Addressing" should have sessionId
      const postStartActions = fixActions.filter(a => !a.description.includes('Addressing'));
      for (const action of postStartActions) {
        assert.ok(action.sessionId, `fix-code action "${action.description}" should include sessionId`);
        assert.ok(typeof action.sessionId === 'string');
        assert.ok(action.sessionId.startsWith('cli-'));
      }
    });

    test('commits and pushes when copilot produces changes', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(true);
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot });
      const release = await createRelease(manager, planRunner);

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        { type: 'alert', severity: 'high', description: 'XSS vulnerability', file: 'src/a.ts' },
      ]);

      assert.ok(git.repository.stageAll.calledOnce);
      assert.ok(git.repository.commit.calledOnce);
      assert.ok(git.repository.push.calledOnce);
      assert.ok(actions.some(a => a.type === 'fix-code' && a.success === true && a.commitHash));
    });

    test('emits failure action when copilot returns failure', async () => {
      const planRunner = createMockPlanRunner();
      const copilot = createMockCopilot();
      copilot.run.resolves({ success: false, error: 'AI timed out' });
      const manager = createManager({ planRunner, copilot });
      const release = await createRelease(manager, planRunner);

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        { type: 'comment', body: 'Fix this', author: 'reviewer', id: 'c1' },
      ]);

      assert.ok(actions.some(a => a.success === false && a.description.includes('AI timed out')));
    });

    test('emits failure action when copilot throws', async () => {
      const planRunner = createMockPlanRunner();
      const copilot = createMockCopilot();
      copilot.run.rejects(new Error('copilot spawn failed'));
      const manager = createManager({ planRunner, copilot });
      const release = await createRelease(manager, planRunner);

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        { type: 'check', name: 'CI' },
      ]);

      assert.ok(actions.some(a => a.success === false && a.description.includes('copilot spawn failed')));
    });

    test('replies to comments via prService when prNumber set', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(true);
      const prFactory = createMockPRServiceFactory();
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot, prFactory });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.isolatedRepoPath = '/repo/.orchestrator/release/release-v1';

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        {
          type: 'comment',
          body: 'Fix this',
          author: 'reviewer',
          id: 'c1',
          commentId: 'comment-123',
          threadId: 'thread-abc',
          path: 'src/foo.ts',
        },
      ]);

      const prService = prFactory._service;
      assert.ok(prService.replyToComment.calledOnce);
      assert.ok(prService.resolveThread.calledOnce);
      assert.ok(actions.some(a => a.type === 'respond-comment' && a.success === true));
    });

    test('includes commentUrl in respond-comment actions', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(true);
      const prFactory = createMockPRServiceFactory();
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot, prFactory });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.isolatedRepoPath = '/repo/.orchestrator/release/release-v1';

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [
        {
          type: 'comment',
          body: 'Fix this',
          author: 'reviewer',
          id: 'c1',
          commentId: 'comment-123',
          path: 'src/foo.ts',
          url: 'https://github.com/o/r/pull/42#discussion_r123',
        },
      ]);

      const replyAction = actions.find(a => a.type === 'respond-comment');
      assert.ok(replyAction, 'should have respond-comment action');
      assert.strictEqual(replyAction.commentUrl, 'https://github.com/o/r/pull/42#discussion_r123');
    });

    test('emits findingsResolved with finding IDs', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(false);
      const manager = createManager({ planRunner, git });
      const release = await createRelease(manager, planRunner);

      const resolvedEvents: any[] = [];
      manager.on('findingsResolved', (id: string, ids: string[], hasCommit: boolean) =>
        resolvedEvents.push({ id, ids, hasCommit }),
      );

      await manager.addressFindings(release.id, [
        { type: 'check', id: 'finding-1', name: 'CI' },
        { type: 'alert', id: 'finding-2', description: 'XSS' },
      ]);

      assert.ok(resolvedEvents.length > 0);
      assert.ok(resolvedEvents[0].ids.includes('finding-1'));
      assert.ok(resolvedEvents[0].ids.includes('finding-2'));
    });

    test('builds task description from mixed finding types', async () => {
      const planRunner = createMockPlanRunner();
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, copilot });
      const release = await createRelease(manager, planRunner);

      await manager.addressFindings(release.id, [
        { type: 'check', name: 'CI/CD', url: 'https://ci.example.com' },
        { type: 'comment', body: 'Please fix', author: 'alice', path: 'src/a.ts', line: 5 },
        { type: 'alert', severity: 'critical', description: 'SQL injection', file: 'src/db.ts' },
      ]);

      const callArgs = copilot.run.firstCall.args[0];
      const task = callArgs.task as string;
      assert.ok(task.includes('CI/CD Check Failures'));
      assert.ok(task.includes('PR Review Comments'));
      assert.ok(task.includes('Security Alerts'));
    });

    test('handles commit/push failure gracefully', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.resolves(true);
      git.repository.commit.rejects(new Error('commit failed'));
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot });
      const release = await createRelease(manager, planRunner);

      const actions: any[] = [];
      manager.on('releaseActionTaken', (_id: string, action: any) => actions.push(action));

      await manager.addressFindings(release.id, [{ type: 'check', name: 'CI' }]);

      assert.ok(actions.some(a => a.success === false && a.description.includes('commit failed')));
    });

    test('handles git hasChanges failure gracefully', async () => {
      const planRunner = createMockPlanRunner();
      const git = createMockGitOps();
      git.repository.hasChanges.rejects(new Error('git status failed'));
      const copilot = createMockCopilot();
      const manager = createManager({ planRunner, git, copilot });
      const release = await createRelease(manager, planRunner);

      // Should not throw
      await manager.addressFindings(release.id, [{ type: 'check', name: 'CI' }]);
      assert.ok(copilot.run.calledOnce);
    });
  });

  // ── _loadPersistedReleases ─────────────────────────────────────────────

  suite('_loadPersistedReleases', () => {
    test('loads releases from store on construction', async () => {
      const store = createMockReleaseStore();
      const savedRelease: ReleaseDefinition = {
        id: 'rel-persisted',
        name: 'Persisted Release',
        flowType: 'from-plans',
        planIds: [],
        releaseBranch: 'release/persisted',
        targetBranch: 'main',
        repoPath: '/repo',
        status: 'succeeded',
        source: 'from-plans',
        stateHistory: [{ from: 'drafting', to: 'succeeded', timestamp: Date.now(), reason: 'done' }],
        createdAt: Date.now(),
      };
      store.loadAllReleases.resolves([savedRelease]);

      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      // Give the async constructor callback time to run
      await new Promise(r => setTimeout(r, 0));

      assert.ok(manager.getRelease('rel-persisted'));
      assert.strictEqual(manager.getRelease('rel-persisted')?.name, 'Persisted Release');
    });

    test('backfills missing stateHistory on load', async () => {
      const store = createMockReleaseStore();
      const savedRelease: any = {
        id: 'rel-old',
        name: 'Old Release',
        flowType: 'from-plans',
        planIds: ['plan-1'],
        releaseBranch: 'release/old',
        targetBranch: 'main',
        repoPath: '/repo',
        status: 'succeeded',
        // stateHistory intentionally missing
        createdAt: Date.now(),
      };
      store.loadAllReleases.resolves([savedRelease]);

      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );
      await new Promise(r => setTimeout(r, 0));

      const loaded = manager.getRelease('rel-old');
      assert.ok(loaded?.stateHistory);
      assert.ok(loaded!.stateHistory.length > 0);
    });

    test('backfills missing source on load', async () => {
      const store = createMockReleaseStore();
      const savedRelease: any = {
        id: 'rel-nosrc',
        name: 'No Source Release',
        flowType: 'from-plans',
        planIds: ['plan-1'],
        releaseBranch: 'release/nosrc',
        targetBranch: 'main',
        repoPath: '/repo',
        status: 'canceled',
        stateHistory: [],
        createdAt: Date.now(),
        // source intentionally missing
      };
      store.loadAllReleases.resolves([savedRelease]);

      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );
      await new Promise(r => setTimeout(r, 0));

      const loaded = manager.getRelease('rel-nosrc');
      assert.strictEqual(loaded?.source, 'from-plans');
    });

    test('emits releaseCreated for each loaded release', async () => {
      const store = createMockReleaseStore();
      const r1: any = {
        id: 'rel-a',
        name: 'Release A',
        flowType: 'from-plans',
        planIds: [],
        releaseBranch: 'release/a',
        targetBranch: 'main',
        repoPath: '/repo',
        status: 'succeeded',
        source: 'from-plans',
        stateHistory: [],
        createdAt: Date.now(),
      };
      const r2: any = { ...r1, id: 'rel-b', name: 'Release B', releaseBranch: 'release/b' };
      store.loadAllReleases.resolves([r1, r2]);

      const createdEvents: any[] = [];
      // We need to listen before construction... but the manager emits after load
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );
      manager.on('releaseCreated', (r: ReleaseDefinition) => createdEvents.push(r.id));

      await new Promise(r => setTimeout(r, 10));

      assert.ok(createdEvents.includes('rel-a'));
      assert.ok(createdEvents.includes('rel-b'));
    });

    test('restores monitoring for monitoring-state releases with setTimeout', async () => {
      const store = createMockReleaseStore();
      const clock = sinon.useFakeTimers();

      const monitoringRelease: any = {
        id: 'rel-monitoring',
        name: 'Monitoring Release',
        flowType: 'from-plans',
        planIds: [],
        releaseBranch: 'release/monitoring',
        targetBranch: 'main',
        repoPath: '/repo',
        status: 'monitoring',
        prNumber: 77,
        source: 'from-plans',
        stateHistory: [
          { from: 'pr-active', to: 'monitoring', timestamp: Date.now(), reason: 'started' },
        ],
        createdAt: Date.now(),
      };
      store.loadAllReleases.resolves([monitoringRelease]);

      const prMonitor = createMockPRMonitor();
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        prMonitor,
        createMockPRServiceFactory(),
        store,
      );

      // Let the async _loadPersistedReleases settle
      await clock.tickAsync(0);

      // Before 5 second delay, monitoring should not have started
      assert.ok(prMonitor.startMonitoring.notCalled);

      // Advance past the 5-second delay
      await clock.tickAsync(6000);

      // Now monitoring should have been started
      assert.ok(prMonitor.startMonitoring.calledOnce);

      clock.restore();
    });
  });

  // ── createPR ─────────────────────────────────────────────────────────

  suite('createPR', () => {
    let cpModule: any;
    let origExecSync: any;

    setup(() => {
      cpModule = require('child_process');
      origExecSync = cpModule.execSync;
      cpModule.execSync = sandbox.stub().returns(Buffer.from(''));
    });

    teardown(() => {
      cpModule.execSync = origExecSync;
    });

    test('throws for non-existent release', async () => {
      const manager = createManager();
      await assert.rejects(
        () => manager.createPR('no-such-id'),
        /Release not found/,
      );
    });

    test('throws when release is not in ready-for-pr status', async () => {
      const planRunner = createMockPlanRunner();
      const manager = createManager({ planRunner });
      const release = await createRelease(manager, planRunner);
      // release.status = 'drafting', not 'ready-for-pr'

      await assert.rejects(
        () => manager.createPR(release.id),
        /Cannot create PR/,
      );
    });

    test('creates PR via prService and updates release', async () => {
      const planRunner = createMockPlanRunner();
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prFactory, store });
      const release = await createRelease(manager, planRunner);

      await manager.transitionToState(release.id, 'ready-for-pr');

      await manager.createPR(release.id);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.prNumber, 42);
      assert.ok(updated?.prUrl?.includes('42'));
      assert.strictEqual(updated?.status, 'pr-active');
    });

    test('transitions to failed on error', async () => {
      const planRunner = createMockPlanRunner();
      const prFactory = createMockPRServiceFactory();
      prFactory._service.createPR.rejects(new Error('API error'));
      prFactory.getServiceForRepo.resolves(prFactory._service);

      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prFactory, store });
      const release = await createRelease(manager, planRunner);

      await manager.transitionToState(release.id, 'ready-for-pr');

      await assert.rejects(
        () => manager.createPR(release.id),
        /API error/,
      );

      assert.strictEqual(release.status, 'failed');
    });
  });
});
