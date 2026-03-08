/**
 * @fileoverview Coverage tests for DefaultReleasePRMonitor
 *
 * Covers additional paths not exercised by the main unit tests:
 * - Cycle with non-empty checks and security alerts (map body coverage)
 * - Error handling when prService.getPRChecks throws
 * - _addressFindings private method (via type cast) for all branches
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultReleasePRMonitor } from '../../../plan/releasePRMonitor';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockCopilot(): any {
  return {
    run: sinon.stub().resolves({
      success: true,
      sessionId: 'test',
      output: 'Fixed',
      metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 },
    }),
    isAvailable: sinon.stub().returns(true),
  };
}

function createMockSpawner(): any {
  return { spawn: sinon.stub() };
}

function createMockGit(): any {
  return {
    repository: {
      hasChanges: sinon.stub().resolves(false),
      stageAll: sinon.stub().resolves(),
      commit: sinon.stub().resolves(),
      getHead: sinon.stub().resolves('abc123'),
      push: sinon.stub().resolves(true),
    },
  };
}

function createMockPRService(): any {
  return {
    getPRChecks: sinon.stub().resolves([]),
    getPRComments: sinon.stub().resolves([]),
    getSecurityAlerts: sinon.stub().resolves([]),
    replyToComment: sinon.stub().resolves(),
    resolveThread: sinon.stub().resolves(),
    createPR: sinon.stub().resolves({ prNumber: 42, prUrl: 'https://github.com/test/repo/pull/42' }),
  };
}

function createMockPRServiceFactory(svc?: any): any {
  const service = svc || createMockPRService();
  return {
    getServiceForRepo: sinon.stub().resolves(service),
    _service: service,
  };
}

function createNullPulse(): any {
  return { onPulse: () => ({ dispose: () => {} }), isRunning: false };
}

suite('ReleasePRMonitor – coverage', () => {
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

  // ── Map-body coverage: non-empty checks and alerts ─────────────────────

  test('maps check result fields (name/status/url) when checks are non-empty', async () => {
    const mockService = createMockPRService();
    mockService.getPRChecks.resolves([
      { name: 'CI Build', status: 'passing', url: 'https://ci.example.com/1' },
      { name: 'Lint', status: 'failing', url: undefined },
    ]);

    const factory = createMockPRServiceFactory(mockService);
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      createNullPulse(),
    );

    const cycles: any[] = [];
    monitor.on('cycleComplete', (_id: string, cycle: any) => cycles.push(cycle));

    await monitor.startMonitoring('rel-1', 42, '/repo', 'release/v1');

    assert.strictEqual(cycles.length, 1);
    const checks = cycles[0].checks;
    assert.strictEqual(checks.length, 2);
    assert.strictEqual(checks[0].name, 'CI Build');
    assert.strictEqual(checks[0].status, 'passing');
    assert.strictEqual(checks[0].url, 'https://ci.example.com/1');
    assert.strictEqual(checks[1].name, 'Lint');
    assert.strictEqual(checks[1].status, 'failing');

    monitor.stopMonitoring('rel-1');
  });

  test('maps security alert fields when alerts are non-empty', async () => {
    const mockService = createMockPRService();
    mockService.getSecurityAlerts.resolves([
      { id: 'alert-1', severity: 'high', description: 'XSS vuln', file: 'src/a.ts', resolved: false },
      { id: 'alert-2', severity: 'low', description: 'Info leak', file: undefined, resolved: true },
    ]);

    const factory = createMockPRServiceFactory(mockService);
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      createNullPulse(),
    );

    const cycles: any[] = [];
    monitor.on('cycleComplete', (_id: string, cycle: any) => cycles.push(cycle));

    await monitor.startMonitoring('rel-1', 42, '/repo', 'release/v1');

    assert.strictEqual(cycles.length, 1);
    const alerts = cycles[0].securityAlerts;
    assert.strictEqual(alerts.length, 2);
    assert.strictEqual(alerts[0].id, 'alert-1');
    assert.strictEqual(alerts[0].severity, 'high');
    assert.strictEqual(alerts[0].description, 'XSS vuln');
    assert.strictEqual(alerts[0].file, 'src/a.ts');
    assert.strictEqual(alerts[0].resolved, false);

    monitor.stopMonitoring('rel-1');
  });

  // ── Error handling in _runCycle when fetch fails ───────────────────────

  test('records empty cycle when prService.getPRChecks throws', async () => {
    const mockService = createMockPRService();
    mockService.getPRChecks.rejects(new Error('network error'));

    const factory = createMockPRServiceFactory(mockService);
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      createNullPulse(),
    );

    await monitor.startMonitoring('rel-1', 42, '/repo', 'release/v1');

    const cycles = monitor.getMonitorCycles('rel-1');
    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(cycles[0].checks, []);
    assert.deepStrictEqual(cycles[0].comments, []);
    assert.deepStrictEqual(cycles[0].securityAlerts, []);

    monitor.stopMonitoring('rel-1');
  });

  test('does not stop monitoring on fetch error', async () => {
    const mockService = createMockPRService();
    mockService.getPRChecks.rejects(new Error('network timeout'));

    const factory = createMockPRServiceFactory(mockService);
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      createNullPulse(),
    );

    await monitor.startMonitoring('rel-1', 42, '/repo', 'release/v1');

    assert.strictEqual(monitor.isMonitoring('rel-1'), true);

    monitor.stopMonitoring('rel-1');
  });

  // ── startMonitoring when already monitoring ────────────────────────────

  test('startMonitoring warns and returns if already monitoring', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      createNullPulse(),
    );

    await monitor.startMonitoring('rel-1', 42, '/repo', 'release/v1');

    // Second call for same release: should warn and return immediately
    await monitor.startMonitoring('rel-1', 42, '/repo', 'release/v1');

    // getPRChecks was called only once (from the first startMonitoring)
    assert.strictEqual(mockService.getPRChecks.callCount, 1);

    monitor.stopMonitoring('rel-1');
  });

  // ── stopMonitoring for unknown release ─────────────────────────────────

  test('stopMonitoring warns and does nothing for unknown release', () => {
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    // Should not throw
    monitor.stopMonitoring('unknown-release');
    assert.strictEqual(monitor.isMonitoring('unknown-release'), false);
  });

  // ── isMonitoring and getMonitorCycles for unknown release ──────────────

  test('isMonitoring returns false for unknown release', () => {
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    assert.strictEqual(monitor.isMonitoring('unknown'), false);
  });

  test('getMonitorCycles returns empty array for unknown release', () => {
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    assert.deepStrictEqual(monitor.getMonitorCycles('unknown'), []);
  });

  // ── _addressFindings via type cast ─────────────────────────────────────

  /**
   * Helper to build a mock MonitorState that _addressFindings expects.
   */
  function buildState(
    prService: any,
    repoPath = '/repo',
    releaseBranch = 'release/v1',
  ): any {
    return {
      releaseId: 'rel-af',
      prNumber: 42,
      repoPath,
      releaseBranch,
      prService,
      pulseSubscription: undefined,
      tickCount: 0,
      lastPushTime: Date.now(),
      cycles: [],
      isActive: true,
    };
  }

  function buildCycle(overrides?: Partial<any>): any {
    return {
      cycleNumber: 1,
      timestamp: Date.now(),
      checks: [],
      comments: [],
      securityAlerts: [],
      actions: [],
      ...overrides,
    };
  }

  test('_addressFindings: returns empty actions when all arrays empty', async () => {
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle(); // all empty arrays

    const actions = await (monitor as any)._addressFindings(state, cycle);
    assert.deepStrictEqual(actions, []);
  });

  test('_addressFindings: handles failing checks, invokes copilot', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);
    git.repository.getHead.resolves('deadbeef');

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const prService = createMockPRService();
    const state = buildState(prService);
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing', url: 'https://ci.example.com' }],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(copilot.run.calledOnce);
    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('CI/CD Check Failures'));
    assert.ok(task.includes('CI'));
    assert.ok(actions.some((a: any) => a.type === 'fix-code' && a.success === true));
  });

  test('_addressFindings: commits and pushes when hasChanges is true', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);
    git.repository.getHead.resolves('abc1234');

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    await (monitor as any)._addressFindings(state, cycle);

    assert.ok(git.repository.stageAll.calledOnce);
    assert.ok(git.repository.commit.calledOnce);
    assert.ok(git.repository.push.calledOnce);
  });

  test('_addressFindings: no commit when hasChanges is false', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(false);

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(git.repository.stageAll.notCalled);
    // fix-code action still pushed but with no commitHash
    assert.ok(actions.length === 0 || actions.every((a: any) => !a.commitHash));
  });

  test('_addressFindings: handles copilot failure result', async () => {
    const copilot = createMockCopilot();
    copilot.run.resolves({ success: false, error: 'AI timed out' });

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(actions.some((a: any) => a.success === false));
  });

  test('_addressFindings: handles copilot run() throw', async () => {
    const copilot = createMockCopilot();
    copilot.run.rejects(new Error('spawn error'));

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(actions.some((a: any) => a.type === 'fix-code' && a.success === false));
  });

  test('_addressFindings: handles unresolved comments (with threadId)', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);
    git.repository.getHead.resolves('deadbeef');

    const prService = createMockPRService();
    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(prService),
      createNullPulse(),
    );

    const state = buildState(prService);
    const cycle = buildCycle({
      comments: [
        {
          id: 'c1',
          author: 'reviewer',
          body: 'Please fix this',
          path: 'src/a.ts',
          line: 42,
          isResolved: false,
          source: 'review',
          threadId: 'thread-1',
        },
      ],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(prService.replyToComment.calledOnce);
    assert.ok(prService.resolveThread.calledOnce);
    assert.ok(actions.some((a: any) => a.type === 'respond-comment' && a.success === true));
  });

  test('_addressFindings: handles comment without threadId', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);

    const prService = createMockPRService();
    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(prService),
      createNullPulse(),
    );

    const state = buildState(prService);
    const cycle = buildCycle({
      comments: [
        {
          id: 'c2',
          author: 'alice',
          body: 'Style issue',
          isResolved: false,
          source: 'review',
          // no threadId
        },
      ],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(prService.replyToComment.calledOnce);
    assert.ok(prService.resolveThread.notCalled);
    assert.ok(actions.some((a: any) => a.type === 'respond-comment'));
  });

  test('_addressFindings: handles replyToComment failure gracefully', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(false);

    const prService = createMockPRService();
    prService.replyToComment.rejects(new Error('API failure'));

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(prService),
      createNullPulse(),
    );

    const state = buildState(prService);
    const cycle = buildCycle({
      comments: [
        { id: 'c1', author: 'reviewer', body: 'Fix', isResolved: false, source: 'review' },
      ],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(actions.some((a: any) => a.type === 'respond-comment' && a.success === false));
  });

  test('_addressFindings: handles unresolved security alerts', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);

    const prService = createMockPRService();
    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(prService),
      createNullPulse(),
    );

    const state = buildState(prService);
    const cycle = buildCycle({
      securityAlerts: [
        { id: 'a1', severity: 'critical', description: 'SQL injection', file: 'src/db.ts', resolved: false },
      ],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(copilot.run.calledOnce);
    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('Security Alerts'));
    assert.ok(task.includes('SQL injection'));
    assert.ok(actions.some((a: any) => a.type === 'fix-code'));
  });

  test('_addressFindings: handles git hasChanges failure', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.rejects(new Error('git status failed'));

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    // Should not throw - hasChanges failure is caught gracefully
    const actions = await (monitor as any)._addressFindings(state, cycle);

    // copilot still ran, but no commit action since hasChanges threw
    assert.ok(copilot.run.calledOnce);
    assert.ok(git.repository.stageAll.notCalled);
  });

  test('_addressFindings: handles commit/push failure gracefully', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);
    git.repository.stageAll.rejects(new Error('stage failed'));

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(actions.some((a: any) => a.type === 'fix-code' && a.success === false));
  });

  test('_addressFindings: check URL is included in task when present', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(false);

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'TypeScript', status: 'failing', url: 'https://ci.example.com/build/42' }],
    });

    await (monitor as any)._addressFindings(state, cycle);

    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('https://ci.example.com/build/42'));
  });

  test('_addressFindings: security alert without file still included in task', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(false);

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      securityAlerts: [
        { id: 'a1', severity: 'medium', description: 'Hardcoded secret', resolved: false },
        // no 'file' field
      ],
    });

    await (monitor as any)._addressFindings(state, cycle);

    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('Hardcoded secret'));
    assert.ok(task.includes('MEDIUM'));
  });

  test('_addressFindings: comment with path and line included in task', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(false);

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      comments: [
        {
          id: 'c1',
          author: 'bot',
          body: 'Missing null check',
          path: 'src/util.ts',
          line: 77,
          isResolved: false,
          source: 'review',
        },
      ],
    });

    await (monitor as any)._addressFindings(state, cycle);

    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('src/util.ts'));
    assert.ok(task.includes('77'));
  });

  test('_addressFindings: handles git hasChanges error gracefully', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.rejects(new Error('git status failed'));

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    // Should not throw
    const actions = await (monitor as any)._addressFindings(state, cycle);
    assert.ok(Array.isArray(actions));
  });

  test('_addressFindings: handles commit failure gracefully', async () => {
    const copilot = createMockCopilot();
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);
    git.repository.commit.rejects(new Error('commit failed'));

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      git,
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'CI', status: 'failing' }],
    });

    const actions = await (monitor as any)._addressFindings(state, cycle);

    assert.ok(actions.some((a: any) => a.type === 'fix-code' && a.success === false));
  });

  test('_addressFindings: check URL is included in task when present', async () => {
    const copilot = createMockCopilot();

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      checks: [{ name: 'Security Scan', status: 'failing', url: 'https://security.example.com/report' }],
    });

    await (monitor as any)._addressFindings(state, cycle);

    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('https://security.example.com/report'));
  });

  test('_addressFindings: comment path:line included in task', async () => {
    const copilot = createMockCopilot();

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      comments: [
        {
          id: 'c1',
          author: 'dev',
          body: 'Null pointer possible here',
          path: 'src/service.ts',
          line: 99,
          isResolved: false,
          source: 'review',
        },
      ],
    });

    await (monitor as any)._addressFindings(state, cycle);

    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('src/service.ts'));
    assert.ok(task.includes('99'));
  });

  test('_addressFindings: alert file path included in task', async () => {
    const copilot = createMockCopilot();

    const monitor = new DefaultReleasePRMonitor(
      copilot,
      createMockSpawner(),
      createMockGit(),
      createMockPRServiceFactory(),
      createNullPulse(),
    );

    const state = buildState(createMockPRService());
    const cycle = buildCycle({
      securityAlerts: [
        { id: 'a1', severity: 'high', description: 'XSS', file: 'src/view.ts', resolved: false },
      ],
    });

    await (monitor as any)._addressFindings(state, cycle);

    const task = copilot.run.firstCall.args[0].task as string;
    assert.ok(task.includes('src/view.ts'));
  });
});
