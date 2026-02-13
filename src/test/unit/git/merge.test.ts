/**
 * @fileoverview Unit tests for git merge operations.
 *
 * Tests the merge module (src/git/core/merge.ts) by mocking
 * the underlying git command executor.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as merge from '../../../git/core/merge';
import * as executor from '../../../git/core/executor';
import type { CommandResult } from '../../../git/core/executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a successful CommandResult. */
function ok(stdout = '', stderr = ''): CommandResult {
  return { success: true, stdout, stderr, exitCode: 0 };
}

/** Build a failed CommandResult. */
function fail(stderr = '', stdout = '', exitCode = 1): CommandResult {
  return { success: false, stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Git Merge Operations', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;

  setup(() => {
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // merge()
  // =========================================================================

  suite('merge()', () => {

    test('fast-forward merge succeeds', async () => {
      execAsyncStub.resolves(ok('Already up to date.\n'));

      const result = await merge.merge({
        source: 'feature/login',
        target: 'main',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);

      // Should call git merge with --no-edit and source
      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('merge'), 'should call merge');
      assert.ok(args.includes('--no-edit'), 'default merge uses --no-edit');
      assert.ok(args.includes('feature/login'), 'should include source branch');
    });

    test('merge with --no-ff flag', async () => {
      execAsyncStub.resolves(ok());

      await merge.merge({
        source: 'feature/x',
        target: 'main',
        cwd: '/repo',
        fastForward: false,
      });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('--no-ff'), 'should include --no-ff flag');
    });

    test('merge with custom commit message', async () => {
      execAsyncStub.resolves(ok());

      await merge.merge({
        source: 'feature/y',
        target: 'main',
        cwd: '/repo',
        message: 'Merge feature/y into main',
      });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('-m'), 'should include -m flag');
      assert.ok(
        args.includes('Merge feature/y into main'),
        'should include commit message',
      );
      assert.ok(!args.includes('--no-edit'), 'should not include --no-edit when message provided');
    });

    test('squash merge commits separately', async () => {
      // First call: git merge --squash <source> => success
      // Second call: git commit -m <msg> => success
      execAsyncStub
        .onFirstCall().resolves(ok())
        .onSecondCall().resolves(ok());

      const result = await merge.merge({
        source: 'feature/z',
        target: 'main',
        cwd: '/repo',
        squash: true,
        message: 'squashed',
      });

      assert.strictEqual(result.success, true);

      // First call should be merge --squash
      const [mergeArgs] = execAsyncStub.firstCall.args;
      assert.ok(mergeArgs.includes('--squash'), 'should include --squash');
      assert.ok(!mergeArgs.includes('-m'), 'squash merge should not include -m');

      // Second call should be commit -m
      const [commitArgs] = execAsyncStub.secondCall.args;
      assert.ok(commitArgs.includes('commit'), 'should commit after squash');
      assert.ok(commitArgs.includes('squashed'), 'should use provided message');
    });

    test('squash merge uses default message when none provided', async () => {
      execAsyncStub
        .onFirstCall().resolves(ok())
        .onSecondCall().resolves(ok());

      await merge.merge({
        source: 'feature/abc',
        target: 'main',
        cwd: '/repo',
        squash: true,
      });

      const [commitArgs] = execAsyncStub.secondCall.args;
      assert.ok(
        commitArgs.includes("Merge branch 'feature/abc'"),
        'should use default merge message',
      );
    });

    test('detects merge conflicts', async () => {
      execAsyncStub
        .onFirstCall().resolves(
          fail('CONFLICT (content): Merge conflict in file.txt', ''),
        );

      // listConflicts uses execAsyncOrNull
      execAsyncOrNullStub.resolves('file.txt\nother.ts');

      const result = await merge.merge({
        source: 'feature/conflict',
        target: 'main',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.deepStrictEqual(result.conflictFiles, ['file.txt', 'other.ts']);
      assert.strictEqual(result.error, 'Merge conflicts detected');
    });

    test('reports non-conflict failure', async () => {
      execAsyncStub.resolves(fail('fatal: not a git repository'));

      const result = await merge.merge({
        source: 'feature/bad',
        target: 'main',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.strictEqual(result.error, 'fatal: not a git repository');
    });

    test('invokes logger when provided', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await merge.merge({
        source: 'feature/logged',
        target: 'main',
        cwd: '/repo',
        log: (msg) => messages.push(msg),
      });

      assert.ok(messages.length > 0, 'logger should have been called');
      assert.ok(
        messages.some((m) => m.includes('Merging')),
        'should log merge start',
      );
    });

    test('passes cwd to executor', async () => {
      execAsyncStub.resolves(ok());

      await merge.merge({
        source: 'feature/cwd',
        target: 'main',
        cwd: '/my/custom/path',
      });

      const [, opts] = execAsyncStub.firstCall.args;
      assert.strictEqual(opts.cwd, '/my/custom/path');
    });
  });

  // =========================================================================
  // mergeWithoutCheckout()
  // =========================================================================

  suite('mergeWithoutCheckout()', () => {

    test('successful merge returns tree SHA', async () => {
      execAsyncStub.resolves(ok('abc123def456\n'));

      const result = await merge.mergeWithoutCheckout({
        source: 'feature/a',
        target: 'main',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.treeSha, 'abc123def456');
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
    });

    test.skip('detects conflicts from merge-tree output', async () => {
      const conflictOutput = [
        'abc123',
        'CONFLICT (content): Merge conflict in src/app.ts',
        'CONFLICT (content): Merge conflict in README.md',
      ].join('\n');

      execAsyncStub.resolves(fail('', conflictOutput));

      const result = await merge.mergeWithoutCheckout({
        source: 'feature/b',
        target: 'main',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.deepStrictEqual(result.conflictFiles, ['src/app.ts', 'README.md']);
      assert.strictEqual(result.error, 'Merge conflicts detected');
    });

    test('handles old git version (merge-tree not available)', async () => {
      execAsyncStub.resolves(
        fail('git merge-tree is not a git command'),
      );

      const result = await merge.mergeWithoutCheckout({
        source: 'feature/c',
        target: 'main',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.ok(result.error?.includes('Git 2.38'));
    });

    test('handles unknown option error for old git', async () => {
      execAsyncStub.resolves(fail('unknown option `write-tree'));

      const result = await merge.mergeWithoutCheckout({
        source: 'a',
        target: 'b',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Git 2.38'));
    });

    test('returns generic error for other failures', async () => {
      execAsyncStub.resolves(fail('something unexpected'));

      const result = await merge.mergeWithoutCheckout({
        source: 'x',
        target: 'y',
        repoPath: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.strictEqual(result.error, 'something unexpected');
    });

    test('constructs correct merge-tree command', async () => {
      execAsyncStub.resolves(ok('sha\n'));

      await merge.mergeWithoutCheckout({
        source: 'src-branch',
        target: 'tgt-branch',
        repoPath: '/repo',
      });

      const [args, opts] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['merge-tree', '--write-tree', 'tgt-branch', 'src-branch']);
      assert.strictEqual(opts.cwd, '/repo');
    });
  });

  // =========================================================================
  // commitTree()
  // =========================================================================

  suite('commitTree()', () => {

    test('creates commit with correct parent args', async () => {
      execAsyncOrThrowStub.resolves('newcommitsha\n');

      const sha = await merge.commitTree(
        'treeSha123',
        ['parentA', 'parentB'],
        'merge commit msg',
        '/repo',
      );

      assert.strictEqual(sha, 'newcommitsha');

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, [
        'commit-tree', 'treeSha123',
        '-p', 'parentA',
        '-p', 'parentB',
        '-m', 'merge commit msg',
      ]);
    });

    test('works with a single parent', async () => {
      execAsyncOrThrowStub.resolves('abc\n');

      await merge.commitTree('tree', ['singleParent'], 'msg', '/repo');

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.ok(args.filter((a: string) => a === '-p').length === 1);
    });
  });

  // =========================================================================
  // abort()
  // =========================================================================

  suite('abort()', () => {

    test('calls git merge --abort', async () => {
      execAsyncStub.resolves(ok());

      await merge.abort('/repo');

      const [args, opts] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['merge', '--abort']);
      assert.strictEqual(opts.cwd, '/repo');
    });

    test('invokes logger', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await merge.abort('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Aborting')));
    });
  });

  // =========================================================================
  // listConflicts()
  // =========================================================================

  suite('listConflicts()', () => {

    test('returns conflicting file names', async () => {
      execAsyncOrNullStub.resolves('a.ts\nb.ts\nc.ts');

      const files = await merge.listConflicts('/repo');

      assert.deepStrictEqual(files, ['a.ts', 'b.ts', 'c.ts']);
    });

    test('returns empty array on null result', async () => {
      execAsyncOrNullStub.resolves(null);

      const files = await merge.listConflicts('/repo');

      assert.deepStrictEqual(files, []);
    });

    test('filters blank lines', async () => {
      execAsyncOrNullStub.resolves('x.ts\n\ny.ts\n');

      const files = await merge.listConflicts('/repo');

      assert.deepStrictEqual(files, ['x.ts', 'y.ts']);
    });
  });

  // =========================================================================
  // isInProgress()
  // =========================================================================

  suite('isInProgress()', () => {

    test('returns false when rev-parse fails', async () => {
      execAsyncStub.resolves(fail(''));

      const inProgress = await merge.isInProgress('/repo');

      assert.strictEqual(inProgress, false);
    });

    // Note: testing the true path requires fs.promises.access which
    // would need an fs stub. We verify the false-path logic here.
    test('returns false when MERGE_HEAD file does not exist', async () => {
      execAsyncStub.resolves(ok('.git/MERGE_HEAD\n'));

      const inProgress = await merge.isInProgress('/repo');

      // MERGE_HEAD file won't exist in unit-test context
      assert.strictEqual(inProgress, false);
    });
  });

  // =========================================================================
  // resolveBySide()
  // =========================================================================

  suite('resolveBySide()', () => {

    test('resolves using "ours"', async () => {
      execAsyncOrThrowStub.resolves('');

      await merge.resolveBySide('conflict.ts', 'ours', '/repo');

      const [checkoutArgs] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(checkoutArgs, ['checkout', '--ours', '--', 'conflict.ts']);

      const [addArgs] = execAsyncOrThrowStub.secondCall.args;
      assert.deepStrictEqual(addArgs, ['add', 'conflict.ts']);
    });

    test('resolves using "theirs"', async () => {
      execAsyncOrThrowStub.resolves('');

      await merge.resolveBySide('other.ts', 'theirs', '/repo');

      const [checkoutArgs] = execAsyncOrThrowStub.firstCall.args;
      assert.ok(checkoutArgs.includes('--theirs'));
    });

    test('invokes logger', async () => {
      execAsyncOrThrowStub.resolves('');
      const messages: string[] = [];

      await merge.resolveBySide('f.ts', 'ours', '/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Resolving')));
      assert.ok(messages.some((m) => m.includes('Resolved')));
    });
  });

  // =========================================================================
  // continueAfterResolve()
  // =========================================================================

  suite('continueAfterResolve()', () => {

    test('stages all and commits', async () => {
      execAsyncStub
        .onFirstCall().resolves(ok())   // git add -A
        .onSecondCall().resolves(ok());  // git commit -m ...

      const ok_ = await merge.continueAfterResolve('/repo', 'Resolved merge');

      assert.strictEqual(ok_, true);

      const [addArgs] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(addArgs, ['add', '-A']);

      const [commitArgs] = execAsyncStub.secondCall.args;
      assert.ok(commitArgs.includes('commit'));
      assert.ok(commitArgs.includes('Resolved merge'));
    });

    test('returns false when commit fails', async () => {
      execAsyncStub
        .onFirstCall().resolves(ok())
        .onSecondCall().resolves(fail('commit failed'));

      const ok_ = await merge.continueAfterResolve('/repo', 'msg');

      assert.strictEqual(ok_, false);
    });

    test('invokes logger on success', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await merge.continueAfterResolve('/repo', 'msg', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('committed') || m.includes('Committing')));
    });
  });

  // =========================================================================
  // Merge strategy edge-cases
  // =========================================================================

  suite('merge strategy edge-cases', () => {

    test('squash merge tolerates "nothing to commit"', async () => {
      execAsyncStub
        .onFirstCall().resolves(ok())  // merge --squash
        .onSecondCall().resolves(
          fail('nothing to commit, working tree clean', '', 1),
        );

      const result = await merge.merge({
        source: 'feature/empty',
        target: 'main',
        cwd: '/repo',
        squash: true,
      });

      // Should still report success because the squash itself succeeded
      assert.strictEqual(result.success, true);
    });

    test('squash flag prevents --no-ff', async () => {
      execAsyncStub.resolves(ok());

      await merge.merge({
        source: 'f',
        target: 't',
        cwd: '/repo',
        squash: true,
        fastForward: false, // should be ignored when squash is set
      });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('--squash'));
      assert.ok(!args.includes('--no-ff'), '--no-ff should not appear with --squash');
    });

    test('conflict detection checks stdout too', async () => {
      execAsyncStub.resolves(
        fail('', 'Auto-merging a.txt\nCONFLICT (content): ...', 1),
      );
      execAsyncOrNullStub.resolves('a.txt');

      const result = await merge.merge({
        source: 'x',
        target: 'y',
        cwd: '/repo',
      });

      assert.strictEqual(result.hasConflicts, true);
    });

    test('empty stderr falls back to generic error message', async () => {
      execAsyncStub.resolves(fail(''));

      const result = await merge.merge({
        source: 'a',
        target: 'b',
        cwd: '/repo',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Merge failed');
    });
  });
});
