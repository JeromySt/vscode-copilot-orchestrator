import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';
import * as orchestrator from '../../../git/orchestrator';
import * as branches from '../../../git/core/branches';
import * as worktrees from '../../../git/core/worktrees';
import * as repository from '../../../git/core/repository';
import * as executor from '../../../git/core/executor';
import { ensureGitignoreEntries } from '../../../git/core/gitignore';

/**
 * Comprehensive unit tests for git orchestrator module.
 * Tests high-level orchestration functions for 95%+ code coverage.
 */

suite('Git Orchestrator Unit Tests', () => {
  let branchesIsDefaultBranchStub: sinon.SinonStub;
  let branchesExistsStub: sinon.SinonStub;
  let branchesCurrentStub: sinon.SinonStub;
  let branchesCheckoutStub: sinon.SinonStub;
  let branchesRemoveStub: sinon.SinonStub;
  let worktreesIsValidStub: sinon.SinonStub;
  let worktreesCreateStub: sinon.SinonStub;
  let worktreesRemoveStub: sinon.SinonStub;
  let repositoryStageAllStub: sinon.SinonStub;
  let repositoryHasStagedChangesStub: sinon.SinonStub;
  let repositoryCommitStub: sinon.SinonStub;
  let execAsyncStub: sinon.SinonStub;
  let ensureGitignoreEntriesStub: sinon.SinonStub;

  setup(() => {
    branchesIsDefaultBranchStub = sinon.stub(branches, 'isDefaultBranch');
    branchesExistsStub = sinon.stub(branches, 'exists');
    branchesCurrentStub = sinon.stub(branches, 'current');
    branchesCheckoutStub = sinon.stub(branches, 'checkout');
    branchesRemoveStub = sinon.stub(branches, 'remove');
    worktreesIsValidStub = sinon.stub(worktrees, 'isValid');
    worktreesCreateStub = sinon.stub(worktrees, 'create');
    worktreesRemoveStub = sinon.stub(worktrees, 'remove');
    repositoryStageAllStub = sinon.stub(repository, 'stageAll');
    repositoryHasStagedChangesStub = sinon.stub(repository, 'hasStagedChanges');
    repositoryCommitStub = sinon.stub(repository, 'commit');
    execAsyncStub = sinon.stub(executor, 'execAsync');
    ensureGitignoreEntriesStub = sinon.stub().resolves();
    
    // Mock the ensureGitignoreEntries import
    sinon.replace(
      require('../../../git/core/gitignore'),
      'ensureGitignoreEntries',
      ensureGitignoreEntriesStub
    );
  });

  teardown(() => {
    sinon.restore();
  });

  suite('slugify()', () => {
    test('should convert string to valid git branch slug', () => {
      assert.strictEqual(orchestrator.slugify('Feature Branch'), 'feature-branch');
      assert.strictEqual(orchestrator.slugify('My awesome feature!'), 'my-awesome-feature');
      assert.strictEqual(orchestrator.slugify('  Special@chars#123  '), 'special-chars-123');
    });

    test('should remove consecutive hyphens', () => {
      assert.strictEqual(orchestrator.slugify('multiple---spaces   here'), 'multiple-spaces-here');
    });

    test('should remove leading and trailing hyphens', () => {
      assert.strictEqual(orchestrator.slugify('---leading and trailing---'), 'leading-and-trailing');
    });

    test('should truncate to specified max length', () => {
      const longName = 'this is a very long feature branch name that should be truncated';
      const result = orchestrator.slugify(longName, 20);
      assert.strictEqual(result.length, 20);
      assert.strictEqual(result, 'this-is-a-very-long-');
    });

    test('should use default max length of 50', () => {
      const longName = 'a'.repeat(100);
      const result = orchestrator.slugify(longName);
      assert.strictEqual(result.length, 50);
    });

    test('should handle empty string', () => {
      assert.strictEqual(orchestrator.slugify(''), '');
    });

    test('should handle string with only special characters', () => {
      assert.strictEqual(orchestrator.slugify('!@#$%^&*()'), '');
    });

    test('should preserve alphanumeric characters', () => {
      assert.strictEqual(orchestrator.slugify('abc123XYZ'), 'abc123xyz');
    });
  });

  suite('resolveTargetBranchRoot()', () => {
    test('should create feature branch for default branch', async () => {
      branchesIsDefaultBranchStub.resolves(true);

      const result = await orchestrator.resolveTargetBranchRoot('main', '/test/repo', 'copilot_jobs', 'my-suffix');

      assert.strictEqual(result.targetBranchRoot, 'copilot_jobs/my-suffix');
      assert.strictEqual(result.needsCreation, true);
      assert.ok(branchesIsDefaultBranchStub.calledWith('main', '/test/repo'));
    });

    test('should use base branch for non-default branch', async () => {
      branchesIsDefaultBranchStub.resolves(false);

      const result = await orchestrator.resolveTargetBranchRoot('feature-branch', '/test/repo');

      assert.strictEqual(result.targetBranchRoot, 'feature-branch');
      assert.strictEqual(result.needsCreation, false);
    });

    test('should generate UUID when no suffix provided', async () => {
      branchesIsDefaultBranchStub.resolves(true);
      
      const result = await orchestrator.resolveTargetBranchRoot('main', '/test/repo');

      assert.ok(result.targetBranchRoot.startsWith('copilot_jobs/'));
      assert.strictEqual(result.needsCreation, true);
      
      // Should be in format copilot_jobs/<uuid-first-part>
      const parts = result.targetBranchRoot.split('/');
      assert.strictEqual(parts.length, 2);
      assert.strictEqual(parts[0], 'copilot_jobs');
      assert.ok(parts[1].length > 0);
    });

    test('should remove trailing slashes from prefix', async () => {
      branchesIsDefaultBranchStub.resolves(true);

      const result = await orchestrator.resolveTargetBranchRoot('main', '/test/repo', 'prefix///', 'suffix');

      assert.strictEqual(result.targetBranchRoot, 'prefix/suffix');
    });

    test('should use custom prefix', async () => {
      branchesIsDefaultBranchStub.resolves(true);

      const result = await orchestrator.resolveTargetBranchRoot('main', '/test/repo', 'users/john', 'feature');

      assert.strictEqual(result.targetBranchRoot, 'users/john/feature');
      assert.strictEqual(result.needsCreation, true);
    });
  });

  suite('createJobWorktree()', () => {
    test('should create new job worktree successfully', async () => {
      ensureGitignoreEntriesStub.resolves();
      execAsyncStub.resolves({ success: true });
      worktreesIsValidStub.resolves(false); // Worktree doesn't exist
      branchesExistsStub.resolves(true); // origin/branch exists
      worktreesCreateStub.resolves();

      const options = {
        repoPath: '/test/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job123',
        baseBranch: 'main',
        targetBranch: 'feature-branch'
      };

      const result = await orchestrator.createJobWorktree(options);

      assert.strictEqual(result, path.join('/test/repo', '.worktrees', 'job123'));
      assert.ok(ensureGitignoreEntriesStub.calledWith('/test/repo', ['.worktrees', '.orchestrator']));
      assert.ok(execAsyncStub.calledWith(['fetch', '--all', '--tags'], { cwd: '/test/repo' }));
      assert.ok(branchesExistsStub.calledWith('origin/main', '/test/repo'));
      assert.ok(worktreesCreateStub.calledWith({
        repoPath: '/test/repo',
        worktreePath: path.join('/test/repo', '.worktrees', 'job123'),
        branchName: 'feature-branch',
        fromRef: 'origin/main',
        log: sinon.match.func
      }));
    });

    test('should reuse existing valid worktree', async () => {
      ensureGitignoreEntriesStub.resolves();
      execAsyncStub.resolves({ success: true });
      worktreesIsValidStub.resolves(true); // Worktree exists
      worktreesCreateStub.resolves();

      const options = {
        repoPath: '/test/repo',
        worktreeRoot: '.worktrees',
        jobId: 'existing-job',
        baseBranch: 'main',
        targetBranch: 'feature-branch'
      };

      const result = await orchestrator.createJobWorktree(options);

      assert.strictEqual(result, path.join('/test/repo', '.worktrees', 'existing-job'));
      assert.ok(execAsyncStub.calledWith(['fetch', '--all'], { cwd: result }));
      assert.ok(worktreesCreateStub.notCalled); // Should not create new worktree
    });

    test('should use local branch when remote does not exist', async () => {
      ensureGitignoreEntriesStub.resolves();
      execAsyncStub.resolves({ success: true });
      worktreesIsValidStub.resolves(false);
      branchesExistsStub.resolves(false); // origin/branch doesn't exist
      worktreesCreateStub.resolves();

      const options = {
        repoPath: '/test/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job123',
        baseBranch: 'local-feature',
        targetBranch: 'target-branch'
      };

      await orchestrator.createJobWorktree(options);

      assert.ok(branchesExistsStub.calledWith('origin/local-feature', '/test/repo'));
      assert.ok(worktreesCreateStub.calledWith(sinon.match({
        fromRef: 'local-feature' // Should use local branch, not origin/
      })));
    });

    test('should use custom logger when provided', async () => {
      ensureGitignoreEntriesStub.resolves();
      execAsyncStub.resolves({ success: true });
      worktreesIsValidStub.resolves(false);
      branchesExistsStub.resolves(true);
      worktreesCreateStub.resolves();

      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      const options = {
        repoPath: '/test/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job123',
        baseBranch: 'main',
        targetBranch: 'feature-branch',
        logger: customLogger
      };

      await orchestrator.createJobWorktree(options);

      assert.ok(logMessages.some(m => m.includes('[git] Fetching latest changes')));
      assert.ok(logMessages.some(m => m.includes('[git] Creating worktree from origin/main')));
      assert.ok(ensureGitignoreEntriesStub.calledWith('/test/repo', ['.worktrees', '.orchestrator'], customLogger));
    });

    test('should handle absolute worktree root path', async () => {
      ensureGitignoreEntriesStub.resolves();
      execAsyncStub.resolves({ success: true });
      worktreesIsValidStub.resolves(false);
      branchesExistsStub.resolves(true);
      worktreesCreateStub.resolves();

      const options = {
        repoPath: '/test/repo',
        worktreeRoot: '/absolute/worktrees',
        jobId: 'job123',
        baseBranch: 'main',
        targetBranch: 'feature-branch'
      };

      const result = await orchestrator.createJobWorktree(options);

      assert.strictEqual(result, require('path').join('/test/repo', '/absolute/worktrees', 'job123'));
    });

    test('should propagate worktree creation errors', async () => {
      ensureGitignoreEntriesStub.resolves();
      execAsyncStub.resolves({ success: true });
      worktreesIsValidStub.resolves(false);
      branchesExistsStub.resolves(true);
      worktreesCreateStub.rejects(new Error('Worktree creation failed'));

      const options = {
        repoPath: '/test/repo',
        worktreeRoot: '.worktrees',
        jobId: 'job123',
        baseBranch: 'main',
        targetBranch: 'feature-branch'
      };

      await assert.rejects(
        () => orchestrator.createJobWorktree(options),
        /Worktree creation failed/
      );
    });
  });

  suite('removeJobWorktree()', () => {
    test('should remove worktree without deleting branch', async () => {
      worktreesRemoveStub.resolves();

      await orchestrator.removeJobWorktree('/test/worktree', '/test/repo');

      assert.ok(worktreesRemoveStub.calledWith('/test/worktree', '/test/repo'));
      assert.ok(branchesRemoveStub.notCalled);
    });

    test('should remove worktree and delete branch when requested', async () => {
      worktreesRemoveStub.resolves();
      branchesRemoveStub.resolves();

      await orchestrator.removeJobWorktree('/test/worktree', '/test/repo', {
        deleteBranch: true,
        branchName: 'feature-branch'
      });

      assert.ok(worktreesRemoveStub.calledWith('/test/worktree', '/test/repo'));
      assert.ok(branchesRemoveStub.calledWith('feature-branch', '/test/repo', { force: true, log: sinon.match.func }));
    });

    test('should handle worktree removal failure gracefully', async () => {
      worktreesRemoveStub.rejects(new Error('Permission denied'));
      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      // Should not throw
      await orchestrator.removeJobWorktree('/test/worktree', '/test/repo', { logger: customLogger });

      assert.ok(logMessages.some(m => m.includes('[git] Warning: Could not remove worktree')));
    });

    test('should handle branch deletion failure gracefully', async () => {
      worktreesRemoveStub.resolves();
      branchesRemoveStub.rejects(new Error('Branch is protected'));
      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      // Should not throw
      await orchestrator.removeJobWorktree('/test/worktree', '/test/repo', {
        deleteBranch: true,
        branchName: 'protected-branch',
        logger: customLogger
      });

      assert.ok(logMessages.some(m => m.includes('[git] Warning: Could not delete branch')));
    });

    test('should not delete branch when deleteBranch is true but branchName is missing', async () => {
      worktreesRemoveStub.resolves();

      await orchestrator.removeJobWorktree('/test/worktree', '/test/repo', {
        deleteBranch: true
        // branchName omitted
      });

      assert.ok(branchesRemoveStub.notCalled);
    });

    test('should use custom logger when provided', async () => {
      worktreesRemoveStub.resolves();
      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      await orchestrator.removeJobWorktree('/test/worktree', '/test/repo', { logger: customLogger });

      assert.ok(worktreesRemoveStub.calledWith('/test/worktree', '/test/repo', customLogger));
    });
  });

  suite('finalizeWorktree()', () => {
    test('should finalize worktree with changes', async () => {
      repositoryStageAllStub.resolves();
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.resolves(true);

      const result = await orchestrator.finalizeWorktree('/test/worktree', 'Commit message');

      assert.strictEqual(result, true);
      assert.ok(repositoryStageAllStub.calledWith('/test/worktree'));
      assert.ok(repositoryHasStagedChangesStub.calledWith('/test/worktree'));
      assert.ok(repositoryCommitStub.calledWith('/test/worktree', 'Commit message', { log: sinon.match.func }));
    });

    test('should return false when no staged changes', async () => {
      repositoryStageAllStub.resolves();
      repositoryHasStagedChangesStub.resolves(false);

      const result = await orchestrator.finalizeWorktree('/test/worktree', 'Commit message');

      assert.strictEqual(result, false);
      assert.ok(repositoryCommitStub.notCalled);
    });

    test('should use custom logger when provided', async () => {
      repositoryStageAllStub.resolves();
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.resolves(true);

      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      await orchestrator.finalizeWorktree('/test/worktree', 'Commit message', customLogger);

      assert.ok(logMessages.some(m => m.includes('[git] Finalizing worktree changes')));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Changes committed')));
      assert.ok(repositoryCommitStub.calledWith('/test/worktree', 'Commit message', { log: customLogger }));
    });

    test('should log when no changes to commit', async () => {
      repositoryStageAllStub.resolves();
      repositoryHasStagedChangesStub.resolves(false);

      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      await orchestrator.finalizeWorktree('/test/worktree', 'Commit message', customLogger);

      assert.ok(logMessages.some(m => m.includes('[git] No changes to commit')));
    });

    test('should propagate staging errors', async () => {
      repositoryStageAllStub.rejects(new Error('Staging failed'));

      await assert.rejects(
        () => orchestrator.finalizeWorktree('/test/worktree', 'Commit message'),
        /Staging failed/
      );
    });

    test('should propagate commit errors', async () => {
      repositoryStageAllStub.resolves();
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.rejects(new Error('Commit failed'));

      await assert.rejects(
        () => orchestrator.finalizeWorktree('/test/worktree', 'Commit message'),
        /Commit failed/
      );
    });
  });

  suite('squashMerge()', () => {
    test('should perform squash merge successfully', async () => {
      branchesCurrentStub.resolves('target-branch');
      execAsyncStub.resolves({ success: true });
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.resolves(true);

      await orchestrator.squashMerge('source-branch', 'target-branch', 'Squash merge message', '/test/worktree');

      assert.ok(branchesCurrentStub.calledWith('/test/worktree'));
      assert.ok(execAsyncStub.calledWith(['merge', '--squash', 'source-branch'], { 
        cwd: '/test/worktree', 
        throwOnError: true 
      }));
      assert.ok(repositoryHasStagedChangesStub.calledWith('/test/worktree'));
      assert.ok(repositoryCommitStub.calledWith('/test/worktree', 'Squash merge message', { log: sinon.match.func }));
    });

    test('should checkout target branch if not current', async () => {
      branchesCurrentStub.resolves('different-branch');
      branchesCheckoutStub.resolves();
      execAsyncStub.resolves({ success: true });
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.resolves(true);

      await orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree');

      assert.ok(branchesCheckoutStub.calledWith('target-branch', '/test/worktree'));
    });

    test('should handle case with no changes to commit', async () => {
      branchesCurrentStub.resolves('target-branch');
      execAsyncStub.resolves({ success: true });
      repositoryHasStagedChangesStub.resolves(false); // No staged changes

      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      await orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree', customLogger);

      assert.ok(repositoryCommitStub.notCalled);
      assert.ok(logMessages.some(m => m.includes('[git] ✓ No changes to commit (branches already in sync)')));
    });

    test('should use custom logger when provided', async () => {
      branchesCurrentStub.resolves('target-branch');
      execAsyncStub.resolves({ success: true });
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.resolves(true);

      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      await orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree', customLogger);

      assert.ok(logMessages.some(m => m.includes("[git] Squash merging 'source-branch' into 'target-branch'")));
      assert.ok(logMessages.some(m => m.includes('[git] ✓ Squash merge completed')));
      assert.ok(branchesCheckoutStub.notCalled); // Should not checkout since already on target
    });

    test('should log branch checkout when switching', async () => {
      branchesCurrentStub.resolves('wrong-branch');
      branchesCheckoutStub.resolves();
      execAsyncStub.resolves({ success: true });
      repositoryHasStagedChangesStub.resolves(false);

      const logMessages: string[] = [];
      const customLogger = (msg: string) => logMessages.push(msg);

      await orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree', customLogger);

      assert.ok(logMessages.some(m => m.includes("[git] Switching to target branch 'target-branch'")));
      assert.ok(branchesCheckoutStub.calledWith('target-branch', '/test/worktree', customLogger));
    });

    test('should propagate merge errors', async () => {
      branchesCurrentStub.resolves('target-branch');
      execAsyncStub.rejects(new Error('Merge conflict'));

      await assert.rejects(
        () => orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree'),
        /Merge conflict/
      );
    });

    test('should propagate checkout errors', async () => {
      branchesCurrentStub.resolves('wrong-branch');
      branchesCheckoutStub.rejects(new Error('Checkout failed'));

      await assert.rejects(
        () => orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree'),
        /Checkout failed/
      );
    });

    test('should propagate commit errors', async () => {
      branchesCurrentStub.resolves('target-branch');
      execAsyncStub.resolves({ success: true });
      repositoryHasStagedChangesStub.resolves(true);
      repositoryCommitStub.rejects(new Error('Commit failed'));

      await assert.rejects(
        () => orchestrator.squashMerge('source-branch', 'target-branch', 'Merge message', '/test/worktree'),
        /Commit failed/
      );
    });
  });

  suite('Re-exported functions', () => {
    test('should re-export isDefaultBranch', async () => {
      branchesIsDefaultBranchStub.resolves(true);

      const result = await orchestrator.isDefaultBranch('main', '/test/repo');

      assert.strictEqual(result, true);
      assert.ok(branchesIsDefaultBranchStub.calledWith('main', '/test/repo'));
    });

    test('should re-export branchExists', async () => {
      branchesExistsStub.resolves(true);

      const result = await orchestrator.branchExists('feature', '/test/repo');

      assert.strictEqual(result, true);
      assert.ok(branchesExistsStub.calledWith('feature', '/test/repo'));
    });

    test('should re-export getCurrentBranch', async () => {
      const currentOrNullStub = sinon.stub(branches, 'currentOrNull').resolves('main');

      const result = await orchestrator.getCurrentBranch('/test/repo');

      assert.strictEqual(result, 'main');
      assert.ok(currentOrNullStub.calledWith('/test/repo'));
    });

    test('should re-export createBranch', async () => {
      const createStub = sinon.stub(branches, 'create').resolves();

      await orchestrator.createBranch('new-branch', 'main', '/test/repo');

      assert.ok(createStub.calledWith('new-branch', 'main', '/test/repo'));
    });

    test('should re-export isValidWorktree', async () => {
      worktreesIsValidStub.resolves(true);

      const result = await orchestrator.isValidWorktree('/test/worktree');

      assert.strictEqual(result, true);
      assert.ok(worktreesIsValidStub.calledWith('/test/worktree'));
    });

    test('should re-export getWorktreeBranch', async () => {
      const getBranchStub = sinon.stub(worktrees, 'getBranch').resolves('feature');

      const result = await orchestrator.getWorktreeBranch('/test/worktree');

      assert.strictEqual(result, 'feature');
      assert.ok(getBranchStub.calledWith('/test/worktree'));
    });
  });
});