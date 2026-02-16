/**
 * @fileoverview Unit tests for MergeRiPhaseExecutor
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MergeRiPhaseExecutor } from '../../../../plan/phases/mergeRiPhase';
import { EventEmitter } from 'events';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
import type { IGitOperations } from '../../../../interfaces/IGitOperations';
import type { JobNode } from '../../../../plan/types';
import type { ICopilotRunner } from '../../../../interfaces/ICopilotRunner';

// Mock ICopilotRunner for tests
const mockCopilotRunner: ICopilotRunner = {
  run: async () => ({ success: true, sessionId: 'test', metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } }),
  isAvailable: () => true,
  writeInstructionsFile: (cwd: string, task: string, instructions: string | undefined, label: string, jobId?: string) => ({ filePath: '/tmp/instructions.md', dirPath: '/tmp' }),
  buildCommand: (options: any) => 'copilot --help',
  cleanupInstructionsFile: (filePath: string, dirPath: string | undefined, label: string) => {}
};

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeri-test-'));
  tmpDirs.push(dir);
  return dir;
}

function createMockNode(overrides: Partial<JobNode> = {}): JobNode {
  return {
    id: 'test-node', producerId: 'test-node', name: 'Test Node', type: 'job',
    task: 'test task', work: { type: 'shell', command: 'echo test' },
    dependencies: [], dependents: [],
    ...overrides,
  };
}

function createMockContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    node: createMockNode(),
    worktreePath: makeTmpDir(),
    executionKey: 'test:node:1',
    phase: 'merge-ri',
    repoPath: makeTmpDir(),
    targetBranch: 'main',
    baseCommitAtStart: 'abc123456789012345678901234567890abcdef12',
    completedCommit: 'def456789012345678901234567890abcdef123456',
    baseCommit: 'ghi789012345678901234567890abcdef123456789',
    logInfo: sinon.stub(),
    logError: sinon.stub(),
    logOutput: sinon.stub(),
    isAborted: () => false,
    setProcess: sinon.stub(),
    setStartTime: sinon.stub(),
    setIsAgentWork: sinon.stub(),
    ...overrides,
  };
}

function mockGitOperations(): IGitOperations {
  return {
    repository: {
      getDirtyFiles: sinon.stub().resolves([]),
      hasUncommittedChanges: sinon.stub().resolves(false),
      stageAll: sinon.stub().resolves(),
      commit: sinon.stub().resolves(true),
      fetch: sinon.stub().resolves(),
      pull: sinon.stub().resolves(true),
      push: sinon.stub().resolves(true),
      stageFile: sinon.stub().resolves(),
      hasChanges: sinon.stub().resolves(false),
      hasStagedChanges: sinon.stub().resolves(false),
      getHead: sinon.stub().resolves(null),
      resolveRef: sinon.stub().resolves('abc123'),
      getCommitLog: sinon.stub().resolves([]),
      getCommitChanges: sinon.stub().resolves([]),
      getDiffStats: sinon.stub().resolves({ added: 0, modified: 0, deleted: 0 }),
      getFileDiff: sinon.stub().resolves(null),
      getStagedFileDiff: sinon.stub().resolves(null),
      getFileChangesBetween: sinon.stub().resolves([]),
      hasChangesBetween: sinon.stub().resolves(false),
      getCommitCount: sinon.stub().resolves(0),
      checkoutFile: sinon.stub().resolves(),
      resetHard: sinon.stub().resolves(),
      clean: sinon.stub().resolves(),
      updateRef: sinon.stub().resolves(),
      stashPush: sinon.stub().resolves(true),
      stashPop: sinon.stub().resolves(true),
      stashDrop: sinon.stub().resolves(true),
      stashList: sinon.stub().resolves([]),
      stashShowFiles: sinon.stub().resolves([]),
      stashShowPatch: sinon.stub().resolves(null),
    },
    worktrees: {
      getHeadCommit: sinon.stub().resolves('abc123'),
      create: sinon.stub().resolves(),
      createWithTiming: sinon.stub().resolves({ durationMs: 100 }),
      createDetachedWithTiming: sinon.stub().resolves({ durationMs: 100, baseCommit: 'abc123' }),
      createOrReuseDetached: sinon.stub().resolves({ durationMs: 100, baseCommit: 'abc123', reused: false }),
      remove: sinon.stub().resolves(),
      removeSafe: sinon.stub().resolves(true),
      isValid: sinon.stub().resolves(true),
      getBranch: sinon.stub().resolves('main'),
      list: sinon.stub().resolves([]),
      prune: sinon.stub().resolves(),
    },
    branches: {
      isDefaultBranch: sinon.stub().resolves(true),
      exists: sinon.stub().resolves(true),
      remoteExists: sinon.stub().resolves(true),
      current: sinon.stub().resolves('main'),
      currentOrNull: sinon.stub().resolves('main'),
      create: sinon.stub().resolves(),
      createOrReset: sinon.stub().resolves(),
      checkout: sinon.stub().resolves(),
      list: sinon.stub().resolves(['main']),
      getCommit: sinon.stub().resolves('abc123'),
      getMergeBase: sinon.stub().resolves('abc123'),
      remove: sinon.stub().resolves(),
      deleteLocal: sinon.stub().resolves(true),
      deleteRemote: sinon.stub().resolves(true),
    },
    merge: {
      merge: sinon.stub().resolves({ success: true, hasConflicts: false, conflictFiles: [] }),
      mergeWithoutCheckout: sinon.stub().resolves({ success: true, treeSha: 'tree123', hasConflicts: false, conflictFiles: [] }),
      commitTree: sinon.stub().resolves('commit123'),
      continueAfterResolve: sinon.stub().resolves(true),
      abort: sinon.stub().resolves(),
      listConflicts: sinon.stub().resolves([]),
      isInProgress: sinon.stub().resolves(false),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(true),
      isIgnored: sinon.stub().resolves(false),
      isOrchestratorGitIgnoreConfigured: sinon.stub().resolves(true),
      ensureOrchestratorGitIgnore: sinon.stub().resolves(true),
    isDiffOnlyOrchestratorChanges: sinon.stub().returns(true),
    },
  };
}

suite('MergeRiPhaseExecutor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs = [];
  });

  test('constructor creates instance', () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    assert.ok(executor);
  });

  test('constructor accepts configManager dependency', () => {
    const configManager = { getConfig: () => false };
    const executor = new MergeRiPhaseExecutor({ configManager, git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    assert.ok(executor);
  });

  test('returns failure when repoPath is missing', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      repoPath: undefined
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('repoPath is required'));
  });

  test('returns failure when targetBranch is missing', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      targetBranch: undefined
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('targetBranch is required'));
  });

  test('returns success when completedCommit is missing (skip RI merge)', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      completedCommit: undefined
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/No completed commit/)));
  });

  test('no changes skip - returns success when no diff detected', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(false);

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('========== REVERSE INTEGRATION MERGE START =========='));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/No changes detected/)));

    // Check that hasChangesBetween was called correctly
    const hasChangesCall = (git.repository.hasChangesBetween as sinon.SinonStub).getCall(0);
    assert.strictEqual(hasChangesCall.args[0], context.baseCommitAtStart);
    assert.strictEqual(hasChangesCall.args[1], context.completedCommit);
    assert.strictEqual(hasChangesCall.args[2], context.repoPath);
  });

  test('clean merge - successful merge without conflicts', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: true,
      treeSha: 'tree123456789012345678901234567890abcdef12',
      hasConflicts: false,
      conflictFiles: []
    });
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789012345678901234567890abcdef123456');
    (git.merge.commitTree as sinon.SinonStub).resolves('merge456789012345678901234567890abcdef123');

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'updateBranchRef').resolves(true);
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);

    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('✓ No conflicts detected'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('========== REVERSE INTEGRATION MERGE END =========='));
  });

  test('clean merge with push - pushes when configured', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: true,
      treeSha: 'tree123456789012345678901234567890abcdef12',
      hasConflicts: false,
      conflictFiles: []
    });
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789012345678901234567890abcdef123456');
    (git.merge.commitTree as sinon.SinonStub).resolves('merge456789012345678901234567890abcdef123');

    // Mock configManager to return pushOnSuccess = true
    const configManager = {
      getConfig: sinon.stub().returns(true)
    };
    const executor = new MergeRiPhaseExecutor({ configManager, git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'updateBranchRef').resolves(true);
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);

    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('Pushing main to origin...'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('✓ Pushed to origin'));
    
    // Verify push was called
    assert.ok((git.repository.push as sinon.SinonStub).calledOnce);
  });

  test('merge conflict with resolution - conflict resolved in ephemeral worktree', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      conflictFiles: ['conflict1.txt', 'conflict2.txt']
    });

    // Mock mergeInEphemeralWorktree to succeed
    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const mergeInWorktreeStub = sandbox.stub(executor as any, 'mergeInEphemeralWorktree').resolves({
      success: true,
      metrics: {
        durationMs: 7500,
        turns: 3,
        toolCalls: 5,
        tokenUsage: {
          inputTokens: 150,
          outputTokens: 75,
          totalTokens: 225,
          model: 'gpt-4'
        }
      }
    });

    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('⚠ Merge has conflicts'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('  Conflicts: conflict1.txt, conflict2.txt'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Resolving in ephemeral worktree/)));
    
    // Check that mergeInEphemeralWorktree was called
    assert.ok(mergeInWorktreeStub.calledOnce);
    
    // Check that metrics are returned
    assert.ok(result.metrics);
    assert.strictEqual(result.metrics!.tokenUsage?.totalTokens, 225);
  });

  test('merge conflict with failed resolution - returns failure', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      conflictFiles: ['failed.txt']
    });

    // Mock mergeInEphemeralWorktree to fail
    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'mergeInEphemeralWorktree').resolves({
      success: false,
      error: 'Could not resolve conflicts'
    });

    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Could not resolve conflicts'));
  });

  test('validation-only root node - no commit to merge', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      completedCommit: undefined,
      baseCommit: undefined
    });

    const result = await executor.execute(context);

    // No completed commit means skip RI merge
    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/No completed commit/)));
  });

  test('returns failure when baseCommitAtStart is missing', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      baseCommitAtStart: undefined
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('baseCommitAtStart is required'));
  });

  test('handles validation-only root node (no commit)', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      completedCommit: undefined,
      baseCommit: undefined
    });

    const result = await executor.execute(context);

    // No completed commit means skip RI merge gracefully
    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/No completed commit/)));
  });

  test('merge tree failure returns error', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: false,
      error: 'Merge-tree command failed'
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Merge-tree failed: Merge-tree command failed'));
  });

  test('exception during merge is caught', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).rejects(new Error('Git operation failed'));

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Reverse integration merge failed: Git operation failed'));
    assert.ok((context.logError as sinon.SinonStub).calledWith('✗ Exception: Git operation failed'));
  });

  test('updateBranchRef failure with warning', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: true,
      treeSha: 'tree123456789012345678901234567890abcdef12',
      hasConflicts: false,
      conflictFiles: []
    });
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789012345678901234567890abcdef123456');
    (git.merge.commitTree as sinon.SinonStub).resolves('merge456789012345678901234567890abcdef123');
    (git.repository.updateRef as sinon.SinonStub).rejects(new Error('Branch update failed'));

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);
    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Merge commit .* created but branch not auto-updated/)));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Run 'git reset --hard/)));
  });

  test('updateBranchRef passes arguments in correct order (repoPath, refName, commit)', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: true,
      treeSha: 'tree123456789012345678901234567890abcdef12',
      hasConflicts: false,
      conflictFiles: []
    });
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789012345678901234567890abcdef123456');
    (git.merge.commitTree as sinon.SinonStub).resolves('merge456789012345678901234567890abcdef123');
    (git.repository.updateRef as sinon.SinonStub).resolves();

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);
    const context = createMockContext();

    await executor.execute(context);

    const updateRefStub = git.repository.updateRef as sinon.SinonStub;
    assert.ok(updateRefStub.calledOnce, 'updateRef should be called once');
    const [repoPath, refName, commit] = updateRefStub.firstCall.args;
    assert.strictEqual(repoPath, context.repoPath, 'first arg should be repoPath');
    assert.strictEqual(refName, 'refs/heads/main', 'second arg should be ref name');
    assert.strictEqual(commit, 'merge456789012345678901234567890abcdef123', 'third arg should be commit');
  });

  test('push failure is handled gracefully', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: true,
      treeSha: 'tree123456789012345678901234567890abcdef12',
      hasConflicts: false,
      conflictFiles: []
    });
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789012345678901234567890abcdef123456');
    (git.merge.commitTree as sinon.SinonStub).resolves('merge456789012345678901234567890abcdef123');
    (git.repository.push as sinon.SinonStub).rejects(new Error('Push failed'));

    // Mock configManager to return pushOnSuccess = true
    const configManager = {
      getConfig: sinon.stub().returns(true)
    };
    const executor = new MergeRiPhaseExecutor({ configManager, git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'updateBranchRef').resolves(true);
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);

    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logError as sinon.SinonStub).calledWith('Push failed: Push failed'));
  });

  test('mergeInEphemeralWorktree creates worktree, merges, resolves, validates, and cleans up', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');
    (git.worktrees.createDetachedWithTiming as sinon.SinonStub).resolves({ durationMs: 100, baseCommit: 'target789abc' });
    (git.merge.merge as sinon.SinonStub).rejects(new Error('Conflicts'));
    (git.merge.listConflicts as sinon.SinonStub).resolves(['file1.txt']);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('resolvedcommit123');
    (git.worktrees.removeSafe as sinon.SinonStub).resolves(true);

    // Mock resolveMergeConflictWithCopilot
    const mergeHelperModule = await import('../../../../plan/phases/mergeHelper');
    sandbox.stub(mergeHelperModule, 'resolveMergeConflictWithCopilot').resolves({
      success: true,
      metrics: { durationMs: 5000 }
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);
    sandbox.stub(executor as any, 'updateBranchRef').resolves(true);

    const context = createMockContext();
    const method = (executor as any).mergeInEphemeralWorktree;
    const result = await method.call(executor, context, '/repo', 'source123', 'main', 'Test merge', ['file1.txt']);

    assert.strictEqual(result.success, true);
    // Verify worktree was created
    assert.ok((git.worktrees.createDetachedWithTiming as sinon.SinonStub).calledOnce);
    // Verify merge was attempted in the worktree
    assert.ok((git.merge.merge as sinon.SinonStub).calledOnce);
    // Verify worktree was cleaned up
    assert.ok((git.worktrees.removeSafe as sinon.SinonStub).calledOnce);
    // Verify user's main checkout was NEVER touched (no stash, no checkout)
    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called);
    assert.ok(!(git.branches.checkout as sinon.SinonStub).called);
  });

  test('mergeInEphemeralWorktree cleans up worktree on failure', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');
    (git.worktrees.createDetachedWithTiming as sinon.SinonStub).resolves({ durationMs: 100, baseCommit: 'target789abc' });
    (git.merge.merge as sinon.SinonStub).rejects(new Error('Conflicts'));
    (git.merge.listConflicts as sinon.SinonStub).resolves(['file1.txt']);
    (git.worktrees.removeSafe as sinon.SinonStub).resolves(true);

    // Mock resolveMergeConflictWithCopilot to fail
    const mergeHelperModule = await import('../../../../plan/phases/mergeHelper');
    sandbox.stub(mergeHelperModule, 'resolveMergeConflictWithCopilot').resolves({
      success: false
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).mergeInEphemeralWorktree;
    const result = await method.call(executor, context, '/repo', 'source123', 'main', 'Test merge', ['file1.txt']);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Copilot CLI failed'));
    // Worktree must be cleaned up even on failure
    assert.ok((git.worktrees.removeSafe as sinon.SinonStub).calledOnce);
  });

  test('mergeInEphemeralWorktree never touches user stash', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');
    (git.worktrees.createDetachedWithTiming as sinon.SinonStub).resolves({ durationMs: 100, baseCommit: 'target789abc' });
    (git.merge.merge as sinon.SinonStub).rejects(new Error('Conflicts'));
    (git.merge.listConflicts as sinon.SinonStub).resolves(['file1.txt']);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('resolvedcommit123');
    (git.worktrees.removeSafe as sinon.SinonStub).resolves(true);

    const mergeHelperModule = await import('../../../../plan/phases/mergeHelper');
    sandbox.stub(mergeHelperModule, 'resolveMergeConflictWithCopilot').resolves({ success: true });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);
    sandbox.stub(executor as any, 'updateBranchRef').resolves(true);

    const context = createMockContext();
    const method = (executor as any).mergeInEphemeralWorktree;
    await method.call(executor, context, '/repo', 'source123', 'main', 'Test merge', ['file1.txt']);

    // CRITICAL: stash operations must NEVER be called
    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called, 'stashPush must not be called');
    assert.ok(!(git.repository.stashPop as sinon.SinonStub).called, 'stashPop must not be called');
    assert.ok(!(git.repository.stashDrop as sinon.SinonStub).called, 'stashDrop must not be called');
  });

  test('validateMergedTree passes when file ratio is above threshold', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    // Stub countTreeFiles to return healthy counts
    sandbox.stub(executor as any, 'countTreeFiles')
      .onFirstCall().resolves(180)   // result
      .onSecondCall().resolves(182)  // source
      .onThirdCall().resolves(170);  // target

    const context = createMockContext();
    const method = (executor as any).validateMergedTree;
    const result = await method.call(executor, context, '/repo', 'resultSha', 'sourceSha', 'targetSha');

    assert.strictEqual(result, undefined); // no error = passed
  });

  test('validateMergedTree fails when file ratio drops below threshold', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    // Stub countTreeFiles: result has far fewer files than richer parent
    sandbox.stub(executor as any, 'countTreeFiles')
      .onFirstCall().resolves(5)     // result — catastrophic loss
      .onSecondCall().resolves(182)  // source
      .onThirdCall().resolves(170);  // target

    const context = createMockContext();
    const method = (executor as any).validateMergedTree;
    const result = await method.call(executor, context, '/repo', 'resultSha', 'sourceSha', 'targetSha');

    assert.ok(result); // should return an error string
    assert.ok(result.includes('ABORTED'));
    assert.ok(result.includes('5 files'));
    assert.ok(result.includes('182 files'));
  });

  test('validateMergedTree skips for very small repos', async () => {
    const executor = new MergeRiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    // Small repo: 3 files to 1 file — ratio is bad but richerCount <= 10
    sandbox.stub(executor as any, 'countTreeFiles')
      .onFirstCall().resolves(1)
      .onSecondCall().resolves(3)
      .onThirdCall().resolves(3);

    const context = createMockContext();
    const method = (executor as any).validateMergedTree;
    const result = await method.call(executor, context, '/repo', 'resultSha', 'sourceSha', 'targetSha');

    assert.strictEqual(result, undefined); // skips validation for small repos
  });

  test('clean merge aborts when tree validation fails', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: true,
      treeSha: 'tree123456789012345678901234567890abcdef12',
      hasConflicts: false,
      conflictFiles: []
    });
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789');
    (git.merge.commitTree as sinon.SinonStub).resolves('merge456');

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'validateMergedTree').resolves('ABORTED: destructive merge detected');

    const context = createMockContext();
    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('ABORTED'));
    // updateRef should NOT have been called (branch not updated)
    assert.ok(!(git.repository.updateRef as sinon.SinonStub).called);
  });
});
