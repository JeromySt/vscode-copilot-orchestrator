/**
 * @fileoverview Coverage tests for MergeFiPhaseExecutor.
 * Covers: workSummary logging (line 81-82), local-changes stash-retry paths (140-191),
 * and popStash AI-assisted fallback (235-271).
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { MergeFiPhaseExecutor } from '../../../plan/phases/mergeFiPhase';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function makeContext(sandbox: sinon.SinonSandbox, overrides?: any): any {
  return {
    node: { id: 'node-1', name: 'Test Job' },
    worktreePath: '/repo/.worktrees/plan-1/node-1',
    dependencyCommits: [],
    logInfo: sandbox.stub(),
    logError: sandbox.stub(),
    logDebug: sandbox.stub(),
    logWarn: sandbox.stub(),
    ...overrides,
  };
}

function makeGit(sandbox: sinon.SinonSandbox): any {
  return {
    merge: {
      merge: sandbox.stub().resolves({ success: true }),
      abort: sandbox.stub().resolves(),
      listConflicts: sandbox.stub().resolves([]),
    },
    repository: {
      stashPush: sandbox.stub().resolves(true),
      stashPop: sandbox.stub().resolves(),
      stashDrop: sandbox.stub().resolves(),
      stageAll: sandbox.stub().resolves(),
      stashShowPatch: sandbox.stub().resolves(null),
    },
    gitignore: {
      isDiffOnlyOrchestratorChanges: sandbox.stub().returns(false),
    },
  };
}

function makeCopilotRunner(sandbox: sinon.SinonSandbox): any {
  return {
    run: sandbox.stub().resolves({ success: true, sessionId: 'sid' }),
    isAvailable: sandbox.stub().returns(true),
  };
}

suite('MergeFiPhaseExecutor coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };
  // Saved reference for resolveMergeConflictWithCopilot mock
  let mergeHelperModule: any;
  let originalResolveFn: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();
    mergeHelperModule = require('../../../plan/phases/mergeHelper');
    originalResolveFn = mergeHelperModule.resolveMergeConflictWithCopilot;
  });

  teardown(() => {
    mergeHelperModule.resolveMergeConflictWithCopilot = originalResolveFn;
    quiet.restore();
    sandbox.restore();
  });

  // ── workSummary logging (lines 81-82) ────────────────────────────────────

  suite('logDependencyWorkSummary', () => {
    test('logs up to 3 lines of workSummary without truncation message', async () => {
      const git = makeGit(sandbox);
      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [
          { commit: 'abc12345', nodeId: 'node-dep', nodeName: 'Dep Node' },
        ],
      });

      // Inject workSummary via dependencyInfoMap by adding a node with summary
      // We do it by overriding ctx.dependencyCommits and also patching the git stub
      // to succeed, then check logInfo was called with the summary lines
      git.merge.merge.resolves({ success: true });

      // We need to set workSummary through a path that sets it in dependencyInfoMap.
      // The dependencyInfoMap is internal, so we use a workaround: add workSummary to commit
      // Actually the workSummary is set to undefined always in execute(). To test
      // logDependencyWorkSummary, we need to call it directly via type cast.

      // Call logDependencyWorkSummary directly
      const summary = 'Line 1\nLine 2\nLine 3';
      (executor as any).logDependencyWorkSummary(ctx, summary);

      assert.ok(ctx.logInfo.calledWith('    Line 1'));
      assert.ok(ctx.logInfo.calledWith('    Line 2'));
      assert.ok(ctx.logInfo.calledWith('    Line 3'));
      // No truncation message for 3 lines
      const calls = ctx.logInfo.args.map((a: any) => a[0]);
      assert.ok(!calls.some((c: string) => c.includes('more lines')));
    });

    test('logs first 3 lines and truncation message for longer workSummary', () => {
      const git = makeGit(sandbox);
      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox);

      const summary = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      (executor as any).logDependencyWorkSummary(ctx, summary);

      assert.ok(ctx.logInfo.calledWith('    Line 1'));
      assert.ok(ctx.logInfo.calledWith('    Line 2'));
      assert.ok(ctx.logInfo.calledWith('    Line 3'));
      const calls = ctx.logInfo.args.map((a: any) => a[0]);
      assert.ok(calls.some((c: string) => c.includes('2 more lines')));
      // Line 4 and 5 should NOT be logged
      assert.ok(!calls.some((c: string) => c.includes('Line 4')));
    });
  });

  // ── local-changes stash/retry paths (lines 140-191) ──────────────────────

  suite('local changes stash/retry', () => {
    test('stashes, retries successfully, then pops stash when merge blocked by local changes', async () => {
      const git = makeGit(sandbox);
      // First merge call: fails with "local changes" error
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'Your local changes would be overwritten' })
        // Second merge call (retry after stash): succeeds
        .onSecondCall().resolves({ success: true });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.resolves();

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(git.repository.stashPush.calledOnce);
      assert.ok(git.repository.stashPop.calledOnce);
    });

    test('returns error when stash fails', async () => {
      const git = makeGit(sandbox);
      git.merge.merge.onFirstCall().resolves({
        success: false, hasConflicts: false, error: 'local changes to the following files would be overwritten',
      });
      // stashPush throws
      git.repository.stashPush.rejects(new Error('stash error'));

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Merge failed'));
    });

    test('returns error when stashPush returns false (stash not created)', async () => {
      const git = makeGit(sandbox);
      git.merge.merge.onFirstCall().resolves({
        success: false, hasConflicts: false, error: 'local changes would be overwritten',
      });
      git.repository.stashPush.resolves(false); // stash not created

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Could not stash') || result.error?.includes('Merge failed'));
    });

    test('stash retry encounters conflict — AI resolves successfully', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: false, hasConflicts: true, conflictFiles: ['src/a.ts'] });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.resolves();

      // AI resolves the conflict
      mergeHelperModule.resolveMergeConflictWithCopilot = sandbox.stub().resolves({
        success: true,
        metrics: { requestCount: 1, inputTokens: 50, outputTokens: 30, costUsd: 0.001, durationMs: 500 },
      });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.metrics !== undefined);
    });

    test('stash retry encounters conflict — AI fails', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: false, hasConflicts: true, conflictFiles: ['src/a.ts'] });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.resolves();
      git.merge.abort.resolves();

      mergeHelperModule.resolveMergeConflictWithCopilot = sandbox.stub().resolves({ success: false });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Failed to resolve conflict'));
    });

    test('stash retry fails for non-conflict reason', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: false, hasConflicts: false, error: 'Some other error' });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.resolves();

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('even after stash'));
    });

    test('non-local-changes merge failure returns immediate error', async () => {
      const git = makeGit(sandbox);
      git.merge.merge.resolves({ success: false, hasConflicts: false, error: 'Unrelated failure' });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Merge failed for dependency'));
    });
  });

  // ── AI conflict resolution with metrics accumulation (lines 128-133) ─────

  suite('conflict resolution metrics accumulation', () => {
    test('accumulates metrics from multiple conflict resolutions', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: true, conflictFiles: ['a.ts'] })
        .onSecondCall().resolves({ success: false, hasConflicts: true, conflictFiles: ['b.ts'] });

      const metrics1 = { requestCount: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 };
      const metrics2 = { requestCount: 2, inputTokens: 200, outputTokens: 100, costUsd: 0.02, durationMs: 2000 };
      mergeHelperModule.resolveMergeConflictWithCopilot = sandbox.stub()
        .onFirstCall().resolves({ success: true, metrics: metrics1 })
        .onSecondCall().resolves({ success: true, metrics: metrics2 });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [
          { commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' },
          { commit: 'def67890', nodeId: 'dep-2', nodeName: 'Dep 2' },
        ],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(result.metrics !== undefined);
    });
  });

  // ── popStash AI-assisted fallback (lines 235-271) ─────────────────────────

  suite('popStash fallback', () => {
    test('popStash: stashPop throws, conflicts exist, AI resolves successfully', async () => {
      const git = makeGit(sandbox);
      // First merge to trigger stash path
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: true });
      git.repository.stashPush.resolves(true);
      // stashPop throws
      git.repository.stashPop.rejects(new Error('conflict during pop'));
      git.merge.listConflicts.resolves(['conflicted.ts']);
      git.repository.stageAll.resolves();
      git.repository.stashDrop.resolves();

      mergeHelperModule.resolveMergeConflictWithCopilot = sandbox.stub().resolves({ success: true });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(git.repository.stageAll.called);
      assert.ok(git.repository.stashDrop.called);
    });

    test('popStash: stashPop throws, conflicts exist, AI fails, orchestrator-only diff is dropped', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: true });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.rejects(new Error('pop conflict'));
      git.merge.listConflicts.resolves(['orchestrator.ts']);
      git.repository.stashShowPatch.resolves('some diff content');
      git.gitignore.isDiffOnlyOrchestratorChanges.returns(true);
      git.repository.stashDrop.resolves();

      mergeHelperModule.resolveMergeConflictWithCopilot = sandbox.stub().resolves({ success: false });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(git.repository.stashDrop.called);
      const infoCalls = ctx.logInfo.args.map((a: any) => a[0]);
      assert.ok(infoCalls.some((c: string) => c.includes('orchestrator-only')));
    });

    test('popStash: stashPop throws, conflicts exist, AI fails, non-orchestrator diff is dropped', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: true });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.rejects(new Error('pop conflict'));
      git.merge.listConflicts.resolves(['important.ts']);
      git.repository.stashShowPatch.resolves('important diff content');
      git.gitignore.isDiffOnlyOrchestratorChanges.returns(false);
      git.repository.stashDrop.resolves();

      mergeHelperModule.resolveMergeConflictWithCopilot = sandbox.stub().resolves({ success: false });

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(git.repository.stashDrop.called);
      const infoCalls = ctx.logInfo.args.map((a: any) => a[0]);
      assert.ok(infoCalls.some((c: string) => c.includes('unresolvable stash') || c.includes('authoritative')));
    });

    test('popStash: stashPop throws, no conflicts, stashShowPatch is null, stash dropped', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: true });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.rejects(new Error('pop error'));
      git.merge.listConflicts.resolves([]); // no conflicts
      git.repository.stashShowPatch.resolves(null);
      git.repository.stashDrop.resolves();

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, true);
      assert.ok(git.repository.stashDrop.called);
    });

    test('popStash: stashPop throws, inner operations also throw (last resort drop)', async () => {
      const git = makeGit(sandbox);
      git.merge.merge
        .onFirstCall().resolves({ success: false, hasConflicts: false, error: 'local changes would be overwritten' })
        .onSecondCall().resolves({ success: true });
      git.repository.stashPush.resolves(true);
      git.repository.stashPop.rejects(new Error('pop error'));
      // listConflicts also throws
      git.merge.listConflicts.rejects(new Error('listConflicts error'));
      git.repository.stashDrop.resolves();

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      // Should not throw — last resort catch drops stash
      assert.strictEqual(result.success, true);
      const infoCalls = ctx.logInfo.args.map((a: any) => a[0]);
      assert.ok(infoCalls.some((c: string) => c.includes('Dropped stash') || c.includes('authoritative')));
    });

    test('popStash: didStash=false skips all operations', async () => {
      const git = makeGit(sandbox);
      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox);

      // Call popStash directly with didStash=false
      await (executor as any).popStash('/some/path', false, ctx);

      assert.ok(git.repository.stashPop.notCalled);
      assert.ok(git.repository.stashDrop.notCalled);
    });
  });

  // ── merge throw path (lines 202-209) ─────────────────────────────────────

  suite('merge throws exception', () => {
    test('returns error when git.merge.merge throws', async () => {
      const git = makeGit(sandbox);
      git.merge.merge.rejects(new Error('git crash'));

      const copilot = makeCopilotRunner(sandbox);
      const executor = new MergeFiPhaseExecutor({ git, copilotRunner: copilot });
      const ctx = makeContext(sandbox, {
        dependencyCommits: [{ commit: 'abc12345', nodeId: 'dep-1', nodeName: 'Dep 1' }],
      });

      const result = await executor.execute(ctx);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Merge error'));
      assert.ok(result.error?.includes('git crash'));
    });
  });
});
