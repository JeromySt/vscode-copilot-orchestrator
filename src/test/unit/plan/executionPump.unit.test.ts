/**
 * @fileoverview Unit tests for ExecutionPump
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ExecutionPump, ExecutionPumpState, ExecuteNodeCallback } from '../../../plan/executionPump';
import { PlanEventEmitter } from '../../../plan/planEvents';
import type { PlanInstance, JobNode, NodeExecutionState } from '../../../plan/types';
import type { ILogger } from '../../../interfaces/ILogger';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockLogger(): ILogger {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
    for: () => createMockLogger(),
  } as any;
}

function createTestJobNode(id: string, name: string): JobNode {
  return {
    id,
    producerId: id,
    name,
    type: 'job',
    task: 'test task',
    dependencies: [],
    dependents: [],
    work: { type: 'shell', command: 'echo test' },
  };
}

function createTestPlan(opts?: { isPaused?: boolean; startedAt?: number }): PlanInstance {
  const node = createTestJobNode('node-1', 'Test Job');
  const nodeState: NodeExecutionState = { status: 'ready', attempts: 0, version: 1 };
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
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
    isPaused: opts?.isPaused,
    startedAt: opts?.startedAt,
  } as PlanInstance;
}

function createMockStateMachine(status: string = 'running') {
  return {
    computePlanStatus: sinon.stub().returns(status),
    getReadyNodes: sinon.stub().returns(['node-1']),
    getStatusCounts: sinon.stub().returns({
      pending: 0, ready: 1, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0,
    }),
    transition: sinon.stub(),
    areDependenciesMet: sinon.stub().returns(true),
    resetNodeToPending: sinon.stub(),
  };
}

function createMockScheduler() {
  return {
    selectNodes: sinon.stub().returns(['node-1']),
    getGlobalMaxParallel: sinon.stub().returns(8),
  };
}

function createState(plan?: PlanInstance, sm?: any): ExecutionPumpState {
  const p = plan || createTestPlan();
  const s = sm || createMockStateMachine();
  return {
    plans: new Map([[p.id, p]]),
    stateMachines: new Map([[p.id, s]]),
    scheduler: createMockScheduler() as any,
    persistence: { save: sinon.stub(), saveSync: sinon.stub() } as any,
    executor: {
      execute: sinon.stub().resolves({ success: true }),
      cancel: sinon.stub(),
    } as any,
    config: { storagePath: '/tmp/plans', pumpInterval: 100 },
    events: new PlanEventEmitter(),
  };
}

suite('ExecutionPump', () => {
  let quiet: { restore: () => void };
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    quiet = silenceConsole();
    clock = sinon.useFakeTimers();
  });

  teardown(() => {
    quiet.restore();
    clock.restore();
    sinon.restore();
  });

  test('startPump creates interval timer', () => {
    const state = createState();
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    // Second call should be no-op
    pump.startPump();
    pump.stopPump();
  });

  test('stopPump clears interval timer', () => {
    const state = createState();
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    pump.stopPump();
    // Should be safe to call again
    pump.stopPump();
  });

  test('hasRunningPlans returns true when plan is running', () => {
    const state = createState();
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    assert.strictEqual(pump.hasRunningPlans(), true);
  });

  test('hasRunningPlans returns false when no plans', () => {
    const state = createState();
    state.plans.clear();
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    assert.strictEqual(pump.hasRunningPlans(), false);
  });

  test('hasRunningPlans returns false when plan is completed', () => {
    const sm = createMockStateMachine('succeeded');
    const state = createState(undefined, sm);
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    assert.strictEqual(pump.hasRunningPlans(), false);
  });

  test('pump skips when no executor', async () => {
    const state = createState();
    state.executor = undefined;
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    await clock.tickAsync(200);
    assert.strictEqual(cb.callCount, 0);
    pump.stopPump();
  });

  test('pump calls executeNode for ready nodes', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    await clock.tickAsync(200);
    assert.ok(cb.callCount >= 1);
    assert.strictEqual(sm.transition.callCount, cb.callCount);
    pump.stopPump();
  });

  test('pump skips paused plans', async () => {
    const plan = createTestPlan({ isPaused: true });
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    await clock.tickAsync(200);
    assert.strictEqual(cb.callCount, 0);
    pump.stopPump();
  });

  test('pump skips completed plans', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('succeeded');
    const state = createState(plan, sm);
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    await clock.tickAsync(200);
    assert.strictEqual(cb.callCount, 0);
    pump.stopPump();
  });

  test('pump marks plan as started on first running cycle', async () => {
    const plan = createTestPlan();
    assert.strictEqual(plan.startedAt, undefined);
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    const eventSpy = sinon.spy(state.events, 'emitPlanStarted');
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    await clock.tickAsync(200);
    assert.ok(plan.startedAt);
    assert.ok(eventSpy.called);
    pump.stopPump();
  });

  test('pump promotes stuck pending nodes', async () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'pending';
    const sm = createMockStateMachine('running');
    sm.getReadyNodes.returns([]);
    (sm as any).selectNodes = sinon.stub().returns([]);
    const state = createState(plan, sm);
    state.scheduler.selectNodes = sinon.stub().returns([]) as any;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    await clock.tickAsync(200);
    assert.ok(sm.resetNodeToPending.called);
    pump.stopPump();
  });

  test('pump persists after scheduling', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    await clock.tickAsync(200);
    assert.ok((state.persistence.save as sinon.SinonStub).called);
    pump.stopPump();
  });

  test('updateWakeLock handles no running plans gracefully', async () => {
    const sm = createMockStateMachine('succeeded');
    const state = createState(undefined, sm);
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    // No running plans, so this should just return without acquiring a lock
    await pump.updateWakeLock();
  });

  test('pump updates global capacity when available', async () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    const sm = createMockStateMachine('running');
    sm.getReadyNodes.returns([]);
    const state = createState(plan, sm);
    state.scheduler.selectNodes = sinon.stub().returns([]) as any;
    state.globalCapacity = {
      updateRunningJobs: sinon.stub().resolves(),
      getTotalGlobalRunning: sinon.stub().resolves(1),
    } as any;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    await clock.tickAsync(200);
    assert.ok((state.globalCapacity!.updateRunningJobs as sinon.SinonStub).called);
    pump.stopPump();
  });

  test('updateWakeLock acquires lock when plans are running', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    const releaseFn = sinon.stub();
    state.powerManager = {
      acquireWakeLock: sinon.stub().resolves(releaseFn),
    } as any;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    await pump.updateWakeLock();
    assert.ok((state.powerManager!.acquireWakeLock as sinon.SinonStub).calledOnce);
  });

  test('updateWakeLock releases lock when no plans are running', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    const releaseFn = sinon.stub();
    state.powerManager = {
      acquireWakeLock: sinon.stub().resolves(releaseFn),
    } as any;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    // First acquire the lock
    await pump.updateWakeLock();
    assert.ok((state.powerManager!.acquireWakeLock as sinon.SinonStub).calledOnce);
    // Now make the plan "succeeded" so no running plans
    sm.computePlanStatus.returns('succeeded');
    await pump.updateWakeLock();
    assert.ok(releaseFn.calledOnce);
  });

  test('updateWakeLock handles acquireWakeLock failure', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    state.powerManager = {
      acquireWakeLock: sinon.stub().rejects(new Error('lock failed')),
    } as any;
    const log = createMockLogger();
    const pump = new ExecutionPump(state, log, sinon.stub());
    await pump.updateWakeLock();
    assert.ok((log.warn as sinon.SinonStub).called);
  });

  test('updateWakeLock returns early when no powerManager', async () => {
    const state = createState();
    state.powerManager = undefined;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    await pump.updateWakeLock(); // should not throw
  });

  test('pump liveness watchdog detects dead PID', async () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    (plan.nodeStates.get('node-1')! as any).pid = 12345;
    (plan.nodeStates.get('node-1')! as any).startedAt = Date.now();
    const sm = createMockStateMachine('running');
    sm.getReadyNodes.returns([]);
    const state = createState(plan, sm);
    state.scheduler.selectNodes = sinon.stub().returns([]) as any;
    state.processMonitor = { isRunning: sinon.stub().returns(false) } as any;
    const log = createMockLogger();
    const pump = new ExecutionPump(state, log, sinon.stub());
    pump.startPump();
    // Need 10+ pump cycles for watchdog to trigger
    await clock.tickAsync(1100);
    assert.ok(sm.transition.called);
    assert.ok((log.warn as sinon.SinonStub).called);
    pump.stopPump();
  });

  test('pump liveness watchdog skips alive PID', async () => {
    const plan = createTestPlan();
    plan.nodeStates.get('node-1')!.status = 'running';
    (plan.nodeStates.get('node-1')! as any).pid = 12345;
    const sm = createMockStateMachine('running');
    sm.getReadyNodes.returns([]);
    const state = createState(plan, sm);
    state.scheduler.selectNodes = sinon.stub().returns([]) as any;
    state.processMonitor = { isRunning: sinon.stub().returns(true) } as any;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    await clock.tickAsync(1100);
    assert.strictEqual(sm.transition.callCount, 0);
    pump.stopPump();
  });

  test('pump logs bottleneck when ready nodes exist but none scheduled', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    sm.getReadyNodes.returns(['node-1']);
    const state = createState(plan, sm);
    state.scheduler.selectNodes = sinon.stub().returns([]) as any;
    const log = createMockLogger();
    const pump = new ExecutionPump(state, log, sinon.stub());
    pump.startPump();
    await clock.tickAsync(200);
    assert.ok((log.debug as sinon.SinonStub).called);
    pump.stopPump();
  });

  test('pump skips node when nodes.get returns undefined', async () => {
    const plan = createTestPlan();
    const sm = createMockStateMachine('running');
    const state = createState(plan, sm);
    // Scheduler returns a node ID that doesn't exist in the plan
    state.scheduler.selectNodes = sinon.stub().returns(['nonexistent']) as any;
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    await clock.tickAsync(200);
    // executeNode should not be called for the nonexistent node
    assert.strictEqual(cb.callCount, 0);
    pump.stopPump();
  });

  test('pump handles plan with no state machine gracefully', async () => {
    const plan = createTestPlan();
    const state = createState(plan);
    state.stateMachines.clear();
    const cb = sinon.stub();
    const pump = new ExecutionPump(state, createMockLogger(), cb);
    pump.startPump();
    await clock.tickAsync(200);
    assert.strictEqual(cb.callCount, 0);
    pump.stopPump();
  });

  test('hasRunningPlans returns false when state machine is missing', () => {
    const plan = createTestPlan();
    const state = createState(plan);
    state.stateMachines.clear();
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    assert.strictEqual(pump.hasRunningPlans(), false);
  });

  test('pump counts work-performing running nodes for local capacity', async () => {
    const plan = createTestPlan();
    // Set the node to have work and be running
    const node = plan.nodes.get('node-1')!;
    (node as any).work = { type: 'shell', command: 'echo test' };
    plan.nodeStates.get('node-1')!.status = 'running';
    const sm = createMockStateMachine('running');
    sm.getReadyNodes.returns([]);
    const state = createState(plan, sm);
    state.scheduler.selectNodes = sinon.stub().returns([]) as any;
    state.globalCapacity = {
      updateRunningJobs: sinon.stub().resolves(),
      getTotalGlobalRunning: sinon.stub().resolves(1),
    } as any;
    const pump = new ExecutionPump(state, createMockLogger(), sinon.stub());
    pump.startPump();
    await clock.tickAsync(200);
    const updateStub = state.globalCapacity!.updateRunningJobs as sinon.SinonStub;
    assert.ok(updateStub.called);
    assert.strictEqual(updateStub.firstCall.args[0], 1); // 1 local running job
    pump.stopPump();
  });
});
