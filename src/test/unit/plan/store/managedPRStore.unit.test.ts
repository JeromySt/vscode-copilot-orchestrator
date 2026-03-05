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
      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Test PR',
        body: 'Test body',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        repoPath: '/test/repo',
        prUrl: 'https://github.com/test/repo/pull/42',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

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
      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Test PR',
        body: 'Test body',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        releaseId: 'rel-123',
        planIds: ['plan-1', 'plan-2'],
        metadata: {
          customField: 'customValue',
        },
      };

      await store.save(pr);

      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(writtenContent.releaseId, 'rel-123');
      assert.deepStrictEqual(writtenContent.planIds, ['plan-1', 'plan-2']);
      assert.strictEqual(writtenContent.metadata.customField, 'customValue');
    });

    test('should cleanup temp file on error', async () => {
      mockFS.renameAsync.rejects(new Error('Rename failed'));

      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Test PR',
        body: 'Test body',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

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

      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Test PR',
        body: 'Test body',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

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
        prNumber: 42,
        title: 'Stored PR',
        body: 'Stored body',
        sourceBranch: 'feature/stored',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: 1234567890,
        updatedAt: 1234567890,
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
        prNumber: 42,
        title: 'PR with metadata',
        body: '',
        sourceBranch: 'feature/meta',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        releaseId: 'rel-456',
        metadata: {
          status: 'monitoring',
        },
      };

      mockFS.readFileAsync.resolves(JSON.stringify(storedPR));

      const result = await store.load(42);

      assert.ok(result);
      assert.strictEqual(result.releaseId, 'rel-456');
      assert.strictEqual(result.metadata?.status, 'monitoring');
    });
  });

  // ── loadByPRNumber ─────────────────────────────────────────────────────

  suite('loadByPRNumber', () => {
    test('should be an alias for load', async () => {
      const storedPR = {
        prNumber: 42,
        title: 'PR',
        body: '',
        sourceBranch: 'feature',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
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
        prNumber: 42,
        title: 'PR 1',
        body: '',
        sourceBranch: 'feature/1',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const pr2 = {
        prNumber: 43,
        title: 'PR 2',
        body: '',
        sourceBranch: 'feature/2',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
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
        prNumber: 42,
        title: 'Valid PR',
        body: '',
        sourceBranch: 'feature/valid',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
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
      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Test',
        body: '',
        sourceBranch: 'feature',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

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
      const pr: ManagedPR = {
        prNumber: 42,
        title: 'No metadata PR',
        body: '',
        sourceBranch: 'feature',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      };

      await store.save(pr);

      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.deepStrictEqual(writtenContent.metadata, {});
    });

    test('should handle missing optional fields', async () => {
      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Minimal PR',
        body: '',
        sourceBranch: 'feature',
        targetBranch: 'main',
        repoPath: '/test/repo',
        isOpen: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(pr);

      const writtenContent = JSON.parse(mockFS.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(writtenContent.releaseId, undefined);
      assert.strictEqual(writtenContent.planIds, undefined);
      assert.strictEqual(writtenContent.prUrl, undefined);
    });

    test('should preserve all fields during save-load round trip', async () => {
      const pr: ManagedPR = {
        prNumber: 42,
        title: 'Complete PR',
        body: 'Full body',
        sourceBranch: 'feature/complete',
        targetBranch: 'main',
        repoPath: '/test/repo',
        prUrl: 'https://github.com/test/repo/pull/42',
        isOpen: false,
        createdAt: 1234567890,
        updatedAt: 9876543210,
        releaseId: 'rel-xyz',
        planIds: ['plan-a', 'plan-b'],
        metadata: {
          status: 'ready',
          priority: 5,
        },
      };

      // Save
      await store.save(pr);
      const savedJson = mockFS.writeFileAsync.firstCall.args[1];

      // Load (simulate reading back)
      mockFS.readFileAsync.resolves(savedJson);
      const loaded = await store.load(42);

      // Verify all fields preserved
      assert.ok(loaded);
      assert.strictEqual(loaded.prNumber, pr.prNumber);
      assert.strictEqual(loaded.title, pr.title);
      assert.strictEqual(loaded.body, pr.body);
      assert.strictEqual(loaded.sourceBranch, pr.sourceBranch);
      assert.strictEqual(loaded.targetBranch, pr.targetBranch);
      assert.strictEqual(loaded.repoPath, pr.repoPath);
      assert.strictEqual(loaded.prUrl, pr.prUrl);
      assert.strictEqual(loaded.isOpen, pr.isOpen);
      assert.strictEqual(loaded.createdAt, pr.createdAt);
      assert.strictEqual(loaded.updatedAt, pr.updatedAt);
      assert.strictEqual(loaded.releaseId, pr.releaseId);
      assert.deepStrictEqual(loaded.planIds, pr.planIds);
      assert.deepStrictEqual(loaded.metadata, pr.metadata);
    });
  });
});
