/**
 * @fileoverview Unit tests for DefaultReleasePRMonitor
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultReleasePRMonitor } from '../../../plan/releasePRMonitor';
import type { PRCheck, PRComment, PRSecurityAlert } from '../../../plan/types/remotePR';

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
      metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } 
    }),
    isAvailable: sinon.stub().returns(true),
  };
}

function createMockSpawner(): any {
  return {
    spawn: sinon.stub(),
  };
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

function createMockPRServiceFactory(mockService?: any): any {
  const service = mockService || createMockPRService();
  return {
    getServiceForRepo: sinon.stub().resolves(service),
  };
}

suite('ReleasePRMonitor', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    clock = sinon.useFakeTimers();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
    clock.restore();
  });

  test('resolves IRemotePRService from factory at start', async () => {
    const factory = createMockPRServiceFactory();
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    assert.ok(factory.getServiceForRepo.calledOnce);
    assert.strictEqual(factory.getServiceForRepo.firstCall.args[0], '/repo/.orchestrator/release/v1');

    monitor.stopMonitoring('rel-1');
  });

  test('runs first cycle immediately', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // First cycle runs immediately
    assert.ok(mockService.getPRChecks.calledOnce);
    assert.ok(mockService.getPRComments.calledOnce);
    assert.ok(mockService.getSecurityAlerts.calledOnce);

    monitor.stopMonitoring('rel-1');
  });

  test('polls every 2 minutes', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // First cycle runs immediately
    assert.strictEqual(mockService.getPRChecks.callCount, 1);

    // Advance by 2 minutes
    await clock.tickAsync(120000);

    // Second cycle should have run
    assert.strictEqual(mockService.getPRChecks.callCount, 2);

    // Advance by another 2 minutes
    await clock.tickAsync(120000);

    // Third cycle
    assert.strictEqual(mockService.getPRChecks.callCount, 3);

    monitor.stopMonitoring('rel-1');
  });

  test('stops after 40 minutes', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // First cycle runs immediately
    assert.strictEqual(mockService.getPRChecks.callCount, 1);

    // Advance past 40 minutes (21 cycles at 2 minutes each = 42 min)
    // The check is > MAX_MONITORING_MS, so at exactly 40 min it's still active
    for (let i = 0; i < 21; i++) {
      await clock.tickAsync(120000);
    }

    // Should stop monitoring after exceeding 40 minutes
    const isMonitoring = monitor.isMonitoring('rel-1');
    assert.strictEqual(isMonitoring, false);
  });

  test('resets timer on push', async () => {
    const mockService = createMockPRService();
    mockService.getPRComments.resolves([
      {
        id: 'c1',
        author: 'reviewer',
        body: 'Fix this',
        path: 'file.ts',
        line: 10,
        isResolved: false,
        source: 'review',
        threadId: 't1',
      },
    ]);

    const factory = createMockPRServiceFactory(mockService);
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);
    git.repository.getHead.resolves('new123');

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      git,
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // First cycle with findings - should push
    assert.strictEqual(mockService.getPRChecks.callCount, 1);
    assert.ok(git.repository.push.calledOnce);

    // Reset mocks
    mockService.getPRChecks.resetHistory();
    mockService.getPRComments.resolves([]);
    git.repository.hasChanges.resolves(false);
    git.repository.push.resetHistory();

    // Advance by 40 minutes
    for (let i = 0; i < 20; i++) {
      await clock.tickAsync(120000);
    }

    // Should still be monitoring because timer was reset by the push
    const isMonitoring = monitor.isMonitoring('rel-1');
    assert.strictEqual(isMonitoring, true);

    monitor.stopMonitoring('rel-1');
  });

  test('uses prService.getPRChecks() not gh directly', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    assert.ok(mockService.getPRChecks.calledOnce);
    assert.strictEqual(mockService.getPRChecks.firstCall.args[0], 42);
    assert.strictEqual(mockService.getPRChecks.firstCall.args[1], '/repo/.orchestrator/release/v1');

    monitor.stopMonitoring('rel-1');
  });

  test('uses prService.getPRComments() not gh directly', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    assert.ok(mockService.getPRComments.calledOnce);
    assert.strictEqual(mockService.getPRComments.firstCall.args[0], 42);
    assert.strictEqual(mockService.getPRComments.firstCall.args[1], '/repo/.orchestrator/release/v1');

    monitor.stopMonitoring('rel-1');
  });

  test('uses prService.getSecurityAlerts()', async () => {
    const mockService = createMockPRService();
    const factory = createMockPRServiceFactory(mockService);
    
    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    assert.ok(mockService.getSecurityAlerts.calledOnce);
    assert.strictEqual(mockService.getSecurityAlerts.firstCall.args[0], 'release/v1');
    assert.strictEqual(mockService.getSecurityAlerts.firstCall.args[1], '/repo/.orchestrator/release/v1');

    monitor.stopMonitoring('rel-1');
  });

  test('calls prService.replyToComment() for each comment', async () => {
    const mockService = createMockPRService();
    mockService.getPRComments.resolves([
      {
        id: 'c1',
        author: 'reviewer',
        body: 'Fix this',
        path: 'file.ts',
        line: 10,
        isResolved: false,
        source: 'review',
        threadId: 't1',
      },
      {
        id: 'c2',
        author: 'bot',
        body: 'Lint error',
        isResolved: false,
        source: 'bot',
        threadId: 't2',
      },
    ]);

    const factory = createMockPRServiceFactory(mockService);
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      git,
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // Should reply to both comments
    assert.strictEqual(mockService.replyToComment.callCount, 2);
    assert.strictEqual(mockService.replyToComment.firstCall.args[0], 42);
    assert.strictEqual(mockService.replyToComment.firstCall.args[1], 'c1');

    monitor.stopMonitoring('rel-1');
  });

  test('calls prService.resolveThread()', async () => {
    const mockService = createMockPRService();
    mockService.getPRComments.resolves([
      {
        id: 'c1',
        author: 'reviewer',
        body: 'Fix this',
        path: 'file.ts',
        line: 10,
        isResolved: false,
        source: 'review',
        threadId: 't1',
      },
    ]);

    const factory = createMockPRServiceFactory(mockService);
    const git = createMockGit();
    git.repository.hasChanges.resolves(true);

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      git,
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // Should resolve the thread
    assert.ok(mockService.resolveThread.calledOnce);
    assert.strictEqual(mockService.resolveThread.firstCall.args[0], 42);
    assert.strictEqual(mockService.resolveThread.firstCall.args[1], 't1');
    assert.strictEqual(mockService.resolveThread.firstCall.args[2], '/repo/.orchestrator/release/v1');

    monitor.stopMonitoring('rel-1');
  });

  test('concurrent monitoring independent timers', async () => {
    const mockService1 = createMockPRService();
    const mockService2 = createMockPRService();

    const factory = {
      getServiceForRepo: sinon.stub().callsFake((path: string) => {
        if (path.includes('v1')) return Promise.resolve(mockService1);
        if (path.includes('v2')) return Promise.resolve(mockService2);
        return Promise.resolve(createMockPRService());
      }),
    };

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    // Start monitoring two releases
    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');
    await monitor.startMonitoring('rel-2', 43, '/repo/.orchestrator/release/v2', 'release/v2');

    // Both should have run first cycle
    assert.strictEqual(mockService1.getPRChecks.callCount, 1);
    assert.strictEqual(mockService2.getPRChecks.callCount, 1);

    // Advance by 2 minutes
    await clock.tickAsync(120000);

    // Both should have run second cycle
    assert.strictEqual(mockService1.getPRChecks.callCount, 2);
    assert.strictEqual(mockService2.getPRChecks.callCount, 2);

    // Stop one monitor
    monitor.stopMonitoring('rel-1');

    // Advance by 2 minutes
    await clock.tickAsync(120000);

    // Only rel-2 should continue
    assert.strictEqual(mockService1.getPRChecks.callCount, 2); // No change
    assert.strictEqual(mockService2.getPRChecks.callCount, 3); // Incremented

    monitor.stopMonitoring('rel-2');
  });
});
