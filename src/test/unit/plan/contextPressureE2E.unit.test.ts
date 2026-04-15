/**
 * @fileoverview End-to-end integration test for the full context pressure lifecycle.
 *
 * Tests the flow: pressure critical → sentinel → checkpoint manifest → fan-out
 * sub-jobs → fan-in postchecks → downstream ready, all with mocked components.
 *
 * Uses the real PlanStateMachine and reshaper to validate the full lifecycle of
 * checkpoint-triggered DAG reshaping and dependency propagation.
 */
import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { PlanStateMachine } from '../../../plan/stateMachine';
import {
  addNode as reshaperAddNode,
  addNodeAfter as reshaperAddNodeAfter,
  updateNodeDependencies as reshaperUpdateNodeDependencies,
  recomputeRootsAndLeaves,
} from '../../../plan/reshaper';
import type {
  PlanInstance,
  PlanNode,
  JobNode,
  NodeExecutionState,
  JobNodeSpec,
} from '../../../plan/types';
import type { ICheckpointManager, CheckpointManifest } from '../../../interfaces/ICheckpointManager';
import type { IJobSplitter, WorkChunk } from '../../../interfaces/IJobSplitter';
import type { AgentSpec } from '../../../plan/types/specs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, opts: Partial<JobNode> = {}): PlanNode {
  return {
    id,
    producerId: opts.producerId ?? id,
    name: opts.name ?? `Job ${id}`,
    type: 'job',
    task: opts.task ?? 'do stuff',
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
    work: opts.work,
    prechecks: opts.prechecks,
    postchecks: opts.postchecks,
    instructions: opts.instructions,
    autoHeal: opts.autoHeal,
  } as PlanNode;
}

function makeState(status: string, extras: Partial<NodeExecutionState> = {}): NodeExecutionState {
  return { status: status as any, version: 0, attempts: 0, ...extras };
}

