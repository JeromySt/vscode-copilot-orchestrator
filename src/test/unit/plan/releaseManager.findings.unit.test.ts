/**
 * @fileoverview Unit tests for ReleaseManager findings methods
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultReleaseManager } from '../../../plan/releaseManager';
import type { ReleaseDefinition, PrepTask, ReviewFinding } from '../../../plan/types/release';

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

suite('ReleaseManager findings', () => {
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

  suite('updateFindingStatus', () => {
    test('updates finding status to acknowledged', async () => {
      const store = createMockReleaseStore();
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      // Create a release with a task containing findings
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
        status: 'succeeded',
      };
      const planRunner = createMockPlanRunner({ get: sinon.stub().returns(mockPlan) });
      const manager2 = new DefaultReleaseManager(
        planRunner,
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        store,
      );

      const release = await manager2.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      // Add a prep task with findings manually
      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Code Review',
          description: 'Review code',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'finding-1',
              severity: 'warning',
              title: 'Test finding',
              description: 'Test description',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
      ];

      // Update the finding status
      await manager2.updateFindingStatus(release.id, 'task-1', 'finding-1', 'acknowledged');

      // Verify
      const task = release.prepTasks!.find((t) => t.id === 'task-1')!;
      const finding = task.findings!.find((f) => f.id === 'finding-1')!;
      assert.strictEqual(finding.status, 'acknowledged');
      assert.ok(store.saveRelease.calledTwice); // Once for create, once for update
    });

    test('updates finding status to dismissed with note', async () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      const release = await manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Code Review',
          description: 'Review',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'finding-1',
              severity: 'info',
              title: 'Minor issue',
              description: 'Not important',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
      ];

      await manager.updateFindingStatus(release.id, 'task-1', 'finding-1', 'dismissed', 'Not applicable');

      const task = release.prepTasks!.find((t) => t.id === 'task-1')!;
      const finding = task.findings!.find((f) => f.id === 'finding-1')!;
      assert.strictEqual(finding.status, 'dismissed');
      assert.strictEqual(finding.note, 'Not applicable');
    });

    test('throws when release not found', async () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore(),
      );

      await assert.rejects(
        async () => {
          await manager.updateFindingStatus('nonexistent', 'task-1', 'finding-1', 'acknowledged');
        },
        /Release not found/
      );
    });

    test('throws when task not found', async () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      const release = await manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      await assert.rejects(
        async () => {
          await manager.updateFindingStatus(release.id, 'nonexistent-task', 'finding-1', 'acknowledged');
        },
        /Preparation task not found/
      );
    });

    test('throws when finding not found', async () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      const release = await manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Code Review',
          description: 'Review',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'different-finding',
              severity: 'info',
              title: 'Some other finding',
              description: 'Not the one we are looking for',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
      ];

      await assert.rejects(
        async () => {
          await manager.updateFindingStatus(release.id, 'task-1', 'nonexistent-finding', 'acknowledged');
        },
        /Finding not found/
      );
    });

    test('emits releaseProgress after update', async () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      const release = await manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Code Review',
          description: 'Review',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'finding-1',
              severity: 'warning',
              title: 'Test',
              description: 'Test',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
      ];

      const progressSpy = sinon.spy();
      manager.on('releaseProgress', progressSpy);

      await manager.updateFindingStatus(release.id, 'task-1', 'finding-1', 'acknowledged');

      assert.ok(progressSpy.called);
    });
  });

  suite('getAllFindings', () => {
    test('returns empty array when no findings', () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      // Create release but don't add any findings
      manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      }).then((release) => {
        const findings = manager.getAllFindings(release.id);
        assert.strictEqual(findings.length, 0);
      });
    });

    test('returns findings from single task', async () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      const release = await manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Code Review',
          description: 'Review',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'finding-1',
              severity: 'error',
              title: 'Error 1',
              description: 'Desc 1',
              status: 'open',
              createdAt: Date.now(),
            },
            {
              id: 'finding-2',
              severity: 'warning',
              title: 'Warning 1',
              description: 'Desc 2',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
      ];

      const findings = manager.getAllFindings(release.id);
      assert.strictEqual(findings.length, 2);
      assert.strictEqual(findings[0].id, 'finding-1');
      assert.strictEqual(findings[1].id, 'finding-2');
    });

    test('returns findings from multiple tasks flattened', async () => {
      const store = createMockReleaseStore();
      const mockPlan = {
        id: 'plan-1',
        spec: { name: 'Test', repoPath: '/repo', baseBranch: 'main' },
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
        store,
      );

      const release = await manager.createRelease({
        name: 'Test Release',
        releaseBranch: 'release-v1',
        targetBranch: 'main',
        planIds: ['plan-1'],
      });

      release.prepTasks = [
        {
          id: 'task-1',
          title: 'Review 1',
          description: 'Review',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'finding-1',
              severity: 'error',
              title: 'Error 1',
              description: 'Desc 1',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
        {
          id: 'task-2',
          title: 'Review 2',
          description: 'Review',
          required: false,
          autoSupported: true,
          status: 'completed',
          findings: [
            {
              id: 'finding-2',
              severity: 'warning',
              title: 'Warning 1',
              description: 'Desc 2',
              status: 'open',
              createdAt: Date.now(),
            },
            {
              id: 'finding-3',
              severity: 'info',
              title: 'Info 1',
              description: 'Desc 3',
              status: 'open',
              createdAt: Date.now(),
            },
          ],
        } as PrepTask,
      ];

      const findings = manager.getAllFindings(release.id);
      assert.strictEqual(findings.length, 3);
      assert.strictEqual(findings[0].id, 'finding-1');
      assert.strictEqual(findings[1].id, 'finding-2');
      assert.strictEqual(findings[2].id, 'finding-3');
    });

    test('returns empty when release not found', () => {
      const manager = new DefaultReleaseManager(
        createMockPlanRunner(),
        createMockGitOps(),
        createMockCopilot(),
        createMockIsolatedRepos(),
        createMockPRMonitor(),
        createMockPRServiceFactory(),
        createMockReleaseStore(),
      );

      const findings = manager.getAllFindings('nonexistent');
      assert.strictEqual(findings.length, 0);
    });
  });
});
