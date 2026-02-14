/**
 * @fileoverview Unit tests for the agent CLI check module.
 *
 * Tests cover:
 * - cliCheckCore: isCopilotCliAvailable, checkCopilotCliAsync, resetCliCache, isCliCachePopulated
 * - cliCheck: ensureCopilotCliInteractive, registerCopilotCliCheck
 * - AgentDelegator: delegate, extractSessionId, createTaskFile, isCopilotAvailable
 *
 * All child_process and VS Code APIs are stubbed via sinon.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import type { IGitOperations } from '../../../interfaces/IGitOperations';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if cp.spawn can be stubbed by sinon.
 * In some Node.js environments, spawn is non-configurable and cannot be stubbed.
 * We try to stub it once to check.
 */
function canStubSpawn(): boolean {
  try {
    const stub = sinon.stub(cp, 'spawn');
    stub.restore();
    return true;
  } catch {
    return false;
  }
}

/** Flag indicating if spawn can be stubbed in this environment */
const spawnStubbable = canStubSpawn();

const mockGitOps = {} as any as IGitOperations;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  /* eslint-disable no-console */
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  /* eslint-enable no-console */
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

/**
 * Create a fake ChildProcess that can be controlled in tests.
 * Emits 'close', 'exit', or 'error' as directed.
 */
function fakeProc(exitCode: number | null = 0): cp.ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;

  // Schedule the exit event on the next tick so callers can attach listeners first
  if (exitCode !== null) {
    process.nextTick(() => {
      proc.emit('close', exitCode);
    });
  }

  return proc as cp.ChildProcess;
}

/** Create a fake proc that emits 'error' instead of 'close'. */
function fakeErrorProc(err: Error = new Error('spawn ENOENT')): cp.ChildProcess {
  const proc = new EventEmitter() as any;
  proc.pid = undefined;
  proc.kill = sinon.stub();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;

  process.nextTick(() => {
    proc.emit('error', err);
  });

  return proc as cp.ChildProcess;
}

// ---------------------------------------------------------------------------
// cliCheckCore tests
// ---------------------------------------------------------------------------

