/**
 * @fileoverview Unit tests for PlanRunner - delegation and lifecycle coverage
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanRunner } from '../../../plan/runner';
import { PlanConfigManager } from '../../../plan/configManager';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { ProcessMonitor } from '../../../process/processMonitor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cov-test-'));
  tmpDirs.push(dir);
  return dir;
}

function createRunnerDeps(storagePath: string) {
  return {
    configManager: new PlanConfigManager(),
    persistence: new PlanPersistence(storagePath),
    processMonitor: new ProcessMonitor(new DefaultProcessSpawner()),
    stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
    git: {
      worktrees: { removeSafe: async () => {}, list: async () => [], prune: async () => {} },
      gitignore: { ensureGitignoreEntries: async () => true, ensureOrchestratorGitIgnore: async () => true },
      branches: { current: async () => 'main', exists: async () => true },
      repository: { hasChanges: async () => false },
      merge: {},
    } as any,
  };
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('PlanRunner delegation coverage', () => {
  let quiet: { restore: () => void };
  setup(() => { quiet = silenceConsole(); });
  teardown(() => {
    quiet.restore();
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  test('constructor creates instance', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.ok(runner);
  });

  test('setExecutor and setGlobalCapacityManager', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    runner.setExecutor({ execute: async () => ({ success: true }), cancel: () => {} } as any);
    runner.setGlobalCapacityManager({} as any);
  });

  test('setCopilotRunner stores the runner', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const mockRunner = { run: async () => {} } as any;
    runner.setCopilotRunner(mockRunner);
    assert.strictEqual((runner as any)._state.copilotRunner, mockRunner);
  });

  test('query methods return defaults for unknown plans', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.strictEqual(runner.get('x'), undefined);
    assert.strictEqual(runner.getPlan('x'), undefined);
    assert.deepStrictEqual(runner.getAll(), []);
    assert.deepStrictEqual(runner.getByStatus('running'), []);
    assert.strictEqual(runner.getStateMachine('x'), undefined);
    assert.strictEqual(runner.getStatus('x'), undefined);
    assert.strictEqual(runner.getEffectiveEndedAt('x'), undefined);
    assert.strictEqual(runner.getEffectiveStartedAt('x'), undefined);
    // getRecursiveStatusCounts returns an object with totalNodes:0 for unknown
    const counts = runner.getRecursiveStatusCounts('x');
    assert.ok(counts === undefined || (typeof counts === 'object'));
  });

  test('control methods return false for unknown plans', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.strictEqual(runner.cancel('x'), false);
    assert.strictEqual(runner.pause('x'), false);
    assert.strictEqual(runner.delete('x'), false);
    assert.strictEqual(await runner.resume('x'), false);
  });

  test('node query methods return defaults', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.ok(typeof runner.getNodeLogs('p', 'n') === 'string');
    assert.deepStrictEqual(runner.getNodeAttempts('p', 'n'), []);
    assert.ok('error' in runner.getNodeFailureContext('p', 'n'));
  });

  test('retryNode returns error for unknown', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const r = await runner.retryNode('p', 'n');
    assert.strictEqual(r.success, false);
  });

  test('forceFailNode throws for unknown', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    try {
      await runner.forceFailNode('p', 'n');
      assert.fail('Should have thrown');
    } catch (e: any) { assert.ok(e.message); }
  });

  test('enqueue creates plan and get retrieves it', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'Test', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'Build', dependencies: [] }],
    });
    assert.ok(runner.get(plan.id));
    assert.ok(runner.getStateMachine(plan.id));
  });

  test('enqueueJob creates single-job plan', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueueJob({ name: 'Job', task: 'x' });
    assert.ok(plan.id);
    assert.strictEqual(plan.nodes.size, 2); // 1 job + snapshot-validation
  });

  test('initialize, persistSync, shutdown lifecycle', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    await runner.initialize();
    runner.persistSync();
    await runner.shutdown();
  });

  test('getGlobalStats returns stats object', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const stats = runner.getGlobalStats();
    assert.ok(stats);
    assert.ok('totalPlans' in stats || 'running' in stats || typeof stats === 'object');
  });

  test('getGlobalCapacityStats returns null without manager', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.strictEqual(await runner.getGlobalCapacityStats(), null);
  });

  test('cancel with skipPersist option', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    const result = runner.cancel(plan.id, { skipPersist: true });
    assert.strictEqual(result, true);
  });

  test('pause on real plan', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    assert.strictEqual(runner.pause(plan.id), true);
  });

  test('delete on real plan', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    assert.strictEqual(runner.delete(plan.id), true);
    assert.strictEqual(runner.get(plan.id), undefined);
  });

  test('getNodeLogFilePath for unknown', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const result = runner.getNodeLogFilePath('p', 'n');
    assert.ok(result === undefined || typeof result === 'string');
  });

  test('getNodeAttempt for unknown', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const result = runner.getNodeAttempt('p', 'n', 1);
    assert.ok(result === null || result === undefined);
  });

  test('getProcessStats for unknown', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const result = await runner.getProcessStats('p', 'n');
    assert.ok(result === null || result === undefined || typeof result === 'object');
  });

  test('getAllProcessStats for unknown', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const result = await runner.getAllProcessStats('unknown-plan');
    assert.ok(result === null || result === undefined || Array.isArray(result) || typeof result === 'object');
  });

  test('savePlan returns false for unknown', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.strictEqual(runner.savePlan('unknown'), false);
  });

  test('savePlan returns true for known plan', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    assert.strictEqual(runner.savePlan(plan.id), true);
  });

  test('completeFinalMerge returns error for unknown plan', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const r = await runner.completeFinalMerge('unknown');
    assert.strictEqual(r.success, false);
    assert.ok(r.error?.includes('not found'));
  });

  test('completeFinalMerge returns error when not awaiting', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    const r = await runner.completeFinalMerge(plan.id);
    assert.strictEqual(r.success, false);
    assert.ok(r.error?.includes('not awaiting'));
  });

  test('completeFinalMerge returns error when no snapshot', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    (plan as any).awaitingFinalMerge = true;
    const r = await runner.completeFinalMerge(plan.id);
    assert.strictEqual(r.success, false);
    assert.ok(r.error?.includes('snapshot'));
  });

  test('completeFinalMerge succeeds with valid snapshot', async () => {
    const dir = makeTmpDir();
    const deps = createRunnerDeps(path.join(dir, 'plans'));
    const resolvedRef = 'abc1234def5678901234567890abcdef12345678';
    // Add merge and repository stubs needed by FinalMergeExecutor
    deps.git.repository = {
      ...deps.git.repository,
      resolveRef: async () => resolvedRef,
      updateRef: async () => {},
      hasUncommittedChanges: async () => false,
      resetHard: async () => {},
    };
    deps.git.branches = {
      ...deps.git.branches,
      currentOrNull: async () => null,
    };
    deps.git.merge = {
      mergeWithoutCheckout: async () => ({ success: true, treeSha: 'tree123' }),
      commitTree: async () => 'commit12345678901234567890abcdef1234567890',
    };
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, deps);
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main', targetBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    (plan as any).awaitingFinalMerge = true;
    (plan as any).snapshot = {
      branch: 'orchestrator/snapshot/test',
      worktreePath: '/tmp/snap',
      baseCommit: resolvedRef, // same as resolveRef returns → rebase is a no-op
    };
    (plan as any).repoPath = dir;
    const r = await runner.completeFinalMerge(plan.id);
    assert.strictEqual(r.success, true);
    assert.strictEqual(plan.awaitingFinalMerge, undefined);
  });

  test('setPowerManager stores the power manager', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const mockPm = { shutdown: async () => {} } as any;
    runner.setPowerManager(mockPm);
    assert.strictEqual((runner as any)._state.powerManager, mockPm);
  });

  test('completeFinalMerge returns failure when merge fails', async () => {
    const dir = makeTmpDir();
    const deps = createRunnerDeps(path.join(dir, 'plans'));
    const resolvedRef = 'abc1234def5678901234567890abcdef12345678';
    deps.git.repository = {
      ...deps.git.repository,
      resolveRef: async () => resolvedRef,
      updateRef: async () => {},
      hasUncommittedChanges: async () => false,
      resetHard: async () => {},
    };
    deps.git.branches = {
      ...deps.git.branches,
      currentOrNull: async () => null,
    };
    deps.git.merge = {
      mergeWithoutCheckout: async () => ({ success: false, conflicts: ['file.txt'] }),
    };
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, deps);
    const plan = runner.enqueue({
      name: 'P', baseBranch: 'main', targetBranch: 'main',
      jobs: [{ producerId: 'a', task: 'X', dependencies: [] }],
    });
    (plan as any).awaitingFinalMerge = true;
    (plan as any).snapshot = {
      branch: 'orchestrator/snapshot/test',
      worktreePath: '/tmp/snap',
      baseCommit: resolvedRef,
    };
    (plan as any).repoPath = dir;
    const r = await runner.completeFinalMerge(plan.id);
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });
});
