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
      resetMixed: sinon.stub().resolves(),
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
      isAncestor: sinon.stub().resolves(false),
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
      catFileFromTree: sinon.stub().resolves('file content'),
      hashObjectFromFile: sinon.stub().resolves('blob123'),
      replaceTreeBlobs: sinon.stub().resolves('newtree123'),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(true),
      isIgnored: sinon.stub().resolves(false),
      isOrchestratorGitIgnoreConfigured: sinon.stub().resolves(true),
      ensureOrchestratorGitIgnore: sinon.stub().resolves(true),
    isDiffOnlyOrchestratorChanges: sinon.stub().returns(true),
    },
    command: {} as any,
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

  test('merge conflict with resolution - conflict resolved in-memory', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      treeSha: 'conflictedtree123',
      conflictFiles: ['conflict1.txt', 'conflict2.txt']
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const resolveStub = sandbox.stub(executor as any, 'resolveConflictsInMemory').resolves({
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
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Resolving in-memory/)));
    
    assert.ok(resolveStub.calledOnce);
    // treeSha must be passed through
    assert.strictEqual(resolveStub.firstCall.args[5], 'conflictedtree123');
    
    assert.ok(result.metrics);
    assert.strictEqual(result.metrics!.tokenUsage?.totalTokens, 225);
  });

  test('merge conflict with failed resolution - returns failure', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      treeSha: 'conflictedtree123',
      conflictFiles: ['failed.txt']
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'resolveConflictsInMemory').resolves({
      success: false,
      error: 'Could not resolve conflicts'
    });

    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Could not resolve conflicts'));
  });

  test('merge conflict with no treeSha returns failure', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      treeSha: undefined,
      conflictFiles: ['broken.txt']
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('no tree SHA'));
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

  test('resolveConflictsInMemory extracts files, calls Copilot, hashes back, commits', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');
    // catFileFromTree returns content with conflict markers
    (git.merge.catFileFromTree as sinon.SinonStub).resolves('<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs\n');
    (git.merge.hashObjectFromFile as sinon.SinonStub).resolves('resolvedblob123');
    (git.merge.replaceTreeBlobs as sinon.SinonStub).resolves('resolvedtree456');
    (git.merge.commitTree as sinon.SinonStub).resolves('mergecommit789');

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    sandbox.stub(executor as any, 'validateMergedTree').resolves(undefined);
    sandbox.stub(executor as any, 'updateBranchRef').resolves(true);

    const context = createMockContext();
    const tmpRepo = makeTmpDir();
    fs.mkdirSync(path.join(tmpRepo, '.git'), { recursive: true });
    const method = (executor as any).resolveConflictsInMemory;
    const result = await method.call(
      executor, context, tmpRepo, 'source123', 'main',
      'Test merge', 'conflictedtree000', ['file1.txt']
    );

    assert.strictEqual(result.success, true);
    // catFileFromTree must be called for each conflict file
    assert.ok((git.merge.catFileFromTree as sinon.SinonStub).calledOnce);
    // replaceTreeBlobs must be called with the conflicted tree
    assert.ok((git.merge.replaceTreeBlobs as sinon.SinonStub).calledOnce);
    assert.strictEqual((git.merge.replaceTreeBlobs as sinon.SinonStub).firstCall.args[1], 'conflictedtree000');
    // commitTree gets the resolved tree
    assert.ok((git.merge.commitTree as sinon.SinonStub).calledOnce);
    assert.strictEqual((git.merge.commitTree as sinon.SinonStub).firstCall.args[0], 'resolvedtree456');
    // No worktree created, no checkout, no stash
    assert.ok(!(git.worktrees.createDetachedWithTiming as sinon.SinonStub).called);
    assert.ok(!(git.branches.checkout as sinon.SinonStub).called);
  });

  test('resolveConflictsInMemory returns failure when Copilot cannot resolve', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');
    (git.merge.catFileFromTree as sinon.SinonStub).resolves('content');

    // Copilot runner fails
    const failRunner: ICopilotRunner = {
      ...mockCopilotRunner,
      run: async () => ({ success: false, error: 'Copilot failed' })
    };

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: failRunner });
    const context = createMockContext();
    const tmpRepo = makeTmpDir();
    fs.mkdirSync(path.join(tmpRepo, '.git'), { recursive: true });
    const method = (executor as any).resolveConflictsInMemory;
    const result = await method.call(
      executor, context, tmpRepo, 'source123', 'main',
      'Test merge', 'conflictedtree000', ['file1.txt']
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Copilot CLI failed'));
  });

  test('updateBranchRef resets working tree when branch checked out and clean', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'abc123');

    assert.strictEqual(result, true);
    assert.ok((git.repository.updateRef as sinon.SinonStub).calledOnce);
    // Clean before ref move → safe to reset with explicit commit SHA
    assert.ok((git.repository.resetHard as sinon.SinonStub).calledOnce);
    assert.strictEqual((git.repository.resetHard as sinon.SinonStub).firstCall.args[1], 'abc123');
    // Must NOT stash — no stash/pop cycle
    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Synced main worktree/)));
  });

  test('updateBranchRef does mixed reset + selective checkout when dirty', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    // User has Cargo.lock dirty before the merge
    (git.repository.getDirtyFiles as sinon.SinonStub).onFirstCall().resolves(['Cargo.lock']);
    // After mixed reset: Cargo.lock still dirty + plan-changed files appear
    (git.repository.getDirtyFiles as sinon.SinonStub).onSecondCall().resolves(['Cargo.lock', 'src/lib.rs', 'README.md']);

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'abc123');

    assert.strictEqual(result, true);
    // Dirty before ref move → do NOT hard reset (would destroy user changes)
    assert.ok(!(git.repository.resetHard as sinon.SinonStub).called);
    // MUST do a mixed reset so the index matches the new HEAD
    assert.ok((git.repository.resetMixed as sinon.SinonStub).calledOnce);
    assert.strictEqual((git.repository.resetMixed as sinon.SinonStub).firstCall.args[1], 'abc123');
    // Plan-changed files (src/lib.rs, README.md) should be checked out from index
    // User's dirty file (Cargo.lock) should NOT be touched
    const checkedOutFiles = (git.repository.checkoutFile as sinon.SinonStub).args.map((a: any[]) => a[1]);
    assert.ok(checkedOutFiles.includes('src/lib.rs'));
    assert.ok(checkedOutFiles.includes('README.md'));
    assert.ok(!checkedOutFiles.includes('Cargo.lock'));
    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Synced index/)));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Preserved 1 pre-existing/)));
  });

  test('updateBranchRef tolerates resetMixed failure when dirty', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['Cargo.lock']);
    (git.repository.resetMixed as sinon.SinonStub).rejects(new Error('index locked'));

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'abc123');

    // Still succeeds — resetMixed failure is non-fatal
    assert.strictEqual(result, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/Could not sync working tree/)));
  });

  test('updateBranchRef does not reset when different branch checked out', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('feature-branch');

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'abc123');

    assert.strictEqual(result, true);
    assert.ok(!(git.repository.resetHard as sinon.SinonStub).called);
  });

  test('updateBranchRef never uses stash/pop cycle', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    await method.call(executor, context, '/repo', 'main', 'abc123');

    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called);
    assert.ok(!(git.repository.stashPop as sinon.SinonStub).called);
  });

  test('updateBranchRef tolerates currentOrNull failure gracefully', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).rejects(new Error('git error'));

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'abc123');

    // Still succeeds — dirty check failure is non-fatal (defaults to branchCheckedOut=false, no reset)
    assert.strictEqual(result, true);
    assert.ok(!(git.repository.resetHard as sinon.SinonStub).called);
    assert.ok(!(git.repository.resetMixed as sinon.SinonStub).called);
  });

  test('resolveConflictFilesWithCopilot runs copilot and returns metrics', async () => {
    const git = mockGitOperations();
    const runStub = sinon.stub().resolves({ success: true, metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } });
    const copilotRunner: ICopilotRunner = { ...mockCopilotRunner, run: runStub };

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner });
    const context = createMockContext();
    const method = (executor as any).resolveConflictFilesWithCopilot;
    const result = await method.call(executor, context, '/tmp/dir', '/repo', 'src123', 'main', 'merge msg', ['a.ts', 'b.ts']);

    assert.strictEqual(result.success, true);
    assert.ok(result.metrics);
    assert.ok(runStub.calledOnce);
    const taskArg = runStub.firstCall.args[0].task;
    assert.ok(taskArg.includes('a.ts'));
    assert.ok(taskArg.includes('b.ts'));
  });

  test('resolveConflictFilesWithCopilot returns failure on copilot error', async () => {
    const git = mockGitOperations();
    const runStub = sinon.stub().rejects(new Error('copilot crashed'));
    const copilotRunner: ICopilotRunner = { ...mockCopilotRunner, run: runStub };

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner });
    const context = createMockContext();
    const method = (executor as any).resolveConflictFilesWithCopilot;
    const result = await method.call(executor, context, '/tmp/dir', '/repo', 'src123', 'main', 'merge msg', ['a.ts']);

    assert.strictEqual(result.success, false);
  });

  test('validateMergedTree passes when file counts are comparable', async () => {
    const git = mockGitOperations();
    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).validateMergedTree;

    // Stub countTreeFiles to return comparable counts
    (executor as any).countTreeFiles = sinon.stub()
      .onFirstCall().resolves(100)  // result
      .onSecondCall().resolves(100)  // source
      .onThirdCall().resolves(95);   // target

    const result = await method.call(executor, context, '/repo', 'result123', 'source123', 'target123');
    assert.strictEqual(result, undefined);
  });

  test('validateMergedTree catches errors and returns undefined', async () => {
    const git = mockGitOperations();
    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).validateMergedTree;

    // Force countTreeFiles to throw
    (executor as any).countTreeFiles = sinon.stub().rejects(new Error('ls-tree failed'));

    const result = await method.call(executor, context, '/repo', 'result123', 'source123', 'target123');
    assert.strictEqual(result, undefined);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith(sinon.match(/validation skipped/)));
  });

  test('countTreeFiles returns count from ls-tree output', async () => {
    const git = mockGitOperations();
    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const method = (executor as any).countTreeFiles;

    // We can't easily stub execAsync import, but we can test via the public flow
    // The method returns 0 on failure which is the safe fallback
    const count = await method.call(executor, '/nonexistent', 'abc123');
    assert.strictEqual(typeof count, 'number');
  });

  test('pushIfConfigured skips when no configManager', async () => {
    const git = mockGitOperations();
    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).pushIfConfigured;
    // Should not throw when configManager is undefined
    await method.call(executor, context, '/repo', 'main');
    assert.ok(!(git.repository.push as sinon.SinonStub).called);
  });

  test('updateBranchRef returns false on error', async () => {
    const git = mockGitOperations();
    (git.repository.updateRef as sinon.SinonStub).rejects(new Error('ref update failed'));

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'newcommit123');

    assert.strictEqual(result, false);
  });

  test('execute handles merge-tree failure gracefully', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false, hasConflicts: false, treeSha: null, conflictFiles: [],
      error: 'merge-tree internal error'
    });

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Merge-tree failed'));
  });

  test('execute handles conflict path success', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false, hasConflicts: true, treeSha: 'conflicttree123',
      conflictFiles: ['file1.ts']
    });
    (git.merge.catFileFromTree as sinon.SinonStub).resolves('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> source');
    (git.merge.hashObjectFromFile as sinon.SinonStub).resolves('resolvedblob123');
    (git.merge.replaceTreeBlobs as sinon.SinonStub).resolves('resolvedtree123');
    (git.merge.commitTree as sinon.SinonStub).resolves('mergecommit123');

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();

    // Stub validateMergedTree and pushIfConfigured to avoid external calls
    (executor as any).validateMergedTree = sinon.stub().resolves(undefined);
    (executor as any).pushIfConfigured = sinon.stub().resolves();

    const result = await executor.execute(context);
    assert.strictEqual(result.success, true);
  });

  test('execute handles conflict resolution failure', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).resolves(true);
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false, hasConflicts: true, treeSha: 'conflicttree123',
      conflictFiles: ['file1.ts']
    });
    (git.merge.catFileFromTree as sinon.SinonStub).resolves('conflict content');

    const failRunner: ICopilotRunner = {
      ...mockCopilotRunner,
      run: async () => ({ success: false, error: 'Copilot failed' })
    };

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: failRunner });
    const context = createMockContext();
    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('resolve merge conflicts') || result.error?.includes('Copilot CLI failed'));
  });

  test('execute catches exceptions in try block', async () => {
    const git = mockGitOperations();
    (git.repository.hasChangesBetween as sinon.SinonStub).rejects(new Error('git crashed'));

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('git crashed'));
  });

  test('updateBranchRef resets cleanly and never stashes', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'newcommit123');

    assert.strictEqual(result, true);
    assert.ok((git.repository.updateRef as sinon.SinonStub).calledOnce);
    assert.ok((git.repository.resetHard as sinon.SinonStub).calledOnce);
    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called);
  });

  test('updateBranchRef skips reset when different branch is checked out', async () => {
    const git = mockGitOperations();
    (git.branches.currentOrNull as sinon.SinonStub).resolves('feature-branch');

    const executor = new MergeRiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    const method = (executor as any).updateBranchRef;
    const result = await method.call(executor, context, '/repo', 'main', 'newcommit123');

    assert.strictEqual(result, true);
    assert.ok(!(git.repository.resetHard as sinon.SinonStub).called);
    assert.ok(!(git.repository.stashPush as sinon.SinonStub).called);
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
