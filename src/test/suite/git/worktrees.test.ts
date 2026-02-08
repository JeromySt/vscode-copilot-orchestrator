/**
 * @fileoverview Tests for git worktree operations (src/git/core/worktrees.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as worktrees from '../../../git/core/worktrees';
import * as executor from '../../../git/core/executor';
import * as branches from '../../../git/core/branches';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

suite('Git Worktrees', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;

  setup(() => {
    silenceConsole();
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // list
  // =========================================================================

  suite('list', () => {
    test('returns empty array when no output', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await worktrees.list('/repo');
      assert.deepStrictEqual(result, []);
    });

    test('parses single worktree entry', async () => {
      execAsyncOrNullStub.resolves(
        'worktree /repo\nbranch refs/heads/main\n\n'
      );
      const result = await worktrees.list('/repo');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, '/repo');
      assert.strictEqual(result[0].branch, 'main');
    });

    test('parses multiple worktree entries', async () => {
      execAsyncOrNullStub.resolves(
        'worktree /repo\nbranch refs/heads/main\n\n' +
        'worktree /repo/.worktrees/job-1\nbranch refs/heads/feature\n\n'
      );
      const result = await worktrees.list('/repo');
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].branch, 'main');
      assert.strictEqual(result[1].branch, 'feature');
    });

    test('handles detached HEAD (no branch)', async () => {
      execAsyncOrNullStub.resolves(
        'worktree /repo/.worktrees/job-1\nHEAD abc123\ndetached\n\n'
      );
      const result = await worktrees.list('/repo');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].branch, null);
    });
  });

  // =========================================================================
  // create
  // =========================================================================

  suite('create', () => {
    test('calls execAsyncOrThrow with correct args', async () => {
      execAsyncOrThrowStub.resolves('');
      // Stub fs.promises.access to simulate existing parent dir
      const fs = require('fs');
      const accessStub = sinon.stub(fs.promises, 'access').resolves();
      // Stub submodule check (no .gitmodules)
      accessStub.withArgs(sinon.match(/\.gitmodules/)).rejects(new Error('ENOENT'));

      await worktrees.create({
        repoPath: '/repo',
        worktreePath: '/repo/.wt/job1',
        branchName: 'feature',
        fromRef: 'main',
      });

      const callArgs = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(callArgs[0], ['worktree', 'add', '-B', 'feature', '/repo/.wt/job1', 'main']);
      assert.strictEqual(callArgs[1], '/repo');
    });
  });

  // =========================================================================
  // createWithTiming
  // =========================================================================

  suite('createWithTiming', () => {
    test('returns timing information', async () => {
      execAsyncOrThrowStub.resolves('');
      const fs = require('fs');
      const accessStub = sinon.stub(fs.promises, 'access').resolves();
      accessStub.withArgs(sinon.match(/\.gitmodules/)).rejects(new Error('ENOENT'));

      const timing = await worktrees.createWithTiming({
        repoPath: '/repo',
        worktreePath: '/repo/.wt/job1',
        branchName: 'feature',
        fromRef: 'main',
      });

      assert.ok(typeof timing.worktreeMs === 'number');
      assert.ok(typeof timing.submoduleMs === 'number');
      assert.ok(typeof timing.totalMs === 'number');
      assert.ok(timing.totalMs >= 0);
    });
  });

  // =========================================================================
  // remove
  // =========================================================================

  suite('remove', () => {
    test('calls git worktree remove with --force', async () => {
      execAsyncOrThrowStub.resolves('');
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      const fs = require('fs');
      sinon.stub(fs.promises, 'access').rejects(new Error('ENOENT'));

      await worktrees.remove('/repo/.wt/job1', '/repo');

      const firstCall = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(firstCall[0], ['worktree', 'remove', '/repo/.wt/job1', '--force']);
    });
  });

  // =========================================================================
  // removeSafe
  // =========================================================================

  suite('removeSafe', () => {
    test('returns true on success', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      const fs = require('fs');
      sinon.stub(fs.promises, 'access').rejects(new Error('ENOENT'));

      const result = await worktrees.removeSafe('/repo', '/repo/.wt/job1');
      assert.strictEqual(result, true);
    });

    test('returns false on failure', async () => {
      execAsyncStub.resolves({ success: false, stdout: '', stderr: 'error', exitCode: 1 });
      const fs = require('fs');
      sinon.stub(fs.promises, 'access').rejects(new Error('ENOENT'));

      const result = await worktrees.removeSafe('/repo', '/repo/.wt/job1');
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // isValid
  // =========================================================================

  suite('isValid', () => {
    test('returns false when path does not exist', async () => {
      const result = await worktrees.isValid('/nonexistent/path/xyz123');
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // getHeadCommit
  // =========================================================================

  suite('getHeadCommit', () => {
    test('returns commit SHA on success', async () => {
      execAsyncStub.resolves({
        success: true,
        stdout: 'abc123def456\n',
        stderr: '',
        exitCode: 0,
      });
      const result = await worktrees.getHeadCommit('/repo');
      assert.strictEqual(result, 'abc123def456');
    });

    test('returns null on failure', async () => {
      execAsyncStub.resolves({
        success: false,
        stdout: '',
        stderr: 'fatal',
        exitCode: 128,
      });
      const result = await worktrees.getHeadCommit('/repo');
      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // getBranch
  // =========================================================================

  suite('getBranch', () => {
    test('delegates to branches.currentOrNull', async () => {
      const stub = sinon.stub(branches, 'currentOrNull').resolves('feature');
      const result = await worktrees.getBranch('/repo');
      assert.strictEqual(result, 'feature');
      assert.ok(stub.calledOnceWith('/repo'));
    });
  });

  // =========================================================================
  // prune
  // =========================================================================

  suite('prune', () => {
    test('calls git worktree prune', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      await worktrees.prune('/repo');
      assert.ok(execAsyncStub.calledOnce);
      assert.deepStrictEqual(execAsyncStub.firstCall.args[0], ['worktree', 'prune']);
    });
  });

  // =========================================================================
  // createDetached / createDetachedWithTiming
  // =========================================================================

  suite('createDetached', () => {
    test('creates detached worktree', async () => {
      execAsyncStub.resolves({ success: true, stdout: 'abc123\n', stderr: '', exitCode: 0 });
      execAsyncOrThrowStub.resolves('');
      const fs = require('fs');
      const accessStub = sinon.stub(fs.promises, 'access').resolves();
      accessStub.withArgs(sinon.match(/\.gitmodules/)).rejects(new Error('ENOENT'));

      await worktrees.createDetached('/repo', '/repo/.wt/detach', 'abc123');
      assert.ok(execAsyncOrThrowStub.calledWith(
        ['worktree', 'add', '--detach', '/repo/.wt/detach', 'abc123'],
        '/repo'
      ));
    });
  });

  suite('createDetachedWithTiming', () => {
    test('returns timing and base commit', async () => {
      execAsyncStub.resolves({ success: true, stdout: 'abc123\n', stderr: '', exitCode: 0 });
      execAsyncOrThrowStub.resolves('');
      const fs = require('fs');
      const accessStub = sinon.stub(fs.promises, 'access').resolves();
      accessStub.withArgs(sinon.match(/\.gitmodules/)).rejects(new Error('ENOENT'));

      const result = await worktrees.createDetachedWithTiming('/repo', '/repo/.wt/detach', 'main');
      assert.ok(typeof result.worktreeMs === 'number');
      assert.ok(typeof result.submoduleMs === 'number');
      assert.ok(typeof result.totalMs === 'number');
      assert.strictEqual(result.baseCommit, 'abc123');
    });

    test('creates parent dir when it does not exist', async () => {
      execAsyncStub.resolves({ success: true, stdout: 'sha1\n', stderr: '', exitCode: 0 });
      execAsyncOrThrowStub.resolves('');
      const fs = require('fs');
      const accessStub = sinon.stub(fs.promises, 'access');
      // Parent dir doesn't exist
      accessStub.withArgs(sinon.match(/\.wt$/)).rejects(new Error('ENOENT'));
      accessStub.withArgs(sinon.match(/\.gitmodules/)).rejects(new Error('ENOENT'));
      accessStub.resolves(); // other calls succeed
      const mkdirStub = sinon.stub(fs.promises, 'mkdir').resolves();

      await worktrees.createDetachedWithTiming('/repo', '/repo/.wt/detach', 'main');
      assert.ok(mkdirStub.calledOnce);
    });
  });

  // =========================================================================
  // createOrReuseDetached
  // =========================================================================

  suite('createOrReuseDetached', () => {
    test('reuses existing valid worktree', async () => {
      const fs = require('fs');
      sinon.stub(fs.promises, 'access').resolves();
      execAsyncStub.resolves({ success: true, stdout: 'headsha\n', stderr: '', exitCode: 0 });

      const result = await worktrees.createOrReuseDetached('/repo', '/repo/.wt/detach', 'main');
      assert.strictEqual(result.reused, true);
      assert.strictEqual(result.baseCommit, 'headsha');
      assert.strictEqual(result.worktreeMs, 0);
    });

    test('creates new when worktree is invalid', async () => {
      const fs = require('fs');
      const accessStub = sinon.stub(fs.promises, 'access');
      // isValid check: worktreePath exists but .git does not
      accessStub.withArgs('/repo/.wt/detach').resolves();
      accessStub.withArgs(sinon.match(/\.git$/)).rejects(new Error('ENOENT'));
      accessStub.withArgs(sinon.match(/\.gitmodules/)).rejects(new Error('ENOENT'));
      accessStub.resolves();
      execAsyncStub.resolves({ success: true, stdout: 'sha1\n', stderr: '', exitCode: 0 });
      execAsyncOrThrowStub.resolves('');

      const result = await worktrees.createOrReuseDetached('/repo', '/repo/.wt/detach', 'main');
      assert.strictEqual(result.reused, false);
    });
  });
});
