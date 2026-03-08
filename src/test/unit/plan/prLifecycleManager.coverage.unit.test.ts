/**
 * @fileoverview Coverage tests for DefaultPRLifecycleManager.
 * Covers: demotePR not-found (421-424), demotePR error (446-455),
 * removePR error (497-506), and removePR with 'addressing' status.
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultPRLifecycleManager } from '../../../plan/prLifecycleManager';
import type { RemoteProviderInfo, PRDetails } from '../../../plan/types/remotePR';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

const mockProvider: RemoteProviderInfo = {
  type: 'github',
  owner: 'test-owner',
  repoName: 'test-repo',
  remoteUrl: 'https://github.com/test-owner/test-repo.git',
  hostname: 'github.com',
};

const mockPRDetails: PRDetails = {
  prNumber: 42,
  title: 'Test PR',
  headBranch: 'feature/test',
  baseBranch: 'main',
  isDraft: false,
  state: 'open',
  author: 'test-user',
  url: 'https://github.com/test-owner/test-repo/pull/42',
  body: 'PR body',
};

suite('DefaultPRLifecycleManager coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };
  let mockPRService: any;
  let mockPRServiceFactory: any;
  let mockPRMonitor: any;
  let mockIsolatedRepos: any;
  let mockStore: any;
  let mockReleaseConfig: any;
  let manager: DefaultPRLifecycleManager;

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();

    mockPRService = {
      detectProvider: sandbox.stub().resolves(mockProvider),
      getPRDetails: sandbox.stub().resolves(mockPRDetails),
      listPRs: sandbox.stub().resolves([]),
      abandonPR: sandbox.stub().resolves(),
      promotePR: sandbox.stub().resolves(),
      demotePR: sandbox.stub().resolves(),
      replyToComment: sandbox.stub().resolves(),
    };

    mockPRServiceFactory = {
      getServiceForRepo: sandbox.stub().resolves(mockPRService),
    };

    mockPRMonitor = {
      startMonitoring: sandbox.stub().resolves(),
      stopMonitoring: sandbox.stub(),
    };

    mockIsolatedRepos = {
      getRepoInfo: sandbox.stub().resolves(undefined),
      createIsolatedRepo: sandbox.stub().resolves(),
      removeIsolatedRepo: sandbox.stub().resolves(),
    };

    mockStore = {
      save: sandbox.stub().resolves(),
      load: sandbox.stub().resolves(undefined),
      loadByPRNumber: sandbox.stub().resolves(undefined),
      loadAll: sandbox.stub().resolves([]),
      delete: sandbox.stub().resolves(),
    };

    mockReleaseConfig = {};

    manager = new DefaultPRLifecycleManager(
      mockPRServiceFactory,
      mockPRMonitor,
      mockIsolatedRepos,
      mockStore,
      mockReleaseConfig,
    );
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  // ── demotePR error paths ────────────────────────────────────────────────

  suite('demotePR', () => {
    test('returns error for non-existent PR id (lines 421-424)', async () => {
      // No PR adopted, so managedPRs is empty
      const result = await manager.demotePR('nonexistent-id');

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Managed PR not found'));
      assert.ok(result.error?.includes('nonexistent-id'));
    });

    test('returns error when prService.demotePR throws (lines 446-455)', async () => {
      // Adopt a PR first
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      // Make demotePR throw
      mockPRService.demotePR.rejects(new Error('demote API failure'));

      const result = await manager.demotePR(prId);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('demote API failure'));
    });

    test('returns error message from non-Error exception (lines 446-455)', async () => {
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      // Non-Error exception
      mockPRService.demotePR.rejects('string error');

      const result = await manager.demotePR(prId);

      assert.strictEqual(result.success, false);
      assert.ok(result.error !== undefined);
    });
  });

  // ── removePR error paths ────────────────────────────────────────────────

  suite('removePR', () => {
    test('returns error when store.delete throws (lines 497-506)', async () => {
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      mockStore.delete.rejects(new Error('storage failure'));

      const result = await manager.removePR(prId);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('storage failure'));
    });

    test('returns error when removeIsolatedRepo throws (lines 497-506)', async () => {
      const adoptResult = await manager.adoptPR({
        prNumber: 42,
        repoPath: '/repo',
        workingDirectory: '/isolated/clone',
      });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      mockIsolatedRepos.removeIsolatedRepo.rejects(new Error('isolated repo cleanup failed'));

      const result = await manager.removePR(prId);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('isolated repo cleanup failed'));
    });

    test('returns error with fallback message for non-Error exception (lines 497-506)', async () => {
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      // Reject with non-Error object
      mockStore.delete.rejects({ code: 'DISK_FULL' });

      const result = await manager.removePR(prId);

      assert.strictEqual(result.success, false);
      assert.ok(result.error !== undefined);
    });

    test('stops monitoring for PR with addressing status (line 473)', async () => {
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo' });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      // Manually set status to 'addressing' via internal map
      const pr = (manager as any).managedPRs.get(prId);
      assert.ok(pr);
      pr.status = 'addressing';

      await manager.removePR(prId);

      assert.ok(mockPRMonitor.stopMonitoring.calledWith(prId));
    });

    test('does not call removeIsolatedRepo when workingDirectory equals repoPath', async () => {
      const adoptResult = await manager.adoptPR({
        prNumber: 42,
        repoPath: '/repo',
        // No workingDirectory → defaults to repoPath
      });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      const result = await manager.removePR(prId);

      assert.strictEqual(result.success, true);
      // workingDirectory === repoPath → no isolated repo cleanup
      assert.ok(mockIsolatedRepos.removeIsolatedRepo.notCalled);
    });
  });

  // ── demotePR happy path completeness ──────────────────────────────────

  suite('demotePR happy path', () => {
    test('decreases priority from 1 to 0 when demoting', async () => {
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 1 });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      const result = await manager.demotePR(prId);

      assert.strictEqual(result.success, true);
      const updatedPR = manager.getManagedPR(prId);
      assert.strictEqual(updatedPR?.priority, 0);
    });

    test('priority does not go below 0', async () => {
      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 0 });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      const result = await manager.demotePR(prId);

      assert.strictEqual(result.success, true);
      const updatedPR = manager.getManagedPR(prId);
      assert.strictEqual(updatedPR?.priority, 0);
    });

    test('emits prDemoted event on success', async () => {
      const eventHandler = sandbox.stub();
      manager.on('prDemoted', eventHandler);

      const adoptResult = await manager.adoptPR({ prNumber: 42, repoPath: '/repo', priority: 2 });
      assert.ok(adoptResult.managedPR);
      const prId = adoptResult.managedPR.id;

      await manager.demotePR(prId);

      assert.ok(eventHandler.calledOnce);
    });
  });
});
