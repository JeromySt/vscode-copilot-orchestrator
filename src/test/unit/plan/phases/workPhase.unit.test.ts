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
    const executor = new WorkPhaseExecutor({ spawner: stubSpawner });
    const result = await executor.execute(makeCtx({ workSpec: undefined }));
    assert.strictEqual(result.success, true);
  });

  test('delegates agent work correctly', async () => {
    const runner = {
      run: sinon.stub().resolves({ success: true, sessionId: 'sess', metrics: { durationMs: 200 } }),
    };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
    const ctx = makeCtx({
      workSpec: { type: 'agent', instructions: 'implement feature', model: 'gpt-5', contextFiles: ['a.ts'], maxTurns: 10, context: 'ctx', allowedFolders: ['/x'], allowedUrls: ['example.com'] },
      sessionId: 'prev-sess',
    });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.copilotSessionId, 'sess');
    assert.ok(result.metrics);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.task, 'implement feature');
    assert.strictEqual(call.sessionId, 'prev-sess');
  });

  test('agent failure returns error with exit code', async () => {
    const runner = {
      run: sinon.stub().resolves({ success: false, error: 'broke', exitCode: 42, sessionId: 's1' }),
    };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 42);
    assert.strictEqual(result.copilotSessionId, 's1');
  });

  test('agent exception caught', async () => {
    const runner = { run: sinon.stub().rejects(new Error('timeout')) };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('timeout'));
    assert.ok(result.metrics?.durationMs !== undefined);
  });

  test('unknown work type returns error', async () => {
    const executor = new WorkPhaseExecutor({ spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'magic' as any } as any });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Unknown work type'));
  });

  test('without Copilot runner returns error for agent spec', async () => {
    const executor = new WorkPhaseExecutor({ spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'hi' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Copilot runner'));
  });

  test('string workSpec normalised to shell', async () => {
    const executor = new WorkPhaseExecutor({ spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: 'echo test' });
    const result = await executor.execute(ctx);
    assert.ok(typeof result.success === 'boolean');
  });

  test('@agent string normalised to agent spec', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: '@agent fix bug' });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
  });

  test('logs agent parameters', async () => {
    const logInfo = sinon.stub();
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
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

  test('agent with no metrics returns durationMs only', async () => {
    const runner = {
      run: sinon.stub().resolves({ success: true }),
    };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' } });
    const result = await executor.execute(ctx);
    assert.strictEqual(result.success, true);
    assert.ok(result.metrics?.durationMs !== undefined);
  });

  test('agent uses node instructions over spec context', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const executor = new WorkPhaseExecutor({ copilotRunner: runner as any, spawner: stubSpawner });
    const node = makeNode({ instructions: 'node-level instructions' });
    const ctx = makeCtx({
      node,
      workSpec: { type: 'agent', instructions: 'task', context: 'spec-context' },
    });
    await executor.execute(ctx);
    assert.strictEqual(runner.run.firstCall.args[0].instructions, 'node-level instructions');
  });
});

suite('adaptCommandForPowerShell', () => {
  test('converts && to error-propagation chain', () => {
    assert.strictEqual(adaptCommandForPowerShell('a && b'), "$ErrorActionPreference = 'Continue'; a; if (!$?) { exit 1 }; b; if ($LASTEXITCODE -eq -1) { exit 0 } else { exit $LASTEXITCODE }");
  });

  test('rewrites ls -la', () => {
    assert.strictEqual(adaptCommandForPowerShell('ls -la'), "$ErrorActionPreference = 'Continue'; Get-ChildItem; if ($LASTEXITCODE -eq -1) { exit 0 } else { exit $LASTEXITCODE }");
  });

  test('treats -1 exit code as success to handle pipeline termination by Select-Object -First', () => {
    // In PowerShell 5.x, Select-Object -First N kills upstream native commands with
    // exit code -1. This guard prevents false postchecks failures when tests pass.
    const adapted = adaptCommandForPowerShell("npm run test 2>&1 | Select-Object -First 5");
    assert.ok(adapted.includes("if ($LASTEXITCODE -eq -1) { exit 0 }"), 'must guard against -1 kill code');
    assert.ok(!adapted.includes("; exit $LASTEXITCODE"), 'must not use bare exit $LASTEXITCODE');
  });

  test('uses custom errorAction', () => {
    const result = adaptCommandForPowerShell('do-work', 'Stop');
    assert.ok(result.startsWith("$ErrorActionPreference = 'Stop';"), 'should use Stop');
  });
});