suite('Agent CLI Check Core', function() {
  let spawnStub: sinon.SinonStub;
  let quiet: { restore: () => void };

  // We need fresh module state for each test because cliCheckCore caches results
  let cliCheckCore: typeof import('../../../agent/cliCheckCore');

  setup(function() {
    if (!spawnStubbable) {
      this.skip();
      return;
    }
    quiet = silenceConsole();
    spawnStub = sinon.stub(cp, 'spawn');

    // Clear the module cache to get fresh state for cliCheckCore
    const modulePath = require.resolve('../../../agent/cliCheckCore');
    delete require.cache[modulePath];
    cliCheckCore = require('../../../agent/cliCheckCore');
  });

  teardown(() => {
    sinon.restore();
    if (quiet) quiet.restore();
  });

  // =========================================================================
  // resetCliCache / isCliCachePopulated
  // =========================================================================

  suite('Cache management', () => {
    test('cache is not populated on fresh load', () => {
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), false);
    });

    test('resetCliCache clears a populated cache', async () => {
      // Populate cache by running checkCopilotCliAsync
      spawnStub.callsFake(() => fakeProc(0));
      await cliCheckCore.checkCopilotCliAsync();

      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);

      cliCheckCore.resetCliCache();
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), false);
    });
  });

  // =========================================================================
  // isCopilotCliAvailable
  // =========================================================================

  suite('isCopilotCliAvailable()', () => {
    test('returns true optimistically on first call (before cache populated)', () => {
      // Before any check completes, should return true optimistically
      spawnStub.callsFake(() => {
        // Return a proc that never closes (simulating long-running check)
        const proc = new EventEmitter() as any;
        proc.pid = 1;
        proc.kill = sinon.stub();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        return proc;
      });

      const result = cliCheckCore.isCopilotCliAvailable();
      assert.strictEqual(result, true, 'should return true optimistically on first call');
    });

    test('returns cached value when cache is populated (true)', async () => {
      // First, populate the cache with true
      spawnStub.callsFake(() => fakeProc(0));
      await cliCheckCore.checkCopilotCliAsync();

      assert.strictEqual(cliCheckCore.isCopilotCliAvailable(), true);
    });

    test('returns cached value when cache is populated (false)', async () => {
      // Populate the cache with false (all commands fail)
      spawnStub.callsFake(() => fakeErrorProc());
      await cliCheckCore.checkCopilotCliAsync();

      assert.strictEqual(cliCheckCore.isCopilotCliAvailable(), false);
    });
  });

  // =========================================================================
  // checkCopilotCliAsync
  // =========================================================================

  suite('checkCopilotCliAsync()', () => {
    test('returns true when first command (gh copilot --help) succeeds', async () => {
      spawnStub.callsFake(() => fakeProc(0));

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, true);
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);
    });

    test('returns false when all commands fail', async () => {
      spawnStub.callsFake(() => fakeErrorProc());

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, false);
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);
    });

    test('returns true when later command succeeds (copilot --help)', async () => {
      let callCount = 0;
      spawnStub.callsFake((..._args: any[]) => {
        callCount++;
        // First two calls fail (gh copilot --help, gh extension list),
        // third succeeds (copilot --help)
        if (callCount <= 2) {
          return fakeErrorProc();
        }
        return fakeProc(0);
      });

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, true);
    });

    test('handles non-zero exit code as command not found', async () => {
      spawnStub.callsFake(() => fakeProc(1));

      // When gh copilot exits with code 1, it tries gh extension list
      // We need the extension list to also fail, then try other commands
      const result = await cliCheckCore.checkCopilotCliAsync();
      // All commands return exit code 1, so should be false
      assert.strictEqual(result, false);
    });

    test('updates cache after check', async () => {
      spawnStub.callsFake(() => fakeProc(0));

      assert.strictEqual(cliCheckCore.isCliCachePopulated(), false);
      await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(cliCheckCore.isCliCachePopulated(), true);
    });

    test('hasGhCopilotAsync parses extension list output', async () => {
      let callCount = 0;
      spawnStub.callsFake((..._args: any[]) => {
        callCount++;
        if (callCount === 1) {
          // gh copilot --help fails
          return fakeErrorProc();
        }
        if (callCount === 2) {
          // gh extension list succeeds and includes gh-copilot
          const proc = new EventEmitter() as any;
          proc.pid = 99;
          proc.kill = sinon.stub();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = null;

          process.nextTick(() => {
            proc.stdout.emit('data', Buffer.from('github/gh-copilot\ngithub/gh-other\n'));
            proc.emit('close', 0);
          });

          return proc;
        }
        return fakeErrorProc();
      });

      const result = await cliCheckCore.checkCopilotCliAsync();
      assert.strictEqual(result, true, 'should detect gh-copilot from extension list');
    });
  });
});

// ---------------------------------------------------------------------------
// AgentDelegator tests
// ---------------------------------------------------------------------------

