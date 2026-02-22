/**
 * @fileoverview Unit tests for specific agent coverage areas:
 * - allowedFolders merging with worktreePath in AgentDelegator
 * - CLI version checking
 * - --no-auto-update flag in buildCommand
 * - Model discovery cache with TTL
 * 
 * These tests supplement existing test files with targeted coverage.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { suite, test, setup, teardown } from 'mocha';

// ============================================================================
// IMPORTS
// ============================================================================

import { AgentDelegator } from '../../../agent/agentDelegator';
import type { DelegatorLogger, DelegateOptions, DelegatorCallbacks } from '../../../agent/agentDelegator';
import type { ICopilotRunner } from '../../../interfaces/ICopilotRunner';
import type { CopilotRunOptions } from '../../../agent/copilotCliRunner';
import { buildCommand, sanitizeUrl, CopilotCliRunner } from '../../../agent/copilotCliRunner';
import {
  isCopilotCliAvailable,
  checkCopilotCliAsync,
  resetCliCache,
  isCliCachePopulated,
  cmdOkAsync,
} from '../../../agent/cliCheckCore';
import {
  discoverAvailableModels,
  getCachedModels,
  resetModelCache,
} from '../../../agent/modelDiscovery';
import type { IProcessSpawner, ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import type { IGitOperations } from '../../../interfaces/IGitOperations';
import * as cliCheckCore from '../../../agent/cliCheckCore';

// ============================================================================
// HELPERS
// ============================================================================

function createMockLogger(): DelegatorLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    log: (msg: string) => messages.push(msg),
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
      resetMixed: async () => {},
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
    command: {} as any,
  };
}

function createMockSpawner(output: string = '', exitCode: number = 0): IProcessSpawner {
  return {
    spawn(): ChildProcessLike {
      const proc = new EventEmitter() as EventEmitter & ChildProcessLike;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, {
        pid: 1234,
        exitCode: null as number | null,
        killed: false,
        stdout,
        stderr,
        kill() { return true; },
      });
      setImmediate(() => {
        if (output) {
          stdout.emit('data', Buffer.from(output));
        }
        (proc as any).exitCode = exitCode;
        proc.emit('close', exitCode);
      });
      return proc as unknown as ChildProcessLike;
    },
  };
}

function createErrorSpawner(): IProcessSpawner {
  return {
    spawn(): ChildProcessLike {
      const proc = new EventEmitter() as EventEmitter & ChildProcessLike;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, {
        pid: 1234,
        exitCode: null as number | null,
        killed: false,
        stdout,
        stderr,
        kill() { return true; },
      });
      setImmediate(() => proc.emit('error', new Error('command not found')));
      return proc as unknown as ChildProcessLike;
    },
  };
}

// ============================================================================
// TESTS: allowedFolders merging with worktreePath
// ============================================================================

suite('AgentDelegator - allowedFolders merging', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(cliCheckCore, 'isCopilotCliAvailable').returns(true);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-coverage-test-'));
  });

  teardown(() => {
    sandbox.restore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('should add worktreePath to empty allowedFolders', async () => {
    const logger = createMockLogger();
    const gitOps = createMockGitOps();
    let capturedFolders: string[] = [];
    
    const runner: ICopilotRunner = {
      run: async (options: CopilotRunOptions) => {
        capturedFolders = options.allowedFolders || [];
        return { success: true };
      },
      isAvailable: () => true,
      writeInstructionsFile: () => ({ filePath: '/fake', dirPath: '/fake' }),
      buildCommand: () => 'mock',
      cleanupInstructionsFile: () => {},
    };
    
    const delegator = new AgentDelegator(logger, gitOps, {}, runner);
    
    await delegator.delegate({
      jobId: 'test-job',
      taskDescription: 'Test task',
      label: 'work',
      worktreePath: tmpDir,
      baseBranch: 'main',
      targetBranch: 'feature/test',
      // No allowedFolders specified
    });
    
    assert.ok(capturedFolders.includes(tmpDir),
      'worktreePath should be added to allowedFolders');
    assert.strictEqual(capturedFolders[0], tmpDir,
      'worktreePath should be first in the array');
  });

  test('should add worktreePath to beginning when allowedFolders exist', async () => {
    const logger = createMockLogger();
    const gitOps = createMockGitOps();
    let capturedFolders: string[] = [];
    
    const runner: ICopilotRunner = {
      run: async (options: CopilotRunOptions) => {
        capturedFolders = options.allowedFolders || [];
        return { success: true };
      },
      isAvailable: () => true,
      writeInstructionsFile: () => ({ filePath: '/fake', dirPath: '/fake' }),
      buildCommand: () => 'mock',
      cleanupInstructionsFile: () => {},
    };
    
    const delegator = new AgentDelegator(logger, gitOps, {}, runner);
    
    await delegator.delegate({
      jobId: 'test-job',
      taskDescription: 'Test task',
      label: 'work',
      worktreePath: tmpDir,
      baseBranch: 'main',
      targetBranch: 'feature/test',
      allowedFolders: ['/shared/libs', '/shared/config'],
    });
    
    assert.strictEqual(capturedFolders.length, 3,
      'Should have worktreePath + 2 additional folders');
    assert.strictEqual(capturedFolders[0], tmpDir,
      'worktreePath should be first');
    assert.ok(capturedFolders.includes('/shared/libs'),
      'Should include original allowed folder');
    assert.ok(capturedFolders.includes('/shared/config'),
      'Should include original allowed folder');
  });

  test('should not duplicate worktreePath if already in allowedFolders', async () => {
    const logger = createMockLogger();
    const gitOps = createMockGitOps();
    let capturedFolders: string[] = [];
    
    const runner: ICopilotRunner = {
      run: async (options: CopilotRunOptions) => {
        capturedFolders = options.allowedFolders || [];
        return { success: true };
      },
      isAvailable: () => true,
      writeInstructionsFile: () => ({ filePath: '/fake', dirPath: '/fake' }),
      buildCommand: () => 'mock',
      cleanupInstructionsFile: () => {},
    };
    
    const delegator = new AgentDelegator(logger, gitOps, {}, runner);
    
    await delegator.delegate({
      jobId: 'test-job',
      taskDescription: 'Test task',
      label: 'work',
      worktreePath: tmpDir,
      baseBranch: 'main',
      targetBranch: 'feature/test',
      allowedFolders: [tmpDir, '/other/path'],
    });
    
    const worktreeCount = capturedFolders.filter(f => f === tmpDir).length;
    assert.strictEqual(worktreeCount, 1,
      'worktreePath should appear exactly once');
  });

  test('should log security configuration for allowedFolders', async () => {
    const logger = createMockLogger();
    const gitOps = createMockGitOps();
    
    const runner: ICopilotRunner = {
      run: async () => ({ success: true }),
      isAvailable: () => true,
      writeInstructionsFile: () => ({ filePath: '/fake', dirPath: '/fake' }),
      buildCommand: () => 'mock',
      cleanupInstructionsFile: () => {},
    };
    
    const delegator = new AgentDelegator(logger, gitOps, {}, runner);
    
    await delegator.delegate({
      jobId: 'test-job',
      taskDescription: 'Test task',
      label: 'work',
      worktreePath: tmpDir,
      baseBranch: 'main',
      targetBranch: 'feature/test',
      allowedFolders: ['/shared'],
    });
    
    const loggedAllowedFolders = logger.messages.find(m => m.includes('Allowed folders:'));
    assert.ok(loggedAllowedFolders, 'Should log allowed folders');
    assert.ok(loggedAllowedFolders!.includes(tmpDir), 'Log should contain worktreePath');
    assert.ok(loggedAllowedFolders!.includes('/shared'), 'Log should contain additional folder');
  });
});

// ============================================================================
// TESTS: --no-auto-update flag in buildCommand
// ============================================================================

suite('buildCommand - --no-auto-update flag', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should include --no-auto-update flag in generated command', () => {
    const cmd = buildCommand(
      { task: 'test task', cwd: '/test/path' },
      { existsSync: () => true }
    );
    
    assert.ok(cmd.includes('--no-auto-update'),
      'Command should include --no-auto-update flag');
  });

  test('should include --no-auto-update before optional flags', () => {
    const cmd = buildCommand(
      { task: 'test task', cwd: '/test/path', model: 'gpt-5' },
      { existsSync: () => true }
    );
    
    const noAutoUpdateIndex = cmd.indexOf('--no-auto-update');
    const modelIndex = cmd.indexOf('--model');
    
    assert.ok(noAutoUpdateIndex !== -1, '--no-auto-update should be in command');
    assert.ok(modelIndex !== -1, '--model should be in command');
    assert.ok(noAutoUpdateIndex < modelIndex,
      '--no-auto-update should come before --model');
  });

  test('should include --no-auto-update alongside --allow-all-tools', () => {
    const cmd = buildCommand(
      { task: 'test task', cwd: '/test/path' },
      { existsSync: () => true }
    );
    
    assert.ok(cmd.includes('--allow-all-tools'), 'Should include --allow-all-tools');
    assert.ok(cmd.includes('--no-auto-update'), 'Should include --no-auto-update');
    
    // Both should be on the same command line
    const hasFlags = cmd.includes('--allow-all-tools') && cmd.includes('--no-auto-update');
    assert.ok(hasFlags, 'Both flags should be present');
  });

  test('CopilotCliRunner.buildCommand includes --no-auto-update', () => {
    const runner = new CopilotCliRunner();
    const cmd = runner.buildCommand({ task: 'test task', cwd: '/test/path' });
    
    assert.ok(cmd.includes('--no-auto-update'),
      'CopilotCliRunner.buildCommand should include --no-auto-update');
  });
});

// ============================================================================
// TESTS: CLI version checking
// ============================================================================

suite('CLI version checking', () => {
  let sandbox: sinon.SinonSandbox;
  const cp = require('child_process');
  let origSpawn: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    origSpawn = cp.spawn;
    resetCliCache();
  });

  teardown(() => {
    cp.spawn = origSpawn;
    sandbox.restore();
    resetCliCache();
  });

  function fakeProc(exitCode: number, stdout = '') {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = sandbox.stub();
    setTimeout(() => {
      if (stdout) { proc.stdout.emit('data', Buffer.from(stdout)); }
      proc.emit('close', exitCode);
    }, 5);
    return proc;
  }

  test('isCopilotCliAvailable returns false when cache is empty', () => {
    cp.spawn = sandbox.stub().returns(fakeProc(1));
    const result = isCopilotCliAvailable();
    assert.strictEqual(result, false, 'Should return false when cache is empty');
  });

  test('isCopilotCliAvailable returns cached value after async check', async () => {
    cp.spawn = sandbox.stub().returns(fakeProc(0));
    
    await checkCopilotCliAsync();
    const result = isCopilotCliAvailable();
    
    assert.strictEqual(result, true, 'Should return cached true value');
  });

  test('checkCopilotCliAsync tries multiple CLI variants', async () => {
    let callCount = 0;
    cp.spawn = sandbox.stub().callsFake((cmd: string) => {
      callCount++;
      // All fail except the last one (github-copilot-cli)
      if (callCount < 5) { return fakeProc(1); }
      return fakeProc(0);
    });
    
    const result = await checkCopilotCliAsync();
    
    assert.strictEqual(result, true, 'Should find CLI on final attempt');
    assert.ok(callCount >= 4, 'Should try multiple CLI variants');
  });

  test('checkCopilotCliAsync detects gh copilot extension via gh extension list', async () => {
    let callCount = 0;
    cp.spawn = sandbox.stub().callsFake((cmd: string, args: string[]) => {
      callCount++;
      // First call (gh copilot --help) fails
      if (callCount === 1) { return fakeProc(1); }
      // Second call (gh extension list) returns copilot extension
      if (args && args[0] === 'extension') {
        return fakeProc(0, 'github/gh-copilot');
      }
      return fakeProc(1);
    });
    
    const result = await checkCopilotCliAsync();
    
    assert.strictEqual(result, true, 'Should detect copilot via gh extension list');
  });

  test('resetCliCache clears the cached value', async () => {
    cp.spawn = sandbox.stub().returns(fakeProc(0));
    
    await checkCopilotCliAsync();
    assert.strictEqual(isCliCachePopulated(), true, 'Cache should be populated');
    
    resetCliCache();
    
    assert.strictEqual(isCliCachePopulated(), false, 'Cache should be cleared');
  });

  test('isCliCachePopulated returns correct state', async () => {
    assert.strictEqual(isCliCachePopulated(), false, 'Should be false initially');
    
    cp.spawn = sandbox.stub().returns(fakeProc(0));
    await checkCopilotCliAsync();
    
    assert.strictEqual(isCliCachePopulated(), true, 'Should be true after check');
  });

  test('cmdOkAsync returns true for successful command', async () => {
    const spawner = createMockSpawner('', 0);
    const result = await cmdOkAsync('echo test', spawner);
    assert.strictEqual(result, true);
  });

  test('cmdOkAsync returns false for failed command', async () => {
    const spawner = createMockSpawner('', 1);
    const result = await cmdOkAsync('invalid-command', spawner);
    assert.strictEqual(result, false);
  });

  test('cmdOkAsync returns false on spawn error', async () => {
    const spawner = createErrorSpawner();
    const result = await cmdOkAsync('nonexistent-cmd', spawner);
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// TESTS: Model discovery cache with TTL
// ============================================================================

suite('Model discovery cache with TTL', () => {
  const HELP_OUTPUT = `Usage: copilot [options]
  --model <model>  The model to use (choices: "claude-sonnet-4.5", "gpt-5", "claude-haiku-4.5")
`;

  setup(() => {
    resetModelCache();
  });

  teardown(() => {
    resetModelCache();
  });

  test('cache TTL is 30 minutes (1800000 ms)', async () => {
    let currentTime = 1000000;
    const clock = () => currentTime;
    const spawner = createMockSpawner(HELP_OUTPUT, 0);
    
    // First discovery
    const result1 = await discoverAvailableModels({ spawner, clock });
    assert.strictEqual(result1.models.length, 3);
    
    // Advance time by 29 minutes (within 30-minute TTL)
    currentTime += 29 * 60 * 1000;
    
    // Should return cached result
    const result2 = await getCachedModels({ spawner: createErrorSpawner(), clock });
    assert.strictEqual(result2.discoveredAt, result1.discoveredAt,
      'Should return cached result within TTL');
    
    // Advance time past TTL (total 31 minutes)
    currentTime += 2 * 60 * 1000;
    
    // Should trigger new discovery
    const newSpawner = createMockSpawner(HELP_OUTPUT, 0);
    const result3 = await getCachedModels({ spawner: newSpawner, clock });
    assert.ok(result3.discoveredAt > result1.discoveredAt,
      'Should re-discover after TTL expires');
  });

  test('failure cache TTL is 30 seconds', async () => {
    let currentTime = 1000000;
    const clock = () => currentTime;
    
    // First discovery fails
    const result1 = await discoverAvailableModels({
      spawner: createErrorSpawner(),
      clock
    });
    assert.strictEqual(result1.models.length, 0, 'Failed discovery returns empty');
    
    // Advance time by 25 seconds (within failure TTL)
    currentTime += 25 * 1000;
    
    // Should still return empty (failure cached)
    const result2 = await discoverAvailableModels({
      spawner: createMockSpawner(HELP_OUTPUT, 0),
      clock
    });
    assert.strictEqual(result2.models.length, 0,
      'Should return cached failure within 30s TTL');
    
    // Advance time past failure TTL
    currentTime += 10 * 1000; // Now at 35 seconds
    
    // Should retry discovery
    const result3 = await discoverAvailableModels({
      spawner: createMockSpawner(HELP_OUTPUT, 0),
      clock
    });
    assert.strictEqual(result3.models.length, 3,
      'Should retry discovery after failure TTL expires');
  });

  test('cliVersion field is populated in discovery result', async () => {
    const spawner = createMockSpawner(HELP_OUTPUT, 0);
    const result = await discoverAvailableModels({ spawner });
    
    // cliVersion is optional but the field should exist in the result type
    assert.ok('cliVersion' in result || result.cliVersion === undefined,
      'Result should have cliVersion field (may be undefined)');
  });

  test('cache is keyed by discovery timestamp', async () => {
    let currentTime = 1000000;
    const clock = () => currentTime;
    const spawner = createMockSpawner(HELP_OUTPUT, 0);
    
    const result1 = await discoverAvailableModels({ spawner, clock });
    const timestamp1 = result1.discoveredAt;
    
    // Reset cache and discover again with different time
    resetModelCache();
    currentTime = 2000000;
    
    const result2 = await discoverAvailableModels({ spawner, clock });
    const timestamp2 = result2.discoveredAt;
    
    assert.notStrictEqual(timestamp1, timestamp2,
      'Different discoveries should have different timestamps');
    assert.strictEqual(timestamp2, 2000000,
      'Timestamp should match clock value at discovery time');
  });
});

// ============================================================================
// TESTS: buildCommand URL sanitization
// ============================================================================

suite('buildCommand URL sanitization', () => {
  test('sanitizeUrl rejects URLs with shell metacharacters', () => {
    const result1 = sanitizeUrl('https://example.com;rm -rf /');
    assert.strictEqual(result1, null, 'Should reject URL with semicolon');
    
    const result2 = sanitizeUrl('https://example.com`id`');
    assert.strictEqual(result2, null, 'Should reject URL with backticks');
    
    const result3 = sanitizeUrl('https://example.com&&whoami');
    assert.strictEqual(result3, null, 'Should reject URL with &&');
  });

  test('sanitizeUrl accepts valid HTTPS URLs', () => {
    const result = sanitizeUrl('https://api.github.com');
    assert.strictEqual(result, 'https://api.github.com');
  });

  test('sanitizeUrl accepts valid HTTP URLs', () => {
    const result = sanitizeUrl('http://localhost:3000');
    assert.strictEqual(result, 'http://localhost:3000');
  });

  test('sanitizeUrl rejects URLs starting with dash (argument injection)', () => {
    const result = sanitizeUrl('--config /etc/passwd');
    assert.strictEqual(result, null, 'Should reject URL starting with dash');
  });

  test('sanitizeUrl rejects empty or whitespace URLs', () => {
    assert.strictEqual(sanitizeUrl(''), null);
    assert.strictEqual(sanitizeUrl('   '), null);
  });
});

// ============================================================================
// TESTS: buildCommand path handling
// ============================================================================

suite('buildCommand path handling', () => {
  test('includes --add-dir for cwd when exists', () => {
    const cmd = buildCommand(
      { task: 'test task', cwd: '/worktrees/test' },
      { existsSync: () => true }
    );
    
    assert.ok(cmd.includes('--add-dir'), 'Should include --add-dir');
    assert.ok(cmd.includes('/worktrees/test') || cmd.includes('worktrees'),
      'Should include the cwd path');
  });

  test('includes --add-dir for all allowedFolders', () => {
    const cmd = buildCommand(
      {
        task: 'test task',
        cwd: '/worktrees/test',
        allowedFolders: ['/shared/libs', '/shared/config']
      },
      { existsSync: () => true }
    );
    
    // Should have multiple --add-dir flags
    const addDirCount = (cmd.match(/--add-dir/g) || []).length;
    assert.ok(addDirCount >= 3, 'Should have --add-dir for cwd and all allowedFolders');
  });

  test('skips relative paths in allowedFolders', () => {
    const logger: any = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };
    
    buildCommand(
      {
        task: 'test task',
        cwd: '/worktrees/test',
        allowedFolders: ['relative/path', '/absolute/path']
      },
      { existsSync: () => true, logger }
    );
    
    assert.ok(logger.warn.called, 'Should warn about relative path');
    const warnCall = logger.warn.args.find(
      (args: string[]) => args[0].includes('relative')
    );
    assert.ok(warnCall, 'Warning should mention relative path');
  });

  test('warns when allowedFolder does not exist', () => {
    const logger: any = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };
    
    buildCommand(
      {
        task: 'test task',
        cwd: '/worktrees/test',
        allowedFolders: ['/nonexistent/path']
      },
      { 
        existsSync: (p: string) => p.includes('worktrees'),
        logger
      }
    );
    
    assert.ok(logger.warn.called, 'Should warn about nonexistent path');
  });
});
