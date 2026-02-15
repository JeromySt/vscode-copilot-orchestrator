/**
 * @fileoverview Unit tests for JobExecutionEngine
 * Tests the execution engine with mocked git operations and executor.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as git from '../../../git';
import { JobExecutionEngine, ExecutionEngineState } from '../../../plan/executionEngine';
import { NodeManager } from '../../../plan/nodeManager';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import { CopilotCliRunner } from '../../../agent/copilotCliRunner';
import type { PlanInstance, JobNode, NodeExecutionState, PlanNode, ExecutionContext, JobExecutionResult } from '../../../plan/types';
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

function createJobNode(id: string, deps: string[] = [], dependents: string[] = [], opts: Partial<JobNode> = {}): JobNode {
  return {
    id, producerId: id, name: `Job ${id}`, type: 'job',
    task: `Task ${id}`,
    work: { type: 'shell', command: 'echo test' },
    dependencies: deps, dependents, ...opts,
  };
}

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
  tmpDirs.push(dir);
  return dir;
}

function createTestPlan(opts?: {
  nodes?: Map<string, PlanNode>;
  nodeStates?: Map<string, NodeExecutionState>;
  targetBranch?: string;
  leaves?: string[];
  roots?: string[];
}): PlanInstance {
  const defaultNode = createJobNode('node-1');
  const nodes = opts?.nodes || new Map<string, PlanNode>([['node-1', defaultNode]]);
  const nodeStates = opts?.nodeStates || new Map<string, NodeExecutionState>([
    ['node-1', { status: 'scheduled', version: 0, attempts: 0 }],
  ]);
  return {
    id: 'plan-1', spec: { name: 'Test Plan', jobs: [], baseBranch: 'main' },
    nodes, producerIdToNodeId: new Map([['node-1', 'node-1']]),
    roots: opts?.roots || ['node-1'], leaves: opts?.leaves || ['node-1'],
    nodeStates, groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
    repoPath: '/repo', baseBranch: 'main', targetBranch: opts?.targetBranch,
    worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
    cleanUpSuccessfulWork: true, maxParallel: 4,
  };
}

function createEngineState(storagePath: string, executorOverrides?: Partial<any>): ExecutionEngineState {
  const persistence = new PlanPersistence(storagePath);
  const events = new PlanEventEmitter();
  const configManager = new PlanConfigManager();
  const executor = {
    execute: sinon.stub(),
    cancel: sinon.stub(),
    getLogs: sinon.stub().returns([]),
    getLogsForPhase: sinon.stub().returns([]),
    getLogFileSize: sinon.stub().returns(0),
    getLogFilePath: sinon.stub().returns(undefined),
    log: sinon.stub(),
    computeAggregatedWorkSummary: sinon.stub().resolves({ nodeId: 'n1', nodeName: 'J', commits: 0, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '' }),
    ...executorOverrides,
  };
  return {
    plans: new Map(), stateMachines: new Map(),
    persistence, executor, events, configManager,
  };
}

function createMockGitOperations(): any {
  return {
    worktrees: {
      createOrReuseDetached: sinon.stub().resolves({
        reused: false, baseCommit: 'base123', totalMs: 100,
      }),
      removeSafe: sinon.stub().resolves(true),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(false),
    },
    repository: {
      updateRef: sinon.stub().resolves(),
      resolveRef: sinon.stub().resolves('target-sha-123'),
      stageFile: sinon.stub().resolves(),
      hasChangesBetween: sinon.stub().resolves(true),
      hasUncommittedChanges: sinon.stub().resolves(false),
    },
    merge: {
      mergeWithoutCheckout: sinon.stub().resolves({ success: true, treeSha: 'tree-sha-123' }),
      commitTree: sinon.stub().resolves('new-commit-123'),
    },
    branches: {
      getCommit: sinon.stub().resolves('abc123'),
      currentOrNull: sinon.stub().resolves('current-branch'),
    },
  };
}

function createPassthroughGitOperations(): any {
  // This creates a git operations object that delegates to the real git module
  // so that sandbox stubs on the real git module will work
  return {
    worktrees: git.worktrees,
    gitignore: git.gitignore,
    repository: git.repository,
    merge: git.merge,
    branches: git.branches,
  };
}

suite('JobExecutionEngine', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
  });

  test('constructor creates instance', () => {
    const dir = makeTmpDir();
    const state = createEngineState(dir);
    const log = createMockLogger();
    const mockGit = createMockGitOperations();
    const nodeManager = new NodeManager(state as any, log, mockGit);
    const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);
    assert.ok(engine);
  });

  suite('executeJobNode - basic flows', () => {
    test('root node succeeds with shell work', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true,
        completedCommit: 'abc123def456789012345678901234567890abcd',
        workSummary: {
          nodeId: 'node-1', nodeName: 'Job node-1', commits: 1,
          filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'test',
        },
        stepStatuses: { prechecks: 'skipped', work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const nodeState = plan.nodeStates.get('node-1')!;
      assert.strictEqual(nodeState.status, 'succeeded');
      assert.strictEqual(nodeState.completedCommit, 'abc123def456789012345678901234567890abcd');
      assert.ok(nodeState.attemptHistory);
      assert.strictEqual(nodeState.attemptHistory!.length, 1);
      assert.strictEqual(nodeState.attemptHistory![0].status, 'succeeded');
    });

    test('executor failure transitions node to failed', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.autoHeal = false;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: false,
        error: 'Build failed',
        failedPhase: 'work',
        exitCode: 1,
        stepStatuses: { work: 'failed' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const nodeState = plan.nodeStates.get('node-1')!;
      assert.strictEqual(nodeState.status, 'failed');
      assert.strictEqual(nodeState.error, 'Build failed');
      assert.ok(nodeState.attemptHistory);
      assert.strictEqual(nodeState.attemptHistory![0].status, 'failed');
    });

    test('worktree creation failure fails the node', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const state = createEngineState(dir);
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      // Override the stub to throw an error for this test
      mockGit.worktrees.createOrReuseDetached = sinon.stub().rejects(new Error('Cannot create worktree'));
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const nodeState = plan.nodeStates.get('node-1')!;
      assert.strictEqual(nodeState.status, 'failed');
      assert.ok(nodeState.error!.includes('Cannot create worktree'));
    });

    test('reused worktree for retry preserves baseCommit', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const nodeState = plan.nodeStates.get('node-1')!;
      nodeState.baseCommit = 'original-base';
      nodeState.attempts = 1;
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'new-commit-hash-1234567890123456789012',
        stepStatuses: { work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const passthroughGit = createPassthroughGitOperations();
      const nodeManager = new NodeManager(state as any, log, passthroughGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, passthroughGit);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: true, baseCommit: 'different-base', totalMs: 10,
      } as any);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      // baseCommit should be preserved from original, not overwritten
      assert.strictEqual(plan.nodeStates.get('node-1')!.baseCommit, 'original-base');
    });

    test('node with dependencies performs FI merge', async () => {
      const dir = makeTmpDir();
      const depNode = createJobNode('dep-1', [], ['node-1']);
      const mainNode = createJobNode('node-1', ['dep-1'], []);
      const nodes = new Map<string, PlanNode>([['dep-1', depNode], ['node-1', mainNode]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep-1', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep-commit-hash12345678901234567890' }],
        ['node-1', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep-1'], leaves: ['node-1'] });

      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'main-commit-1234567890123456789012',
        stepStatuses: { work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, mainNode as JobNode);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      // FI merge step status is set then overwritten by executor stepStatuses
      // Verify the node consumed the dependency commit
      assert.ok(ns.completedCommit);
    });

    test('leaf node with targetBranch performs RI merge', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature-branch' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true,
        completedCommit: 'commit-hash-12345678901234567890123456',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true);
    });

    test('auto-heal swaps to agent on shell failure', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const failResult: JobExecutionResult = {
        success: false, error: 'Tests failed', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true, completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { work: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const state = createEngineState(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.attempts, 2);
      // Should have 2 attempts in history: 1 failed + 1 auto-heal succeeded
      assert.ok(ns.attemptHistory);
      assert.strictEqual(ns.attemptHistory!.length, 2);
    });

    test('auto-heal failure still results in failed node', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const failResult: JobExecutionResult = {
        success: false, error: 'Build failed', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(failResult);

      const state = createEngineState(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
    });

    test('no auto-heal when autoHeal is false', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = false;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const failResult: JobExecutionResult = {
        success: false, error: 'Build failed', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const executeStub = sinon.stub();
      executeStub.resolves(failResult);

      const state = createEngineState(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      // Executor should only be called once (no auto-heal)
      assert.strictEqual(executeStub.callCount, 1);
    });

    test('resume from merge-ri phase skips executor', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature' });
      const ns = plan.nodeStates.get('node-1')!;
      ns.resumeFromPhase = 'merge-ri' as any;
      ns.completedCommit = 'existing-commit-12345678901234567890';
      ns.baseCommit = 'base123';
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executeStub = sinon.stub();
      const state = createEngineState(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const passthroughGit = createPassthroughGitOperations();
      const nodeManager = new NodeManager(state as any, log, passthroughGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, passthroughGit);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: true, baseCommit: 'base123', totalMs: 10,
      } as any);
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: true, treeSha: 'tree-sha',
      } as any);
      sandbox.stub(git.repository, 'resolveRef').resolves('target-sha');
      sandbox.stub(git.merge, 'commitTree').resolves('new-commit');
      sandbox.stub(git.branches, 'currentOrNull').resolves('main');
      sandbox.stub(git.repository, 'hasChangesBetween').resolves(true);
      sandbox.stub(git.repository, 'updateRef').resolves();
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      // Executor should not be called - resumed from RI
      assert.strictEqual(executeStub.callCount, 0);
    });

    test('expectsNoChanges node carries forward baseCommit', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.expectsNoChanges = true;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true,
        // No completedCommit for expectsNoChanges
        stepStatuses: { work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      const nodeState = plan.nodeStates.get('node-1')!;
      assert.strictEqual(nodeState.status, 'succeeded');
      // completedCommit should be set to baseCommit as fallback
      assert.strictEqual(nodeState.completedCommit, 'base123');
    });

    test('multi-dependency FI merge', async () => {
      const dir = makeTmpDir();
      const dep1 = createJobNode('dep-1', [], ['node-1']);
      const dep2 = createJobNode('dep-2', [], ['node-1']);
      const mainNode = createJobNode('node-1', ['dep-1', 'dep-2'], []);
      const nodes = new Map<string, PlanNode>([
        ['dep-1', dep1], ['dep-2', dep2], ['node-1', mainNode],
      ]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep-1', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep1-commit-abcdef1234567890123456' }],
        ['dep-2', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep2-commit-abcdef1234567890123456' }],
        ['node-1', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep-1', 'dep-2'], leaves: ['node-1'] });
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'merge-result-12345678901234567890',
        stepStatuses: { work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, mainNode as JobNode);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });

    test('slow worktree creation is logged', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'commit-abc-12345678901234567890',
        stepStatuses: { work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      // Override for this test to return slow timing
      mockGit.worktrees.createOrReuseDetached = sinon.stub().resolves({
        reused: false, baseCommit: 'base', totalMs: 5000,
      });
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      // log.warn should have been called for slow worktree
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/[Ss]low/)));
    });

    test('gitignore update modifies and stages', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'commit-xyz-12345678901234567890',
        stepStatuses: { work: 'success', commit: 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      // Override gitignore to return true (modified)
      mockGit.gitignore.ensureGitignoreEntries = sinon.stub().resolves(true);
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      await engine.executeJobNode(plan, sm, node);

      assert.ok(mockGit.gitignore.ensureGitignoreEntries.calledOnce);
      // git add .gitignore should have been called via stageFile
      assert.ok(mockGit.repository.stageFile.calledOnce);
    });

    test('RI merge failure marks node as failed with preserved worktree', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'commit-abc-12345678901234567890',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'failed' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.repository, 'hasChangesBetween').resolves(true);
      // RI merge: mergeWithoutCheckout returns conflicts
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: false, hasConflicts: true, conflictFiles: ['file.ts'],
      } as any);
      // Stub mergeWithConflictResolution dependencies
      sandbox.stub(git.branches, 'currentOrNull').resolves('other');
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(true);
      sandbox.stub(git.repository, 'stashPush').resolves(true);
      sandbox.stub(git.branches, 'checkout').resolves();
      sandbox.stub(git.merge, 'merge').rejects(new Error('merge conflict'));
      sandbox.stub(git.merge, 'abort').resolves();
      sandbox.stub(git.repository, 'stashPop').resolves(true);
      // Stub CopilotCliRunner.prototype.run to fail
      sandbox.stub(CopilotCliRunner.prototype, 'run').resolves({
        success: false, error: 'CLI not available', exitCode: 1,
      } as any);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.ok(ns.error!.includes('Reverse integration'));
      assert.ok(ns.stepStatuses?.['merge-ri'] === 'failed');
    });

    test('RI merge with conflict resolved by Copilot CLI succeeds', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'commit-abc-12345678901234567890',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();
      // RI merge: conflicts detected
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: false, hasConflicts: true, conflictFiles: ['file.ts'],
      } as any);
      // mergeWithConflictResolution stubs
      sandbox.stub(git.branches, 'currentOrNull').resolves('other');
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(true);
      sandbox.stub(git.repository, 'stashPush').resolves(true);
      sandbox.stub(git.branches, 'checkout').resolves();
      sandbox.stub(git.merge, 'merge').rejects(new Error('conflict'));
      sandbox.stub(git.repository, 'stashPop').resolves(true);
      // CLI resolves conflicts successfully
      sandbox.stub(CopilotCliRunner.prototype, 'run').resolves({
        success: true, sessionId: 'session-123',
        metrics: { premiumRequests: 1, apiTimeSeconds: 5, sessionTimeSeconds: 10, durationMs: 5000 },
      } as any);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true);
    });

    test('RI merge-tree fails without conflicts returns false', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);
      const log = createMockLogger();

      const executorResult: JobExecutionResult = {
        success: true, completedCommit: 'commit-abc-12345678901234567890',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'failed' },
      };

      const state = createEngineState(dir, { execute: sinon.stub().resolves(executorResult) });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      const mockGit = createMockGitOperations();
      const nodeManager = new NodeManager(state as any, log, mockGit);
      const engine = new JobExecutionEngine(state, nodeManager, log, mockGit);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.repository, 'hasChangesBetween').resolves(true);
      // merge-tree fails without conflicts or treeSha
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: false, hasConflicts: false, error: 'not a valid ref',
      } as any);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.ok(ns.stepStatuses?.['merge-ri'] === 'failed');
    });
  });
});
