/**
 * @fileoverview Unit tests for CommitPhaseExecutor.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as git from '../../../../git';
import { CommitPhaseExecutor } from '../../../../plan/phases/commitPhase';
import type { CommitPhaseContext } from '../../../../plan/phases/commitPhase';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
import type { IEvidenceValidator } from '../../../../interfaces/IEvidenceValidator';
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

suite('CommitPhaseExecutor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('commits when uncommitted changes exist', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves(['file.ts']);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(true);
    sandbox.stub(git.repository, 'stageAll').resolves();
    sandbox.stub(git.repository, 'commit').resolves(true);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('def456');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx());
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.commit, 'def456');
  });

  test('succeeds when work stage made commits (HEAD != baseCommit)', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('newcommit');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({ baseCommit: 'oldcommit' }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.commit, 'newcommit');
  });

  test('succeeds when evidence file found', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');
    sandbox.stub(git.repository, 'stageAll').resolves();
    sandbox.stub(git.repository, 'commit').resolves(true);

    const ev = mockEvidenceValidator(true);
    const executor = new CommitPhaseExecutor({ evidenceValidator: ev, getCopilotConfigDir: () => '/tmp' });
    const headStub = git.worktrees.getHeadCommit as sinon.SinonStub;
    headStub.onSecondCall().resolves('evidcommit');

    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, true);
  });

  test('succeeds with expectsNoChanges', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({
      baseCommit: 'abc123',
      node: makeNode({ expectsNoChanges: true }),
    }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.commit, undefined);
  });

  test('fails when no evidence and no agent delegator', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('No work evidence'));
  });

  test('AI review: legitimate no-changes succeeds', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

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

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({
      baseCommit: 'abc123', logInfo,
      getExecutionLogs: () => logs,
    }));
    assert.strictEqual(result.success, true);
    assert.ok(result.reviewMetrics);
  });

  test('AI review: not legitimate fails', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

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

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({
      baseCommit: 'abc123', logInfo, logError: sinon.stub(),
      getExecutionLogs: () => logs,
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.reviewMetrics);
  });

  test('AI review delegation failure falls through', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

    const delegator = { delegate: sinon.stub().resolves({ success: false, error: 'timeout' }) };
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, false);
  });

  test('AI review exception falls through', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

    const delegator = { delegate: sinon.stub().rejects(new Error('network error')) };
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), agentDelegator: delegator, getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123' }));
    assert.strictEqual(result.success, false);
  });

  test('commit error caught', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'hasUncommittedChanges').rejects(new Error('git broke'));

    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx());
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('git broke'));
  });

  test('shows ignored files when no changes and dirty files empty', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves(['node_modules/a.js']);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

    const logInfo = sinon.stub();
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    const result = await executor.execute(makeCtx({ baseCommit: 'abc123', logInfo }));
    assert.ok(logInfo.calledWithMatch(sinon.match(/Ignored files/)));
  });

  test('truncates ignored files at 50', async () => {
    sandbox.stub(git.repository, 'getDirtyFiles').resolves([]);
    const manyFiles = Array.from({ length: 60 }, (_, i) => `f${i}.js`);
    sandbox.stub(git.repository, 'getIgnoredFiles').resolves(manyFiles);
    sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
    sandbox.stub(git.worktrees, 'getHeadCommit').resolves('abc123');

    const logInfo = sinon.stub();
    const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), getCopilotConfigDir: () => '/tmp' });
    await executor.execute(makeCtx({ baseCommit: 'abc123', logInfo }));
    assert.ok(logInfo.calledWithMatch(sinon.match(/truncated/)));
  });
});
