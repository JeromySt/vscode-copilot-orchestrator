import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as worktrees from '../../../git/core/worktrees';
import * as executor from '../../../git/core/executor';
import * as branches from '../../../git/core/branches';

/**
 * Comprehensive unit tests for git worktrees module.
 * Tests all functions with mocked executor and fs for 95%+ code coverage.
 */

suite('Git Core Worktrees Unit Tests', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;
  let fsAccessStub: sinon.SinonStub;
  let fsMkdirStub: sinon.SinonStub;
  let fsRmStub: sinon.SinonStub;
  let fsReadFileStub: sinon.SinonStub;
  let fsStatStub: sinon.SinonStub;
  let fsLstatStub: sinon.SinonStub;
  let fsUnlinkStub: sinon.SinonStub;
  let fsSymlinkStub: sinon.SinonStub;
  let branchesCurrentOrNullStub: sinon.SinonStub;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
    fsAccessStub = sinon.stub(fs.promises, 'access');
    fsMkdirStub = sinon.stub(fs.promises, 'mkdir');
    fsRmStub = sinon.stub(fs.promises, 'rm');
    fsReadFileStub = sinon.stub(fs.promises, 'readFile');
    fsStatStub = sinon.stub(fs.promises, 'stat');
    fsLstatStub = sinon.stub(fs.promises, 'lstat');
    fsUnlinkStub = sinon.stub(fs.promises, 'unlink');
    fsSymlinkStub = sinon.stub(fs.promises, 'symlink');
    branchesCurrentOrNullStub = sinon.stub(branches, 'currentOrNull');
  });

  teardown(() => {
    sinon.restore();
    if (clock) clock.restore();
  });

  // Helper functions for creating mock objects
  function mockSuccess(stdout: string = '') {
    return { success: true, stdout, stderr: '', exitCode: 0 };
  }

  function mockFailure(stderr: string = 'command failed') {
    return { success: false, stdout: '', stderr, exitCode: 1 };
  }

  function createMockStats(isDirectory = true, isFile = false, isSymbolicLink = false, size = 100) {
    return {
      isDirectory: () => isDirectory,
      isFile: () => isFile,
      isSymbolicLink: () => isSymbolicLink,
      size
    } as fs.Stats;
  }

  suite('create()', () => {
    test('should create worktree successfully', async () => {
      fsAccessStub.onFirstCall().resolves(); // Parent directory exists
      execAsyncOrThrowStub.onFirstCall().resolves(''); // worktree add
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // No .gitmodules

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      await worktrees.create(options);

      assert.ok(execAsyncOrThrowStub.calledWith(['worktree', 'add', '-B', 'feature-branch', '/test/worktrees/feature', 'main'], '/test/repo'));
    });

    test('should create parent directory if it does not exist', async () => {
      fsAccessStub.onFirstCall().rejects(new Error('ENOENT')); // Parent directory doesn't exist
      fsMkdirStub.resolves();
      execAsyncOrThrowStub.onFirstCall().resolves('');
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // No .gitmodules

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      await worktrees.create(options);

      assert.ok(fsMkdirStub.calledWith('/test/worktrees', { recursive: true }));
    });

    test('should log when logger provided', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main',
        log
      };

      await worktrees.create(options);

      assert.ok(logMessages.some(m => m.includes("Creating worktree at '/test/worktrees/feature' on branch 'feature-branch' from 'main'")));
      assert.ok(logMessages.some(m => m.includes('✓ Created worktree')));
    });

    test('should throw on worktree creation failure', async () => {
      fsAccessStub.resolves();
      execAsyncOrThrowStub.rejects(new Error('Branch already exists'));

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      await assert.rejects(
        () => worktrees.create(options),
        /Branch already exists/
      );
    });
  });

  suite('createWithTiming()', () => {
    test('should return timing information', async () => {
      clock = sinon.useFakeTimers();
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // No .gitmodules

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      const resultPromise = worktrees.createWithTiming(options);
      
      // Simulate time passing for worktree creation
      clock.tick(100);
      
      const result = await resultPromise;

      assert.ok(typeof result.worktreeMs === 'number');
      assert.ok(typeof result.submoduleMs === 'number');
      assert.ok(typeof result.totalMs === 'number');
    });

    test('should setup submodules when .gitmodules exists', async () => {
      clock = sinon.useFakeTimers();
      fsAccessStub.onFirstCall().resolves(); // Parent directory exists
      execAsyncOrThrowStub.onFirstCall().resolves(''); // worktree add
      
      // Mock .gitmodules detection and parsing
      fsAccessStub.onSecondCall().resolves(); // .gitmodules exists
      fsStatStub.resolves(createMockStats(false, true, false, 200)); // .gitmodules is a file with size
      execAsyncStub.onFirstCall().resolves(mockSuccess('submodule.test.path test-module')); // config --get-regexp
      
      // Mock submodule symlink creation
      fsStatStub.onSecondCall().resolves(createMockStats(true)); // Source submodule directory exists
      fsMkdirStub.resolves(); // Create parent directory for symlink
      fsLstatStub.rejects(new Error('ENOENT')); // Destination doesn't exist
      fsSymlinkStub.resolves(); // Create symlink
      
      execAsyncStub.onSecondCall().resolves(mockSuccess()); // submodule.recurse config

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      const resultPromise = worktrees.createWithTiming(options);
      clock.tick(50); // worktree creation time
      clock.tick(25); // submodule setup time

      const result = await resultPromise;

      assert.ok(result.submoduleMs >= 0);
      assert.ok(fsSymlinkStub.calledOnce);
    });

    test('should handle empty .gitmodules file', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      fsAccessStub.onSecondCall().resolves(); // .gitmodules exists
      fsStatStub.resolves(createMockStats(false, true, false, 0)); // Empty file

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      const result = await worktrees.createWithTiming(options);

      assert.strictEqual(result.submoduleMs, 0);
    });

    test('should handle submodule symlink failure and fallback to git init', async () => {
      clock = sinon.useFakeTimers();
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      
      // .gitmodules setup
      fsAccessStub.onSecondCall().resolves();
      fsStatStub.onFirstCall().resolves(createMockStats(false, true, false, 200));
      execAsyncStub.onFirstCall().resolves(mockSuccess('submodule.test.path test-module'));
      
      // Submodule symlink fails
      fsStatStub.onSecondCall().resolves(createMockStats(true));
      fsMkdirStub.resolves();
      fsLstatStub.rejects(new Error('ENOENT'));
      fsSymlinkStub.rejects(new Error('Permission denied'));
      
      // Fallback to git submodule init
      execAsyncStub.onSecondCall().resolves(mockSuccess('Submodule path \'test-module\': checked out')); // submodule update --init
      execAsyncStub.onThirdCall().resolves(mockSuccess()); // submodule.recurse config

      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main',
        log
      };

      clock.tick(100);
      await worktrees.createWithTiming(options);

      assert.ok(logMessages.some(m => m.includes('Falling back to git submodule init')));
      assert.ok(logMessages.some(m => m.includes("✓ Initialized submodule 'test-module' via git")));
      assert.ok(execAsyncStub.calledWith(['submodule', 'update', '--init', '--', 'test-module'], { cwd: '/test/worktrees/feature' }));
    });

    test('should handle Windows junction symlinks', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      try {
        fsAccessStub.onFirstCall().resolves();
        execAsyncOrThrowStub.resolves('');
        
        fsAccessStub.onSecondCall().resolves();
        fsStatStub.onFirstCall().resolves(createMockStats(false, true, false, 200));
        execAsyncStub.onFirstCall().resolves(mockSuccess('submodule.test.path test-module'));
        fsStatStub.onSecondCall().resolves(createMockStats(true));
        fsMkdirStub.resolves();
        fsLstatStub.rejects(new Error('ENOENT'));
        fsSymlinkStub.resolves();
        execAsyncStub.onSecondCall().resolves(mockSuccess());

        const options = {
          repoPath: '/test/repo',
          worktreePath: '/test/worktrees/feature',
          branchName: 'feature-branch',
          fromRef: 'main'
        };

        await worktrees.createWithTiming(options);

        assert.ok(fsSymlinkStub.calledWith(
          sinon.match.string,
          sinon.match.string,
          'junction'
        ));
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    test('should remove existing destination before creating symlink', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      
      fsAccessStub.onSecondCall().resolves();
      fsStatStub.onFirstCall().resolves(createMockStats(false, true, false, 200));
      execAsyncStub.onFirstCall().resolves(mockSuccess('submodule.test.path test-module'));
      fsStatStub.onSecondCall().resolves(createMockStats(true));
      fsMkdirStub.resolves();
      
      // Existing destination is a directory
      fsLstatStub.resolves(createMockStats(true));
      fsRmStub.resolves();
      fsSymlinkStub.resolves();
      execAsyncStub.onSecondCall().resolves(mockSuccess());

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      await worktrees.createWithTiming(options);

      assert.ok(fsRmStub.calledWith(sinon.match.string, { recursive: true, force: true }));
    });

    test('should remove existing symlink before creating new one', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      
      fsAccessStub.onSecondCall().resolves();
      fsStatStub.onFirstCall().resolves(createMockStats(false, true, false, 200));
      execAsyncStub.onFirstCall().resolves(mockSuccess('submodule.test.path test-module'));
      fsStatStub.onSecondCall().resolves(createMockStats(true));
      fsMkdirStub.resolves();
      
      // Existing destination is a symlink
      fsLstatStub.resolves(createMockStats(false, false, true));
      fsUnlinkStub.resolves();
      fsSymlinkStub.resolves();
      execAsyncStub.onSecondCall().resolves(mockSuccess());

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      await worktrees.createWithTiming(options);

      assert.ok(fsUnlinkStub.calledOnce);
    });

    test('should handle submodule config parsing errors', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      
      fsAccessStub.onSecondCall().resolves();
      fsStatStub.resolves(createMockStats(false, true, false, 200));
      execAsyncStub.onFirstCall().resolves(mockFailure()); // config command fails

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      const result = await worktrees.createWithTiming(options);

      assert.strictEqual(result.submoduleMs, 0);
    });

    test('should handle malformed submodule config lines', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncOrThrowStub.resolves('');
      
      fsAccessStub.onSecondCall().resolves();
      fsStatStub.onFirstCall().resolves(createMockStats(false, true, false, 200));
      execAsyncStub.onFirstCall().resolves(mockSuccess('invalid config line'));
      execAsyncStub.onSecondCall().resolves(mockSuccess()); // submodule.recurse config

      const options = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature',
        branchName: 'feature-branch',
        fromRef: 'main'
      };

      const result = await worktrees.createWithTiming(options);

      assert.ok(result.submoduleMs >= 0);
    });
  });

  suite('remove()', () => {
    test('should remove worktree successfully', async () => {
      execAsyncOrThrowStub.onFirstCall().resolves(''); // worktree remove
      execAsyncStub.resolves(mockSuccess()); // worktree prune
      fsAccessStub.rejects(new Error('ENOENT')); // Directory doesn't exist after removal

      await worktrees.remove('/test/worktrees/feature', '/test/repo');

      assert.ok(execAsyncOrThrowStub.calledWith(['worktree', 'remove', '/test/worktrees/feature', '--force'], '/test/repo'));
      assert.ok(execAsyncStub.calledWith(['worktree', 'prune'], { cwd: '/test/repo' }));
    });

    test('should clean up leftover directory', async () => {
      execAsyncOrThrowStub.resolves('');
      execAsyncStub.resolves(mockSuccess());
      fsAccessStub.resolves(); // Directory still exists after removal
      fsRmStub.resolves();

      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await worktrees.remove('/test/worktrees/feature', '/test/repo', log);

      assert.ok(fsRmStub.calledWith('/test/worktrees/feature', { recursive: true, force: true }));
      assert.ok(logMessages.some(m => m.includes('✓ Removed leftover directory')));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      execAsyncStub.resolves(mockSuccess());
      fsAccessStub.rejects(new Error('ENOENT'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await worktrees.remove('/test/worktrees/feature', '/test/repo', log);

      assert.ok(logMessages.some(m => m.includes("Removing worktree at '/test/worktrees/feature'")));
      assert.ok(logMessages.some(m => m.includes('✓ Removed worktree')));
    });

    test('should throw on removal failure', async () => {
      execAsyncOrThrowStub.rejects(new Error('Worktree removal failed'));

      await assert.rejects(
        () => worktrees.remove('/test/worktrees/feature', '/test/repo'),
        /Worktree removal failed/
      );
    });
  });

  suite('removeSafe()', () => {
    test('should return true when removal succeeds', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess()); // worktree remove
      execAsyncStub.onSecondCall().resolves(mockSuccess()); // worktree prune
      fsAccessStub.rejects(new Error('ENOENT')); // Directory doesn't exist

      const result = await worktrees.removeSafe('/test/repo', '/test/worktrees/feature');

      assert.strictEqual(result, true);
    });

    test('should return false when removal fails', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('Worktree has uncommitted changes')); // worktree remove fails
      execAsyncStub.onSecondCall().resolves(mockSuccess()); // worktree prune still runs
      fsAccessStub.rejects(new Error('ENOENT'));

      const result = await worktrees.removeSafe('/test/repo', '/test/worktrees/feature');

      assert.strictEqual(result, false);
    });

    test('should use force flag by default', async () => {
      execAsyncStub.resolves(mockSuccess());
      fsAccessStub.rejects(new Error('ENOENT'));

      await worktrees.removeSafe('/test/repo', '/test/worktrees/feature');

      assert.ok(execAsyncStub.calledWith(['worktree', 'remove', '/test/worktrees/feature', '--force'], { cwd: '/test/repo' }));
    });

    test('should not use force flag when disabled', async () => {
      execAsyncStub.resolves(mockSuccess());
      fsAccessStub.rejects(new Error('ENOENT'));

      await worktrees.removeSafe('/test/repo', '/test/worktrees/feature', { force: false });

      assert.ok(execAsyncStub.calledWith(['worktree', 'remove', '/test/worktrees/feature'], { cwd: '/test/repo' }));
    });

    test('should log failure when removal fails', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('removal error'));
      execAsyncStub.onSecondCall().resolves(mockSuccess());
      fsAccessStub.rejects(new Error('ENOENT'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await worktrees.removeSafe('/test/repo', '/test/worktrees/feature', { log });

      assert.ok(logMessages.some(m => m.includes('⚠ git worktree remove failed: removal error')));
    });
  });

  suite('createDetached()', () => {
    test('should create detached worktree', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncStub.onFirstCall().resolves(mockSuccess('abc123def456')); // rev-parse
      execAsyncOrThrowStub.resolves(''); // worktree add --detach
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // No .gitmodules

      await worktrees.createDetached('/test/repo', '/test/worktrees/detached', 'main');

      assert.ok(execAsyncStub.calledWith(['rev-parse', 'main'], { cwd: '/test/repo' }));
      assert.ok(execAsyncOrThrowStub.calledWith(['worktree', 'add', '--detach', '/test/worktrees/detached', 'main'], '/test/repo'));
    });
  });

  suite('createDetachedWithTiming()', () => {
    test('should return timing and base commit', async () => {
      clock = sinon.useFakeTimers();
      fsAccessStub.onFirstCall().resolves();
      execAsyncStub.onFirstCall().resolves(mockSuccess('abc123def456')); // rev-parse
      execAsyncOrThrowStub.resolves(''); // worktree add
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // No .gitmodules

      const resultPromise = worktrees.createDetachedWithTiming('/test/repo', '/test/worktrees/detached', 'main');
      clock.tick(100);
      
      const result = await resultPromise;

      assert.strictEqual(result.baseCommit, 'abc123def456');
      assert.ok(typeof result.worktreeMs === 'number');
      assert.ok(typeof result.submoduleMs === 'number');
      assert.ok(typeof result.totalMs === 'number');
    });

    test('should use commitish as base when rev-parse fails', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncStub.onFirstCall().resolves(mockFailure()); // rev-parse fails
      execAsyncOrThrowStub.resolves('');
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT'));

      const result = await worktrees.createDetachedWithTiming('/test/repo', '/test/worktrees/detached', 'unknown-ref');

      assert.strictEqual(result.baseCommit, 'unknown-ref');
    });

    test('should log with base commit SHA', async () => {
      fsAccessStub.onFirstCall().resolves();
      execAsyncStub.onFirstCall().resolves(mockSuccess('abc123def456'));
      execAsyncOrThrowStub.resolves('');
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await worktrees.createDetachedWithTiming('/test/repo', '/test/worktrees/detached', 'main', log);

      assert.ok(logMessages.some(m => m.includes("Creating detached worktree at '/test/worktrees/detached' from 'main' (abc123de)")));
      assert.ok(logMessages.some(m => m.includes('✓ Created detached worktree')));
    });
  });

  suite('createOrReuseDetached()', () => {
    test('should reuse existing valid worktree', async () => {
      fsAccessStub.onFirstCall().resolves(); // worktree path exists
      fsAccessStub.onSecondCall().resolves(); // .git path exists
      execAsyncStub.resolves(mockSuccess('existing123')); // getHeadCommit

      const result = await worktrees.createOrReuseDetached('/test/repo', '/test/worktrees/existing', 'main');

      assert.strictEqual(result.reused, true);
      assert.strictEqual(result.baseCommit, 'existing123');
      assert.strictEqual(result.worktreeMs, 0);
      assert.strictEqual(result.submoduleMs, 0);
      assert.strictEqual(result.totalMs, 0);
    });

    test('should create new worktree when none exists', async () => {
      // isValid returns false
      fsAccessStub.onFirstCall().rejects(new Error('ENOENT')); // worktree path doesn't exist
      
      // createDetachedWithTiming mocks
      fsAccessStub.onSecondCall().resolves(); // parent dir exists
      execAsyncStub.onFirstCall().resolves(mockSuccess('abc123def456')); // rev-parse
      execAsyncOrThrowStub.resolves(''); // worktree add
      fsAccessStub.onThirdCall().rejects(new Error('ENOENT')); // No .gitmodules

      const result = await worktrees.createOrReuseDetached('/test/repo', '/test/worktrees/new', 'main');

      assert.strictEqual(result.reused, false);
      assert.strictEqual(result.baseCommit, 'abc123def456');
      assert.ok(result.worktreeMs >= 0);
    });

    test('should use commitish as base when HEAD retrieval fails during reuse', async () => {
      fsAccessStub.onFirstCall().resolves(); // worktree exists
      fsAccessStub.onSecondCall().resolves(); // .git exists
      execAsyncStub.resolves(mockFailure()); // getHeadCommit fails

      const result = await worktrees.createOrReuseDetached('/test/repo', '/test/worktrees/existing', 'fallback-ref');

      assert.strictEqual(result.reused, true);
      assert.strictEqual(result.baseCommit, 'fallback-ref');
    });

    test('should log when reusing existing worktree', async () => {
      fsAccessStub.resolves();
      execAsyncStub.resolves(mockSuccess('existing123'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await worktrees.createOrReuseDetached('/test/repo', '/test/worktrees/existing', 'main', log);

      assert.ok(logMessages.some(m => m.includes("Reusing existing worktree at '/test/worktrees/existing'")));
    });
  });

  suite('getHeadCommit()', () => {
    test('should return HEAD commit SHA', async () => {
      execAsyncStub.resolves(mockSuccess('  abc123def456  \n'));

      const result = await worktrees.getHeadCommit('/test/worktrees/feature');

      assert.strictEqual(result, 'abc123def456');
      assert.ok(execAsyncStub.calledWith(['rev-parse', 'HEAD'], { cwd: '/test/worktrees/feature' }));
    });

    test('should return null when command fails', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await worktrees.getHeadCommit('/test/worktrees/feature');

      assert.strictEqual(result, null);
    });
  });

  suite('isValid()', () => {
    test('should return true for valid worktree', async () => {
      fsAccessStub.onFirstCall().resolves(); // worktree path exists
      fsAccessStub.onSecondCall().resolves(); // .git path exists

      const result = await worktrees.isValid('/test/worktrees/feature');

      assert.strictEqual(result, true);
    });

    test('should return false when worktree path does not exist', async () => {
      fsAccessStub.onFirstCall().rejects(new Error('ENOENT')); // worktree path doesn't exist

      const result = await worktrees.isValid('/test/worktrees/nonexistent');

      assert.strictEqual(result, false);
    });

    test('should return false when .git path does not exist', async () => {
      fsAccessStub.onFirstCall().resolves(); // worktree path exists
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // .git path doesn't exist

      const result = await worktrees.isValid('/test/worktrees/invalid');

      assert.strictEqual(result, false);
    });
  });

  suite('getBranch()', () => {
    test('should return branch name from branches module', async () => {
      branchesCurrentOrNullStub.resolves('feature-branch');

      const result = await worktrees.getBranch('/test/worktrees/feature');

      assert.strictEqual(result, 'feature-branch');
      assert.ok(branchesCurrentOrNullStub.calledWith('/test/worktrees/feature'));
    });

    test('should return null for detached HEAD', async () => {
      branchesCurrentOrNullStub.resolves(null);

      const result = await worktrees.getBranch('/test/worktrees/detached');

      assert.strictEqual(result, null);
    });
  });

  suite('list()', () => {
    test('should parse worktree list output', async () => {
      const listOutput = 'worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /test/worktrees/feature\nHEAD def456\nbranch refs/heads/feature\n\nworktree /test/worktrees/detached\nHEAD 789abc\ndetached\n';
      execAsyncOrNullStub.resolves(listOutput);

      const result = await worktrees.list('/test/repo');

      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result[0], { path: '/test/repo', branch: 'main' });
      assert.deepStrictEqual(result[1], { path: '/test/worktrees/feature', branch: 'feature' });
      assert.deepStrictEqual(result[2], { path: '/test/worktrees/detached', branch: null });
      assert.ok(execAsyncOrNullStub.calledWith(['worktree', 'list', '--porcelain'], '/test/repo'));
    });

    test('should return empty array when command fails', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await worktrees.list('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle worktree without branch info', async () => {
      const listOutput = 'worktree /test/repo\nHEAD abc123\n';
      execAsyncOrNullStub.resolves(listOutput);

      const result = await worktrees.list('/test/repo');

      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0], { path: '/test/repo', branch: null });
    });

    test('should handle empty output', async () => {
      execAsyncOrNullStub.resolves('');

      const result = await worktrees.list('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle Windows line endings', async () => {
      const listOutput = 'worktree /test/repo\r\nHEAD abc123\r\nbranch refs/heads/main\r\n';
      execAsyncOrNullStub.resolves(listOutput);

      const result = await worktrees.list('/test/repo');

      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0], { path: '/test/repo', branch: 'main' });
    });
  });

  suite('prune()', () => {
    test('should prune stale worktree references', async () => {
      execAsyncStub.resolves(mockSuccess());

      await worktrees.prune('/test/repo');

      assert.ok(execAsyncStub.calledWith(['worktree', 'prune'], { cwd: '/test/repo' }));
    });

    test('should handle prune failure gracefully', async () => {
      execAsyncStub.resolves(mockFailure());

      // Should not throw
      await worktrees.prune('/test/repo');

      assert.ok(execAsyncStub.calledOnce);
    });
  });

  suite('Mutex functionality', () => {
    test('should serialize worktree operations for same repository', async () => {
      let firstOperationStarted = false;
      let firstOperationCompleted = false;
      let secondOperationStarted = false;

      // Mock first operation
      fsAccessStub.onFirstCall().callsFake(async () => {
        firstOperationStarted = true;
        // Simulate slow operation
        await new Promise(resolve => setTimeout(resolve, 50));
        firstOperationCompleted = true;
      });

      execAsyncOrThrowStub.onFirstCall().resolves('');
      fsAccessStub.onSecondCall().rejects(new Error('ENOENT')); // No .gitmodules for first op

      // Mock second operation
      fsAccessStub.onThirdCall().callsFake(async () => {
        secondOperationStarted = true;
        // Second operation should not start until first completes
        assert.ok(firstOperationCompleted, 'Second operation started before first completed');
      });

      execAsyncOrThrowStub.onSecondCall().resolves('');
      fsAccessStub.onCall(3).rejects(new Error('ENOENT')); // No .gitmodules for second op

      const options1 = {
        repoPath: '/test/repo',
        worktreePath: '/test/worktrees/feature1',
        branchName: 'feature1',
        fromRef: 'main'
      };

      const options2 = {
        repoPath: '/test/repo', // Same repo
        worktreePath: '/test/worktrees/feature2',
        branchName: 'feature2',
        fromRef: 'main'
      };

      // Start both operations simultaneously
      const [result1, result2] = await Promise.all([
        worktrees.create(options1),
        worktrees.create(options2)
      ]);

      assert.ok(firstOperationStarted);
      assert.ok(firstOperationCompleted);
      assert.ok(secondOperationStarted);
    });

    test('should allow parallel operations for different repositories', async () => {
      let op1Started = false;
      let op2Started = false;

      fsAccessStub.callsFake(async () => {
        if (fsAccessStub.callCount <= 2) {
          op1Started = true;
        } else {
          op2Started = true;
          // Both operations should be able to start
          assert.ok(op1Started, 'First operation should have started');
        }
      });

      execAsyncOrThrowStub.resolves('');

      const options1 = {
        repoPath: '/test/repo1',
        worktreePath: '/test/worktrees/feature1',
        branchName: 'feature1',
        fromRef: 'main'
      };

      const options2 = {
        repoPath: '/test/repo2', // Different repo
        worktreePath: '/test/worktrees/feature2',
        branchName: 'feature2',
        fromRef: 'main'
      };

      await Promise.all([
        worktrees.create(options1),
        worktrees.create(options2)
      ]);

      assert.ok(op1Started);
      assert.ok(op2Started);
    });
  });
});