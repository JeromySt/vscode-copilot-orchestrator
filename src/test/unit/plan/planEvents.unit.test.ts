/**
 * @fileoverview Unit tests for PlanEventEmitter
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanEventEmitter } from '../../../plan/planEvents';
import type { PlanInstance, PlanStatus, NodeStatus, NodeTransitionEvent } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function mockPlan(id = 'plan-1'): PlanInstance {
  return {
    id,
    spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
    nodes: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
    nodeStates: new Map(),
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

suite('PlanEventEmitter', () => {
  let quiet: { restore: () => void };
  let emitter: PlanEventEmitter;

  setup(() => {
    quiet = silenceConsole();
    emitter = new PlanEventEmitter();
  });

  teardown(() => {
    quiet.restore();
    emitter.removeAllListeners();
  });

  test('emitPlanCreated fires planCreated event', () => {
    const plan = mockPlan();
    const spy = sinon.spy();
    emitter.on('planCreated', spy);
    emitter.emitPlanCreated(plan);
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], plan);
  });

  test('emitPlanStarted fires planStarted event', () => {
    const plan = mockPlan();
    const spy = sinon.spy();
    emitter.on('planStarted', spy);
    emitter.emitPlanStarted(plan);
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], plan);
  });

  test('emitPlanCompleted fires planCompleted with plan and status', () => {
    const plan = mockPlan();
    const spy = sinon.spy();
    emitter.on('planCompleted', spy);
    emitter.emitPlanCompleted(plan, 'succeeded');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], plan);
    assert.strictEqual(spy.firstCall.args[1], 'succeeded');
  });

  test('emitPlanDeleted fires planDeleted with planId', () => {
    const spy = sinon.spy();
    emitter.on('planDeleted', spy);
    emitter.emitPlanDeleted('plan-42');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 'plan-42');
  });

  test('emitPlanUpdated fires planUpdated with planId', () => {
    const spy = sinon.spy();
    emitter.on('planUpdated', spy);
    emitter.emitPlanUpdated('plan-42');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 'plan-42');
  });

  test('emitNodeTransition fires nodeTransition with event', () => {
    const event = {
      planId: 'plan-1',
      nodeId: 'node-1',
      from: 'pending' as NodeStatus,
      to: 'running' as NodeStatus,
      timestamp: Date.now(),
    };
    const spy = sinon.spy();
    emitter.on('nodeTransition', spy);
    emitter.emitNodeTransition(event);
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], event);
  });

  test('emitNodeStarted fires nodeStarted with planId and nodeId', () => {
    const spy = sinon.spy();
    emitter.on('nodeStarted', spy);
    emitter.emitNodeStarted('plan-1', 'node-1');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 'plan-1');
    assert.strictEqual(spy.firstCall.args[1], 'node-1');
  });

  test('emitNodeCompleted fires nodeCompleted with success flag', () => {
    const spy = sinon.spy();
    emitter.on('nodeCompleted', spy);
    emitter.emitNodeCompleted('plan-1', 'node-1', true);
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[2], true);
  });

  test('emitNodeCompleted fires with false on failure', () => {
    const spy = sinon.spy();
    emitter.on('nodeCompleted', spy);
    emitter.emitNodeCompleted('plan-1', 'node-1', false);
    assert.strictEqual(spy.firstCall.args[2], false);
  });

  test('emitNodeRetry fires nodeRetry event', () => {
    const spy = sinon.spy();
    emitter.on('nodeRetry', spy);
    emitter.emitNodeRetry('plan-1', 'node-1');
    assert.strictEqual(spy.callCount, 1);
    assert.strictEqual(spy.firstCall.args[0], 'plan-1');
    assert.strictEqual(spy.firstCall.args[1], 'node-1');
  });

  test('emitNodeUpdated fires nodeUpdated event', () => {
    const spy = sinon.spy();
    emitter.on('nodeUpdated', spy);
    emitter.emitNodeUpdated('plan-1', 'node-1');
    assert.strictEqual(spy.callCount, 1);
  });

  test('emitNodeTransitionFull fires nodeTransition, nodeUpdated, planUpdated', () => {
    const transitionSpy = sinon.spy();
    const nodeUpdatedSpy = sinon.spy();
    const planUpdatedSpy = sinon.spy();
    emitter.on('nodeTransition', transitionSpy);
    emitter.on('nodeUpdated', nodeUpdatedSpy);
    emitter.on('planUpdated', planUpdatedSpy);

    emitter.emitNodeTransitionFull({
      planId: 'plan-1',
      nodeId: 'node-1',
      previousStatus: 'running',
      newStatus: 'failed',
      reason: 'force-failed',
    });

    assert.strictEqual(transitionSpy.callCount, 1);
    assert.strictEqual(nodeUpdatedSpy.callCount, 1);
    assert.strictEqual(planUpdatedSpy.callCount, 1);
    assert.strictEqual(planUpdatedSpy.firstCall.args[0], 'plan-1');
  });

  test('multiple listeners receive events', () => {
    const spy1 = sinon.spy();
    const spy2 = sinon.spy();
    emitter.on('planDeleted', spy1);
    emitter.on('planDeleted', spy2);
    emitter.emitPlanDeleted('plan-1');
    assert.strictEqual(spy1.callCount, 1);
    assert.strictEqual(spy2.callCount, 1);
  });

  test('emitter extends EventEmitter', () => {
    assert.ok(typeof emitter.on === 'function');
    assert.ok(typeof emitter.emit === 'function');
    assert.ok(typeof emitter.removeAllListeners === 'function');
  });
});
