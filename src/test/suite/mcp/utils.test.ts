/**
 * @fileoverview Tests for MCP handler utilities (src/mcp/handlers/utils.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  errorResult,
  validateRequired,
  lookupPlan,
  lookupNode,
  isError,
  resolveBaseBranch,
  resolveTargetBranch,
  PlanHandlerContext,
} from '../../../mcp/handlers/utils';
import * as git from '../../../git';
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
    status: 'running', version: 1, attempts: 1,
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
    createdAt: Date.now(), stateVersion: 1,
    cleanUpSuccessfulWork: true, maxParallel: 4,
  };
}

function createContext(plans: PlanInstance[] = []): PlanHandlerContext {
  const planMap = new Map(plans.map(p => [p.id, p]));
  return {
    PlanRunner: {
      get: sinon.stub().callsFake((id: string) => planMap.get(id)),
      getPlan: sinon.stub().callsFake((id: string) => planMap.get(id)),
      getAll: sinon.stub().returns(plans),
    } as any,
    workspacePath: '/workspace',
    git: {} as any,
    runner: null as any,
    plans: null as any,
  };
}

suite('MCP Handler Utils', () => {
  setup(() => { silenceConsole(); });
  teardown(() => { sinon.restore(); });

  suite('errorResult', () => {
    test('returns standard error shape', () => {
      const result = errorResult('test error');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'test error');
    });
  });

  suite('validateRequired', () => {
    test('returns null for present fields', () => {
      const result = validateRequired({ a: 1, b: 2 }, ['a', 'b']);
      assert.strictEqual(result, null);
    });

    test('returns error for missing field', () => {
      const result = validateRequired({ a: 1 }, ['a', 'b']);
      assert.ok(result);
      assert.strictEqual(result!.success, false);
      assert.ok(result!.error.includes('b'));
    });
  });

  suite('isError', () => {
    test('returns true for error result', () => {
      assert.strictEqual(isError({ success: false, error: 'msg' }), true);
    });

    test('returns false for success result', () => {
      assert.strictEqual(isError({ success: true }), false);
    });

    test('returns false for null', () => {
      assert.strictEqual(isError(null), false);
    });

    test('returns false for undefined', () => {
      assert.strictEqual(isError(undefined), false);
    });
  });

  suite('lookupPlan', () => {
    test('returns plan when found via get', () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = lookupPlan(ctx, plan.id);
      assert.ok(!isError(result));
    });

    test('returns error when plan not found', () => {
      const ctx = createContext();
      const result = lookupPlan(ctx, 'nonexistent');
      assert.ok(isError(result));
    });

    test('uses getPlan method when specified', () => {
      const plan = createTestPlan();
      const ctx = createContext([plan]);
      const result = lookupPlan(ctx, plan.id, 'getPlan');
      assert.ok(!isError(result));
    });
  });

  suite('lookupNode', () => {
    test('returns node and state when found', () => {
      const plan = createTestPlan();
      const result = lookupNode(plan, 'node-1');
      assert.ok(!isError(result));
      assert.ok((result as any).node);
      assert.ok((result as any).state);
    });

    test('returns error when node not found', () => {
      const plan = createTestPlan();
      const result = lookupNode(plan, 'nonexistent');
      assert.ok(isError(result));
    });
  });

  suite('resolveBaseBranch', () => {
    test('returns requested branch if provided', async () => {
      const result = await resolveBaseBranch('/repo', {} as any, 'develop');
      assert.strictEqual(result, 'develop');
    });

    test('returns current branch if no request', async () => {
      sinon.stub(git.branches, 'currentOrNull').resolves('feature-branch');
      const result = await resolveBaseBranch('/repo', git as any);
      assert.strictEqual(result, 'feature-branch');
      sinon.restore();
    });

    test('returns main when no current branch', async () => {
      sinon.stub(git.branches, 'currentOrNull').resolves(null);
      const result = await resolveBaseBranch('/repo', git as any);
      assert.strictEqual(result, 'main');
      sinon.restore();
    });
  });

  suite('resolveTargetBranch', () => {
    test('generates feature branch when no request', async () => {
      sinon.stub(git.branches, 'exists').resolves(false);
      sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any);
      assert.ok(result.includes('copilot_plan'));
    });

    test('creates new branch when needsCreation is true', async () => {
      sinon.stub(git.branches, 'exists').resolves(false);
      const createStub = sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any);
      assert.ok(createStub.calledOnce);
      assert.ok(result.startsWith('copilot_plan/'));
    });

    test('uses requested branch when not default', async () => {
      sinon.stub(git.branches, 'isDefaultBranch').resolves(false);
      sinon.stub(git.branches, 'exists').resolves(true);
      const result = await resolveTargetBranch('main', '/repo', git as any, 'feature/my-branch');
      assert.strictEqual(result, 'feature/my-branch');
    });

    test('creates requested branch when it does not exist', async () => {
      sinon.stub(git.branches, 'isDefaultBranch').resolves(false);
      sinon.stub(git.branches, 'exists').resolves(false);
      const createStub = sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any, 'new-branch');
      assert.strictEqual(result, 'new-branch');
      assert.ok(createStub.calledOnce);
    });

    test('generates feature branch when requested is default', async () => {
      sinon.stub(git.branches, 'isDefaultBranch').resolves(true);
      sinon.stub(git.branches, 'exists').resolves(false);
      sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any, 'main');
      assert.ok(result.startsWith('copilot_plan/'));
    });

    test('falls back to feature branch on error', async () => {
      sinon.stub(git.branches, 'isDefaultBranch').rejects(new Error('git fail'));
      sinon.stub(git.branches, 'exists').resolves(false);
      sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any, 'bad-branch');
      assert.ok(result.startsWith('copilot_plan/'));
    });

    test('uses planName for branch suffix', async () => {
      sinon.stub(git.branches, 'exists').resolves(false);
      sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any, undefined, 'My Plan');
      assert.ok(result.includes('copilot_plan'));
    });

    test('strips trailing slashes from branchPrefix to avoid double-slash', async () => {
      const mockConfig = {
        getConfig: (section: string, key: string, def: any) =>
          section === 'git' && key === 'branchPrefix' ? 'users/jstatia/' : def
      };
      sinon.stub(git.branches, 'exists').resolves(false);
      sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any, undefined, 'My Plan', mockConfig);
      assert.ok(!result.includes('//'), `Branch should not contain double-slash: ${result}`);
      assert.ok(result.startsWith('users/jstatia/'), `Branch should start with stripped prefix: ${result}`);
    });

    test('strips multiple trailing slashes via configProvider', async () => {
      const mockConfig = {
        getConfig: (section: string, key: string, def: any) =>
          section === 'git' && key === 'branchPrefix' ? 'users/jstatia///' : def
      };
      sinon.stub(git.branches, 'exists').resolves(false);
      sinon.stub(git.branches, 'create').resolves();
      const result = await resolveTargetBranch('main', '/repo', git as any, undefined, 'My Plan', mockConfig);
      assert.ok(!result.includes('//'), `Branch should not contain double-slash even with multiple trailing slashes: ${result}`);
      assert.ok(result.startsWith('users/jstatia/'), `Branch should start with normalized prefix: ${result}`);
    });
  });
});
