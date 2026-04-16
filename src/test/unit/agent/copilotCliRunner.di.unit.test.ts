/**
 * @fileoverview DI unit tests for CopilotCliRunner
 *
 * Tests buildCommand, sanitizeUrl pure functions and run flow with mock spawner.
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import {
  CopilotCliRunner,
  sanitizeUrl,
  buildCommand,
} from '../../../agent/copilotCliRunner';
import { resetCliCache } from '../../../agent/cliCheckCore';
import type { IProcessSpawner, ChildProcessLike } from '../../../interfaces/IProcessSpawner';
import type { IEnvironment } from '../../../interfaces/IEnvironment';
import type { CopilotCliLogger } from '../../../agent/copilotCliRunner';
import type { IManagedProcessFactory } from '../../../interfaces/IManagedProcessFactory';

// ── Helpers ────────────────────────────────────────────────────────────

function noopLogger(): CopilotCliLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/** Create a fake child process that emits events. */
function createFakeProcess(pid = 1234): ChildProcessLike & EventEmitter {
  const proc = new EventEmitter() as any;
  proc.pid = pid;
  proc.exitCode = null;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (signal?: NodeJS.Signals | number) => { proc.killed = true; return true; };
  return proc;
}

function createMockSpawner(proc: ChildProcessLike & EventEmitter): IProcessSpawner {
  return {
    spawn: (_cmd: string, _args: string[], _opts: any) => proc,
  };
}

function createMockEnv(overrides?: Partial<IEnvironment>): IEnvironment {
  return {
    env: overrides?.env ?? { HOME: '/home/test' },
    platform: overrides?.platform ?? 'linux',
    cwd: overrides?.cwd ?? (() => '/mock/cwd'),
  };
}

/** Create a mock IManagedProcessFactory that wraps a raw process with simple handler stubs. */
function createMockManagedFactory(): IManagedProcessFactory {
  return {
    create(proc: any, _options: any) {
      const emitter = new EventEmitter();
      let sessionId: string | undefined;
      let sawComplete = false;
      let statsStarted: number | null = null;
      let metrics: any;

      const mockBus = {
        getHandler: <T>(name: string): T | undefined => {
          if (name === 'session-id') return { getSessionId: () => sessionId } as any;
          if (name === 'task-complete') return { sawTaskComplete: () => sawComplete } as any;
          if (name === 'stats') return { getStatsStartedAt: () => statsStarted, getMetrics: () => metrics } as any;
          return undefined;
        },
        dispose: () => {},
      };

      const processLine = (line: string) => {
        const sm = line.match(/Session ID[:\s]+([a-f0-9-]{36})/i) ||
                   line.match(/session[:\s]+([a-f0-9-]{36})/i) ||
                   line.match(/Starting session[:\s]+([a-f0-9-]{36})/i);
        if (sm && !sessionId) { sessionId = sm[1]; }
        if (line.includes('Task complete')) { sawComplete = true; }
      };

      proc.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach((line: string) => {
          if (line.trim()) {
            processLine(line.trim());
            emitter.emit('line', line.trim(), { type: 'stdout', name: 'stdout' });
          }
        });
      });
      proc.stderr?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach((line: string) => {
          if (line.trim()) {
            processLine(line.trim());
            emitter.emit('line', line.trim(), { type: 'stderr', name: 'stderr' });
          }
        });
      });
      proc.on('exit', (code: any, signal: any) => emitter.emit('exit', code, signal));
      proc.on('error', (err: any) => emitter.emit('error', err));

      return Object.assign(emitter, {
        pid: proc.pid,
        exitCode: proc.exitCode,
        killed: proc.killed,
        bus: mockBus,
        timestamps: { requested: 0 },
        durations: {},
        diagnostics: () => ({
          pid: proc.pid, exitCode: proc.exitCode, killed: proc.killed,
          timestamps: { requested: 0 }, durations: {},
          handlerNames: ['stats', 'session-id', 'task-complete'],
          busMetrics: { totalLines: 0, linesBySource: {}, handlerInvocations: 0, handlerErrors: 0 },
          tailerMetrics: [],
        }),
        kill: (signal?: any) => proc.kill?.(signal),
      }) as any;
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

