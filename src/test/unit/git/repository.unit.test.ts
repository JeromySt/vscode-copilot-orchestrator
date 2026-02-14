import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as repository from '../../../git/core/repository';
import * as executor from '../../../git/core/executor';

/**
 * Comprehensive unit tests for git repository module.
 * Tests all functions with mocked executor and fs for 95%+ code coverage.
 */

suite('Git Core Repository Unit Tests', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;
  let readFileStub: sinon.SinonStub;
  let writeFileStub: sinon.SinonStub;

  setup(() => {
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
    readFileStub = sinon.stub(fs.promises, 'readFile');
    writeFileStub = sinon.stub(fs.promises, 'writeFile');
  });

  teardown(() => {
    sinon.restore();
  });

  // Helper functions for creating mock objects
  function mockSuccess(stdout: string = '') {
    return { success: true, stdout, stderr: '', exitCode: 0 };
  }

  function mockFailure(stderr: string = 'command failed') {
    return { success: false, stdout: '', stderr, exitCode: 1 };
  }

  suite('fetch()', () => {
    test('should fetch from default origin', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/test/repo');

      assert.ok(execAsyncOrThrowStub.calledWith(['fetch', 'origin'], '/test/repo'));
    });

    test('should fetch from specific remote', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/test/repo', { remote: 'upstream' });

      assert.ok(execAsyncOrThrowStub.calledWith(['fetch', 'upstream'], '/test/repo'));
    });

    test('should fetch all remotes when specified', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/test/repo', { all: true });

      assert.ok(execAsyncOrThrowStub.calledWith(['fetch', '--all'], '/test/repo'));
    });

    test('should include tags when specified', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/test/repo', { tags: true });

      assert.ok(execAsyncOrThrowStub.calledWith(['fetch', '--tags', 'origin'], '/test/repo'));
    });

    test('should fetch all remotes with tags', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/test/repo', { all: true, tags: true });

      assert.ok(execAsyncOrThrowStub.calledWith(['fetch', '--all', '--tags'], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.fetch('/test/repo', { log });

      assert.ok(logMessages.some(m => m.includes('[git] Fetching from origin')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Fetch complete')));
    });

    test('should log all remotes fetch', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.fetch('/test/repo', { all: true, log });

      assert.ok(logMessages.some(m => m.includes('[git] Fetching all remotes')));
    });

    test('should throw on fetch error', async () => {
      execAsyncOrThrowStub.rejects(new Error('Network error'));

      await assert.rejects(
        () => repository.fetch('/test/repo'),
        /Network error/
      );
    });
  });

  suite('pull()', () => {
    test('should return true on successful pull', async () => {
      execAsyncStub.resolves(mockSuccess('Already up to date.'));

      const result = await repository.pull('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['pull', '--ff-only'], { cwd: '/test/repo' }));
    });

    test('should return false on pull failure', async () => {
      execAsyncStub.resolves(mockFailure('divergent branches'));

      const result = await repository.pull('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should return true when no tracking branch', async () => {
      execAsyncStub.resolves(mockFailure('no tracking information'));

      const result = await repository.pull('/test/repo');

      assert.strictEqual(result, true);
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.pull('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] Pulling changes (fast-forward only)')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Pull complete')));
    });

    test('should log failure when pull fails', async () => {
      execAsyncStub.resolves(mockFailure('merge conflict'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.pull('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] ⚠ Pull failed: merge conflict')));
    });

    test('should log when no tracking branch', async () => {
      execAsyncStub.resolves(mockFailure('no tracking information'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.pull('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] No upstream tracking branch, skipping pull')));
    });
  });

  suite('push()', () => {
    test('should return true on successful push', async () => {
      execAsyncStub.resolves(mockSuccess());

      const result = await repository.push('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['push', 'origin'], { cwd: '/test/repo' }));
    });

    test('should return false on push failure', async () => {
      execAsyncStub.resolves(mockFailure('rejected'));

      const result = await repository.push('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should push specific branch', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.push('/test/repo', { branch: 'feature' });

      assert.ok(execAsyncStub.calledWith(['push', 'origin', 'feature'], { cwd: '/test/repo' }));
    });

    test('should push with force-with-lease', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.push('/test/repo', { force: true });

      assert.ok(execAsyncStub.calledWith(['push', 'origin', '--force-with-lease'], { cwd: '/test/repo' }));
    });

    test('should push to custom remote', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.push('/test/repo', { remote: 'upstream' });

      assert.ok(execAsyncStub.calledWith(['push', 'upstream'], { cwd: '/test/repo' }));
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.push('/test/repo', { branch: 'main', log });

      assert.ok(logMessages.some(m => m.includes('[git] Pushing to origin/main')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Push complete')));
    });

    test('should log failure when push fails', async () => {
      execAsyncStub.resolves(mockFailure('rejected'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.push('/test/repo', { log });

      assert.ok(logMessages.some(m => m.includes('[git] ✗ Push failed: rejected')));
    });
  });

  suite('stageAll()', () => {
    test('should stage all changes', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.stageAll('/test/repo');

      assert.ok(execAsyncOrThrowStub.calledWith(['add', '-A'], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.stageAll('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] Staging all changes')));
    });

    test('should throw on staging error', async () => {
      execAsyncOrThrowStub.rejects(new Error('Staging failed'));

      await assert.rejects(
        () => repository.stageAll('/test/repo'),
        /Staging failed/
      );
    });
  });

  suite('commit()', () => {
    test('should return true on successful commit', async () => {
      execAsyncStub.resolves(mockSuccess('[main abc123] Test commit'));

      const result = await repository.commit('/test/repo', 'Test commit');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['commit', '-m', 'Test commit'], { cwd: '/test/repo' }));
    });

    test('should return false on commit failure', async () => {
      execAsyncStub.resolves(mockFailure('commit failed'));

      const result = await repository.commit('/test/repo', 'Test commit');

      assert.strictEqual(result, false);
    });

    test('should return true when nothing to commit (stdout)', async () => {
      execAsyncStub.resolves({ success: false, stdout: 'nothing to commit, working tree clean', stderr: '', exitCode: 1 });

      const result = await repository.commit('/test/repo', 'Test commit');

      assert.strictEqual(result, true);
    });

    test('should return true when nothing to commit (stderr)', async () => {
      execAsyncStub.resolves({ success: false, stdout: '', stderr: 'nothing to commit', exitCode: 1 });

      const result = await repository.commit('/test/repo', 'Test commit');

      assert.strictEqual(result, true);
    });

    test('should allow empty commits when specified', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.commit('/test/repo', 'Empty commit', { allowEmpty: true });

      assert.ok(execAsyncStub.calledWith(['commit', '-m', 'Empty commit', '--allow-empty'], { cwd: '/test/repo' }));
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.commit('/test/repo', 'Test', { log });

      assert.ok(logMessages.some(m => m.includes('[git] Creating commit')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Committed')));
    });

    test('should log when nothing to commit', async () => {
      execAsyncStub.resolves({ success: false, stdout: 'nothing to commit', stderr: '', exitCode: 1 });
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.commit('/test/repo', 'Test', { log });

      assert.ok(logMessages.some(m => m.includes('[git] Nothing to commit')));
    });

    test('should log failure', async () => {
      execAsyncStub.resolves(mockFailure('commit error'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.commit('/test/repo', 'Test', { log });

      assert.ok(logMessages.some(m => m.includes('[git] ✗ Commit failed: commit error')));
    });
  });

  suite('hasChanges()', () => {
    test('should return true when there are changes', async () => {
      execAsyncStub.resolves(mockSuccess('M file.txt\nA new-file.txt'));

      const result = await repository.hasChanges('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['status', '--porcelain'], { cwd: '/test/repo' }));
    });

    test('should return false when there are no changes', async () => {
      execAsyncStub.resolves(mockSuccess(''));

      const result = await repository.hasChanges('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should return false on command failure', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await repository.hasChanges('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should handle whitespace-only output', async () => {
      execAsyncStub.resolves(mockSuccess('   \n   '));

      const result = await repository.hasChanges('/test/repo');

      assert.strictEqual(result, false);
    });
  });

  suite('hasStagedChanges()', () => {
    test('should return true when there are staged changes', async () => {
      execAsyncStub.resolves(mockSuccess('file.txt\nnew-file.txt'));

      const result = await repository.hasStagedChanges('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['diff', '--cached', '--name-only'], { cwd: '/test/repo' }));
    });

    test('should return false when there are no staged changes', async () => {
      execAsyncStub.resolves(mockSuccess(''));

      const result = await repository.hasStagedChanges('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should return false on command failure', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await repository.hasStagedChanges('/test/repo');

      assert.strictEqual(result, false);
    });
  });

  suite('getHead()', () => {
    test('should return HEAD commit hash', async () => {
      execAsyncOrNullStub.resolves('abc123def456');

      const result = await repository.getHead('/test/repo');

      assert.strictEqual(result, 'abc123def456');
      assert.ok(execAsyncOrNullStub.calledWith(['rev-parse', 'HEAD'], '/test/repo'));
    });

    test('should return null when command fails', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getHead('/test/repo');

      assert.strictEqual(result, null);
    });
  });

  suite('resolveRef()', () => {
    test('should resolve ref to commit hash', async () => {
      execAsyncOrThrowStub.resolves('  abc123def456  \n');

      const result = await repository.resolveRef('main', '/test/repo');

      assert.strictEqual(result, 'abc123def456');
      assert.ok(execAsyncOrThrowStub.calledWith(['rev-parse', 'main'], '/test/repo'));
    });

    test('should throw on invalid ref', async () => {
      execAsyncOrThrowStub.rejects(new Error('ambiguous argument'));

      await assert.rejects(
        () => repository.resolveRef('invalid-ref', '/test/repo'),
        /ambiguous argument/
      );
    });
  });

  suite('getCommitLog()', () => {
    test('should return parsed commit log', async () => {
      const logOutput = 'abc123|abc|John Doe|2023-01-01 12:00:00 +0000|First commit\ndef456|def|Jane Smith|2023-01-02 12:00:00 +0000|Second commit';
      execAsyncOrNullStub.resolves(logOutput);

      const result = await repository.getCommitLog('main~2', 'main', '/test/repo');

      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result[0], {
        hash: 'abc123',
        shortHash: 'abc',
        author: 'John Doe',
        date: '2023-01-01 12:00:00 +0000',
        message: 'First commit'
      });
      assert.deepStrictEqual(result[1], {
        hash: 'def456',
        shortHash: 'def',
        author: 'Jane Smith',
        date: '2023-01-02 12:00:00 +0000',
        message: 'Second commit'
      });
      assert.ok(execAsyncOrNullStub.calledWith(['log', 'main~2..main', '--pretty=format:%H|%h|%an|%ai|%s', '--reverse'], '/test/repo'));
    });

    test('should handle commit messages with pipes', async () => {
      const logOutput = 'abc123|abc|John|2023-01-01|Message with | pipe chars';
      execAsyncOrNullStub.resolves(logOutput);

      const result = await repository.getCommitLog('HEAD~1', 'HEAD', '/test/repo');

      assert.strictEqual(result[0].message, 'Message with | pipe chars');
    });

    test('should return empty array when no commits', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getCommitLog('HEAD~1', 'HEAD', '/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle Windows line endings', async () => {
      const logOutput = 'abc123|abc|John|2023-01-01|First\r\ndef456|def|Jane|2023-01-02|Second';
      execAsyncOrNullStub.resolves(logOutput);

      const result = await repository.getCommitLog('HEAD~2', 'HEAD', '/test/repo');

      assert.strictEqual(result.length, 2);
    });

    test('should filter out empty lines', async () => {
      const logOutput = 'abc123|abc|John|2023-01-01|First\n\n\ndef456|def|Jane|2023-01-02|Second\n';
      execAsyncOrNullStub.resolves(logOutput);

      const result = await repository.getCommitLog('HEAD~2', 'HEAD', '/test/repo');

      assert.strictEqual(result.length, 2);
    });
  });

  suite('getCommitChanges()', () => {
    test('should return parsed file changes', async () => {
      const diffOutput = 'A\tfile1.txt\nM\tfile2.txt\nD\tfile3.txt\nR\toldname.txt\tnewname.txt\nC\tcopy1.txt\tcopy2.txt';
      execAsyncOrNullStub.resolves(diffOutput);

      const result = await repository.getCommitChanges('abc123', '/test/repo');

      assert.strictEqual(result.length, 5);
      assert.deepStrictEqual(result[0], { status: 'added', path: 'file1.txt' });
      assert.deepStrictEqual(result[1], { status: 'modified', path: 'file2.txt' });
      assert.deepStrictEqual(result[2], { status: 'deleted', path: 'file3.txt' });
      assert.deepStrictEqual(result[3], { status: 'renamed', path: 'oldname.txt\tnewname.txt' });
      assert.deepStrictEqual(result[4], { status: 'copied', path: 'copy1.txt\tcopy2.txt' });
      assert.ok(execAsyncOrNullStub.calledWith(['diff-tree', '--no-commit-id', '--name-status', '-r', 'abc123'], '/test/repo'));
    });

    test('should handle unknown status codes', async () => {
      const diffOutput = 'X\tunknown.txt';
      execAsyncOrNullStub.resolves(diffOutput);

      const result = await repository.getCommitChanges('abc123', '/test/repo');

      assert.deepStrictEqual(result[0], { status: 'modified', path: 'unknown.txt' });
    });

    test('should return empty array when no changes', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getCommitChanges('abc123', '/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle file paths with tabs', async () => {
      const diffOutput = 'M\tfile with\ttabs.txt';
      execAsyncOrNullStub.resolves(diffOutput);

      const result = await repository.getCommitChanges('abc123', '/test/repo');

      assert.strictEqual(result[0].path, 'file with\ttabs.txt');
    });
  });

  suite('getDiffStats()', () => {
    test('should return diff statistics', async () => {
      const diffOutput = 'A\tfile1.txt\nM\tfile2.txt\nD\tfile3.txt\nR\toldfile.txt\tnewfile.txt\nC\tcopy1.txt\tcopy2.txt';
      execAsyncOrNullStub.resolves(diffOutput);

      const result = await repository.getDiffStats('main~1', 'main', '/test/repo');

      assert.deepStrictEqual(result, { added: 2, modified: 2, deleted: 1 });
      assert.ok(execAsyncOrNullStub.calledWith(['diff', '--name-status', 'main~1', 'main'], '/test/repo'));
    });

    test('should handle empty diff', async () => {
      execAsyncOrNullStub.resolves('');

      const result = await repository.getDiffStats('HEAD', 'HEAD', '/test/repo');

      assert.deepStrictEqual(result, { added: 0, modified: 0, deleted: 0 });
    });

    test('should handle null result', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getDiffStats('invalid', 'refs', '/test/repo');

      assert.deepStrictEqual(result, { added: 0, modified: 0, deleted: 0 });
    });

    test('should handle unknown status codes', async () => {
      const diffOutput = 'X\tunknown.txt\nY\tanother.txt';
      execAsyncOrNullStub.resolves(diffOutput);

      const result = await repository.getDiffStats('HEAD~1', 'HEAD', '/test/repo');

      assert.deepStrictEqual(result, { added: 0, modified: 0, deleted: 0 });
    });
  });

  suite('ensureGitignore()', () => {
    test('should create .gitignore with patterns', async () => {
      readFileStub.rejects(new Error('ENOENT')); // File doesn't exist
      writeFileStub.resolves();

      await repository.ensureGitignore('/test/repo', ['.orchestrator/', '.worktrees/']);

      assert.ok(writeFileStub.calledOnce);
      const content = writeFileStub.getCall(0).args[1] as string;
      assert.ok(content.includes('# Copilot Orchestrator'));
      assert.ok(content.includes('.orchestrator/'));
      assert.ok(content.includes('.worktrees/'));
    });

    test('should append to existing .gitignore', async () => {
      readFileStub.resolves('node_modules/\n');
      writeFileStub.resolves();

      await repository.ensureGitignore('/test/repo', ['.orchestrator/']);

      assert.ok(writeFileStub.calledOnce);
      const content = writeFileStub.getCall(0).args[1] as string;
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('.orchestrator/'));
    });

    test('should not modify if patterns already exist', async () => {
      readFileStub.resolves('node_modules/\n.orchestrator/\n.worktrees/\n');
      writeFileStub.resolves();

      await repository.ensureGitignore('/test/repo', ['.orchestrator/', '.worktrees/']);

      assert.ok(writeFileStub.notCalled);
    });

    test('should handle patterns without leading slash', async () => {
      readFileStub.resolves('orchestrator/\n'); // pattern without slash exists
      writeFileStub.resolves();

      await repository.ensureGitignore('/test/repo', ['/orchestrator/']); // pattern with slash

      assert.ok(writeFileStub.notCalled); // Should detect existing pattern
    });

    test('should add newline to file without trailing newline', async () => {
      readFileStub.resolves('node_modules/'); // No trailing newline
      writeFileStub.resolves();

      await repository.ensureGitignore('/test/repo', ['.orchestrator/']);

      const content = writeFileStub.getCall(0).args[1] as string;
      assert.ok(content.startsWith('node_modules/\n'));
    });

    test('should log when patterns added', async () => {
      readFileStub.rejects(new Error('ENOENT'));
      writeFileStub.resolves();
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.ensureGitignore('/test/repo', ['.orchestrator/'], log);

      assert.ok(logMessages.some(m => m.includes('[git] Updated .gitignore with orchestrator directories')));
    });

    test('should log error on write failure', async () => {
      readFileStub.rejects(new Error('ENOENT'));
      writeFileStub.rejects(new Error('Permission denied'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.ensureGitignore('/test/repo', ['.orchestrator/'], log);

      assert.ok(logMessages.some(m => m.includes('[git] ⚠ Could not update .gitignore')));
    });
  });

  suite('hasUncommittedChanges()', () => {
    test('should return true when there are uncommitted changes', async () => {
      execAsyncStub.resolves(mockSuccess('M file.txt'));

      const result = await repository.hasUncommittedChanges('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['status', '--porcelain'], { cwd: '/test/repo' }));
    });

    test('should return false when working directory is clean', async () => {
      execAsyncStub.resolves(mockSuccess(''));

      const result = await repository.hasUncommittedChanges('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should return false on command failure', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await repository.hasUncommittedChanges('/test/repo');

      assert.strictEqual(result, false);
    });
  });

  suite('getDirtyFiles()', () => {
    test('should return list of dirty files', async () => {
      execAsyncStub.resolves(mockSuccess('M  file1.txt\nA  file2.txt\n D file3.txt'));

      const result = await repository.getDirtyFiles('/test/repo');

      assert.deepStrictEqual(result, ['file1.txt', 'file2.txt', 'file3.txt']);
    });

    test('should handle renamed files', async () => {
      execAsyncStub.resolves(mockSuccess('R  old.txt -> new.txt'));

      const result = await repository.getDirtyFiles('/test/repo');

      assert.deepStrictEqual(result, ['new.txt']);
    });

    test('should return empty array when no changes', async () => {
      execAsyncStub.resolves(mockSuccess(''));

      const result = await repository.getDirtyFiles('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should return empty array on command failure', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await repository.getDirtyFiles('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle files with spaces', async () => {
      execAsyncStub.resolves(mockSuccess('M  "file with spaces.txt"'));

      const result = await repository.getDirtyFiles('/test/repo');

      assert.deepStrictEqual(result, ['"file with spaces.txt"']);
    });
  });

  suite('stashPush()', () => {
    test('should return true when changes are stashed', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess('M file.txt')); // hasUncommittedChanges
      execAsyncStub.onSecondCall().resolves(mockSuccess('Saved working directory'));

      const result = await repository.stashPush('/test/repo', 'test stash');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['stash', 'push', '-m', 'test stash'], { cwd: '/test/repo' }));
    });

    test('should return false when nothing to stash', async () => {
      execAsyncStub.resolves(mockSuccess('')); // No changes

      const result = await repository.stashPush('/test/repo', 'test stash');

      assert.strictEqual(result, false);
      assert.strictEqual(execAsyncStub.callCount, 1); // Only called hasUncommittedChanges
    });

    test('should throw on stash failure', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess('M file.txt'));
      execAsyncStub.onSecondCall().resolves(mockFailure('stash failed'));

      await assert.rejects(
        () => repository.stashPush('/test/repo', 'test stash'),
        /Failed to stash changes: stash failed/
      );
    });

    test('should log when logger provided', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess('M file.txt'));
      execAsyncStub.onSecondCall().resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.stashPush('/test/repo', 'test stash', log);

      assert.ok(logMessages.some(m => m.includes('[git] Stashing changes: test stash')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Changes stashed')));
    });

    test('should log when nothing to stash', async () => {
      execAsyncStub.resolves(mockSuccess(''));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.stashPush('/test/repo', 'test stash', log);

      assert.ok(logMessages.some(m => m.includes('[git] Nothing to stash')));
    });
  });

  suite('stashPop()', () => {
    test('should return true when stash is popped', async () => {
      execAsyncStub.resolves(mockSuccess('Dropped refs/stash@{0}'));

      const result = await repository.stashPop('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['stash', 'pop'], { cwd: '/test/repo' }));
    });

    test('should return false when no stash entries', async () => {
      execAsyncStub.resolves(mockFailure('No stash entries found'));

      const result = await repository.stashPop('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should throw on other stash pop failures', async () => {
      execAsyncStub.resolves(mockFailure('merge conflict'));

      await assert.rejects(
        () => repository.stashPop('/test/repo'),
        /Failed to pop stash: merge conflict/
      );
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.stashPop('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] Popping stash')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Stash popped')));
    });

    test('should log when no stash to pop', async () => {
      execAsyncStub.resolves(mockFailure('No stash entries found'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.stashPop('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] No stash to pop')));
    });
  });

  suite('stashDrop()', () => {
    test('should return true when stash is dropped', async () => {
      execAsyncStub.resolves(mockSuccess('Dropped refs/stash@{0}'));

      const result = await repository.stashDrop('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['stash', 'drop'], { cwd: '/test/repo' }));
    });

    test('should drop specific stash by index', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.stashDrop('/test/repo', 2);

      assert.ok(execAsyncStub.calledWith(['stash', 'drop', 'stash@{2}'], { cwd: '/test/repo' }));
    });

    test('should return false when no stash entries', async () => {
      execAsyncStub.resolves(mockFailure('No stash entries found'));

      const result = await repository.stashDrop('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should throw on other drop failures', async () => {
      execAsyncStub.resolves(mockFailure('invalid stash'));

      await assert.rejects(
        () => repository.stashDrop('/test/repo'),
        /Failed to drop stash: invalid stash/
      );
    });
  });

  suite('checkoutFile()', () => {
    test('should checkout file successfully', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.checkoutFile('/test/repo', 'file.txt');

      assert.ok(execAsyncStub.calledWith(['checkout', '--', 'file.txt'], { cwd: '/test/repo' }));
    });

    test('should throw on checkout failure', async () => {
      execAsyncStub.resolves(mockFailure('pathspec did not match'));

      await assert.rejects(
        () => repository.checkoutFile('/test/repo', 'nonexistent.txt'),
        /Failed to checkout file nonexistent.txt: pathspec did not match/
      );
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.checkoutFile('/test/repo', 'file.txt', log);

      assert.ok(logMessages.some(m => m.includes('[git] Checking out (discarding changes to): file.txt')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ File checked out: file.txt')));
    });
  });

  suite('resetHard()', () => {
    test('should reset to ref successfully', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.resetHard('/test/repo', 'HEAD~1');

      assert.ok(execAsyncStub.calledWith(['reset', '--hard', 'HEAD~1'], { cwd: '/test/repo' }));
    });

    test('should throw on reset failure', async () => {
      execAsyncStub.resolves(mockFailure('ambiguous argument'));

      await assert.rejects(
        () => repository.resetHard('/test/repo', 'invalid-ref'),
        /Failed to reset to invalid-ref: ambiguous argument/
      );
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.resetHard('/test/repo', 'main', log);

      assert.ok(logMessages.some(m => m.includes('[git] Resetting to main (hard)')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Reset to main')));
    });
  });

  suite('updateRef()', () => {
    test('should update ref successfully', async () => {
      execAsyncStub.resolves(mockSuccess());

      await repository.updateRef('/test/repo', 'refs/heads/feature', 'abc123');

      assert.ok(execAsyncStub.calledWith(['update-ref', 'refs/heads/feature', 'abc123'], { cwd: '/test/repo' }));
    });

    test('should throw on update failure', async () => {
      execAsyncStub.resolves(mockFailure('invalid object name'));

      await assert.rejects(
        () => repository.updateRef('/test/repo', 'refs/heads/feature', 'invalid'),
        /Failed to update ref refs\/heads\/feature: invalid object name/
      );
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.updateRef('/test/repo', 'refs/heads/test', 'abc123', log);

      assert.ok(logMessages.some(m => m.includes('[git] Updating ref refs/heads/test to abc123')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Updated refs/heads/test to abc123')));
    });
  });

  suite('stashList()', () => {
    test('should return list of stashes', async () => {
      execAsyncOrNullStub.resolves('stash@{0}: On main: Work in progress\nstash@{1}: On feature: WIP');

      const result = await repository.stashList('/test/repo');

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0], 'stash@{0}: On main: Work in progress');
      assert.strictEqual(result[1], 'stash@{1}: On feature: WIP');
      assert.ok(execAsyncOrNullStub.calledWith(['stash', 'list'], '/test/repo'));
    });

    test('should return empty array when no stashes', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.stashList('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle Windows line endings', async () => {
      execAsyncOrNullStub.resolves('stash@{0}: First\r\nstash@{1}: Second');

      const result = await repository.stashList('/test/repo');

      assert.strictEqual(result.length, 2);
    });

    test('should filter out empty lines', async () => {
      execAsyncOrNullStub.resolves('stash@{0}: First\n\nstash@{1}: Second\n');

      const result = await repository.stashList('/test/repo');

      assert.strictEqual(result.length, 2);
    });
  });

  suite('getIgnoredFiles()', () => {
    test('should return list of ignored files', async () => {
      execAsyncStub.resolves(mockSuccess('!! .DS_Store\n!! node_modules/package.json\n!! build/'));

      const result = await repository.getIgnoredFiles('/test/repo');

      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result, ['.DS_Store', 'node_modules/package.json', 'build/']);
      assert.ok(execAsyncStub.calledWith(['status', '--ignored', '--short'], { cwd: '/test/repo' }));
    });

    test('should return empty array when no ignored files', async () => {
      execAsyncStub.resolves(mockSuccess(''));

      const result = await repository.getIgnoredFiles('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should return empty array on command failure', async () => {
      execAsyncStub.resolves(mockFailure());

      const result = await repository.getIgnoredFiles('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should filter out non-ignored status lines', async () => {
      execAsyncStub.resolves(mockSuccess('M  modified.txt\n!! ignored.txt\nA  added.txt\n!! another-ignored.txt'));

      const result = await repository.getIgnoredFiles('/test/repo');

      assert.deepStrictEqual(result, ['ignored.txt', 'another-ignored.txt']);
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess('!! ignored.txt'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.getIgnoredFiles('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] Getting ignored files')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Found 1 ignored files')));
    });

    test('should log when no ignored files found', async () => {
      execAsyncStub.resolves(mockSuccess(''));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await repository.getIgnoredFiles('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[git] ✓ No ignored files found')));
    });
  });

  suite('stageFile()', () => {
    test('should stage a file', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '' });
      await repository.stageFile('/test/repo', 'file.txt');
      assert.ok(execAsyncStub.calledOnce);
      assert.deepStrictEqual(execAsyncStub.firstCall.args[0], ['add', 'file.txt']);
    });
  });

  suite('getFileDiff()', () => {
    test('should return diff for a file', async () => {
      execAsyncOrNullStub.resolves('diff output');
      const result = await repository.getFileDiff('/test/repo', 'file.txt');
      assert.strictEqual(result, 'diff output');
    });

    test('should return null when no diff', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await repository.getFileDiff('/test/repo', 'file.txt');
      assert.strictEqual(result, null);
    });
  });

  suite('getStagedFileDiff()', () => {
    test('should return staged diff for a file', async () => {
      execAsyncOrNullStub.resolves('staged diff');
      const result = await repository.getStagedFileDiff('/test/repo', 'file.txt');
      assert.strictEqual(result, 'staged diff');
      assert.deepStrictEqual(execAsyncOrNullStub.firstCall.args[0], ['diff', '--cached', 'file.txt']);
    });
  });

  suite('stashShowFiles()', () => {
    test('should return list of stash files', async () => {
      execAsyncOrNullStub.resolves('file1.txt\nfile2.txt\n');
      const result = await repository.stashShowFiles('/test/repo');
      assert.deepStrictEqual(result, ['file1.txt', 'file2.txt']);
    });

    test('should return empty array when null', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await repository.stashShowFiles('/test/repo');
      assert.deepStrictEqual(result, []);
    });
  });

  suite('stashShowPatch()', () => {
    test('should return patch content', async () => {
      execAsyncOrNullStub.resolves('patch content');
      const result = await repository.stashShowPatch('/test/repo');
      assert.strictEqual(result, 'patch content');
    });
  });

  suite('hasChangesBetween()', () => {
    test('should return true when changes exist', async () => {
      execAsyncOrNullStub.resolves('A\tfile1.txt\nM\tfile2.txt\n');
      const result = await repository.hasChangesBetween('abc', 'def', '/test/repo');
      assert.strictEqual(result, true);
    });

    test('should return false when no changes', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await repository.hasChangesBetween('abc', 'def', '/test/repo');
      assert.strictEqual(result, false);
    });
  });

  suite('clean()', () => {
    test('should clean successfully', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '' });
      await repository.clean('/test/repo');
      assert.deepStrictEqual(execAsyncStub.firstCall.args[0], ['clean', '-fd']);
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '' });
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);
      await repository.clean('/test/repo', log);
      assert.ok(logMessages.some(m => m.includes('Cleaning untracked files')));
      assert.ok(logMessages.some(m => m.includes('Clean complete')));
    });

    test('should throw on failure', async () => {
      execAsyncStub.resolves({ success: false, stdout: '', stderr: 'error' });
      await assert.rejects(() => repository.clean('/test/repo'), /Failed to clean/);
    });
  });

  suite('getCommitCount()', () => {
    test('should return commit count', async () => {
      execAsyncOrNullStub.resolves('5\n');
      const result = await repository.getCommitCount('abc', 'def', '/test/repo');
      assert.strictEqual(result, 5);
    });

    test('should return 0 when null', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await repository.getCommitCount('abc', 'def', '/test/repo');
      assert.strictEqual(result, 0);
    });
  });

  suite('getFileChangesBetween()', () => {
    test('should parse file changes', async () => {
      execAsyncOrNullStub.resolves('A\tfile1.txt\nM\tfile2.txt\nD\tfile3.txt\n');
      const result = await repository.getFileChangesBetween('abc', 'def', '/test/repo');
      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result[0], { status: 'added', path: 'file1.txt' });
      assert.deepStrictEqual(result[1], { status: 'modified', path: 'file2.txt' });
      assert.deepStrictEqual(result[2], { status: 'deleted', path: 'file3.txt' });
    });

    test('should return empty array when null', async () => {
      execAsyncOrNullStub.resolves(null);
      const result = await repository.getFileChangesBetween('abc', 'def', '/test/repo');
      assert.deepStrictEqual(result, []);
    });

    test('should handle unknown status as modified', async () => {
      execAsyncOrNullStub.resolves('X\tunknown.txt\n');
      const result = await repository.getFileChangesBetween('abc', 'def', '/test/repo');
      assert.deepStrictEqual(result[0], { status: 'modified', path: 'unknown.txt' });
    });
  });
});