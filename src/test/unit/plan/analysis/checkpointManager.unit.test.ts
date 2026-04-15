/**
 * @fileoverview Unit tests for DefaultCheckpointManager.
 */

import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import * as path from 'path';
import { DefaultCheckpointManager } from '../../../../plan/analysis/checkpointManager';
import type { ContextPressureState, CheckpointManifest } from '../../../../interfaces/ICheckpointManager';

suite('DefaultCheckpointManager', () => {
  let sandbox: sinon.SinonSandbox;
  let mockFs: any;
  let mgr: DefaultCheckpointManager;
  const worktree = '/repo/worktrees/abc';
  const sentinelPath = path.join(worktree, '.orchestrator', 'CHECKPOINT_REQUIRED');
  const manifestPath = path.join(worktree, '.orchestrator', 'checkpoint-manifest.json');

  const pressureState: ContextPressureState = {
    level: 'critical',
    currentInputTokens: 180_000,
    maxPromptTokens: 200_000,
    pressure: 0.9,
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockFs = {
      ensureDirAsync: sandbox.stub().resolves(),
      writeFileAsync: sandbox.stub().resolves(),
      existsAsync: sandbox.stub().resolves(false),
      readFileAsync: sandbox.stub().resolves(''),
      unlinkAsync: sandbox.stub().resolves(),
    };
    mgr = new DefaultCheckpointManager(mockFs);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('writeSentinel', () => {
    test('ensures orchestrator dir and writes JSON to sentinel path', async () => {
      await mgr.writeSentinel(worktree, pressureState);

      assert.ok(mockFs.ensureDirAsync.calledOnce);
      assert.strictEqual(
        mockFs.ensureDirAsync.firstCall.args[0],
        path.join(worktree, '.orchestrator'),
      );
      assert.ok(mockFs.writeFileAsync.calledOnce);
      assert.strictEqual(mockFs.writeFileAsync.firstCall.args[0], sentinelPath);

      const written = JSON.parse(mockFs.writeFileAsync.firstCall.args[1]);
      assert.strictEqual(written.reason, 'context_pressure');
      assert.strictEqual(written.currentTokens, 180_000);
      assert.strictEqual(written.maxTokens, 200_000);
      assert.strictEqual(written.pressure, 0.9);
      assert.ok(typeof written.timestamp === 'string');
    });
  });

  suite('manifestExists', () => {
    test('returns true when manifest file exists', async () => {
      mockFs.existsAsync.resolves(true);
      const result = await mgr.manifestExists(worktree);
      assert.strictEqual(result, true);
      assert.strictEqual(mockFs.existsAsync.firstCall.args[0], manifestPath);
    });

    test('returns false when manifest file does not exist', async () => {
      mockFs.existsAsync.resolves(false);
      const result = await mgr.manifestExists(worktree);
      assert.strictEqual(result, false);
    });
  });

  suite('readManifest', () => {
    const validManifest: CheckpointManifest = {
      status: 'checkpointed',
      completed: [{ file: 'a.ts', summary: 'done' }],
      remaining: [{ file: 'b.ts', description: 'todo' }],
      summary: 'halfway there',
    };

    test('parses valid JSON and returns CheckpointManifest', async () => {
      mockFs.existsAsync.resolves(true);
      mockFs.readFileAsync.resolves(JSON.stringify(validManifest));
      const result = await mgr.readManifest(worktree);
      assert.deepStrictEqual(result, validManifest);
    });

    test('returns undefined when file does not exist', async () => {
      mockFs.existsAsync.resolves(false);
      const result = await mgr.readManifest(worktree);
      assert.strictEqual(result, undefined);
      assert.ok(mockFs.readFileAsync.notCalled);
    });

    test('returns undefined and logs warning on invalid JSON', async () => {
      mockFs.existsAsync.resolves(true);
      mockFs.readFileAsync.resolves('not-json{{');
      const result = await mgr.readManifest(worktree);
      assert.strictEqual(result, undefined);
    });
  });

  suite('cleanupSentinel', () => {
    test('calls unlinkAsync on sentinel path', async () => {
      await mgr.cleanupSentinel(worktree);
      assert.ok(mockFs.unlinkAsync.calledOnce);
      assert.strictEqual(mockFs.unlinkAsync.firstCall.args[0], sentinelPath);
    });

    test('does not throw when file does not exist', async () => {
      mockFs.unlinkAsync.rejects(new Error('ENOENT'));
      await assert.doesNotReject(() => mgr.cleanupSentinel(worktree));
    });
  });

  suite('cleanupManifest', () => {
    test('calls unlinkAsync on manifest path', async () => {
      await mgr.cleanupManifest(worktree);
      assert.ok(mockFs.unlinkAsync.calledOnce);
      assert.strictEqual(mockFs.unlinkAsync.firstCall.args[0], manifestPath);
    });

    test('does not throw when file does not exist', async () => {
      mockFs.unlinkAsync.rejects(new Error('ENOENT'));
      await assert.doesNotReject(() => mgr.cleanupManifest(worktree));
    });
  });

  suite('path construction', () => {
    test('sentinel lives at <worktreePath>/.orchestrator/CHECKPOINT_REQUIRED', async () => {
      await mgr.writeSentinel(worktree, pressureState);
      const writtenPath = mockFs.writeFileAsync.firstCall.args[0];
      assert.ok(writtenPath.endsWith(path.join('.orchestrator', 'CHECKPOINT_REQUIRED')));
    });

    test('manifest lives at <worktreePath>/.orchestrator/checkpoint-manifest.json', async () => {
      mockFs.existsAsync.resolves(true);
      mockFs.readFileAsync.resolves('{}');
      await mgr.readManifest(worktree);
      const checkedPath = mockFs.existsAsync.firstCall.args[0];
      assert.ok(checkedPath.endsWith(path.join('.orchestrator', 'checkpoint-manifest.json')));
    });
  });
});
