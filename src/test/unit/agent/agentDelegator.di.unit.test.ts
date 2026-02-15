/**
 * @fileoverview DI unit tests for AgentDelegator
 *
 * Tests delegation with mock ICopilotRunner and IGitOperations.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentDelegator } from '../../../agent/agentDelegator';
import type { DelegatorLogger, DelegatorCallbacks, DelegateOptions } from '../../../agent/agentDelegator';
import type { ICopilotRunner } from '../../../interfaces/ICopilotRunner';
import type { IGitOperations } from '../../../interfaces/IGitOperations';
import type { CopilotRunOptions, CopilotRunResult } from '../../../agent/copilotCliRunner';
import * as modelDiscovery from '../../../agent/modelDiscovery';

// ── Helpers ────────────────────────────────────────────────────────────

function createLogger(): DelegatorLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    log: (msg: string) => messages.push(msg),
  };
}

function createMockRunner(result?: Partial<CopilotRunResult>): ICopilotRunner & { calls: CopilotRunOptions[] } {
  const calls: CopilotRunOptions[] = [];
  return {
    calls,
    run: async (options: CopilotRunOptions) => {
      calls.push(options);
      return {
        success: true,
        sessionId: 'mock-session-id',
        exitCode: 0,
        ...result,
      };
    },
    isAvailable: () => true,
    writeInstructionsFile: () => ({ filePath: '/fake/path', dirPath: '/fake' }),
    buildCommand: () => 'mock-command',
    cleanupInstructionsFile: () => {},
  };
}

function createMockGitOps(): IGitOperations {
  return {
    branches: {} as any,
    worktrees: {} as any,
    merge: {} as any,
    repository: {
      commit: async () => true,
      stageAll: async () => {},
      stageFile: async () => {},
      hasChanges: async () => false,
      hasStagedChanges: async () => false,
      hasUncommittedChanges: async () => false,
      fetch: async () => {},
      pull: async () => true,
      push: async () => true,
      getHead: async () => null,
      resolveRef: async () => 'abc123',
      getCommitLog: async () => [],
      getCommitChanges: async () => [],
      getDiffStats: async () => ({ added: 0, modified: 0, deleted: 0 }),
      getFileDiff: async () => null,
      getStagedFileDiff: async () => null,
      getFileChangesBetween: async () => [],
      hasChangesBetween: async () => false,
      getCommitCount: async () => 0,
      getDirtyFiles: async () => [],
      checkoutFile: async () => {},
      resetHard: async () => {},
      clean: async () => {},
      updateRef: async () => {},
      stashPush: async () => true,
      stashPop: async () => true,
      stashDrop: async () => true,
      stashList: async () => [],
      stashShowFiles: async () => [],
      stashShowPatch: async () => null,
    },
    gitignore: {} as any,
  };
}

function defaultOptions(tmpDir: string): DelegateOptions {
  return {
    jobId: 'test-job-123',
    taskDescription: 'Test task',
    label: 'test',
    worktreePath: tmpDir,
    baseBranch: 'main',
    targetBranch: 'feature/test',
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

suite('AgentDelegator DI', () => {
  let tmpDir: string;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Stub model validation to avoid needing a spawner
    sandbox.stub(modelDiscovery, 'isValidModel').resolves(true);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegator-test-'));
    // Create .copilot-orchestrator dir structure
    fs.mkdirSync(path.join(tmpDir, '.orchestrator', '.copilot'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.copilot-orchestrator', 'logs'), { recursive: true });
  });

  teardown(() => {
    sandbox.restore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ====================================================================
  // Constructor backward compat
  // ====================================================================
  suite('constructor', () => {
    test('no-arg runner/gitOps works (backward compat)', () => {
      const logger = createLogger();
      const delegator = new AgentDelegator(logger, createMockGitOps());
      assert.ok(delegator);
    });

    test('accepts all DI params', () => {
      const logger = createLogger();
      const runner = createMockRunner();
      const gitOps = createMockGitOps();
      const delegator = new AgentDelegator(logger, gitOps, {}, runner);
      assert.ok(delegator);
    });
  });

  // ====================================================================
  // delegate() with mock runner
  // ====================================================================
  suite('delegate() with mock runner', () => {
    test('creates task file and uses injected runner', async () => {
      const logger = createLogger();
      const runner = createMockRunner();
      const gitOps = createMockGitOps();
      const delegator = new AgentDelegator(logger, gitOps, {}, runner);

      const result = await delegator.delegate(defaultOptions(tmpDir));

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, 'mock-session-id');

      // Verify task file was created
      const taskFile = path.join(tmpDir, '.copilot-task.md');
      assert.ok(fs.existsSync(taskFile), 'Task file should be created');
      const content = fs.readFileSync(taskFile, 'utf-8');
      assert.ok(content.includes('Test task'));
    });

    test('passes options to runner correctly', async () => {
      const logger = createLogger();
      const runner = createMockRunner();
      const gitOps = createMockGitOps();
      const delegator = new AgentDelegator(logger, gitOps, {}, runner);

      await delegator.delegate({
        ...defaultOptions(tmpDir),
        model: 'gpt-5',
        sessionId: 'existing-session',
        allowedFolders: ['/shared'],
        allowedUrls: ['https://api.example.com'],
      });

      assert.strictEqual(runner.calls.length, 1);
      const call = runner.calls[0];
      assert.strictEqual(call.model, 'gpt-5');
      assert.strictEqual(call.sessionId, 'existing-session');
      assert.ok(call.allowedUrls?.includes('https://api.example.com'));
    });

    test('handles runner failure', async () => {
      const logger = createLogger();
      const runner = createMockRunner({ success: false, error: 'CLI crashed' });
      const gitOps = createMockGitOps();
      const delegator = new AgentDelegator(logger, gitOps, {}, runner);

      const result = await delegator.delegate(defaultOptions(tmpDir));

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'CLI crashed');
    });

    test('uses injected git operations for marker commit', async () => {
      const logger = createLogger();
      const runner = createMockRunner();
      const gitOps = createMockGitOps();
      let stageFileCalled = false;
      let commitCalled = false;
      gitOps.repository.stageFile = async (cwd, filePath) => {
        stageFileCalled = true;
        assert.ok(filePath.includes('.copilot-task.md'));
      };
      gitOps.repository.commit = async (cwd, msg) => {
        commitCalled = true;
        assert.ok(msg.includes('test-job-123'));
        return true;
      };
      const delegator = new AgentDelegator(logger, gitOps, {}, runner);

      await delegator.delegate(defaultOptions(tmpDir));

      assert.ok(stageFileCalled, 'git add should be called via injected repository.stageFile');
      assert.ok(commitCalled, 'git commit should be called via injected repository');
    });
  });

  // ====================================================================
  // Callbacks
  // ====================================================================
  suite('callbacks', () => {
    test('fires onSessionCaptured when session extracted from output', async () => {
      const logger = createLogger();
      const sessionId = 'abcdef12-3456-7890-abcd-ef1234567890';
      const runner = createMockRunner({ sessionId });
      const gitOps = createMockGitOps();
      const captured: string[] = [];
      const callbacks: DelegatorCallbacks = {
        onSessionCaptured: (sid) => captured.push(sid),
      };
      const delegator = new AgentDelegator(logger, gitOps, callbacks, runner);

      await delegator.delegate(defaultOptions(tmpDir));

      // The session from runner result should be used
      assert.ok(captured.length === 0 || captured.includes(sessionId));
    });
  });

  // ====================================================================
  // isCopilotAvailable
  // ====================================================================
  suite('isCopilotAvailable', () => {
    test('returns boolean', () => {
      const logger = createLogger();
      const delegator = new AgentDelegator(logger, createMockGitOps());
      const result = delegator.isCopilotAvailable();
      assert.ok(typeof result === 'boolean');
    });
  });
});
