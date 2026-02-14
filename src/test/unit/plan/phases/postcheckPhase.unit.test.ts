/**
 * @fileoverview Unit tests for PostcheckPhaseExecutor.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { PostcheckPhaseExecutor } from '../../../../plan/phases/postcheckPhase';
import type { PhaseContext } from '../../../../interfaces/IPhaseExecutor';
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
    node: makeNode(), worktreePath: '/tmp/wt', executionKey: 'p:n:1', phase: 'postchecks',
    logInfo: sinon.stub(), logError: sinon.stub(), logOutput: sinon.stub(),
    isAborted: () => false, setProcess: sinon.stub(), setStartTime: sinon.stub(), setIsAgentWork: sinon.stub(),
    ...overrides,
  };
}

suite('PostcheckPhaseExecutor', () => {
  test('returns success when no workSpec', async () => {
    const executor = new PostcheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const result = await executor.execute(makeCtx({ workSpec: undefined }));
    assert.strictEqual(result.success, true);
  });

  test('delegates agent work', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: true, sessionId: 'ss', metrics: { durationMs: 10 } }) };
    const executor = new PostcheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'verify' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.copilotSessionId, 'ss');
  });

  test('returns error for unknown type', async () => {
    const executor = new PostcheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'fake' as any } as any });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Unknown work type'));
  });

  test('agent fails without delegator', async () => {
    const executor = new PostcheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'check' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('agent delegator'));
  });

  test('agent failure returns error', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: false, error: 'nope', exitCode: 2 }) };
    const executor = new PostcheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'verify' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 2);
  });

  test('agent exception caught', async () => {
    const delegator = { delegate: sinon.stub().rejects(new Error('crash')) };
    const executor = new PostcheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'verify' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('crash'));
  });

  test('normalises string workSpec', async () => {
    const executor = new PostcheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: 'npm test' });
    const result = await executor.execute(ctx);
    assert.ok(typeof result.success === 'boolean');
  });

  test('normalises @agent string', async () => {
    const delegator = { delegate: sinon.stub().resolves({ success: true }) };
    const executor = new PostcheckPhaseExecutor({ agentDelegator: delegator, getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: '@agent review code' });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
  });

  test('logs work type', async () => {
    const logInfo = sinon.stub();
    const executor = new PostcheckPhaseExecutor({ getCopilotConfigDir: () => '/tmp', spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' }, logInfo });
    await executor.execute(ctx);
    assert.ok(logInfo.calledWith('Work type: agent'));
  });
});
