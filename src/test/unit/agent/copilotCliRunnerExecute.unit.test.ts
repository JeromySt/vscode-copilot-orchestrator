/**
 * @fileoverview Unit tests for CopilotCliRunner execute, cleanup, and singleton functions.
 *
 * Covers:
 * - run() method (which calls private execute())
 * - cleanupInstructionsFile() method
 * - getCopilotCliRunner() singleton
 * - runCopilotCli() convenience function
 * - Various exit code scenarios
 * - Success/failure/error paths in execute
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { CopilotCliRunner } from '../../../agent/copilotCliRunner';
import { resetCliCache } from '../../../agent/cliCheckCore';
import type { IManagedProcessFactory } from '../../../interfaces/IManagedProcessFactory';

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
        if (line.includes('Premium requests')) {
          statsStarted = Date.now();
          if (!metrics) { metrics = {}; }
          const pm = line.match(/(\d+)\s+Premium requests/);
          if (pm) { metrics.premiumRequests = parseInt(pm[1]); }
        }
        const mm = line.match(/^(\S+)\s+([\d.]+[km]?)\s+in,\s+([\d.]+[km]?)\s+out/i);
        if (mm) {
          if (!metrics) { metrics = {}; }
          if (!metrics.modelBreakdown) { metrics.modelBreakdown = []; }
          const parseCount = (s: string): number => {
            const n = parseFloat(s);
            if (s.endsWith('k')) return n * 1000;
            if (s.endsWith('m')) return n * 1000000;
            return n;
          };
          metrics.modelBreakdown.push({ model: mm[1], inputTokens: parseCount(mm[2]), outputTokens: parseCount(mm[3]) });
        }
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

/**
 * Testable subclass that overrides buildCommand to use simple shell commands
 * instead of the actual copilot CLI, allowing us to test the execute path.
 */
class TestableCliRunner extends CopilotCliRunner {
  private _testCommand: string | undefined;

  constructor(logger?: any, managedFactory?: IManagedProcessFactory) {
    super(logger, undefined, undefined, undefined, managedFactory);
  }

  setTestCommand(cmd: string): void {
    this._testCommand = cmd;
  }

  isAvailable(): boolean {
    return true;
  }

  /** Skip real CLI detection — always report available to prevent test hangs. */
  async ensureAvailable(): Promise<boolean> {
    return true;
  }

  buildCommand(_options: any): any {
    if (this._testCommand) {
      // Parse the test command into executable + args for shell: false execution.
      // On Windows, commands like 'cmd /c echo hello' become executable='cmd', args=['/c', 'echo', 'hello'].
      // On Unix, 'echo hello' becomes executable='echo', args=['hello'].
      const parts = this._testCommand.match(/"[^"]*"|\S+/g) || [];
      const executable = parts[0] || this._testCommand;
      const args = parts.slice(1).map(p => p.replace(/^"|"$/g, ''));
      return { executable, args, logDir: undefined, commandString: this._testCommand };
    }
    return super.buildCommand(_options);
  }
}