suite('CopilotCliRunner DI', () => {

  // ====================================================================
  // sanitizeUrl (pure function)
  // ====================================================================
  suite('sanitizeUrl (pure)', () => {
    test('accepts valid https URL', () => {
      assert.strictEqual(sanitizeUrl('https://example.com'), 'https://example.com');
    });

    test('accepts domain-only URL', () => {
      assert.strictEqual(sanitizeUrl('example.com'), 'example.com');
    });

    test('accepts wildcard domain', () => {
      assert.strictEqual(sanitizeUrl('*.example.com'), '*.example.com');
    });

    test('rejects empty string', () => {
      assert.strictEqual(sanitizeUrl(''), null);
    });

    test('rejects null/undefined input', () => {
      assert.strictEqual(sanitizeUrl(null as any), null);
      assert.strictEqual(sanitizeUrl(undefined as any), null);
    });

    test('rejects control characters', () => {
      assert.strictEqual(sanitizeUrl('https://evil.com\x00'), null);
    });

    test('rejects shell metacharacters', () => {
      assert.strictEqual(sanitizeUrl('https://evil.com; rm -rf /'), null);
      assert.strictEqual(sanitizeUrl('https://evil.com | cat /etc/passwd'), null);
      assert.strictEqual(sanitizeUrl('`whoami`.evil.com'), null);
      assert.strictEqual(sanitizeUrl('$(whoami).evil.com'), null);
    });

    test('rejects && operator', () => {
      assert.strictEqual(sanitizeUrl('https://evil.com && whoami'), null);
    });

    test('rejects argument injection', () => {
      assert.strictEqual(sanitizeUrl('--config-dir=/evil'), null);
    });

    test('rejects embedded credentials', () => {
      assert.strictEqual(sanitizeUrl('https://user:pass@evil.com'), null);
    });

    test('rejects non-http schemes', () => {
      assert.strictEqual(sanitizeUrl('ftp://evil.com'), null);
      assert.strictEqual(sanitizeUrl('file:///etc/passwd'), null);
    });

    test('accepts URL with query params (single &)', () => {
      assert.strictEqual(
        sanitizeUrl('https://api.example.com/v1?key=value&other=param'),
        'https://api.example.com/v1?key=value&other=param'
      );
    });

    test('logs warnings via provided logger', () => {
      const warnings: string[] = [];
      const logger = noopLogger();
      logger.warn = (msg: string) => warnings.push(msg);
      sanitizeUrl('', logger);
      assert.ok(warnings.length > 0);
    });
  });

  // ====================================================================
  // buildCommand (pure function)
  // ====================================================================
  suite('buildCommand (pure)', () => {
    test('builds basic command with task', () => {
      const cmd = buildCommand({ task: 'hello world' }, {
        existsSync: () => true,
        fallbackCwd: '/fallback',
      });
      assert.ok(cmd.commandString.includes('-p "hello world"'));
      assert.ok(cmd.commandString.includes('--stream off'));
      assert.ok(cmd.commandString.includes('--allow-all-tools'));
    });

    test('includes --config-dir when cwd is provided', () => {
      const cmd = buildCommand({ task: 'test', cwd: '/path/to/worktree' }, {
        existsSync: () => true,
      });
      assert.ok(cmd.commandString.includes('--config-dir'));
      assert.ok(cmd.commandString.includes('.orchestrator'));
      assert.ok(cmd.commandString.includes('.copilot-cli'));
    });

    test('includes --model when provided', () => {
      const cmd = buildCommand({ task: 'test', model: 'gpt-5' }, {
        existsSync: () => true,
      });
      assert.ok(cmd.commandString.includes('--model gpt-5'));
    });

    test('includes --resume when sessionId provided', () => {
      const cmd = buildCommand({ task: 'test', sessionId: 'sess-123' }, {
        existsSync: () => true,
      });
      assert.ok(cmd.commandString.includes('--resume sess-123'));
    });

    test('includes --log-dir and debug level', () => {
      const cmd = buildCommand({ task: 'test', logDir: '/logs' }, {
        existsSync: () => true,
      });
      assert.ok(cmd.commandString.includes('--log-dir') && cmd.commandString.includes('/logs'));
      assert.ok(cmd.commandString.includes('--log-level debug'));
    });

    test('includes --share when sharePath provided', () => {
      const cmd = buildCommand({ task: 'test', sharePath: '/share.md' }, {
        existsSync: () => true,
      });
      assert.ok(cmd.commandString.includes('--share') && cmd.commandString.includes('/share.md'));
    });

    test('uses fallbackCwd when no paths available', () => {
      const cmd = buildCommand({ task: 'test' }, {
        existsSync: () => false,
        fallbackCwd: '/my/fallback',
      });
      assert.ok(cmd.commandString.includes('--add-dir') && cmd.commandString.includes('/my/fallback'));
    });

    test('adds cwd as allowed path when it exists', () => {
      const cmd = buildCommand({ task: 'test', cwd: '/worktree' }, {
        existsSync: (p: string) => p.includes('worktree'),
      });
      assert.ok(cmd.commandString.includes('--add-dir'));
    });

    test('skips relative allowed folders', () => {
      const warnings: string[] = [];
      const logger = noopLogger();
      logger.warn = (msg: string) => warnings.push(msg);
      buildCommand(
        { task: 'test', allowedFolders: ['relative/path'] },
        { existsSync: () => true, logger, fallbackCwd: '/x' }
      );
      assert.ok(warnings.some(w => w.includes('relative')));
    });

    test('includes --allow-url for valid URLs', () => {
      const cmd = buildCommand(
        { task: 'test', allowedUrls: ['https://api.github.com'] },
        { existsSync: () => true, fallbackCwd: '/x' }
      );
      assert.ok(cmd.commandString.includes('--allow-url') && cmd.commandString.includes('https://api.github.com'));
    });

    test('filters out invalid URLs', () => {
      const cmd = buildCommand(
        { task: 'test', allowedUrls: ['https://valid.com', '$(evil)'] },
        { existsSync: () => true, fallbackCwd: '/x' }
      );
      assert.ok(cmd.commandString.includes('--allow-url') && cmd.commandString.includes('https://valid.com'));
      assert.ok(!cmd.commandString.includes('evil'));
    });

    test('accepts custom urlSanitizer', () => {
      const cmd = buildCommand(
        { task: 'test', allowedUrls: ['anything'] },
        { existsSync: () => true, fallbackCwd: '/x', urlSanitizer: () => 'https://fixed.com' }
      );
      assert.ok(cmd.commandString.includes('--allow-url') && cmd.commandString.includes('https://fixed.com'));
    });

    test('includes --effort when provided', () => {
      const cmd = buildCommand(
        { task: 'test', effort: 'high' },
        { existsSync: () => true, fallbackCwd: '/x' }
      );
      assert.ok(cmd.commandString.includes('--effort high'));
    });

    test('does not include --effort when not provided', () => {
      const cmd = buildCommand(
        { task: 'test' },
        { existsSync: () => true, fallbackCwd: '/x' }
      );
      assert.ok(!cmd.commandString.includes('--effort'));
    });

    test('includes --effort with low value', () => {
      const cmd = buildCommand(
        { task: 'test', effort: 'low' },
        { existsSync: () => true, fallbackCwd: '/x' }
      );
      assert.ok(cmd.commandString.includes('--effort low'));
    });

    test('includes --effort with medium value', () => {
      const cmd = buildCommand(
        { task: 'test', effort: 'medium' },
        { existsSync: () => true, fallbackCwd: '/x' }
      );
      assert.ok(cmd.commandString.includes('--effort medium'));
    });
  });

  // ====================================================================
  // CopilotCliRunner class with DI
  // ====================================================================
  suite('CopilotCliRunner constructor DI', () => {
    test('no-arg constructor works (backward compat)', () => {
      const runner = new CopilotCliRunner();
      assert.ok(runner);
    });

    test('accepts logger only', () => {
      const runner = new CopilotCliRunner(noopLogger());
      assert.ok(runner);
    });

    test('accepts all three DI params', () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env);
      assert.ok(runner);
    });

    test('buildCommand delegates to pure function with environment', () => {
      const env = createMockEnv({ cwd: () => '/env/cwd' });
      const runner = new CopilotCliRunner(noopLogger(), undefined, env);
      const cmd = runner.buildCommand({ task: 'hi' });
      // Should use the env's cwd as fallback
      assert.ok(cmd.commandString.includes('/env/cwd'));
    });

    test('sanitizeUrl delegates to pure function', () => {
      const runner = new CopilotCliRunner(noopLogger());
      assert.strictEqual(runner.sanitizeUrl('https://valid.com'), 'https://valid.com');
      assert.strictEqual(runner.sanitizeUrl(''), null);
    });
  });

  // ====================================================================
  // run() with mock spawner
  // ====================================================================
  suite('run() with mock spawner', () => {
    setup(() => {
      // Ensure isCopilotCliAvailable() returns true optimistically
      resetCliCache();
    });

    teardown(() => {
      resetCliCache();
    });

    test('successful run resolves with success', async () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'do something',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      // Simulate process exit
      setImmediate(() => proc.emit('exit', 0, null));

      const result = await resultPromise;
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
    });

    test('failed run resolves with error', async () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'fail',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      setImmediate(() => proc.emit('exit', 1, null));

      const result = await resultPromise;
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('captures session ID from stdout', async () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      setImmediate(() => {
        (proc.stdout as EventEmitter).emit('data', Buffer.from('Session ID: 12345678-1234-1234-1234-123456789012\n'));
        proc.emit('exit', 0, null);
      });

      const result = await resultPromise;
      assert.strictEqual(result.sessionId, '12345678-1234-1234-1234-123456789012');
    });

    test('calls onOutput callback', async () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;
      const lines: string[] = [];

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
        onOutput: (line) => lines.push(line),
      });

      setImmediate(() => {
        (proc.stdout as EventEmitter).emit('data', Buffer.from('hello world\n'));
        proc.emit('exit', 0, null);
      });

      await resultPromise;
      assert.ok(lines.includes('hello world'));
    });

    test('calls onProcess callback with proc', async () => {
      const proc = createFakeProcess(9999);
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;
      let capturedPid: number | undefined;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
        onProcess: (p) => { capturedPid = p.pid; },
      });

      setImmediate(() => proc.emit('exit', 0, null));
      await resultPromise;
      assert.strictEqual(capturedPid, 9999);
    });

    test('handles spawn error', async () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv();
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      setImmediate(() => proc.emit('error', new Error('spawn failed')));

      const result = await resultPromise;
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'spawn failed');
    });

    test('Windows null exit code with Task complete marker treated as success', async () => {
      const proc = createFakeProcess();
      const spawner = createMockSpawner(proc);
      const env = createMockEnv({ platform: 'win32' });
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      setImmediate(() => {
        (proc.stdout as EventEmitter).emit('data', Buffer.from('Task complete\n'));
        proc.emit('exit', null, null);
      });

      const result = await resultPromise;
      assert.strictEqual(result.success, true);
    });

    test('uses injected environment for clean env', async () => {
      const proc = createFakeProcess();
      let capturedEnv: Record<string, string | undefined> | undefined;
      const spawner: IProcessSpawner = {
        spawn: (_cmd, _args, opts) => {
          capturedEnv = opts.env as any;
          return proc;
        },
      };
      const env = createMockEnv({
        env: { HOME: '/test', NODE_OPTIONS: '--no-warnings', PATH: '/usr/bin' },
      });
      const runner = new CopilotCliRunner(noopLogger(), spawner, env, undefined, createMockManagedFactory());
      runner.isAvailable = () => true; runner.ensureAvailable = async () => true;

      const resultPromise = runner.run({
        cwd: '/worktree',
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      setImmediate(() => proc.emit('exit', 0, null));
      await resultPromise;

      assert.ok(capturedEnv);
      assert.strictEqual(capturedEnv!.NODE_OPTIONS, undefined, 'NODE_OPTIONS should be removed');
      assert.strictEqual(capturedEnv!.PATH, '/usr/bin');
    });
  });
});
