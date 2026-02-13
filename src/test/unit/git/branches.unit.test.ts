import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as branches from '../../../git/core/branches';
import * as executor from '../../../git/core/executor';

/**
 * Comprehensive unit tests for git branches module.
 * Tests all functions with mocked executor for 95%+ code coverage.
 */

suite('Git Core Branches Unit Tests', () => {
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
    // Cache is private, so use different repo paths in tests to avoid conflicts
  });

  // Helper to create mock command results
  function mockSuccess(stdout: string = '') {
    return { success: true, stdout, stderr: '', exitCode: 0 };
  }

  function mockFailure(stderr: string = 'command failed') {
    return { success: false, stdout: '', stderr, exitCode: 1 };
  }

  suite('isDefaultBranch()', () => {
    test('should return true when branch matches origin/HEAD', async () => {
      execAsyncOrNullStub.onFirstCall().resolves('refs/remotes/origin/main');

      const result = await branches.isDefaultBranch('main', '/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncOrNullStub.calledWith(['symbolic-ref', 'refs/remotes/origin/HEAD'], '/test/repo'));
    });

    test('should handle refs/heads/ prefix correctly', async () => {
      execAsyncOrNullStub.onFirstCall().resolves('refs/remotes/origin/develop');

      const result = await branches.isDefaultBranch('refs/heads/develop', '/test/repo2');

      assert.strictEqual(result, true);
    });

    test('should fall back to git config when no origin/HEAD', async () => {
      execAsyncOrNullStub.onFirstCall().resolves(null); // no origin/HEAD
      execAsyncOrNullStub.onSecondCall().resolves('main'); // config value

      const result = await branches.isDefaultBranch('main', '/test/repo3');

      assert.strictEqual(result, true);
      assert.ok(execAsyncOrNullStub.calledWith(['config', '--get', 'init.defaultBranch'], '/test/repo3'));
    });

    test('should fall back to main when no config found', async () => {
      execAsyncOrNullStub.onFirstCall().resolves(null); // no origin/HEAD
      execAsyncOrNullStub.onSecondCall().resolves(null); // no config

      const result = await branches.isDefaultBranch('main', '/test/repo');

      assert.strictEqual(result, true);
    });

    test('should fall back to master when no config found', async () => {
      execAsyncOrNullStub.onFirstCall().resolves(null); // no origin/HEAD
      execAsyncOrNullStub.onSecondCall().resolves(null); // no config

      const result = await branches.isDefaultBranch('master', '/test/repo');

      assert.strictEqual(result, true);
    });

    test('should return false for non-default branch', async () => {
      execAsyncOrNullStub.onFirstCall().resolves('refs/remotes/origin/main');

      const result = await branches.isDefaultBranch('feature-branch', '/test/repo');

      assert.strictEqual(result, false);
    });

    test('should cache default branch for subsequent calls', async () => {
      execAsyncOrNullStub.onFirstCall().resolves('refs/remotes/origin/develop');

      // First call should hit the remote  
      const result1 = await branches.isDefaultBranch('develop', '/test/repo4');
      assert.strictEqual(result1, true);

      // Second call should use cache (same repo)
      const result2 = await branches.isDefaultBranch('develop', '/test/repo4');
      assert.strictEqual(result2, true);

      // Should only have called execAsyncOrNull once (cached)
      assert.strictEqual(execAsyncOrNullStub.callCount, 1);
    });

    test('should handle different repos separately in cache', async () => {
      execAsyncOrNullStub.onFirstCall().resolves('refs/remotes/origin/main');
      execAsyncOrNullStub.onSecondCall().resolves('refs/remotes/origin/develop');

      await branches.isDefaultBranch('main', '/repo1');
      await branches.isDefaultBranch('develop', '/repo2');

      assert.strictEqual(execAsyncOrNullStub.callCount, 2);
    });

    test('should cache null when no default branch found', async () => {
      execAsyncOrNullStub.onFirstCall().resolves(null); // no origin/HEAD
      execAsyncOrNullStub.onSecondCall().resolves(null); // no config

      const result1 = await branches.isDefaultBranch('feature', '/test/repo6');
      const result2 = await branches.isDefaultBranch('feature', '/test/repo6');

      assert.strictEqual(result1, false);
      assert.strictEqual(result2, false);
      assert.strictEqual(execAsyncOrNullStub.callCount, 2); // Both calls made, then cached
    });
  });

  suite('exists()', () => {
    test('should return true when branch exists', async () => {
      execAsyncStub.resolves(mockSuccess());

      const result = await branches.exists('main', '/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: '/test/repo' }));
    });

    test('should return false when branch does not exist', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await branches.exists('nonexistent', '/test/repo');

      assert.strictEqual(result, false);
    });
  });

  suite('remoteExists()', () => {
    test('should return true when remote branch exists', async () => {
      execAsyncStub.resolves(mockSuccess());

      const result = await branches.remoteExists('main', '/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: '/test/repo' }));
    });

    test('should return false when remote branch does not exist', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await branches.remoteExists('nonexistent', '/test/repo');

      assert.strictEqual(result, false);
    });

    test('should use custom remote', async () => {
      execAsyncStub.resolves(mockSuccess());

      await branches.remoteExists('main', '/test/repo', 'upstream');

      assert.ok(execAsyncStub.calledWith(['show-ref', '--verify', '--quiet', 'refs/remotes/upstream/main'], { cwd: '/test/repo' }));
    });
  });

  suite('current()', () => {
    test('should return current branch name', async () => {
      execAsyncOrThrowStub.resolves('feature-branch');

      const result = await branches.current('/test/repo');

      assert.strictEqual(result, 'feature-branch');
      assert.ok(execAsyncOrThrowStub.calledWith(['branch', '--show-current'], '/test/repo'));
    });

    test('should throw on error', async () => {
      execAsyncOrThrowStub.rejects(new Error('Git error'));

      await assert.rejects(
        () => branches.current('/test/repo'),
        /Git error/
      );
    });
  });

  suite('currentOrNull()', () => {
    test('should return current branch name', async () => {
      execAsyncOrNullStub.resolves('main');

      const result = await branches.currentOrNull('/test/repo');

      assert.strictEqual(result, 'main');
      assert.ok(execAsyncOrNullStub.calledWith(['branch', '--show-current'], '/test/repo'));
    });

    test('should return null on detached HEAD', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.currentOrNull('/test/repo');

      assert.strictEqual(result, null);
    });
  });

  suite('create()', () => {
    test('should create branch from another branch', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.create('new-branch', 'main', '/test/repo');

      assert.ok(execAsyncOrThrowStub.calledWith(['branch', 'new-branch', 'main'], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.create('feature', 'develop', '/test/repo', log);

      assert.ok(logMessages.some(m => m.includes("Creating branch 'feature' from 'develop'")));
      assert.ok(logMessages.some(m => m.includes("✓ Created branch 'feature'")));
    });

    test('should throw on creation error', async () => {
      execAsyncOrThrowStub.rejects(new Error('Branch already exists'));

      await assert.rejects(
        () => branches.create('existing', 'main', '/test/repo'),
        /Branch already exists/
      );
    });
  });

  suite('createOrReset()', () => {
    test('should create/reset branch when not checked out', async () => {
      execAsyncStub.resolves(mockSuccess());

      await branches.createOrReset('feature', 'main', '/test/repo');

      assert.ok(execAsyncStub.calledWith(['branch', '-f', 'feature', 'main'], { cwd: '/test/repo' }));
    });

    test('should log success when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.createOrReset('feature', 'main', '/test/repo', log);

      assert.ok(logMessages.some(m => m.includes("Creating/resetting branch 'feature' to 'main'")));
      assert.ok(logMessages.some(m => m.includes("✓ Branch 'feature' set to 'main'")));
    });

    test('should reset checked out branch with clean working directory', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('error: branch checked out'));
      execAsyncOrThrowStub.onFirstCall().resolves('feature'); // current branch
      execAsyncStub.onSecondCall().resolves(mockSuccess('')); // status --porcelain (clean)
      execAsyncOrThrowStub.onSecondCall().resolves(''); // reset --hard

      await branches.createOrReset('feature', 'main', '/test/repo');

      assert.ok(execAsyncStub.calledWith(['branch', '-f', 'feature', 'main'], { cwd: '/test/repo' }));
      assert.ok(execAsyncOrThrowStub.calledWith(['branch', '--show-current'], '/test/repo'));
      assert.ok(execAsyncStub.calledWith(['status', '--porcelain'], { cwd: '/test/repo' }));
      assert.ok(execAsyncOrThrowStub.calledWith(['reset', '--hard', 'main'], '/test/repo'));
    });

    test('should throw when checked out branch has uncommitted changes', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('error: branch checked out'));
      execAsyncOrThrowStub.onFirstCall().resolves('feature'); // current branch
      execAsyncStub.onSecondCall().resolves(mockSuccess('M modified-file.txt')); // uncommitted changes

      await assert.rejects(
        () => branches.createOrReset('feature', 'main', '/test/repo'),
        /Cannot update branch 'feature' - it is checked out with uncommitted changes/
      );
    });

    test('should log when branch has uncommitted changes', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('error: branch checked out'));
      execAsyncOrThrowStub.onFirstCall().resolves('feature');
      execAsyncStub.onSecondCall().resolves(mockSuccess('M file.txt'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await assert.rejects(() => branches.createOrReset('feature', 'main', '/test/repo', log));

      assert.ok(logMessages.some(m => m.includes('⚠ Cannot reset - uncommitted changes would be lost')));
    });

    test('should throw when branch is checked out in another worktree', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('error: branch checked out'));
      execAsyncOrThrowStub.onFirstCall().resolves('main'); // different current branch

      await assert.rejects(
        () => branches.createOrReset('feature', 'develop', '/test/repo'),
        /Cannot update branch 'feature' - it is checked out in another worktree/
      );
    });

    test('should handle "used by worktree" error', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('error: used by worktree at'));
      execAsyncOrThrowStub.onFirstCall().resolves('main'); // different current branch

      await assert.rejects(
        () => branches.createOrReset('feature', 'develop', '/test/repo'),
        /Cannot update branch 'feature' - it is checked out in another worktree/
      );
    });

    test('should throw for other git errors', async () => {
      execAsyncStub.resolves(mockFailure('Some other git error'));

      await assert.rejects(
        () => branches.createOrReset('feature', 'invalid-ref', '/test/repo'),
        /Git command failed: git branch -f feature invalid-ref - Some other git error/
      );
    });

    test('should log when resetting checked out branch', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('error: branch checked out'));
      execAsyncOrThrowStub.onFirstCall().resolves('feature');
      execAsyncStub.onSecondCall().resolves(mockSuccess(''));
      execAsyncOrThrowStub.onSecondCall().resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.createOrReset('feature', 'main', '/test/repo', log);

      assert.ok(logMessages.some(m => m.includes("Branch 'feature' is checked out, checking if safe to reset")));
      assert.ok(logMessages.some(m => m.includes("Working directory clean, resetting to 'main'")));
      assert.ok(logMessages.some(m => m.includes("✓ Reset 'feature' to 'main' via git reset")));
    });
  });

  suite('remove()', () => {
    test('should delete branch with default options', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.remove('feature', '/test/repo');

      assert.ok(execAsyncOrThrowStub.calledWith(['branch', '-d', 'feature'], '/test/repo'));
    });

    test('should delete branch with force option', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.remove('feature', '/test/repo', { force: true });

      assert.ok(execAsyncOrThrowStub.calledWith(['branch', '-D', 'feature'], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.remove('feature', '/test/repo', { log });

      assert.ok(logMessages.some(m => m.includes("Deleting branch 'feature'")));
      assert.ok(logMessages.some(m => m.includes("✓ Deleted branch 'feature'")));
    });

    test('should throw on deletion error', async () => {
      execAsyncOrThrowStub.rejects(new Error('Branch not fully merged'));

      await assert.rejects(
        () => branches.remove('feature', '/test/repo'),
        /Branch not fully merged/
      );
    });
  });

  suite('deleteLocal()', () => {
    test('should return true when deletion succeeds', async () => {
      execAsyncStub.resolves(mockSuccess());

      const result = await branches.deleteLocal('/test/repo', 'feature');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['branch', '-d', 'feature'], { cwd: '/test/repo' }));
    });

    test('should return false when deletion fails', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await branches.deleteLocal('/test/repo', 'feature');

      assert.strictEqual(result, false);
    });

    test('should use force flag when specified', async () => {
      execAsyncStub.resolves(mockSuccess());

      await branches.deleteLocal('/test/repo', 'feature', { force: true });

      assert.ok(execAsyncStub.calledWith(['branch', '-D', 'feature'], { cwd: '/test/repo' }));
    });

    test('should log success when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.deleteLocal('/test/repo', 'feature', { log });

      assert.ok(logMessages.some(m => m.includes("Deleting local branch 'feature'")));
      assert.ok(logMessages.some(m => m.includes("✓ Deleted local branch 'feature'")));
    });
  });

  suite('deleteRemote()', () => {
    test('should return true when deletion succeeds', async () => {
      execAsyncStub.resolves(mockSuccess());

      const result = await branches.deleteRemote('/test/repo', 'feature');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['push', 'origin', '--delete', 'feature'], { cwd: '/test/repo' }));
    });

    test('should return false when deletion fails', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await branches.deleteRemote('/test/repo', 'feature');

      assert.strictEqual(result, false);
    });

    test('should use custom remote', async () => {
      execAsyncStub.resolves(mockSuccess());

      await branches.deleteRemote('/test/repo', 'feature', { remote: 'upstream' });

      assert.ok(execAsyncStub.calledWith(['push', 'upstream', '--delete', 'feature'], { cwd: '/test/repo' }));
    });

    test('should log success when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.deleteRemote('/test/repo', 'feature', { log });

      assert.ok(logMessages.some(m => m.includes("Deleting remote branch 'origin/feature'")));
      assert.ok(logMessages.some(m => m.includes("✓ Deleted remote branch 'origin/feature'")));
    });
  });

  suite('checkout()', () => {
    test('should switch to branch', async () => {
      execAsyncOrThrowStub.resolves('');

      await branches.checkout('/test/repo', 'feature');

      assert.ok(execAsyncOrThrowStub.calledWith(['switch', 'feature'], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await branches.checkout('/test/repo', 'feature', log);

      assert.ok(logMessages.some(m => m.includes("Switching to branch 'feature'")));
      assert.ok(logMessages.some(m => m.includes("✓ Switched to 'feature'")));
    });

    test('should throw on checkout error', async () => {
      execAsyncOrThrowStub.rejects(new Error('Branch does not exist'));

      await assert.rejects(
        () => branches.checkout('/test/repo', 'nonexistent'),
        /Branch does not exist/
      );
    });
  });

  suite('list()', () => {
    test('should return list of branches', async () => {
      execAsyncOrNullStub.resolves('main\nfeature\ndevelop');

      const result = await branches.list('/test/repo');

      assert.deepStrictEqual(result, ['main', 'feature', 'develop']);
      assert.ok(execAsyncOrNullStub.calledWith(['branch', '--format=%(refname:short)'], '/test/repo'));
    });

    test('should handle Windows line endings', async () => {
      execAsyncOrNullStub.resolves('main\r\nfeature\r\ndevelop');

      const result = await branches.list('/test/repo');

      assert.deepStrictEqual(result, ['main', 'feature', 'develop']);
    });

    test('should filter out empty lines', async () => {
      execAsyncOrNullStub.resolves('main\n\nfeature\n\n');

      const result = await branches.list('/test/repo');

      assert.deepStrictEqual(result, ['main', 'feature']);
    });

    test('should return empty array when command fails', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.list('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle single branch', async () => {
      execAsyncOrNullStub.resolves('main');

      const result = await branches.list('/test/repo');

      assert.deepStrictEqual(result, ['main']);
    });
  });

  suite('getCommit()', () => {
    test('should return commit SHA', async () => {
      execAsyncOrNullStub.resolves('abc123def456');

      const result = await branches.getCommit('main', '/test/repo');

      assert.strictEqual(result, 'abc123def456');
      assert.ok(execAsyncOrNullStub.calledWith(['rev-parse', 'main'], '/test/repo'));
    });

    test('should return null when branch does not exist', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.getCommit('nonexistent', '/test/repo');

      assert.strictEqual(result, null);
    });
  });

  suite('getMergeBase()', () => {
    test('should return merge base SHA', async () => {
      execAsyncOrNullStub.resolves('abc123def456');

      const result = await branches.getMergeBase('main', 'feature', '/test/repo');

      assert.strictEqual(result, 'abc123def456');
      assert.ok(execAsyncOrNullStub.calledWith(['merge-base', 'main', 'feature'], '/test/repo'));
    });

    test('should return null when no merge base exists', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await branches.getMergeBase('unrelated1', 'unrelated2', '/test/repo');

      assert.strictEqual(result, null);
    });
  });
});