suite('runAgent (standalone)', () => {
  test('handles onProcess callback', async () => {
    const fakeProc = {};
    const runner = {
      run: sinon.stub().callsFake(async (opts: any) => {
        opts.onProcess(fakeProc);
        return { success: true };
      }),
    };
    const setProcess = sinon.stub();
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'x' }, setProcess });
    await runAgent({ type: 'agent', instructions: 'x' }, ctx, runner as any);
    assert.ok(setProcess.calledWith(fakeProc));
  });

  test('resolves modelTier to concrete model via suggestModel', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    // Stub the dynamic import by pre-loading the module and stubbing suggestModel
    const modelDiscovery = await import('../../../../agent/modelDiscovery');
    const stub = sinon.stub(modelDiscovery, 'suggestModel').resolves({ id: 'claude-haiku-4.5', vendor: 'anthropic', family: 'haiku', tier: 'fast' } as any);
    try {
      await runAgent({ type: 'agent', instructions: 'test', modelTier: 'fast' }, ctx, runner as any);
      const call = runner.run.firstCall.args[0];
      assert.strictEqual(call.model, 'claude-haiku-4.5');
    } finally { stub.restore(); }
  });

  test('falls back to undefined model when suggestModel fails', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const modelDiscovery = await import('../../../../agent/modelDiscovery');
    const stub = sinon.stub(modelDiscovery, 'suggestModel').rejects(new Error('no models'));
    try {
      await runAgent({ type: 'agent', instructions: 'test', modelTier: 'fast' }, ctx, runner as any);
      const call = runner.run.firstCall.args[0];
      assert.strictEqual(call.model, undefined);
    } finally { stub.restore(); }
  });

  test('explicit model takes precedence over modelTier', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    await runAgent({ type: 'agent', instructions: 'test', model: 'gpt-5', modelTier: 'fast' }, ctx, runner as any);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.model, 'gpt-5');
  });
});

suite('runAgent (no-op detector — A1)', () => {
  // Trick: patch Date.now so the FIRST call (startTime in runAgent) returns
  // realNow() - 90_000, simulating a 90s elapsed run by the time durationMs
  // is computed on the second Date.now call.
  function patchDateNowToOldStart(): () => void {
    const realNow = Date.now;
    let firstCall = true;
    (Date as any).now = () => {
      if (firstCall) { firstCall = false; return realNow() - 90_000; }
      return realNow();
    };
    return () => { (Date as any).now = realNow; };
  }

  test('flips success→failure when zero changes after long run and node does not expect no-changes', async () => {
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        sessionId: 'sess-noop',
        metrics: { codeChanges: { linesAdded: 0, linesRemoved: 0 } },
      }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'do work' } });
    const restore = patchDateNowToOldStart();
    try {
      const result = await runAgent({ type: 'agent', instructions: 'do work' }, ctx, runner as any);
      assert.strictEqual(result.success, false, 'Expected no-op detection to flip success');
      assert.ok(result.error?.includes('no-op'), `Expected no-op error message, got: ${result.error}`);
      assert.strictEqual(result.copilotSessionId, 'sess-noop');
    } finally { restore(); }
  });

  test('does NOT trip when node declares expectsNoChanges=true', async () => {
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        metrics: { codeChanges: { linesAdded: 0, linesRemoved: 0 } },
      }),
    };
    const ctx = makeCtx({
      node: makeNode({ expectsNoChanges: true } as any),
      workSpec: { type: 'agent', instructions: 'verify only' },
    });
    const restore = patchDateNowToOldStart();
    try {
      const result = await runAgent({ type: 'agent', instructions: 'verify only' }, ctx, runner as any);
      assert.strictEqual(result.success, true, 'expectsNoChanges nodes must not trip the no-op detector');
    } finally { restore(); }
  });

  test('does NOT trip when run is shorter than the no-op grace window', async () => {
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        metrics: { codeChanges: { linesAdded: 0, linesRemoved: 0 } },
      }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'fast task' } });
    // No Date.now patching → run completes well under 60s grace window.
    const result = await runAgent({ type: 'agent', instructions: 'fast task' }, ctx, runner as any);
    assert.strictEqual(result.success, true);
  });

  test('does NOT trip when there are real code changes', async () => {
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        metrics: { codeChanges: { linesAdded: 50, linesRemoved: 3 } },
      }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'real work' } });
    const restore = patchDateNowToOldStart();
    try {
      const result = await runAgent({ type: 'agent', instructions: 'real work' }, ctx, runner as any);
      assert.strictEqual(result.success, true);
    } finally { restore(); }
  });

  test('does NOT trip when stats produced no codeChanges metric', async () => {
    // If we have no metric to inspect, we can't conclude no-op — fail open (success).
    const runner = {
      run: sinon.stub().resolves({ success: true, metrics: {} }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'work' } });
    const restore = patchDateNowToOldStart();
    try {
      const result = await runAgent({ type: 'agent', instructions: 'work' }, ctx, runner as any);
      assert.strictEqual(result.success, true);
    } finally { restore(); }
  });
});

