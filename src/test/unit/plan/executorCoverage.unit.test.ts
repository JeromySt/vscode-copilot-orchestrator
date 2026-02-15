/**
 * @fileoverview Unit tests for DefaultJobExecutor - coverage gaps (error paths)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { DefaultJobExecutor } from '../../../plan/executor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';
import { DefaultEvidenceValidator } from '../../../plan/evidenceValidator';
import { ProcessMonitor } from '../../../process';
import { WorkPhaseExecutor } from '../../../plan/phases/workPhase';
import { PostcheckPhaseExecutor } from '../../../plan/phases/postcheckPhase';
import { Logger } from '../../../core/logger';
import type { JobNode, ExecutionContext, JobExecutionResult } from '../../../plan/types';
import type { ICopilotRunner } from '../../../interfaces/ICopilotRunner';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-coverage-test-'));
  tmpDirs.push(dir);
  return dir;
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// Mock logger that captures calls
function createMockLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
    debug: (msg: string) => messages.push(`DEBUG: ${msg}`)
  } as any;
}

suite('DefaultJobExecutor Coverage - Error Paths', () => {
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

  test('execute handles work phase failure (line 140)', async () => {
    const dir = makeTmpDir();
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    executor.setStoragePath(dir);

    // Mock work phase to fail
    sandbox.stub(WorkPhaseExecutor.prototype, 'execute').resolves({
      success: false,
      error: 'Work failed test',
      exitCode: 1
    } as JobExecutionResult);

    const mockPlan = { id: 'test-plan', nodes: [] } as any;
    const mockNode: JobNode = {
      id: 'test-node',
      producerId: 'test-producer',
      name: 'Test Node',
      type: 'job',
      task: 'Test task',
      work: 'echo test',
      postchecks: undefined,
      dependencies: [],
      dependents: []
    };

    const mockContext: ExecutionContext = {
      plan: mockPlan,
      node: mockNode,
      baseCommit: 'abc123',
      worktreePath: dir,
      attemptNumber: 1,
      onProgress: () => {},
      onStepStatusChange: () => {}
    };

    const result = await executor.execute(mockContext);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Work failed'));
    assert.strictEqual(result.failedPhase, 'work');
    assert.strictEqual(result.exitCode, 1);
  });

  test('execute handles postchecks failure (line 160)', async () => {
    const dir = makeTmpDir();
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    executor.setStoragePath(dir);

    // Mock work phase to succeed
    sandbox.stub(WorkPhaseExecutor.prototype, 'execute').resolves({
      success: true
    } as JobExecutionResult);

    // Mock postchecks phase to fail
    sandbox.stub(PostcheckPhaseExecutor.prototype, 'execute').resolves({
      success: false,
      error: 'Postchecks failed test',
      exitCode: 2
    } as JobExecutionResult);

    const mockPlan = { id: 'test-plan', nodes: [] } as any;
    const mockNode: JobNode = {
      id: 'test-node',
      producerId: 'test-producer',
      name: 'Test Node',
      type: 'job',
      task: 'Test task with postchecks',
      work: 'echo test',
      postchecks: 'echo postcheck',
      dependencies: [],
      dependents: []
    };

    const mockContext: ExecutionContext = {
      plan: mockPlan,
      node: mockNode,
      baseCommit: 'abc123',
      worktreePath: dir,
      attemptNumber: 1,
      onProgress: () => {},
      onStepStatusChange: () => {}
    };

    const result = await executor.execute(mockContext);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Postchecks failed'));
    assert.strictEqual(result.failedPhase, 'postchecks');
    assert.strictEqual(result.exitCode, 2);
  });

  test('cancel handles Windows process termination (lines 202-205)', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    const logger = createMockLogger();
    
    // Mock Windows platform
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    
    // Stub spawn to capture taskkill call
    const spawnStub = sandbox.stub(require('child_process'), 'spawn');
    
    // Mock an active execution with process
    const planId = 'test-plan';
    const nodeId = 'test-node';
    const executionKey = `${planId}:${nodeId}`;
    const nodeKey = `${planId}:${nodeId}`;
    const mockProcess = { pid: 12345 };
    
    // Set up executor state properly
    (executor as any).activeExecutions.set(executionKey, {
      aborted: false,
      process: mockProcess
    });
    (executor as any).activeExecutionsByNode.set(nodeKey, executionKey);

    try {
      executor.cancel(planId, nodeId);
      
      // Verify taskkill was called with correct args
      assert.ok(spawnStub.calledOnce);
      const [cmd, args] = spawnStub.firstCall.args;
      assert.strictEqual(cmd, 'taskkill');
      assert.deepStrictEqual(args, ['/pid', '12345', '/f', '/t']);
      
      // Verify execution was marked as aborted
      const execution = (executor as any).activeExecutions.get(executionKey);
      assert.strictEqual(execution.aborted, true);
      
    } finally {
      // Restore platform
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  test('cancel handles Unix process termination (lines 202-205)', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    
    // Mock Unix platform
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    
    // Mock an active execution with process
    const planId = 'test-plan';
    const nodeId = 'test-node';
    const executionKey = `${planId}:${nodeId}`;
    const nodeKey = `${planId}:${nodeId}`;
    const mockProcess = { 
      pid: 12345,
      kill: sandbox.stub()
    };
    
    // Set up executor state properly
    (executor as any).activeExecutions.set(executionKey, {
      aborted: false,
      process: mockProcess
    });
    (executor as any).activeExecutionsByNode.set(nodeKey, executionKey);

    try {
      executor.cancel(planId, nodeId);
      
      // Verify kill was called with SIGTERM
      assert.ok(mockProcess.kill.calledOnce);
      assert.strictEqual(mockProcess.kill.firstCall.args[0], 'SIGTERM');
      
      // Verify execution was marked as aborted
      const execution = (executor as any).activeExecutions.get(executionKey);
      assert.strictEqual(execution.aborted, true);
      
    } finally {
      // Restore platform
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  test('cancel handles process kill exception gracefully (lines 204-205)', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    
    // Mock an active execution with process that throws on kill
    const planId = 'test-plan';
    const nodeId = 'test-node';
    const executionKey = `${planId}:${nodeId}`;
    const nodeKey = `${planId}:${nodeId}`;
    const mockProcess = { 
      pid: 12345,
      kill: () => { throw new Error('Process not found'); }
    };
    
    // Set up executor state properly
    (executor as any).activeExecutions.set(executionKey, {
      aborted: false,
      process: mockProcess
    });
    (executor as any).activeExecutionsByNode.set(nodeKey, executionKey);

    // Should not throw despite process.kill throwing
    assert.doesNotThrow(() => {
      executor.cancel(planId, nodeId);
    });
    
    // Verify execution was still marked as aborted
    const execution = (executor as any).activeExecutions.get(executionKey);
    assert.strictEqual(execution.aborted, true);
  });

  test('cancel with no active execution (edge case)', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    
    // Should not throw when no execution exists
    assert.doesNotThrow(() => {
      executor.cancel('nonexistent-plan', 'nonexistent-node');
    });
  });

  test('cancel with execution but no process (edge case)', () => {
    const executor = new DefaultJobExecutor(new DefaultProcessSpawner(), new DefaultEvidenceValidator(), new ProcessMonitor(new DefaultProcessSpawner()), {} as any, mockCopilotRunner);
    
    // Mock an active execution without process
    const planId = 'test-plan';
    const nodeId = 'test-node';
    const executionKey = `${planId}:${nodeId}`;
    const nodeKey = `${planId}:${nodeId}`;
    
    // Set up executor state properly
    (executor as any).activeExecutions.set(executionKey, {
      aborted: false,
      process: undefined
    });
    (executor as any).activeExecutionsByNode.set(nodeKey, executionKey);

    // Should not throw when no process exists
    assert.doesNotThrow(() => {
      executor.cancel(planId, nodeId);
    });
    
    // Verify execution was marked as aborted even without process
    const execution = (executor as any).activeExecutions.get(executionKey);
    assert.strictEqual(execution.aborted, true);
  });
});


