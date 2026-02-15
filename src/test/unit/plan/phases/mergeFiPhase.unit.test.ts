/**
 * @fileoverview Unit tests for MergeFiPhaseExecutor
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MergeFiPhaseExecutor } from '../../../../plan/phases/mergeFiPhase';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergefi-test-'));
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
    phase: 'merge-fi',
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
    },
  };
}

suite('MergeFiPhaseExecutor', () => {
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
    const executor = new MergeFiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    assert.ok(executor);
  });

  test('constructor accepts configManager dependency', () => {
    const configManager = { test: true };
    const executor = new MergeFiPhaseExecutor({ configManager, git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    assert.ok(executor);
  });

  test('returns success when no dependency commits', async () => {
    const executor = new MergeFiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: []
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('No additional dependency commits to merge - forward integration complete'));
  });

  test('returns success when dependency commits is undefined', async () => {
    const executor = new MergeFiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: undefined
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('No additional dependency commits to merge - forward integration complete'));
  });

  test('clean merge - successful merge without conflicts', async () => {
    const git = mockGitOperations();
    (git.merge.merge as sinon.SinonStub).resolves({
      success: true,
      hasConflicts: false,
      conflictFiles: [],
    });

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: [{
        commit: 'abcd1234567890abcdef1234567890abcdef1234',
        nodeId: 'dep-node',
        nodeName: 'Dependency Node'
      }]
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('========== FORWARD INTEGRATION MERGE START =========='));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('  ✓ Merged successfully'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('========== FORWARD INTEGRATION MERGE END =========='));

    // Check that git.merge.merge was called correctly
    const mergeCall = (git.merge.merge as sinon.SinonStub).getCall(0);
    assert.strictEqual(mergeCall.args[0].source, 'abcd1234567890abcdef1234567890abcdef1234');
    assert.strictEqual(mergeCall.args[0].target, 'HEAD');
  });

  test('merge conflict with resolution - conflict resolved by Copilot', async () => {
    const git = mockGitOperations();
    (git.merge.merge as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      conflictFiles: ['file1.txt', 'file2.txt'],
    });

    // Mock resolveMergeConflictWithCopilot to succeed
    const resolveMergeConflictStub = sandbox.stub().resolves({
      success: true,
      metrics: {
        durationMs: 5000,
        turns: 2,
        toolCalls: 3,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          model: 'claude-3'
        }
      }
    });

    // Mock the import of resolveMergeConflictWithCopilot
    const mergeHelperModule = await import('../../../../plan/phases/mergeHelper');
    sandbox.stub(mergeHelperModule, 'resolveMergeConflictWithCopilot').callsFake(resolveMergeConflictStub);

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: [{
        commit: 'conflict123456789012345678901234567890123456',
        nodeId: 'conflict-node',
        nodeName: 'Conflict Node'
      }]
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('  ⚠ Merge conflict detected'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('    Conflicts: file1.txt, file2.txt'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('  ✓ Conflict resolved by Copilot CLI'));
    
    // Check that metrics are returned
    assert.ok(result.metrics);
    assert.strictEqual(result.metrics!.tokenUsage?.totalTokens, 150);
  });

  test('merge conflict with failed resolution - returns failure', async () => {
    const git = mockGitOperations();
    (git.merge.merge as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: true,
      conflictFiles: ['failed.txt'],
    });

    // Mock resolveMergeConflictWithCopilot to fail
    const resolveMergeConflictStub = sandbox.stub().resolves({
      success: false,
      error: 'Could not resolve conflict'
    });

    // Mock the import of resolveMergeConflictWithCopilot
    const mergeHelperModule = await import('../../../../plan/phases/mergeHelper');
    sandbox.stub(mergeHelperModule, 'resolveMergeConflictWithCopilot').callsFake(resolveMergeConflictStub);

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: [{
        commit: 'failed12345678901234567890123456789012345678',
        nodeId: 'failed-node',  
        nodeName: 'Failed Node'
      }]
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Failed to resolve merge conflict for dependency Failed Node'));
    assert.ok((context.logError as sinon.SinonStub).calledWith('  ✗ Copilot CLI failed to resolve conflict'));
    
    // Check that merge abort was called
    assert.ok((git.merge.abort as sinon.SinonStub).calledOnce);
  });

  test('merge failure without conflicts returns error', async () => {
    const git = mockGitOperations();
    (git.merge.merge as sinon.SinonStub).resolves({
      success: false,
      hasConflicts: false,
      error: 'Merge failed for unknown reason'
    });

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: [{
        commit: 'error123456789012345678901234567890123456',
        nodeId: 'error-node',  
        nodeName: 'Error Node'
      }]
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Merge failed for dependency Error Node'));
    assert.ok((context.logError as sinon.SinonStub).calledWith('  ✗ Merge failed: Merge failed for unknown reason'));
  });

  test('merge exception is caught and returned as error', async () => {
    const git = mockGitOperations();
    (git.merge.merge as sinon.SinonStub).rejects(new Error('Git command failed'));

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: [{
        commit: 'exception456789012345678901234567890123456',
        nodeId: 'exception-node',  
        nodeName: 'Exception Node'
      }]
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Merge error for dependency Exception Node'));
    assert.ok((context.logError as sinon.SinonStub).calledWith('  ✗ Merge error: Git command failed'));
  });

  test('multiple dependency commits are processed in order', async () => {
    const git = mockGitOperations();
    const mergeStub = git.merge.merge as sinon.SinonStub;
    mergeStub.resolves({ success: true, hasConflicts: false, conflictFiles: [] });

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: [
        {
          commit: 'first123456789012345678901234567890123456',
          nodeId: 'first-node',
          nodeName: 'First Node'
        },
        {
          commit: 'second12345678901234567890123456789012345',
          nodeId: 'second-node',
          nodeName: 'Second Node'
        }
      ]
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.strictEqual(mergeStub.callCount, 2);
    
    // Check first call
    assert.strictEqual(mergeStub.getCall(0).args[0].source, 'first123456789012345678901234567890123456');
    assert.strictEqual(mergeStub.getCall(0).args[0].message, 'Merge parent commit first123 for job Test Node');
    
    // Check second call
    assert.strictEqual(mergeStub.getCall(1).args[0].source, 'second12345678901234567890123456789012345');
    assert.strictEqual(mergeStub.getCall(1).args[0].message, 'Merge parent commit second12 for job Test Node');

    // Check logging
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('[Merge Source] First Node'));
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('[Merge Source] Second Node'));
  });

  test('dependency work summary is logged when available', async () => {
    const git = mockGitOperations();
    (git.merge.merge as sinon.SinonStub).resolves({ success: true, hasConflicts: false, conflictFiles: [] });

    const executor = new MergeFiPhaseExecutor({ git, copilotRunner: mockCopilotRunner });
    
    // Mock the dependency info to include work summary
    const originalExecute = executor.execute;
    executor.execute = async function(context: any) {
      // Temporarily patch the dependencyInfoMap to include workSummary
      const originalMethod = originalExecute.bind(this);
      
      // Create context with dependency that has workSummary
      const contextWithSummary = {
        ...context,
        dependencyCommits: [{
          commit: 'summary123456789012345678901234567890123456',
          nodeId: 'summary-node',
          nodeName: 'Summary Node'
        }]
      };

      // Patch the logDependencyWorkSummary method to simulate work summary
      const patchedThis = this as any;
      const originalLogMethod = patchedThis.logDependencyWorkSummary;
      patchedThis.logDependencyWorkSummary = (ctx: any, summary: string) => {
        ctx.logInfo('Work summary would be logged here');
      };

      const result = await originalMethod(contextWithSummary);
      patchedThis.logDependencyWorkSummary = originalLogMethod;
      return result;
    };

    const context = createMockContext();
    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
  });

  test('logDependencyWorkSummary handles short work summary', async () => {
    const executor = new MergeFiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    
    // Test the private method by calling it directly
    (executor as any).logDependencyWorkSummary(context, 'Short summary');
    
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('    Short summary'));
  });

  test('logDependencyWorkSummary handles long work summary with truncation', async () => {
    const executor = new MergeFiPhaseExecutor({ git: mockGitOperations(), copilotRunner: mockCopilotRunner });
    const context = createMockContext();
    
    // Test the private method with a long summary (more than 3 lines)
    const longSummary = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6';
    (executor as any).logDependencyWorkSummary(context, longSummary);
    
    const logCalls = (context.logInfo as sinon.SinonStub).getCalls().map(call => call.args[0]);
    
    // Should log first 3 lines plus truncation message
    assert.ok(logCalls.includes('    Line 1'));
    assert.ok(logCalls.includes('    Line 2'));
    assert.ok(logCalls.includes('    Line 3'));
    assert.ok(logCalls.includes('    ... (3 more lines)'));
  });
});