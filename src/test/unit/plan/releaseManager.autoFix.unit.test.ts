/**
 * @fileoverview Unit tests for DefaultReleaseManager auto-fix feature.
 *
 * Covers:
 *  - setAutoFix (enable/disable)
 *  - cycleComplete handler: auto-fix logic (comments, checks, alerts)
 *  - deduplication via autoFixedFindingIds
 *  - trimming autoFixedFindingIds when > 500
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
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

function createMockPRServiceFactory(overrides?: any): any {
  const mockPRService = {
    createPR: sinon.stub().resolves({ prNumber: 42, prUrl: 'https://github.com/test/repo/pull/42' }),
    getPRChecks: sinon.stub().resolves([]),
    getPRComments: sinon.stub().resolves([]),
    getSecurityAlerts: sinon.stub().resolves([]),
    replyToComment: sinon.stub().resolves(),
    addIssueComment: sinon.stub().resolves(),
    resolveThread: sinon.stub().resolves(),
    minimizeComment: sinon.stub().resolves(),
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

/** Creates an EventEmitter-based prMonitor so the manager can register cycleComplete listeners */
function createEventEmitterPRMonitor(): EventEmitter & {
  startMonitoring: sinon.SinonStub;
  stopMonitoring: sinon.SinonStub;
  isMonitoring: sinon.SinonStub;
  getMonitorCycles: sinon.SinonStub;
} {
  const ee = new EventEmitter() as any;
  ee.startMonitoring = sinon.stub().resolves();
  ee.stopMonitoring = sinon.stub();
  ee.isMonitoring = sinon.stub().returns(false);
  ee.getMonitorCycles = sinon.stub().returns([]);
  return ee;
}

function createEventEmitterPlanRunner(): EventEmitter & any {
  const ee = new EventEmitter() as any;
  ee.get = sinon.stub().returns(undefined);
  ee.getAll = sinon.stub().returns([]);
  ee.enqueue = sinon.stub();
  ee.cancel = sinon.stub();
  ee.delete = sinon.stub();
  ee.pause = sinon.stub();
  ee.resume = sinon.stub();
  ee.getStateMachine = sinon.stub().returns({ computePlanStatus: () => 'succeeded' });
  ee.getStatus = sinon.stub().returns(undefined);
  ee.off = sinon.stub();
  return ee;
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
    overrides?.prMonitor ?? createEventEmitterPRMonitor(),
    overrides?.prFactory ?? createMockPRServiceFactory(),
    overrides?.store ?? createMockReleaseStore(),
  );
}

async function createRelease(
  manager: DefaultReleaseManager,
  planRunner: any,
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
  });
}

