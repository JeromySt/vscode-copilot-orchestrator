/**
 * @fileoverview Unit tests for git worktree operations.
 *
 * Mocks the executor module (execAsync, execAsyncOrThrow, execAsyncOrNull)
 * and fs to verify worktree management logic without touching the file system
 * or running real git commands.
 */

import * as assert from 'assert';
import * as path from 'path';

// The compiled output uses CommonJS `require`, so we can grab and mutate the
// executor module exports directly.  Import via the path that worktrees.ts uses
// so we're mutating the same cached module object.
import * as executor from '../../../git/core/executor';
import * as worktrees from '../../../git/core/worktrees';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AsyncFn = (...args: any[]) => Promise<any>;

/** Minimal stub that replaces a function on `obj` and restores it later. */
function stub<T extends Record<string, any>>(obj: T, method: keyof T, replacement: AsyncFn) {
  const original = obj[method];
  (obj as any)[method] = replacement;
  return { restore: () => { (obj as any)[method] = original; } };
}

function ok(result: executor.CommandResult): executor.CommandResult {
  return { success: true, stdout: result.stdout ?? '', stderr: '', exitCode: 0 };
}

function fail(stderr = 'error'): executor.CommandResult {
  return { success: false, stdout: '', stderr, exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

suite('Git Worktree Operations', () => {

  const repoPath = path.join('C:', 'repos', 'my-project');
  const worktreePath = path.join('C:', 'repos', 'my-project', '.worktrees', 'feature-1');

  // Stubs that every test can populate; torn down automatically.
  let stubs: Array<{ restore: () => void }> = [];

  // Helpers to stub executor functions
  function stubExecAsync(impl: AsyncFn) {
    stubs.push(stub(executor, 'execAsync', impl));
  }
  function stubExecAsyncOrThrow(impl: AsyncFn) {
    stubs.push(stub(executor, 'execAsyncOrThrow', impl));
  }
  function stubExecAsyncOrNull(impl: AsyncFn) {
    stubs.push(stub(executor, 'execAsyncOrNull', impl));
  }

  teardown(() => {
    stubs.forEach(s => s.restore());
    stubs = [];
  });

  // =========================================================================
  // list()
  // =========================================================================

  suite('list()', () => {

    test('should parse porcelain output with branches', async () => {
      stubExecAsyncOrNull(async () =>
        [
          'worktree /repos/my-project',
          'HEAD abc1234',
          'branch refs/heads/main',
          '',
          'worktree /repos/my-project/.worktrees/feat',
          'HEAD def5678',
          'branch refs/heads/feature-1',
          '',
        ].join('\n')
      );

      const result = await worktrees.list(repoPath);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].path, '/repos/my-project');
      assert.strictEqual(result[0].branch, 'main');
      assert.strictEqual(result[1].path, '/repos/my-project/.worktrees/feat');
      assert.strictEqual(result[1].branch, 'feature-1');
    });

    test('should handle detached HEAD worktrees (no branch line)', async () => {
      stubExecAsyncOrNull(async () =>
        [
          'worktree /repos/my-project',
          'HEAD abc1234',
          'branch refs/heads/main',
          '',
          'worktree /repos/my-project/.worktrees/detached',
          'HEAD 1111111',
          'detached',
          '',
        ].join('\n')
      );

      const result = await worktrees.list(repoPath);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[1].branch, null, 'detached worktree should have null branch');
    });

    test('should return empty array when git command fails', async () => {
      stubExecAsyncOrNull(async () => null);

      const result = await worktrees.list(repoPath);
      assert.deepStrictEqual(result, []);
    });

    test('should return empty array for empty output', async () => {
      stubExecAsyncOrNull(async () => '');

      const result = await worktrees.list(repoPath);
      assert.deepStrictEqual(result, []);
    });

    test('should handle Windows-style paths in porcelain output', async () => {
      stubExecAsyncOrNull(async () =>
        [
          'worktree C:\\repos\\my-project',
          'HEAD abc1234',
          'branch refs/heads/main',
          '',
        ].join('\n')
      );

      const result = await worktrees.list(repoPath);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'C:\\repos\\my-project');
    });

    test('should handle \\r\\n line endings', async () => {
      stubExecAsyncOrNull(async () =>
        'worktree /repos/proj\r\nHEAD abc\r\nbranch refs/heads/main\r\n'
      );

      const result = await worktrees.list(repoPath);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].branch, 'main');
    });
  });

  // =========================================================================
  // create()
  // =========================================================================

  suite('create()', () => {

    test('should call git worktree add with -B flag', async () => {
      const calls: string[][] = [];
      let accessCallCount = 0;

      // Stub fs.promises.access to simulate parent directory exists
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => { accessCallCount++; };

      stubExecAsyncOrThrow(async (args: string[]) => {
        calls.push(args);
        return '';
      });

      // Stub setupSubmoduleSymlinks path – it calls fs.promises.access on .gitmodules
      // The second access call (for .gitmodules) should throw to skip submodules
      let accessCount = 0;
      (fs.promises as any).access = async (p: string) => {
        accessCount++;
        // First call is parent dir check – succeed
        // Second call is .gitmodules check – throw to skip submodules
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      // Stub execAsync for submodule config call
      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      await worktrees.create({
        repoPath,
        worktreePath,
        branchName: 'feature-1',
        fromRef: 'main',
      });

      // Verify worktree add was called with -B
      assert.ok(calls.length > 0, 'should have called execAsyncOrThrow');
      const wtAddCall = calls.find(c => c.includes('worktree'));
      assert.ok(wtAddCall, 'should have a worktree add call');
      assert.ok(wtAddCall!.includes('-B'), 'should use -B flag');
      assert.ok(wtAddCall!.includes('feature-1'), 'should include branch name');
      assert.ok(wtAddCall!.includes('main'), 'should include fromRef');
    });

    test('should create parent directory if it does not exist', async () => {
      let mkdirCalled = false;
      let mkdirPath: string | undefined;

      const origAccess = fs.promises.access;
      const origMkdir = fs.promises.mkdir;
      stubs.push({
        restore: () => {
          (fs.promises as any).access = origAccess;
          (fs.promises as any).mkdir = origMkdir;
        }
      });

      let accessCount = 0;
      (fs.promises as any).access = async (p: string) => {
        accessCount++;
        if (accessCount === 1) {
          // Parent dir does not exist
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        // .gitmodules check – also doesn't exist
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      (fs.promises as any).mkdir = async (p: string, opts: any) => {
        mkdirCalled = true;
        mkdirPath = p;
      };

      stubExecAsyncOrThrow(async () => '');
      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      await worktrees.create({
        repoPath,
        worktreePath,
        branchName: 'feature-1',
        fromRef: 'main',
      });

      assert.ok(mkdirCalled, 'should have called mkdir');
      assert.strictEqual(mkdirPath, path.dirname(worktreePath), 'should create parent dir');
    });

    test('should invoke logger when log function is provided', async () => {
      const logs: string[] = [];
      const log = (msg: string) => logs.push(msg);

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });

      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      stubExecAsyncOrThrow(async () => '');
      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      await worktrees.create({
        repoPath,
        worktreePath,
        branchName: 'feature-1',
        fromRef: 'main',
        log,
      });

      assert.ok(logs.length > 0, 'should have logged messages');
      assert.ok(
        logs.some(l => l.includes('[worktree]')),
        'logs should include [worktree] prefix'
      );
    });
  });

  // =========================================================================
  // createWithTiming()
  // =========================================================================

  suite('createWithTiming()', () => {

    test('should return timing breakdown', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });

      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      stubExecAsyncOrThrow(async () => '');
      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      const timing = await worktrees.createWithTiming({
        repoPath,
        worktreePath,
        branchName: 'feature-1',
        fromRef: 'main',
      });

      assert.ok('worktreeMs' in timing, 'should have worktreeMs');
      assert.ok('submoduleMs' in timing, 'should have submoduleMs');
      assert.ok('totalMs' in timing, 'should have totalMs');
      assert.ok(timing.totalMs >= 0, 'totalMs should be non-negative');
    });
  });

  // =========================================================================
  // remove()
  // =========================================================================

  suite('remove()', () => {

    test('should call git worktree remove with --force', async () => {
      const calls: string[][] = [];

      stubExecAsyncOrThrow(async (args: string[]) => {
        calls.push(args);
        return '';
      });

      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      // Stub fs.promises.access to throw (no leftover directory)
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      await worktrees.remove(worktreePath, repoPath);

      const removeCall = calls.find(c => c.includes('worktree') && c.includes('remove'));
      assert.ok(removeCall, 'should call git worktree remove');
      assert.ok(removeCall!.includes('--force'), 'should include --force flag');
    });

    test('should prune after removing', async () => {
      const execAsyncCalls: string[][] = [];

      stubExecAsyncOrThrow(async () => '');
      stubExecAsync(async (args: string[]) => {
        execAsyncCalls.push(args);
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      await worktrees.remove(worktreePath, repoPath);

      const pruneCall = execAsyncCalls.find(c => c.includes('prune'));
      assert.ok(pruneCall, 'should call git worktree prune');
    });

    test('should clean up leftover directory', async () => {
      let rmCalled = false;
      let rmPath: string | undefined;

      stubExecAsyncOrThrow(async () => '');
      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      const origAccess = fs.promises.access;
      const origRm = fs.promises.rm;
      stubs.push({
        restore: () => {
          (fs.promises as any).access = origAccess;
          (fs.promises as any).rm = origRm;
        }
      });

      // Simulate leftover directory exists
      (fs.promises as any).access = async () => { /* success */ };
      (fs.promises as any).rm = async (p: string, opts: any) => {
        rmCalled = true;
        rmPath = p;
      };

      await worktrees.remove(worktreePath, repoPath);

      assert.ok(rmCalled, 'should remove leftover directory');
      assert.strictEqual(rmPath, worktreePath, 'should remove the worktree path');
    });

    test('should throw when git worktree remove fails', async () => {
      stubExecAsyncOrThrow(async () => {
        throw new Error('fatal: not a valid worktree');
      });

      await assert.rejects(
        () => worktrees.remove(worktreePath, repoPath),
        /not a valid worktree/
      );
    });
  });

  // =========================================================================
  // removeSafe()
  // =========================================================================

  suite('removeSafe()', () => {

    test('should return true on success', async () => {
      stubExecAsync(async (args: string[]) => {
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      const result = await worktrees.removeSafe(repoPath, worktreePath);
      assert.strictEqual(result, true);
    });

    test('should return false on failure without throwing', async () => {
      stubExecAsync(async (args: string[]) => {
        if (args.includes('remove')) {
          return fail('fatal: not a valid worktree');
        }
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      const result = await worktrees.removeSafe(repoPath, worktreePath);
      assert.strictEqual(result, false);
    });

    test('should include --force flag by default', async () => {
      const execCalls: string[][] = [];

      stubExecAsync(async (args: string[]) => {
        execCalls.push(args);
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      await worktrees.removeSafe(repoPath, worktreePath);

      const removeCall = execCalls.find(c => c.includes('remove'));
      assert.ok(removeCall, 'should call worktree remove');
      assert.ok(removeCall!.includes('--force'), 'should include --force');
    });

    test('should omit --force when force=false', async () => {
      const execCalls: string[][] = [];

      stubExecAsync(async (args: string[]) => {
        execCalls.push(args);
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      await worktrees.removeSafe(repoPath, worktreePath, { force: false });

      const removeCall = execCalls.find(c => c.includes('remove'));
      assert.ok(removeCall, 'should call worktree remove');
      assert.ok(!removeCall!.includes('--force'), 'should NOT include --force');
    });
  });

  // =========================================================================
  // createDetached()
  // =========================================================================

  suite('createDetached()', () => {

    test('should call git worktree add with --detach flag', async () => {
      const throwCalls: string[][] = [];

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      stubExecAsync(async (args: string[]) => {
        return ok({ stdout: 'abc1234567890\n', stderr: '', success: true, exitCode: 0 });
      });

      stubExecAsyncOrThrow(async (args: string[]) => {
        throwCalls.push(args);
        return '';
      });

      await worktrees.createDetached(repoPath, worktreePath, 'main');

      const wtCall = throwCalls.find(c => c.includes('worktree'));
      assert.ok(wtCall, 'should call git worktree add');
      assert.ok(wtCall!.includes('--detach'), 'should include --detach flag');
    });

    test('should resolve commitish to SHA', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      stubExecAsync(async (args: string[]) => {
        if (args.includes('rev-parse') && !args.includes('HEAD')) {
          return ok({ stdout: 'abc1234567890abcdef\n', stderr: '', success: true, exitCode: 0 });
        }
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      stubExecAsyncOrThrow(async () => '');

      const result = await worktrees.createDetachedWithTiming(repoPath, worktreePath, 'main');
      assert.strictEqual(result.baseCommit, 'abc1234567890abcdef');
    });

    test('should fall back to commitish when rev-parse fails', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      stubExecAsync(async (args: string[]) => {
        if (args.includes('rev-parse') && !args.includes('HEAD')) {
          return fail('fatal: ambiguous argument');
        }
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      stubExecAsyncOrThrow(async () => '');

      const result = await worktrees.createDetachedWithTiming(repoPath, worktreePath, 'some-ref');
      assert.strictEqual(result.baseCommit, 'some-ref');
    });
  });

  // =========================================================================
  // createOrReuseDetached()
  // =========================================================================

  suite('createOrReuseDetached()', () => {

    test('should reuse existing valid worktree', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      // isValid checks: worktreePath exists, worktreePath/.git exists
      (fs.promises as any).access = async () => { /* both exist */ };

      // getHeadCommit calls execAsync with rev-parse HEAD
      stubExecAsync(async (args: string[]) => {
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return ok({ stdout: 'existingsha123\n', stderr: '', success: true, exitCode: 0 });
        }
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      const result = await worktrees.createOrReuseDetached(repoPath, worktreePath, 'main');

      assert.strictEqual(result.reused, true, 'should report reused');
      assert.strictEqual(result.baseCommit, 'existingsha123');
      assert.strictEqual(result.worktreeMs, 0, 'worktreeMs should be 0 for reuse');
    });

    test('should create new worktree when path is invalid', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });

      let accessCount = 0;
      (fs.promises as any).access = async (p: string) => {
        accessCount++;
        // isValid: first call to worktreePath fails (doesn't exist)
        if (accessCount <= 1) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        // createDetachedWithTiming: parent dir check succeeds
        if (accessCount === 2) {
          return;
        }
        // .gitmodules check fails
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      stubExecAsync(async (args: string[]) => {
        if (args.includes('rev-parse')) {
          return ok({ stdout: 'newsha456\n', stderr: '', success: true, exitCode: 0 });
        }
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      stubExecAsyncOrThrow(async () => '');

      const result = await worktrees.createOrReuseDetached(repoPath, worktreePath, 'main');

      assert.strictEqual(result.reused, false, 'should not report reused');
    });
  });

  // =========================================================================
  // isValid()
  // =========================================================================

  suite('isValid()', () => {

    test('should return true when worktree path and .git exist', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => { /* success */ };

      const result = await worktrees.isValid(worktreePath);
      assert.strictEqual(result, true);
    });

    test('should return false when worktree path does not exist', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };

      const result = await worktrees.isValid(worktreePath);
      assert.strictEqual(result, false);
    });

    test('should return false when .git file is missing', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });

      let callCount = 0;
      (fs.promises as any).access = async (p: string) => {
        callCount++;
        if (callCount === 2) {
          // .git check fails
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      const result = await worktrees.isValid(worktreePath);
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // getHeadCommit()
  // =========================================================================

  suite('getHeadCommit()', () => {

    test('should return trimmed SHA on success', async () => {
      stubExecAsync(async () =>
        ok({ stdout: '  abc123def456  \n', stderr: '', success: true, exitCode: 0 })
      );

      const result = await worktrees.getHeadCommit(worktreePath);
      assert.strictEqual(result, 'abc123def456');
    });

    test('should return null on failure', async () => {
      stubExecAsync(async () => fail('not a git repo'));

      const result = await worktrees.getHeadCommit(worktreePath);
      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // prune()
  // =========================================================================

  suite('prune()', () => {

    test('should call git worktree prune', async () => {
      const calls: string[][] = [];

      stubExecAsync(async (args: string[]) => {
        calls.push(args);
        return ok({ stdout: '', stderr: '', success: true, exitCode: 0 });
      });

      await worktrees.prune(repoPath);

      assert.ok(calls.length > 0, 'should have called execAsync');
      const pruneCall = calls.find(c => c.includes('prune'));
      assert.ok(pruneCall, 'should call worktree prune');
    });
  });

  // =========================================================================
  // Path handling
  // =========================================================================

  suite('path handling', () => {

    test('should handle Unix-style paths in create options', async () => {
      const unixRepoPath = '/home/user/repos/project';
      const unixWorktreePath = '/home/user/repos/project/.worktrees/feat';

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      let receivedArgs: string[] | undefined;
      stubExecAsyncOrThrow(async (args: string[]) => {
        if (args.includes('worktree')) {
          receivedArgs = args;
        }
        return '';
      });

      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      await worktrees.create({
        repoPath: unixRepoPath,
        worktreePath: unixWorktreePath,
        branchName: 'feature',
        fromRef: 'main',
      });

      assert.ok(receivedArgs, 'should have received worktree add args');
      assert.ok(
        receivedArgs!.includes(unixWorktreePath),
        'should pass through Unix-style paths unchanged'
      );
    });

    test('should handle Windows-style paths in create options', async () => {
      const winRepoPath = 'C:\\Users\\dev\\repos\\project';
      const winWorktreePath = 'C:\\Users\\dev\\repos\\project\\.worktrees\\feat';

      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      let accessCount = 0;
      (fs.promises as any).access = async () => {
        accessCount++;
        if (accessCount >= 2) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      };

      let receivedArgs: string[] | undefined;
      stubExecAsyncOrThrow(async (args: string[]) => {
        if (args.includes('worktree')) {
          receivedArgs = args;
        }
        return '';
      });

      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      await worktrees.create({
        repoPath: winRepoPath,
        worktreePath: winWorktreePath,
        branchName: 'feature',
        fromRef: 'main',
      });

      assert.ok(receivedArgs, 'should have received worktree add args');
      assert.ok(
        receivedArgs!.includes(winWorktreePath),
        'should pass through Windows-style paths unchanged'
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  suite('error handling', () => {

    test('create should propagate git errors', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => { /* parent exists */ };

      stubExecAsyncOrThrow(async () => {
        throw new Error('fatal: \'feature-1\' is already checked out');
      });

      await assert.rejects(
        () => worktrees.create({
          repoPath,
          worktreePath,
          branchName: 'feature-1',
          fromRef: 'main',
        }),
        /already checked out/
      );
    });

    test('createDetached should propagate git errors', async () => {
      const origAccess = fs.promises.access;
      stubs.push({ restore: () => { (fs.promises as any).access = origAccess; } });
      (fs.promises as any).access = async () => { /* parent exists */ };

      // rev-parse succeeds
      stubExecAsync(async () =>
        ok({ stdout: 'abc123\n', stderr: '', success: true, exitCode: 0 })
      );

      // worktree add fails
      stubExecAsyncOrThrow(async () => {
        throw new Error('fatal: worktree path already exists');
      });

      await assert.rejects(
        () => worktrees.createDetached(repoPath, worktreePath, 'main'),
        /worktree path already exists/
      );
    });

    test('remove should not throw when leftover cleanup fails silently', async () => {
      stubExecAsyncOrThrow(async () => '');
      stubExecAsync(async () => ok({ stdout: '', stderr: '', success: true, exitCode: 0 }));

      // Simulate: access succeeds but rm throws
      const origAccess = fs.promises.access;
      const origRm = fs.promises.rm;
      stubs.push({
        restore: () => {
          (fs.promises as any).access = origAccess;
          (fs.promises as any).rm = origRm;
        }
      });

      (fs.promises as any).access = async () => { /* exists */ };
      (fs.promises as any).rm = async () => {
        throw new Error('EPERM: operation not permitted');
      };

      // Should NOT throw – cleanup failures are swallowed
      await worktrees.remove(worktreePath, repoPath);
    });
  });
});
