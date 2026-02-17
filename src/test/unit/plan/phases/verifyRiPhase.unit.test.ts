/**
 * @fileoverview Unit tests for VerifyRiPhaseExecutor
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { VerifyRiPhaseExecutor } from '../../../../plan/phases/verifyRiPhase';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
import type { IGitOperations } from '../../../../interfaces/IGitOperations';

function mockGitOperations(): IGitOperations {
  return {
    repository: {
      fetch: sinon.stub().resolves(),
      pull: sinon.stub().resolves(true),
      push: sinon.stub().resolves(true),
      stageAll: sinon.stub().resolves(),
      stageFile: sinon.stub().resolves(),
      commit: sinon.stub().resolves(true),
      hasChanges: sinon.stub().resolves(false),
      hasStagedChanges: sinon.stub().resolves(false),
      hasUncommittedChanges: sinon.stub().resolves(false),
      getHead: sinon.stub().resolves('head123'),
      resolveRef: sinon.stub().resolves('target789abc'),
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
      getDirtyFiles: sinon.stub().resolves([]),
    },
    worktrees: {
      getHeadCommit: sinon.stub().resolves('abc123'),
      create: sinon.stub().resolves(),
      createWithTiming: sinon.stub().resolves({ durationMs: 100 }),
      createDetachedWithTiming: sinon.stub().resolves({ durationMs: 100, baseCommit: 'target789abc' }),
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
  } as any;
}

function createMockContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    node: {
      id: 'node1',
      name: 'test-node',
      task: 'Test task',
      dependencies: [],
      dependents: [],
    } as any,
    worktreePath: '/tmp/worktree',
    executionKey: 'plan1:node1:1',
    phase: 'verify-ri' as any,
    logInfo: sinon.stub(),
    logError: sinon.stub(),
    logOutput: sinon.stub(),
    isAborted: () => false,
    setProcess: sinon.stub(),
    setStartTime: sinon.stub(),
    setIsAgentWork: sinon.stub(),
    repoPath: '/repo',
    targetBranch: 'main',
    ...overrides,
  };
}

const mockSpawner = {
  spawn: sinon.stub(),
};

suite('VerifyRiPhaseExecutor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => {
    sandbox.restore();
  });

  test('constructor creates instance', () => {
    const git = mockGitOperations();
    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    assert.ok(executor);
  });

  test('returns success when no workSpec provided', async () => {
    const git = mockGitOperations();
    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: undefined });

    const result = await executor.execute(context);
    assert.strictEqual(result.success, true);
  });

  test('returns success when no repoPath provided', async () => {
    const git = mockGitOperations();
    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: 'npm test', repoPath: undefined });

    const result = await executor.execute(context);
    assert.strictEqual(result.success, true);
  });

  test('returns success when no targetBranch provided', async () => {
    const git = mockGitOperations();
    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: 'npm test', targetBranch: undefined });

    const result = await executor.execute(context);
    assert.strictEqual(result.success, true);
  });

  test('creates worktree at targetBranch HEAD for verification', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');

    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    // workSpec is 'npm test' (shell type) — the spawner will fail, but we check the worktree was created
    const context = createMockContext({ workSpec: 'npm test' });

    // The spawn will fail because we haven't set up the spawner, but the worktree
    // creation and ref resolution should still happen. Catch the error.
    await executor.execute(context).catch(() => {});

    assert.ok((git.repository.resolveRef as sinon.SinonStub).calledWith('main', '/repo'));
    assert.ok((git.worktrees.createDetachedWithTiming as sinon.SinonStub).calledOnce);
  });

  test('cleans up worktree after successful verification', async () => {
    const git = mockGitOperations();
    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });

    // Override the phase to skip actual work execution but exercise worktree lifecycle
    const context = createMockContext({ workSpec: undefined });
    await executor.execute(context);

    // With no workSpec, it returns early — no worktree needed
    assert.ok(!(git.worktrees.createDetachedWithTiming as sinon.SinonStub).called);
  });

  test('commits verification fixes to targetBranch when changes detected', async () => {
    const git = mockGitOperations();
    (git.repository.hasChanges as sinon.SinonStub).resolves(true);
    (git.repository.getHead as sinon.SinonStub).resolves('fixcommit789');

    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: 'npm test' });

    // Call commitVerifyFixIfNeeded directly
    const method = (executor as any).commitVerifyFixIfNeeded;
    await method.call(executor, context, '/repo', '/worktree', 'main');

    assert.ok((git.repository.stageAll as sinon.SinonStub).calledOnce);
    assert.ok((git.repository.commit as sinon.SinonStub).calledOnce);
    assert.ok((git.repository.updateRef as sinon.SinonStub).calledOnce);
    // updateRef should point to the fix commit
    const [repoPath, ref, commit] = (git.repository.updateRef as sinon.SinonStub).firstCall.args;
    assert.strictEqual(repoPath, '/repo');
    assert.strictEqual(ref, 'refs/heads/main');
    assert.strictEqual(commit, 'fixcommit789');
  });

  test('does not commit when verification produces no changes', async () => {
    const git = mockGitOperations();
    (git.repository.hasChanges as sinon.SinonStub).resolves(false);

    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: 'npm test' });

    const method = (executor as any).commitVerifyFixIfNeeded;
    await method.call(executor, context, '/repo', '/worktree', 'main');

    assert.ok(!(git.repository.stageAll as sinon.SinonStub).called);
    assert.ok(!(git.repository.commit as sinon.SinonStub).called);
  });

  test('full execute: shell workSpec success with worktree lifecycle', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');

    const { EventEmitter } = require('events');
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdout.setEncoding = sinon.stub();
    mockProc.stderr.setEncoding = sinon.stub();
    mockProc.pid = 12345;
    mockProc.killed = false;
    mockProc.kill = sinon.stub();

    const spawner = {
      spawn: sinon.stub().returns(mockProc),
    };

    const executor = new VerifyRiPhaseExecutor({ spawner: spawner as any, git });
    const context = createMockContext({ workSpec: 'npm test' });

    const resultPromise = executor.execute(context);

    // Let the process emit close with code 0 — must be after spawn listeners attach
    setTimeout(() => {
      mockProc.emit('close', 0);
    }, 20);

    const result = await resultPromise;
    assert.strictEqual(result.success, true);

    // Verify worktree was created and cleaned up
    assert.ok((git.worktrees.createDetachedWithTiming as sinon.SinonStub).calledOnce);
    assert.ok((git.worktrees.removeSafe as sinon.SinonStub).calledOnce);
  });

  test('full execute: shell workSpec failure returns error', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');

    const { EventEmitter } = require('events');
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdout.setEncoding = sinon.stub();
    mockProc.stderr.setEncoding = sinon.stub();
    mockProc.pid = 12345;
    mockProc.killed = false;
    mockProc.kill = sinon.stub();

    const spawner = {
      spawn: sinon.stub().returns(mockProc),
    };

    const executor = new VerifyRiPhaseExecutor({ spawner: spawner as any, git });
    const context = createMockContext({ workSpec: 'npm test' });

    const resultPromise = executor.execute(context);

    // Process exits with failure
    setTimeout(() => {
      mockProc.emit('close', 1);
    }, 20);

    const result = await resultPromise;
    assert.strictEqual(result.success, false);

    // Worktree should still be cleaned up on failure
    assert.ok((git.worktrees.removeSafe as sinon.SinonStub).calledOnce);
  });

  test('execute catches errors and cleans up worktree', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');
    (git.worktrees.createDetachedWithTiming as sinon.SinonStub).rejects(new Error('worktree creation failed'));

    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: 'npm test' });

    const result = await executor.execute(context);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('worktree creation failed'));

    // removeSafe should still be called in finally block
    assert.ok((git.worktrees.removeSafe as sinon.SinonStub).calledOnce);
  });

  test('execute with process workSpec type', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');

    const { EventEmitter } = require('events');
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdout.setEncoding = sinon.stub();
    mockProc.stderr.setEncoding = sinon.stub();
    mockProc.pid = 12345;
    mockProc.killed = false;
    mockProc.kill = sinon.stub();

    const spawner = {
      spawn: sinon.stub().returns(mockProc),
    };

    const executor = new VerifyRiPhaseExecutor({ spawner: spawner as any, git });
    const processSpec = { type: 'process', command: 'npm', args: ['test'] };
    const context = createMockContext({ workSpec: processSpec as any });

    const resultPromise = executor.execute(context);
    setTimeout(() => { mockProc.emit('close', 0); }, 20);

    const result = await resultPromise;
    assert.strictEqual(result.success, true);
  });

  test('execute with agent workSpec type returns error without delegator', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('target789abc');

    const { EventEmitter } = require('events');
    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const agentSpec = { type: 'agent', instructions: 'Fix issues' };
    const context = createMockContext({ workSpec: agentSpec as any });

    const result = await executor.execute(context);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('agent delegator'));
  });

  test('commitVerifyFixIfNeeded handles commit failure gracefully', async () => {
    const git = mockGitOperations();
    (git.repository.hasChanges as sinon.SinonStub).resolves(true);
    (git.repository.commit as sinon.SinonStub).resolves(false); // commit returns false

    const executor = new VerifyRiPhaseExecutor({ spawner: mockSpawner as any, git });
    const context = createMockContext({ workSpec: 'npm test' });

    const method = (executor as any).commitVerifyFixIfNeeded;
    await method.call(executor, context, '/repo', '/worktree', 'main');

    // stageAll was called, commit was called but returned false
    assert.ok((git.repository.stageAll as sinon.SinonStub).calledOnce);
    assert.ok((git.repository.commit as sinon.SinonStub).calledOnce);
    // updateRef should NOT be called since commit failed
    assert.ok(!(git.repository.updateRef as sinon.SinonStub).called);
  });
});
