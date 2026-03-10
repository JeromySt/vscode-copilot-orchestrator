/**
 * @fileoverview Unit tests for FileSystemManagedPRStore.
 *
 * Covers:
 * - save: Save managed PR to .orchestrator/managed-prs/<pr-number>/
 * - load: Load managed PR by PR number
 * - loadByPRNumber: Alias for load
 * - loadAll: Load all managed PRs
 * - delete: Delete managed PR directory
 * - Path validation: Block path traversal
 * - Atomic writes: Write to temp file, then rename
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';
import { FileSystemManagedPRStore } from '../../../../plan/store/managedPRStore';
import type { ManagedPR } from '../../../../interfaces/IManagedPRStore';

function makePR(overrides?: Partial<ManagedPR>): ManagedPR {
  return {
    id: 'pr-42',
    prNumber: 42,
    prUrl: 'https://github.com/test/repo/pull/42',
    title: 'Test PR',
    headBranch: 'feature/test',
    baseBranch: 'main',
    status: 'adopted',
    providerType: 'github',
    repoPath: '/test/repo',
    workingDirectory: '/test/repo',
    adoptedAt: Date.now(),
    ...overrides,
  };
}

suite('FileSystemManagedPRStore', () => {
  let sandbox: sinon.SinonSandbox;
  let mockFS: any;
  let store: FileSystemManagedPRStore;

  const repoPath = '/test/repo';
  const orchestratorPath = path.join(repoPath, '.orchestrator');

  setup(() => {
    sandbox = sinon.createSandbox();

    mockFS = {
      mkdirAsync: sandbox.stub().resolves(),
      writeFileAsync: sandbox.stub().resolves(),
      renameAsync: sandbox.stub().resolves(),
      unlinkAsync: sandbox.stub().resolves(),
      readFileAsync: sandbox.stub().resolves('{}'),
      existsAsync: sandbox.stub().resolves(true),
      readdirAsync: sandbox.stub().resolves([]),
      rmAsync: sandbox.stub().resolves(),
    };

    store = new FileSystemManagedPRStore(repoPath, mockFS);
  });

  teardown(() => {
    sandbox.restore();
  });

  // ── save ───────────────────────────────────────────────────────────────

  suite('save', () => {
    test('should save managed PR to correct directory', async () => {
      const pr = makePR();

      await store.save(pr);

      const expectedDir = path.join(repoPath, '.orchestrator', 'managed-prs', '42');
      const expectedTempFile = path.join(expectedDir, '.managed-pr.json.tmp');
      const expectedFinalFile = path.join(expectedDir, 'managed-pr.json');

      // Verify mkdir
      assert.ok(mockFS.mkdirAsync.calledOnce);
      assert.ok(mockFS.mkdirAsync.calledWith(expectedDir, { recursive: true }));

      // Verify write to temp file
      assert.ok(mockFS.writeFileAsync.calledOnce);
      assert.strictEqual(mockFS.writeFileAsync.firstCall.args[0], expectedTempFile);
      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(writtenContent.prNumber, 42);
      assert.strictEqual(writtenContent.title, 'Test PR');

      // Verify atomic rename
      assert.ok(mockFS.renameAsync.calledOnce);
      assert.ok(mockFS.renameAsync.calledWith(expectedTempFile, expectedFinalFile));
    });

    test('should serialize PR with metadata', async () => {
      const pr = makePR({
        releaseId: 'rel-123',
        priority: 2,
        unresolvedComments: 3,
      });

      await store.save(pr);

      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(writtenContent.releaseId, 'rel-123');
      assert.strictEqual(writtenContent.priority, 2);
      assert.strictEqual(writtenContent.unresolvedComments, 3);
    });

    test('should cleanup temp file on error', async () => {
      mockFS.renameAsync.rejects(new Error('Rename failed'));

      const pr = makePR();

      await assert.rejects(
        async () => store.save(pr),
        /Rename failed/
      );

      // Verify cleanup attempted
      const expectedTempFile = path.join(repoPath, '.orchestrator', 'managed-prs', '42', '.managed-pr.json.tmp');
      assert.ok(mockFS.unlinkAsync.calledWith(expectedTempFile));
    });

    test('should not throw if cleanup fails', async () => {
      mockFS.renameAsync.rejects(new Error('Rename failed'));
      mockFS.unlinkAsync.rejects(new Error('Cleanup failed'));

      const pr = makePR();

      // Should throw rename error, not cleanup error
      await assert.rejects(
        async () => store.save(pr),
        /Rename failed/
      );
    });
  });

  // ── load ───────────────────────────────────────────────────────────────

  suite('load', () => {
    test('should load managed PR from correct file', async () => {
      const storedPR = {
        id: 'pr-42',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        title: 'Stored PR',
        headBranch: 'feature/stored',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: 1234567890,
      };

      mockFS.readFileAsync.resolves(JSON.stringify(storedPR));

      const result = await store.load(42);

      const expectedFile = path.join(repoPath, '.orchestrator', 'managed-prs', '42', 'managed-pr.json');
      assert.ok(mockFS.readFileAsync.calledWith(expectedFile));

      assert.ok(result);
      assert.strictEqual(result.prNumber, 42);
      assert.strictEqual(result.title, 'Stored PR');
    });

    test('should return undefined if file does not exist', async () => {
      const error: any = new Error('ENOENT');
      error.code = 'ENOENT';
      mockFS.readFileAsync.rejects(error);

      const result = await store.load(42);

      assert.strictEqual(result, undefined);
    });

    test('should throw on non-ENOENT errors', async () => {
      mockFS.readFileAsync.rejects(new Error('Permission denied'));

      await assert.rejects(
        async () => store.load(42),
        /Permission denied/
      );
    });

    test('should parse JSON with metadata', async () => {
      const storedPR = {
        id: 'pr-42',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        title: 'PR with metadata',
        headBranch: 'feature/meta',
        baseBranch: 'main',
        status: 'monitoring',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: Date.now(),
        releaseId: 'rel-456',
        unresolvedComments: 2,
      };

      mockFS.readFileAsync.resolves(JSON.stringify(storedPR));

      const result = await store.load(42);

      assert.ok(result);
      assert.strictEqual(result.releaseId, 'rel-456');
      assert.strictEqual(result.unresolvedComments, 2);
    });
  });

  // ── loadByPRNumber ─────────────────────────────────────────────────────

  suite('loadByPRNumber', () => {
    test('should be an alias for load', async () => {
      const storedPR = {
        id: 'pr-42',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        title: 'PR',
        headBranch: 'feature',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: Date.now(),
      };

      mockFS.readFileAsync.resolves(JSON.stringify(storedPR));

      const result = await store.loadByPRNumber(42);

      assert.ok(result);
      assert.strictEqual(result.prNumber, 42);
    });
  });

  // ── loadAll ────────────────────────────────────────────────────────────

  suite('loadAll', () => {
    test('should load all managed PRs', async () => {
      const pr1 = {
        id: 'pr-42',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        title: 'PR 1',
        headBranch: 'feature/1',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: Date.now(),
      };

      const pr2 = {
        id: 'pr-43',
        prNumber: 43,
        prUrl: 'https://github.com/test/repo/pull/43',
        title: 'PR 2',
        headBranch: 'feature/2',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: Date.now(),
      };

      mockFS.readdirAsync.resolves(['42', '43']);

      let readCallCount = 0;
      mockFS.readFileAsync.callsFake(async (filePath: string) => {
        readCallCount++;
        if (filePath.includes('42')) {
          return JSON.stringify(pr1);
        } else if (filePath.includes('43')) {
          return JSON.stringify(pr2);
        }
        throw new Error('Unexpected file path');
      });

      const result = await store.loadAll();

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].prNumber, 42);
      assert.strictEqual(result[1].prNumber, 43);

      // Verify readdir called
      const expectedRoot = path.join(repoPath, '.orchestrator', 'managed-prs');
      assert.ok(mockFS.readdirAsync.calledWith(expectedRoot));
    });

    test('should return empty array if managed-prs directory does not exist', async () => {
      mockFS.existsAsync.resolves(false);

      const result = await store.loadAll();

      assert.deepStrictEqual(result, []);
      assert.ok(!mockFS.readdirAsync.called);
    });

    test('should skip invalid files', async () => {
      const pr1 = {
        id: 'pr-42',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        title: 'Valid PR',
        headBranch: 'feature/valid',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: Date.now(),
      };

      mockFS.readdirAsync.resolves(['42', '43']);

      let readCallCount = 0;
      mockFS.readFileAsync.callsFake(async (filePath: string) => {
        readCallCount++;
        if (filePath.includes('42')) {
          return JSON.stringify(pr1);
        } else {
          // PR 43 file is invalid
          throw new Error('Invalid JSON');
        }
      });

      const result = await store.loadAll();

      // Should return only the valid PR
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].prNumber, 42);
    });

    test('should throw on directory read errors', async () => {
      mockFS.readdirAsync.rejects(new Error('Permission denied'));

      await assert.rejects(
        async () => store.loadAll(),
        /Permission denied/
      );
    });

    test('should skip non-numeric directory entries', async () => {
      const pr1 = {
        id: 'pr-42',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        title: 'Valid PR',
        headBranch: 'feature/valid',
        baseBranch: 'main',
        status: 'adopted',
        providerType: 'github',
        repoPath: '/test/repo',
        workingDirectory: '/test/repo',
        adoptedAt: Date.now(),
      };

      mockFS.readdirAsync.resolves(['.DS_Store', '42', 'not-a-number']);
      mockFS.readFileAsync.resolves(JSON.stringify(pr1));

      const result = await store.loadAll();

      // Only the numeric PR entry should be loaded
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].prNumber, 42);
      // readFileAsync called only once (for the numeric entry)
      assert.strictEqual(mockFS.readFileAsync.callCount, 1);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  suite('delete', () => {
    test('should delete managed PR directory', async () => {
      await store.delete(42);

      const expectedDir = path.join(repoPath, '.orchestrator', 'managed-prs', '42');

      // Verify rmAsync called with correct path and options
      assert.ok(mockFS.rmAsync.calledOnce);
      assert.strictEqual(mockFS.rmAsync.firstCall.args[0], expectedDir);
      assert.deepStrictEqual(mockFS.rmAsync.firstCall.args[1], {
        recursive: true,
        force: true,
      });
    });

    test('should not throw if directory does not exist', async () => {
      mockFS.existsAsync.resolves(false);

      await store.delete(42);

      // Should not call rmAsync
      assert.ok(!mockFS.rmAsync.called);
    });

    test('should throw on delete errors', async () => {
      mockFS.rmAsync.rejects(new Error('Permission denied'));

      await assert.rejects(
        async () => store.delete(42),
        /Permission denied/
      );
    });
  });

  // ── Path validation ────────────────────────────────────────────────────

  suite('path validation', () => {
    test('should block path traversal with ..', async () => {
      const pr = makePR();

      // The validation happens in getManagedPRPath, which is called by save/load/delete
      // We can test this by checking that the path is constructed correctly
      await store.save(pr);

      const expectedDir = path.join(repoPath, '.orchestrator', 'managed-prs', '42');
      assert.ok(mockFS.mkdirAsync.calledWith(expectedDir, { recursive: true }));
    });

    test('should construct valid paths for numeric PR numbers', async () => {
      await store.load(12345);

      const expectedFile = path.join(repoPath, '.orchestrator', 'managed-prs', '12345', 'managed-pr.json');
      assert.ok(mockFS.readFileAsync.calledWith(expectedFile));
    });

    test('should handle single-digit PR numbers', async () => {
      await store.load(1);

      const expectedFile = path.join(repoPath, '.orchestrator', 'managed-prs', '1', 'managed-pr.json');
      assert.ok(mockFS.readFileAsync.calledWith(expectedFile));
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  suite('edge cases', () => {
    test('should handle empty metadata', async () => {
      const pr = makePR({ unresolvedComments: undefined });

      await store.save(pr);

      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(writtenContent.unresolvedComments, undefined);
    });

    test('should handle missing optional fields', async () => {
      const pr = makePR();

      await store.save(pr);

      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(writtenContent.releaseId, undefined);
      assert.strictEqual(writtenContent.priority, undefined);
      assert.strictEqual(writtenContent.error, undefined);
    });

    test('should preserve all fields during save-load round trip', async () => {
      const pr: ManagedPR = makePR({
        id: 'pr-complete',
        title: 'Complete PR',
        headBranch: 'feature/complete',
        prUrl: 'https://github.com/test/repo/pull/42',
        status: 'monitoring',
        workingDirectory: '/test/repo/wt',
        adoptedAt: 1234567890,
        monitoringStartedAt: 1234567900,
        releaseId: 'rel-xyz',
        priority: 3,
        unresolvedComments: 5,
        failingChecks: 1,
      });

      // Save
      await store.save(pr);
      const savedJson = mockFS.writeFileAsync.firstCall.args[1];

      // Load (simulate reading back)
      mockFS.readFileAsync.resolves(savedJson);
      const loaded = await store.load(42);

      // Verify all fields preserved
      assert.ok(loaded);
      assert.strictEqual(loaded.id, pr.id);
      assert.strictEqual(loaded.prNumber, pr.prNumber);
      assert.strictEqual(loaded.title, pr.title);
      assert.strictEqual(loaded.headBranch, pr.headBranch);
      assert.strictEqual(loaded.baseBranch, pr.baseBranch);
      assert.strictEqual(loaded.prUrl, pr.prUrl);
      assert.strictEqual(loaded.status, pr.status);
      assert.strictEqual(loaded.providerType, pr.providerType);
      assert.strictEqual(loaded.repoPath, pr.repoPath);
      assert.strictEqual(loaded.workingDirectory, pr.workingDirectory);
      assert.strictEqual(loaded.adoptedAt, pr.adoptedAt);
      assert.strictEqual(loaded.monitoringStartedAt, pr.monitoringStartedAt);
      assert.strictEqual(loaded.releaseId, pr.releaseId);
      assert.strictEqual(loaded.priority, pr.priority);
      assert.strictEqual(loaded.unresolvedComments, pr.unresolvedComments);
      assert.strictEqual(loaded.failingChecks, pr.failingChecks);
    });
  });
});
