import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { handleBulkUpdatePlanJobs } from '../../../../../mcp/handlers/plan/bulkUpdateJobsHandler';
import type { PlanInstance, PlanNode, NodeExecutionState, AgentSpec } from '../../../../../plan/types';

function makeAgentNode(id: string, opts: Partial<PlanNode> & { effort?: string; model?: string } = {}): PlanNode {
  const work: AgentSpec = {
    type: 'agent',
    instructions: 'do work',
    effort: (opts.effort as any) ?? 'medium',
    ...(opts.model ? { model: opts.model } : {}),
  } as AgentSpec;
  return {
    id,
    producerId: opts.producerId ?? id,
    name: opts.name ?? id,
    type: 'job',
    task: opts.task ?? 'do stuff',
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
    work,
  } as PlanNode;
}

function makeShellNode(id: string): PlanNode {
  return {
    id,
    producerId: id,
    name: id,
    type: 'job',
    task: 'shell job',
    dependencies: [],
    dependents: [],
    work: { type: 'shell', command: 'echo hi', shell: 'bash' },
  } as PlanNode;
}

function makeState(status: string, extras: Partial<NodeExecutionState> = {}): NodeExecutionState {
  return { status: status as any, version: 0, attempts: 0, ...extras } as NodeExecutionState;
}

function makePlan(nodes: PlanNode[], states: Map<string, NodeExecutionState>): PlanInstance {
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
  } as PlanInstance;
}

function makeCtx(plan: PlanInstance | undefined): any {
  return {
    PlanRunner: {
      getPlan: sinon.stub().returns(plan),
      get: sinon.stub().returns(plan),
      savePlan: sinon.stub(),
      emit: sinon.stub(),
    },
    workspacePath: '/test',
  };
}

suite('bulkUpdateJobsHandler', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('updates failed jobs (primary use case: update model/effort before retry)', async () => {
    const failed = makeAgentNode('failed-job', { effort: 'medium' });
    const plan = makePlan([failed], new Map([['failed-job', makeState('failed', { attempts: 1 })]]));
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { model: 'claude-opus-4.6', effort: 'high' },
    }, ctx);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.updated, 1);
    assert.deepStrictEqual(result.updatedJobs, ['failed-job']);
    const updatedWork = failed.work as AgentSpec;
    assert.strictEqual(updatedWork.model, 'claude-opus-4.6');
    assert.strictEqual(updatedWork.effort, 'high');
  });

  test('updates blocked jobs (so they pick up new spec when unblocked)', async () => {
    const blocked = makeAgentNode('blocked-job', { effort: 'medium' });
    const plan = makePlan([blocked], new Map([['blocked-job', makeState('blocked')]]));
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { effort: 'high' },
    }, ctx);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.updated, 1);
    assert.strictEqual((blocked.work as AgentSpec).effort, 'high');
  });

  test('skips running, succeeded, and canceled jobs', async () => {
    const running = makeAgentNode('running-job');
    const succeeded = makeAgentNode('succeeded-job');
    const canceled = makeAgentNode('canceled-job');
    const states = new Map<string, NodeExecutionState>([
      ['running-job', makeState('running')],
      ['succeeded-job', makeState('succeeded')],
      ['canceled-job', makeState('canceled')],
    ]);
    const plan = makePlan([running, succeeded, canceled], states);
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { effort: 'high' },
    }, ctx);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 3);
    const reasons = (result.skippedDetails as { id: string; reason: string }[]).map(s => s.reason).sort();
    assert.deepStrictEqual(reasons, ['status=canceled', 'status=running', 'status=succeeded']);
  });

  test('updates pending and ready jobs', async () => {
    const pending = makeAgentNode('pending-job');
    const ready = makeAgentNode('ready-job');
    const plan = makePlan(
      [pending, ready],
      new Map([['pending-job', makeState('pending')], ['ready-job', makeState('ready')]]),
    );
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { model: 'claude-opus-4.6' },
    }, ctx);

    assert.strictEqual(result.updated, 2);
  });

  test('skips non-agent (shell) work specs', async () => {
    const shellNode = makeShellNode('shell-job');
    const plan = makePlan([shellNode], new Map([['shell-job', makeState('failed')]]));
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { effort: 'high' },
    }, ctx);

    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual((result.skippedDetails as { id: string; reason: string }[])[0].reason, 'not an agent work spec');
  });

  test('rejects non-bulk-safe fields', async () => {
    const node = makeAgentNode('n1');
    const plan = makePlan([node], new Map([['n1', makeState('failed')]]));
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { instructions: 'new instructions' },
    }, ctx);

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('cannot be bulk-updated'));
  });

  test('scopes update to provided jobIds', async () => {
    const a = makeAgentNode('a', { effort: 'medium' });
    const b = makeAgentNode('b', { effort: 'medium' });
    const plan = makePlan(
      [a, b],
      new Map([['a', makeState('failed')], ['b', makeState('failed')]]),
    );
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      jobIds: ['a'],
      updates: { effort: 'high' },
    }, ctx);

    assert.strictEqual(result.updated, 1);
    assert.strictEqual((a.work as AgentSpec).effort, 'high');
    assert.strictEqual((b.work as AgentSpec).effort, 'medium');
  });

  test('skips snapshot-validation node', async () => {
    const sv = makeAgentNode('sv-id', { producerId: '__snapshot-validation__' });
    const plan = makePlan([sv], new Map([['sv-id', makeState('failed')]]));
    const ctx = makeCtx(plan);

    const result = await handleBulkUpdatePlanJobs({
      planId: 'plan-1',
      updates: { effort: 'high' },
    }, ctx);

    assert.strictEqual(result.updated, 0);
  });
});
