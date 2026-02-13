/**
 * @fileoverview Unit tests for the git orchestrator module.
 *
 * Tests the orchestrator-level git operations (src/git/orchestrator.ts) by
 * mocking the underlying core git modules (branches, worktrees, repository,
 * executor) and the fs module.
 *
 * Uses the same sinon-based stubbing approach as merge.test.ts.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';
import * as fs from 'fs';

import * as orchestrator from '../../../git/orchestrator';
import * as branches from '../../../git/core/branches';
import * as worktrees from '../../../git/core/worktrees';
import * as repository from '../../../git/core/repository';
import * as executor from '../../../git/core/executor';
import { ensureGitignoreEntries } from '../../../git/core/gitignore';
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

/** Collect log messages from a GitLogger. */
function captureLogger(): { messages: string[]; log: (msg: string) => void } {
  const messages: string[] = [];
  return { messages, log: (msg: string) => messages.push(msg) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Git Orchestrator', () => {

  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  // =========================================================================
  // resolveTargetBranchRoot()
  // =========================================================================

  suite('resolveTargetBranchRoot()', () => {

    test('creates feature branch when baseBranch is default', async () => {
      sandbox.stub(branches, 'isDefaultBranch').resolves(true);

      const result = await orchestrator.resolveTargetBranchRoot('main', '/repo');

      assert.strictEqual(result.needsCreation, true);
      assert.ok(
        result.targetBranchRoot.startsWith('copilot_jobs/'),
        `expected branch to start with copilot_jobs/, got: ${result.targetBranchRoot}`,
      );
    });

    test('uses custom prefix for feature branch', async () => {
      sandbox.stub(branches, 'isDefaultBranch').resolves(true);

      const result = await orchestrator.resolveTargetBranchRoot('main', '/repo', 'my_prefix');

      assert.ok(
        result.targetBranchRoot.startsWith('my_prefix/'),
        `expected branch to start with my_prefix/, got: ${result.targetBranchRoot}`,
      );
      assert.strictEqual(result.needsCreation, true);
    });

    test('returns baseBranch as-is when not default', async () => {
      sandbox.stub(branches, 'isDefaultBranch').resolves(false);

      const result = await orchestrator.resolveTargetBranchRoot('feature/existing', '/repo');

      assert.strictEqual(result.targetBranchRoot, 'feature/existing');
      assert.strictEqual(result.needsCreation, false);
    });

    test('generates unique branch names on repeated calls', async () => {
      sandbox.stub(branches, 'isDefaultBranch').resolves(true);

      const result1 = await orchestrator.resolveTargetBranchRoot('main', '/repo');
      const result2 = await orchestrator.resolveTargetBranchRoot('main', '/repo');

      assert.notStrictEqual(
        result1.targetBranchRoot,
        result2.targetBranchRoot,
        'each call should produce a unique branch name',
      );
    });
  });

  // =========================================================================
  // createJobWorktree()
  // =========================================================================

  suite('createJobWorktree()', () => {

    let execAsyncStub: sinon.SinonStub;

    setup(() => {
      execAsyncStub = sandbox.stub(executor, 'execAsync').resolves(ok());
      // Default: .gitignore doesn't exist yet
      sandbox.stub(fs.promises, 'readFile').rejects(new Error('ENOENT'));
      sandbox.stub(fs.promises, 'writeFile').resolves();
    });

    test('creates worktree from remote ref when available', async () => {
      sandbox.stub(worktrees, 'isValid').resolves(false);
      sandbox.stub(branches, 'exists').resolves(true);
      const createStub = sandbox.stub(worktrees, 'create').resolves();

      const result = await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-1',
        baseBranch: 'main',
        targetBranch: 'copilot_jobs/abc',
      });

      assert.strictEqual(result, path.join('/repo', '.worktrees', 'job-1'));

      // Should create worktree from origin/main
      const createCall = createStub.firstCall.args[0];
      assert.strictEqual(createCall.fromRef, 'origin/main');
      assert.strictEqual(createCall.branchName, 'copilot_jobs/abc');
    });

    test('creates worktree from local ref when no remote', async () => {
      sandbox.stub(worktrees, 'isValid').resolves(false);
      sandbox.stub(branches, 'exists').resolves(false);
      const createStub = sandbox.stub(worktrees, 'create').resolves();

      await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-2',
        baseBranch: 'local-branch',
        targetBranch: 'copilot_jobs/def',
      });

      const createCall = createStub.firstCall.args[0];
      assert.strictEqual(createCall.fromRef, 'local-branch');
    });

    test('reuses existing valid worktree', async () => {
      sandbox.stub(worktrees, 'isValid').resolves(true);
      const createStub = sandbox.stub(worktrees, 'create').resolves();

      const { messages, log } = captureLogger();

      const result = await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-3',
        baseBranch: 'main',
        targetBranch: 'copilot_jobs/ghi',
        logger: log,
      });

      assert.strictEqual(result, path.join('/repo', '.worktrees', 'job-3'));
      assert.ok(createStub.notCalled, 'should not create a new worktree');
      assert.ok(
        messages.some(m => m.includes('reusing')),
        'should log that worktree is being reused',
      );
    });

    test('fetches latest changes before creating worktree', async () => {
      sandbox.stub(worktrees, 'isValid').resolves(false);
      sandbox.stub(branches, 'exists').resolves(true);
      sandbox.stub(worktrees, 'create').resolves();

      await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-4',
        baseBranch: 'main',
        targetBranch: 'copilot_jobs/jkl',
      });

      // execAsync should have been called with fetch --all --tags
      const fetchCall = execAsyncStub.getCalls().find(
        (c: sinon.SinonSpyCall) => c.args[0].includes('fetch'),
      );
      assert.ok(fetchCall, 'should call fetch');
      assert.ok(fetchCall!.args[0].includes('--all'), 'should fetch all');
    });
  });

  // =========================================================================
  // removeJobWorktree()
  // =========================================================================

  suite('removeJobWorktree()', () => {

    test('removes worktree', async () => {
      const removeStub = sandbox.stub(worktrees, 'remove').resolves();

      await orchestrator.removeJobWorktree('/repo/.worktrees/job-1', '/repo');

      assert.ok(removeStub.calledOnce);
      assert.strictEqual(removeStub.firstCall.args[0], '/repo/.worktrees/job-1');
    });

    test('deletes branch when requested', async () => {
      sandbox.stub(worktrees, 'remove').resolves();
      const branchRemoveStub = sandbox.stub(branches, 'remove').resolves();

      await orchestrator.removeJobWorktree('/repo/.worktrees/job-2', '/repo', {
        deleteBranch: true,
        branchName: 'copilot_jobs/abc',
      });

      assert.ok(branchRemoveStub.calledOnce);
      assert.strictEqual(branchRemoveStub.firstCall.args[0], 'copilot_jobs/abc');
    });

    test('does not delete branch when not requested', async () => {
      sandbox.stub(worktrees, 'remove').resolves();
      const branchRemoveStub = sandbox.stub(branches, 'remove').resolves();

      await orchestrator.removeJobWorktree('/repo/.worktrees/job-3', '/repo');

      assert.ok(branchRemoveStub.notCalled);
    });

    test('tolerates worktree removal failure', async () => {
      sandbox.stub(worktrees, 'remove').rejects(new Error('worktree locked'));

      // Should not throw
      await orchestrator.removeJobWorktree('/repo/.worktrees/job-4', '/repo');
    });

    test('tolerates branch deletion failure', async () => {
      sandbox.stub(worktrees, 'remove').resolves();
      sandbox.stub(branches, 'remove').rejects(new Error('branch not found'));

      // Should not throw
      await orchestrator.removeJobWorktree('/repo/.worktrees/job-5', '/repo', {
        deleteBranch: true,
        branchName: 'nonexistent',
      });
    });

    test('logs warnings on failure', async () => {
      sandbox.stub(worktrees, 'remove').rejects(new Error('locked'));
      const { messages, log } = captureLogger();

      await orchestrator.removeJobWorktree('/repo/.worktrees/job-6', '/repo', {
        logger: log,
      });

      assert.ok(
        messages.some(m => m.includes('Warning')),
        'should log a warning on failure',
      );
    });
  });

  // =========================================================================
  // finalizeWorktree()
  // =========================================================================

  suite('finalizeWorktree()', () => {

    test('stages and commits when there are changes', async () => {
      const stageStub = sandbox.stub(repository, 'stageAll').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      const commitStub = sandbox.stub(repository, 'commit').resolves(true);

      const result = await orchestrator.finalizeWorktree('/wt', 'commit msg');

      assert.strictEqual(result, true);
      assert.ok(stageStub.calledOnce);
      assert.ok(commitStub.calledOnce);
      assert.strictEqual(commitStub.firstCall.args[1], 'commit msg');
    });

    test('returns false when there are no changes', async () => {
      sandbox.stub(repository, 'stageAll').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(false);
      const commitStub = sandbox.stub(repository, 'commit').resolves(true);

      const result = await orchestrator.finalizeWorktree('/wt', 'msg');

      assert.strictEqual(result, false);
      assert.ok(commitStub.notCalled, 'should not commit when no changes');
    });

    test('logs commit success', async () => {
      sandbox.stub(repository, 'stageAll').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      sandbox.stub(repository, 'commit').resolves(true);
      const { messages, log } = captureLogger();

      await orchestrator.finalizeWorktree('/wt', 'msg', log);

      assert.ok(
        messages.some(m => m.includes('committed')),
        'should log commit confirmation',
      );
    });

    test('logs "no changes" when nothing to commit', async () => {
      sandbox.stub(repository, 'stageAll').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(false);
      const { messages, log } = captureLogger();

      await orchestrator.finalizeWorktree('/wt', 'msg', log);

      assert.ok(
        messages.some(m => m.includes('No changes')),
        'should log no changes message',
      );
    });
  });

  // =========================================================================
  // squashMerge()
  // =========================================================================

  suite('squashMerge()', () => {

    let execAsyncStub: sinon.SinonStub;

    setup(() => {
      execAsyncStub = sandbox.stub(executor, 'execAsync').resolves(ok());
    });

    test('squash merges source into target', async () => {
      sandbox.stub(branches, 'current').resolves('target-branch');
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      sandbox.stub(repository, 'commit').resolves(true);

      await orchestrator.squashMerge(
        'source-branch', 'target-branch', 'Squash merge', '/wt',
      );

      // Should call git merge --squash source-branch
      const mergeCall = execAsyncStub.firstCall;
      assert.ok(mergeCall.args[0].includes('merge'));
      assert.ok(mergeCall.args[0].includes('--squash'));
      assert.ok(mergeCall.args[0].includes('source-branch'));
    });

    test('switches branch if not on target', async () => {
      sandbox.stub(branches, 'current').resolves('wrong-branch');
      const checkoutStub = sandbox.stub(branches, 'checkout').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      sandbox.stub(repository, 'commit').resolves(true);

      await orchestrator.squashMerge(
        'source', 'target', 'msg', '/wt',
      );

      assert.ok(checkoutStub.calledOnce, 'should checkout target branch');
    });

    test('does not switch branch if already on target', async () => {
      sandbox.stub(branches, 'current').resolves('target');
      const checkoutStub = sandbox.stub(branches, 'checkout').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      sandbox.stub(repository, 'commit').resolves(true);

      await orchestrator.squashMerge(
        'source', 'target', 'msg', '/wt',
      );

      assert.ok(checkoutStub.notCalled, 'should not checkout if already on target');
    });

    test('commits when there are staged changes', async () => {
      sandbox.stub(branches, 'current').resolves('target');
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      const commitStub = sandbox.stub(repository, 'commit').resolves(true);

      await orchestrator.squashMerge(
        'source', 'target', 'Squash commit', '/wt',
      );

      assert.ok(commitStub.calledOnce);
      assert.strictEqual(commitStub.firstCall.args[1], 'Squash commit');
    });

    test('skips commit when branches are in sync', async () => {
      sandbox.stub(branches, 'current').resolves('target');
      sandbox.stub(repository, 'hasStagedChanges').resolves(false);
      const commitStub = sandbox.stub(repository, 'commit').resolves(true);
      const { messages, log } = captureLogger();

      await orchestrator.squashMerge(
        'source', 'target', 'msg', '/wt', log,
      );

      assert.ok(commitStub.notCalled);
      assert.ok(
        messages.some(m => m.includes('already in sync')),
        'should log branches in sync',
      );
    });

    test('uses cwd from worktreePath', async () => {
      sandbox.stub(branches, 'current').resolves('target');
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      sandbox.stub(repository, 'commit').resolves(true);

      await orchestrator.squashMerge(
        'source', 'target', 'msg', '/my/worktree',
      );

      const [, opts] = execAsyncStub.firstCall.args;
      assert.strictEqual(opts.cwd, '/my/worktree');
    });
  });

  // =========================================================================
  // Full Workflow: branch → work → merge
  // =========================================================================

  suite('Full workflow: branch → work → merge', () => {

    test('single job flow: resolve → create worktree → finalize → squash merge → cleanup', async () => {
      // 1. Resolve target branch
      sandbox.stub(branches, 'isDefaultBranch').resolves(true);

      const resolved = await orchestrator.resolveTargetBranchRoot('main', '/repo');
      assert.strictEqual(resolved.needsCreation, true);

      // 2. Create job worktree
      sandbox.stub(executor, 'execAsync').resolves(ok());
      sandbox.stub(fs.promises, 'readFile').rejects(new Error('ENOENT'));
      sandbox.stub(fs.promises, 'writeFile').resolves();
      sandbox.stub(worktrees, 'isValid').resolves(false);
      sandbox.stub(branches, 'exists').resolves(true);
      sandbox.stub(worktrees, 'create').resolves();

      const wtPath = await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-1',
        baseBranch: 'main',
        targetBranch: resolved.targetBranchRoot,
      });
      assert.ok(wtPath.includes('job-1'));

      // 3. Finalize worktree (stage & commit)
      sandbox.stub(repository, 'stageAll').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(true);
      sandbox.stub(repository, 'commit').resolves(true);

      const committed = await orchestrator.finalizeWorktree(wtPath, 'Implement feature');
      assert.strictEqual(committed, true);

      // 4. Squash merge back
      sandbox.stub(branches, 'current').resolves(resolved.targetBranchRoot);

      await orchestrator.squashMerge(
        'job-branch', resolved.targetBranchRoot, 'Merge job work', wtPath,
      );

      // 5. Cleanup
      sandbox.stub(worktrees, 'remove').resolves();
      sandbox.stub(branches, 'remove').resolves();

      await orchestrator.removeJobWorktree(wtPath, '/repo', {
        deleteBranch: true,
        branchName: 'job-branch',
      });
    });
  });

  // =========================================================================
  // Multi-branch coordination
  // =========================================================================

  suite('Multi-branch coordination', () => {

    test('parallel jobs get independent worktrees and branches', async () => {
      sandbox.stub(branches, 'isDefaultBranch').resolves(true);

      const result1 = await orchestrator.resolveTargetBranchRoot('main', '/repo');
      const result2 = await orchestrator.resolveTargetBranchRoot('main', '/repo');

      // Each should get a unique branch
      assert.notStrictEqual(result1.targetBranchRoot, result2.targetBranchRoot);
      assert.strictEqual(result1.needsCreation, true);
      assert.strictEqual(result2.needsCreation, true);

      // Both should share the same prefix
      assert.ok(result1.targetBranchRoot.startsWith('copilot_jobs/'));
      assert.ok(result2.targetBranchRoot.startsWith('copilot_jobs/'));
    });

    test('non-default branches are shared across jobs', async () => {
      sandbox.stub(branches, 'isDefaultBranch').resolves(false);

      const result1 = await orchestrator.resolveTargetBranchRoot('feature/shared', '/repo');
      const result2 = await orchestrator.resolveTargetBranchRoot('feature/shared', '/repo');

      assert.strictEqual(result1.targetBranchRoot, 'feature/shared');
      assert.strictEqual(result2.targetBranchRoot, 'feature/shared');
      assert.strictEqual(result1.needsCreation, false);
      assert.strictEqual(result2.needsCreation, false);
    });
  });

  // =========================================================================
  // Error recovery
  // =========================================================================

  suite('Error recovery', () => {

    test('cleanup succeeds even when worktree removal fails', async () => {
      sandbox.stub(worktrees, 'remove').rejects(new Error('worktree locked'));
      const branchRemoveStub = sandbox.stub(branches, 'remove').resolves();

      await orchestrator.removeJobWorktree('/wt/job-1', '/repo', {
        deleteBranch: true,
        branchName: 'job-branch',
      });

      // Branch deletion should still proceed
      assert.ok(branchRemoveStub.calledOnce);
    });

    test('cleanup succeeds even when branch deletion fails', async () => {
      const removeStub = sandbox.stub(worktrees, 'remove').resolves();
      sandbox.stub(branches, 'remove').rejects(new Error('branch not found'));

      await orchestrator.removeJobWorktree('/wt/job-2', '/repo', {
        deleteBranch: true,
        branchName: 'nonexistent',
      });

      // Worktree removal should still succeed
      assert.ok(removeStub.calledOnce);
    });

    test('cleanup succeeds even when both operations fail', async () => {
      sandbox.stub(worktrees, 'remove').rejects(new Error('locked'));
      sandbox.stub(branches, 'remove').rejects(new Error('not found'));

      // Should not throw
      await orchestrator.removeJobWorktree('/wt/job-3', '/repo', {
        deleteBranch: true,
        branchName: 'bad-branch',
      });
    });

    test('createJobWorktree recovers from existing worktree (retry scenario)', async () => {
      sandbox.stub(executor, 'execAsync').resolves(ok());
      sandbox.stub(fs.promises, 'readFile').rejects(new Error('ENOENT'));
      sandbox.stub(fs.promises, 'writeFile').resolves();
      sandbox.stub(worktrees, 'isValid').resolves(true);
      const createStub = sandbox.stub(worktrees, 'create').resolves();

      const result = await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'retry-job',
        baseBranch: 'main',
        targetBranch: 'copilot_jobs/retry',
      });

      assert.ok(result.includes('retry-job'));
      assert.ok(createStub.notCalled, 'should not create new worktree on retry');
    });

    test('finalizeWorktree handles no-changes gracefully', async () => {
      sandbox.stub(repository, 'stageAll').resolves();
      sandbox.stub(repository, 'hasStagedChanges').resolves(false);

      const result = await orchestrator.finalizeWorktree('/wt', 'msg');

      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // State consistency
  // =========================================================================

  suite('State consistency', () => {

    test('createJobWorktree passes correct paths to worktree.create', async () => {
      sandbox.stub(executor, 'execAsync').resolves(ok());
      sandbox.stub(fs.promises, 'readFile').rejects(new Error('ENOENT'));
      sandbox.stub(fs.promises, 'writeFile').resolves();
      sandbox.stub(worktrees, 'isValid').resolves(false);
      sandbox.stub(branches, 'exists').resolves(true);
      const createStub = sandbox.stub(worktrees, 'create').resolves();

      await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'my-job',
        baseBranch: 'develop',
        targetBranch: 'copilot_jobs/xyz',
      });

      const opts = createStub.firstCall.args[0];
      assert.strictEqual(opts.repoPath, '/repo');
      assert.strictEqual(opts.worktreePath, path.join('/repo', '.worktrees', 'my-job'));
      assert.strictEqual(opts.branchName, 'copilot_jobs/xyz');
      assert.strictEqual(opts.fromRef, 'origin/develop');
    });

    test('squashMerge passes throwOnError to execAsync', async () => {
      const execStub = sandbox.stub(executor, 'execAsync').resolves(ok());
      sandbox.stub(branches, 'current').resolves('target');
      sandbox.stub(repository, 'hasStagedChanges').resolves(false);

      await orchestrator.squashMerge('src', 'target', 'msg', '/wt');

      const [, opts] = execStub.firstCall.args;
      assert.strictEqual(opts.throwOnError, true, 'squash merge should use throwOnError');
    });
  });
});
