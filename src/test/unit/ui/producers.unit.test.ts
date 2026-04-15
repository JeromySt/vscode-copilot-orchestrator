/**
 * @fileoverview Unit tests for UI event producers
 *
 * Covers AiUsageProducer, DependencyStatusProducer, NodeStateProducer,
 * ProcessStatsProducer, PlanStateProducer, PlanListProducer,
 * and the computePhaseStatus / computeCurrentPhase helpers.
 *
 * @module test/unit/ui/producers
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { AiUsageProducer } from '../../../ui/producers/aiUsageProducer';
import { DependencyStatusProducer } from '../../../ui/producers/dependencyStatusProducer';
import {
  NodeStateProducer,
  computePhaseStatus,
  computeCurrentPhase,
} from '../../../ui/producers/nodeStateProducer';
import { ProcessStatsProducer } from '../../../ui/producers/processStatsProducer';
import { PlanStateProducer } from '../../../ui/producers/planStateProducer';
import { PlanListProducer } from '../../../ui/producers/planListProducer';

// ---------------------------------------------------------------------------
// AiUsageProducer
// ---------------------------------------------------------------------------

suite('AiUsageProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makePlan(nodeId: string, metrics: any): any {
    return {
      nodeStates: new Map([[nodeId, { status: 'succeeded', version: 1, attempts: 1, attemptHistory: [{ metrics }] }]]),
    };
  }

  suite('type', () => {
    test('should be "aiUsage"', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new AiUsageProducer(mockRunner);
      assert.strictEqual(producer.type, 'aiUsage');
    });
  });

  suite('readFull', () => {
    test('should return content with null for invalid key (no colon)', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new AiUsageProducer(mockRunner);
      const result = producer.readFull('invalidkey');
      assert.ok(result !== null);
      assert.strictEqual(result.content, null);
    });

    test('should return content with null when plan not found', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new AiUsageProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result.content, null);
    });

    test('should return content with null when no metrics available', () => {
      const plan = {
        nodeStates: new Map([['node1', { status: 'pending', version: 1, attempts: 1 }]]),
      };
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new AiUsageProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result.content, null);
    });

    test('should return content and cursor when metrics available', () => {
      const metrics = {
        premiumRequests: 5,
        apiTimeSeconds: 10,
        sessionTimeSeconds: 20,
        codeChanges: { linesAdded: 100, linesRemoved: 50 },
        modelBreakdown: [{ model: 'gpt-4', inputTokens: 1000, outputTokens: 200 }],
        durationMs: 30000,
      };
      const plan = makePlan('node1', metrics);
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new AiUsageProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result.content!.premiumRequests, 5);
      assert.strictEqual(result.content!.apiTimeSeconds, 10);
      assert.strictEqual(result.content!.sessionTimeSeconds, 20);
      assert.deepStrictEqual(result.content!.modelBreakdown, metrics.modelBreakdown);
      assert.ok(typeof result.cursor === 'string');
    });

    test('should use planId:nodeId key correctly', () => {
      const plan = makePlan('nodeABC', { premiumRequests: 3, durationMs: 1000 });
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new AiUsageProducer(mockRunner);
      const result = producer.readFull('planXYZ:nodeABC');
      assert.ok(result !== null);
      assert.ok(mockRunner.get.calledWith('planXYZ'));
    });
  });

  suite('readDelta', () => {
    test('should return delta (null content) for invalid key when cursor differs', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new AiUsageProducer(mockRunner);
      // Invalid key → null metrics → cursor 'null'; since 'null' !== '{}', returns delta
      const result = producer.readDelta('invalid', '{}');
      assert.ok(result !== null);
      assert.strictEqual(result!.content, null);
    });

    test('should return null for invalid key when cursor already matches null', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new AiUsageProducer(mockRunner);
      assert.strictEqual(producer.readDelta('invalid', 'null'), null);
    });

    test('should return delta (null content) when plan not found and cursor differs', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new AiUsageProducer(mockRunner);
      const result = producer.readDelta('plan1:node1', '{}');
      assert.ok(result !== null);
      assert.strictEqual(result!.content, null);
    });

    test('should return null when no metrics and cursor already matches null serialization', () => {
      const plan = {
        nodeStates: new Map([['node1', { status: 'pending', version: 1, attempts: 1 }]]),
      };
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new AiUsageProducer(mockRunner);
      // No metrics → JSON.stringify(null) = 'null'. If cursor is 'null', no change.
      assert.strictEqual(producer.readDelta('plan1:node1', 'null'), null);
    });

    test('should return null when cursor matches current content', () => {
      const metrics = { premiumRequests: 5, apiTimeSeconds: 10, durationMs: 1000 };
      const plan = makePlan('node1', metrics);
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new AiUsageProducer(mockRunner);
      const full = producer.readFull('plan1:node1')!;
      const delta = producer.readDelta('plan1:node1', full.cursor);
      assert.strictEqual(delta, null);
    });

    test('should return content when cursor differs from current content', () => {
      const metrics = { premiumRequests: 5, apiTimeSeconds: 10, durationMs: 1000 };
      const plan = makePlan('node1', metrics);
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new AiUsageProducer(mockRunner);
      const delta = producer.readDelta('plan1:node1', '{"premiumRequests":0}');
      assert.ok(delta !== null);
      assert.strictEqual(delta!.content!.premiumRequests, 5);
      assert.ok(typeof delta!.cursor === 'string');
    });
  });
});

// ---------------------------------------------------------------------------
// DependencyStatusProducer
// ---------------------------------------------------------------------------

suite('DependencyStatusProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makePlanWithDeps(nodeId: string, deps: string[], depStates: Record<string, string> = {}): any {
    const jobs = new Map<string, any>();
    jobs.set(nodeId, { id: nodeId, name: nodeId, dependencies: deps });
    for (const depId of deps) {
      jobs.set(depId, { id: depId, name: `Job-${depId}`, dependencies: [] });
    }
    const nodeStates = new Map<string, any>();
    nodeStates.set(nodeId, { status: 'running', version: 1, attempts: 1 });
    for (const [depId, status] of Object.entries(depStates)) {
      nodeStates.set(depId, { status, version: 1, attempts: 1 });
    }
    return { jobs, nodeStates };
  }

  suite('type', () => {
    test('should be "deps"', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new DependencyStatusProducer(mockRunner);
      assert.strictEqual(producer.type, 'deps');
    });
  });

  suite('readFull', () => {
    test('should return null content for invalid key (no colon)', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('invalidkey');
      assert.ok(result !== null);
      assert.strictEqual(result.content, null);
    });

    test('should return null content when plan not found', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result.content, null);
    });

    test('should return null content when node not found in plan', () => {
      mockRunner = { get: sandbox.stub().returns({ jobs: new Map(), nodeStates: new Map() }) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result.content, null);
    });

    test('should return empty array for node with no dependencies', () => {
      const plan = makePlanWithDeps('node1', []);
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.deepStrictEqual(result!.content, []);
      assert.strictEqual(result!.cursor, '[]');
    });

    test('should return deps with statuses', () => {
      const plan = makePlanWithDeps('node1', ['dep1', 'dep2'], { dep1: 'succeeded', dep2: 'running' });
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content!.length, 2);
      const dep1 = result!.content!.find((d: any) => d.name === 'Job-dep1');
      const dep2 = result!.content!.find((d: any) => d.name === 'Job-dep2');
      assert.ok(dep1);
      assert.strictEqual(dep1!.status, 'succeeded');
      assert.ok(dep2);
      assert.strictEqual(dep2!.status, 'running');
      assert.ok(result!.cursor.includes('succeeded'));
    });

    test('should default status to "pending" when dep state not found', () => {
      const plan = makePlanWithDeps('node1', ['dep1']);
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content![0].status, 'pending');
    });

    test('should use depId as name when dep job not found', () => {
      const plan = {
        jobs: new Map([['node1', { id: 'node1', name: 'node1', dependencies: ['unknown-dep'] }]]),
        nodeStates: new Map([['node1', { status: 'running', version: 1, attempts: 1 }]]),
      };
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content![0].name, 'unknown-dep');
    });
  });

  suite('readDelta', () => {
    test('should return null when no changes', () => {
      const plan = makePlanWithDeps('node1', ['dep1'], { dep1: 'succeeded' });
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new DependencyStatusProducer(mockRunner);
      const full = producer.readFull('plan1:node1')!;
      const delta = producer.readDelta('plan1:node1', full.cursor);
      assert.strictEqual(delta, null);
    });

    test('should return content when dep status changes', () => {
      const plan = makePlanWithDeps('node1', ['dep1'], { dep1: 'succeeded' });
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new DependencyStatusProducer(mockRunner);
      // Use a cursor that doesn't match current state (old version had pending)
      const delta = producer.readDelta('plan1:node1', '[{"name":"Job-dep1","status":"pending"}]');
      assert.ok(delta !== null);
      assert.strictEqual(delta!.content![0].status, 'succeeded');
    });

    test('should return delta (null content) for invalid key when cursor differs', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new DependencyStatusProducer(mockRunner);
      // Invalid key → null deps → cursor 'null'; since 'null' !== 'other', returns delta
      const result = producer.readDelta('invalid', 'other');
      assert.ok(result !== null);
      assert.strictEqual(result!.content, null);
    });

    test('should return null for invalid key when cursor matches null serialization', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new DependencyStatusProducer(mockRunner);
      assert.strictEqual(producer.readDelta('invalid', 'null'), null);
    });

    test('should return delta (null content) when plan not found and cursor differs', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new DependencyStatusProducer(mockRunner);
      const result = producer.readDelta('plan1:node1', 'other');
      assert.ok(result !== null);
      assert.strictEqual(result!.content, null);
    });
  });
});

// ---------------------------------------------------------------------------
// NodeStateProducer — computePhaseStatus and computeCurrentPhase
// ---------------------------------------------------------------------------

suite('computePhaseStatus', () => {
  function makeState(overrides: any = {}): any {
    return { status: 'pending', version: 1, attempts: 1, ...overrides };
  }

  test('defaults all phases to pending for pending state', () => {
    const result = computePhaseStatus(makeState());
    assert.strictEqual(result['merge-fi'], 'pending');
    assert.strictEqual(result.prechecks, 'pending');
    assert.strictEqual(result.work, 'pending');
    assert.strictEqual(result.commit, 'pending');
    assert.strictEqual(result.postchecks, 'pending');
    assert.strictEqual(result['merge-ri'], 'pending');
  });

  test('copies stepStatuses when available', () => {
    const state = makeState({
      status: 'running',
      stepStatuses: { 'merge-fi': 'success', prechecks: 'success', work: 'running' },
    });
    const result = computePhaseStatus(state);
    assert.strictEqual(result['merge-fi'], 'success');
    assert.strictEqual(result.prechecks, 'success');
    assert.strictEqual(result.work, 'running');
    assert.strictEqual(result.commit, 'pending');
  });

  test('sets all to success for succeeded state without stepStatuses', () => {
    const result = computePhaseStatus(makeState({ status: 'succeeded' }));
    assert.strictEqual(result['merge-fi'], 'success');
    assert.strictEqual(result['merge-ri'], 'success');
    assert.strictEqual(result.work, 'success');
  });

  test('does not override stepStatuses for succeeded state', () => {
    const state = makeState({
      status: 'succeeded',
      stepStatuses: { 'merge-fi': 'success', prechecks: 'skipped', work: 'success', commit: 'success', postchecks: 'skipped', 'merge-ri': 'success' },
    });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.prechecks, 'skipped');
  });

  test('sets merge-ri to failed when failedPhase is merge-ri', () => {
    const state = makeState({ status: 'failed', lastAttempt: { phase: 'merge-ri' } });
    const result = computePhaseStatus(state);
    assert.strictEqual(result['merge-ri'], 'failed');
  });

  test('sets merge-ri failed from error message', () => {
    const state = makeState({ status: 'failed', error: 'Reverse integration merge failed' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result['merge-ri'], 'failed');
  });

  test('sets merge-fi to failed from failedPhase', () => {
    const state = makeState({ status: 'failed', lastAttempt: { phase: 'merge-fi' } });
    const result = computePhaseStatus(state);
    assert.strictEqual(result['merge-fi'], 'failed');
  });

  test('sets merge-fi to failed from error message "merge sources"', () => {
    const state = makeState({ status: 'failed', error: 'Failed to merge sources' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result['merge-fi'], 'failed');
  });

  test('sets prechecks to failed from error message', () => {
    const state = makeState({ status: 'failed', error: 'Prechecks failed' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.prechecks, 'failed');
    assert.strictEqual(result['merge-fi'], 'success');
  });

  test('sets work to failed from error message', () => {
    const state = makeState({ status: 'failed', error: 'Work failed with exit code 1' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.work, 'failed');
  });

  test('sets commit to failed from error message', () => {
    const state = makeState({ status: 'failed', error: 'Commit failed: nothing to commit' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.commit, 'failed');
  });

  test('sets commit to failed from "produced no work" message', () => {
    const state = makeState({ status: 'failed', error: 'Agent produced no work' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.commit, 'failed');
  });

  test('sets postchecks to failed from error message', () => {
    const state = makeState({ status: 'failed', error: 'Postchecks failed' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.postchecks, 'failed');
  });

  test('defaults to work failed for unknown error without stepStatuses', () => {
    const state = makeState({ status: 'failed', error: 'Unknown error' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.work, 'failed');
  });

  test('sets work to running for running state without stepStatuses', () => {
    const result = computePhaseStatus(makeState({ status: 'running' }));
    assert.strictEqual(result.work, 'running');
    assert.strictEqual(result['merge-fi'], 'success');
  });

  test('uses last attempt stepStatuses for pending/ready retried node', () => {
    const state = makeState({
      status: 'ready',
      attemptHistory: [{ stepStatuses: { 'merge-fi': 'success', prechecks: 'success', work: 'failed' } }],
    });
    const result = computePhaseStatus(state);
    assert.strictEqual(result.work, 'failed');
  });

  test('sets merge-fi failed from "Forward integration" error', () => {
    const state = makeState({ status: 'failed', error: 'Forward integration merge failed' });
    const result = computePhaseStatus(state);
    assert.strictEqual(result['merge-fi'], 'failed');
  });
});

suite('computeCurrentPhase', () => {
  function makeState(overrides: any = {}): any {
    return { status: 'pending', version: 1, attempts: 1, ...overrides };
  }

  test('returns undefined when no stepStatuses', () => {
    assert.strictEqual(computeCurrentPhase(makeState()), undefined);
  });

  test('returns running phase from stepStatuses', () => {
    const state = makeState({ stepStatuses: { 'merge-fi': 'success', prechecks: 'running' } });
    assert.strictEqual(computeCurrentPhase(state), 'prechecks');
  });

  test('returns first pending phase when none running', () => {
    const state = makeState({ stepStatuses: { 'merge-fi': 'success', prechecks: 'success' } });
    assert.strictEqual(computeCurrentPhase(state), 'work');
  });

  test('returns undefined when all phases complete', () => {
    const state = makeState({
      stepStatuses: {
        'merge-fi': 'success', prechecks: 'success', work: 'success',
        commit: 'success', postchecks: 'success', 'merge-ri': 'success',
      },
    });
    assert.strictEqual(computeCurrentPhase(state), undefined);
  });
});

suite('NodeStateProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makePlan(nodeId: string, state: any): any {
    return { nodeStates: new Map([[nodeId, state]]), groupStates: new Map() };
  }

  test('type should be "nodeState"', () => {
    mockRunner = { get: sandbox.stub() };
    const producer = new NodeStateProducer(mockRunner);
    assert.strictEqual(producer.type, 'nodeState');
  });

  test('readFull returns null for invalid key', () => {
    mockRunner = { get: sandbox.stub() };
    const producer = new NodeStateProducer(mockRunner);
    assert.strictEqual(producer.readFull('nocoilon'), null);
  });

  test('readFull returns null when plan not found', () => {
    mockRunner = { get: sandbox.stub().returns(undefined) };
    const producer = new NodeStateProducer(mockRunner);
    assert.strictEqual(producer.readFull('plan1:node1'), null);
  });

  test('readFull returns null when node state not found', () => {
    mockRunner = { get: sandbox.stub().returns({ nodeStates: new Map(), groupStates: new Map() }) };
    const producer = new NodeStateProducer(mockRunner);
    assert.strictEqual(producer.readFull('plan1:node1'), null);
  });

  test('readFull returns content with phaseStatus and cursor=version', () => {
    const state = { status: 'running', version: 5, attempts: 1, startedAt: 1000 };
    mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
    const producer = new NodeStateProducer(mockRunner);
    const result = producer.readFull('plan1:node1');
    assert.ok(result !== null);
    assert.strictEqual(result!.cursor, 5);
    assert.strictEqual(result!.content.status, 'running');
    assert.strictEqual(result!.content.startedAt, 1000);
    assert.ok(typeof result!.content.phaseStatus === 'object');
  });

  test('readDelta returns null when version has not advanced', () => {
    const state = { status: 'running', version: 3, attempts: 1 };
    mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
    const producer = new NodeStateProducer(mockRunner);
    const delta = producer.readDelta('plan1:node1', 3);
    assert.strictEqual(delta, null);
  });

  test('readDelta returns content when version advances', () => {
    const state = { status: 'succeeded', version: 7, attempts: 1 };
    mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
    const producer = new NodeStateProducer(mockRunner);
    const delta = producer.readDelta('plan1:node1', 3);
    assert.ok(delta !== null);
    assert.strictEqual(delta!.cursor, 7);
    assert.strictEqual(delta!.content.status, 'succeeded');
  });

  test('readDelta returns null for invalid key', () => {
    mockRunner = { get: sandbox.stub() };
    const producer = new NodeStateProducer(mockRunner);
    assert.strictEqual(producer.readDelta('invalid', 0), null);
  });

  test('readDelta returns null when plan not found', () => {
    mockRunner = { get: sandbox.stub().returns(undefined) };
    const producer = new NodeStateProducer(mockRunner);
    assert.strictEqual(producer.readDelta('plan1:node1', 0), null);
  });
});

// ---------------------------------------------------------------------------
// ProcessStatsProducer
// ---------------------------------------------------------------------------

suite('ProcessStatsProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makePlan(nodeId: string, state: any): any {
    return { nodeStates: new Map([[nodeId, state]]) };
  }

  suite('type', () => {
    test('should be "processStats"', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.type, 'processStats');
    });
  });

  suite('readFull', () => {
    test('returns null for invalid key (no colon)', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readFull('nocoilon'), null);
    });

    test('returns null when plan not found', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readFull('plan1:node1'), null);
    });

    test('returns null when node state not found', () => {
      mockRunner = { get: sandbox.stub().returns({ nodeStates: new Map() }) };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readFull('plan1:node1'), null);
    });

    test('returns stats for running node', () => {
      const state = { status: 'running', pid: 1234, startedAt: 1000, version: 1 };
      mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
      const producer = new ProcessStatsProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.pid, 1234);
      assert.strictEqual(result!.content.running, true);
      assert.ok(result!.content.duration !== null);
      assert.ok(typeof result!.cursor === 'number');
    });

    test('returns stats for non-running node with endedAt', () => {
      const state = { status: 'succeeded', pid: null, startedAt: 1000, endedAt: 5000, version: 1 };
      mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
      const producer = new ProcessStatsProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.pid, null);
      assert.strictEqual(result!.content.running, false);
      assert.strictEqual(result!.content.duration, 4000);
    });

    test('returns null duration when startedAt is missing', () => {
      const state = { status: 'pending', pid: null, version: 1 };
      mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
      const producer = new ProcessStatsProducer(mockRunner);
      const result = producer.readFull('plan1:node1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.duration, null);
    });
  });

  suite('readDelta', () => {
    test('returns null when node is not running', () => {
      const state = { status: 'succeeded', pid: null, version: 1 };
      mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readDelta('plan1:node1', 0), null);
    });

    test('returns stats when node is running', async () => {
      const state = { status: 'running', pid: 5678, startedAt: 1000, version: 1 };
      mockRunner = { get: sandbox.stub().returns(makePlan('node1', state)) };
      const producer = new ProcessStatsProducer(mockRunner);
      await producer.prepareTick();
      const result = producer.readDelta('plan1:node1', 0);
      assert.ok(result !== null);
      assert.strictEqual(result!.content.running, true);
      assert.strictEqual(result!.content.pid, 5678);
    });

    test('returns null for invalid key', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readDelta('nocoilon', 0), null);
    });

    test('returns null when plan not found', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readDelta('plan1:node1', 0), null);
    });

    test('returns null when node state not found', () => {
      mockRunner = { get: sandbox.stub().returns({ nodeStates: new Map() }) };
      const producer = new ProcessStatsProducer(mockRunner);
      assert.strictEqual(producer.readDelta('plan1:node1', 0), null);
    });
  });
});

// ---------------------------------------------------------------------------
// PlanStateProducer
// ---------------------------------------------------------------------------

suite('PlanStateProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makeMockRunner(plan: any, status: any): any {
    return {
      get: sandbox.stub().returns(plan),
      getStatus: sandbox.stub().returns(status),
      getEffectiveStartedAt: sandbox.stub().returns(plan?.startedAt ?? undefined),
      getEffectiveEndedAt: sandbox.stub().returns(plan?.endedAt ?? undefined),
    };
  }

  function makeBaseCounts(): Record<string, number> {
    return {
      pending: 1, ready: 0, scheduled: 0, running: 2,
      succeeded: 3, failed: 0, blocked: 0, canceled: 0,
    };
  }

  suite('type', () => {
    test('should be "planState"', () => {
      mockRunner = { get: sandbox.stub() };
      const producer = new PlanStateProducer(mockRunner);
      assert.strictEqual(producer.type, 'planState');
    });
  });

  suite('readFull', () => {
    test('returns null when plan not found', () => {
      mockRunner = { get: sandbox.stub().returns(undefined), getStatus: sandbox.stub().returns(undefined) };
      const producer = new PlanStateProducer(mockRunner);
      assert.strictEqual(producer.readFull('plan1'), null);
    });

    test('returns null when getStatus returns null', () => {
      const plan = { id: 'plan1', stateVersion: 1 };
      mockRunner = { get: sandbox.stub().returns(plan), getStatus: sandbox.stub().returns(undefined) };
      const producer = new PlanStateProducer(mockRunner);
      assert.strictEqual(producer.readFull('plan1'), null);
    });

    test('returns content with status, counts, progress, timestamps', () => {
      const plan = { id: 'plan1', stateVersion: 5, startedAt: 1000, endedAt: 5000 };
      const counts = makeBaseCounts();
      const status = { status: 'running', counts, progress: 50 };
      mockRunner = makeMockRunner(plan, status);
      const producer = new PlanStateProducer(mockRunner);
      const result = producer.readFull('plan1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.status, 'running');
      assert.strictEqual(result!.content.progress, 50);
      assert.strictEqual(result!.cursor, 5);
      assert.strictEqual(result!.content.startedAt, 1000);
      assert.strictEqual(result!.content.endedAt, 5000);
    });

    test('returns null startedAt/endedAt when not available', () => {
      const plan = { id: 'plan1', stateVersion: 1 };
      const status = { status: 'pending', counts: makeBaseCounts(), progress: 0 };
      mockRunner = {
        get: sandbox.stub().returns(plan),
        getStatus: sandbox.stub().returns(status),
        getEffectiveStartedAt: sandbox.stub().returns(undefined),
        getEffectiveEndedAt: sandbox.stub().returns(undefined),
      };
      const producer = new PlanStateProducer(mockRunner);
      const result = producer.readFull('plan1');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.startedAt, null);
      assert.strictEqual(result!.content.endedAt, null);
    });
  });

  suite('readDelta', () => {
    test('returns deleted status when plan not found', () => {
      mockRunner = { get: sandbox.stub().returns(undefined) };
      const producer = new PlanStateProducer(mockRunner);
      const result = producer.readDelta('plan1', 0);
      assert.ok(result !== null, 'should return deleted signal, not null');
      assert.strictEqual(result!.content.status, 'deleted');
    });

    test('returns null when stateVersion has not advanced', () => {
      const plan = { id: 'plan1', stateVersion: 3 };
      mockRunner = { get: sandbox.stub().returns(plan) };
      const producer = new PlanStateProducer(mockRunner);
      assert.strictEqual(producer.readDelta('plan1', 3), null);
    });

    test('returns content when stateVersion advances', () => {
      const plan = { id: 'plan1', stateVersion: 7 };
      const counts = makeBaseCounts();
      const status = { status: 'succeeded', counts, progress: 100 };
      mockRunner = makeMockRunner(plan, status);
      const producer = new PlanStateProducer(mockRunner);
      const result = producer.readDelta('plan1', 3);
      assert.ok(result !== null);
      assert.strictEqual(result!.content.status, 'succeeded');
      assert.strictEqual(result!.cursor, 7);
    });
  });
});

// ---------------------------------------------------------------------------
// PlanListProducer
// ---------------------------------------------------------------------------

suite('PlanListProducer', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makePlan(id: string, stateVersion: number, parentPlanId?: string): any {
    return {
      id,
      parentPlanId,
      stateVersion,
      createdAt: 1000,
      startedAt: undefined,
      endedAt: undefined,
      jobs: new Map([['j1', {}]]),
      spec: { name: `Plan-${id}` },
    };
  }

  function makeMockRunnerWithPlans(plans: any[], statusMap: Record<string, any>): any {
    return {
      getAll: sandbox.stub().returns(plans),
      getStatus: sandbox.stub().callsFake((planId: string) => statusMap[planId]),
      getEffectiveEndedAt: sandbox.stub().returns(undefined),
    };
  }

  suite('type', () => {
    test('should be "planList"', () => {
      mockRunner = { getAll: sandbox.stub().returns([]) };
      const producer = new PlanListProducer(mockRunner);
      assert.strictEqual(producer.type, 'planList');
    });
  });

  suite('readFull', () => {
    test('returns empty array when no plans', () => {
      mockRunner = { getAll: sandbox.stub().returns([]) };
      const producer = new PlanListProducer(mockRunner);
      const result = producer.readFull('all');
      assert.ok(result !== null);
      assert.deepStrictEqual(result!.content, []);
    });

    test('excludes plans with parentPlanId', () => {
      const plans = [
        makePlan('plan1', 1),
        makePlan('child1', 1, 'plan1'),
      ];
      const counts = { pending: 1, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      const statusMap = { plan1: { status: 'pending', counts, progress: 0 } };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      const result = producer.readFull('all');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.length, 1);
      assert.strictEqual(result!.content[0].id, 'plan1');
    });

    test('returns correct summary fields', () => {
      const plans = [makePlan('plan1', 3)];
      const counts = { pending: 1, ready: 0, scheduled: 0, running: 2, succeeded: 3, failed: 1, blocked: 0, canceled: 0 };
      const statusMap = { plan1: { status: 'running', counts, progress: 60 } };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      const result = producer.readFull('all');
      assert.ok(result !== null);
      const summary = result!.content[0];
      assert.strictEqual(summary.id, 'plan1');
      assert.strictEqual(summary.name, 'Plan-plan1');
      assert.strictEqual(summary.status, 'running');
      assert.strictEqual(summary.stateVersion, 3);
      assert.strictEqual(summary.progress, 60);
      assert.strictEqual(summary.counts.running, 2);
      assert.strictEqual(summary.counts.succeeded, 3);
      assert.strictEqual(summary.counts.failed, 1);
      assert.strictEqual(summary.counts.pending, 1); // pending + ready
      assert.strictEqual(summary.nodes, 1);
    });

    test('handles missing statusInfo gracefully', () => {
      const plans = [makePlan('plan1', 1)];
      mockRunner = makeMockRunnerWithPlans(plans, {});
      const producer = new PlanListProducer(mockRunner);
      const result = producer.readFull('all');
      assert.ok(result !== null);
      assert.strictEqual(result!.content[0].status, 'pending');
      assert.strictEqual(result!.content[0].progress, 0);
    });

    test('builds cursor with planId → stateVersion mapping', () => {
      const plans = [makePlan('plan1', 5), makePlan('plan2', 3)];
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      const statusMap = {
        plan1: { status: 'pending', counts, progress: 0 },
        plan2: { status: 'pending', counts, progress: 0 },
      };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      const result = producer.readFull('all');
      assert.ok(result !== null);
      const cursorObj = JSON.parse(result!.cursor);
      assert.strictEqual(cursorObj.plan1, 5);
      assert.strictEqual(cursorObj.plan2, 3);
    });
  });

  suite('readDelta', () => {
    test('returns null when no plans changed', () => {
      const plans = [makePlan('plan1', 5)];
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 1, failed: 0, blocked: 0, canceled: 0 };
      const statusMap = { plan1: { status: 'succeeded', counts, progress: 100 } };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      const cursor = JSON.stringify({ plan1: 5 });
      assert.strictEqual(producer.readDelta('all', cursor), null);
    });

    test('returns only changed plans when stateVersion advances', () => {
      const plans = [makePlan('plan1', 7), makePlan('plan2', 2)];
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      const statusMap = {
        plan1: { status: 'running', counts, progress: 50 },
        plan2: { status: 'pending', counts, progress: 0 },
      };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      // plan1 version changed from 5 to 7, plan2 unchanged (version=2, cursor=2)
      const cursor = JSON.stringify({ plan1: 5, plan2: 2 });
      const result = producer.readDelta('all', cursor);
      assert.ok(result !== null);
      assert.strictEqual(result!.content.changed.length, 1);
      assert.strictEqual(result!.content.changed[0].id, 'plan1');
    });

    test('returns full list on malformed cursor', () => {
      const plans = [makePlan('plan1', 1)];
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      const statusMap = { plan1: { status: 'pending', counts, progress: 0 } };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      const result = producer.readDelta('all', 'not-valid-json');
      assert.ok(result !== null);
      assert.strictEqual(result!.content.changed.length, 1);
    });

    test('returns new plan (not in cursor) as changed', () => {
      const plans = [makePlan('plan1', 1), makePlan('plan2', 1)];
      const counts = { pending: 0, ready: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };
      const statusMap = {
        plan1: { status: 'pending', counts, progress: 0 },
        plan2: { status: 'pending', counts, progress: 0 },
      };
      mockRunner = makeMockRunnerWithPlans(plans, statusMap);
      const producer = new PlanListProducer(mockRunner);
      // plan2 is new (not in old cursor)
      const cursor = JSON.stringify({ plan1: 1 });
      const result = producer.readDelta('all', cursor);
      assert.ok(result !== null);
      assert.strictEqual(result!.content.changed.length, 1);
      assert.strictEqual(result!.content.changed[0].id, 'plan2');
    });
  });
});
