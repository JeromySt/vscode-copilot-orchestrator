/**
 * @fileoverview Unit tests for ReleaseManager preparation task log functionality
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

function createMockPlanRunner(): any {
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
      metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } 
    }),
    isAvailable: sinon.stub().returns(true),
    writeInstructionsFile: sinon.stub().returns({ filePath: '/tmp/inst.md', dirPath: '/tmp' }),
    buildCommand: sinon.stub().returns('copilot ...'),
    cleanupInstructionsFile: sinon.stub(),
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
    on: sinon.stub(),
    resetPolling: sinon.stub(),
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

function makeTestRelease(overrides?: Partial<ReleaseDefinition>): ReleaseDefinition {
  return {
    id: 'rel-1',
    name: 'Release 1',
    flowType: 'from-plans',
    status: 'preparing',
    planIds: [],
    releaseBranch: 'release/v1.0',
    targetBranch: 'main',
    repoPath: '/repo',
    createdAt: Date.now(),
    stateHistory: [],
    prepTasks: [{ id: 'task-1', title: 'Test Task', status: 'pending', required: false, autoSupported: true }],
    ...overrides,
  };
}

suite('ReleaseManager - Preparation Task Logs', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;
  let mockPlanRunner: any;
  let mockGit: any;
  let mockCopilot: any;
  let mockIsolatedRepos: any;
  let mockPRMonitor: any;
  let mockPRServiceFactory: any;
  let mockStore: any;
  let manager: DefaultReleaseManager;
  let fsPromises: any;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    mockPlanRunner = createMockPlanRunner();
    mockGit = createMockGitOps();
    mockCopilot = createMockCopilot();
    mockIsolatedRepos = createMockIsolatedRepos();
    mockPRMonitor = createMockPRMonitor();
    mockPRServiceFactory = createMockPRServiceFactory();
    mockStore = createMockReleaseStore();

    // Mock fs.promises by stubbing it directly
    fsPromises = {
      mkdir: sandbox.stub().resolves(),
      appendFile: sandbox.stub().resolves(),
    };
    
    // Replace the fs module methods
    const fs = require('fs');
    sandbox.stub(fs.promises, 'mkdir').callsFake(fsPromises.mkdir);
    sandbox.stub(fs.promises, 'appendFile').callsFake(fsPromises.appendFile);

    manager = new DefaultReleaseManager(
      mockPlanRunner,
      mockGit,
      mockCopilot,
      mockIsolatedRepos,
      mockPRMonitor,
      mockPRServiceFactory,
      mockStore,
    );
  });

  teardown(() => {
    sandbox.restore();
    quiet.restore();
  });

  suite('executePreparationTask', () => {
    test('should create log directory', async () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      await manager.executePreparationTask('rel-1', 'task-1');

      assert.ok(fsPromises.mkdir.calledOnce, 'mkdir should be called once');
      const mkdirCall = fsPromises.mkdir.firstCall;
      assert.ok(mkdirCall.args[0].includes('task-logs'), 'should create task-logs directory');
      assert.deepStrictEqual(mkdirCall.args[1], { recursive: true }, 'should use recursive option');
    });

    test('should set task.logFilePath', async () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      await manager.executePreparationTask('rel-1', 'task-1');

      const task = release.prepTasks![0];
      assert.ok(task.logFilePath, 'logFilePath should be set');
      assert.ok(task.logFilePath.includes('task-1.log'), 'logFilePath should include task ID');
    });

    test('should set task.startedAt and task.completedAt', async () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      const beforeExecution = Date.now();
      await manager.executePreparationTask('rel-1', 'task-1');
      const afterExecution = Date.now();

      const task = release.prepTasks![0];
      assert.ok(task.startedAt, 'startedAt should be set');
      assert.ok(task.startedAt >= beforeExecution, 'startedAt should be after test start');
      assert.ok(task.completedAt, 'completedAt should be set');
      assert.ok(task.completedAt >= task.startedAt, 'completedAt should be after startedAt');
      assert.ok(task.completedAt <= afterExecution, 'completedAt should be before test end');
    });

    test('should write error to log file on failed task execution', async () => {
      const failureCopilot: any = {
        run: sandbox.stub().resolves({ 
          success: false, 
          error: 'Task execution failed',
          sessionId: 'test', 
          metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } 
        }),
        isAvailable: sandbox.stub().returns(true),
        writeInstructionsFile: sandbox.stub().returns({ filePath: '/tmp/inst.md', dirPath: '/tmp' }),
        buildCommand: sandbox.stub().returns('copilot ...'),
        cleanupInstructionsFile: sandbox.stub(),
      };

      const failManager = new DefaultReleaseManager(
        mockPlanRunner,
        mockGit,
        failureCopilot,
        mockIsolatedRepos,
        mockPRMonitor,
        mockPRServiceFactory,
        mockStore,
      );

      const release = makeTestRelease();

      (failManager as any).releases.set('rel-1', release);

      await failManager.executePreparationTask('rel-1', 'task-1');

      const task = release.prepTasks![0];
      assert.strictEqual(task.status, 'failed', 'task status should be failed');
      assert.strictEqual(task.error, 'Task execution failed', 'task error should be set');

      // Check that error was written to log
      const appendCalls = fsPromises.appendFile.getCalls();
      const errorLogCall = appendCalls.find((call: any) => call.args[1].includes('Task failed:'));
      assert.ok(errorLogCall, 'error should be written to log file');
    });
  });

  suite('skipPreparationTask', () => {
    test('should write skip note to log and set completedAt', async () => {
      const release = makeTestRelease({
        prepTasks: [{ id: 'task-1', title: 'Test Task', status: 'pending', required: false, autoSupported: true, logFilePath: '/logs/task-1.log' }],
      });

      (manager as any).releases.set('rel-1', release);

      const beforeSkip = Date.now();
      await manager.skipPreparationTask('rel-1', 'task-1');
      const afterSkip = Date.now();

      const task = release.prepTasks![0];
      assert.strictEqual(task.status, 'skipped', 'task status should be skipped');
      assert.ok(task.completedAt, 'completedAt should be set');
      assert.ok(task.completedAt >= beforeSkip && task.completedAt <= afterSkip, 'completedAt should be in range');

      // Check that skip message was written
      assert.ok(fsPromises.appendFile.called, 'appendFile should be called');
      const appendCall = fsPromises.appendFile.firstCall;
      assert.strictEqual(appendCall.args[0], '/logs/task-1.log', 'should write to correct log file');
      assert.ok(appendCall.args[1].includes('Task skipped by user'), 'should write skip message');
    });

    test('should create log file if it does not exist', async () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      await manager.skipPreparationTask('rel-1', 'task-1');

      const task = release.prepTasks![0];
      assert.ok(task.logFilePath, 'logFilePath should be set');
      assert.ok(fsPromises.mkdir.called, 'mkdir should be called to create log directory');
      assert.ok(fsPromises.appendFile.called, 'appendFile should be called');
    });
  });

  suite('completePreparationTask', () => {
    test('should write complete note and set completedAt', async () => {
      const release = makeTestRelease({
        prepTasks: [{ id: 'task-1', title: 'Test Task', status: 'pending', required: false, autoSupported: true, logFilePath: '/logs/task-1.log' }],
      });

      (manager as any).releases.set('rel-1', release);

      const beforeComplete = Date.now();
      await manager.completePreparationTask('rel-1', 'task-1');
      const afterComplete = Date.now();

      const task = release.prepTasks![0];
      assert.strictEqual(task.status, 'completed', 'task status should be completed');
      assert.ok(task.completedAt, 'completedAt should be set');
      assert.ok(task.completedAt >= beforeComplete && task.completedAt <= afterComplete, 'completedAt should be in range');

      // Check that complete message was written
      assert.ok(fsPromises.appendFile.called, 'appendFile should be called');
      const appendCall = fsPromises.appendFile.firstCall;
      assert.strictEqual(appendCall.args[0], '/logs/task-1.log', 'should write to correct log file');
      assert.ok(appendCall.args[1].includes('Task manually marked as completed'), 'should write complete message');
    });

    test('should create log file if it does not exist', async () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      await manager.completePreparationTask('rel-1', 'task-1');

      const task = release.prepTasks![0];
      assert.ok(task.logFilePath, 'logFilePath should be set');
      assert.ok(fsPromises.mkdir.called, 'mkdir should be called to create log directory');
      assert.ok(fsPromises.appendFile.called, 'appendFile should be called');
    });
  });

  suite('getTaskLogFilePath', () => {
    test('should return undefined when release not found', () => {
      const result = manager.getTaskLogFilePath('nonexistent-release', 'task-1');
      assert.strictEqual(result, undefined, 'should return undefined for nonexistent release');
    });

    test('should return undefined when task not found', () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      const result = manager.getTaskLogFilePath('rel-1', 'nonexistent-task');
      assert.strictEqual(result, undefined, 'should return undefined for nonexistent task');
    });

    test('should return undefined when task has no logFilePath', () => {
      const release = makeTestRelease();

      (manager as any).releases.set('rel-1', release);

      const result = manager.getTaskLogFilePath('rel-1', 'task-1');
      assert.strictEqual(result, undefined, 'should return undefined when logFilePath not set');
    });

    test('should return the logFilePath when set', () => {
      const release = makeTestRelease({
        prepTasks: [{ id: 'task-1', title: 'Test Task', status: 'pending', required: false, autoSupported: true, logFilePath: '/logs/task-1.log' }],
      });

      (manager as any).releases.set('rel-1', release);

      const result = manager.getTaskLogFilePath('rel-1', 'task-1');
      assert.strictEqual(result, '/logs/task-1.log', 'should return the logFilePath');
    });
  });
});
