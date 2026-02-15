/**
 * @fileoverview Unit tests for DefaultJobExecutor.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DefaultJobExecutor } from '../../../plan/executor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { DefaultEvidenceValidator } from '../../../plan/evidenceValidator';
import { ProcessMonitor } from '../../../process';
import type { ExecutionPhase } from '../../../plan/types';
import type { ICopilotRunner } from '../../../interfaces/ICopilotRunner';
import { DefaultGitOperations } from '../../../git/DefaultGitOperations';

// Mock ICopilotRunner for tests
const mockCopilotRunner: ICopilotRunner = {
  run: async () => ({ success: true, sessionId: 'test', metrics: { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 } }),
  isAvailable: () => true,
  writeInstructionsFile: (cwd: string, task: string, instructions: string | undefined, label: string, jobId?: string) => ({ filePath: '/tmp/instructions.md', dirPath: '/tmp' }),
  buildCommand: (options: any) => 'copilot --help',
  cleanupInstructionsFile: (filePath: string, dirPath: string | undefined, label: string) => {}
};

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
  tmpDirs.push(dir);
  return dir;
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

suite('DefaultJobExecutor', () => {
  let quiet: { restore: () => void };
  let executor: DefaultJobExecutor;

  setup(() => {
    quiet = silenceConsole();
    executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), new DefaultGitOperations(), mockCopilotRunner);
    tmpDirs = [];
  });

  teardown(() => {
    quiet.restore();
    for (const dir of tmpDirs) rmrf(dir);
  });

  suite('setStoragePath()', () => {
    test('creates logs directory', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      assert.ok(fs.existsSync(path.join(tmp, 'logs')));
    });

    test('does not fail if logs dir already exists', () => {
      const tmp = makeTmpDir();
      fs.mkdirSync(path.join(tmp, 'logs'));
      assert.doesNotThrow(() => executor.setStoragePath(tmp));
    });
  });

  suite('setAgentDelegator()', () => {
    test('accepts any delegator object', () => {
      assert.doesNotThrow(() => executor.setAgentDelegator({ delegate: async () => ({}) }));
    });
  });

  suite('setEvidenceValidator()', () => {
    test('accepts any validator', () => {
      assert.doesNotThrow(() => executor.setEvidenceValidator({ validate: async () => ({ valid: true }) } as any));
    });
  });

  suite('log()', () => {
    test('stores log entries in memory', () => {
      executor.log('p1', 'n1', 'work', 'info', 'hello');
      const logs = executor.getLogs('p1', 'n1');
      assert.ok(logs.some(l => l.message === 'hello'));
    });

    test('creates log file on disk when storagePath set', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      executor.log('p1', 'n1', 'work', 'info', 'test message');
      const logsDir = path.join(tmp, 'logs');
      const files = fs.readdirSync(logsDir);
      assert.ok(files.length > 0, 'Should have created a log file');
    });

    test('log file entries contain phase and type markers', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      executor.log('p1', 'n1', 'commit', 'error', 'bad commit');
      const content = executor.readLogsFromFile('p1', 'n1');
      assert.ok(content.includes('[COMMIT]'));
      assert.ok(content.includes('[ERROR]'));
    });
  });

  suite('getLogs()', () => {
    test('returns empty array for unknown execution', () => {
      assert.deepStrictEqual(executor.getLogs('unknown', 'unknown'), []);
    });

    test('returns entries for known execution', () => {
      executor.log('p1', 'n1', 'work', 'info', 'a');
      executor.log('p1', 'n1', 'work', 'stderr', 'b');
      const logs = executor.getLogs('p1', 'n1');
      assert.strictEqual(logs.length, 2);
    });
  });

  suite('getLogsForPhase()', () => {
    test('filters by phase', () => {
      executor.log('p1', 'n1', 'prechecks', 'info', 'pre');
      executor.log('p1', 'n1', 'work', 'info', 'work');
      executor.log('p1', 'n1', 'postchecks', 'info', 'post');
      const workLogs = executor.getLogsForPhase('p1', 'n1', 'work');
      assert.strictEqual(workLogs.length, 1);
      assert.strictEqual(workLogs[0].message, 'work');
    });
  });

  suite('readLogsFromFile()', () => {
    test('returns content when log file exists', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      executor.log('p1', 'n1', 'work', 'info', 'persisted');
      const content = executor.readLogsFromFile('p1', 'n1');
      assert.ok(content.includes('persisted'));
    });

    test('returns fallback when no log file', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      const content = executor.readLogsFromFile('none', 'none');
      // getLogFilePathByKey creates a log file with header on first access
      assert.ok(typeof content === 'string');
      assert.ok(content.length > 0);
    });

    test('returns fallback when no storagePath', () => {
      const content = executor.readLogsFromFile('p1', 'n1');
      assert.ok(content.includes('No log file'));
    });

    test('returns error message when log file is unreadable', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      executor.log('p-err', 'n-err', 'work', 'info', 'test');
      const logDir = path.join(tmp, 'logs');
      const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
      assert.ok(files.length > 0);
      const logFile = path.join(logDir, files[0]);
      fs.unlinkSync(logFile);
      fs.mkdirSync(logFile); // Replace file with directory
      const content = executor.readLogsFromFile('p-err', 'n-err');
      assert.ok(content.includes('Error reading') || content.includes('error'));
    });
  });

  suite('appendToLogFile error handling', () => {
    test('ignores file write errors silently', () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      executor.log('p-wr', 'n-wr', 'work', 'info', 'initial');
      const logDir = path.join(tmp, 'logs');
      const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
      const logFile = path.join(logDir, files[0]);
      fs.unlinkSync(logFile);
      fs.mkdirSync(logFile);
      assert.doesNotThrow(() => {
        executor.log('p-wr', 'n-wr', 'work', 'info', 'should fail silently');
      });
    });
  });

  suite('isActive()', () => {
    test('returns false when no execution is active', () => {
      assert.strictEqual(executor.isActive('p1', 'n1'), false);
    });
  });

  suite('getProcessStats()', () => {
    test('returns defaults when no execution is active', async () => {
      const stats = await executor.getProcessStats('p1', 'n1');
      assert.strictEqual(stats.running, false);
      assert.strictEqual(stats.pid, null);
    });
  });

  suite('getAllProcessStats()', () => {
    test('returns empty array for empty input', async () => {
      const result = await executor.getAllProcessStats([]);
      assert.deepStrictEqual(result, []);
    });

    test('skips unknown executions', async () => {
      const result = await executor.getAllProcessStats([{ planId: 'x', nodeId: 'y', nodeName: 'Z' }]);
      assert.deepStrictEqual(result, []);
    });
  });

  suite('cancel()', () => {
    test('does nothing for unknown execution', () => {
      assert.doesNotThrow(() => executor.cancel('x', 'y'));
    });
  });

  suite('execute() - worktree check', () => {
    test('returns error if worktree does not exist', async () => {
      const context = {
        plan: { id: 'p1', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: { id: 'n1', name: 'Job', type: 'job' as const, dependencies: [], dependents: [] } as any,
        worktreePath: '/nonexistent/worktree/path',
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Worktree does not exist'));
      assert.strictEqual(result.failedPhase, 'merge-fi');
    });
  });

  suite('execute() - no work', () => {
    test('handles node with no work, prechecks, postchecks', async () => {
      const tmp = makeTmpDir();
      // Create a minimal git repo in the temp dir for the commit phase
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'README.md'), 'test');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}

      const context = {
        plan: { id: 'p2', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n2', name: 'NoWork', type: 'job' as const,
          dependencies: [], dependents: [],
          // no prechecks, work, postchecks
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      // May succeed or fail in commit phase, but work should be skipped
      assert.ok(result.stepStatuses);
      assert.strictEqual(result.stepStatuses.work, 'skipped');
      assert.strictEqual(result.stepStatuses.prechecks, 'skipped');
      assert.strictEqual(result.stepStatuses.postchecks, 'skipped');
    });
  });

  suite('execute() - resume from phase', () => {
    test('skips earlier phases when resumeFromPhase set', async () => {
      const tmp = makeTmpDir();
      const context = {
        plan: { id: 'p3', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n3', name: 'Resume', type: 'job' as const,
          prechecks: 'echo precheck',
          work: 'echo work',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
        resumeFromPhase: 'postchecks' as any,
        previousStepStatuses: { prechecks: 'success' as const, work: 'success' as const },
      };
      const result = await executor.execute(context);
      // prechecks and work should be preserved from previousStepStatuses
      assert.ok(result.stepStatuses);
    });
  });

  suite('execute() - with shell work', () => {
    test('runs shell prechecks successfully', async () => {
      const tmp = makeTmpDir();
      // Initialize git repo
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'init');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}

      const context = {
        plan: { id: 'p4', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n4', name: 'WithWork', type: 'job' as const,
          prechecks: 'echo precheck_ok',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.stepStatuses?.prechecks, 'success');
    });

    test('returns error for failing shell prechecks', async () => {
      const tmp = makeTmpDir();
      const context = {
        plan: { id: 'p5', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n5', name: 'FailCheck', type: 'job' as const,
          prechecks: 'exit 1',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stepStatuses?.prechecks, 'failed');
      assert.strictEqual(result.failedPhase, 'prechecks');
    });

    test('runs work command successfully', async () => {
      const tmp = makeTmpDir();
      // Initialize git repo
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'init');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}

      const context = {
        plan: { id: 'p6', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n6', name: 'RunWork', type: 'job' as const,
          work: 'echo doing_work',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.stepStatuses?.work, 'success');
    });

    test('handles failing work command', async () => {
      const tmp = makeTmpDir();
      const context = {
        plan: { id: 'p7', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n7', name: 'FailWork', type: 'job' as const,
          work: 'exit 1',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stepStatuses?.work, 'failed');
      assert.strictEqual(result.failedPhase, 'work');
    });

    test('runs postchecks after work', async () => {
      const tmp = makeTmpDir();
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'init');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}

      const context = {
        plan: { id: 'p8', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n8', name: 'WithPost', type: 'job' as const,
          work: 'echo work_ok',
          postchecks: 'echo postcheck_ok',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.stepStatuses?.postchecks, 'success');
    });

    test('handles failing postchecks', async () => {
      const tmp = makeTmpDir();
      const context = {
        plan: { id: 'p9', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n9', name: 'FailPost', type: 'job' as const,
          work: 'echo ok',
          postchecks: 'exit 1',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stepStatuses?.postchecks, 'failed');
      assert.strictEqual(result.failedPhase, 'postchecks');
    });

    test('handles process spec execution', async () => {
      const tmp = makeTmpDir();
      const context = {
        plan: { id: 'p10', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n10', name: 'ProcessWork', type: 'job' as const,
          work: { type: 'process', executable: 'echo', args: ['hello'] },
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      // Process should execute 'echo hello'
      assert.ok(result.stepStatuses?.work);
    });

    test('handles onProgress callback', async () => {
      const tmp = makeTmpDir();
      const progresses: string[] = [];
      const context = {
        plan: { id: 'p11', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n11', name: 'Progress', type: 'job' as const,
          prechecks: 'echo check',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
        onProgress: (msg: string) => progresses.push(msg),
      };
      await executor.execute(context);
      assert.ok(progresses.length > 0);
    });

    test('commits changes when work modifies files', async () => {
      const tmp = makeTmpDir();
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'initial');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}
      const baseCommit = require('child_process').execSync('git rev-parse HEAD', { cwd: tmp }).toString().trim();

      const context = {
        plan: { id: 'p12', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n12', name: 'ModifyFile', type: 'job' as const,
          task: 'Modify a file',
          work: `echo modified > ${path.join(tmp, 'file.txt').replace(/\\/g, '/')}`,
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit,
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, true);
      assert.ok(result.completedCommit);
      assert.ok(result.workSummary);
      assert.strictEqual(result.stepStatuses?.commit, 'success');
    });

    test('handles expectsNoChanges node with no modifications', async () => {
      const tmp = makeTmpDir();
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'initial');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}
      const baseCommit = require('child_process').execSync('git rev-parse HEAD', { cwd: tmp }).toString().trim();

      const context = {
        plan: { id: 'p13', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n13', name: 'NoChanges', type: 'job' as const,
          task: 'Check only',
          work: 'echo check_only',
          expectsNoChanges: true,
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit,
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, true);
    });

    test('fails commit when no changes and no expectsNoChanges', async () => {
      const tmp = makeTmpDir();
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'initial');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}
      const baseCommit = require('child_process').execSync('git rev-parse HEAD', { cwd: tmp }).toString().trim();

      const context = {
        plan: { id: 'p14', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'n14', name: 'NoWork', type: 'job' as const,
          task: 'Do nothing',
          work: 'echo nothing_changed',
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit,
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.stepStatuses?.commit, 'failed');
    });
  });

  suite('execute() - agent work', () => {
    test('returns error when no agent delegator configured', async () => {
      const tmp = makeTmpDir();
      const context = {
        plan: { id: 'pa1', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'na1', name: 'AgentWork', type: 'job' as const,
          task: 'Agent task',
          work: { type: 'agent', instructions: 'fix the bug' },
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('agent delegator'));
    });

    test('runs agent work with delegator', async () => {
      const tmp = makeTmpDir();
      executor.setStoragePath(tmp);
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'initial');
        execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });
      } catch {}
      const baseCommit = require('child_process').execSync('git rev-parse HEAD', { cwd: tmp }).toString().trim();

      executor.setAgentDelegator({
        delegate: async (opts: any) => {
          // Simulate agent making changes
          fs.writeFileSync(path.join(tmp, 'agent-output.txt'), 'agent work');
          return { success: true, sessionId: 'session-123' };
        },
      });
      const context = {
        plan: { id: 'pa2', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'na2', name: 'AgentWork', type: 'job' as const,
          task: 'Fix bug',
          work: { type: 'agent', instructions: 'fix it', model: 'gpt-4', contextFiles: ['file.txt'], maxTurns: 5, context: 'extra' },
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit,
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.copilotSessionId, 'session-123');
    });

    test('handles agent failure', async () => {
      const tmp = makeTmpDir();
      executor.setAgentDelegator({
        delegate: async () => ({ success: false, error: 'agent crashed', exitCode: 1 }),
      });
      const context = {
        plan: { id: 'pa3', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'na3', name: 'AgentFail', type: 'job' as const,
          task: 'Fail',
          work: { type: 'agent', instructions: 'crash' },
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failedPhase, 'work');
    });

    test('handles agent delegator exception', async () => {
      const tmp = makeTmpDir();
      executor.setAgentDelegator({
        delegate: async () => { throw new Error('delegator error'); },
      });
      const context = {
        plan: { id: 'pa4', spec: { name: 'test' }, nodeStates: new Map() } as any,
        node: {
          id: 'na4', name: 'AgentError', type: 'job' as const,
          task: 'Error',
          work: { type: 'agent', instructions: 'fail' },
          dependencies: [], dependents: [],
        } as any,
        worktreePath: tmp,
        baseCommit: 'abc123',
        attemptNumber: 1,
      };
      const result = await executor.execute(context);
      assert.strictEqual(result.success, false);
    });
  });
});


