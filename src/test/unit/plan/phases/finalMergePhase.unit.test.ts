/**
 * @fileoverview Unit tests for FinalMergeExecutor
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { FinalMergeExecutor } from '../../../../plan/phases/finalMergePhase';
import type { PlanInstance } from '../../../../plan/types/plan';
import type { IGitOperations } from '../../../../interfaces/IGitOperations';

function mockGitOperations(): IGitOperations {
  return {
    repository: {
      resolveRef: sinon.stub().resolves('abc123def456'),
      hasChangesBetween: sinon.stub().resolves(true),
      hasUncommittedChanges: sinon.stub().resolves(false),
      resetHard: sinon.stub().resolves(),
      updateRef: sinon.stub().resolves(),
      stageAll: sinon.stub().resolves(),
      commit: sinon.stub().resolves(true),
      getHead: sinon.stub().resolves('abc123'),
      hasChanges: sinon.stub().resolves(false),
      push: sinon.stub().resolves(true),
      stashPush: sinon.stub().resolves(true),
      stashPop: sinon.stub().resolves(true),
    },
    worktrees: {
      createDetachedWithTiming: sinon.stub().resolves({ durationMs: 100, baseCommit: 'abc123def456' }),
      removeSafe: sinon.stub().resolves(true),
      isValid: sinon.stub().resolves(true),
      list: sinon.stub().resolves([]),
    },
    branches: {
      create: sinon.stub().resolves(),
      deleteLocal: sinon.stub().resolves(true),
      deleteRemote: sinon.stub().resolves(true),
      currentOrNull: sinon.stub().resolves(null),
      checkout: sinon.stub().resolves(),
    },
    merge: {
      mergeWithoutCheckout: sinon.stub().resolves({ success: true, treeSha: 'mergedtree123', hasConflicts: false }),
      commitTree: sinon.stub().resolves('finalcommit123'),
    },
    gitignore: {},
    command: {},
  } as any;
}

function createMockPlan(overrides: Partial<PlanInstance> = {}): PlanInstance {
  return {
    id: 'plan-123',
    spec: { name: 'Test Plan', jobs: [] },
    repoPath: '/repo',
    targetBranch: 'main',
    snapshot: {
      branch: 'orchestrator/snapshot/plan-123',
      worktreePath: '/wt/_snapshot',
      baseCommit: 'base123',
    },
    nodes: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
    nodeStates: new Map(),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    baseBranch: 'main',
    worktreeRoot: '/wt',
    createdAt: Date.now(),
    stateVersion: 1,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
    ...overrides,
  } as PlanInstance;
}

suite('FinalMergeExecutor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('returns success with 0 attempts when no targetBranch', async () => {
    const git = mockGitOperations();
    const executor = new FinalMergeExecutor({ git, log: sinon.spy() });
    const plan = createMockPlan({ targetBranch: undefined });

    const result = await executor.execute(plan);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts, 0);
  });

  test('returns success with 0 attempts when no snapshot', async () => {
    const git = mockGitOperations();
    const executor = new FinalMergeExecutor({ git, log: sinon.spy() });
    const plan = createMockPlan({ snapshot: undefined });

    const result = await executor.execute(plan);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts, 0);
  });

  test('successful merge in 1 attempt', async () => {
    const git = mockGitOperations();
    // Target hasn't moved, so rebase is a no-op
    (git.repository.resolveRef as sinon.SinonStub)
      .withArgs('main', '/repo').resolves('base123')
      .withArgs('orchestrator/snapshot/plan-123', '/repo').resolves('snapshot456');

    const logSpy = sinon.spy();
    const executor = new FinalMergeExecutor({ git, log: logSpy });
    const plan = createMockPlan();

    const result = await executor.execute(plan);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts, 1);
    assert.ok((git.merge.mergeWithoutCheckout as sinon.SinonStub).calledOnce);
    assert.ok((git.merge.commitTree as sinon.SinonStub).calledOnce);
    assert.ok((git.repository.updateRef as sinon.SinonStub).called);
  });

  test('merge-tree failure returns error', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('base123');
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false, hasConflicts: false, treeSha: null, error: 'merge failed'
    });

    const executor = new FinalMergeExecutor({ git, log: sinon.spy() });
    const plan = createMockPlan();

    const result = await executor.execute(plan);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.attempts, 2); // Retries once
    assert.ok(result.error?.includes('Final merge failed after 2 attempts'));
  });

  test('conflict in merge-tree returns error', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('base123');
    (git.merge.mergeWithoutCheckout as sinon.SinonStub).resolves({
      success: false, hasConflicts: true, treeSha: 'conflicttree',
      conflictFiles: ['a.ts', 'b.ts']
    });

    const executor = new FinalMergeExecutor({ git, log: sinon.spy() });
    const plan = createMockPlan();

    const result = await executor.execute(plan);
    assert.strictEqual(result.success, false);
  });

  test('verification failure blocks merge', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('base123');

    const verifyRi = sinon.stub().resolves({ success: false, error: 'compilation failed' });
    const executor = new FinalMergeExecutor({ git, log: sinon.spy(), runVerifyRi: verifyRi });
    const plan = createMockPlan();

    const result = await executor.execute(plan);
    assert.strictEqual(result.success, false);
    // verification is called before merge
    assert.ok(verifyRi.called);
  });

  test('resets working tree when branch checked out and clean', async () => {
    const git = mockGitOperations();
    // resolveRef for both main and snapshot
    (git.repository.resolveRef as sinon.SinonStub).resolves('base123');
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);

    const executor = new FinalMergeExecutor({ git, log: sinon.spy() });
    const plan = createMockPlan();

    await executor.execute(plan);
    assert.ok((git.repository.resetHard as sinon.SinonStub).called);
  });

  test('does not reset when working tree is dirty', async () => {
    const git = mockGitOperations();
    (git.repository.resolveRef as sinon.SinonStub).resolves('base123');
    (git.branches.currentOrNull as sinon.SinonStub).resolves('main');
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);

    const executor = new FinalMergeExecutor({ git, log: sinon.spy() });
    const plan = createMockPlan();

    await executor.execute(plan);
    assert.ok(!(git.repository.resetHard as sinon.SinonStub).called);
  });
});
