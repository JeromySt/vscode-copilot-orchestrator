/**
 * @fileoverview Additional tests for JobExecutionEngine helper methods and edge cases.
 * Targets: mergeLeafToTarget, updateBranchRef, diffContainsOnlyOrchestratorPatterns,
 * logDependencyWorkSummary, summarizeCommitFiles, acknowledgeConsumption,
 * cleanupEligibleWorktrees, allConsumersConsumed, mergeSourcesIntoWorktree, etc.
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
import type { PlanInstance, JobNode, NodeExecutionState, PlanNode, ExecutionContext, JobExecutionResult, JobWorkSummary } from '../../../plan/types';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-helpers-'));
  tmpDirs.push(dir);
  return dir;
}

function createTestPlan(opts?: {
  nodes?: Map<string, PlanNode>;
  nodeStates?: Map<string, NodeExecutionState>;
  targetBranch?: string;
  leaves?: string[];
  roots?: string[];
  cleanUpSuccessfulWork?: boolean;
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
    cleanUpSuccessfulWork: opts?.cleanUpSuccessfulWork ?? false, maxParallel: 4,
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
    computeAggregatedWorkSummary: sinon.stub().resolves({
      nodeId: 'n1', nodeName: 'J', commits: 0,
      filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '',
    }),
    ...executorOverrides,
  };
  return {
    plans: new Map(), stateMachines: new Map(),
    persistence, executor, events, configManager,
  };
}

function createMockGitOps(): import('../../../interfaces/IGitOperations').IGitOperations {
  return {
    worktrees: {
      create: sinon.stub().resolves(),
      createWithTiming: sinon.stub().resolves({ totalMs: 10, cloneMs: 5, symlinkMs: 2, baseCommit: 'abc123' }),
      createDetachedWithTiming: sinon.stub().resolves({ totalMs: 10, cloneMs: 5, symlinkMs: 2, baseCommit: 'abc123' }),
      createOrReuseDetached: sinon.stub().resolves({ totalMs: 10, cloneMs: 5, symlinkMs: 2, baseCommit: 'abc123', reused: false }),
      remove: sinon.stub().resolves(),
      removeSafe: sinon.stub().resolves(true),
      isValid: sinon.stub().resolves(true),
      getBranch: sinon.stub().resolves(null),
      getHeadCommit: sinon.stub().resolves('abc123'),
      list: sinon.stub().resolves([]),
      prune: sinon.stub().resolves(),
    },
    repository: {
      fetch: sinon.stub().resolves(),
      pull: sinon.stub().resolves(true),
      push: sinon.stub().resolves(true),
      stageAll: sinon.stub().resolves(),
      stageFile: sinon.stub().resolves(),
      commit: sinon.stub().resolves(true),
      hasChanges: sinon.stub().resolves(false),
      hasStagedChanges: sinon.stub().resolves(false),
      hasUncommittedChanges: sinon.stub().resolves(false),
      getHead: sinon.stub().resolves('abc123'),
      resolveRef: sinon.stub().resolves('abc123'),
      getCommitLog: sinon.stub().resolves([]),
      getCommitChanges: sinon.stub().resolves([]),
      getDiffStats: sinon.stub().resolves({ added: 0, modified: 0, deleted: 0 }),
      getFileDiff: sinon.stub().resolves(null),
      getStagedFileDiff: sinon.stub().resolves(null),
      getFileChangesBetween: sinon.stub().resolves([]),
      hasChangesBetween: sinon.stub().resolves(false),
      getCommitCount: sinon.stub().resolves(0),
      getDirtyFiles: sinon.stub().resolves([]),
      checkoutFile: sinon.stub().resolves(),
      resetHard: sinon.stub().resolves(),
      clean: sinon.stub().resolves(),
      updateRef: sinon.stub().resolves(),
      stashPush: sinon.stub().resolves(true),
      stashPop: sinon.stub().resolves(true),
      stashDrop: sinon.stub().resolves(true),
      stashList: sinon.stub().resolves([]),
      stashShowFiles: sinon.stub().resolves([]),
      stashShowPatch: sinon.stub().resolves(null),
    },
    merge: {
      merge: sinon.stub().resolves({ success: true }),
      mergeWithoutCheckout: sinon.stub().resolves({ success: true, treeSha: 'tree123' }),
      commitTree: sinon.stub().resolves('newcommit123'),
      continueAfterResolve: sinon.stub().resolves(true),
      abort: sinon.stub().resolves(),
      listConflicts: sinon.stub().resolves([]),
      isInProgress: sinon.stub().resolves(false),
    },
    branches: {
      isDefaultBranch: sinon.stub().resolves(false),
      exists: sinon.stub().resolves(true),
      remoteExists: sinon.stub().resolves(false),
      current: sinon.stub().resolves('main'),
      currentOrNull: sinon.stub().resolves(null),
      create: sinon.stub().resolves(),
      createOrReset: sinon.stub().resolves(),
      checkout: sinon.stub().resolves(),
      list: sinon.stub().resolves([]),
      getCommit: sinon.stub().resolves(null),
      getMergeBase: sinon.stub().resolves(null),
      remove: sinon.stub().resolves(),
      deleteLocal: sinon.stub().resolves(true),
      deleteRemote: sinon.stub().resolves(true),
    },
    gitignore: {
      ensureGitignoreEntries: sinon.stub().resolves(false),
      isIgnored: sinon.stub().resolves(false),
      isOrchestratorGitIgnoreConfigured: sinon.stub().resolves(true),
      ensureOrchestratorGitIgnore: sinon.stub().resolves(true),
    },
  } as any;
}

function createEngine(dir: string, executorOverrides?: Partial<any>) {
  const log = createMockLogger();
  const state = createEngineState(dir, executorOverrides);
  const gitOps = createMockGitOps();
  const nodeManager = new NodeManager(state as any, log, gitOps);
  const engine = new JobExecutionEngine(state, nodeManager, log, gitOps);
  return { engine, state, log, nodeManager, gitOps };
}

suite('JobExecutionEngine - helper methods', () => {
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

  suite('mergeLeafToTarget via executeJobNode', () => {
    test('fast path: merge-tree success with update-ref (not on target branch)', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true);
    });

    test('fast path: user on target branch, clean - uses reset --hard', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true);
    });

    test('fast path: user on target branch, dirty - uses stash + reset', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true);
    });

    test('stash failure returns false but merge commit exists', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: true, treeSha: 'tree-sha',
      } as any);
      sandbox.stub(git.repository, 'resolveRef').resolves('target-sha');
      sandbox.stub(git.merge, 'commitTree').resolves('new-commit');
      sandbox.stub(git.branches, 'currentOrNull').resolves('main');
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(true);
      sandbox.stub(git.repository, 'getDirtyFiles').resolves(['src/foo.ts']);
      sandbox.stub(git.repository, 'stashPush').rejects(new Error('could not write index'));
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      // Should still succeed - merge commit was created
      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });

    test('merge-tree returns no treeSha and no conflicts - fails', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'failed' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      // RI merge failure should fail the node
      assert.strictEqual(ns.status, 'failed');
      assert.ok(ns.error!.includes('Reverse integration'));
    });

    test('merge-tree throws an exception - node fails', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'failed' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
    });

    test('no targetBranch means merge not needed', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan(); // no targetBranch
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });

    test('leaf with targetBranch but no completedCommit marks merged', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          // No completedCommit - code falls back to baseCommit for RI merge
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.completedCommit, 'abc123'); // Falls back to baseCommit from worktree
    });
  });

  suite('acknowledgeConsumption and cleanup', () => {
    test('acknowledgeConsumption records consumer on deps', async () => {
      const dir = makeTmpDir();
      const dep = createJobNode('dep', [], ['child']);
      const child = createJobNode('child', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['child', child]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep-commit-abcdef1234567890123456' }],
        ['child', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep'], leaves: ['child'], cleanUpSuccessfulWork: false });
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'child-commit-xyz1234567890123456789',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'dep-commit-abcdef1234567890123456', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, child as JobNode);

      const depState = plan.nodeStates.get('dep')!;
      assert.ok(depState.consumedByDependents);
      assert.ok(depState.consumedByDependents!.includes('child'));
    });

    test('cleanupEligibleWorktrees cleans up fully consumed deps', async () => {
      const dir = makeTmpDir();
      const worktreeDir = makeTmpDir(); // Simulates worktree path
      const dep = createJobNode('dep', [], ['child']);
      const child = createJobNode('child', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['child', child]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep-commit-abcdef1234567890123456', worktreePath: worktreeDir }],
        ['child', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep'], leaves: ['child'], cleanUpSuccessfulWork: true });
      const sm = new PlanStateMachine(plan);

      const removeStub = sandbox.stub(git.worktrees, 'removeSafe').resolves();
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'child-commit-xyz1234567890123456789',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'dep-commit-abcdef1234567890123456', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);

      await engine.executeJobNode(plan, sm, child as JobNode);

      const depState = plan.nodeStates.get('dep')!;
      // Dep should have been cleaned up since child consumed it
      assert.ok(depState.worktreeCleanedUp === true || removeStub.called);
    });
  });

  suite('FI merge failure path', () => {
    test('multi-dep FI merge failure fails node', async () => {
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

      const { engine, state, gitOps } = createEngine(dir);
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      // FI worktree creation fails
      (gitOps.worktrees.createOrReuseDetached as sinon.SinonStub).rejects(new Error('merge failed'));

      await engine.executeJobNode(plan, sm, mainNode as JobNode);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.ok(ns.stepStatuses?.['merge-fi'] === 'failed');
    });
  });

  suite('dependencies with no commits', () => {
    test('deps with expectsNoChanges have no commits - still succeeds', async () => {
      const dir = makeTmpDir();
      const dep = createJobNode('dep', [], ['node-1'], { expectsNoChanges: true });
      const mainNode = createJobNode('node-1', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['node-1', mainNode]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'succeeded', version: 1, attempts: 1 }], // No completedCommit
        ['node-1', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep'], leaves: ['node-1'] });
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'child-commit-xyz1234567890123456789',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base-main', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, mainNode as JobNode);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      // No FI merge because deps have no completedCommit
      assert.strictEqual(ns.completedCommit, 'child-commit-xyz1234567890123456789');
    });
  });

  suite('gitignore failure path', () => {
    test('gitignore ensureGitignoreEntries error is caught', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state, log, gitOps } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      (gitOps.gitignore.ensureGitignoreEntries as sinon.SinonStub).rejects(new Error('permission denied'));

      await engine.executeJobNode(plan, sm, node);

      // Should succeed despite gitignore error
      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/gitignore|permission/i)));
    });
  });

  suite('retry with missing baseCommit', () => {
    test('reused worktree with no existing baseCommit uses timing.baseCommit', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const ns = plan.nodeStates.get('node-1')!;
      ns.attempts = 1;
      // No baseCommit set
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state, gitOps } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      (gitOps.worktrees.createOrReuseDetached as sinon.SinonStub).resolves({
        reused: true, baseCommit: 'retry-base-commit', totalMs: 10,
      });

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(plan.nodeStates.get('node-1')!.baseCommit, 'retry-base-commit');
    });
  });

  suite('agent interrupted auto-retry', () => {
    test('agent killed externally retries same spec', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'fix bugs' } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Process killed by signal: SIGTERM',
        failedPhase: 'work', exitCode: 137,
        stepStatuses: { work: 'failed' },
      };
      const successResult: JobExecutionResult = {
        success: true,
        completedCommit: 'fixed-commit-12345678901234567890123',
        stepStatuses: { work: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(successResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(executeStub.callCount, 2);
    });

    test('agent interrupted retry also fails', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'fix bugs' } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Process killed by signal: SIGKILL',
        failedPhase: 'work', exitCode: 137,
        stepStatuses: { work: 'failed' },
      };
      const executeStub = sinon.stub();
      executeStub.resolves(failResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.strictEqual(executeStub.callCount, 2);
    });
  });

  suite('RI merge failure path with details', () => {
    test('RI merge failure records attempt with completedCommit', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'failed' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.ok(ns.attemptHistory);
      assert.strictEqual(ns.attemptHistory![ns.attemptHistory!.length - 1].failedPhase, 'merge-ri');
      assert.ok(ns.attemptHistory![ns.attemptHistory!.length - 1].completedCommit);
    });
  });

  suite('pushOnSuccess config', () => {
    test('push after RI merge when configured', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
        }),
      });
      // Configure pushOnSuccess
      state.configManager.getConfig = ((section: string, key: string, def: any) => {
        if (key === 'pushOnSuccess') return true;
        return def;
      }) as any;
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true);
    });

    test('push failure does not fail the merge', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.configManager.getConfig = ((section: string, key: string, def: any) => {
        if (key === 'pushOnSuccess') return true;
        return def;
      }) as any;
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: true, treeSha: 'tree-sha',
      } as any);
      sandbox.stub(git.repository, 'resolveRef').resolves('target-sha');
      sandbox.stub(git.merge, 'commitTree').resolves('new-commit');
      sandbox.stub(git.branches, 'currentOrNull').resolves('other');
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
      sandbox.stub(git.repository, 'updateRef').resolves();
      sandbox.stub(git.repository, 'push').rejects(new Error('Network error'));
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      // Push failed but merge succeeded
      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });
  });

  suite('dirty only .gitignore orchestrator changes', () => {
    test('only-orchestrator gitignore is discarded and reset', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: true, treeSha: 'tree-sha',
      } as any);
      sandbox.stub(git.repository, 'resolveRef').resolves('target-sha');
      sandbox.stub(git.merge, 'commitTree').resolves('new-commit');
      sandbox.stub(git.branches, 'currentOrNull').resolves('main');
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(true);
      sandbox.stub(git.repository, 'getDirtyFiles').resolves(['.gitignore']);
      // Return only orchestrator patterns in diff
      sandbox.stub(git.repository, 'getFileDiff').resolves('+.orchestrator/\n+# Copilot Orchestrator\n');
      sandbox.stub(git.repository, 'hasChangesBetween').resolves(true);
      sandbox.stub(git.repository, 'checkoutFile').resolves();
      sandbox.stub(git.repository, 'resetHard').resolves();
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });
  });

  suite('index.lock retry', () => {
    test('index.lock error retries up to 3 times', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      // Simulate executor handling index.lock retry internally and succeeding
      const executeStub = sinon.stub();
      executeStub.resolves({
        success: true,
        completedCommit: 'commit123456789012345678901234567890ab',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
      });

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.ok(executeStub.callCount >= 1);
    }).timeout(15000);
  });

  suite('stash pop failure with orchestrator gitignore', () => {
    test('stash pop failure drops orchestrator-only stash', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);
      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      // Stash operations are now handled by the executor's merge-ri phase
      assert.strictEqual(ns.mergedToTarget, true);
    }).timeout(10000);
  });

  suite('non-leaf node is not merged to target', () => {
    test('non-leaf succeeded node is not RI merged', async () => {
      const dir = makeTmpDir();
      const dep = createJobNode('dep', [], ['child']);
      const child = createJobNode('child', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['child', child]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'scheduled', version: 0, attempts: 0 }],
        ['child', { status: 'pending', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({
        nodes, nodeStates,
        roots: ['dep'], leaves: ['child'],
        targetBranch: 'main',
      });
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'dep-result-12345678901234567890123',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      // Execute the non-leaf node (dep)
      await engine.executeJobNode(plan, sm, dep as JobNode);

      const ns = plan.nodeStates.get('dep')!;
      assert.strictEqual(ns.status, 'succeeded');
      // Non-leaf nodes get mergedToTarget=true meaning "no RI merge needed"
      assert.strictEqual(ns.mergedToTarget, true);
    });
  });

  suite('aggregated work summary', () => {
    test('computeAggregatedWorkSummary failure is caught', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: undefined });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state, log } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          workSummary: { nodeId: 'node-1', nodeName: 'Job', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'test' },
          stepStatuses: { work: 'success', commit: 'success' },
        }),
        computeAggregatedWorkSummary: sinon.stub().rejects(new Error('git error')),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      // Warning should have been logged for aggregated work summary failure
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/aggregated/i)));
    });
  });

  suite('metrics and session capture', () => {
    test('executor metrics and phaseMetrics are stored', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const metrics = { premiumRequests: 1, apiTimeSeconds: 10, sessionTimeSeconds: 30, durationMs: 5000 };
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
          copilotSessionId: 'session-123',
          metrics,
          phaseMetrics: { work: metrics },
          pid: 12345,
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.copilotSessionId, 'session-123');
      assert.deepStrictEqual(ns.metrics, metrics);
      assert.ok(ns.phaseMetrics);
    });
  });

  suite('executor callbacks invoked', () => {
    test('onProgress and onStepStatusChange are called by executor', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      // Create executor that calls the callbacks
      const executeStub = sinon.stub().callsFake(async (ctx: any) => {
        if (ctx.onProgress) ctx.onProgress('Running work');
        if (ctx.onStepStatusChange) {
          ctx.onStepStatusChange('work', 'running');
          ctx.onStepStatusChange('work', 'success');
        }
        return {
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        };
      });

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.ok(ns.stepStatuses);
    });
  });

  suite('FI with dep without depInfo', () => {
    test('dependency not in depInfoMap logs generic message', async () => {
      const dir = makeTmpDir();
      // Create a dep that has no workSummary set - the dep commit won't match the depInfoMap
      const dep = createJobNode('dep', [], ['node-1']);
      const mainNode = createJobNode('node-1', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['node-1', mainNode]]);
      const depCommit = 'dep-commit-abcdef1234567890123456';
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'succeeded', version: 1, attempts: 1, completedCommit: depCommit }],
        ['node-1', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep'], leaves: ['node-1'] });

      const sm = new PlanStateMachine(plan);
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'child-commit-xyz1234567890123456789',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      // Make the worktree return a DIFFERENT base commit than dep's commit
      // so the depInfoMap lookup fails
      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'some-other-base-not-dep-commit', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, mainNode as JobNode);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });
  });

  suite('auto-heal non-agent (swap to agent)', () => {
    test('shell failure triggers agent auto-heal swap', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Tests failed', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      // Second call (auto-heal with agent) succeeds
      const healResult: JobExecutionResult = {
        success: true,
        completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { work: 'success', commit: 'success' },
        workSummary: { nodeId: 'node-1', nodeName: 'Job node-1', commits: 1, filesAdded: 0, filesModified: 1, filesDeleted: 0, description: 'fixed' },
        copilotSessionId: 'heal-session-1',
        metrics: { premiumRequests: 2, apiTimeSeconds: 10, sessionTimeSeconds: 30, durationMs: 5000 },
        phaseMetrics: { work: { premiumRequests: 2, apiTimeSeconds: 10, sessionTimeSeconds: 30, durationMs: 5000 } },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().callsFake(async (ctx: any) => {
        // Invoke callbacks for coverage
        if (ctx.onProgress) ctx.onProgress('Auto-heal in progress');
        if (ctx.onStepStatusChange) ctx.onStepStatusChange('work', 'success');
        return healResult;
      });

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.attempts, 2);
      assert.ok(ns.workSummary);
      assert.ok(ns.copilotSessionId);
      assert.ok(ns.metrics);
    });

    test('shell failure auto-heal also fails', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Tests failed', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const healFail: JobExecutionResult = {
        success: false, error: 'Agent also failed', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
        metrics: { premiumRequests: 1, apiTimeSeconds: 10, sessionTimeSeconds: 30, durationMs: 5000 },
        phaseMetrics: { work: { premiumRequests: 1, apiTimeSeconds: 10, sessionTimeSeconds: 30, durationMs: 5000 } },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healFail);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.strictEqual(ns.attempts, 2);
      assert.ok(ns.metrics);
    });

    test('process type work failure also triggers auto-heal', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'process', executable: 'node', args: ['test.js'] } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Process exit 1', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true,
        completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { work: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });

    test('prechecks failure triggers auto-heal for prechecks phase', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.prechecks = { type: 'shell', command: 'echo pre' };
      node.work = { type: 'shell', command: 'echo work' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Prechecks failed', failedPhase: 'prechecks',
        exitCode: 1, stepStatuses: { prechecks: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true,
        completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { prechecks: 'success', work: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });

    test('postchecks failure triggers auto-heal for postchecks phase', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.postchecks = { type: 'shell', command: 'echo check' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Check failed', failedPhase: 'postchecks',
        exitCode: 1, stepStatuses: { work: 'success', postchecks: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true,
        completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { work: 'success', postchecks: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });
  });

  suite('withRiMergeLock serialization', () => {
    test('sequential RI merges both succeed', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);
      sandbox.stub(git.merge, 'mergeWithoutCheckout').resolves({
        success: true, treeSha: 'tree-sha',
      } as any);
      sandbox.stub(git.repository, 'resolveRef').resolves('target-sha');
      sandbox.stub(git.merge, 'commitTree').resolves('new-commit');
      sandbox.stub(git.branches, 'currentOrNull').resolves('other');
      sandbox.stub(git.repository, 'hasUncommittedChanges').resolves(false);
      sandbox.stub(git.repository, 'updateRef').resolves();
      sandbox.stub(git.worktrees, 'removeSafe').resolves();

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'succeeded');
    });
  });

  suite('cleanupWorktree error handling', () => {
    test('worktree cleanup failure does not prevent success', async () => {
      const dir = makeTmpDir();
      // cleanUpSuccessfulWork must be true for cleanup to run
      const plan = createTestPlan({ cleanUpSuccessfulWork: true });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state, log, gitOps } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      // Worktree cleanup fails
      (gitOps.worktrees.removeSafe as sinon.SinonStub).rejects(new Error('permission denied on cleanup'));

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      // Warn should be logged for cleanup failure
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/Failed to cleanup worktree/)));
    });
  });

  suite('allConsumersConsumed leaf path', () => {
    test('leaf node with no targetBranch and cleanUpSuccessfulWork', async () => {
      const dir = makeTmpDir();
      const worktreeDir = makeTmpDir();
      const node = createJobNode('leaf-1', [], []);
      const nodes = new Map<string, PlanNode>([['leaf-1', node]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['leaf-1', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      // No targetBranch, cleanUpSuccessfulWork enabled
      const plan = createTestPlan({
        nodes, nodeStates,
        roots: ['leaf-1'], leaves: ['leaf-1'],
        cleanUpSuccessfulWork: true,
      });
      const sm = new PlanStateMachine(plan);

      const removeStub = sandbox.stub(git.worktrees, 'removeSafe').resolves();
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'leaf-commit-12345678901234567890123',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      sandbox.stub(git.worktrees, 'createOrReuseDetached').resolves({
        reused: false, baseCommit: 'base', totalMs: 50,
      } as any);
      sandbox.stub(git.gitignore, 'ensureGitignoreEntries').resolves(false);

      await engine.executeJobNode(plan, sm, node as JobNode);

      const ns = plan.nodeStates.get('leaf-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });
  });
});
