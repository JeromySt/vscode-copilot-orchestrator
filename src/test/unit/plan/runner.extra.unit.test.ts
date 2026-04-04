/**
 * @fileoverview Extra unit tests for PlanRunner covering savePlan with planRepository
 * and getStoragePath (lines 328-333, 339-340), plus the ensureBranchReady snapshot
 * creation callback (lines 155-180).
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanRunner } from '../../../plan/runner';
import { PlanConfigManager } from '../../../plan/configManager';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { ProcessMonitor } from '../../../process/processMonitor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';
import type { PlanInstance, NodeExecutionState, JobNode } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-extra-test-'));
  tmpDirs.push(dir);
  return dir;
}

function createMockGit(overrides?: Record<string, any>): any {
  return {
    branches: {
      exists: sinon.stub().resolves(true),
      current: sinon.stub().resolves('main'),
      currentOrNull: sinon.stub().resolves('main'),
      checkout: sinon.stub().resolves(),
      create: sinon.stub().resolves(),
      deleteLocal: sinon.stub().resolves(),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(false),
      ensureOrchestratorGitIgnore: sinon.stub().resolves(false),
    },
    worktrees: {
      removeSafe: sinon.stub().resolves(),
      list: sinon.stub().resolves([]),
      prune: sinon.stub().resolves(),
      createDetachedWithTiming: sinon.stub().resolves(),
    },
    repository: {
      hasChanges: sinon.stub().resolves(false),
      stageFile: sinon.stub().resolves(),
      commit: sinon.stub().resolves(),
      fetch: sinon.stub().resolves(),
      resetHard: sinon.stub().resolves(),
      clean: sinon.stub().resolves(),
    },
    merge: {},
    command: {} as any,
    ...overrides,
  };
}

function createRunnerDeps(storagePath: string, gitOverrides?: Record<string, any>) {
  return {
    configManager: new PlanConfigManager(),
    persistence: new PlanPersistence(storagePath),
    processMonitor: new ProcessMonitor(new DefaultProcessSpawner()),
    stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
    git: createMockGit(gitOverrides),
  };
}

function createMockPlan(id: string, extras?: Partial<PlanInstance>): PlanInstance {
  const node: JobNode = {
    id: 'n1', producerId: 'n1', name: 'Node 1', type: 'job', task: 'test',
    work: 'echo test', dependencies: [], dependents: [],
  };
  return {
    id,
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main', ...extras?.spec },
    jobs: new Map([['n1', node]]),
    producerIdToNodeId: new Map([['n1', 'n1']]),
    roots: ['n1'], leaves: ['n1'],
    nodeStates: new Map([['n1', { status: 'pending', version: 1, attempts: 0 } as NodeExecutionState]]),
    groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
    repoPath: '/repo', baseBranch: 'main',
    worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
    cleanUpSuccessfulWork: false, maxParallel: 4,
    ...extras,
  } as PlanInstance;
}

suite('PlanRunner - savePlan and getStoragePath', () => {
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

  test('savePlan returns false for unknown plan', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    assert.strictEqual(runner.savePlan('nonexistent'), false);
  });

  test('savePlan with plan found, no planRepository returns true', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = createMockPlan('plan-1');
    (runner as any)._state.plans.set('plan-1', plan);
    assert.strictEqual(runner.savePlan('plan-1'), true);
  });

  test('savePlan with planRepository calls saveStateSync', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = createMockPlan('plan-2');
    (runner as any)._state.plans.set('plan-2', plan);
    const mockRepo = { saveStateSync: sinon.stub() };
    (runner as any)._state.planRepository = mockRepo;
    const result = runner.savePlan('plan-2');
    assert.strictEqual(result, true);
    assert.ok(mockRepo.saveStateSync.calledOnce);
    assert.ok(mockRepo.saveStateSync.calledWith(plan));
  });

  test('savePlan continues if planRepository.saveStateSync throws', () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));
    const plan = createMockPlan('plan-3');
    (runner as any)._state.plans.set('plan-3', plan);
    const mockRepo = { saveStateSync: sinon.stub().throws(new Error('DB error')) };
    (runner as any)._state.planRepository = mockRepo;
    // Should not throw - error is caught and logged
    const result = runner.savePlan('plan-3');
    assert.strictEqual(result, true);
    assert.ok(mockRepo.saveStateSync.calledOnce);
  });

  test('getStoragePath returns persistence storage path', () => {
    const dir = makeTmpDir();
    const storagePath = path.join(dir, 'plans');
    const runner = new PlanRunner({ storagePath }, createRunnerDeps(storagePath));
    const result = runner.getStoragePath();
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

suite('PlanRunner - ensureBranchReady callback (snapshot creation)', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;
  let snapshotManagerMod: any;
  let origSnapshotManager: any;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    snapshotManagerMod = require('../../../plan/phases/snapshotManager');
    origSnapshotManager = snapshotManagerMod.SnapshotManager;
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
    snapshotManagerMod.SnapshotManager = origSnapshotManager;
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  test('ensureBranchReady snapshot creation success path (lines 155-175)', async () => {
    const dir = makeTmpDir();
    const snapshotWorktree = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));

    const mockSnapshot = {
      branch: 'orchestrator/snapshot/plan-snap',
      worktreePath: snapshotWorktree,
      baseCommit: 'abc1234',
    };

    // Stub SnapshotManager
    snapshotManagerMod.SnapshotManager = function() {
      return { createSnapshot: async () => mockSnapshot };
    };

    // Create a plan with targetBranch, no snapshot, and SV node
    const svNode: JobNode = {
      id: 'sv1', producerId: '__snapshot-validation__', name: 'SV', type: 'job',
      task: 'SV', work: 'echo sv', dependencies: [], dependents: [],
    };
    const plan = createMockPlan('plan-snap', {
      targetBranch: 'main',
      jobs: new Map([['sv1', svNode]]),
      producerIdToNodeId: new Map([['__snapshot-validation__', 'sv1']]),
    });

    const callback = (runner as any)._pump['ensureBranchReady'];
    assert.ok(typeof callback === 'function', 'ensureBranchReady should be a function');
    await callback(plan);

    // Snapshot should be set on the plan
    assert.ok(plan.snapshot, 'snapshot should have been set');
    assert.strictEqual(plan.snapshot.branch, 'orchestrator/snapshot/plan-snap');
    // SV node should have assignedWorktreePath
    assert.strictEqual(svNode.assignedWorktreePath, snapshotWorktree);
  });

  test('ensureBranchReady snapshot creation failure is non-fatal (lines 176-179)', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));

    // Stub SnapshotManager to throw
    snapshotManagerMod.SnapshotManager = function() {
      return { createSnapshot: async () => { throw new Error('Snapshot failed'); } };
    };

    const plan = createMockPlan('plan-snap2', { targetBranch: 'main' });
    const callback = (runner as any)._pump['ensureBranchReady'];
    // Should not throw - snapshot failure is non-fatal
    await assert.doesNotReject(async () => callback(plan));
    // Plan snapshot should remain undefined
    assert.strictEqual(plan.snapshot, undefined);
  });

  test('ensureBranchReady skips snapshot if already created', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));

    const createSnapshotSpy = sinon.stub().resolves({ branch: 'snap', worktreePath: '/wt', baseCommit: 'abc', originalBaseCommit: 'abc' });
    snapshotManagerMod.SnapshotManager = function() {
      return { createSnapshot: createSnapshotSpy };
    };

    const plan = createMockPlan('plan-snap3', {
      targetBranch: 'main',
      snapshot: { branch: 'existing-snap', worktreePath: '/existing', baseCommit: 'def', originalBaseCommit: 'def' },
    });

    const callback = (runner as any)._pump['ensureBranchReady'];
    await callback(plan);

    // createSnapshot should NOT be called since snapshot already exists
    assert.ok(createSnapshotSpy.notCalled, 'createSnapshot should not be called if snapshot exists');
  });

  test('ensureBranchReady skips snapshot when no targetBranch', async () => {
    const dir = makeTmpDir();
    const runner = new PlanRunner({ storagePath: path.join(dir, 'plans') }, createRunnerDeps(path.join(dir, 'plans')));

    const createSnapshotSpy = sinon.stub().resolves({ branch: 'snap', worktreePath: '/wt', baseCommit: 'abc', originalBaseCommit: 'abc' });
    snapshotManagerMod.SnapshotManager = function() {
      return { createSnapshot: createSnapshotSpy };
    };

    // Plan with no targetBranch
    const plan = createMockPlan('plan-notar', { targetBranch: undefined });

    const callback = (runner as any)._pump['ensureBranchReady'];
    await callback(plan);

    assert.ok(createSnapshotSpy.notCalled, 'createSnapshot should not be called if no targetBranch');
  });
});
