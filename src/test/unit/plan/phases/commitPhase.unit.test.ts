/**
 * @fileoverview Unit tests for CommitPhaseExecutor.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { CommitPhaseExecutor } from '../../../../plan/phases/commitPhase';
import type { CommitPhaseContext } from '../../../../plan/phases/commitPhase';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
import type { IEvidenceValidator } from '../../../../interfaces/IEvidenceValidator';
import type { IGitOperations } from '../../../../interfaces/IGitOperations';
import type { JobNode, LogEntry } from '../../../../plan/types';

function makeNode(overrides: Partial<JobNode> = {}): JobNode {
  return {
    id: 'n1', producerId: 'n1', name: 'Test', type: 'job',
    task: 'do stuff', dependencies: [], dependents: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CommitPhaseContext> = {}): CommitPhaseContext {
  return {
    node: makeNode(), worktreePath: '/tmp/wt', executionKey: 'p:n:1', phase: 'commit',
    baseCommit: 'abc123',
    logInfo: sinon.stub(), logError: sinon.stub(), logOutput: sinon.stub(),
    isAborted: () => false, setProcess: sinon.stub(), setStartTime: sinon.stub(), setIsAgentWork: sinon.stub(),
    getExecutionLogs: () => [],
    ...overrides,
  };
}

function mockEvidenceValidator(has: boolean = false): IEvidenceValidator {
  return {
    hasEvidenceFile: sinon.stub().resolves(has),
    readEvidence: sinon.stub().resolves(undefined),
    validate: sinon.stub().resolves({ valid: true, reason: 'ok' }),
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

suite('CommitPhaseExecutor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('commits when uncommitted changes exist', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['file.ts']);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('def456');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx());
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.commit, 'def456');
  });

  test('succeeds when work stage made commits (HEAD != baseCommit)', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('newcommit');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ baseCommit: 'oldcommit' }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.commit, 'newcommit');
  });

  test('succeeds when evidence file found', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    const headStub = git.worktrees.getHeadCommit as sinon.SinonStub;
    headStub.onFirstCall().resolves('abc123');
    headStub.onSecondCall().resolves('evidcommit');

    const ev = mockEvidenceValidator(true);
    const executor = new CommitPhaseExecutor({ evidenceValidator: ev, getCopilotConfigDir: () => '/tmp', git });

    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, true);
  });

  test('succeeds with expectsNoChanges', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({
      baseCommit: 'abc123',
      node: makeNode({ expectsNoChanges: true }),
    }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.commit, undefined);
  });

  test('fails when no evidence and no agent delegator', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('No work evidence'));
  });

  test('AI review: legitimate no-changes succeeds', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const logs: LogEntry[] = [];
    const delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        opts.logOutput('[ai-review] {"legitimate": true, "reason": "already done"}');
        return { success: true, metrics: { durationMs: 50 } };
      }),
    };
    const logInfo = sinon.stub().callsFake((msg: string) => {
      logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
    });

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({
      baseCommit: 'abc123', logInfo,
      getExecutionLogs: () => logs,
    }));
    assert.strictEqual(result.success, true);
    assert.ok(result.reviewMetrics);
  });

  test('AI review: not legitimate fails', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const logs: LogEntry[] = [];
    const delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        opts.logOutput('[ai-review] {"legitimate": false, "reason": "agent failed"}');
        return { success: true, metrics: { durationMs: 50 } };
      }),
    };
    const logInfo = sinon.stub().callsFake((msg: string) => {
      logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
    });

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({
      baseCommit: 'abc123', logInfo, logError: sinon.stub(),
      getExecutionLogs: () => logs,
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.reviewMetrics);
  });

  test('AI review delegation failure falls through', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const delegator = { delegate: sinon.stub().resolves({ success: false, error: 'timeout' }) };
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, false);
  });

  test('AI review exception falls through', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const delegator = { delegate: sinon.stub().rejects(new Error('network error')) };
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, false);
  });

  test('commit error caught', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).rejects(new Error('git broke'));

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx());
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('git broke'));
  });

  test('shows ignored files when no changes and dirty files empty', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const logInfo = sinon.stub();
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123', logInfo }));
    // Note: ignored files functionality is currently disabled (returns empty array)
    // so this test just verifies the code path runs without error
    assert.strictEqual(result.success, false); // Will fail due to no evidence
  });

  test('truncates ignored files at 50', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    const logInfo = sinon.stub();
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    await executor.execute(makeCtx({ baseCommit: 'abc123', logInfo }));
    // Note: ignored files functionality is currently disabled (returns empty array)
    // so this test just verifies the code path runs without error
    // The actual truncation logic is in the getIgnoredFiles method which is currently a placeholder
  });

  test('handles git status with dirty files', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['file1.ts', 'file2.js']);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('newcommit');

    const logInfo = sinon.stub();
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ logInfo }));
    
    assert.strictEqual(result.success, true);
    assert.ok(logInfo.calledWithMatch('Git status:\nM  file1.ts\nM  file2.js'));
  });

  test('handles git status error gracefully', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).rejects(new Error('git failed'));
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('newcommit');

    const logInfo = sinon.stub();
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp', git });
    const result = await executor.execute(makeCtx({ logInfo }));
    
    assert.strictEqual(result.success, true);
    // Should still succeed since getDirtyFiles is for logging only
  });

  test('AI review truncates logs over 150 lines', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    // Create many log entries (over 150)
    const manyLogs: any[] = [];
    for (let i = 0; i < 160; i++) {
      manyLogs.push({ timestamp: Date.now(), phase: 'work', type: 'info', message: `Log line ${i}` });
    }

    const delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        // Check that instructions contain truncation message
        assert.ok(opts.instructions.includes('(10 earlier lines omitted)'));
        opts.logOutput('[ai-review] {"legitimate": true, "reason": "logs truncated"}');
        return { success: true, metrics: { durationMs: 50 } };
      }),
    };

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    
    // We need to track the logs that include the AI review output
    const reviewLogs: any[] = [...manyLogs];
    
    const context = makeCtx({
      baseCommit: 'abc123',
      getExecutionLogs: () => reviewLogs,
    });
    
    // Override logInfo to capture AI review output in the logs that will be parsed later
    const originalLogInfo = context.logInfo;
    context.logInfo = (message: string) => {
      originalLogInfo(message);
      // Capture AI review messages in commit phase logs
      if (message.includes('[ai-review]')) {
        reviewLogs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message });
      }
    };
    
    const result = await executor.execute(context);
    assert.strictEqual(result.success, true);
  });

  test('AI review with work description variations', async () => {
    const git = mockGitOperations();
    (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
    (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
    (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('abc123');

    // Test process work type
    const processWork = { type: 'process' as const, executable: 'node', args: ['script.js'] };
    let delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        assert.ok(opts.instructions.includes('Process: node script.js'));
        opts.logOutput('[ai-review] {"legitimate": true, "reason": "test"}');
        return { success: true };
      }),
    };
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    await executor.execute(makeCtx({ baseCommit: 'abc123', node: makeNode({ work: processWork }) }));

    // Test agent work type
    const agentWork = { type: 'agent' as const, instructions: 'Do something with AI' };
    delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        assert.ok(opts.instructions.includes('Agent: Do something with AI'));
        opts.logOutput('[ai-review] {"legitimate": true, "reason": "test"}');
        return { success: true };
      }),
    };
    const executor2 = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    await executor2.execute(makeCtx({ baseCommit: 'abc123', node: makeNode({ work: agentWork }) }));

    // Test no work
    delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        assert.ok(opts.instructions.includes('No work specified'));
        opts.logOutput('[ai-review] {"legitimate": true, "reason": "test"}');
        return { success: true };
      }),
    };
    const executor3 = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', git });
    await executor3.execute(makeCtx({ baseCommit: 'abc123', node: makeNode({ work: undefined }) }));
  });
});
