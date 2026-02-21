import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { handleRetryPlanJob } from '../../../../../mcp/handlers/plan/retryJobHandler';
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
      retryNode: sinon.stub().resolves({ success: true }),
      resume: sinon.stub().resolves(),
      emit: sinon.stub(),
    },
    workspacePath: '/test',
    configProvider: { getConfig: sinon.stub().returns(undefined) },
    git: {},
  };
}

suite('retryNodeHandler', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('rejects PowerShell 2>&1 in new work specs', async () => {
    const node = makeNode('n1');
    const plan = makePlan([node], new Map([['n1', makeState('failed')]]));
    const ctx = makeCtx(plan);
    // newWork must be truthy to enter the validation branch;
    // validatePowerShellCommands traverses 'work'/'prechecks'/'postchecks' fields
    const result = await handleRetryPlanJob({
      planId: 'plan-1', jobId: 'n1',
      newWork: { type: 'shell', command: 'test 2>&1', shell: 'powershell' },
      work: { type: 'shell', command: 'test 2>&1', shell: 'powershell' },
    }, ctx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('2>&1'));
  });
});