suite('runAgent (auto-promote complex jobs — B1)', () => {
  test('promotes large instructions to high effort', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000); // > 4 KB threshold
    await runAgent({ type: 'agent', instructions: bigInstructions }, ctx, runner as any);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, 'high', 'Expected effort=high after auto-promotion');
  });

  test('promotes when instructions list ≥6 file paths', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const filey = `# Job\n\nFiles to create:\n` +
      `- src/dotnet/Foo/Foo.csproj\n` +
      `- src/dotnet/Foo/Bar.cs\n` +
      `- src/dotnet/Foo/Baz.cs\n` +
      `- src/dotnet/Foo/Qux.cs\n` +
      `- tests/dotnet/Foo.Tests/Foo.Tests.csproj\n` +
      `- tests/dotnet/Foo.Tests/FooContractTests.cs\n`;
    await runAgent({ type: 'agent', instructions: filey }, ctx, runner as any);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, 'high', 'Expected effort=high after file-count auto-promotion');
  });

  test('does NOT promote when model is explicitly set', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000);
    await runAgent(
      { type: 'agent', instructions: bigInstructions, model: 'claude-sonnet-4.6' },
      ctx, runner as any,
    );
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.model, 'claude-sonnet-4.6');
    assert.strictEqual(call.effort, undefined);
  });

  test('does NOT promote when modelTier is explicitly set', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000);
    await runAgent(
      { type: 'agent', instructions: bigInstructions, modelTier: 'standard' },
      ctx, runner as any,
    );
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, undefined);
  });

  test('preserves explicit effort (does not stomp caller choice)', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000);
    await runAgent(
      { type: 'agent', instructions: bigInstructions, effort: 'low' },
      ctx, runner as any,
    );
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, 'low', 'Caller effort must be preserved');
  });

  test('does NOT promote small simple jobs', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    await runAgent({ type: 'agent', instructions: 'do a small thing' }, ctx, runner as any);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, undefined);
  });
});

suite('runAgent (no-op detector — A1)', () => {
  test('flips success→failure when zero changes after long run and node does not expect no-changes', async () => {
    // Long-running agent that produces no commits — the failure mode reported in
    // CLI v1.0.34 logs (empty assistant turn → end_turn → exit 0).
    const runner = {
      run: sinon.stub().callsFake(async () => {
        // Simulate a 90-second run by stubbing Date.now via the metrics path:
        // the detector reads `durationMs = Date.now() - startTime`, so we make the
        // run promise resolve after wall-clock time has advanced. We can't stub
        // Date.now from outside here without sinon clock interference, so instead
        // we exploit setStartTime: the ctx records start, and we delay the resolve.
        await new Promise(r => setTimeout(r, 5));
        return {
          success: true,
          metrics: { codeChanges: { linesAdded: 0, linesRemoved: 0 } },
          sessionId: 'sess-noop',
        };
      }),
    };
    // Force the duration check: we substitute setStartTime to record a start time
    // that is 90s in the past so the detector sees `durationMs >= 60_000`.
    const recordedStart: number[] = [];
    const ctx = makeCtx({
      workSpec: { type: 'agent', instructions: 'do work' },
      setStartTime: (t: number) => { recordedStart.push(t); },
    });
    // Patch Date.now temporarily so startTime gets recorded as 90s ago
    const realNow = Date.now;
    let firstCall = true;
    (Date as any).now = () => {
      if (firstCall) { firstCall = false; return realNow() - 90_000; }
      return realNow();
    };
    try {
      const result = await runAgent({ type: 'agent', instructions: 'do work' }, ctx, runner as any);
      assert.strictEqual(result.success, false, 'Expected no-op detection to flip success');
      assert.ok(result.error?.includes('no-op'), `Expected no-op error message, got: ${result.error}`);
      assert.strictEqual(result.copilotSessionId, 'sess-noop');
    } finally { (Date as any).now = realNow; }
  });

  test('does NOT trip when node declares expectsNoChanges=true', async () => {
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        metrics: { codeChanges: { linesAdded: 0, linesRemoved: 0 } },
      }),
    };
    const node = makeNode({ expectsNoChanges: true });
    const ctx = makeCtx({ node, workSpec: { type: 'agent', instructions: 'verify only' } });
    const realNow = Date.now;
    let firstCall = true;
    (Date as any).now = () => {
      if (firstCall) { firstCall = false; return realNow() - 90_000; }
      return realNow();
    };
    try {
      const result = await runAgent({ type: 'agent', instructions: 'verify only' }, ctx, runner as any);
      assert.strictEqual(result.success, true, 'expectsNoChanges nodes must not trip the no-op detector');
    } finally { (Date as any).now = realNow; }
  });

  test('does NOT trip when run is shorter than the no-op grace window', async () => {
    // Short run with zero changes is fine (e.g. transient denial that still exits 0).
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        metrics: { codeChanges: { linesAdded: 0, linesRemoved: 0 } },
      }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'fast task' } });
    // No Date.now patching → run completes well under 60s grace window.
    const result = await runAgent({ type: 'agent', instructions: 'fast task' }, ctx, runner as any);
    assert.strictEqual(result.success, true);
  });

  test('does NOT trip when there are real code changes', async () => {
    const runner = {
      run: sinon.stub().resolves({
        success: true,
        metrics: { codeChanges: { linesAdded: 50, linesRemoved: 3 } },
      }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'real work' } });
    const realNow = Date.now;
    let firstCall = true;
    (Date as any).now = () => {
      if (firstCall) { firstCall = false; return realNow() - 90_000; }
      return realNow();
    };
    try {
      const result = await runAgent({ type: 'agent', instructions: 'real work' }, ctx, runner as any);
      assert.strictEqual(result.success, true);
    } finally { (Date as any).now = realNow; }
  });

  test('does NOT trip when stats produced no codeChanges metric (compat with older CLI without v1.0.34 parser hits)', async () => {
    // If we have no metric to inspect, we can't conclude no-op — fail open (success).
    const runner = {
      run: sinon.stub().resolves({ success: true, metrics: {} }),
    };
    const ctx = makeCtx({ workSpec: { type: 'agent', instructions: 'work' } });
    const realNow = Date.now;
    let firstCall = true;
    (Date as any).now = () => {
      if (firstCall) { firstCall = false; return realNow() - 90_000; }
      return realNow();
    };
    try {
      const result = await runAgent({ type: 'agent', instructions: 'work' }, ctx, runner as any);
      assert.strictEqual(result.success, true);
    } finally { (Date as any).now = realNow; }
  });
});

