/**
 * @fileoverview Unit tests for DefaultPRLifecycleManager.
 *
 * Covers:
 * - adoptPR: Adopt existing PR, duplicate check, error handling
 * - abandonPR: Stop monitoring, close PR, cleanup isolated clone
 * - promotePR: Increase priority, call remote service
 * - demotePR: Decrease priority, call remote service
 * - startMonitoring: Transition to monitoring, create isolated clone
 * - stopMonitoring: Transition back to adopted, stop monitor
 * - removePR: Complete removal, cleanup, delete from store
 * - listAvailablePRs: List with isManaged flag, filtering
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultPRLifecycleManager } from '../../../plan/prLifecycleManager';
import type { 
  ManagedPR, 
  AdoptPROptions, 
  ListPRsOptions 
} from '../../../plan/types/prLifecycle';
import type { 
  PRListItem, 
  PRDetails, 
  RemoteProviderInfo, 
  RemoteCredentials 
} from '../../../plan/types/remotePR';
import type { ManagedPR as StoredManagedPR } from '../../../interfaces/IManagedPRStore';

suite('DefaultPRLifecycleManager', () => {
  let sandbox: sinon.SinonSandbox;
  let mockPRServiceFactory: any;
  let mockPRMonitor: any;
  let mockIsolatedRepos: any;
  let mockStore: any;
  let mockReleaseConfig: any;
  let mockPRService: any;
  let manager: DefaultPRLifecycleManager;

  const mockProvider: RemoteProviderInfo = {
    type: 'github',
    owner: 'test-owner',
    repoName: 'test-repo',
    remoteUrl: 'https://github.com/test-owner/test-repo.git',
    hostname: 'github.com',
  };

  const mockCredentials: RemoteCredentials = {
    token: 'gh_token_123',
    tokenSource: 'environment',
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    // Mock PR service
    mockPRService = {
      detectProvider: sandbox.stub().resolves(mockProvider),
      getPRDetails: sandbox.stub().resolves({
        prNumber: 42,
        title: 'Test PR',
        headBranch: 'feature/test',
        baseBranch: 'main',
        isDraft: false,
        state: 'open',
        author: 'test-user',
        url: 'https://github.com/test-owner/test-repo/pull/42',
        body: 'Test PR body',
      } as PRDetails),
      listPRs: sandbox.stub().resolves([]),
      abandonPR: sandbox.stub().resolves(),
      promotePR: sandbox.stub().resolves(),
      demotePR: sandbox.stub().resolves(),
    };

    // Mock PR service factory
    mockPRServiceFactory = {
      getServiceForRepo: sandbox.stub().resolves(mockPRService),
    };

    // Mock PR monitor
    mockPRMonitor = {
      startMonitoring: sandbox.stub().resolves(),
      stopMonitoring: sandbox.stub(),
    };

    // Mock isolated repos
    mockIsolatedRepos = {
      getRepoInfo: sandbox.stub().resolves(undefined),
      createIsolatedRepo: sandbox.stub().resolves(),
      removeIsolatedRepo: sandbox.stub().resolves(),
    };

    // Mock store
    mockStore = {
      save: sandbox.stub().resolves(),
      load: sandbox.stub().resolves(undefined),
      loadByPRNumber: sandbox.stub().resolves(undefined),
      loadAll: sandbox.stub().resolves([]),
      delete: sandbox.stub().resolves(),
    };

    // Mock release config
    mockReleaseConfig = {};

    manager = new DefaultPRLifecycleManager(
      mockPRServiceFactory,
      mockPRMonitor,
      mockIsolatedRepos,
      mockStore,
      mockReleaseConfig
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  // ── adoptPR ────────────────────────────────────────────────────────────

  suite('adoptPR', () => {
    test('should adopt a new PR successfully', async () => {
      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
        priority: 1,
      };

      const result = await manager.adoptPR(options);

      assert.strictEqual(result.success, true);
      assert.ok(result.managedPR);
      assert.strictEqual(result.managedPR.prNumber, 42);
      assert.strictEqual(result.managedPR.status, 'adopted');
      assert.strictEqual(result.managedPR.priority, 1);
      assert.ok(mockPRService.detectProvider.calledOnce);
      assert.ok(mockPRService.getPRDetails.calledWith(42, '/repo'));
      assert.ok(mockStore.save.calledOnce);
    });

    test('should reject duplicate PR adoption', async () => {
      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
      };

      // Adopt first time
      await manager.adoptPR(options);

      // Try to adopt again
      const result = await manager.adoptPR(options);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('already managed'));
    });

    test('should use custom working directory', async () => {
      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
        workingDirectory: '/custom/path',
      };

      const result = await manager.adoptPR(options);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPR?.workingDirectory, '/custom/path');
    });

    test('should handle adoption errors gracefully', async () => {
      mockPRService.getPRDetails.rejects(new Error('API error'));

      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
      };

      const result = await manager.adoptPR(options);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('API error'));
    });

    test('should emit prAdopted event on success', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prAdopted', eventHandler);

      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
      };

      await manager.adoptPR(options);

      assert.ok(eventHandler.calledOnce);
      assert.strictEqual(eventHandler.firstCall.args[0].prNumber, 42);
    });

    test('should set default priority to 0 if not specified', async () => {
      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
      };

      const result = await manager.adoptPR(options);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPR?.priority, 0);
    });

    test('should store releaseId if provided', async () => {
      const options: AdoptPROptions = {
        prNumber: 42,
        repoPath: '/repo',
        releaseId: 'rel-123',
      };

      const result = await manager.adoptPR(options);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.managedPR?.releaseId, 'rel-123');
    });
  });

  // ── abandonPR ──────────────────────────────────────────────────────────

  suite('abandonPR', () => {
    test('should abandon PR and stop monitoring', async () => {
      // First adopt a PR
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      // Start monitoring
      await manager.startMonitoring(pr.id);

      // Abandon
      const result = await manager.abandonPR(pr.id);

      assert.strictEqual(result.success, true);
      assert.ok(mockPRMonitor.stopMonitoring.calledWith(pr.id));
      assert.ok(mockPRService.abandonPR.calledWith(42, pr.workingDirectory, 'Abandoned by orchestrator'));
      
      const updatedPR = manager.getManagedPR(pr.id);
      assert.strictEqual(updatedPR?.status, 'abandoned');
      assert.ok(updatedPR?.completedAt);
    });

    test('should cleanup isolated clone if exists', async () => {
      await manager.adoptPR({ 
        prNumber: 42, 
        repoPath: '/repo',
        workingDirectory: '/isolated/clone'
      });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.abandonPR(pr.id);

      assert.ok(mockIsolatedRepos.removeIsolatedRepo.calledWith(pr.id));
    });

    test('should return error for non-existent PR', async () => {
      const result = await manager.abandonPR('non-existent-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('not found'));
    });

    test('should emit prAbandoned event', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prAbandoned', eventHandler);

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.abandonPR(pr.id);

      assert.ok(eventHandler.calledOnce);
      assert.strictEqual(eventHandler.firstCall.args[0].status, 'abandoned');
    });

    test('should handle remote API errors', async () => {
      mockPRService.abandonPR.rejects(new Error('Network error'));

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      const result = await manager.abandonPR(pr.id);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('Network error'));
    });
  });

  // ── promotePR ──────────────────────────────────────────────────────────

  suite('promotePR', () => {
    test('should promote PR and increase priority', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 0 });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      const result = await manager.promotePR(pr.id);

      assert.strictEqual(result.success, true);
      assert.ok(mockPRService.promotePR.calledWith(42, pr.workingDirectory));
      
      const updatedPR = manager.getManagedPR(pr.id);
      assert.strictEqual(updatedPR?.priority, 1);
    });

    test('should emit prPromoted event', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prPromoted', eventHandler);

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.promotePR(pr.id);

      assert.ok(eventHandler.calledOnce);
      assert.strictEqual(eventHandler.firstCall.args[0].priority, 1);
    });

    test('should return error for non-existent PR', async () => {
      const result = await manager.promotePR('non-existent-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should handle remote API errors', async () => {
      mockPRService.promotePR.rejects(new Error('API error'));

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      const result = await manager.promotePR(pr.id);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  // ── demotePR ───────────────────────────────────────────────────────────

  suite('demotePR', () => {
    test('should demote PR and decrease priority', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 2 });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      const result = await manager.demotePR(pr.id);

      assert.strictEqual(result.success, true);
      assert.ok(mockPRService.demotePR.calledWith(42, pr.workingDirectory));
      
      const updatedPR = manager.getManagedPR(pr.id);
      assert.strictEqual(updatedPR?.priority, 1);
    });

    test('should not decrease priority below 0', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 0 });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.demotePR(pr.id);

      const updatedPR = manager.getManagedPR(pr.id);
      assert.strictEqual(updatedPR?.priority, 0);
    });

    test('should emit prDemoted event', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prDemoted', eventHandler);

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 1 });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.demotePR(pr.id);

      assert.ok(eventHandler.calledOnce);
    });
  });

  // ── startMonitoring ────────────────────────────────────────────────────

  suite('startMonitoring', () => {
    test('should transition PR to monitoring status', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);

      assert.ok(mockPRMonitor.startMonitoring.calledWith(
        pr.id,
        42,
        pr.workingDirectory,
        'feature/test'
      ));

      const updatedPR = manager.getManagedPR(pr.id);
      assert.strictEqual(updatedPR?.status, 'monitoring');
      assert.ok(updatedPR?.monitoringStartedAt);
    });

    test('should create isolated clone if working directory differs', async () => {
      await manager.adoptPR({ 
        prNumber: 42, 
        repoPath: '/repo',
        workingDirectory: '/isolated/clone'
      });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);

      assert.ok(mockIsolatedRepos.createIsolatedRepo.calledWith(
        pr.id,
        '/repo',
        'feature/test'
      ));
    });

    test('should throw for non-existent PR', async () => {
      await assert.rejects(
        async () => manager.startMonitoring('non-existent-id'),
        /Managed PR not found/
      );
    });

    test('should throw for PR not in adopted status', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);

      await assert.rejects(
        async () => manager.startMonitoring(pr.id),
        /Cannot start monitoring PR in 'monitoring' status/
      );
    });

    test('should emit prMonitoringStarted event', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prMonitoringStarted', eventHandler);

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);

      assert.ok(eventHandler.calledOnce);
      assert.strictEqual(eventHandler.firstCall.args[0].status, 'monitoring');
    });
  });

  // ── stopMonitoring ─────────────────────────────────────────────────────

  suite('stopMonitoring', () => {
    test('should transition PR back to adopted status', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);
      await manager.stopMonitoring(pr.id);

      assert.ok(mockPRMonitor.stopMonitoring.calledWith(pr.id));

      const updatedPR = manager.getManagedPR(pr.id);
      assert.strictEqual(updatedPR?.status, 'adopted');
    });

    test('should throw for non-existent PR', async () => {
      await assert.rejects(
        async () => manager.stopMonitoring('non-existent-id'),
        /Managed PR not found/
      );
    });

    test('should throw for PR not in monitoring/addressing status', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await assert.rejects(
        async () => manager.stopMonitoring(pr.id),
        /Cannot stop monitoring PR in 'adopted' status/
      );
    });

    test('should emit prMonitoringStopped event', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prMonitoringStopped', eventHandler);

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);
      await manager.stopMonitoring(pr.id);

      assert.ok(eventHandler.calledOnce);
    });
  });

  // ── removePR ───────────────────────────────────────────────────────────

  suite('removePR', () => {
    test('should remove PR completely', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      const result = await manager.removePR(pr.id);

      assert.strictEqual(result.success, true);
      assert.ok(mockStore.delete.calledWith(42));
      assert.strictEqual(manager.getManagedPR(pr.id), undefined);
    });

    test('should stop monitoring before removal', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.startMonitoring(pr.id);
      await manager.removePR(pr.id);

      assert.ok(mockPRMonitor.stopMonitoring.calledWith(pr.id));
    });

    test('should cleanup isolated clone before removal', async () => {
      await manager.adoptPR({ 
        prNumber: 42, 
        repoPath: '/repo',
        workingDirectory: '/isolated/clone'
      });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.removePR(pr.id);

      assert.ok(mockIsolatedRepos.removeIsolatedRepo.calledWith(pr.id));
    });

    test('should emit prRemoved event', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prRemoved', eventHandler);

      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      await manager.removePR(pr.id);

      assert.ok(eventHandler.calledOnce);
      assert.strictEqual(eventHandler.firstCall.args[0], pr.id);
    });

    test('should return error for non-existent PR', async () => {
      const result = await manager.removePR('non-existent-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  // ── listAvailablePRs ───────────────────────────────────────────────────

  suite('listAvailablePRs', () => {
    test('should list PRs with isManaged flag', async () => {
      const mockPRs: PRListItem[] = [
        {
          prNumber: 42,
          title: 'PR 1',
          headBranch: 'feature/1',
          baseBranch: 'main',
          state: 'open',
          isDraft: false,
          author: 'user1',
          url: 'https://github.com/test/repo/pull/42',
        },
        {
          prNumber: 43,
          title: 'PR 2',
          headBranch: 'feature/2',
          baseBranch: 'main',
          state: 'open',
          isDraft: false,
          author: 'user2',
          url: 'https://github.com/test/repo/pull/43',
        },
      ];

      mockPRService.listPRs.resolves(mockPRs);

      // Adopt one PR
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });

      const options: ListPRsOptions = {
        repoPath: '/repo',
        baseBranch: 'main',
      };

      const result = await manager.listAvailablePRs(options);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].isManaged, true); // PR 42 is adopted
      assert.strictEqual(result[1].isManaged, false); // PR 43 is not
    });

    test('should filter by base branch', async () => {
      const mockPRs: PRListItem[] = [
        {
          prNumber: 42,
          title: 'PR 1',
          headBranch: 'feature/1',
          baseBranch: 'main',
          state: 'open',
          isDraft: false,
          author: 'user1',
          url: 'https://github.com/test/repo/pull/42',
        },
        {
          prNumber: 43,
          title: 'PR 2',
          headBranch: 'feature/2',
          baseBranch: 'develop',
          state: 'open',
          isDraft: false,
          author: 'user2',
          url: 'https://github.com/test/repo/pull/43',
        },
      ];

      mockPRService.listPRs.resolves(mockPRs);

      const options: ListPRsOptions = {
        repoPath: '/repo',
        baseBranch: 'main',
      };

      const result = await manager.listAvailablePRs(options);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].baseBranch, 'main');
    });

    test('should pass state and limit options to PR service', async () => {
      mockPRService.listPRs.resolves([]);

      const options: ListPRsOptions = {
        repoPath: '/repo',
        state: 'all',
        limit: 50,
      };

      await manager.listAvailablePRs(options);

      assert.ok(mockPRService.listPRs.calledWith('/repo', {
        state: 'all',
        limit: 50,
      }));
    });
  });

  // ── Query methods ──────────────────────────────────────────────────────

  suite('query methods', () => {
    test('getManagedPR should return PR by ID', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr);

      const result = manager.getManagedPR(pr.id);

      assert.ok(result);
      assert.strictEqual(result.prNumber, 42);
    });

    test('getManagedPRByNumber should return PR by number and repo', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });

      const result = manager.getManagedPRByNumber(42, '/repo');

      assert.ok(result);
      assert.strictEqual(result.prNumber, 42);
      assert.strictEqual(result.repoPath, '/repo');
    });

    test('getAllManagedPRs should return all PRs', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      await manager.adoptPR({ prNumber: 43, repoPath: '/repo' });

      const result = manager.getAllManagedPRs();

      assert.strictEqual(result.length, 2);
    });

    test('getManagedPRsByStatus should filter by status', async () => {
      await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      const pr1 = manager.getManagedPRByNumber(42, '/repo');
      assert.ok(pr1);
      await manager.startMonitoring(pr1.id);

      await manager.adoptPR({ prNumber: 43, repoPath: '/repo' });

      const adopted = manager.getManagedPRsByStatus('adopted');
      const monitoring = manager.getManagedPRsByStatus('monitoring');

      assert.strictEqual(adopted.length, 1);
      assert.strictEqual(monitoring.length, 1);
      assert.strictEqual(monitoring[0].prNumber, 42);
    });
  });

  // ── Initialization ─────────────────────────────────────────────────────

  suite('initialization', () => {
    test('should load persisted PRs on first operation', async () => {
      const storedPR: StoredManagedPR = {
        id: 'stored-id',
        prNumber: 42,
        title: 'Stored PR',
        prUrl: 'https://github.com/test/repo/pull/42',
        headBranch: 'feature/stored',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/repo',
        workingDirectory: '/repo',
        adoptedAt: Date.now(),
      };

      mockStore.loadAll.resolves([storedPR]);
      mockPRService.listPRs.resolves([]);

      const newManager = new DefaultPRLifecycleManager(
        mockPRServiceFactory,
        mockPRMonitor,
        mockIsolatedRepos,
        mockStore,
        mockReleaseConfig
      );

      // Trigger initialization by calling an async method
      await newManager.listAvailablePRs({ repoPath: '/repo' });
      
      // After initialization, the stored PR should be available
      const pr = newManager.getManagedPR('stored-id');
      assert.ok(pr);
      assert.strictEqual(pr.prNumber, 42);
      assert.strictEqual(pr.status, 'adopted');
    });

    test('should handle initialization errors', async () => {
      mockStore.loadAll.rejects(new Error('Storage error'));

      const newManager = new DefaultPRLifecycleManager(
        mockPRServiceFactory,
        mockPRMonitor,
        mockIsolatedRepos,
        mockStore,
        mockReleaseConfig
      );

      await assert.rejects(
        async () => newManager.adoptPR({ prNumber: 42, repoPath: '/repo' }),
        /Storage error/
      );
    });
  });
});
