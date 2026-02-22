/**
 * @fileoverview Unit tests for git branch operations.
 *
 * Tests the branches module (src/git/core/branches.ts) by mocking
 * the underlying git command executor.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as branches from '../../../git/core/branches';
import * as executor from '../../../git/core/executor';
import type { CommandResult } from '../../../git/core/executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout = '', stderr = ''): CommandResult {
  return { success: true, stdout, stderr, exitCode: 0 };
}

function fail(stderr = '', stdout = '', exitCode = 1): CommandResult {
  return { success: false, stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Git Branch Operations', () => {
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
    branches.clearDefaultBranchCache();
  });

  // =========================================================================
  // exists()
  // =========================================================================

  suite('exists()', () => {
    test('returns true when branch exists', async () => {
      execAsyncStub.resolves(ok());

      const result = await branches.exists('feature/test', '/repo');

      assert.strictEqual(result, true);
      const [args, opts] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['show-ref', '--verify', '--quiet', 'refs/heads/feature/test']);
      assert.strictEqual(opts.cwd, '/repo');
    });

    test('returns false when branch does not exist', async () => {
      execAsyncStub.resolves(fail());

      const result = await branches.exists('nonexistent', '/repo');

      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // remoteExists()
  // =========================================================================

  suite('remoteExists()', () => {
    test('returns true when remote branch exists', async () => {
      execAsyncStub.resolves(ok());

      const result = await branches.remoteExists('main', '/repo');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']);
    });

    test('uses custom remote name', async () => {
      execAsyncStub.resolves(ok());

      await branches.remoteExists('main', '/repo', 'upstream');

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('refs/remotes/upstream/main'));
    });

    test('returns false when remote branch does not exist', async () => {
      execAsyncStub.resolves(fail());

      const result = await branches.remoteExists('nonexistent', '/repo');

      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // current()
  // =========================================================================

  suite('current()', () => {
    test('returns current branch name', async () => {
      execAsyncOrThrowStub.resolves('main');

      const result = await branches.current('/repo');

      assert.strictEqual(result, 'main');
      const [args, cwd] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '--show-current']);
      assert.strictEqual(cwd, '/repo');
    });

    test('throws on detached HEAD', async () => {
      execAsyncOrThrowStub.rejects(new Error('Git command failed'));

      await assert.rejects(() => branches.current('/repo'), /Git command failed/);
    });
  });

  // =========================================================================
  // currentOrNull()
  // =========================================================================

  suite('currentOrNull()', () => {
    test('returns branch name when on a branch', async () => {
      execAsyncOrNullStub.resolves('develop');

      const result = await branches.currentOrNull('/repo');

      assert.strictEqual(result, 'develop');
    });

    test('returns null on detached HEAD', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.currentOrNull('/repo');

      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // create()
  // =========================================================================

  suite('create()', () => {
    test('creates branch from another branch', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.create('feature/new', 'main', '/repo');

      const [args, cwd] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', 'feature/new', 'main']);
      assert.strictEqual(cwd, '/repo');
    });

    test('invokes logger when provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const messages: string[] = [];

      await branches.create('feature/logged', 'main', '/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Creating branch')));
      assert.ok(messages.some((m) => m.includes('Created branch')));
    });
  });

  // =========================================================================
  // createOrReset()
  // =========================================================================

  suite('createOrReset()', () => {
    test('succeeds with simple branch -f', async () => {
      execAsyncStub.resolves(ok());

      await branches.createOrReset('feature/x', 'main', '/repo');

      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '-f', 'feature/x', 'main']);
    });

    test('resets checked-out branch when clean', async () => {
      // First call: branch -f fails (checked out)
      execAsyncStub
        .onFirstCall().resolves(fail('checked out'))
        .onSecondCall().resolves(ok('', '')); // status --porcelain returns empty

      execAsyncOrThrowStub
        .onFirstCall().resolves('feature/x'); // current branch
      // The second call to execAsyncOrThrow is for reset --hard
      execAsyncOrThrowStub
        .onSecondCall().resolves('');

      // Stub current() which calls execAsyncOrThrow
      await branches.createOrReset('feature/x', 'abc123', '/repo');

      // Should have called reset --hard
      const [resetArgs] = execAsyncOrThrowStub.secondCall.args;
      assert.deepStrictEqual(resetArgs, ['reset', '--hard', 'abc123']);
    });

    test('throws when checked-out branch has uncommitted changes', async () => {
      execAsyncStub
        .onFirstCall().resolves(fail('checked out'))
        .onSecondCall().resolves(ok('M file.txt', '')); // porcelain has changes

      execAsyncOrThrowStub.resolves('feature/x'); // current branch

      await assert.rejects(
        () => branches.createOrReset('feature/x', 'abc123', '/repo'),
        /uncommitted changes/
      );
    });

    test('throws when branch is in another worktree', async () => {
      execAsyncStub
        .onFirstCall().resolves(fail('used by worktree'))
        .onSecondCall().resolves(ok('', '')); // status

      execAsyncOrThrowStub.resolves('main'); // current branch is different

      await assert.rejects(
        () => branches.createOrReset('feature/x', 'abc123', '/repo'),
        /another worktree/
      );
    });

    test('throws on other errors', async () => {
      execAsyncStub.resolves(fail('fatal: bad ref'));

      await assert.rejects(
        () => branches.createOrReset('feature/x', 'bad', '/repo'),
        /Git command failed/
      );
    });

    test('invokes logger', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await branches.createOrReset('feature/x', 'main', '/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Creating/resetting')));
      assert.ok(messages.some((m) => m.includes('set to')));
    });
  });

  // =========================================================================
  // remove()
  // =========================================================================

  suite('remove()', () => {
    test('deletes branch with -d by default', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.remove('feature/old', '/repo');

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '-d', 'feature/old']);
    });

    test('deletes branch with -D when forced', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.remove('feature/old', '/repo', { force: true });

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '-D', 'feature/old']);
    });

    test('invokes logger', async () => {
      execAsyncOrThrowStub.resolves('');
      const messages: string[] = [];

      await branches.remove('feature/old', '/repo', { log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('Deleting')));
      assert.ok(messages.some((m) => m.includes('Deleted')));
    });
  });

  // =========================================================================
  // deleteLocal()
  // =========================================================================

  suite('deleteLocal()', () => {
    test('returns true on successful deletion', async () => {
      execAsyncStub.resolves(ok());

      const result = await branches.deleteLocal('/repo', 'feature/done');

      assert.strictEqual(result, true);
      const [args, opts] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '-d', 'feature/done']);
      assert.strictEqual(opts.cwd, '/repo');
    });

    test('returns false on failure', async () => {
      execAsyncStub.resolves(fail('not fully merged'));

      const result = await branches.deleteLocal('/repo', 'feature/unmerged');

      assert.strictEqual(result, false);
    });

    test('uses -D when force is true', async () => {
      execAsyncStub.resolves(ok());

      await branches.deleteLocal('/repo', 'feature/forced', { force: true });

      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '-D', 'feature/forced']);
    });

    test('invokes logger on success', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await branches.deleteLocal('/repo', 'feature/x', { log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('Deleting')));
      assert.ok(messages.some((m) => m.includes('Deleted')));
    });
  });

  // =========================================================================
  // deleteRemote()
  // =========================================================================

  suite('deleteRemote()', () => {
    test('deletes remote branch', async () => {
      execAsyncStub.resolves(ok());

      const result = await branches.deleteRemote('/repo', 'feature/done');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['push', 'origin', '--delete', 'feature/done']);
    });

    test('uses custom remote', async () => {
      execAsyncStub.resolves(ok());

      await branches.deleteRemote('/repo', 'feature/done', { remote: 'upstream' });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('upstream'));
    });

    test('returns false on failure', async () => {
      execAsyncStub.resolves(fail());

      const result = await branches.deleteRemote('/repo', 'nonexistent');

      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // checkout()
  // =========================================================================

  suite('checkout()', () => {
    test('switches to branch via git switch', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.checkout('/repo', 'develop');

      const [args, cwd] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['switch', 'develop']);
      assert.strictEqual(cwd, '/repo');
    });

    test('invokes logger', async () => {
      execAsyncOrThrowStub.resolves('');
      const messages: string[] = [];

      await branches.checkout('/repo', 'develop', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Switching to')));
      assert.ok(messages.some((m) => m.includes('Switched to')));
    });

    test('throws if switch fails', async () => {
      execAsyncOrThrowStub.rejects(new Error('error: pathspec'));

      await assert.rejects(() => branches.checkout('/repo', 'nonexistent'), /pathspec/);
    });
  });

  // =========================================================================
  // list()
  // =========================================================================

  suite('list()', () => {
    test('returns list of branch names', async () => {
      execAsyncOrNullStub.resolves('main\ndevelop\nfeature/x');

      const result = await branches.list('/repo');

      assert.deepStrictEqual(result, ['main', 'develop', 'feature/x']);
      const [args, cwd] = execAsyncOrNullStub.firstCall.args;
      assert.deepStrictEqual(args, ['branch', '--format=%(refname:short)']);
      assert.strictEqual(cwd, '/repo');
    });

    test('returns empty array when command fails', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.list('/repo');

      assert.deepStrictEqual(result, []);
    });

    test('filters blank lines', async () => {
      execAsyncOrNullStub.resolves('main\n\ndevelop\n');

      const result = await branches.list('/repo');

      assert.deepStrictEqual(result, ['main', 'develop']);
    });
  });

  // =========================================================================
  // getCommit()
  // =========================================================================

  suite('getCommit()', () => {
    test('returns commit SHA', async () => {
      execAsyncOrNullStub.resolves('abc123def456');

      const result = await branches.getCommit('main', '/repo');

      assert.strictEqual(result, 'abc123def456');
      const [args, cwd] = execAsyncOrNullStub.firstCall.args;
      assert.deepStrictEqual(args, ['rev-parse', 'main']);
      assert.strictEqual(cwd, '/repo');
    });

    test('returns null when branch not found', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.getCommit('nonexistent', '/repo');

      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // getMergeBase()
  // =========================================================================

  suite('getMergeBase()', () => {
    test('returns merge base SHA', async () => {
      execAsyncOrNullStub.resolves('deadbeef');

      const result = await branches.getMergeBase('main', 'feature/x', '/repo');

      assert.strictEqual(result, 'deadbeef');
      const [args, cwd] = execAsyncOrNullStub.firstCall.args;
      assert.deepStrictEqual(args, ['merge-base', 'main', 'feature/x']);
      assert.strictEqual(cwd, '/repo');
    });

    test('returns null when no common ancestor', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.getMergeBase('a', 'b', '/repo');

      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // isDefaultBranch()
  // =========================================================================

  suite('isDefaultBranch()', () => {
    test('returns true for origin/HEAD default branch', async () => {
      execAsyncOrNullStub
        .onFirstCall().resolves('refs/remotes/origin/main'); // symbolic-ref
      
      const result = await branches.isDefaultBranch('main', '/repo-default1');

      assert.strictEqual(result, true);
    });

    test('returns true for configured init.defaultBranch', async () => {
      execAsyncOrNullStub
        .onFirstCall().resolves(null) // symbolic-ref fails
        .onSecondCall().resolves('develop'); // config --get init.defaultBranch

      const result = await branches.isDefaultBranch('develop', '/repo-default2');

      assert.strictEqual(result, true);
    });

    test('returns true for common names (main/master) as fallback', async () => {
      execAsyncOrNullStub.resolves(null); // both lookups fail

      assert.strictEqual(await branches.isDefaultBranch('main', '/repo2'), true);
    });

    test('strips refs/heads/ prefix', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.isDefaultBranch('refs/heads/master', '/repo3');

      assert.strictEqual(result, true);
    });

    test('returns false for non-default branch', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.isDefaultBranch('feature/xyz', '/repo4');

      assert.strictEqual(result, false);
    });
  });
});