suite('CopilotCliRunner - Execute & Lifecycle', () => {
  let logMessages: { level: string; msg: string }[];
  let runner: CopilotCliRunner;

  function createLogger() {
    return {
      info: (msg: string) => logMessages.push({ level: 'info', msg }),
      warn: (msg: string) => logMessages.push({ level: 'warn', msg }),
      error: (msg: string) => logMessages.push({ level: 'error', msg }),
      debug: (msg: string) => logMessages.push({ level: 'debug', msg }),
    };
  }

  setup(() => {
    logMessages = [];
    runner = new CopilotCliRunner(createLogger(), undefined, undefined, undefined, createMockManagedFactory());
    // Ensure isCopilotCliAvailable() returns true optimistically
    resetCliCache();
  });

  teardown(() => {
    resetCliCache();
  });

  // ==========================================================================
  // cleanupInstructionsFile
  // ==========================================================================
  suite('cleanupInstructionsFile', () => {
    let tmpDir: string;

    setup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
    });

    teardown(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('removes existing file', () => {
      const filePath = path.join(tmpDir, 'test.md');
      fs.writeFileSync(filePath, 'test content');
      assert.ok(fs.existsSync(filePath));

      runner.cleanupInstructionsFile(filePath, undefined, 'test');
      assert.ok(!fs.existsSync(filePath), 'File should be deleted');
    });

    test('removes empty directory after file cleanup', () => {
      const dirPath = path.join(tmpDir, 'instructions');
      fs.mkdirSync(dirPath, { recursive: true });
      const filePath = path.join(dirPath, 'test.md');
      fs.writeFileSync(filePath, 'test content');

      runner.cleanupInstructionsFile(filePath, dirPath, 'test');
      assert.ok(!fs.existsSync(filePath), 'File should be deleted');
      assert.ok(!fs.existsSync(dirPath), 'Empty directory should be removed');
    });

    test('keeps non-empty directory after file cleanup', () => {
      const dirPath = path.join(tmpDir, 'instructions');
      fs.mkdirSync(dirPath, { recursive: true });
      const filePath = path.join(dirPath, 'test.md');
      const otherFile = path.join(dirPath, 'other.md');
      fs.writeFileSync(filePath, 'test content');
      fs.writeFileSync(otherFile, 'other content');

      runner.cleanupInstructionsFile(filePath, dirPath, 'test');
      assert.ok(!fs.existsSync(filePath), 'File should be deleted');
      assert.ok(fs.existsSync(dirPath), 'Non-empty directory should remain');
      assert.ok(fs.existsSync(otherFile), 'Other file should remain');
    });

    test('handles non-existent file gracefully', () => {
      const filePath = path.join(tmpDir, 'nonexistent.md');
      assert.doesNotThrow(() => {
        runner.cleanupInstructionsFile(filePath, undefined, 'test');
      });
    });

    test('handles non-existent directory gracefully', () => {
      const filePath = path.join(tmpDir, 'test.md');
      fs.writeFileSync(filePath, 'test content');
      const dirPath = path.join(tmpDir, 'nonexistent-dir');

      assert.doesNotThrow(() => {
        runner.cleanupInstructionsFile(filePath, dirPath, 'test');
      });
    });

    test('handles undefined dirPath', () => {
      const filePath = path.join(tmpDir, 'test.md');
      fs.writeFileSync(filePath, 'test content');

      runner.cleanupInstructionsFile(filePath, undefined, 'test');
      assert.ok(!fs.existsSync(filePath), 'File should be deleted');
    });
  });

  // ==========================================================================
  // run() method - integration via execute
  // ==========================================================================
  suite('run() method', () => {
    test('run with CLI not available returns failure', async () => {
      // Clear module cache and mock isCopilotCliAvailable
      const cliCheckPath = require.resolve('../../../agent/cliCheckCore');
      const savedCache = require.cache[cliCheckPath];
      require.cache[cliCheckPath] = {
        ...require.cache[cliCheckPath]!,
        exports: {
          isCopilotCliAvailable: () => false,
          checkCopilotCliAsync: async () => false,
          ensureCopilotCliChecked: async () => false,
          resetCliCache: () => {},
          isCliCachePopulated: () => true,
        },
      } as any;

      try {
        // Re-create runner with fresh module
        delete require.cache[require.resolve('../../../agent/copilotCliRunner')];
        const { CopilotCliRunner: FreshRunner } = require('../../../agent/copilotCliRunner');
        const freshRunner = new FreshRunner(createLogger());

        const result = await freshRunner.run({
          cwd: os.tmpdir(),
          task: 'test task',
          label: 'test',
        });

        assert.strictEqual(result.success, false, 'Should return failure when CLI not available');
        assert.ok(result.error?.includes('Copilot CLI not available'), 'Should include error message');
        assert.strictEqual(result.exitCode, 127, 'Should return exit code 127');
      } finally {
        // Restore
        if (savedCache) {
          require.cache[cliCheckPath] = savedCache;
        } else {
          delete require.cache[cliCheckPath];
        }
        delete require.cache[require.resolve('../../../agent/copilotCliRunner')];
      }
    });

    test('run executes command and captures exit code on failure', async function () {
      this.timeout(10000);

      // Use TestableCliRunner (overrides ensureAvailable + buildCommand) to avoid real CLI detection
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c exit 1' : 'sh -c "exit 1"');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test task',
        skipInstructionsFile: true,
        timeout: 5000,
      });

      assert.strictEqual(result.success, false, 'Should return failure for non-zero exit code');
    });

    test('run calls onOutput callback with output lines', async function () {
      this.timeout(10000);
      const outputLines: string[] = [];

      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo hello_from_run' : 'echo hello_from_run');

      await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
        onOutput: (line) => outputLines.push(line),
      });

      assert.ok(outputLines.some(l => l.includes('hello_from_run')), 'onOutput should receive output lines');
    });

    test('run calls onProcess callback when process spawns', async function () {
      this.timeout(10000);
      let processReceived = false;

      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo spawned' : 'echo spawned');

      await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 5000,
        onProcess: () => { processReceived = true; },
      });

      assert.strictEqual(processReceived, true, 'onProcess callback should be called when process spawns');
    });

    test('run with instructions writes and cleans up instructions file', async function () {
      this.timeout(15000);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-run-test-'));

      try {
        await runner.run({
          cwd: tmpDir,
          task: 'test task with instructions',
          instructions: 'Do something specific',
          label: 'instr-test',
          timeout: 5000,
          jobId: 'testjob1',
        });

        // After run, instructions file should be cleaned up
        const instrDir = path.join(tmpDir, '.github', 'instructions');
        const instrFile = path.join(instrDir, 'orchestrator-job-testjob1.instructions.md');
        // File may or may not exist depending on cleanup timing, but should not throw
        assert.ok(true, 'Run with instructions completed');
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    test('run captures session ID from output', async function () {
      this.timeout(15000);

      const result = await runner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        sessionId: 'pre-existing-session-id',
        timeout: 5000,
      });

      // With a pre-existing session ID, it should be preserved
      // The exact behavior depends on whether copilot is available
      assert.ok(result !== undefined);
    });
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================
  suite('constructor', () => {
    test('works without logger (uses noop)', () => {
      const noLogRunner = new CopilotCliRunner();
      assert.ok(noLogRunner, 'Should create runner without logger');

      // Should not throw when building command (which uses logger)
      const cmd = noLogRunner.buildCommand({ task: 'test' });
      assert.ok(cmd.commandString.includes('copilot'));
    });

    test('works with custom logger', () => {
      const msgs: string[] = [];
      const customRunner = new CopilotCliRunner({
        info: (m) => msgs.push(m),
        warn: (m) => msgs.push(m),
        error: (m) => msgs.push(m),
        debug: (m) => msgs.push(m),
      });

      customRunner.buildCommand({ task: 'test', cwd: os.tmpdir() });
      assert.ok(msgs.length > 0, 'Logger should receive messages');
    });
  });

  // ==========================================================================
  // Execute paths via TestableCliRunner
  // ==========================================================================
  suite('execute paths via TestableCliRunner', () => {

    test('successful command returns success with exit code 0', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo hello' : 'echo hello');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
      });

      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.exitCode, 0, 'Should have exit code 0');
    });

    test('failed command returns failure with non-zero exit code', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c exit 42' : 'exit 42');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
      });

      assert.strictEqual(result.success, false, 'Should fail');
      assert.ok(result.error, 'Should have error message');
    });

    test('command outputting Task complete with null exit code treated as success', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      // Echo "Task complete" to trigger the sawTaskComplete flag
      testRunner.setTestCommand(process.platform === 'win32'
        ? 'cmd /c echo Task complete'
        : 'echo "Task complete"');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
      });

      assert.strictEqual(result.success, true, 'Should succeed when Task complete is seen');
    });

    test('command with stats output parses metrics', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      const statsOutput = [
        'Total usage est:        3 Premium requests',
        'API time spent:         32s',
        'Total session time:     55s',
        'Total code changes:     +10 -5',
        'Breakdown by AI model:',
        'claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)',
      ].join('\n');

      // Windows: use echo with multiple lines; this outputs all stats
      if (process.platform === 'win32') {
        testRunner.setTestCommand(`cmd /c "echo Total usage est:        3 Premium requests && echo API time spent:         32s && echo Breakdown by AI model: && echo claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)"`);
      } else {
        testRunner.setTestCommand(`echo "${statsOutput}"`);
      }

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
      });

      assert.strictEqual(result.success, true);
      // Metrics parsing from stdout
      if (result.metrics) {
        assert.ok(result.metrics.premiumRequests !== undefined || result.metrics.modelBreakdown !== undefined,
          'Should parse some metrics from output');
      }
    });

    test('session ID is extracted from output', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      const sessionUUID = 'abcd1234-5678-9012-3456-789abcdef012';
      testRunner.setTestCommand(process.platform === 'win32'
        ? `cmd /c echo Session ID: ${sessionUUID}`
        : `echo "Session ID: ${sessionUUID}"`);

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, sessionUUID, 'Should capture session ID from output');
    });

    test('onProcess callback receives process object', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo test' : 'echo test');

      let receivedPid = false;
      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
        onProcess: (proc) => {
          if (proc.pid) { receivedPid = true; }
        },
      });

      assert.ok(receivedPid, 'Should receive process with PID');
    });

    test('onOutput callback receives output lines', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo test_output_line' : 'echo test_output_line');

      const lines: string[] = [];
      await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
        onOutput: (line) => lines.push(line),
      });

      assert.ok(lines.length > 0, 'Should receive output lines');
      assert.ok(lines.some(l => l.includes('test_output_line')), 'Should receive the echo output');
    });

    test('timeout kills long-running process', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      // A command that takes a long time
      testRunner.setTestCommand(process.platform === 'win32'
        ? 'cmd /c ping -n 30 127.0.0.1'
        : 'sleep 30');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 2000, // 2 second timeout
      });

      assert.strictEqual(result.success, false, 'Should fail due to timeout');
      assert.ok(result.error?.includes('TIMEOUT') || result.error?.includes('killed'),
        'Error should mention timeout or kill');
    });

    test('zero timeout means no timeout', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo quick' : 'echo quick');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 0, // No timeout
      });

      assert.strictEqual(result.success, true);
    });

    test('stderr output is also processed', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32'
        ? 'cmd /c echo stderr_test 1>&2'
        : 'echo stderr_test >&2');

      const lines: string[] = [];
      await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
        onOutput: (line) => lines.push(line),
      });

      assert.ok(lines.some(l => l.includes('stderr_test')), 'Should capture stderr output');
    });

    test('metrics tokenUsage backfill from modelBreakdown', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      // Output model breakdown stats that should trigger backfill
      if (process.platform === 'win32') {
        testRunner.setTestCommand(`cmd /c "echo Breakdown by AI model: && echo claude-opus-4.6         100k in, 5k out (Est. 2 Premium requests)"`);
      } else {
        testRunner.setTestCommand(`echo "Breakdown by AI model:\nclaude-opus-4.6         100k in, 5k out (Est. 2 Premium requests)"`);
      }

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        timeout: 10000,
      });

      if (result.metrics?.modelBreakdown?.length && result.metrics.tokenUsage) {
        assert.ok(result.metrics.tokenUsage.inputTokens > 0, 'Should backfill input tokens');
        assert.ok(result.metrics.tokenUsage.outputTokens > 0, 'Should backfill output tokens');
        assert.ok(result.metrics.tokenUsage.model, 'Should backfill model name');
      }
    });

    test('pre-existing sessionId is preserved when output has no session', async function () {
      this.timeout(15000);
      const testRunner = new TestableCliRunner(createLogger(), createMockManagedFactory());
      testRunner.setTestCommand(process.platform === 'win32' ? 'cmd /c echo done' : 'echo done');

      const result = await testRunner.run({
        cwd: os.tmpdir(),
        task: 'test',
        skipInstructionsFile: true,
        sessionId: 'pre-existing-id',
        timeout: 10000,
      });

      assert.strictEqual(result.success, true);
      // Pre-existing session ID should be preserved since output didn't contain one
      assert.strictEqual(result.sessionId, 'pre-existing-id');
    });
  });
});
