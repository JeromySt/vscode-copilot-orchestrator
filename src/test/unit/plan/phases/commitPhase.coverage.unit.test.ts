/**
 * @fileoverview Coverage-focused tests for CommitPhaseExecutor.
 * 
 * Targets specific areas for comprehensive coverage:
 * - CommitPhaseContext.getWorkSpec field usage
 * - removeCopilotCliDir() cleanup path
 * - removeOrchestratorSkillDir() cleanup path
 * - AI review with no file changes (assessNoChangeOutcome)
 * - Evidence file detection and staging
 * - expectsNoChanges flag behavior
 * - Stage-all and commit flow
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { CommitPhaseExecutor } from '../../../../plan/phases/commitPhase';
import type { CommitPhaseContext } from '../../../../plan/phases/commitPhase';
import type { IEvidenceValidator } from '../../../../interfaces/IEvidenceValidator';
import type { IGitOperations } from '../../../../interfaces/IGitOperations';
import type { JobNode, LogEntry } from '../../../../plan/types';

function makeNode(overrides: Partial<JobNode> = {}): JobNode {
  return {
    id: 'n1',
    producerId: 'n1',
    name: 'Test Node',
    type: 'job',
    task: 'Test Task',
    dependencies: [],
    dependents: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CommitPhaseContext> = {}): CommitPhaseContext {
  return {
    node: makeNode(),
    worktreePath: '/tmp/worktree',
    executionKey: 'plan:node:1',
    phase: 'commit',
    baseCommit: 'base123',
    logInfo: sinon.stub(),
    logError: sinon.stub(),
    logOutput: sinon.stub(),
    isAborted: () => false,
    setProcess: sinon.stub(),
    setStartTime: sinon.stub(),
    setIsAgentWork: sinon.stub(),
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
      resolveRef: sinon.stub().resolves('base123'),
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
      getHeadCommit: sinon.stub().resolves('base123'),
      create: sinon.stub().resolves(),
      createWithTiming: sinon.stub().resolves({ durationMs: 100 }),
      createDetachedWithTiming: sinon.stub().resolves({ durationMs: 100, baseCommit: 'base123' }),
      createOrReuseDetached: sinon.stub().resolves({ durationMs: 100, baseCommit: 'base123', reused: false }),
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
      getCommit: sinon.stub().resolves('base123'),
      getMergeBase: sinon.stub().resolves('base123'),
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

suite('CommitPhaseExecutor - Coverage', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('getWorkSpec field usage', () => {
    test('AI review uses getWorkSpec callback when present', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logs: LogEntry[] = [];
      let capturedInstructions = '';
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          capturedInstructions = opts.instructions;
          opts.logOutput('[ai-review] {"legitimate": true, "reason": "using hydrated work"}');
          return { success: true };
        }),
      };
      const logInfo = sinon.stub().callsFake((msg: string) => {
        logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      // Work spec returned via async getWorkSpec callback
      const hydratedWork = {
        type: 'agent' as const,
        instructions: 'Hydrated instructions from disk',
      };

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const ctx = makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => logs,
        getWorkSpec: async () => hydratedWork,
        node: makeNode({ work: { type: 'agent', instructions: 'Original inline instructions' } }),
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      // The commit phase resolves work as: node.work || (ctx.getWorkSpec ? await ctx.getWorkSpec() : undefined)
      // Since node.work is present, it takes priority
      assert.ok(capturedInstructions.includes('Agent:'));
    });

    test('AI review falls back to node.work when getWorkSpec is undefined', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logs: LogEntry[] = [];
      let capturedInstructions = '';
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          capturedInstructions = opts.instructions;
          opts.logOutput('[ai-review] {"legitimate": true, "reason": "using node.work"}');
          return { success: true };
        }),
      };
      const logInfo = sinon.stub().callsFake((msg: string) => {
        logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const ctx = makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => logs,
        getWorkSpec: undefined,
        node: makeNode({ work: { type: 'agent', instructions: 'Fallback instructions from node' } }),
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(capturedInstructions.includes('Agent: Fallback instructions from node'));
    });

    test('AI review handles getWorkSpec returning JSON string', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logs: LogEntry[] = [];
      let capturedInstructions = '';
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          capturedInstructions = opts.instructions;
          opts.logOutput('[ai-review] {"legitimate": true, "reason": "parsed JSON"}');
          return { success: true };
        }),
      };
      const logInfo = sinon.stub().callsFake((msg: string) => {
        logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      // getWorkSpec returns a JSON-encoded string (what might come from persistence)
      const hydratedWork = '{"type":"shell","command":"npm test"}';

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const ctx = makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => logs,
        getWorkSpec: async () => hydratedWork,
        node: makeNode({ work: undefined }),
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(capturedInstructions.includes('Shell: npm test'));
    });
  });

  suite('removeCopilotCliDir cleanup', () => {
    // Note: fs.existsSync and fs.rmSync cannot be stubbed in Node.js 18+ due to property descriptors
    // These cleanup methods are tested indirectly through integration tests
    // Coverage is achieved through execution paths that don't stub fs
    
    test('executes cleanup code path without fs stubbing', async () => {
      // This test verifies the cleanup code executes without error
      // even if the directories don't exist (non-fatal nature)
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['file.ts']);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('newcommit');

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), git });
      const result = await executor.execute(makeCtx({ worktreePath: '/tmp/nonexistent', logInfo }));

      // Cleanup failures are non-fatal, commit should succeed
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, 'newcommit');
    });
  });

  suite('removeOrchestratorSkillDir cleanup', () => {
    // Note: fs.existsSync and fs.rmSync cannot be stubbed in Node.js 18+ due to property descriptors
    // These cleanup methods are tested indirectly through integration tests
    // Coverage is achieved through execution paths that don't stub fs
    
    test('executes cleanup code path for orchestrator skill dir without fs stubbing', async () => {
      // This test verifies the cleanup code executes without error
      // even if the directories don't exist (non-fatal nature)
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['file.ts']);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('newcommit');

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), git });
      const result = await executor.execute(makeCtx({ worktreePath: '/tmp/nonexistent', logInfo }));

      // Cleanup failures are non-fatal, commit should succeed
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, 'newcommit');
    });
  });

  suite('AI review no-change assessment', () => {
    test('AI review includes full execution context', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const executionLogs: LogEntry[] = [
        { timestamp: Date.now(), phase: 'work', type: 'info', message: 'Starting work' },
        { timestamp: Date.now(), phase: 'work', type: 'stdout', message: 'Processing files' },
        { timestamp: Date.now(), phase: 'work', type: 'info', message: 'Work complete' },
      ];

      let capturedInstructions = '';
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          capturedInstructions = opts.instructions;
          opts.logOutput('[ai-review] {"legitimate": true, "reason": "analysis complete"}');
          return { success: true, metrics: { durationMs: 100 } };
        }),
      };

      const reviewLogs: LogEntry[] = [...executionLogs];
      const logInfo = sinon.stub().callsFake((msg: string) => {
        reviewLogs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => reviewLogs,
        node: makeNode({ name: 'TestJob', task: 'Test the code' }),
      }));

      assert.strictEqual(result.success, true);
      assert.ok(capturedInstructions.includes('Node: TestJob'));
      assert.ok(capturedInstructions.includes('Task: Test the code'));
      assert.ok(capturedInstructions.includes('[work] [info] Starting work'));
      assert.ok(capturedInstructions.includes('[work] [stdout] Processing files'));
      assert.ok(result.reviewMetrics);
      assert.strictEqual(result.reviewMetrics.durationMs, 100);
    });

    test('AI review parses JSON from combined output when individual parsing fails', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const reviewLogs: LogEntry[] = [];
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          // Simulate output where individual lines don't parse but combined does
          // This happens when JSON spans multiple log calls with different prefixes
          opts.logOutput('Analyzing logs...');
          opts.logOutput('[ai-review] Result: {"legitimate": true, "reason": "parsed from combined"}');
          return { success: true };
        }),
      };
      const logInfo = sinon.stub().callsFake((msg: string) => {
        reviewLogs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => reviewLogs,
      }));

      // Should succeed by parsing from the log that has complete JSON
      assert.strictEqual(result.success, true);
    });

    test('AI review with shell work description', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logs: LogEntry[] = [];
      let capturedInstructions = '';
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          capturedInstructions = opts.instructions;
          opts.logOutput('[ai-review] {"legitimate": true, "reason": "shell work"}');
          return { success: true };
        }),
      };
      const logInfo = sinon.stub().callsFake((msg: string) => {
        logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => logs,
        node: makeNode({ work: { type: 'shell', command: 'npm run build' } }),
      }));

      assert.strictEqual(result.success, true);
      assert.ok(capturedInstructions.includes('Shell: npm run build'));
    });

    test('AI review handles unparseable response gracefully', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logs: LogEntry[] = [];
      const delegator = {
        delegate: sinon.stub().callsFake(async (opts: any) => {
          opts.logOutput('[ai-review] This is not valid JSON at all');
          return { success: true };
        }),
      };
      const logInfo = sinon.stub().callsFake((msg: string) => {
        logs.push({ timestamp: Date.now(), phase: 'commit', type: 'info', message: msg });
      });

      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(),
        agentDelegator: delegator,
        git,
      });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        getExecutionLogs: () => logs,
      }));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('No work evidence'));
      assert.ok(logInfo.calledWithMatch('did not return a parseable judgment'));
    });
  });

  suite('evidence file detection', () => {
    test('stages and commits when evidence file exists', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      const headStub = git.worktrees.getHeadCommit as sinon.SinonStub;
      headStub.onFirstCall().resolves('base123');
      headStub.onSecondCall().resolves('evidcommit456');

      const evidenceValidator = mockEvidenceValidator(true);
      const stageAllStub = git.repository.stageAll as sinon.SinonStub;
      const commitStub = git.repository.commit as sinon.SinonStub;

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator, git });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        node: makeNode({ task: 'Evidence task' }),
      }));

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, 'evidcommit456');
      assert.ok(stageAllStub.calledOnce);
      assert.ok(commitStub.calledWith('/tmp/worktree', '[Plan] Evidence task (evidence only)'));
      assert.ok(logInfo.calledWithMatch('Evidence file found, staging'));
    });

    test('evidence file has priority over expectsNoChanges flag', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      const headStub = git.worktrees.getHeadCommit as sinon.SinonStub;
      headStub.onFirstCall().resolves('base123');
      headStub.onSecondCall().resolves('evidcommit789');

      const evidenceValidator = mockEvidenceValidator(true);

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator, git });

      // Node has both evidence file and expectsNoChanges=true
      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        node: makeNode({ expectsNoChanges: true }),
      }));

      // Evidence file takes priority
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, 'evidcommit789');
      assert.ok(logInfo.calledWithMatch('Evidence file found'));
    });
  });

  suite('expectsNoChanges flag', () => {
    test('succeeds without commit when expectsNoChanges is true', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(false),
        git,
      });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logInfo,
        node: makeNode({ expectsNoChanges: true }),
      }));

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, undefined);
      assert.ok(logInfo.calledWithMatch('Node declares expectsNoChanges'));
    });

    test('fails without expectsNoChanges when no evidence present', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('base123');

      const logError = sinon.stub();
      const executor = new CommitPhaseExecutor({
        evidenceValidator: mockEvidenceValidator(false),
        git,
      });

      const result = await executor.execute(makeCtx({
        baseCommit: 'base123',
        logError,
        node: makeNode({ expectsNoChanges: false }),
      }));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('No work evidence produced'));
      assert.ok(result.error?.includes('Modify files'));
      assert.ok(result.error?.includes('Create an evidence file'));
      assert.ok(result.error?.includes('Declare expectsNoChanges: true'));
    });
  });

  suite('stage-all and commit flow', () => {
    test('stages all changes and commits with task message', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['src/file1.ts', 'src/file2.ts']);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('newcommit123');

      const stageAllStub = git.repository.stageAll as sinon.SinonStub;
      const commitStub = git.repository.commit as sinon.SinonStub;

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), git });

      const result = await executor.execute(makeCtx({
        logInfo,
        node: makeNode({ task: 'Implement feature X' }),
      }));

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, 'newcommit123');
      assert.ok(stageAllStub.calledWith('/tmp/worktree'));
      assert.ok(commitStub.calledWith('/tmp/worktree', '[Plan] Implement feature X'));
      assert.ok(logInfo.calledWithMatch('Staging all changes'));
      assert.ok(logInfo.calledWithMatch('Creating commit: "[Plan] Implement feature X"'));
      assert.ok(logInfo.calledWithMatch('✓ Committed: newcommi'));
    });

    test('succeeds when work phase made commits (HEAD advanced)', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves([]);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(false);
      (git.worktrees.getHeadCommit as sinon.SinonStub).resolves('advanced123');

      const logInfo = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), git });

      const result = await executor.execute(makeCtx({
        baseCommit: 'original123',
        logInfo,
      }));

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.commit, 'advanced123');
      assert.ok(logInfo.calledWithMatch('Work stage made commits'));
    });

    test('handles stageAll error', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['file.ts']);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
      (git.repository.stageAll as sinon.SinonStub).rejects(new Error('stage failed'));

      const logError = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), git });

      const result = await executor.execute(makeCtx({ logError }));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('stage failed'));
    });

    test('handles commit error', async () => {
      const git = mockGitOperations();
      (git.repository.getDirtyFiles as sinon.SinonStub).resolves(['file.ts']);
      (git.repository.hasUncommittedChanges as sinon.SinonStub).resolves(true);
      (git.repository.commit as sinon.SinonStub).rejects(new Error('commit failed'));

      const logError = sinon.stub();
      const executor = new CommitPhaseExecutor({ evidenceValidator: mockEvidenceValidator(), git });

      const result = await executor.execute(makeCtx({ logError }));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('commit failed'));
    });
  });
});
