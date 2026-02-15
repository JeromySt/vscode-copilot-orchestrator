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
import * as git from '../../../../git';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
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
    const executor = new MergeFiPhaseExecutor({ git: {} as any, copilotRunner: mockCopilotRunner });
    assert.ok(executor);
  });

  test('constructor accepts configManager dependency', () => {
    const configManager = { test: true };
    const executor = new MergeFiPhaseExecutor({ configManager, git: {} as any, copilotRunner: mockCopilotRunner });
    assert.ok(executor);
  });

  test('returns success when no dependency commits', async () => {
    const executor = new MergeFiPhaseExecutor({ git: {} as any, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: []
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('No additional dependency commits to merge - forward integration complete'));
  });

  test('returns success when dependency commits is undefined', async () => {
    const executor = new MergeFiPhaseExecutor({ git: {} as any, copilotRunner: mockCopilotRunner });
    const context = createMockContext({
      dependencyCommits: undefined
    });

    const result = await executor.execute(context);

    assert.strictEqual(result.success, true);
    assert.ok((context.logInfo as sinon.SinonStub).calledWith('No additional dependency commits to merge - forward integration complete'));
  });

  test('clean merge - successful merge without conflicts', async () => {
    // Mock git.merge.merge to return success
    sandbox.stub(git.merge, 'merge').resolves({
      success: true,
      hasConflicts: false,
      conflictFiles: [],
    });

    const executor = new MergeFiPhaseExecutor({ git: {} as any, copilotRunner: mockCopilotRunner });
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
    // Mock git.merge.merge to return conflict
    sandbox.stub(git.merge, 'merge').resolves({
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

    const executor = new MergeFiPhaseExecutor({ git: {} as any, copilotRunner: mockCopilotRunner });
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
    // Mock git.merge.merge to return conflict
    sandbox.stub(git.merge, 'merge').resolves({
      success: false,
      hasConflicts: true,
      conflictFiles: ['failed.txt'],
    });

    // Mock git.merge.abort
    sandbox.stub(git.merge, 'abort').resolves();

    // Mock resolveMergeConflictWithCopilot to fail
    const resolveMergeConflictStub = sandbox.stub().resolves({
      success: false,
      error: 'Could not resolve conflict'
    });

    // Mock the import of resolveMergeConflictWithCopilot
    const mergeHelperModule = await import('../../../../plan/phases/mergeHelper');
    sandbox.stub(mergeHelperModule, 'resolveMergeConflictWithCopilot').callsFake(resolveMergeConflictStub);

    const executor = new MergeFiPhaseExecutor({ git: {} as any, copilotRunner: mockCopilotRunner });
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
});


