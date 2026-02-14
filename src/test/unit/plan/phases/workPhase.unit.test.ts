/**
 * @fileoverview Unit tests for WorkPhaseExecutor and shared runners.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { WorkPhaseExecutor, runAgent, adaptCommandForPowerShell } from '../../../../plan/phases/workPhase';
import type { PhaseContext, PhaseResult } from '../../../../interfaces/IPhaseExecutor';
import type { IProcessSpawner } from '../../../../interfaces/IProcessSpawner';
import { EventEmitter } from 'events';
const stubSpawner: IProcessSpawner = {
  spawn: () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const proc = Object.assign(new EventEmitter(), {
      pid: 0, exitCode: 1, killed: false,
      stdout, stderr,
      kill: () => true,
    });
    process.nextTick(() => proc.emit('close', 1));
    return proc as any;
  },
};
import type { JobNode } from '../../../../plan/types';

function makeNode(overrides: Partial<JobNode> = {}): JobNode {
  return {
    id: 'n1', producerId: 'n1', name: 'Test', type: 'job',
    task: 'do stuff', dependencies: [], dependents: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    node: makeNode(), worktreePath: '/tmp/wt', executionKey: 'p:n:1', phase: 'work',
    logInfo: sinon.stub(), logError: sinon.stub(), logOutput: sinon.stub(),
    isAborted: () => false, setProcess: sinon.stub(), setStartTime: sinon.stub(), setIsAgentWork: sinon.stub(),
    ...overrides,
  };
}

suite('WorkPhaseExecutor', () => {
  test('returns success when no workSpec', async () => {
    const executor = new WorkPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const result = await executor.execute(makeCtx({ workSpec: undefined }));
    assert.strictEqual(result.success, true);
  });

  test('delegates agent work correctly', async () => {
    const delegator = {
      delegate: sinon.stub().resolves({ success: true, sessionId: 'sess', metrics: { durationMs: 200 } }),
    };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/cfg', spawner: stubSpawner });
    const ctx = makeCtx({
      workSpec: { type: 'agent', instructions: 'implement feature', model: 'gpt-5', contextFiles: ['a.ts'], maxTurns: 10, context: 'ctx', allowedFolders: ['/x'], allowedUrls: ['example.com'] },
      sessionId: 'prev-sess',
    });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.copilotSessionId, 'sess');
    assert.ok(result.metrics);
    const call = delegator.delegate.firstCall.args[0];
    assert.strictEqual(call.task, 'implement feature');
    assert.strictEqual(call.sessionId, 'prev-sess');
    assert.strictEqual(call.configDir, '/cfg');
  });

  test('agent failure returns error with exit code', async () => {
    const delegator = {
      delegate: sinon.stub().resolves({ success: false, error: 'broke', exitCode: 42, sessionId: 's1' }),
    };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 42);
    assert.strictEqual(result.copilotSessionId, 's1');
  });

  test('agent exception caught', async () => {
    const delegator = { delegate: sinon.stub().rejects(new Error('timeout')) };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('timeout'));
    assert.ok(result.metrics?.durationMs !== undefined);
  });

  test('unknown work type returns error', async () => {
    const executor = new WorkPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'magic' as any } as any });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Unknown work type'));
  });

  test('without agent delegator returns error for agent spec', async () => {
    const executor = new WorkPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'hi' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('agent delegator'));
  });

  test('string workSpec normalised to shell', async () => {
    const executor = new WorkPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: 'echo test' });
    const result = await executor.execute(ctx);
    assert.ok(typeof result.success === 'boolean');
  });

  test('@agent string normalised to agent spec', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: true }) };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: '@agent fix bug' });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
  });

  test('logs agent parameters', async () => {
    const logInfo = sinon.stub();
    const delegator = { delegate: sinon.stub().resolves({ success: true }) };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({
      workSpec: { type: 'agent', instructions: 'instr', model: 'm', contextFiles: ['f'], maxTurns: 5, context: 'c', allowedFolders: ['/a'], allowedUrls: ['u'] },
      sessionId: 'sid', logInfo,
    });
    await executor.execute(ctx);
    assert.ok(logInfo.calledWith('Using model: m'));
    assert.ok(logInfo.calledWith('Agent max turns: 5'));
    assert.ok(logInfo.calledWith('Agent context: c'));
    assert.ok(logInfo.calledWith('Resuming Copilot session: sid'));
  });

  test('agent with legacy tokenUsage fallback', async () => {
    const delegator = {
      delegate: sinon.stub().resolves({ success: true, tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, model: 'm' } }),
    };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.ok(result.metrics?.tokenUsage);
  });

  test('agent uses node instructions over spec context', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: true }) };
    const executor = new WorkPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const node = makeNode({ instructions: 'node-level instructions' });
    const ctx = makeCtx({
      node,
      workSpec: { type: 'agent', instructions: 'task', context: 'spec-context' },
    });
    await executor.execute(ctx);
    assert.strictEqual(delegator.delegate.firstCall.args[0].instructions, 'node-level instructions');
  });
});

suite('adaptCommandForPowerShell', () => {
  test('converts && to error-propagation chain', () => {
    assert.strictEqual(adaptCommandForPowerShell('a && b'), "$ErrorActionPreference = 'Continue'; a; if (!$?) { exit 1 }; b; exit $LASTEXITCODE");
  });

  test('rewrites ls -la', () => {
    assert.strictEqual(adaptCommandForPowerShell('ls -la'), "$ErrorActionPreference = 'Continue'; Get-ChildItem; exit $LASTEXITCODE");
  });
});

suite('runAgent (standalone)', () => {
  test('handles onProcess callback', async () => {
    const fakeProc = {};
    const delegator = {
      delegate: sinon.stub().callsFake(async (opts: any) => {
        opts.onProcess(fakeProc);
        return { success: true };
      }),
    };
    const setProcess = sinon.stub();
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' }, setProcess });
    await runAgent({ type: 'agent', instructions: 'x' }, ctx, delegator, () => '/cfg');
    assert.ok(setProcess.calledWith(fakeProc));
  });
});
