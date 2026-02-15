/**
 * @fileoverview Unit tests for DefaultGitOperations
 * 
 * Tests verify proper delegation to underlying git core modules.
 * Uses simple pass-through tests since DefaultGitOperations is a delegation layer.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { DefaultGitOperations } from '../../../git/DefaultGitOperations';
import * as branches from '../../../git/core/branches';
import * as worktrees from '../../../git/core/worktrees';
import * as merge from '../../../git/core/merge';
import * as repository from '../../../git/core/repository';
import * as gitignore from '../../../git/core/gitignore';

suite('DefaultGitOperations', () => {
  let sandbox: sinon.SinonSandbox;
  let gitOps: DefaultGitOperations;

  setup(() => {
    sandbox = sinon.createSandbox();
    gitOps = new DefaultGitOperations();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('DefaultGitBranches', () => {
    test('isDefaultBranch delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'isDefaultBranch').resolves(true);
      const result = await gitOps.branches.isDefaultBranch('main', '/repo');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('main', '/repo'));
    });

    test('exists delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'exists').resolves(false);
      const result = await gitOps.branches.exists('feature', '/repo');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('feature', '/repo'));
    });

    test('remoteExists delegates with optional remote', async () => {
      const stub = sandbox.stub(branches, 'remoteExists').resolves(true);
      const result = await gitOps.branches.remoteExists('feature', '/repo', 'origin');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('feature', '/repo', 'origin'));
    });

    test('current delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'current').resolves('main');
      const result = await gitOps.branches.current('/repo');
      assert.strictEqual(result, 'main');
      assert.ok(stub.calledWith('/repo'));
    });

    test('currentOrNull delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'currentOrNull').resolves(null);
      const result = await gitOps.branches.currentOrNull('/repo');
      assert.strictEqual(result, null);
      assert.ok(stub.calledWith('/repo'));
    });

    test('create delegates with all parameters', async () => {
      const stub = sandbox.stub(branches, 'create').resolves();
      await gitOps.branches.create('feature', 'main', '/repo');
      assert.ok(stub.calledWith('feature', 'main', '/repo'));
    });

    test('createOrReset delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'createOrReset').resolves();
      await gitOps.branches.createOrReset('feature', 'main', '/repo');
      assert.ok(stub.calledWith('feature', 'main', '/repo'));
    });

    test('checkout delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'checkout').resolves();
      await gitOps.branches.checkout('/repo', 'feature');
      assert.ok(stub.calledWith('/repo', 'feature'));
    });

    test('list delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'list').resolves(['main', 'feature']);
      const result = await gitOps.branches.list('/repo');
      assert.deepStrictEqual(result, ['main', 'feature']);
      assert.ok(stub.calledWith('/repo'));
    });

    test('getCommit delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'getCommit').resolves('abc123');
      const result = await gitOps.branches.getCommit('main', '/repo');
      assert.strictEqual(result, 'abc123');
      assert.ok(stub.calledWith('main', '/repo'));
    });

    test('getMergeBase delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'getMergeBase').resolves('def456');
      const result = await gitOps.branches.getMergeBase('main', 'feature', '/repo');
      assert.strictEqual(result, 'def456');
      assert.ok(stub.calledWith('main', 'feature', '/repo'));
    });

    test('remove delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'remove').resolves();
      await gitOps.branches.remove('feature', '/repo');
      assert.ok(stub.calledWith('feature', '/repo'));
    });

    test('deleteLocal delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'deleteLocal').resolves(true);
      const result = await gitOps.branches.deleteLocal('/repo', 'feature');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('/repo', 'feature'));
    });

    test('deleteRemote delegates to branches module', async () => {
      const stub = sandbox.stub(branches, 'deleteRemote').resolves(false);
      const result = await gitOps.branches.deleteRemote('/repo', 'feature');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('/repo', 'feature'));
    });
  });

  suite('DefaultGitWorktrees', () => {
    test('create delegates to worktrees module', async () => {
      const stub = sandbox.stub(worktrees, 'create').resolves();
      const options = { repoPath: '/repo', worktreePath: '/wt', branchName: 'main', fromRef: 'HEAD' };
      await gitOps.worktrees.create(options);
      assert.ok(stub.calledWith(options));
    });

    test('createWithTiming delegates to worktrees module', async () => {
      const timing = { worktreeMs: 100, submoduleMs: 50, totalMs: 150 };
      const stub = sandbox.stub(worktrees, 'createWithTiming').resolves(timing);
      const options = { repoPath: '/repo', worktreePath: '/wt', branchName: 'main', fromRef: 'HEAD' };
      const result = await gitOps.worktrees.createWithTiming(options);
      assert.deepStrictEqual(result, timing);
      assert.ok(stub.calledWith(options));
    });

    test('remove delegates to worktrees module', async () => {
      const stub = sandbox.stub(worktrees, 'remove').resolves();
      await gitOps.worktrees.remove('/wt', '/repo');
      assert.ok(stub.calledWith('/wt', '/repo'));
    });

    test('isValid delegates to worktrees module', async () => {
      const stub = sandbox.stub(worktrees, 'isValid').resolves(false);
      const result = await gitOps.worktrees.isValid('/wt');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('/wt'));
    });

    test('getBranch delegates to worktrees module', async () => {
      const stub = sandbox.stub(worktrees, 'getBranch').resolves('feature');
      const result = await gitOps.worktrees.getBranch('/wt');
      assert.strictEqual(result, 'feature');
      assert.ok(stub.calledWith('/wt'));
    });

    test('getHeadCommit delegates to worktrees module', async () => {
      const stub = sandbox.stub(worktrees, 'getHeadCommit').resolves('abc123');
      const result = await gitOps.worktrees.getHeadCommit('/wt');
      assert.strictEqual(result, 'abc123');
      assert.ok(stub.calledWith('/wt'));
    });

    test('list delegates to worktrees module', async () => {
      const list = [{ path: '/wt1', branch: 'main' }, { path: '/wt2', branch: null }];
      const stub = sandbox.stub(worktrees, 'list').resolves(list);
      const result = await gitOps.worktrees.list('/repo');
      assert.deepStrictEqual(result, list);
      assert.ok(stub.calledWith('/repo'));
    });

    test('prune delegates to worktrees module', async () => {
      const stub = sandbox.stub(worktrees, 'prune').resolves();
      await gitOps.worktrees.prune('/repo');
      assert.ok(stub.calledWith('/repo'));
    });
  });

  suite('DefaultGitMerge', () => {
    test('merge delegates to merge module', async () => {
      const mergeResult = { success: true, hasConflicts: false, conflictFiles: [] };
      const stub = sandbox.stub(merge, 'merge').resolves(mergeResult);
      const options = { source: 'feature', target: 'main', cwd: '/repo' };
      const result = await gitOps.merge.merge(options);
      assert.deepStrictEqual(result, mergeResult);
      assert.ok(stub.calledWith(options));
    });

    test('abort delegates to merge module', async () => {
      const stub = sandbox.stub(merge, 'abort').resolves();
      await gitOps.merge.abort('/repo');
      assert.ok(stub.calledWith('/repo'));
    });

    test('listConflicts delegates to merge module', async () => {
      const conflicts = ['file1.ts', 'file2.ts'];
      const stub = sandbox.stub(merge, 'listConflicts').resolves(conflicts);
      const result = await gitOps.merge.listConflicts('/repo');
      assert.deepStrictEqual(result, conflicts);
      assert.ok(stub.calledWith('/repo'));
    });

    test('isInProgress delegates to merge module', async () => {
      const stub = sandbox.stub(merge, 'isInProgress').resolves(true);
      const result = await gitOps.merge.isInProgress('/repo');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('/repo'));
    });
  });

  suite('DefaultGitRepository', () => {
    test('fetch delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'fetch').resolves();
      await gitOps.repository.fetch('/repo');
      assert.ok(stub.calledWith('/repo'));
    });

    test('pull delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'pull').resolves(true);
      const result = await gitOps.repository.pull('/repo');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('/repo'));
    });

    test('push delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'push').resolves(false);
      const result = await gitOps.repository.push('/repo');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('/repo'));
    });

    test('stageAll delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'stageAll').resolves();
      await gitOps.repository.stageAll('/repo');
      assert.ok(stub.calledWith('/repo'));
    });

    test('stageFile delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'stageFile').resolves();
      await gitOps.repository.stageFile('/repo', 'file.ts');
      assert.ok(stub.calledWith('/repo', 'file.ts'));
    });

    test('commit delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'commit').resolves(true);
      const result = await gitOps.repository.commit('/repo', 'message');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('/repo', 'message'));
    });

    test('hasChanges delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'hasChanges').resolves(false);
      const result = await gitOps.repository.hasChanges('/repo');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('/repo'));
    });

    test('getHead delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'getHead').resolves('abc123');
      const result = await gitOps.repository.getHead('/repo');
      assert.strictEqual(result, 'abc123');
      assert.ok(stub.calledWith('/repo'));
    });

    test('resolveRef delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'resolveRef').resolves('def456');
      const result = await gitOps.repository.resolveRef('main', '/repo');
      assert.strictEqual(result, 'def456');
      assert.ok(stub.calledWith('main', '/repo'));
    });

    test('getDiffStats delegates to repository module', async () => {
      const stats = { added: 1, modified: 2, deleted: 0 };
      const stub = sandbox.stub(repository, 'getDiffStats').resolves(stats);
      const result = await gitOps.repository.getDiffStats('from', 'to', '/repo');
      assert.deepStrictEqual(result, stats);
      assert.ok(stub.calledWith('from', 'to', '/repo'));
    });

    test('getFileDiff delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'getFileDiff').resolves('diff content');
      const result = await gitOps.repository.getFileDiff('/repo', 'file.ts');
      assert.strictEqual(result, 'diff content');
      assert.ok(stub.calledWith('/repo', 'file.ts'));
    });

    test('getCommitCount delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'getCommitCount').resolves(5);
      const result = await gitOps.repository.getCommitCount('from', 'to', '/repo');
      assert.strictEqual(result, 5);
      assert.ok(stub.calledWith('from', 'to', '/repo'));
    });

    test('getDirtyFiles delegates to repository module', async () => {
      const files = ['modified.ts', 'added.ts'];
      const stub = sandbox.stub(repository, 'getDirtyFiles').resolves(files);
      const result = await gitOps.repository.getDirtyFiles('/repo');
      assert.deepStrictEqual(result, files);
      assert.ok(stub.calledWith('/repo'));
    });

    test('checkoutFile delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'checkoutFile').resolves();
      await gitOps.repository.checkoutFile('/repo', 'file.ts');
      assert.ok(stub.calledWith('/repo', 'file.ts'));
    });

    test('resetHard delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'resetHard').resolves();
      await gitOps.repository.resetHard('/repo', 'abc123');
      assert.ok(stub.calledWith('/repo', 'abc123'));
    });

    test('clean delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'clean').resolves();
      await gitOps.repository.clean('/repo');
      assert.ok(stub.calledWith('/repo'));
    });

    test('stashPush delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'stashPush').resolves(true);
      const result = await gitOps.repository.stashPush('/repo', 'message');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('/repo', 'message'));
    });

    test('stashPop delegates to repository module', async () => {
      const stub = sandbox.stub(repository, 'stashPop').resolves(false);
      const result = await gitOps.repository.stashPop('/repo');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('/repo'));
    });

    test('stashList delegates to repository module', async () => {
      const stashes = ['stash@{0}: message'];
      const stub = sandbox.stub(repository, 'stashList').resolves(stashes);
      const result = await gitOps.repository.stashList('/repo');
      assert.deepStrictEqual(result, stashes);
      assert.ok(stub.calledWith('/repo'));
    });
  });

  suite('DefaultGitGitignore', () => {
    test('ensureGitignoreEntries delegates to gitignore module', async () => {
      const stub = sandbox.stub(gitignore, 'ensureGitignoreEntries').resolves(true);
      const result = await gitOps.gitignore.ensureGitignoreEntries('/repo');
      assert.strictEqual(result, true);
      assert.ok(stub.calledWith('/repo'));
    });

    test('isIgnored delegates to gitignore module', async () => {
      const stub = sandbox.stub(gitignore, 'isIgnored').resolves(false);
      const result = await gitOps.gitignore.isIgnored('/repo', 'file.ts');
      assert.strictEqual(result, false);
      assert.ok(stub.calledWith('/repo', 'file.ts'));
    });
  });

  suite('Main Class Structure', () => {
    test('exposes all required sub-interfaces', () => {
      assert.ok(gitOps.branches, 'Should expose branches interface');
      assert.ok(gitOps.worktrees, 'Should expose worktrees interface');
      assert.ok(gitOps.merge, 'Should expose merge interface');
      assert.ok(gitOps.repository, 'Should expose repository interface');
      assert.ok(gitOps.gitignore, 'Should expose gitignore interface');
    });

    test('sub-interfaces have correct method types', () => {
      assert.strictEqual(typeof gitOps.branches.isDefaultBranch, 'function');
      assert.strictEqual(typeof gitOps.worktrees.create, 'function');
      assert.strictEqual(typeof gitOps.merge.merge, 'function');
      assert.strictEqual(typeof gitOps.repository.fetch, 'function');
      assert.strictEqual(typeof gitOps.gitignore.isIgnored, 'function');
    });
  });
});