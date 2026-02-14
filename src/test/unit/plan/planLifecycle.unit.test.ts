/**
 * @fileoverview Unit tests for PlanLifecycleManager
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanLifecycleManager, PlanRunnerState } from '../../../plan/planLifecycle';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import type { PlanInstance, JobNode, NodeExecutionState, PlanStatus } from '../../../plan/types';
import type { ILogger } from '../../../interfaces/ILogger';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockLogger(): ILogger {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    for: () => createMockLogger(),
  } as any;
}

function createTestJobNode(id: string, name: string): JobNode {
  return {
    id, producerId: id, name, type: 'job', task: 'test task',
    dependencies: [], dependents: [],
    work: { type: 'shell', command: 'echo test' },
  };
}

function createTestPlan(id = 'plan-1'): PlanInstance {
  const node = createTestJobNode('node-1', 'Test Job');
  const nodeState: NodeExecutionState = { status: 'pending', attempts: 0, version: 1 };
  return {
    id,
    spec: { name: 'Test Plan', jobs: [{ producerId: 'node-1', name: 'Test Job', task: 'test', work: 'echo hi' }], baseBranch: 'main' },
    nodes: new Map([['node-1', node]]),
    producerIdToNodeId: new Map([['node-1', 'node-1']]),
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: new Map([['node-1', nodeState]]),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  } as PlanInstance;
}

function createState(): PlanRunnerState {
  return {
    plans: new Map(),
    stateMachines: new Map(),
    scheduler: {
      selectNodes: sinon.stub().returns([]),
      getGlobalMaxParallel: sinon.stub().returns(8),
    } as any,
    persistence: {
      save: sinon.stub(),
      saveSync: sinon.stub(),
      loadAll: sinon.stub().returns([]),
      delete: sinon.stub(),
    } as any,
    config: { storagePath: '/tmp/test-plans', defaultRepoPath: '/repo' },
    processMonitor: { isRunning: sinon.stub().returns(false), terminate: sinon.stub().resolves() } as any,
    events: new PlanEventEmitter(),
    configManager: new PlanConfigManager(),
    stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
  };
}

suite('PlanLifecycleManager', () => {
  let quiet: { restore: () => void };
  let state: PlanRunnerState;
  let mgr: PlanLifecycleManager;
  let log: ILogger;

  setup(() => {
    quiet = silenceConsole();
    state = createState();
    log = createMockLogger();
    mgr = new PlanLifecycleManager(state, log, {} as any);
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  // ── Initialization ───────────────────────────────────────────────

  test('initialize loads persisted plans', async () => {
    const plan = createTestPlan();
    (state.persistence.loadAll as sinon.SinonStub).returns([plan]);
    await mgr.initialize();
    assert.strictEqual(state.plans.size, 1);
    assert.strictEqual(state.stateMachines.size, 1);
  });

  test('initialize recovers crashed nodes', async () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    plan.nodeStates.get('node-1')!.pid = 9999;
    (state.persistence.loadAll as sinon.SinonStub).returns([plan]);
    await mgr.initialize();
    assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
    assert.ok(plan.nodeStates.get('node-1')!.error?.includes('crashed'));
  });

  test('initialize recovers running node with no PID', async () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    (state.persistence.loadAll as sinon.SinonStub).returns([plan]);
    await mgr.initialize();
    assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
  });

  test('shutdown persists all plans', async () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    await mgr.shutdown();
    assert.ok((state.persistence.save as sinon.SinonStub).called);
  });

  test('persistSync calls saveSync on all plans', () => {
    state.plans.set('p1', createTestPlan('p1'));
    state.plans.set('p2', createTestPlan('p2'));
    mgr.persistSync();
    assert.strictEqual((state.persistence.saveSync as sinon.SinonStub).callCount, 2);
  });

  // ── Queries ──────────────────────────────────────────────────────

  test('get returns plan by id', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    assert.strictEqual(mgr.get(plan.id), plan);
    assert.strictEqual(mgr.get('non-existent'), undefined);
  });

  test('getAll returns all plans', () => {
    state.plans.set('p1', createTestPlan('p1'));
    state.plans.set('p2', createTestPlan('p2'));
    assert.strictEqual(mgr.getAll().length, 2);
  });

  test('getByStatus filters by computed status', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    const sm = { computePlanStatus: sinon.stub().returns('running') };
    state.stateMachines.set(plan.id, sm as any);
    assert.strictEqual(mgr.getByStatus('running').length, 1);
    assert.strictEqual(mgr.getByStatus('succeeded').length, 0);
  });

  test('getStateMachine returns state machine', () => {
    const sm = { computePlanStatus: sinon.stub() };
    state.stateMachines.set('p1', sm as any);
    assert.strictEqual(mgr.getStateMachine('p1'), sm);
    assert.strictEqual(mgr.getStateMachine('nonexistent'), undefined);
  });

  test('getStatus returns undefined for unknown plan', () => {
    assert.strictEqual(mgr.getStatus('nonexistent'), undefined);
  });

  test('getStatus returns plan status', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    const sm = {
      computePlanStatus: sinon.stub().returns('running'),
      getStatusCounts: sinon.stub().returns({
        pending: 0, ready: 0, scheduled: 0, running: 1,
        succeeded: 0, failed: 0, blocked: 0, canceled: 0,
      }),
    };
    state.stateMachines.set(plan.id, sm as any);
    const result = mgr.getStatus(plan.id)!;
    assert.strictEqual(result.status, 'running');
    assert.ok(result.progress >= 0);
  });

  test('getGlobalStats counts running and queued', () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    state.plans.set(plan.id, plan);
    state.stateMachines.set(plan.id, { computePlanStatus: () => 'running' } as any);
    const stats = mgr.getGlobalStats();
    assert.strictEqual(stats.running, 1);
    assert.strictEqual(stats.maxParallel, 8);
  });

  test('getEffectiveEndedAt returns max endedAt', () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.endedAt = 1000;
    state.plans.set(plan.id, plan);
    assert.strictEqual(mgr.getEffectiveEndedAt(plan.id), 1000);
    assert.strictEqual(mgr.getEffectiveEndedAt('nonexistent'), undefined);
  });

  test('getEffectiveStartedAt returns min startedAt', () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.startedAt = 500;
    state.plans.set(plan.id, plan);
    assert.strictEqual(mgr.getEffectiveStartedAt(plan.id), 500);
    assert.strictEqual(mgr.getEffectiveStartedAt('nonexistent'), undefined);
  });

  test('getRecursiveStatusCounts counts all node statuses', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    const counts = mgr.getRecursiveStatusCounts(plan.id);
    assert.strictEqual(counts.totalNodes, 1);
    assert.strictEqual(counts.counts.pending, 1);
  });

  test('getGlobalCapacityStats returns null when no manager', async () => {
    const result = await mgr.getGlobalCapacityStats();
    assert.strictEqual(result, null);
  });

  // ── Control ──────────────────────────────────────────────────────

  test('pause sets isPaused and persists', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    const wakeLock = sinon.stub().resolves();
    const result = mgr.pause(plan.id, wakeLock);
    assert.strictEqual(result, true);
    assert.strictEqual(plan.isPaused, true);
    assert.ok((state.persistence.save as sinon.SinonStub).called);
  });

  test('pause returns true when already paused', () => {
    const plan = createTestPlan();
    plan.isPaused = true;
    state.plans.set(plan.id, plan);
    assert.strictEqual(mgr.pause(plan.id, sinon.stub().resolves()), true);
  });

  test('pause returns false for unknown plan', () => {
    assert.strictEqual(mgr.pause('nonexistent', sinon.stub().resolves()), false);
  });

  test('cancel cancels all running nodes', () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    state.plans.set(plan.id, plan);
    const sm = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub().returns('running') };
    state.stateMachines.set(plan.id, sm as any);
    state.executor = { cancel: sinon.stub() } as any;
    const result = mgr.cancel(plan.id);
    assert.strictEqual(result, true);
    assert.ok(sm.cancelAll.called);
    assert.ok((state.executor!.cancel as sinon.SinonStub).called);
  });

  test('cancel returns false for unknown plan', () => {
    assert.strictEqual(mgr.cancel('nonexistent'), false);
  });

  test('cancel with skipPersist skips save', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    const sm = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
    state.stateMachines.set(plan.id, sm as any);
    mgr.cancel(plan.id, { skipPersist: true });
    assert.ok(!(state.persistence.save as sinon.SinonStub).called);
  });

  test('delete removes plan and fires event', () => {
    const plan = createTestPlan();
    state.plans.set(plan.id, plan);
    const sm = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
    state.stateMachines.set(plan.id, sm as any);
    const spy = sinon.spy();
    state.events.on('planDeleted', spy);

    const result = mgr.delete(plan.id);
    assert.strictEqual(result, true);
    assert.strictEqual(state.plans.has(plan.id), false);
    assert.ok(spy.called);
  });

  test('delete returns false for unknown plan', () => {
    assert.strictEqual(mgr.delete('nonexistent'), false);
  });

  test('resume clears paused flag and calls startPump', async () => {
    const plan = createTestPlan();
    plan.isPaused = true;
    plan.endedAt = Date.now();
    state.plans.set(plan.id, plan);
    const pumpStub = sinon.stub();
    const result = await mgr.resume(plan.id, pumpStub);
    assert.strictEqual(result, true);
    assert.strictEqual(plan.isPaused, false);
    assert.strictEqual(plan.endedAt, undefined);
    assert.ok(pumpStub.called);
  });

  test('resume returns false for unknown plan', async () => {
    assert.strictEqual(await mgr.resume('nonexistent', sinon.stub()), false);
  });

  // ── State machine listeners ──────────────────────────────────────

  test('setupStateMachineListeners wires transition events', () => {
    const sm = { on: sinon.stub() };
    mgr.setupStateMachineListeners(sm as any);
    assert.ok(sm.on.calledWith('transition'));
    assert.ok(sm.on.calledWith('planComplete'));
  });
});