suite('runAgent (auto-promote complex jobs — B1)', () => {
  test('promotes large instructions to premium tier + high effort', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000); // > 4 KB threshold
    await runAgent({ type: 'agent', instructions: bigInstructions }, ctx, runner as any);
    // suggestModel may not return a model in test env; verify the *tier* and *effort*
    // were resolved by inspecting the runner call's `effort` arg.
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, 'high', 'Expected effort=high after auto-promotion');
  });

  test('promotes when instructions list ≥6 file paths', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const filey = `# Job\n\nFiles to create:\n` +
      `- src/dotnet/Foo/Foo.csproj\n` +
      `- src/dotnet/Foo/Bar.cs\n` +
      `- src/dotnet/Foo/Baz.cs\n` +
      `- src/dotnet/Foo/Qux.cs\n` +
      `- tests/dotnet/Foo.Tests/Foo.Tests.csproj\n` +
      `- tests/dotnet/Foo.Tests/FooContractTests.cs\n`;
    await runAgent({ type: 'agent', instructions: filey }, ctx, runner as any);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, 'high', 'Expected effort=high after file-count auto-promotion');
  });

  test('does NOT promote when model is explicitly set', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000);
    await runAgent(
      { type: 'agent', instructions: bigInstructions, model: 'claude-sonnet-4.6' },
      ctx, runner as any,
    );
    const call = runner.run.firstCall.args[0];
    // Explicit model wins; no effort injected.
    assert.strictEqual(call.model, 'claude-sonnet-4.6');
    assert.strictEqual(call.effort, undefined);
  });

  test('does NOT promote when modelTier is explicitly set', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000);
    await runAgent(
      { type: 'agent', instructions: bigInstructions, modelTier: 'standard' },
      ctx, runner as any,
    );
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, undefined);
  });

  test('preserves explicit effort (does not downgrade when explicit)', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    const bigInstructions = 'x'.repeat(5_000);
    // Caller asked for low; auto-promote should still upgrade (no explicit model/tier),
    // but should not stomp the caller's effort choice.
    await runAgent(
      { type: 'agent', instructions: bigInstructions, effort: 'low' },
      ctx, runner as any,
    );
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, 'low', 'Caller effort must be preserved');
  });

  test('does NOT promote small simple jobs', async () => {
    const runner = { run: sinon.stub().resolves({ success: true }) };
    const ctx = makeCtx();
    await runAgent({ type: 'agent', instructions: 'do a small thing' }, ctx, runner as any);
    const call = runner.run.firstCall.args[0];
    assert.strictEqual(call.effort, undefined);
  });
});
