import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { handleUpdatePlanJob } from '../../../../../mcp/handlers/plan/updateJobHandler';
import type { PlanInstance, PlanNode, NodeExecutionState } from '../../../../../plan/types';

function makeNode(id: string, opts: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    producerId: opts.producerId ?? id,
    name: opts.name ?? id,
    type: 'job',
    task: opts.task ?? 'do stuff',
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
  } as PlanNode;
}

function makeState(status: string, extras: Partial<NodeExecutionState> = {}): NodeExecutionState {
  return { status: status as any, version: 0, attempts: 0, ...extras } as NodeExecutionState;
}

function makePlan(
  nodes: PlanNode[],
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

function makeCtx(plan: PlanInstance | undefined): any {
  return {
    PlanRunner: {
      getPlan: sinon.stub().returns(plan),
      get: sinon.stub().returns(plan),
      savePlan: sinon.stub(),
      emit: sinon.stub(),
      resume: sinon.stub().resolves(),
    },
    workspacePath: '/test',
    configProvider: { getConfig: sinon.stub().returns(undefined) },
    git: {},
  };
}

suite('updateNodeHandler', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('rejects PowerShell 2>&1 commands', async () => {
    const node = makeNode('n1');
    const plan = makePlan([node], new Map([['n1', makeState('failed')]]));
    const ctx = makeCtx(plan);
    const result = await handleUpdatePlanJob({
      planId: 'plan-1', jobId: 'n1',
      work: { type: 'shell', command: 'cmd 2>&1', shell: 'powershell' },
    }, ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('2>&1'));
  });

  test('rejects SV node updates', async () => {
    const svNode = makeNode('sv-id', { producerId: '__snapshot-validation__', name: 'Snapshot Validation' });
    const plan = makePlan([svNode], new Map([['sv-id', makeState('failed')]]));
    const ctx = makeCtx(plan);
    const result = await handleUpdatePlanJob({
      planId: 'plan-1', jobId: 'sv-id',
      work: 'echo hello',
    }, ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('auto-managed'));
  });

  test('successful update returns expected fields', async () => {
    const node = makeNode('n1');
    const plan = makePlan([node], new Map([['n1', makeState('failed')]]));
    const ctx = makeCtx(plan);
    const result = await handleUpdatePlanJob({
      planId: 'plan-1', jobId: 'n1',
      work: 'echo hello',
    }, ctx);
    assert.strictEqual(result.success, true);
    assert.ok(result.message);
    assert.strictEqual(result.planId, 'plan-1');
    assert.strictEqual(result.jobId, 'n1');
  });

  test('does not set resumeFromPhase for never-executed nodes', async () => {
    // Node that has never been executed (attempts=0, status=pending)
    const node = makeNode('n1');
    const nodeState = makeState('pending', { attempts: 0 });
    const plan = makePlan([node], new Map([['n1', nodeState]]));
    const ctx = makeCtx(plan);
    
    // Update only postchecks on a never-executed node
    const result = await handleUpdatePlanJob({
      planId: 'plan-1', jobId: 'n1',
      postchecks: { type: 'shell', command: 'echo ok', shell: 'bash' },
    }, ctx);
    
    assert.strictEqual(result.success, true);
    // Critical: resumeFromPhase should NOT be set for a node that's never executed
    // Setting it would cause merge-fi and other phases to be skipped on first execution
    assert.strictEqual(nodeState.resumeFromPhase, undefined);
  });

  test('sets resumeFromPhase for previously-executed nodes', async () => {
    // Node that has been executed (attempts > 0, status=failed)
    const node = makeNode('n1');
    const nodeState = makeState('failed', { attempts: 1 });
    const plan = makePlan([node], new Map([['n1', nodeState]]));
    const ctx = makeCtx(plan);
    
    // Update postchecks on a failed node
    const result = await handleUpdatePlanJob({
      planId: 'plan-1', jobId: 'n1',
      postchecks: { type: 'shell', command: 'echo ok', shell: 'bash' },
    }, ctx);
    
    assert.strictEqual(result.success, true);
    // For a node that has executed, resumeFromPhase should be set
    assert.strictEqual(nodeState.resumeFromPhase, 'postchecks');
  });
});