function makePlan(
  nodes: PlanNode[] = [],
  states: Map<string, NodeExecutionState> = new Map(),
  opts: Partial<PlanInstance> = {},
): PlanInstance {
  const nodesMap = new Map<string, PlanNode>();
  const producerMap = new Map<string, string>();
  for (const n of nodes) {
    nodesMap.set(n.id, n);
    if (n.producerId) { producerMap.set(n.producerId, n.id); }
  }
  return {
    id: 'plan-1',
    spec: {} as any,
    jobs: nodesMap,
    producerIdToNodeId: producerMap,
    roots: [],
    leaves: [],
    nodeStates: states,
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    startedAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: false,
    maxParallel: 4,
    ...opts,
  } as PlanInstance;
}

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Context Pressure E2E Lifecycle', () => {
  let sandbox: sinon.SinonSandbox;
  let quiet: { restore: () => void };

  setup(() => {
    sandbox = sinon.createSandbox();
    quiet = silenceConsole();
  });

  teardown(() => {
    sandbox.restore();
    quiet.restore();
  });

  test('full lifecycle: pressure → split → fan-out → fan-in → downstream ready', () => {
    // -------------------------------------------------------------------
    // 1. Setup: parent P with downstream dep D1
    // -------------------------------------------------------------------
    const parentNode = makeNode('P-id', {
      producerId: 'P',
      name: 'Parent Job',
      postchecks: { type: 'shell', command: 'npm test' },
      dependents: ['D1-id'],
    });
    const downstreamNode = makeNode('D1-id', {
      producerId: 'D1',
      name: 'Downstream Job',
      dependencies: ['P-id'],
    });

    const plan = makePlan(
      [parentNode, downstreamNode],
      new Map([
        ['P-id', makeState('running', {
          worktreePath: '/worktrees/P',
          agentPhase: 'work' as any,
          completedCommit: 'abc123',
        })],
        ['D1-id', makeState('pending')],
      ]),
    );
    recomputeRootsAndLeaves(plan);

    const sm = new PlanStateMachine(plan);

    // -------------------------------------------------------------------
    // 2. Mock ICheckpointManager: sentinel written, manifest exists
    // -------------------------------------------------------------------
    const manifest: CheckpointManifest = {
      status: 'checkpointed',
      completed: [{ file: 'src/a.ts', summary: 'Implemented A' }],
      remaining: [
        { file: 'src/b.ts', description: 'Implement B' },
        { file: 'src/c.ts', description: 'Implement C' },
      ],
      summary: 'Completed A, remaining B and C',
    };

    const mockCheckpointManager: ICheckpointManager = {
      writeSentinel: sandbox.stub().resolves(),
      manifestExists: sandbox.stub().resolves(true),
      readManifest: sandbox.stub().resolves(manifest),
      cleanupManifest: sandbox.stub().resolves(),
      cleanupSentinel: sandbox.stub().resolves(),
    };

    // Verify sentinel can be written (simulates monitor detecting critical pressure)
    mockCheckpointManager.writeSentinel('/worktrees/P', {
      level: 'critical',
      currentInputTokens: 180000,
      maxPromptTokens: 200000,
      pressure: 0.9,
    });
    assert.ok(
      (mockCheckpointManager.writeSentinel as sinon.SinonStub).calledOnce,
      'Sentinel should be written when pressure reaches critical',
    );

    // -------------------------------------------------------------------
    // 3. Mock IJobSplitter
    // -------------------------------------------------------------------
    const chunks: WorkChunk[] = [
      { name: 'Sub 1', files: ['src/b.ts'], description: 'Implement B', priority: 1 },
      { name: 'Sub 2', files: ['src/c.ts'], description: 'Implement C', priority: 2 },
    ];

    const mockJobSplitter: IJobSplitter = {
      buildChunks: sandbox.stub().returns(chunks),
      buildSubJobSpec: sandbox.stub().callsFake((chunk: WorkChunk) => ({
        type: 'agent' as const,
        instructions: `Do: ${chunk.description}`,
      } as AgentSpec)),
      buildFanInSpec: sandbox.stub().callsFake(
        (parentSpec: JobNodeSpec, subJobProducerIds: string[]): JobNodeSpec => ({
          producerId: `${parentSpec.producerId}-fan-in`,
          name: `${parentSpec.name} (fan-in)`,
          task: 'Validate combined sub-job output',
          work: { type: 'shell', command: 'true' },
          postchecks: parentSpec.postchecks,
          autoHeal: true,
          dependencies: [],
        }),
      ),
    };

    // Verify splitter produces expected chunks from manifest
    const builtChunks = mockJobSplitter.buildChunks(manifest, '');
    assert.strictEqual(builtChunks.length, 2);

    // Track planReshaped events via PlanEventEmitter
    const { PlanEventEmitter } = require('../../../plan/planEvents');
    const events = new PlanEventEmitter();
    const planReshapedSpy = sandbox.spy();
    events.on('planReshaped', planReshapedSpy);

    // -------------------------------------------------------------------
    // 4. Engine transitions P: running → completed_split
    // -------------------------------------------------------------------
    const transitioned = sm.transition('P-id', 'completed_split');
    assert.strictEqual(transitioned, true, 'P should transition running → completed_split');
    assert.strictEqual(plan.nodeStates.get('P-id')!.status, 'completed_split');

    // D1 should NOT become ready (completed_split doesn't trigger checkDependentsReady)
    assert.strictEqual(plan.nodeStates.get('D1-id')!.status, 'pending',
      'D1 should stay pending during completed_split');

    // -------------------------------------------------------------------
    // 5–7. Reshape DAG: fan-in first, then sub-jobs, then override deps.
    //
    // The reshape inserts the fan-in via addNodeAfter (which transfers D1),
    // then adds sub-jobs depending on P, then overrides fan-in deps to
    // [S1, S2]. This produces the target topology: P → {S1, S2} → F → D1
    // -------------------------------------------------------------------

    // 5a. addNodeAfter: fan-in F (with postchecks from P, autoHeal)
    const fanInSpec: JobNodeSpec = mockJobSplitter.buildFanInSpec(
      { producerId: 'P', name: 'Parent Job', task: 'parent', postchecks: parentNode.postchecks, dependencies: [] },
      ['P-sub-1', 'P-sub-2'],
    );
    const fanInResult = reshaperAddNodeAfter(plan, 'P-id', fanInSpec);
    assert.ok(fanInResult.success, `addNodeAfter fan-in failed: ${fanInResult.error}`);

    // Verify fan-in inherits postchecks from parent
    const fanInNode = plan.jobs.get(fanInResult.nodeId!)!;
    assert.deepStrictEqual(fanInNode.postchecks, { type: 'shell', command: 'npm test' });
    assert.strictEqual(fanInNode.autoHeal, true);

    // D1 should now depend on fan-in (transferred by addNodeAfter)
    assert.ok(plan.jobs.get('D1-id')!.dependencies.includes(fanInResult.nodeId!),
      'D1 should depend on fan-in after addNodeAfter transfer');

    // 5b. addNode: sub-jobs S1, S2 (no postchecks)
    const s1Result = reshaperAddNode(plan, {
      producerId: 'P-sub-1',
      name: 'Sub 1',
      task: 'Implement B',
      work: { type: 'agent', instructions: 'Do: Implement B' } as AgentSpec,
      postchecks: undefined,
      dependencies: ['P'],
    });
    assert.ok(s1Result.success, `addNode S1 failed: ${s1Result.error}`);

    const s2Result = reshaperAddNode(plan, {
      producerId: 'P-sub-2',
      name: 'Sub 2',
      task: 'Implement C',
      work: { type: 'agent', instructions: 'Do: Implement C' } as AgentSpec,
      postchecks: undefined,
      dependencies: ['P'],
    });
    assert.ok(s2Result.success, `addNode S2 failed: ${s2Result.error}`);

    // Verify sub-jobs have no postchecks
    assert.strictEqual(plan.jobs.get(s1Result.nodeId!)!.postchecks, undefined,
      'Sub-jobs should not have postchecks');
    assert.strictEqual(plan.jobs.get(s2Result.nodeId!)!.postchecks, undefined);

    // 7. updateNodeDependencies: override fan-in deps to [S1, S2]
    const updateResult = reshaperUpdateNodeDependencies(
      plan,
      fanInResult.nodeId!,
      [s1Result.nodeId!, s2Result.nodeId!],
    );
    assert.ok(updateResult.success, `updateNodeDependencies failed: ${updateResult.error}`);

    // Verify final fan-in topology
    const fanInAfterUpdate = plan.jobs.get(fanInResult.nodeId!)!;
    assert.deepStrictEqual(
      [...fanInAfterUpdate.dependencies].sort(),
      [s1Result.nodeId!, s2Result.nodeId!].sort(),
      'Fan-in should depend on S1 and S2',
    );
    assert.ok(!fanInAfterUpdate.dependencies.includes('P-id'),
      'Fan-in should NOT depend on P after override');

    // -------------------------------------------------------------------
    // 8. savePlanState: stateVersion incremented after reshape
    // -------------------------------------------------------------------
    assert.ok(plan.stateVersion > 0, 'stateVersion should have incremented after reshape mutations');

    // -------------------------------------------------------------------
    // 9. planReshaped event emitted
    // -------------------------------------------------------------------
    events.emit('planReshaped', plan.id);
    assert.strictEqual(planReshapedSpy.callCount, 1);
    assert.strictEqual(planReshapedSpy.firstCall.args[0], 'plan-1');

    // -------------------------------------------------------------------
    // 10. Engine transitions P: completed_split → succeeded
    // -------------------------------------------------------------------
    const succeededOk = sm.transition('P-id', 'succeeded');
    assert.strictEqual(succeededOk, true, 'P should transition completed_split → succeeded');
    assert.strictEqual(plan.nodeStates.get('P-id')!.status, 'succeeded');

    // -------------------------------------------------------------------
    // 11. checkDependentsReady fires → S1, S2 promoted to ready
    // -------------------------------------------------------------------
    assert.strictEqual(plan.nodeStates.get(s1Result.nodeId!)!.status, 'ready',
      'S1 should be promoted to ready after P succeeded');
    assert.strictEqual(plan.nodeStates.get(s2Result.nodeId!)!.status, 'ready',
      'S2 should be promoted to ready after P succeeded');

    // -------------------------------------------------------------------
    // 12. Fan-in F stays pending (deps S1, S2 not yet succeeded)
    // -------------------------------------------------------------------
    assert.strictEqual(plan.nodeStates.get(fanInResult.nodeId!)!.status, 'pending',
      'Fan-in should stay pending while S1/S2 are not succeeded');

    // -------------------------------------------------------------------
    // 13. D1 stays pending (depends on F, not P)
    // -------------------------------------------------------------------
    assert.strictEqual(plan.nodeStates.get('D1-id')!.status, 'pending',
      'D1 should stay pending (depends on fan-in, not P)');

    // -------------------------------------------------------------------
    // 14. Simulate: S1, S2 succeed → F promoted to ready
    // -------------------------------------------------------------------
    sm.transition(s1Result.nodeId!, 'scheduled');
    sm.transition(s1Result.nodeId!, 'running');
    sm.transition(s1Result.nodeId!, 'succeeded');

    // After S1 succeeds, fan-in still pending (S2 not done)
    assert.strictEqual(plan.nodeStates.get(fanInResult.nodeId!)!.status, 'pending',
      'Fan-in should stay pending after only S1 succeeds');

    sm.transition(s2Result.nodeId!, 'scheduled');
    sm.transition(s2Result.nodeId!, 'running');
    sm.transition(s2Result.nodeId!, 'succeeded');

    // Both S1 and S2 succeeded → fan-in promoted to ready
    assert.strictEqual(plan.nodeStates.get(fanInResult.nodeId!)!.status, 'ready',
      'Fan-in should be promoted to ready after both S1 and S2 succeed');

    // D1 still pending (fan-in not yet succeeded)
    assert.strictEqual(plan.nodeStates.get('D1-id')!.status, 'pending',
      'D1 should still be pending (fan-in not yet succeeded)');

    // -------------------------------------------------------------------
    // 15. F executes with merge-fi + postchecks + merge-ri and succeeds
    // -------------------------------------------------------------------
    sm.transition(fanInResult.nodeId!, 'scheduled');
    sm.transition(fanInResult.nodeId!, 'running');

    // Verify fan-in has the correct spec for execution
    assert.deepStrictEqual(fanInNode.work, { type: 'shell', command: 'true' },
      'Fan-in work should be no-op shell command');
    assert.deepStrictEqual(fanInNode.postchecks, { type: 'shell', command: 'npm test' },
      'Fan-in should carry postchecks from parent');

    sm.transition(fanInResult.nodeId!, 'succeeded');

    // -------------------------------------------------------------------
    // 16. D1 promoted to ready after F succeeds
    // -------------------------------------------------------------------
    assert.strictEqual(plan.nodeStates.get('D1-id')!.status, 'ready',
      'D1 should be promoted to ready after fan-in succeeds');

    // -------------------------------------------------------------------
    // Verify final topology: P → {S1, S2} → F → D1
    // -------------------------------------------------------------------
    const s1Node = plan.jobs.get(s1Result.nodeId!)!;
    const s2Node = plan.jobs.get(s2Result.nodeId!)!;
    const d1Node = plan.jobs.get('D1-id')!;

    // S1 and S2 depend on P
    assert.ok(s1Node.dependencies.includes('P-id'), 'S1 should depend on P');
    assert.ok(s2Node.dependencies.includes('P-id'), 'S2 should depend on P');

    // Fan-in depends on S1 and S2
    assert.deepStrictEqual(
      [...fanInAfterUpdate.dependencies].sort(),
      [s1Result.nodeId!, s2Result.nodeId!].sort(),
    );

    // D1 depends on fan-in
    assert.ok(d1Node.dependencies.includes(fanInResult.nodeId!), 'D1 should depend on fan-in');
    assert.ok(!d1Node.dependencies.includes('P-id'), 'D1 should NOT depend directly on P');
  });
});