suite('DefaultReleaseManager – auto-fix', () => {
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

  // ── setAutoFix ─────────────────────────────────────────────────────────

  suite('setAutoFix', () => {
    test('throws when release not found', () => {
      const manager = createManager();
      assert.throws(
        () => manager.setAutoFix('no-such-id', true),
        /Release not found/,
      );
    });

    test('enables auto-fix on the release', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.autoFixEnabled, true);
      assert.ok(store.saveRelease.called);
    });

    test('disables auto-fix and clears autoFixedFindingIds', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      // First enable and seed some tracked IDs
      manager.setAutoFix(release.id, true);
      const rel = manager.getRelease(release.id)!;
      rel.autoFixedFindingIds = ['comment-1', 'check-2'];

      // Now disable
      manager.setAutoFix(release.id, false);

      const updated = manager.getRelease(release.id);
      assert.strictEqual(updated?.autoFixEnabled, false);
      assert.deepStrictEqual(updated?.autoFixedFindingIds, []);
    });

    test('calls store.saveRelease when toggling', async () => {
      const planRunner = createMockPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);
      store.saveRelease.resetHistory();

      manager.setAutoFix(release.id, true);

      assert.ok(store.saveRelease.calledOnce);
    });
  });

  // ── cycleComplete handler – auto-fix logic ─────────────────────────────

  suite('cycleComplete auto-fix logic', () => {
    test('does nothing when autoFixEnabled is false', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      const release = await createRelease(manager, planRunner);

      // autoFixEnabled is not set (falsy)
      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [{ id: 'c1', isResolved: false, body: 'Please fix' }],
        checks: [{ name: 'CI', status: 'failing' }],
        securityAlerts: [],
      });

      assert.strictEqual(findingsProcessingEvents.length, 0);
    });

    test('queues new unresolved comments when autoFixEnabled', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      // Stub addressFindings to prevent async side effects in the test suite
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [
          { id: 'c1', isResolved: false, body: 'Please fix this', author: 'reviewer', path: 'src/a.ts', line: 10, source: 'review', threadId: 'th1', url: 'http://gh/1', nodeId: 'n1' },
        ],
        checks: [],
        securityAlerts: [],
      });

      // findingsProcessing emitted by auto-fix handler
      assert.strictEqual(findingsProcessingEvents.length, 1);
      const [emittedReleaseId, findingIds] = findingsProcessingEvents[0];
      assert.strictEqual(emittedReleaseId, release.id);
      assert.ok((findingIds as string[]).includes('comment-c1'));

      // autoFixedFindingIds updated
      const updated = manager.getRelease(release.id);
      assert.ok(updated?.autoFixedFindingIds?.includes('comment-c1'));
    });

    test('queues new failing checks when autoFixEnabled', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [],
        checks: [{ name: 'unit tests', status: 'failing', url: 'http://gh/ci' }],
        securityAlerts: [],
      });

      assert.strictEqual(findingsProcessingEvents.length, 1);
      const [, findingIds] = findingsProcessingEvents[0];
      assert.ok((findingIds as string[]).some((id: string) => id.startsWith('check-')));
    });

    test('queues new unresolved alerts when autoFixEnabled', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [],
        checks: [],
        securityAlerts: [{ id: 'a1', resolved: false, severity: 'high', description: 'SQL injection', file: 'src/db.ts' }],
      });

      assert.strictEqual(findingsProcessingEvents.length, 1);
      const [, alertFindingIds] = findingsProcessingEvents[0];
      assert.ok((alertFindingIds as string[]).includes('alert-a1'));
    });

    test('skips already-processed findings (deduplication)', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);
      const rel = manager.getRelease(release.id)!;
      // Pre-seed as already processed
      rel.autoFixedFindingIds = ['comment-c1'];

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [{ id: 'c1', isResolved: false, body: 'old finding' }],
        checks: [],
        securityAlerts: [],
      });

      // Already processed — no new findings
      assert.strictEqual(findingsProcessingEvents.length, 0);
    });

    test('does not queue resolved comments', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [{ id: 'c1', isResolved: true, body: 'already resolved' }],
        checks: [],
        securityAlerts: [],
      });

      assert.strictEqual(findingsProcessingEvents.length, 0);
    });

    test('does not queue passing checks', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [],
        checks: [{ name: 'CI', status: 'passing' }],
        securityAlerts: [],
      });

      assert.strictEqual(findingsProcessingEvents.length, 0);
    });

    test('trims autoFixedFindingIds to last 500 when overflow', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);
      const rel = manager.getRelease(release.id)!;
      // Pre-seed with 499 IDs so adding one more pushes it to exactly 500 (no trim)
      // then we'll add one more to push to 501 which triggers trim
      rel.autoFixedFindingIds = Array.from({ length: 500 }, (_, i) => `old-${i}`);

      manager.on('findingsProcessing', () => {});

      prMonitor.emit('cycleComplete', release.id, {
        comments: [{ id: 'new-c', isResolved: false, body: 'new finding' }],
        checks: [],
        securityAlerts: [],
      });

      // After adding 'comment-new-c', length should be trimmed to 500
      const updated = manager.getRelease(release.id);
      assert.ok((updated?.autoFixedFindingIds?.length ?? 0) <= 500);
    });

    test('ignores cycleComplete for unknown release', () => {
      const prMonitor = createEventEmitterPRMonitor();
      const manager = createManager({ prMonitor });

      // Should not throw
      assert.doesNotThrow(() => {
        prMonitor.emit('cycleComplete', 'no-such-release', {
          comments: [],
          checks: [],
          securityAlerts: [],
        });
      });
    });

    test('marks comment as resolved when id is in addressedCommentIds', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      // Pre-seed addressed comment IDs (set by _onFixPlanCompleted after a previous fix)
      const rel = manager.getRelease(release.id)!;
      rel.addressedCommentIds = ['c1'];
      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [{ id: 'c1', isResolved: false, body: 'fix this' }],
        checks: [],
        securityAlerts: [],
      });

      // Comment was previously addressed — should not trigger a new auto-fix
      assert.strictEqual(findingsProcessingEvents.length, 0);
    });

    test('marks comment as resolved when body contains ✅ Addressed in automated fix', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [
          {
            id: 'c2', isResolved: false,
            body: '> fix this\n\n\u2705 Addressed in automated fix (abc1234)',
          },
        ],
        checks: [],
        securityAlerts: [],
      });

      // Comment is our own automated reply — should not trigger a new auto-fix
      assert.strictEqual(findingsProcessingEvents.length, 0);
    });

    test('does not suppress human comment that only references automated fix text', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [
          {
            id: 'c-human',
            isResolved: false,
            author: 'JeromySt',
            body: "Re: copilot-pull-request-reviewer[bot]'s feedback -- ✅ Addressed in automated fix (abc1234)",
          },
        ],
        checks: [],
        securityAlerts: [],
      });

      // Human-authored feedback that mentions the marker should still be treated as a new finding
      assert.strictEqual(findingsProcessingEvents.length, 1);
    });

    test('marks comment as resolved when replies contain ✅ Addressed in automated fix', async () => {
      const planRunner = createMockPlanRunner();
      const prMonitor = createEventEmitterPRMonitor();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prMonitor, store });
      sandbox.stub(manager as any, 'addressFindings').resolves();
      const release = await createRelease(manager, planRunner);

      manager.setAutoFix(release.id, true);

      const findingsProcessingEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => findingsProcessingEvents.push(args));

      prMonitor.emit('cycleComplete', release.id, {
        comments: [
          {
            id: 'c3',
            isResolved: false,
            body: 'fix this',
            replies: [{ id: 'r1', author: 'bot', body: '\u2705 Addressed in automated fix (abc1234)' }],
          },
        ],
        checks: [],
        securityAlerts: [],
      });

      // Thread already contains our automated fix reply — should not trigger a new auto-fix
      assert.strictEqual(findingsProcessingEvents.length, 0);
    });
  });

  // ── _onFixPlanCompleted ─────────────────────────────────────────────────

  suite('_onFixPlanCompleted', () => {
    test('calls replyToComment for inline comment with path', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prFactory, store });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.fixPlanIds = ['fix-plan-1'];
      release.fixPlanFindings = {
        'fix-plan-1': [
          { type: 'comment', id: 'comment-c1', commentId: 'c1', author: 'reviewer', body: 'fix this', path: 'src/a.ts', line: 5 },
        ],
      };

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out')), 2000);
        manager.once('findingsResolved', () => { clearTimeout(t); resolve(); });
        planRunner.emit('planCompleted', { id: 'fix-plan-1', spec: { repoPath: '/repo' } }, 'succeeded');
      });

      assert.ok(prFactory._service.replyToComment.calledOnce, 'should call replyToComment for inline comment');
      assert.ok(prFactory._service.addIssueComment.notCalled, 'should not call addIssueComment for inline comment');
    });

    test('calls replyToComment for threaded comment without path', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prFactory, store });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.fixPlanIds = ['fix-plan-1'];
      release.fixPlanFindings = {
        'fix-plan-1': [
          { type: 'comment', id: 'comment-c-thread', commentId: 'c-thread', author: 'reviewer', body: 'fix this thread', threadId: 'thread-1' },
        ],
      };

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out')), 2000);
        manager.once('findingsResolved', () => { clearTimeout(t); resolve(); });
        planRunner.emit('planCompleted', { id: 'fix-plan-1', spec: { repoPath: '/repo' } }, 'succeeded');
      });

      assert.ok(prFactory._service.replyToComment.calledOnce, 'should call replyToComment for threaded comment');
      assert.ok(prFactory._service.addIssueComment.notCalled, 'should not call addIssueComment for threaded comment');
      assert.ok(prFactory._service.resolveThread.calledOnce, 'should resolve the thread when threadId is present');
    });

    test('calls addIssueComment for top-level comment without path', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prFactory, store });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.fixPlanIds = ['fix-plan-1'];
      release.fixPlanFindings = {
        'fix-plan-1': [
          { type: 'comment', id: 'comment-c2', commentId: 'c2', author: 'bot', body: 'review feedback' },
        ],
      };

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out')), 2000);
        manager.once('findingsResolved', () => { clearTimeout(t); resolve(); });
        planRunner.emit('planCompleted', { id: 'fix-plan-1', spec: { repoPath: '/repo' } }, 'succeeded');
      });

      assert.ok(prFactory._service.addIssueComment.calledOnce, 'should call addIssueComment for top-level comment');
      assert.ok(prFactory._service.replyToComment.notCalled, 'should not call replyToComment for top-level comment');
    });

    test('calls replyToComment for review thread comment without path', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const prFactory = createMockPRServiceFactory();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, prFactory, store });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.fixPlanIds = ['fix-plan-1'];
      release.fixPlanFindings = {
        'fix-plan-1': [
          {
            type: 'comment',
            id: 'comment-c2-thread',
            commentId: 'c2-thread',
            author: 'reviewer',
            body: 'review feedback',
            threadId: 'thread-42',
            nodeId: 'node-42',
          },
        ],
      };

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out')), 2000);
        manager.once('findingsResolved', () => { clearTimeout(t); resolve(); });
        planRunner.emit('planCompleted', { id: 'fix-plan-1', spec: { repoPath: '/repo' } }, 'succeeded');
      });

      assert.ok(prFactory._service.replyToComment.calledOnce, 'should call replyToComment for thread comment');
      assert.ok(prFactory._service.addIssueComment.notCalled, 'should not call addIssueComment for thread comment');
      assert.ok(prFactory._service.resolveThread.calledOnce, 'should resolve the review thread');
      assert.ok(prFactory._service.minimizeComment.notCalled, 'should not minimize a threaded review comment');
    });

    test('adds commentId to addressedCommentIds', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      release.prNumber = 42;
      release.fixPlanIds = ['fix-plan-1'];
      release.fixPlanFindings = {
        'fix-plan-1': [
          { type: 'comment', id: 'comment-c3', commentId: 'c3', author: 'reviewer', body: 'fix it' },
        ],
      };

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out')), 2000);
        manager.once('findingsResolved', () => { clearTimeout(t); resolve(); });
        planRunner.emit('planCompleted', { id: 'fix-plan-1', spec: { repoPath: '/repo' } }, 'succeeded');
      });

      const updated = manager.getRelease(release.id);
      assert.ok(updated?.addressedCommentIds?.includes('c3'), 'should track addressed comment id');
    });

    test('emits findingsProcessing with failed status when plan did not succeed', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const store = createMockReleaseStore();
      const manager = createManager({ planRunner, store });
      const release = await createRelease(manager, planRunner);

      release.fixPlanIds = ['fix-plan-1'];
      release.fixPlanFindings = {
        'fix-plan-1': [
          { type: 'comment', id: 'comment-c4', commentId: 'c4', author: 'reviewer', body: 'fix it' },
        ],
      };

      const failedEvents: any[] = [];
      manager.on('findingsProcessing', (...args: any[]) => failedEvents.push(args));
      planRunner.emit('planCompleted', { id: 'fix-plan-1', spec: { repoPath: '/repo' } }, 'failed');

      await new Promise(r => setTimeout(r, 20));

      const failedEvent = failedEvents.find(([, , status]: any) => status === 'failed');
      assert.ok(failedEvent, 'should emit findingsProcessing with failed status');
    });

    test('does nothing when plan is not associated with any release', async () => {
      const planRunner = createEventEmitterPlanRunner();
      const prFactory = createMockPRServiceFactory();
      const manager = createManager({ planRunner, prFactory });

      planRunner.emit('planCompleted', { id: 'unknown-plan' }, 'succeeded');

      await new Promise(r => setTimeout(r, 20));

      assert.ok(prFactory._service.replyToComment.notCalled);
      assert.ok(prFactory._service.addIssueComment.notCalled);
    });
  });
});
