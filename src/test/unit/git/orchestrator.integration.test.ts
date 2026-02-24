/**
 * @fileoverview Tests for git orchestrator (src/git/orchestrator.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as orchestrator from '../../../git/orchestrator';
import * as worktrees from '../../../git/core/worktrees';
import * as branches from '../../../git/core/branches';
import * as executor from '../../../git/core/executor';
import * as repository from '../../../git/core/repository';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
}

suite('Git Orchestrator', () => {
  let execAsyncStub: sinon.SinonStub;

  setup(() => {
    silenceConsole();
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // slugify
  // =========================================================================

  suite('slugify', () => {
    test('converts to lowercase', () => {
      assert.strictEqual(orchestrator.slugify('HelloWorld'), 'helloworld');
    });

    test('replaces spaces with hyphens', () => {
      assert.strictEqual(orchestrator.slugify('hello world'), 'hello-world');
    });

    test('removes special characters', () => {
      assert.strictEqual(orchestrator.slugify('hello@world!'), 'hello-world');
    });

    test('collapses consecutive hyphens', () => {
      assert.strictEqual(orchestrator.slugify('hello---world'), 'hello-world');
    });

    test('removes leading/trailing hyphens', () => {
      assert.strictEqual(orchestrator.slugify('-hello-'), 'hello');
    });

    test('truncates to maxLength', () => {
      const result = orchestrator.slugify('a'.repeat(100), 10);
      assert.strictEqual(result.length, 10);
    });
  });

  // =========================================================================
  // resolveTargetBranchRoot
  // =========================================================================

  suite('resolveTargetBranchRoot', () => {
    test('creates feature branch for default branch', async () => {
      sinon.stub(branches, 'isDefaultBranch').resolves(true);
      const result = await orchestrator.resolveTargetBranchRoot('main', '/repo');
      assert.strictEqual(result.needsCreation, true);
      assert.ok(result.targetBranchRoot.startsWith('copilot_jobs/'));
    });

    test('uses custom prefix for feature branch', async () => {
      sinon.stub(branches, 'isDefaultBranch').resolves(true);
      const result = await orchestrator.resolveTargetBranchRoot('main', '/repo', 'users/test');
      assert.ok(result.targetBranchRoot.startsWith('users/test/'));
    });

    test('uses custom suffix for feature branch', async () => {
      sinon.stub(branches, 'isDefaultBranch').resolves(true);
      const result = await orchestrator.resolveTargetBranchRoot('main', '/repo', 'copilot_jobs', 'my-plan');
      assert.strictEqual(result.targetBranchRoot, 'copilot_jobs/my-plan');
    });

    test('returns baseBranch as-is for non-default branch', async () => {
      sinon.stub(branches, 'isDefaultBranch').resolves(false);
      const result = await orchestrator.resolveTargetBranchRoot('feature-branch', '/repo');
      assert.strictEqual(result.targetBranchRoot, 'feature-branch');
      assert.strictEqual(result.needsCreation, false);
    });
  });

  // =========================================================================
  // createJobWorktree
  // =========================================================================

  suite('createJobWorktree', () => {
    test('creates worktree and returns path', async () => {
      sinon.stub(worktrees, 'isValid').resolves(false);
      sinon.stub(worktrees, 'create').resolves();
      sinon.stub(branches, 'exists').resolves(true);

      // Stub .gitignore reading/writing
      sinon.stub(fs.promises, 'readFile').resolves('');
      sinon.stub(fs.promises, 'writeFile').resolves();

      const result = await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-1',
        baseBranch: 'main',
        targetBranch: 'feature',
      });

      assert.ok(result.includes('job-1'));
    });

    test('reuses existing valid worktree', async () => {
      sinon.stub(worktrees, 'isValid').resolves(true);
      const createStub = sinon.stub(worktrees, 'create');
      sinon.stub(fs.promises, 'readFile').resolves('.worktrees\n');
      sinon.stub(fs.promises, 'writeFile').resolves();

      const result = await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-1',
        baseBranch: 'main',
        targetBranch: 'feature',
      });

      assert.ok(result.includes('job-1'));
      assert.ok(createStub.notCalled);
    });
  });

  // =========================================================================
  // removeJobWorktree
  // =========================================================================

  suite('removeJobWorktree', () => {
    test('removes worktree', async () => {
      const removeStub = sinon.stub(worktrees, 'remove').resolves();
      await orchestrator.removeJobWorktree('/repo/.wt/job1', '/repo');
      assert.ok(removeStub.calledOnce);
    });

    test('deletes branch when requested', async () => {
      sinon.stub(worktrees, 'remove').resolves();
      const removeBranchStub = sinon.stub(branches, 'remove').resolves();

      await orchestrator.removeJobWorktree('/repo/.wt/job1', '/repo', {
        deleteBranch: true,
        branchName: 'feature',
      });

      assert.ok(removeBranchStub.calledOnce);
    });

    test('does not throw when remove fails', async () => {
      sinon.stub(worktrees, 'remove').rejects(new Error('fail'));
      await orchestrator.removeJobWorktree('/repo/.wt/job1', '/repo');
      // Should not throw
    });

    test('does not throw when branch delete fails', async () => {
      sinon.stub(worktrees, 'remove').resolves();
      sinon.stub(branches, 'remove').rejects(new Error('branch fail'));
      await orchestrator.removeJobWorktree('/repo/.wt/job1', '/repo', {
        deleteBranch: true,
        branchName: 'feature',
      });
      // Should not throw
    });
  });

  // =========================================================================
  // createJobWorktree - local ref fallback
  // =========================================================================

  suite('createJobWorktree local fallback', () => {
    test('uses local baseBranch when remote does not exist', async () => {
      sinon.stub(worktrees, 'isValid').resolves(false);
      const createStub = sinon.stub(worktrees, 'create').resolves();
      sinon.stub(branches, 'exists').resolves(false);
      sinon.stub(fs.promises, 'readFile').resolves('');
      sinon.stub(fs.promises, 'writeFile').resolves();

      await orchestrator.createJobWorktree({
        repoPath: '/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job-2',
        baseBranch: 'local-only',
        targetBranch: 'feature-2',
      });

      // Should have created with local-only as fromRef (not origin/local-only)
      const createCall = createStub.firstCall.args[0];
      assert.strictEqual(createCall.fromRef, 'local-only');
    });
  });

  // =========================================================================
  // finalizeWorktree
  // =========================================================================

  suite('finalizeWorktree', () => {
    test('stages, checks and commits changes', async () => {
      const stageAllStub = sinon.stub(repository, 'stageAll').resolves();
      sinon.stub(repository, 'hasStagedChanges').resolves(true);
      const commitStub = sinon.stub(repository, 'commit').resolves();

      const result = await orchestrator.finalizeWorktree('/wt', 'commit message');
      assert.strictEqual(result, true);
      assert.ok(stageAllStub.calledOnceWith('/wt'));
      assert.ok(commitStub.calledOnce);
    });

    test('returns false when no changes to commit', async () => {
      sinon.stub(repository, 'stageAll').resolves();
      sinon.stub(repository, 'hasStagedChanges').resolves(false);

      const result = await orchestrator.finalizeWorktree('/wt', 'msg');
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // squashMerge
  // =========================================================================

  suite('squashMerge', () => {
    test('merges and commits when on target branch', async () => {
      sinon.stub(branches, 'current').resolves('target');
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sinon.stub(repository, 'hasStagedChanges').resolves(true);
      const commitStub = sinon.stub(repository, 'commit').resolves();

      await orchestrator.squashMerge('source', 'target', 'Squash msg', '/wt');
      assert.ok(commitStub.calledOnce);
    });

    test('checks out target branch when not on it', async () => {
      sinon.stub(branches, 'current').resolves('other');
      const checkoutStub = sinon.stub(branches, 'checkout').resolves();
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sinon.stub(repository, 'hasStagedChanges').resolves(false);

      await orchestrator.squashMerge('source', 'target', 'Squash msg', '/wt');
      assert.ok(checkoutStub.calledOnceWith('target', '/wt', sinon.match.func));
    });

    test('skips commit when no staged changes', async () => {
      sinon.stub(branches, 'current').resolves('target');
      execAsyncStub.resolves({ success: true, stdout: '', stderr: '', exitCode: 0 });
      sinon.stub(repository, 'hasStagedChanges').resolves(false);
      const commitStub = sinon.stub(repository, 'commit');

      await orchestrator.squashMerge('source', 'target', 'msg', '/wt');
      assert.ok(commitStub.notCalled);
    });
  });
});
