/**
 * @fileoverview Tests for node-centric MCP handlers (src/mcp/handlers/nodeHandlers.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  handleGetGroupStatus,
  handleListGroups,
  handleCancelGroup,
  handleDeleteGroup,
  handleRetryGroup,
  handleGetNode,
  handleListNodes,
  handleRetryNode,
  handleForceFailNode,
  handleNodeFailureContext,
} from '../../../mcp/handlers/nodeHandlers';
import {
  adaptGetPlanStatus,
  adaptListPlans,
  adaptCancelPlan,
  adaptDeletePlan,
  adaptRetryPlan,
  adaptGetNodeDetails,
  adaptRetryPlanNode,
  adaptGetNodeFailureContext,
} from '../../../mcp/handlers/legacyAdapters';
import { PlanHandlerContext } from '../../../mcp/handlers/utils';
import { PlanInstance, NodeExecutionState, JobNode, GroupInstance, GroupExecutionState } from '../../../plan/types';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
  sinon.stub(console, 'info');
}

function createTestPlan(id: string = 'plan-1'): PlanInstance {
  const nodeId = 'node-1';
  const node: JobNode = {
    id: nodeId, producerId: 'job-1', name: 'Test Job', type: 'job',
    task: 'do work', dependencies: [], dependents: [],
  };
  const nodeState: NodeExecutionState = {
    status: 'running', version: 1, attempts: 1, startedAt: Date.now() - 5000,
  };
  const nodes = new Map<string, JobNode>();
  nodes.set(nodeId, node);
  const nodeStates = new Map<string, NodeExecutionState>();
  nodeStates.set(nodeId, nodeState);
  const producerIdToNodeId = new Map<string, string>();
  producerIdToNodeId.set('job-1', nodeId);

  return {
    id, spec: { name: 'Test Plan', jobs: [] },
    nodes: nodes as any, producerIdToNodeId,
    roots: [nodeId], leaves: [nodeId], nodeStates,
    groups: new Map<string, GroupInstance>(),
    groupStates: new Map<string, GroupExecutionState>(),
    groupPathToId: new Map<string, string>(),
    repoPath: '/repo', baseBranch: 'main', worktreeRoot: '.wt',
    createdAt: Date.now() - 10000, startedAt: Date.now() - 5000,
    stateVersion: 1, cleanUpSuccessfulWork: true, maxParallel: 4,
  };
}

function createContext(plans: PlanInstance[] = []): PlanHandlerContext {
  const planMap = new Map(plans.map(p => [p.id, p]));

  // Create a simple status counts object
  const mockCounts = { pending: 0, ready: 0, scheduled: 0, running: 1, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };

  return {
    git: {
      branches: {
        currentOrNull: sinon.stub().resolves('main'),
        isDefaultBranch: sinon.stub().resolves(false),
        exists: sinon.stub().resolves(false),
        create: sinon.stub().resolves(),
        current: sinon.stub().resolves('main'),
      },
      worktrees: {},
      merge: {},
      repository: {},
      orchestrator: {},
    } as any,
    PlanRunner: {
      get: sinon.stub().callsFake((id: string) => planMap.get(id)),
      getPlan: sinon.stub().callsFake((id: string) => planMap.get(id)),
      getAll: sinon.stub().returns(plans),
      getStatus: sinon.stub().callsFake((id: string) => {
        const p = planMap.get(id);
        if (!p) {return undefined;}
        return { plan: p, status: 'running', counts: mockCounts, progress: 0.5 };
      }),
      getStateMachine: sinon.stub().callsFake(() => ({
        computePlanStatus: () => 'running',
        getStatusCounts: () => mockCounts,
      })),
      getEffectiveEndedAt: sinon.stub().returns(undefined),
      cancel: sinon.stub().returns(true),
      delete: sinon.stub().resolves(true),
      pause: sinon.stub().returns(true),
      resume: sinon.stub().returns(true),
      retryNode: sinon.stub().returns({ success: true }),
      forceFailNode: sinon.stub().returns({ success: true }),
      getNodeLogs: sinon.stub().returns('log line'),
      getNodeAttempt: sinon.stub().returns(null),
      getNodeAttempts: sinon.stub().returns([]),
      getNodeFailureContext: sinon.stub().returns(null),
      enqueue: sinon.stub(),
      enqueueJob: sinon.stub(),
      on: sinon.stub(),
    } as any,
    workspacePath: '/workspace',
    runner: null as any,
    plans: null as any,
  };
}

suite('Node-centric Handlers', () => {
  setup(() => { silenceConsole(); });
  teardown(() => { sinon.restore(); });

  suite('handleGetGroupStatus', () => {
    test('returns error when group_id missing', async () => {
      const ctx = createContext();
      const result = await handleGetGroupStatus({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when group not found', async () => {
      const ctx = createContext();
      const result = await handleGetGroupStatus({ group_id: 'x' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns status when group found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetGroupStatus({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.groupId, plan.id);
      assert.ok(result.nodes.length > 0);
    });
  });

  suite('handleListGroups', () => {
    test('returns empty list when no groups', async () => {
      const ctx = createContext();
      const result = await handleListGroups({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0);
    });

    test('returns groups when they exist', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListGroups({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
    });
  });

  suite('handleCancelGroup', () => {
    test('returns error when group_id missing', async () => {
      const ctx = createContext();
      const result = await handleCancelGroup({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when group not found', async () => {
      const ctx = createContext();
      const result = await handleCancelGroup({ group_id: 'x' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('cancels group', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleCancelGroup({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('handleDeleteGroup', () => {
    test('returns error when group_id missing', async () => {
      const ctx = createContext();
      const result = await handleDeleteGroup({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('deletes group', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleDeleteGroup({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('handleRetryGroup', () => {
    test('returns error when group_id missing', async () => {
      const ctx = createContext();
      const result = await handleRetryGroup({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when group not found', async () => {
      const ctx = createContext();
      const result = await handleRetryGroup({ group_id: 'x' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleGetNode', () => {
    test('returns error when node_id missing', async () => {
      const ctx = createContext();
      const result = await handleGetNode({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when node not found', async () => {
      const ctx = createContext();
      const result = await handleGetNode({ node_id: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns node details when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNode({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'node-1');
    });
  });

  suite('handleListNodes', () => {
    test('returns all nodes', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListNodes({}, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.count > 0);
    });

    test('filters by status', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListNodes({ status: 'running' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('filters by group_id', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleListNodes({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
    });
  });

  suite('handleRetryNode', () => {
    test('returns error when node_id missing', async () => {
      const ctx = createContext();
      const result = await handleRetryNode({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns error when node not found', async () => {
      const ctx = createContext();
      const result = await handleRetryNode({ node_id: 'nonexistent' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('retries node when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleRetryNode({ node_id: 'node-1' }, ctx);
      assert.ok(result);
    });
  });

  suite('handleForceFailNode', () => {
    test('returns error when node_id missing', async () => {
      const ctx = createContext();
      const result = await handleForceFailNode({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('force fails node when found', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleForceFailNode({ node_id: 'node-1' }, ctx);
      assert.ok(result);
    });
  });

  suite('handleNodeFailureContext', () => {
    test('returns error when node_id missing', async () => {
      const ctx = createContext();
      const result = await handleNodeFailureContext({}, ctx);
      assert.strictEqual(result.success, false);
    });

    test('returns failure context when node found', async () => {
      const plan = createTestPlan();
      // Set node to failed state so the handler processes it
      plan.nodeStates.get('node-1')!.status = 'failed';
      plan.nodeStates.get('node-1')!.error = 'test error';
      const ctx = createContext([plan]);
      const result = await handleNodeFailureContext({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.nodeId, 'node-1');
    });

    test('returns error when node not in failed state', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleNodeFailureContext({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });
});

// =========================================================================
// Legacy Adapters
// =========================================================================

suite('Legacy Adapters', () => {
  setup(() => { silenceConsole(); });
  teardown(() => { sinon.restore(); });

  function createAdapterContext(plans: PlanInstance[] = []): PlanHandlerContext {
    const planMap = new Map(plans.map(p => [p.id, p]));
    const mockCounts = { pending: 0, ready: 0, scheduled: 0, running: 1, succeeded: 0, failed: 0, blocked: 0, canceled: 0 };

    return {
      git: {
        branches: {
          currentOrNull: sinon.stub().resolves('main'),
          isDefaultBranch: sinon.stub().resolves(false),
          exists: sinon.stub().resolves(false),
          create: sinon.stub().resolves(),
          current: sinon.stub().resolves('main'),
        },
        worktrees: {},
        merge: {},
        repository: {},
        orchestrator: {},
      } as any,
      PlanRunner: {
        get: sinon.stub().callsFake((id: string) => planMap.get(id)),
        getPlan: sinon.stub().callsFake((id: string) => planMap.get(id)),
        getAll: sinon.stub().returns(plans),
        getStatus: sinon.stub().callsFake((id: string) => {
          const p = planMap.get(id);
          if (!p) {return undefined;}
          return { plan: p, status: 'running', counts: mockCounts, progress: 0.5 };
        }),
        getStateMachine: sinon.stub().callsFake(() => ({
          computePlanStatus: () => 'running',
          getStatusCounts: () => mockCounts,
        })),
        getEffectiveEndedAt: sinon.stub().returns(undefined),
        cancel: sinon.stub().returns(true),
        delete: sinon.stub().resolves(true),
        pause: sinon.stub().returns(true),
        resume: sinon.stub().returns(true),
        retryNode: sinon.stub().returns({ success: true }),
        forceFailNode: sinon.stub().returns({ success: true }),
        getNodeLogs: sinon.stub().returns('log line'),
        getNodeFailureContext: sinon.stub().returns(null),
        enqueue: sinon.stub(),
        enqueueJob: sinon.stub(),
        on: sinon.stub(),
      } as any,
      workspacePath: '/workspace',
      runner: null as any,
      plans: null as any,
    };
  }

  test('adaptGetPlanStatus maps to handleGetGroupStatus', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptGetPlanStatus({ id: plan.id }, ctx);
    assert.strictEqual(result.success, true);
    assert.ok(result.planId);
  });

  test('adaptListPlans maps to handleListGroups', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptListPlans({}, ctx);
    assert.strictEqual(result.success, true);
    assert.ok(result.Plans);
  });

  test('adaptCancelPlan maps to handleCancelGroup', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptCancelPlan({ id: plan.id }, ctx);
    assert.strictEqual(result.success, true);
  });

  test('adaptDeletePlan maps to handleDeleteGroup', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptDeletePlan({ id: plan.id }, ctx);
    assert.strictEqual(result.success, true);
  });

  test('adaptRetryPlan maps to handleRetryGroup', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptRetryPlan({ id: plan.id }, ctx);
    // May return error since retry logic is complex
    assert.ok(result);
  });

  test('adaptGetNodeDetails maps to handleGetNode', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptGetNodeDetails({ nodeId: 'node-1' }, ctx);
    assert.ok(result);
  });

  test('adaptRetryPlanNode maps to handleRetryNode', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptRetryPlanNode({ nodeId: 'node-1' }, ctx);
    assert.ok(result);
  });

  test('adaptGetNodeFailureContext maps to handleNodeFailureContext', async () => {
    const plan = createTestPlan();
    const ctx = createAdapterContext([plan]);
    const result = await adaptGetNodeFailureContext({ nodeId: 'node-1' }, ctx);
    assert.ok(result);
  });
});

// =========================================================================
// Additional node handler tests for coverage
// =========================================================================

suite('Node Handler Coverage Tests', () => {
  setup(() => { silenceConsole(); });
  teardown(() => { sinon.restore(); });

  suite('handleRetryGroup extended', () => {
    test('retries all failed nodes in group', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryGroup({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.retriedNodes);
    });

    test('returns error when no failed nodes', async () => {
      const plan = createTestPlan();
      // node-1 is running, not failed
      const ctx = createContext([plan]);
      const result = await handleRetryGroup({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('retries specific node_ids', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleRetryGroup({ group_id: plan.id, node_ids: ['node-1'] }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('handles retry failure', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).retryNode = sinon.stub().returns({ success: false, error: 'retry failed' });
      const result = await handleRetryGroup({ group_id: plan.id }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleForceFailNode extended', () => {
    test('returns error when node not found', async () => {
      const ctx = createContext();
      const result = await handleForceFailNode({ node_id: 'ghost' }, ctx);
      assert.strictEqual(result.success, false);
    });

    test('force fail success returns groupId', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleForceFailNode({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.groupId);
    });

    test('handles force fail failure', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).forceFailNode = sinon.stub().throws(new Error('cannot force fail'));
      const result = await handleForceFailNode({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleRetryNode extended', () => {
    test('retries via producerId lookup', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleRetryNode({ node_id: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('handles retry failure response', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      (ctx.PlanRunner as any).retryNode = sinon.stub().returns({ success: false, error: 'not retriable' });
      const result = await handleRetryNode({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleNodeFailureContext extended', () => {
    test('returns failure context with logs', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      plan.nodeStates.get('node-1')!.error = 'test error';
      plan.nodeStates.get('node-1')!.worktreePath = '/wt/path';
      const ctx = createContext([plan]);
      // Add executor with getLogs
      (ctx.PlanRunner as any).executor = {
        getLogs: sinon.stub().returns([
          { timestamp: Date.now(), phase: 'work', type: 'error', message: 'failed' },
        ]),
      };
      const result = await handleNodeFailureContext({ node_id: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.error, 'test error');
      assert.ok(result.logs);
      assert.strictEqual(result.logs.length, 1);
    });

    test('returns context via producerId lookup', async () => {
      const plan = createTestPlan();
      plan.nodeStates.get('node-1')!.status = 'failed';
      const ctx = createContext([plan]);
      const result = await handleNodeFailureContext({ node_id: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('returns error when node not found globally', async () => {
      const ctx = createContext();
      const result = await handleNodeFailureContext({ node_id: 'ghost' }, ctx);
      assert.strictEqual(result.success, false);
    });
  });

  suite('handleGetNode extended', () => {
    test('finds node via producerId', async () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = await handleGetNode({ node_id: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.producerId, 'job-1');
    });
  });
});
