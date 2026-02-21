/**
 * @fileoverview Tests for git merge operations (src/git/core/merge.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as merge from '../../../git/core/merge';
import * as executor from '../../../git/core/executor';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

suite('Git Merge', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;

  setup(() => {
    silenceConsole();
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // merge
  // =========================================================================

  suite('merge', () => {
    test('returns success on clean merge', async () => {
      execAsyncStub.resolves({
        success: true,
        stdout: 'Already up to date.\n',
        stderr: '',
        exitCode: 0,
      });

      const result = await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
    });

    test('returns conflict info on merge conflict', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'CONFLICT (content): Merge conflict in file.txt',
        exitCode: 1,
      });
      execAsyncOrNullStub.resolves('file.txt');

      const result = await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.ok(result.conflictFiles.includes('file.txt'));
    });

    test('uses --no-ff when fastForward is false', async () => {
      execAsyncStub.resolves({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
        fastForward: false,
      });

      const args = execAsyncStub.firstCall.args[0];
      assert.ok(args.includes('--no-ff'));
    });

    test('uses --squash when squash is true', async () => {
      // First call: merge --squash
      execAsyncStub.onFirstCall().resolves({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      // Second call: commit
      execAsyncStub.onSecondCall().resolves({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
        squash: true,
        message: 'squash commit',
      });

      assert.strictEqual(result.success, true);
      const args = execAsyncStub.firstCall.args[0];
      assert.ok(args.includes('--squash'));
    });

    test('passes custom message with -m flag', async () => {
      execAsyncStub.resolves({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
        message: 'custom merge message',
      });

      const args = execAsyncStub.firstCall.args[0];
      assert.ok(args.includes('-m'));
      assert.ok(args.includes('custom merge message'));
    });

    test('returns error for non-conflict failure', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'fatal: not something we can merge',
        exitCode: 128,
      });

      const result = await merge.merge({
        source: 'nonexistent',
        target: 'main',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.ok(result.error);
    });
  });

  // =========================================================================
  // listConflicts (hasConflicts / getConflictFiles equivalent)
  // =========================================================================

  suite('listConflicts', () => {
    test('returns empty array when no conflicts', async () => {
      execAsyncOrNullStub.resolves('');
      const result = await merge.listConflicts('/repo');
      assert.deepStrictEqual(result, []);
    });

    test('returns list of conflicting files', async () => {
      execAsyncOrNullStub.resolves('file1.txt\nfile2.txt');
      const result = await merge.listConflicts('/repo');
      assert.deepStrictEqual(result, ['file1.txt', 'file2.txt']);
    });

    test('returns empty array when command returns null', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await merge.listConflicts('/repo');
      assert.deepStrictEqual(result, []);
    });
  });

  // =========================================================================
  // abort
  // =========================================================================

  suite('abort', () => {
    test('calls git merge --abort', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      await merge.abort('/repo');
      const args = execAsyncStub.firstCall.args[0];
      assert.deepStrictEqual(args, ['merge', '--abort']);
    });
  });

  // =========================================================================
  // isInProgress
  // =========================================================================

  suite('isInProgress', () => {
    test('returns false when rev-parse fails', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'fatal',
        exitCode: 128,
      });
      const result = await merge.isInProgress('/repo');
      assert.strictEqual(result, false);
    });

    test('returns false when MERGE_HEAD file does not exist', async () => {
      execAsyncStub.resolves({
        success: true,
        stdout: 'MERGE_HEAD\n',
        stderr: '',
        exitCode: 0,
      });
      // MERGE_HEAD file won't exist at the test path
      const result = await merge.isInProgress('/nonexistent/repo/path/xyz');
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // mergeWithoutCheckout
  // =========================================================================

  suite('mergeWithoutCheckout', () => {
    test('returns success with tree SHA on clean merge', async () => {
      execAsyncStub.resolves({
        success: true,
        stdout: 'abc123def456\n',
        stderr: '',
        exitCode: 0,
      });

      const result = await merge.mergeWithoutCheckout({
        source: 'feature',
        target: 'main',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.treeSha, 'abc123def456');
      assert.strictEqual(result.hasConflicts, false);
    });

    test('returns conflicts when merge-tree reports CONFLICT', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: 'CONFLICT (content): Merge conflict in src/file.ts\n',
        stderr: '',
        exitCode: 1,
      });

      const result = await merge.mergeWithoutCheckout({
        source: 'feature',
        target: 'main',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.ok(result.conflictFiles.includes('src/file.ts'));
    });

    test('returns error when git merge-tree is not available', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'is not a git command',
        exitCode: 1,
      });

      const result = await merge.mergeWithoutCheckout({
        source: 'feature',
        target: 'main',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.ok(result.error?.includes('Git 2.38'));
    });
  });

  // =========================================================================
  // commitTree
  // =========================================================================

  suite('commitTree', () => {
    test('creates commit with correct parent args', async () => {
      execAsyncOrThrowStub.resolves('newcommitsha\n');

      const result = await merge.commitTree(
        'treeSha123',
        ['parent1', 'parent2'],
        'merge commit message',
        '/repo'
      );

      assert.strictEqual(result, 'newcommitsha');
      const args = execAsyncOrThrowStub.firstCall.args[0];
      assert.ok(args.includes('-p'));
      assert.ok(args.includes('parent1'));
      assert.ok(args.includes('parent2'));
      assert.ok(args.includes('-m'));
      assert.ok(args.includes('merge commit message'));
    });
  });

  // =========================================================================
  // resolveBySide
  // =========================================================================

  suite('resolveBySide', () => {
    test('resolves conflict using ours', async () => {
      execAsyncOrThrowStub.resolves('');
      await merge.resolveBySide('file.txt', 'ours', '/repo');
      assert.ok(execAsyncOrThrowStub.calledWith(['checkout', '--ours', '--', 'file.txt'], '/repo'));
      assert.ok(execAsyncOrThrowStub.calledWith(['add', 'file.txt'], '/repo'));
    });

    test('resolves conflict using theirs', async () => {
      execAsyncOrThrowStub.resolves('');
      await merge.resolveBySide('file.txt', 'theirs', '/repo');
      assert.ok(execAsyncOrThrowStub.calledWith(['checkout', '--theirs', '--', 'file.txt'], '/repo'));
    });
  });

  // =========================================================================
  // continueAfterResolve
  // =========================================================================

  suite('continueAfterResolve', () => {
    test('stages all and commits on success', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      const result = await merge.continueAfterResolve('/repo', 'resolve merge');
      assert.strictEqual(result, true);
      // First call should be 'add -A', second should be 'commit -m ...'
      assert.deepStrictEqual(execAsyncStub.firstCall.args[0], ['add', '-A']);
      assert.deepStrictEqual(execAsyncStub.secondCall.args[0], ['commit', '-m', 'resolve merge']);
    });

    test('returns false when commit fails', async () => {
      // add -A succeeds
      execAsyncStub.onFirstCall().resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      // commit fails
      execAsyncStub.onSecondCall().resolves({ success: false, stdout: '', stderr: 'nothing to commit', exitCode: 1 });
      const result = await merge.continueAfterResolve('/repo', 'resolve merge');
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // mergeWithoutCheckout - unknown option
  // =========================================================================

  suite('mergeWithoutCheckout edge cases', () => {
    test('returns error for unknown option in stderr', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'unknown option --write-tree',
        exitCode: 1,
      });
      const result = await merge.mergeWithoutCheckout({
        source: 'feature',
        target: 'main',
        repoPath: '/repo',
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Git 2.38'));
    });

    test('returns generic error for other failures', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'some other error',
        exitCode: 1,
      });
      const result = await merge.mergeWithoutCheckout({
        source: 'feature',
        target: 'main',
        repoPath: '/repo',
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  // =========================================================================
  // merge - squash with nothing to commit
  // =========================================================================

  suite('merge squash edge cases', () => {
    test('squash merge handles nothing to commit', async () => {
      // merge --squash succeeds
      execAsyncStub.onFirstCall().resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      // commit returns nothing to commit
      execAsyncStub.onSecondCall().resolves({ success: false, stdout: '', stderr: 'nothing to commit', exitCode: 1 });

      const result = await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
        squash: true,
      });

      assert.strictEqual(result.success, true);
    });

    test('merge uses --no-edit when no message and not squash', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      await merge.merge({
        source: 'feature',
        target: 'main',
        cwd: '/repo',
      });
      const args = execAsyncStub.firstCall.args[0];
      assert.ok(args.includes('--no-edit'));
    });
  });
});
