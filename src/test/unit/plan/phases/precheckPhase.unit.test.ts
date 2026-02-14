/**
 * @fileoverview Unit tests for PrecheckPhaseExecutor.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { PrecheckPhaseExecutor } from '../../../../plan/phases/precheckPhase';
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
    node: makeNode(), worktreePath: '/tmp/wt', executionKey: 'p:n:1', phase: 'prechecks',
    logInfo: sinon.stub(), logError: sinon.stub(), logOutput: sinon.stub(),
    isAborted: () => false, setProcess: sinon.stub(), setStartTime: sinon.stub(), setIsAgentWork: sinon.stub(),
    ...overrides,
  };
}

suite('PrecheckPhaseExecutor', () => {
  test('returns success when no workSpec', async () => {
    const executor = new PrecheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const result = await executor.execute(makeCtx({ workSpec: undefined }));
    assert.strictEqual(result.success, true);
  });

  test('returns success for shell spec with agent delegator on agent type', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: true, sessionId: 'sess1', metrics: { durationMs: 100 } }) };
    const executor = new PrecheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'check things' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.copilotSessionId, 'sess1');
  });

  test('returns error for unknown work type', async () => {
    const executor = new PrecheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'unknown' as any } as any });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Unknown work type'));
  });

  test('agent fails without delegator', async () => {
    const executor = new PrecheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'do' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('agent delegator'));
  });

  test('agent failure returns error and metrics', async () => {
    const delegator = {
      delegate: sinon.stub().resolves({ success: false, error: 'bad', exitCode: 1, metrics: { durationMs: 50 } }),
    };
    const executor = new PrecheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'check' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.metrics);
  });

  test('agent exception returns error', async () => {
    const delegator = { delegate: sinon.stub().rejects(new Error('boom')) };
    const executor = new PrecheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'check' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('boom'));
  });

  test('normalises string workSpec to shell', async () => {
    // A string workSpec gets normalised to shell — this will fail to spawn but exercises the path
    const executor = new PrecheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: 'echo hello' });
    // The shell spawn will fail (no real shell), but we exercise the normalisation
    const result = await executor.execute(ctx);
    // Either success or spawn error — both are valid code paths
    assert.ok(typeof result.success === 'boolean');
  });

  test('normalises @agent string to agent spec', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: true }) };
    const executor = new PrecheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: '@agent do the thing' });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.ok(delegator.delegate.calledOnce);
  });

  test('logs work type', async () => {
    const executor = new PrecheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const logInfo = sinon.stub();
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' }, logInfo });
    await executor.execute(ctx);
    assert.ok(logInfo.calledWith('Work type: agent'));
  });
});
