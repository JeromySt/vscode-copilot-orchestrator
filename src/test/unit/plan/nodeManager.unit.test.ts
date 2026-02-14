/**
 * @fileoverview Unit tests for NodeManager
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { NodeManager, NodeManagerState } from '../../../plan/nodeManager';
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

function createTestPlan(opts?: { nodeStatus?: string; pid?: number }): PlanInstance {
  const node = createTestJobNode('node-1', 'Test Job');
  const nodeState: NodeExecutionState = {
    status: (opts?.nodeStatus || 'failed') as any,
    attempts: 1,
    version: 1,
    pid: opts?.pid,
    error: 'test error',
    startedAt: Date.now(),
    endedAt: opts?.nodeStatus === 'running' ? undefined : Date.now(),
    lastAttempt: { phase: 'work' as any, startTime: Date.now() },
  };
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
  } as PlanInstance;
}

function createState(plan?: PlanInstance): NodeManagerState {
  const p = plan || createTestPlan();
  return {
    plans: new Map([[p.id, p]]),
    stateMachines: new Map([[p.id, {
      getReadyNodes: sinon.stub().returns([]),
      resetNodeToPending: sinon.stub(),
      computePlanStatus: sinon.stub().returns('running'),
    }]]) as any,
    persistence: { save: sinon.stub(), saveSync: sinon.stub() } as any,
    executor: {
      execute: sinon.stub().resolves({ success: true }),
      cancel: sinon.stub(),
      getLogs: sinon.stub().returns([]),
      getLogsForPhase: sinon.stub().returns([]),
      getLogFilePath: sinon.stub().returns('/logs/test.log'),
    } as any,
    events: new PlanEventEmitter(),
    processMonitor: { isRunning: sinon.stub().returns(false), terminate: sinon.stub().resolves() } as any,
  };
}

suite('NodeManager', () => {
  let quiet: { restore: () => void };
  let state: NodeManagerState;
  let mgr: NodeManager;
  let log: ILogger;

  setup(() => {
    quiet = silenceConsole();
    state = createState();
    log = createMockLogger();
    mgr = new NodeManager(state, log, {} as any);
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  // ── Log queries ──────────────────────────────────────────────────

  test('getNodeLogs returns "No executor" when no executor', () => {
    state.executor = undefined;
    assert.strictEqual(mgr.getNodeLogs('plan-1', 'node-1'), 'No executor available.');
  });

  test('getNodeLogs returns formatted logs', () => {
    (state.executor!.getLogs as sinon.SinonStub).returns([
      { timestamp: Date.now(), phase: 'work', type: 'info', message: 'hello' },
    ]);
    const result = mgr.getNodeLogs('plan-1', 'node-1');
    assert.ok(result.includes('hello'));
  });

  test('getNodeLogs filters by phase', () => {
    (state.executor!.getLogsForPhase as sinon.SinonStub).returns([
      { timestamp: Date.now(), phase: 'work', type: 'info', message: 'phase log' },
    ]);
    const result = mgr.getNodeLogs('plan-1', 'node-1', 'work');
    assert.ok(result.includes('phase log'));
  });

  test('getNodeLogs returns "No logs" when empty', () => {
    const result = mgr.getNodeLogs('plan-1', 'node-1');
    assert.ok(result.includes('No logs'));
  });

  test('getNodeLogFilePath returns path from executor', () => {
    const path = mgr.getNodeLogFilePath('plan-1', 'node-1');
    assert.strictEqual(path, '/logs/test.log');
  });

  test('getNodeLogFilePath returns undefined when no executor', () => {
    state.executor = undefined;
    assert.strictEqual(mgr.getNodeLogFilePath('plan-1', 'node-1'), undefined);
  });

  test('getNodeLogsFromOffset returns logs from offset', () => {
    (state.executor!.getLogs as sinon.SinonStub).returns([
      { timestamp: Date.now(), phase: 'work', type: 'info', message: 'line1' },
      { timestamp: Date.now(), phase: 'work', type: 'info', message: 'line2' },
    ]);
    const result = mgr.getNodeLogsFromOffset('plan-1', 'node-1', 1, 0);
    assert.ok(result.includes('line2'));
  });

  test('getNodeLogsFromOffset returns "No executor" when none', () => {
    state.executor = undefined;
    assert.strictEqual(mgr.getNodeLogsFromOffset('plan-1', 'node-1', 0, 0), 'No executor available.');
  });

  // ── Attempt queries ──────────────────────────────────────────────

  test('getNodeAttempt returns null for unknown plan', () => {
    assert.strictEqual(mgr.getNodeAttempt('nonexistent', 'node-1', 1), null);
  });

  test('getNodeAttempt returns null when no history', () => {
    assert.strictEqual(mgr.getNodeAttempt('plan-1', 'node-1', 1), null);
  });

  test('getNodeAttempt returns attempt by number', () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.attemptHistory = [
      { attemptNumber: 1, startedAt: 100, endedAt: 200, success: false } as any,
    ];
    const attempt = mgr.getNodeAttempt('plan-1', 'node-1', 1);
    assert.ok(attempt);
    assert.strictEqual(attempt!.attemptNumber, 1);
  });

  test('getNodeAttempts returns empty for unknown plan', () => {
    assert.deepStrictEqual(mgr.getNodeAttempts('nonexistent', 'node-1'), []);
  });

  test('getNodeAttempts returns attempt history', () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.attemptHistory = [
      { attemptNumber: 1, startedAt: 100, endedAt: 200, success: false } as any,
    ];
    assert.strictEqual(mgr.getNodeAttempts('plan-1', 'node-1').length, 1);
  });

  // ── Process stats ────────────────────────────────────────────────

  test('getProcessStats returns empty when no executor', async () => {
    state.executor = undefined;
    const stats = await mgr.getProcessStats('plan-1', 'node-1');
    assert.strictEqual(stats.pid, null);
    assert.strictEqual(stats.running, false);
  });

  test('getProcessStats delegates to executor', async () => {
    (state.executor as any).getProcessStats = sinon.stub().resolves({
      pid: 123, running: true, tree: [], duration: 1000,
    });
    const stats = await mgr.getProcessStats('plan-1', 'node-1');
    assert.strictEqual(stats.pid, 123);
  });

  test('getAllProcessStats returns empty for unknown plan', async () => {
    const result = await mgr.getAllProcessStats('nonexistent');
    assert.deepStrictEqual(result.flat, []);
  });

  test('getAllProcessStats returns empty when no executor', async () => {
    state.executor = undefined;
    const result = await mgr.getAllProcessStats('plan-1');
    assert.deepStrictEqual(result.flat, []);
  });

  test('getAllProcessStats collects running nodes', async () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    (state.executor as any).getAllProcessStats = sinon.stub().resolves([
      { planId: 'plan-1', nodeId: 'node-1', pid: 42, running: true, tree: [], duration: 100 },
    ]);
    const result = await mgr.getAllProcessStats('plan-1');
    assert.strictEqual(result.flat.length, 1);
    assert.strictEqual(result.flat[0].pid, 42);
  });

  // ── Failure context ──────────────────────────────────────────────

  test('getNodeFailureContext returns error for unknown plan', () => {
    const ctx = mgr.getNodeFailureContext('nonexistent', 'node-1');
    assert.ok('error' in ctx);
  });

  test('getNodeFailureContext returns error for unknown node', () => {
    const ctx = mgr.getNodeFailureContext('plan-1', 'nonexistent');
    assert.ok('error' in ctx);
  });

  test('getNodeFailureContext returns context for failed node', () => {
    const ctx = mgr.getNodeFailureContext('plan-1', 'node-1');
    assert.ok(!('error' in ctx));
    assert.strictEqual((ctx as any).errorMessage, 'test error');
    assert.strictEqual((ctx as any).phase, 'work');
  });

  // ── Force fail ───────────────────────────────────────────────────

  test('forceFailNode throws for unknown plan', async () => {
    await assert.rejects(() => mgr.forceFailNode('nonexistent', 'node-1'), /Plan.*not found/);
  });

  test('forceFailNode throws for unknown node', async () => {
    await assert.rejects(() => mgr.forceFailNode('plan-1', 'nonexistent'), /Node.*not found/);
  });

  test('forceFailNode sets node to failed', async () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    await mgr.forceFailNode('plan-1', 'node-1');
    const ns = plan.nodeStates.get('node-1')!;
    assert.strictEqual(ns.status, 'failed');
    assert.strictEqual(ns.forceFailed, true);
    assert.ok(ns.endedAt);
  });

  test('forceFailNode cancels executor', async () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    await mgr.forceFailNode('plan-1', 'node-1');
    assert.ok((state.executor!.cancel as sinon.SinonStub).called);
  });

  test('forceFailNode kills process', async () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    plan.nodeStates.get('node-1')!.pid = 9999;
    await mgr.forceFailNode('plan-1', 'node-1');
    assert.ok((state.processMonitor.terminate as sinon.SinonStub).calledWith(9999, true));
  });

  test('forceFailNode increments attempts for running node', async () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    plan.nodeStates.get('node-1')!.attempts = 1;
    await mgr.forceFailNode('plan-1', 'node-1');
    assert.strictEqual(plan.nodeStates.get('node-1')!.attempts, 2);
  });

  test('forceFailNode emits transition event', async () => {
    const spy = sinon.spy();
    state.events.on('nodeTransition', spy);
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    await mgr.forceFailNode('plan-1', 'node-1');
    assert.ok(spy.called);
  });

  // ── Retry ────────────────────────────────────────────────────────

  test('retryNode fails for unknown plan', async () => {
    const result = await mgr.retryNode('nonexistent', 'node-1');
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Plan not found'));
  });

  test('retryNode fails for non-failed node', async () => {
    const plan = state.plans.get('plan-1')!;
    plan.nodeStates.get('node-1')!.status = 'running';
    const result = await mgr.retryNode('plan-1', 'node-1');
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('not in failed state'));
  });

  test('retryNode resets failed node to pending', async () => {
    const plan = state.plans.get('plan-1')!;
    const pumpStub = sinon.stub();
    const result = await mgr.retryNode('plan-1', 'node-1', undefined, pumpStub);
    assert.strictEqual(result.success, true);
    assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'pending');
    assert.ok(pumpStub.called);
  });

  test('retryNode accepts new work spec', async () => {
    const plan = state.plans.get('plan-1')!;
    const newWork = { type: 'shell' as const, command: 'echo new' };
    const result = await mgr.retryNode('plan-1', 'node-1', { newWork });
    assert.strictEqual(result.success, true);
    const jobNode = plan.nodes.get('node-1') as JobNode;
    assert.deepStrictEqual(jobNode.work, newWork);
  });

  test('retryNode emits nodeRetry event', async () => {
    const spy = sinon.spy();
    state.events.on('nodeRetry', spy);
    await mgr.retryNode('plan-1', 'node-1');
    assert.ok(spy.called);
  });

  test('retryNode with clearWorktree rejects when upstream has commits', async () => {
    const plan = state.plans.get('plan-1')!;
    const depNode = createTestJobNode('dep-1', 'Dep Job');
    depNode.dependents = ['node-1'];
    plan.nodes.set('dep-1', depNode);
    const node = plan.nodes.get('node-1')!;
    node.dependencies = ['dep-1'];
    plan.nodeStates.set('dep-1', {
      status: 'succeeded',
      attempts: 1,
      version: 1,
      completedCommit: 'abc123',
    } as any);
    plan.nodeStates.get('node-1')!.worktreePath = '/wt/node-1';

    const result = await mgr.retryNode('plan-1', 'node-1', { clearWorktree: true });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('upstream'));
  });
});
