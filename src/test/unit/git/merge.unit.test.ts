import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as merge from '../../../git/core/merge';
import * as executor from '../../../git/core/executor';

/**
 * Comprehensive unit tests for git merge module.
 * Tests all functions with mocked executor and fs for 95%+ code coverage.
 */

suite('Git Core Merge Unit Tests', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;
  let fsAccessStub: sinon.SinonStub;

  setup(() => {
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
    fsAccessStub = sinon.stub(fs.promises, 'access');
  });

  teardown(() => {
    sinon.restore();
  });

  // Helper functions for creating mock objects
  function mockSuccess(stdout: string = '') {
    return { success: true, stdout, stderr: '', exitCode: 0 };
  }

  function mockFailure(stderr: string = 'command failed', stdout: string = '') {
    return { success: false, stdout, stderr, exitCode: 1 };
  }

  suite('mergeWithoutCheckout()', () => {
    test('should return successful merge with tree SHA', async () => {
      execAsyncStub.resolves(mockSuccess('abc123def456789\n'));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.treeSha, 'abc123def456789');
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
      assert.ok(execAsyncStub.calledWith(['merge-tree', '--write-tree', 'main', 'feature-branch'], { cwd: '/test/repo' }));
    });

    test('should detect conflicts from stdout', async () => {
      const conflictOutput = 'tree abc123\nCONFLICT (content): Merge conflict in file1.txt\nCONFLICT (content): Merge conflict in file2.txt';
      execAsyncStub.resolves(mockFailure('merge conflicts', conflictOutput));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.deepStrictEqual(result.conflictFiles, ['file1.txt', 'file2.txt']);
      assert.strictEqual(result.error, 'Merge conflicts in: file1.txt, file2.txt');
    });

    test('should detect conflicts from stderr', async () => {
      const conflictError = 'CONFLICT (content): Merge conflict in config.js';
      execAsyncStub.resolves(mockFailure(conflictError));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.strictEqual(result.error, 'Merge conflicts in: ');
    });

    test('should handle old git version error', async () => {
      execAsyncStub.resolves(mockFailure('git: \'merge-tree\' is not a git command'));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
      assert.strictEqual(result.error, 'git merge-tree --write-tree requires Git 2.38 or later');
    });

    test('should handle unknown option error', async () => {
      execAsyncStub.resolves(mockFailure('error: unknown option `write-tree\''));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'git merge-tree --write-tree requires Git 2.38 or later');
    });

    test('should handle generic merge failure', async () => {
      execAsyncStub.resolves(mockFailure('fatal: invalid object name'));

      const options = {
        source: 'invalid-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
      assert.strictEqual(result.error, 'fatal: invalid object name');
    });

    test('should handle empty stderr error', async () => {
      execAsyncStub.resolves(mockFailure(''));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.error, 'Merge computation failed for unknown reason');
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess('abc123def456789'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo',
        log
      };

      await merge.mergeWithoutCheckout(options);

      assert.ok(logMessages.some(m => m.includes("[merge-tree] Computing merge of 'feature-branch' into 'main'")));
      assert.ok(logMessages.some(m => m.includes('[merge-tree] ✓ Merge computed successfully, tree: abc123de')));
    });

    test('should log conflicts when logger provided', async () => {
      const conflictOutput = 'CONFLICT (content): Merge conflict in file1.txt\nCONFLICT (content): Merge conflict in file2.txt';
      execAsyncStub.resolves(mockFailure('conflicts', conflictOutput));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo',
        log
      };

      await merge.mergeWithoutCheckout(options);

      assert.ok(logMessages.some(m => m.includes('[merge-tree] ⚠ Merge has conflicts in 2 file(s)')));
    });

    test('should log old git version error when logger provided', async () => {
      execAsyncStub.resolves(mockFailure('git: \'merge-tree\' is not a git command'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo',
        log
      };

      await merge.mergeWithoutCheckout(options);

      assert.ok(logMessages.some(m => m.includes('[merge-tree] ✗ git merge-tree --write-tree not available')));
    });

    test('should log generic failure when logger provided', async () => {
      execAsyncStub.resolves(mockFailure('generic error'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo',
        log
      };

      await merge.mergeWithoutCheckout(options);

      assert.ok(logMessages.some(m => m.includes('[merge-tree] ✗ Merge failed: generic error')));
    });

    test('should handle complex conflict output format', async () => {
      const complexConflictOutput = `tree abc123
CONFLICT (content): Merge conflict in path/to/file.js
Auto-merging another/file.txt
CONFLICT (modify/delete): file3.txt deleted in HEAD and modified in feature. Version feature of file3.txt left in tree.
Some other output
CONFLICT (content): Merge conflict in final/file.md`;

      execAsyncStub.resolves(mockFailure('conflicts', complexConflictOutput));

      const options = {
        source: 'feature-branch',
        target: 'main',
        repoPath: '/test/repo'
      };

      const result = await merge.mergeWithoutCheckout(options);

      assert.strictEqual(result.hasConflicts, true);
      assert.deepStrictEqual(result.conflictFiles, ['path/to/file.js', 'file3.txt', 'final/file.md']);
    });
  });

  suite('commitTree()', () => {
    test('should create commit from tree SHA', async () => {
      execAsyncOrThrowStub.resolves('  def456789abc123  \n');

      const result = await merge.commitTree(
        'abc123def456789',
        ['parent1sha', 'parent2sha'],
        'Merge commit message',
        '/test/repo'
      );

      assert.strictEqual(result, 'def456789abc123');
      assert.ok(execAsyncOrThrowStub.calledWith([
        'commit-tree',
        'abc123def456789',
        '-p', 'parent1sha',
        '-p', 'parent2sha',
        '-m', 'Merge commit message'
      ], '/test/repo'));
    });

    test('should handle single parent', async () => {
      execAsyncOrThrowStub.resolves('newcommitsha');

      await merge.commitTree(
        'treeSha',
        ['singleParent'],
        'Commit message',
        '/test/repo'
      );

      assert.ok(execAsyncOrThrowStub.calledWith([
        'commit-tree',
        'treeSha',
        '-p', 'singleParent',
        '-m', 'Commit message'
      ], '/test/repo'));
    });

    test('should handle no parents (initial commit)', async () => {
      execAsyncOrThrowStub.resolves('initialcommit');

      await merge.commitTree(
        'treeSha',
        [],
        'Initial commit',
        '/test/repo'
      );

      assert.ok(execAsyncOrThrowStub.calledWith([
        'commit-tree',
        'treeSha',
        '-m', 'Initial commit'
      ], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('def456789abc123');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await merge.commitTree('abc123def456789', ['parent1'], 'Message', '/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[commit-tree] Creating commit from tree abc123de')));
      assert.ok(logMessages.some(m => m.includes('[commit-tree] ✓ Created commit def45678')));
    });

    test('should throw on commit tree failure', async () => {
      execAsyncOrThrowStub.rejects(new Error('Invalid tree SHA'));

      await assert.rejects(
        () => merge.commitTree('invalid', ['parent'], 'Message', '/test/repo'),
        /Invalid tree SHA/
      );
    });
  });

  suite('merge()', () => {
    test('should perform successful merge with default options', async () => {
      execAsyncStub.resolves(mockSuccess('Merge made by recursive strategy'));

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo'
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
      assert.ok(execAsyncStub.calledWith(['merge', '--no-edit', 'feature-branch'], { cwd: '/test/repo' }));
    });

    test('should use custom commit message', async () => {
      execAsyncStub.resolves(mockSuccess());

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        message: 'Custom merge message'
      };

      await merge.merge(options);

      assert.ok(execAsyncStub.calledWith(['merge', '-m', 'Custom merge message', 'feature-branch'], { cwd: '/test/repo' }));
    });

    test('should perform no-fast-forward merge', async () => {
      execAsyncStub.resolves(mockSuccess());

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        fastForward: false
      };

      await merge.merge(options);

      assert.ok(execAsyncStub.calledWith(['merge', '--no-ff', '--no-edit', 'feature-branch'], { cwd: '/test/repo' }));
    });

    test('should perform squash merge', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess()); // merge --squash
      execAsyncStub.onSecondCall().resolves(mockSuccess()); // commit

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        squash: true,
        message: 'Squashed changes'
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.success, true);
      assert.ok(execAsyncStub.firstCall.calledWith(['merge', '--squash', 'feature-branch'], { cwd: '/test/repo' }));
      assert.ok(execAsyncStub.secondCall.calledWith(['commit', '-m', 'Squashed changes'], { cwd: '/test/repo' }));
    });

    test('should handle squash merge with default message', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess());
      execAsyncStub.onSecondCall().resolves(mockSuccess());

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        squash: true
      };

      await merge.merge(options);

      assert.ok(execAsyncStub.secondCall.calledWith(['commit', '-m', "Merge branch 'feature-branch'"], { cwd: '/test/repo' }));
    });

    test('should handle squash commit failure gracefully', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess());
      execAsyncStub.onSecondCall().resolves(mockFailure('commit failed'));

      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        squash: true,
        log
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.success, true);
      assert.ok(logMessages.some(m => m.includes('[merge] ⚠ Squash commit warning: commit failed')));
    });

    test('should ignore "nothing to commit" error in squash', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess());
      execAsyncStub.onSecondCall().resolves(mockFailure('nothing to commit'));

      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        squash: true,
        log
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.success, true);
      assert.ok(!logMessages.some(m => m.includes('⚠ Squash commit warning')));
    });

    test('should perform no-commit merge', async () => {
      execAsyncStub.resolves(mockSuccess());

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        noCommit: true
      };

      await merge.merge(options);

      assert.ok(execAsyncStub.calledWith(['merge', '--no-commit', 'feature-branch'], { cwd: '/test/repo' }));
    });

    test('should handle merge conflicts', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('CONFLICT (content): Merge conflict in file.txt'));
      execAsyncOrNullStub.resolves('file1.txt\nfile2.txt'); // listConflicts

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo'
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, true);
      assert.deepStrictEqual(result.conflictFiles, ['file1.txt', 'file2.txt']);
      assert.strictEqual(result.error, 'Merge conflicts detected');
    });

    test('should handle conflicts in stdout', async () => {
      execAsyncStub.onFirstCall().resolves({ success: false, stdout: 'CONFLICT in file.js', stderr: '', exitCode: 1 });
      execAsyncOrNullStub.resolves('file.js');

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo'
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.hasConflicts, true);
    });

    test('should handle generic merge failure', async () => {
      execAsyncStub.resolves(mockFailure('fatal: refusing to merge unrelated histories'));

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo'
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.hasConflicts, false);
      assert.deepStrictEqual(result.conflictFiles, []);
      assert.strictEqual(result.error, 'fatal: refusing to merge unrelated histories');
    });

    test('should handle empty error message', async () => {
      execAsyncStub.resolves(mockFailure(''));

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo'
      };

      const result = await merge.merge(options);

      assert.strictEqual(result.error, 'Merge failed');
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        log
      };

      await merge.merge(options);

      assert.ok(logMessages.some(m => m.includes("[merge] Merging 'feature-branch' into 'main'")));
      assert.ok(logMessages.some(m => m.includes('[merge] ✓ Merge completed')));
    });

    test('should log conflicts when logger provided', async () => {
      execAsyncStub.resolves(mockFailure('CONFLICT in file.txt'));
      execAsyncOrNullStub.resolves('file.txt\nfile2.txt');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        log
      };

      await merge.merge(options);

      assert.ok(logMessages.some(m => m.includes('[merge] ⚠ Merge conflicts in 2 file(s)')));
    });

    test('should log generic failure when logger provided', async () => {
      execAsyncStub.resolves(mockFailure('merge failed'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      const options = {
        source: 'feature-branch',
        target: 'main',
        cwd: '/test/repo',
        log
      };

      await merge.merge(options);

      assert.ok(logMessages.some(m => m.includes('[merge] ✗ Merge failed: merge failed')));
    });
  });

  suite('abort()', () => {
    test('should abort merge', async () => {
      execAsyncStub.resolves(mockSuccess());

      await merge.abort('/test/repo');

      assert.ok(execAsyncStub.calledWith(['merge', '--abort'], { cwd: '/test/repo' }));
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await merge.abort('/test/repo', log);

      assert.ok(logMessages.some(m => m.includes('[merge] Aborting merge')));
    });

    test('should handle abort failure gracefully', async () => {
      execAsyncStub.resolves(mockFailure('no merge to abort'));

      // Should not throw
      await merge.abort('/test/repo');

      assert.ok(execAsyncStub.calledOnce);
    });
  });

  suite('listConflicts()', () => {
    test('should return list of conflicted files', async () => {
      execAsyncOrNullStub.resolves('file1.txt\nfile2.js\nsrc/file3.md');

      const result = await merge.listConflicts('/test/repo');

      assert.deepStrictEqual(result, ['file1.txt', 'file2.js', 'src/file3.md']);
      assert.ok(execAsyncOrNullStub.calledWith(['diff', '--name-only', '--diff-filter=U'], '/test/repo'));
    });

    test('should return empty array when no conflicts', async () => {
      execAsyncOrNullStub.resolves('');

      const result = await merge.listConflicts('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should return empty array when command fails', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await merge.listConflicts('/test/repo');

      assert.deepStrictEqual(result, []);
    });

    test('should handle Windows line endings', async () => {
      execAsyncOrNullStub.resolves('file1.txt\r\nfile2.js\r\nfile3.md');

      const result = await merge.listConflicts('/test/repo');

      assert.deepStrictEqual(result, ['file1.txt', 'file2.js', 'file3.md']);
    });

    test('should filter out empty lines', async () => {
      execAsyncOrNullStub.resolves('file1.txt\n\nfile2.js\n\n');

      const result = await merge.listConflicts('/test/repo');

      assert.deepStrictEqual(result, ['file1.txt', 'file2.js']);
    });
  });

  suite('isInProgress()', () => {
    test('should return true when merge is in progress', async () => {
      execAsyncStub.resolves(mockSuccess('.git/MERGE_HEAD'));
      fsAccessStub.resolves();

      const result = await merge.isInProgress('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.calledWith(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: '/test/repo' }));
      assert.ok(fsAccessStub.calledWith(require('path').join('/test/repo', '.git/MERGE_HEAD')));
    });

    test('should return false when MERGE_HEAD file does not exist', async () => {
      execAsyncStub.resolves(mockSuccess('.git/MERGE_HEAD'));
      fsAccessStub.rejects(new Error('ENOENT'));

      const result = await merge.isInProgress('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should return false when rev-parse fails', async () => {
      execAsyncStub.resolves(mockFailure('not in a git repository'));

      const result = await merge.isInProgress('/test/repo');

      assert.strictEqual(result, false);
    });

    test('should handle relative git path', async () => {
      execAsyncStub.resolves(mockSuccess('.git/MERGE_HEAD'));
      fsAccessStub.resolves();

      await merge.isInProgress('/test/repo');

      assert.ok(fsAccessStub.calledWith(require('path').join('/test/repo', '.git/MERGE_HEAD')));
    });

    test('should handle absolute git path', async () => {
      execAsyncStub.resolves(mockSuccess('/abs/path/.git/MERGE_HEAD'));
      fsAccessStub.resolves();

      const result = await merge.isInProgress('/test/repo');

      assert.strictEqual(result, true);
      assert.ok(fsAccessStub.calledWith(require('path').join('/test/repo', '/abs/path/.git/MERGE_HEAD')));
    });
  });

  suite('resolveBySide()', () => {
    test('should resolve conflict using "ours"', async () => {
      execAsyncOrThrowStub.onFirstCall().resolves(''); // checkout
      execAsyncOrThrowStub.onSecondCall().resolves(''); // add

      await merge.resolveBySide('file.txt', 'ours', '/test/repo');

      assert.ok(execAsyncOrThrowStub.firstCall.calledWith(['checkout', '--ours', '--', 'file.txt'], '/test/repo'));
      assert.ok(execAsyncOrThrowStub.secondCall.calledWith(['add', 'file.txt'], '/test/repo'));
    });

    test('should resolve conflict using "theirs"', async () => {
      execAsyncOrThrowStub.onFirstCall().resolves('');
      execAsyncOrThrowStub.onSecondCall().resolves('');

      await merge.resolveBySide('file.txt', 'theirs', '/test/repo');

      assert.ok(execAsyncOrThrowStub.firstCall.calledWith(['checkout', '--theirs', '--', 'file.txt'], '/test/repo'));
    });

    test('should log when logger provided', async () => {
      execAsyncOrThrowStub.resolves('');
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await merge.resolveBySide('file.txt', 'ours', '/test/repo', log);

      assert.ok(logMessages.some(m => m.includes("[merge] Resolving 'file.txt' using 'ours'")));
      assert.ok(logMessages.some(m => m.includes("[merge] ✓ Resolved 'file.txt'")));
    });

    test('should throw on checkout failure', async () => {
      execAsyncOrThrowStub.rejects(new Error('pathspec did not match'));

      await assert.rejects(
        () => merge.resolveBySide('nonexistent.txt', 'ours', '/test/repo'),
        /pathspec did not match/
      );
    });

    test('should throw on add failure', async () => {
      execAsyncOrThrowStub.onFirstCall().resolves('');
      execAsyncOrThrowStub.onSecondCall().rejects(new Error('add failed'));

      await assert.rejects(
        () => merge.resolveBySide('file.txt', 'ours', '/test/repo'),
        /add failed/
      );
    });
  });

  suite('continueAfterResolve()', () => {
    test('should commit resolved merge', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess()); // add -A
      execAsyncStub.onSecondCall().resolves(mockSuccess()); // commit

      const result = await merge.continueAfterResolve('/test/repo', 'Resolved merge conflicts');

      assert.strictEqual(result, true);
      assert.ok(execAsyncStub.firstCall.calledWith(['add', '-A'], { cwd: '/test/repo' }));
      assert.ok(execAsyncStub.secondCall.calledWith(['commit', '-m', 'Resolved merge conflicts'], { cwd: '/test/repo' }));
    });

    test('should return false when commit fails', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess()); // add -A
      execAsyncStub.onSecondCall().resolves(mockFailure('commit failed')); // commit

      const result = await merge.continueAfterResolve('/test/repo', 'Message');

      assert.strictEqual(result, false);
    });

    test('should log when logger provided', async () => {
      execAsyncStub.resolves(mockSuccess());
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await merge.continueAfterResolve('/test/repo', 'Message', log);

      assert.ok(logMessages.some(m => m.includes('[merge] Committing resolved merge')));
      assert.ok(logMessages.some(m => m.includes('[merge] ✓ Merge committed')));
    });

    test('should log failure when logger provided', async () => {
      execAsyncStub.onFirstCall().resolves(mockSuccess());
      execAsyncStub.onSecondCall().resolves(mockFailure('commit error'));
      const logMessages: string[] = [];
      const log = (msg: string) => logMessages.push(msg);

      await merge.continueAfterResolve('/test/repo', 'Message', log);

      assert.ok(logMessages.some(m => m.includes('[merge] ✗ Failed to commit: commit error')));
    });

    test('should handle add failure gracefully', async () => {
      execAsyncStub.onFirstCall().resolves(mockFailure('add failed'));
      execAsyncStub.onSecondCall().resolves(mockSuccess());

      // Should still try to commit
      await merge.continueAfterResolve('/test/repo', 'Message');

      assert.strictEqual(execAsyncStub.callCount, 2);
    });
  });
});