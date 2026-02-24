/**
 * @fileoverview Unit tests for mergeHelper
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { resolveMergeConflictWithCopilot } from '../../../../plan/phases/mergeHelper';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
import type { ICopilotRunner } from '../../../../interfaces/ICopilotRunner';
import type { JobNode } from '../../../../plan/types';

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
    worktreePath: '/tmp/test',
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

function createMockCopilotRunner(): ICopilotRunner {
  return {
    run: sinon.stub().resolves({
      success: true,
      sessionId: 'test-session-123',
      metrics: {
        durationMs: 1000,
        turns: 1,
        toolCalls: 2,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          model: 'claude-3'
        }
      }
    }),
    isAvailable: sinon.stub().returns(true),
    writeInstructionsFile: sinon.stub().returns({ filePath: '/tmp/instructions.md', dirPath: '/tmp' }),
    buildCommand: sinon.stub().returns('gh copilot --help'),
    cleanupInstructionsFile: sinon.stub()
  };
}

suite('mergeHelper', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('resolveMergeConflictWithCopilot', () => {
    test('successful conflict resolution with provided runner', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      const result = await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature-branch',
        'main',
        'Merge feature into main',
        runner,
        ['file1.txt', 'file2.txt']
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, 'test-session-123');
      assert.ok(result.metrics);
      assert.strictEqual(result.metrics!.durationMs, 1000);

      // Check that runner.run was called with correct parameters
      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      assert.strictEqual(runCall.args[0].cwd, '/tmp/repo');
      assert.strictEqual(runCall.args[0].task, 'Resolve all git merge conflicts in this repository.');
      assert.ok(runCall.args[0].instructions.includes('feature-branch'));
      assert.ok(runCall.args[0].instructions.includes('main'));
      assert.ok(runCall.args[0].instructions.includes('file1.txt'));
      assert.ok(runCall.args[0].instructions.includes('file2.txt'));
      assert.strictEqual(runCall.args[0].label, 'merge-conflict');
      assert.strictEqual(runCall.args[0].jobId, 'test-node');
      assert.strictEqual(runCall.args[0].timeout, 600000);
    });

    test('uses provided CopilotCliRunner', async () => {
      const context = createMockContext();
      const runner = createMockCopilotRunner();

      const result = await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'source',
        'target',
        'Test merge',
        runner,
        ['conflict.txt']
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, 'test-session-123');
      assert.ok((runner.run as sinon.SinonStub).calledOnce);
    });

    test('handles runner failure', async () => {
      const runner = createMockCopilotRunner();
      (runner.run as sinon.SinonStub).resolves({
        success: false,
        error: 'Copilot CLI failed',
        exitCode: 1,
        sessionId: 'failed-session',
        metrics: { durationMs: 500 }
      });

      const context = createMockContext();

      const result = await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        []
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.sessionId, 'failed-session');
      assert.ok(result.metrics);

      // Check that error was logged
      const logError = context.logError as sinon.SinonStub;
      assert.ok(logError.calledWithMatch('Copilot CLI error: Copilot CLI failed'));
      assert.ok(logError.calledWithMatch('Exit code: 1'));
    });

    test('uses configManager for merge preference', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();
      const configManager = {
        getConfig: sinon.stub().returns('ours')
      };

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        ['file.txt'],
        configManager
      );

      // Check that config was queried
      assert.ok(configManager.getConfig.calledWith('copilotOrchestrator.merge', 'prefer', 'theirs'));

      // Check that instructions contain the preference
      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      assert.ok(runCall.args[0].instructions.includes('Prefer "ours" changes'));
    });

    test('defaults to "theirs" when no configManager provided', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        []
      );

      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      assert.ok(runCall.args[0].instructions.includes('Prefer "theirs" changes'));
    });

    test('handles empty conflicted files list', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main', 
        'Merge commit',
        runner,
        []
      );

      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      assert.ok(runCall.args[0].instructions.includes('(run `git diff --name-only --diff-filter=U` to list them)'));
    });

    test('includes conflicted files in instructions when provided', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        ['src/file1.ts', 'src/file2.ts', 'README.md']
      );

      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      const instructions = runCall.args[0].instructions;
      assert.ok(instructions.includes('- src/file1.ts'));
      assert.ok(instructions.includes('- src/file2.ts'));
      assert.ok(instructions.includes('- README.md'));
    });

    test('calls onOutput callback with filtered lines', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();
      let outputCallback: ((line: string) => void) | undefined;

      (runner.run as sinon.SinonStub).callsFake((options: any) => {
        outputCallback = options.onOutput;
        return Promise.resolve({ success: true, sessionId: 'test' });
      });

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        []
      );

      // Simulate copilot output
      assert.ok(outputCallback);
      outputCallback!('Some output line');
      outputCallback!('   '); // Empty line should be filtered
      outputCallback!('Another line');

      const logInfo = context.logInfo as sinon.SinonStub;
      assert.ok(logInfo.calledWith('[copilot] Some output line'));
      assert.ok(logInfo.calledWith('[copilot] Another line'));
      // Empty line should not be logged
      assert.ok(!logInfo.calledWith('[copilot]    '));
    });

    test('calls onProcess callback with process', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();
      const mockProcess = { pid: 12345 };
      let processCallback: ((proc: any) => void) | undefined;

      (runner.run as sinon.SinonStub).callsFake((options: any) => {
        processCallback = options.onProcess;
        return Promise.resolve({ success: true });
      });

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        []
      );

      // Simulate process callback
      assert.ok(processCallback);
      processCallback!(mockProcess);

      const setProcess = context.setProcess as sinon.SinonStub;
      assert.ok(setProcess.calledWith(mockProcess));
    });

    test('timeout is set to 10 minutes', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        []
      );

      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      assert.strictEqual(runCall.args[0].timeout, 600000); // 10 minutes in ms
    });

    test('logs session ID when available', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature',
        'main',
        'Merge commit',
        runner,
        []
      );

      const logInfo = context.logInfo as sinon.SinonStub;
      assert.ok(logInfo.calledWith('Copilot session: test-session-123'));
    });

    test('instructions contain all required elements', async () => {
      const runner = createMockCopilotRunner();
      const context = createMockContext();

      await resolveMergeConflictWithCopilot(
        context,
        '/tmp/repo',
        'feature-branch',
        'main-branch',
        'Custom merge message',
        runner,
        ['conflict1.txt', 'conflict2.txt']
      );

      const runCall = (runner.run as sinon.SinonStub).getCall(0);
      const instructions = runCall.args[0].instructions;

      // Check all required elements are present
      assert.ok(instructions.includes('# Merge Conflict Resolution'));
      assert.ok(instructions.includes('## Context'));
      assert.ok(instructions.includes('feature-branch'));
      assert.ok(instructions.includes('main-branch'));
      assert.ok(instructions.includes('## Conflicted Files'));
      assert.ok(instructions.includes('- conflict1.txt'));
      assert.ok(instructions.includes('- conflict2.txt'));
      assert.ok(instructions.includes('## Rules'));
      assert.ok(instructions.includes('git diff --check'));
      assert.ok(instructions.includes('git add <file>'));
      assert.ok(instructions.includes('Custom merge message'));
      assert.ok(instructions.includes('## Important'));
      assert.ok(instructions.includes('Do NOT modify any files beyond resolving the conflict markers'));
      assert.ok(instructions.includes('Do NOT run builds, tests, or linters'));
    });
  });
});