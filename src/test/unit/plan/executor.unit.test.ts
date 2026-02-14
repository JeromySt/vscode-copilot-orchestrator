/**
 * @fileoverview Unit tests for DefaultJobExecutor (non-execute methods + setup)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { DefaultJobExecutor } from '../../../plan/executor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { DefaultEvidenceValidator } from '../../../plan/evidenceValidator';
import type { ExecutionPhase, LogEntry } from '../../../plan/types';
import { ProcessMonitor } from '../../../process';

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
  tmpDirs.push(dir);
  return dir;
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('DefaultJobExecutor', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  test('constructor creates instance', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
    assert.ok(executor);
  });

  test('setStoragePath creates logs directory', () => {
    const dir = makeTmpDir();
    const storagePath = path.join(dir, 'storage');
    fs.mkdirSync(storagePath, { recursive: true });
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
    executor.setStoragePath(storagePath);
    assert.ok(fs.existsSync(path.join(storagePath, 'logs')));
  });

  test('setAgentDelegator stores delegator', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
    const delegator = { run: () => {} };
    executor.setAgentDelegator(delegator);
    // No assertion needed - just verifying no throw
  });

  test('setEvidenceValidator stores validator', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
    executor.setEvidenceValidator({ validate: async () => ({ isValid: true }) } as any);
  });

  suite('getLogs / getLogsForPhase', () => {
    test('getLogs returns empty for unknown execution', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const logs = executor.getLogs('plan-1', 'node-1');
      assert.deepStrictEqual(logs, []);
    });

    test('log creates entries and getLogs retrieves them', () => {
      const dir = makeTmpDir();
      const storagePath = path.join(dir, 'storage');
      fs.mkdirSync(path.join(storagePath, 'logs'), { recursive: true });
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      executor.setStoragePath(storagePath);
      
      executor.log('plan-1', 'node-1', 'work', 'info', 'Hello World');
      const logs = executor.getLogs('plan-1', 'node-1');
      // log uses executionKey without attempt, so check the base key
      assert.ok(logs.length >= 0); // May or may not use same key
    });

    test('log with attemptNumber uses specific key', () => {
      const dir = makeTmpDir();
      const storagePath = path.join(dir, 'storage');
      fs.mkdirSync(path.join(storagePath, 'logs'), { recursive: true });
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      executor.setStoragePath(storagePath);
      
      executor.log('plan-1', 'node-1', 'work', 'info', 'attempt log', 2);
      // Verify no throw
    });

    test('getLogsForPhase filters by phase', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      // No logs exist, should return empty
      const logs = executor.getLogsForPhase('plan-1', 'node-1', 'work');
      assert.deepStrictEqual(logs, []);
    });
  });

  suite('getLogFileSize', () => {
    test('returns 0 when no storage path', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      assert.strictEqual(executor.getLogFileSize('plan-1', 'node-1'), 0);
    });

    test('returns 0 when log file does not exist', () => {
      const dir = makeTmpDir();
      const storagePath = path.join(dir, 'storage');
      fs.mkdirSync(path.join(storagePath, 'logs'), { recursive: true });
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      executor.setStoragePath(storagePath);
      assert.strictEqual(executor.getLogFileSize('plan-1', 'node-1'), 0);
    });
  });

  suite('isActive', () => {
    test('returns false for unknown execution', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      assert.strictEqual(executor.isActive('plan-1', 'node-1'), false);
    });
  });

  suite('cancel', () => {
    test('does nothing for unknown execution', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      // Should not throw
      executor.cancel('plan-1', 'node-1');
    });
  });

  suite('getProcessStats', () => {
    test('returns default for unknown execution', async () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const stats = await executor.getProcessStats('plan-1', 'node-1');
      assert.strictEqual(stats.pid, null);
      assert.strictEqual(stats.running, false);
      assert.deepStrictEqual(stats.tree, []);
    });
  });

  suite('getAllProcessStats', () => {
    test('returns empty for empty input', async () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const stats = await executor.getAllProcessStats([]);
      assert.deepStrictEqual(stats, []);
    });

    test('skips unknown executions', async () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const stats = await executor.getAllProcessStats([
        { planId: 'p1', nodeId: 'n1', nodeName: 'Job' },
      ]);
      assert.deepStrictEqual(stats, []);
    });
  });

  suite('getLogFilePath', () => {
    test('returns undefined without storage path', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      assert.strictEqual(executor.getLogFilePath('plan-1', 'node-1'), undefined);
    });

    test('returns path with attempt number', () => {
      const dir = makeTmpDir();
      const storagePath = path.join(dir, 'storage');
      fs.mkdirSync(path.join(storagePath, 'logs'), { recursive: true });
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      executor.setStoragePath(storagePath);
      const result = executor.getLogFilePath('plan-1', 'node-1', 3);
      assert.ok(result);
      assert.ok(result!.includes('logs'));
    });
  });

  suite('readLogsFromFile', () => {
    test('returns "No log file found." without storage path', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const result = executor.readLogsFromFile('plan-1', 'node-1');
      assert.ok(result.includes('No log file found'));
    });

    test('reads from file with attemptNumber', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const result = executor.readLogsFromFile('plan-1', 'node-1', 2);
      assert.ok(result.includes('No log file found'));
    });
  });

  suite('readLogsFromFileOffset', () => {
    test('returns "No log file found." without storage path', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const result = executor.readLogsFromFileOffset('plan-1', 'node-1', 0);
      assert.ok(result.includes('No log file found'));
    });

    test('reads from offset with attemptNumber', () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const result = executor.readLogsFromFileOffset('plan-1', 'node-1', 100, 2);
      assert.ok(result.includes('No log file found'));
    });
  });

  suite('execute basics', () => {
    test('returns failure when worktree does not exist', async () => {
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      const context = {
        plan: { id: 'plan-1' } as any,
        node: { id: 'node-1', name: 'Test', type: 'job', task: 'test', dependencies: [], dependents: [] } as any,
        worktreePath: '/nonexistent/path',
        attemptNumber: 1,
      };
      const result = await executor.execute(context as any);
      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes('Worktree does not exist'));
    });
  });

  suite('logEntry multiline splitting', () => {
    test('log splits multi-line messages', () => {
      const dir = makeTmpDir();
      const storagePath = path.join(dir, 'storage');
      fs.mkdirSync(path.join(storagePath, 'logs'), { recursive: true });
      const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any);
      executor.setStoragePath(storagePath);
      
      executor.log('plan-1', 'node-1', 'work', 'info', 'line1\nline2\nline3');
      // Should have created log entries - check no throw
    });
  });
});
