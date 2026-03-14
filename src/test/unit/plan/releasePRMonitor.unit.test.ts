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

/**
 * Creates a pulse emitter backed by setInterval so that sinon fake timers
 * can advance time and trigger pulse callbacks (one tick per second).
 * Supports multiple concurrent subscribers.
 */
function createTimerBasedPulse(): any {
  const handlers = new Set<() => void>();
  let intervalId: ReturnType<typeof setInterval> | undefined;

  intervalId = setInterval(() => {
    for (const h of handlers) h();
  }, 1000);

  return {
    onPulse: (fn: () => void) => {
      handlers.add(fn);
      return {
        dispose: () => {
          handlers.delete(fn);
          if (handlers.size === 0 && intervalId !== undefined) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
        },
      };
    },
    isRunning: true,
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
      createTimerBasedPulse(),
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // First cycle runs immediately
    assert.strictEqual(mockService.getPRChecks.callCount, 1);

    // Advance by 2 minutes (120 pulse ticks at 1s each)
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
      createTimerBasedPulse(),
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

  test('keeps monitoring beyond 40 minutes when findings are outstanding', async () => {
    const mockService = createMockPRService();
    mockService.getPRComments.resolves([
      {
        id: 'c1',
        author: 'reviewer',
        body: 'Please fix this',
        path: 'src/file.ts',
        line: 10,
        isResolved: false,
        source: 'review',
        threadId: 't1',
      },
    ]);

    const factory = createMockPRServiceFactory(mockService);

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      createMockGit(),
      factory,
      createTimerBasedPulse(),
    );

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // Advance past 40 minutes (21 cycles at 2 minutes each = 42 min)
    for (let i = 0; i < 21; i++) {
      await clock.tickAsync(120000);
    }

    // Should NOT stop monitoring because there are still outstanding findings
    const isMonitoring = monitor.isMonitoring('rel-1');
    assert.strictEqual(isMonitoring, true);

    monitor.stopMonitoring('rel-1');
  });

  test('emits cycleComplete event with findings (auto-fix disabled)', async () => {
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

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      git,
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    const cycleCompleteEvents: any[] = [];
    monitor.on('cycleComplete', (releaseId: string, cycle: any) => {
      cycleCompleteEvents.push({ releaseId, cycle });
    });

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // First cycle runs immediately with findings detected
    assert.strictEqual(mockService.getPRChecks.callCount, 1);
    // Auto-fix is disabled — no push, no replies, no thread resolution
    assert.ok(git.repository.push.notCalled);
    assert.ok(mockService.replyToComment.notCalled);
    assert.ok(mockService.resolveThread.notCalled);
    // cycleComplete event should have been emitted with the findings
    assert.strictEqual(cycleCompleteEvents.length, 1);
    assert.strictEqual(cycleCompleteEvents[0].releaseId, 'rel-1');
    assert.strictEqual(cycleCompleteEvents[0].cycle.comments.length, 1);

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

  test('does not auto-reply to comments (auto-fix disabled)', async () => {
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

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      git,
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    const cycleEvents: any[] = [];
    monitor.on('cycleComplete', (_: string, cycle: any) => cycleEvents.push(cycle));

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // Auto-fix disabled: no automatic replies
    assert.strictEqual(mockService.replyToComment.callCount, 0);
    // But the cycle should have captured the comments for display in the UI
    assert.strictEqual(cycleEvents.length, 1);
    assert.strictEqual(cycleEvents[0].comments.length, 2);

    monitor.stopMonitoring('rel-1');
  });

  test('does not auto-resolve threads (auto-fix disabled)', async () => {
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

    const monitor = new DefaultReleasePRMonitor(
      createMockCopilot(),
      createMockSpawner(),
      git,
      factory,
      { onPulse: () => ({ dispose: () => {} }), isRunning: false } as any,
    );

    const cycleEvents: any[] = [];
    monitor.on('cycleComplete', (_: string, cycle: any) => cycleEvents.push(cycle));

    await monitor.startMonitoring('rel-1', 42, '/repo/.orchestrator/release/v1', 'release/v1');

    // Auto-fix disabled: no automatic thread resolution
    assert.ok(mockService.resolveThread.notCalled);
    // Findings are surfaced via cycleComplete for user-triggered fixes
    assert.strictEqual(cycleEvents.length, 1);
    assert.strictEqual(cycleEvents[0].comments[0].isResolved, false);

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
      createTimerBasedPulse(),
    );
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
