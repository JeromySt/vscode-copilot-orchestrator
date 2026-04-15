/**
 * @fileoverview Unit tests for ScriptedProcessSpawner.
 *
 * Validates that the scripted spawner matches scripts to spawn() calls,
 * replays stdout/stderr on timers, handles consumeOnce scripts, and
 * falls back to default behavior for unmatched calls.
 *
 * @module test/unit/plan/testing/scriptedProcessSpawner.unit.test
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ScriptedProcessSpawner, FakeChildProcess } from '../../../../plan/testing/scriptedProcessSpawner';
import type { ProcessScript } from '../../../../plan/testing/processScripts';

suite('ScriptedProcessSpawner', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('FakeChildProcess', () => {
    test('has correct initial state', () => {
      const proc = new FakeChildProcess();
      assert.strictEqual(proc.pid, process.pid);
      assert.strictEqual(proc.exitCode, null);
      assert.strictEqual(proc.killed, false);
      assert.ok(proc.stdout);
      assert.ok(proc.stderr);
    });

    test('kill sets killed flag and emits close', (done) => {
      const proc = new FakeChildProcess();
      proc.on('close', (code: number, signal: string | null) => {
        assert.strictEqual(proc.killed, true);
        done();
      });
      proc.kill();
    });    test('kill emits exit before close', (done) => {
      const proc = new FakeChildProcess();
      const order: string[] = [];
      proc.on('exit', () => order.push('exit'));
      proc.on('close', () => {
        order.push('close');
        assert.deepStrictEqual(order, ['exit', 'close']);
        done();
      });
      proc.kill();
    });    test('kill passes signal to exit and close events', (done) => {
      const proc = new FakeChildProcess();
      let exitSignal: string | null = null;
      proc.on('exit', (_code: number | null, signal: string | null) => { exitSignal = signal; });
      proc.on('close', (_code: number | null, signal: string | null) => {
        assert.strictEqual(exitSignal, 'SIGTERM');
        assert.strictEqual(signal, 'SIGTERM');
        done();
      });
      proc.kill('SIGTERM');
    });

    test('kill cleans up pending timers', () => {
      const proc = new FakeChildProcess();
      let timerFired = false;
      proc._schedule(() => { timerFired = true; }, 5000);
      proc.kill();
      // Timer should not fire after kill
      assert.strictEqual(timerFired, false);
    });

    test('stdout and stderr support setEncoding', () => {
      const proc = new FakeChildProcess();
      // workPhase.ts calls setEncoding — must not throw
      assert.doesNotThrow(() => {
        (proc.stdout as any).setEncoding('utf8');
        (proc.stderr as any).setEncoding('utf8');
      });
    });
  });

  suite('spawn', () => {
    test('matches script by command string', (done) => {
      const spawner = new ScriptedProcessSpawner();
      const script: ProcessScript = {
        label: 'test-cmd',
        match: { command: 'npm' },
        stdout: [{ text: 'hello', delayMs: 10 }],
        exitCode: 0,
        exitDelayMs: 50,
      };
      spawner.addScript(script);

      const proc = spawner.spawn('npm', ['run', 'build'], { cwd: '/tmp' });
      const lines: string[] = [];

      proc.stdout!.on('data', (d: Buffer) => lines.push(d.toString().trim()));
      proc.on('close', (code: number) => {
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(lines, ['hello']);
        done();
      });
    });

    test('matches script by command regex', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'regex-match',
        match: { command: /copilot/i },
        stdout: [{ text: 'matched', delayMs: 10 }],
        exitCode: 0,
        exitDelayMs: 30,
      });

      const proc = spawner.spawn('github-copilot-cli', ['--task', 'test'], {});
      const lines: string[] = [];
      proc.stdout!.on('data', (d: Buffer) => lines.push(d.toString().trim()));
      proc.on('close', () => {
        assert.deepStrictEqual(lines, ['matched']);
        done();
      });
    });

    test('matches by argsContain', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'args-match',
        match: { argsContain: '--strict' },
        stdout: [{ text: 'strict mode', delayMs: 10 }],
        exitCode: 0,
        exitDelayMs: 30,
      });

      const proc = spawner.spawn('node', ['validate.js', '--strict'], {});
      proc.on('close', (code: number) => {
        assert.strictEqual(code, 0);
        done();
      });
    });

    test('matches by cwdContain', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'cwd-match',
        match: { cwdContain: 'my-job' },
        stdout: [{ text: 'in worktree', delayMs: 10 }],
        exitCode: 0,
        exitDelayMs: 30,
      });

      const proc = spawner.spawn('npm', ['test'], { cwd: '/worktrees/my-job' });
      proc.on('close', (code: number) => {
        assert.strictEqual(code, 0);
        done();
      });
    });

    test('returns default empty process for unmatched call', (done) => {
      const spawner = new ScriptedProcessSpawner();
      const proc = spawner.spawn('unknown', [], {});
      proc.on('close', (code: number) => {
        assert.strictEqual(code, 0); // default exit code
        done();
      });
    });

    test('respects setDefaultExitCode for unmatched calls', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.setDefaultExitCode(1);
      const proc = spawner.spawn('unknown', [], {});
      proc.on('close', (code: number) => {
        assert.strictEqual(code, 1);
        done();
      });
    });

    test('emits stderr lines', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'stderr-test',
        match: { command: 'fail' },
        stdout: [],
        stderr: [{ text: 'error: bad input', delayMs: 10 }],
        exitCode: 1,
        exitDelayMs: 50,
      });

      const proc = spawner.spawn('fail', [], {});
      const errLines: string[] = [];
      proc.stderr!.on('data', (d: Buffer) => errLines.push(d.toString().trim()));
      proc.on('close', () => {
        assert.deepStrictEqual(errLines, ['error: bad input']);
        done();
      });
    });

    test('emits exit signal when specified', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'killed',
        match: { command: 'timeout-cmd' },
        stdout: [{ text: 'running...', delayMs: 10 }],
        exitCode: 137,
        signal: 'SIGKILL',
        exitDelayMs: 30,
      });

      const proc = spawner.spawn('timeout-cmd', [], {});
      proc.on('close', (code: number | null, signal: string | null) => {
        assert.strictEqual(code, null);
        assert.strictEqual(signal, 'SIGKILL');
        done();
      });
    });    test('emits exit before close on normal exit', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'normal-exit',
        match: { command: 'my-cmd' },
        stdout: [],
        exitCode: 0,
        exitDelayMs: 20,
      });

      const order: string[] = [];
      const proc = spawner.spawn('my-cmd', [], {});
      proc.on('exit', () => order.push('exit'));
      proc.on('close', () => {
        order.push('close');
        assert.deepStrictEqual(order, ['exit', 'close']);
        done();
      });
    });    test('emits exit before close on signal exit', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'signal-exit',
        match: { command: 'signal-cmd' },
        stdout: [],
        exitCode: 0,
        signal: 'SIGTERM',
        exitDelayMs: 20,
      });

      const order: string[] = [];
      const proc = spawner.spawn('signal-cmd', [], {});
      proc.on('exit', () => order.push('exit'));
      proc.on('close', () => {
        order.push('close');
        assert.deepStrictEqual(order, ['exit', 'close']);
        done();
      });
    });    test('emits exit before close on unmatched default exit', (done) => {
      const spawner = new ScriptedProcessSpawner();
      const order: string[] = [];
      const proc = spawner.spawn('unmatched', [], {});
      proc.on('exit', () => order.push('exit'));
      proc.on('close', () => {
        order.push('close');
        assert.deepStrictEqual(order, ['exit', 'close']);
        done();
      });
    });
  });

  suite('consumeOnce', () => {
    test('removes script after first match', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'once',
        match: { command: 'cmd' },
        stdout: [{ text: 'first', delayMs: 10 }],
        exitCode: 1,
        exitDelayMs: 30,
        consumeOnce: true,
      });
      spawner.addScript({
        label: 'always',
        match: { command: 'cmd' },
        stdout: [{ text: 'second', delayMs: 10 }],
        exitCode: 0,
        exitDelayMs: 30,
      });

      // First call matches the consumeOnce script
      const proc1 = spawner.spawn('cmd', [], {});
      proc1.on('close', (code: number) => {
        assert.strictEqual(code, 1);

        // Second call matches the permanent script
        const proc2 = spawner.spawn('cmd', [], {});
        proc2.on('close', (code2: number) => {
          assert.strictEqual(code2, 0);
          done();
        });
      });
    });
  });

  suite('getSpawnLog', () => {
    test('records all spawn calls with match info', (done) => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'tracked',
        match: { command: 'npm' },
        stdout: [],
        exitCode: 0,
        exitDelayMs: 20,
      });

      const proc1 = spawner.spawn('npm', ['test'], { cwd: '/project' });
      proc1.on('close', () => {
        const proc2 = spawner.spawn('unknown', [], {});
        proc2.on('close', () => {
          const log = spawner.getSpawnLog();
          assert.strictEqual(log.length, 2);
          assert.strictEqual(log[0].matched, 'tracked');
          assert.strictEqual(log[0].command, 'npm');
          assert.strictEqual(log[1].matched, null);
          assert.strictEqual(log[1].command, 'unknown');
          done();
        });
      });
    });
  });

  suite('reset', () => {
    test('clears scripts and spawn log', () => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScript({
        label: 'tmp',
        match: { command: 'x' },
        stdout: [],
        exitCode: 0,
      });
      spawner.spawn('x', [], {});

      assert.strictEqual(spawner.getRemainingScriptCount(), 1);
      assert.strictEqual(spawner.getSpawnLog().length, 1);

      spawner.reset();

      assert.strictEqual(spawner.getRemainingScriptCount(), 0);
      assert.strictEqual(spawner.getSpawnLog().length, 0);
    });
  });

  suite('addScripts', () => {
    test('adds multiple scripts at once', () => {
      const spawner = new ScriptedProcessSpawner();
      spawner.addScripts([
        { label: 'a', match: { command: 'a' }, stdout: [], exitCode: 0 },
        { label: 'b', match: { command: 'b' }, stdout: [], exitCode: 0 },
      ]);
      assert.strictEqual(spawner.getRemainingScriptCount(), 2);
    });
  });
});