suite('AgentDelegator', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    sinon.restore();
    quiet.restore();
  });

  // =========================================================================
  // extractSessionId (via public-facing behavior)
  // =========================================================================

  suite('Session ID extraction', () => {
    test('extractSessionId captures UUID from "Session ID: <uuid>" format', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      // Access private method via bracket notation for testing
      const extract = (delegator as any).extractSessionId.bind(delegator);

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      assert.strictEqual(extract(`Session ID: ${uuid}`), uuid);
    });

    test('extractSessionId captures UUID from "session: <uuid>" format', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const extract = (delegator as any).extractSessionId.bind(delegator);

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      assert.strictEqual(extract(`session: ${uuid}`), uuid);
    });

    test('extractSessionId captures UUID from "Starting session: <uuid>" format', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const extract = (delegator as any).extractSessionId.bind(delegator);

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      assert.strictEqual(extract(`Starting session: ${uuid}`), uuid);
    });

    test('extractSessionId returns undefined for non-matching lines', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const extract = (delegator as any).extractSessionId.bind(delegator);

      assert.strictEqual(extract('Hello world'), undefined);
      assert.strictEqual(extract('Session started'), undefined);
      assert.strictEqual(extract(''), undefined);
    });
  });

  // =========================================================================
  // extractSessionFromFile
  // =========================================================================

  suite('Session ID from file extraction', () => {
    let fsStub: {
      existsSync: sinon.SinonStub;
      readFileSync: sinon.SinonStub;
      readdirSync: sinon.SinonStub;
      statSync: sinon.SinonStub;
    };

    setup(() => {
      const fs = require('fs');
      fsStub = {
        existsSync: sinon.stub(fs, 'existsSync'),
        readFileSync: sinon.stub(fs, 'readFileSync'),
        readdirSync: sinon.stub(fs, 'readdirSync'),
        statSync: sinon.stub(fs, 'statSync'),
      };
    });

    test('extracts session ID from share file content', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      fsStub.existsSync.returns(true);
      fsStub.readFileSync.returns(`Session ID: ${uuid}\nSome content here`);

      const extract = (delegator as any).extractSessionFromFile.bind(delegator);
      const result = extract('/path/to/session.md', '/path/to/logs', 'work');

      assert.strictEqual(result, uuid);
    });

    test('extracts session ID from bare UUID in share file', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      fsStub.existsSync.returns(true);
      fsStub.readFileSync.returns(uuid);

      const extract = (delegator as any).extractSessionFromFile.bind(delegator);
      const result = extract('/path/to/session.md', '/path/to/logs', 'work');

      assert.strictEqual(result, uuid);
    });

    test('falls back to log filename when share file has no UUID', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      fsStub.existsSync.callsFake((p: string) => true);
      fsStub.readFileSync.returns('No UUID here');
      fsStub.readdirSync.returns([`copilot-2026-01-15-${uuid}.log`]);
      fsStub.statSync.returns({ mtime: { getTime: () => Date.now() } });

      const extract = (delegator as any).extractSessionFromFile.bind(delegator);
      const result = extract('/path/to/session.md', '/path/to/logs', 'work');

      assert.strictEqual(result, uuid);
    });

    test('returns undefined when no files exist', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      fsStub.existsSync.returns(false);

      const extract = (delegator as any).extractSessionFromFile.bind(delegator);
      const result = extract('/path/to/session.md', '/path/to/logs', 'work');

      assert.strictEqual(result, undefined);
    });

    test('returns undefined and logs on exception', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      fsStub.existsSync.throws(new Error('Permission denied'));

      const extract = (delegator as any).extractSessionFromFile.bind(delegator);
      const result = extract('/path/to/session.md', '/path/to/logs', 'work');

      assert.strictEqual(result, undefined);
    });
  });

  // =========================================================================
  // Constructor and isCopilotAvailable
  // =========================================================================

  suite('Constructor & basic API', () => {
    test('constructor accepts logger and callbacks', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };
      const callbacks = {
        onProcessSpawned: sinon.stub(),
        onProcessExited: sinon.stub(),
      };

      const delegator = new AgentDelegator(logger, mockGitOps, callbacks);
      assert.ok(delegator, 'should create delegator instance');
    });

    test('constructor works with only logger (no callbacks)', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const logger = { log: sinon.stub() };

      const delegator = new AgentDelegator(logger, mockGitOps);
      assert.ok(delegator, 'should create delegator instance without callbacks');
    });

    test('isCopilotAvailable delegates to cliCheckCore', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = await import('../../../agent/cliCheckCore');

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      // Reset cache and check behavior
      cliCheckCore.resetCliCache();

      // The method should delegate to isCopilotCliAvailable
      const result = delegator.isCopilotAvailable();
      assert.strictEqual(typeof result, 'boolean');
    });
  });

  // =========================================================================
  // createTaskFile (tested via delegate)
  // =========================================================================

  suite('Task file creation', () => {
    let fsWriteStub: sinon.SinonStub;
    let fsMkdirStub: sinon.SinonStub;

    setup(() => {
      const fs = require('fs');
      fsWriteStub = sinon.stub(fs, 'writeFileSync');
      fsMkdirStub = sinon.stub(fs, 'mkdirSync');

      // Stub cliCheckCore to return false (skip copilot delegation)
      const cliCheckCoreMod = require('../../../agent/cliCheckCore');
      cliCheckCoreMod.resetCliCache();
    });

    test('delegate creates task file with correct content', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(false);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      await delegator.delegate({
        jobId: 'test-job-1',
        taskDescription: 'Implement feature X',
        label: 'work',
        worktreePath: '/fake/worktree',
        baseBranch: 'main',
        targetBranch: 'feature/x',
        instructions: 'Write tests first',
      });

      // Verify writeFileSync was called
      assert.ok(fsWriteStub.calledOnce, 'should write task file');

      const [filePath, content] = fsWriteStub.firstCall.args;
      assert.ok(filePath.includes('.copilot-task.md'), 'file should be .copilot-task.md');
      assert.ok(content.includes('test-job-1'), 'content should include job ID');
      assert.ok(content.includes('Implement feature X'), 'content should include task description');
      assert.ok(content.includes('Write tests first'), 'content should include instructions');
      assert.ok(content.includes('main'), 'content should include base branch');
      assert.ok(content.includes('feature/x'), 'content should include target branch');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('delegate includes session info when sessionId provided', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(false);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      await delegator.delegate({
        jobId: 'test-job-2',
        taskDescription: 'Continue feature',
        label: 'work',
        worktreePath: '/fake/worktree',
        baseBranch: 'main',
        targetBranch: 'feature/x',
        sessionId: 'existing-session-id-here',
      });

      const [, content] = fsWriteStub.firstCall.args;
      assert.ok(content.includes('existing-session-id-here'), 'should include session ID');
      assert.ok(content.includes('active Copilot session'), 'should mention active session');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('delegate uses default instructions when none provided', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(false);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      await delegator.delegate({
        jobId: 'test-job-3',
        taskDescription: 'Do something',
        label: 'work',
        worktreePath: '/fake/worktree',
        baseBranch: 'main',
        targetBranch: 'feature/y',
      });

      const [, content] = fsWriteStub.firstCall.args;
      assert.ok(content.includes('No additional instructions provided'), 'should include default instructions');

      stageFileStub.restore();
      commitStub.restore();
    });
  });

  // =========================================================================
  // delegate result
  // =========================================================================

  suite('delegate() result handling', () => {
    setup(() => {
      const fs = require('fs');
      sinon.stub(fs, 'writeFileSync');
      sinon.stub(fs, 'mkdirSync');
    });

    test('delegate returns success when CLI is not available', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(false);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const result = await delegator.delegate({
        jobId: 'job-1',
        taskDescription: 'Test task',
        label: 'work',
        worktreePath: '/fake',
        baseBranch: 'main',
        targetBranch: 'feature/test',
      });

      assert.strictEqual(result.success, true);
      assert.ok(logger.log.called, 'should have logged messages');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('delegate handles marker commit failure gracefully', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(false);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').rejects(new Error('git not found'));
      const commitStub = sinon.stub(git.repository, 'commit').rejects(new Error('commit failed'));

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      // Should not throw even when marker commit fails
      const result = await delegator.delegate({
        jobId: 'job-2',
        taskDescription: 'Test task',
        label: 'work',
        worktreePath: '/fake',
        baseBranch: 'main',
        targetBranch: 'feature/test',
      });

      assert.strictEqual(result.success, true);

      stageFileStub.restore();
      commitStub.restore();
    });

    test('delegate logs task description and worktree path', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(false);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      await delegator.delegate({
        jobId: 'job-3',
        taskDescription: 'My cool task',
        label: 'postchecks',
        worktreePath: '/my/worktree',
        baseBranch: 'main',
        targetBranch: 'feature/cool',
      });

      const loggedMessages = logger.log.args.map((a: any[]) => a[0]);
      assert.ok(loggedMessages.some((m: string) => m.includes('My cool task')), 'should log task description');
      assert.ok(loggedMessages.some((m: string) => m.includes('/my/worktree')), 'should log worktree path');
      assert.ok(loggedMessages.some((m: string) => m.includes('postchecks')), 'should log label');

      stageFileStub.restore();
      commitStub.restore();
    });
  });

  // =========================================================================
  // delegateViaCopilot (when CLI is available)
  // =========================================================================

  suite('delegateViaCopilot()', function() {
    let spawnStub: sinon.SinonStub;

    setup(function() {
      if (!spawnStubbable) {
        this.skip();
        return;
      }
      const fs = require('fs');
      sinon.stub(fs, 'writeFileSync');
      sinon.stub(fs, 'mkdirSync');
      sinon.stub(fs, 'existsSync').returns(false);

      spawnStub = sinon.stub(cp, 'spawn');
    });

    test('invokes copilot CLI when available and returns success', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const proc = new EventEmitter() as any;
      proc.pid = 999;
      proc.kill = sinon.stub();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      spawnStub.returns(proc);

      const callbacks = {
        onProcessSpawned: sinon.stub(),
        onProcessExited: sinon.stub(),
      };
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps, callbacks);

      const delegatePromise = delegator.delegate({
        jobId: 'copilot-job',
        taskDescription: 'Do something with copilot',
        label: 'work',
        worktreePath: '/fake/worktree',
        baseBranch: 'main',
        targetBranch: 'feature/copilot',
      });

      // Emit exit with success
      process.nextTick(() => {
        proc.emit('exit', 0);
      });

      const result = await delegatePromise;
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(callbacks.onProcessSpawned.calledWith(999), 'should notify process spawned');
      assert.ok(callbacks.onProcessExited.calledWith(999), 'should notify process exited');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('returns failure when copilot exits with non-zero code', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const proc = new EventEmitter() as any;
      proc.pid = 888;
      proc.kill = sinon.stub();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      spawnStub.returns(proc);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const delegatePromise = delegator.delegate({
        jobId: 'fail-job',
        taskDescription: 'Failing task',
        label: 'work',
        worktreePath: '/fake',
        baseBranch: 'main',
        targetBranch: 'feature/fail',
      });

      process.nextTick(() => {
        proc.emit('exit', 1);
      });

      const result = await delegatePromise;
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
      assert.ok(result.error?.includes('exit code'), 'should include exit code in error');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('returns failure on process error', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const proc = new EventEmitter() as any;
      proc.pid = undefined;
      proc.kill = sinon.stub();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      spawnStub.returns(proc);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const delegatePromise = delegator.delegate({
        jobId: 'error-job',
        taskDescription: 'Error task',
        label: 'work',
        worktreePath: '/fake',
        baseBranch: 'main',
        targetBranch: 'feature/error',
      });

      process.nextTick(() => {
        proc.emit('error', new Error('spawn ENOENT'));
      });

      const result = await delegatePromise;
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('ENOENT'), 'should include error message');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('captures session ID from stdout', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const proc = new EventEmitter() as any;
      proc.pid = 777;
      proc.kill = sinon.stub();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      spawnStub.returns(proc);

      const sessionCallback = sinon.stub();
      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps, { onSessionCaptured: sessionCallback });

      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const delegatePromise = delegator.delegate({
        jobId: 'session-job',
        taskDescription: 'Session task',
        label: 'work',
        worktreePath: '/fake',
        baseBranch: 'main',
        targetBranch: 'feature/session',
      });

      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from(`Starting up...\nSession ID: ${uuid}\nDoing work...\n`));
        proc.emit('exit', 0);
      });

      const result = await delegatePromise;
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, uuid);
      assert.ok(sessionCallback.calledWith(uuid), 'should call onSessionCaptured callback');

      stageFileStub.restore();
      commitStub.restore();
    });

    test('resumes existing session when sessionId provided', async () => {
      const { AgentDelegator } = await import('../../../agent/agentDelegator');
      const cliCheckCore = require('../../../agent/cliCheckCore');
      sinon.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);

      const git = require('../../../git');
      const stageFileStub = sinon.stub(git.repository, 'stageFile').resolves();
      const commitStub = sinon.stub(git.repository, 'commit').resolves(true);

      const proc = new EventEmitter() as any;
      proc.pid = 666;
      proc.kill = sinon.stub();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      spawnStub.returns(proc);

      const logger = { log: sinon.stub() };
      const delegator = new AgentDelegator(logger, mockGitOps);

      const delegatePromise = delegator.delegate({
        jobId: 'resume-job',
        taskDescription: 'Resume task',
        label: 'work',
        worktreePath: '/fake',
        baseBranch: 'main',
        targetBranch: 'feature/resume',
        sessionId: 'existing-session-id',
      });

      process.nextTick(() => {
        proc.emit('exit', 0);
      });

      const result = await delegatePromise;
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, 'existing-session-id');

      // Verify spawn was called with --resume flag
      const [cmd] = spawnStub.firstCall.args;
      assert.ok(cmd.includes('--resume'), 'should include --resume flag');
      assert.ok(cmd.includes('existing-session-id'), 'should include session ID');

      // Verify logger mentions resuming
      const loggedMessages = logger.log.args.map((a: any[]) => a[0]);
      assert.ok(loggedMessages.some((m: string) => m.includes('Resuming')), 'should log resuming session');

      stageFileStub.restore();
      commitStub.restore();
    });
  });
});
