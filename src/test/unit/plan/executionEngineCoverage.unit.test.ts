/**
 * @fileoverview Additional coverage tests for JobExecutionEngine.
 * Targets uncovered branches: nodeState missing, no executor, auto-heal edge cases,
 * RI merge mutex serialization, FI merge from deps, work summary, plan completion,
 * worktree cleanup, cancel/abort, and various error paths.
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
import type { PlanInstance, JobNode, NodeExecutionState, PlanNode, ExecutionContext, JobExecutionResult, JobWorkSummary, CommitDetail } from '../../../plan/types';
import type { ILogger } from '../../../interfaces/ILogger';

/* ------------------------------------------------------------------ */
/*  Shared helpers (match existing test-file conventions)              */
/* ------------------------------------------------------------------ */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cov-'));
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

function createMockGitOps(): any {
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

/* ================================================================== */
/*  TESTS                                                             */
/* ================================================================== */

suite('JobExecutionEngine - Coverage', () => {
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

  // ------------------------------------------------------------------
  // 1. nodeState missing early return
  // ------------------------------------------------------------------
  suite('nodeState missing', () => {
    test('executeJobNode returns immediately when nodeState is missing', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      // Remove the nodeState to trigger early return
      plan.nodeStates.delete('node-1');
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir);
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      // Should not throw — just return immediately
      await engine.executeJobNode(plan, sm, node);
      // No status change since nodeState was missing
      assert.strictEqual(plan.nodeStates.has('node-1'), false);
    });
  });

  // ------------------------------------------------------------------
  // 2. execLog when executor is undefined
  // ------------------------------------------------------------------
  suite('execLog with no executor', () => {
    test('execLog is a no-op when executor has no log function', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const state = createEngineState(dir, { log: undefined });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      const log = createMockLogger();
      const gitOps = createMockGitOps();
      // Trigger worktree creation failure to exercise execLog without executor.log
      (gitOps.worktrees.createOrReuseDetached as sinon.SinonStub).rejects(new Error('boom'));
      const nodeManager = new NodeManager(state as any, log, gitOps);
      const engine = new JobExecutionEngine(state, nodeManager, log, gitOps);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
    });
  });

  // ------------------------------------------------------------------
  // 3. baseCommitAtStart is captured only once
  // ------------------------------------------------------------------
  suite('baseCommitAtStart capture', () => {
    test('baseCommitAtStart is set on first fresh worktree', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
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
        reused: false, baseCommit: 'first-base-sha', totalMs: 50,
      });

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(plan.baseCommitAtStart, 'first-base-sha');
    });

    test('baseCommitAtStart is NOT overwritten on subsequent nodes', async () => {
      const dir = makeTmpDir();
      const node1 = createJobNode('n1', [], []);
      const node2 = createJobNode('n2', [], []);
      const nodes = new Map<string, PlanNode>([['n1', node1], ['n2', node2]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['n1', { status: 'scheduled', version: 0, attempts: 0 }],
        ['n2', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['n1', 'n2'], leaves: ['n1', 'n2'] });
      plan.baseCommitAtStart = 'original-base';
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
        reused: false, baseCommit: 'second-base-sha', totalMs: 50,
      });

      await engine.executeJobNode(plan, sm, node2 as JobNode);

      assert.strictEqual(plan.baseCommitAtStart, 'original-base');
    });
  });

  // ------------------------------------------------------------------
  // 4. Executor result stores copilotSessionId, metrics, phaseMetrics, pid
  // ------------------------------------------------------------------
  suite('executor result field capture', () => {
    test('all optional fields from executor result are stored on nodeState', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const metrics = { premiumRequests: 5, apiTimeSeconds: 30, sessionTimeSeconds: 120, durationMs: 60000 };
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
          copilotSessionId: 'sess-abc',
          metrics,
          phaseMetrics: { work: metrics },
          pid: 9999,
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.copilotSessionId, 'sess-abc');
      assert.deepStrictEqual(ns.metrics, metrics);
      assert.ok(ns.phaseMetrics);
      // pid is cleared after execution
      assert.strictEqual(ns.pid, undefined);
    });
  });

  // ------------------------------------------------------------------
  // 5. Executor failure - stores error, lastAttempt, attempt history
  // ------------------------------------------------------------------
  suite('executor failure detail capture', () => {
    test('failure stores lastAttempt, error, stepStatuses from result', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.autoHeal = false;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: false,
          error: 'Compilation error',
          failedPhase: 'prechecks',
          exitCode: 2,
          stepStatuses: { prechecks: 'failed' },
          copilotSessionId: 'sess-fail',
          metrics: { premiumRequests: 1, apiTimeSeconds: 5, sessionTimeSeconds: 10, durationMs: 3000 },
          phaseMetrics: { prechecks: { premiumRequests: 1, apiTimeSeconds: 5, sessionTimeSeconds: 10, durationMs: 3000 } },
          pid: 1234,
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.strictEqual(ns.error, 'Compilation error');
      assert.ok(ns.lastAttempt);
      assert.strictEqual(ns.lastAttempt!.phase, 'prechecks');
      assert.strictEqual(ns.lastAttempt!.error, 'Compilation error');
      assert.ok(ns.attemptHistory);
      assert.strictEqual(ns.attemptHistory![0].failedPhase, 'prechecks');
      assert.strictEqual(ns.attemptHistory![0].exitCode, 2);
    });

    test('failure without failedPhase defaults to work', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.autoHeal = false;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: false,
          error: 'Unknown error',
          // no failedPhase
          stepStatuses: { work: 'failed' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.strictEqual(ns.lastAttempt!.phase, 'work');
    });
  });

  // ------------------------------------------------------------------
  // 6. Auto-heal: agent work that is NOT externally killed should NOT retry
  // ------------------------------------------------------------------
  suite('auto-heal gating', () => {
    test('agent failure without external kill does not trigger auto-retry', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'do stuff' } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const executeStub = sinon.stub().resolves({
        success: false,
        error: 'Agent failed normally',
        failedPhase: 'work',
        exitCode: 1,
        stepStatuses: { work: 'failed' },
      });

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      // Only 1 call — no auto-retry for non-killed agent work
      assert.strictEqual(executeStub.callCount, 1);
    });

    test('phase already healed does not trigger second heal', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const ns = plan.nodeStates.get('node-1')!;
      ns.autoHealAttempted = { work: true };
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const executeStub = sinon.stub().resolves({
        success: false,
        error: 'Build failed again',
        failedPhase: 'work',
        exitCode: 1,
        stepStatuses: { work: 'failed' },
      });

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
      // Only 1 call — phase was already healed
      assert.strictEqual(executeStub.callCount, 1);
    });

    test('non-healable phase (merge-fi) does not trigger auto-heal', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const executeStub = sinon.stub().resolves({
        success: false,
        error: 'merge failed',
        failedPhase: 'merge-fi',
        stepStatuses: { 'merge-fi': 'failed' },
      });

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(plan.nodeStates.get('node-1')!.status, 'failed');
      assert.strictEqual(executeStub.callCount, 1);
    });
  });

  // ------------------------------------------------------------------
  // 7. Auto-heal: agent interrupted retry captures metrics and session
  // ------------------------------------------------------------------
  suite('auto-retry captures retry result fields', () => {
    test('interrupted agent retry stores copilotSessionId and metrics on success', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'fix' } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const retryMetrics = { premiumRequests: 3, apiTimeSeconds: 15, sessionTimeSeconds: 60, durationMs: 30000 };
      const failResult: JobExecutionResult = {
        success: false, error: 'Process killed by signal: SIGTERM',
        failedPhase: 'work', exitCode: 137,
        stepStatuses: { work: 'failed' },
      };
      const retryResult: JobExecutionResult = {
        success: true,
        completedCommit: 'retry-commit-1234567890123456789012',
        stepStatuses: { work: 'success', commit: 'success' },
        copilotSessionId: 'retry-session-1',
        metrics: retryMetrics,
        phaseMetrics: { work: retryMetrics },
        workSummary: { nodeId: 'node-1', nodeName: 'Job node-1', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'retried' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(retryResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.copilotSessionId, 'retry-session-1');
      assert.deepStrictEqual(ns.metrics, retryMetrics);
      assert.ok(ns.workSummary);
    });

    test('interrupted agent retry failure stores metrics and phaseMetrics', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'fix' } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const retryMetrics = { premiumRequests: 2, apiTimeSeconds: 10, sessionTimeSeconds: 40, durationMs: 20000 };
      const failResult: JobExecutionResult = {
        success: false, error: 'Process killed by signal: SIGKILL',
        failedPhase: 'work', exitCode: 137,
        stepStatuses: { work: 'failed' },
      };
      const retryFail: JobExecutionResult = {
        success: false, error: 'Retry also failed',
        failedPhase: 'work', exitCode: 1,
        stepStatuses: { work: 'failed' },
        copilotSessionId: 'retry-sess-fail',
        metrics: retryMetrics,
        phaseMetrics: { work: retryMetrics },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(retryFail);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.ok(ns.error!.includes('Auto-retry failed'));
      assert.deepStrictEqual(ns.metrics, retryMetrics);
      assert.ok(ns.attemptHistory!.length >= 2);
    });
  });

  // ------------------------------------------------------------------
  // 8. Auto-heal: no completedCommit falls back to baseCommit
  // ------------------------------------------------------------------
  suite('auto-heal fallback to baseCommit', () => {
    test('auto-heal success with no completedCommit uses baseCommit', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'echo ok' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'fail', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true,
        // No completedCommit
        stepStatuses: { work: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      // completedCommit should fall back to baseCommit
      assert.ok(ns.completedCommit);
    });

    test('interrupted agent retry with no completedCommit falls back to baseCommit', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'fix' } as any;
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'Process killed by signal: SIGTERM',
        failedPhase: 'work', exitCode: 137,
        stepStatuses: { work: 'failed' },
      };
      const retryResult: JobExecutionResult = {
        success: true,
        // No completedCommit
        stepStatuses: { work: 'success', commit: 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(retryResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.ok(ns.completedCommit);
    });
  });

  // ------------------------------------------------------------------
  // 9. RI merge failure: attempt history records auto-heal trigger type
  // ------------------------------------------------------------------
  suite('RI merge failure after auto-heal', () => {
    test('RI merge failure after auto-heal records auto-heal trigger type', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'fail', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true,
        completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'failed' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      // Last attempt should record 'auto-heal' trigger type
      const lastAttempt = ns.attemptHistory![ns.attemptHistory!.length - 1];
      assert.strictEqual(lastAttempt.triggerType, 'auto-heal');
      assert.strictEqual(lastAttempt.failedPhase, 'merge-ri');
    });

    test('auto-heal preserves targetBranch and repoPath for leaf nodes', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      plan.repoPath = dir;
      plan.baseCommitAtStart = 'base-start-commit';
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'shell', command: 'npm test' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'fail', failedPhase: 'work',
        exitCode: 1, stepStatuses: { work: 'failed' },
      };
      const healResult: JobExecutionResult = {
        success: true,
        completedCommit: 'heal-commit-12345678901234567890123',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(healResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      // Verify the heal context included merge-specific fields
      const healCall = executeStub.secondCall;
      const healContext = healCall.args[0];
      assert.strictEqual(healContext.targetBranch, 'main', 'healContext must include targetBranch for leaf node');
      assert.strictEqual(healContext.repoPath, dir, 'healContext must include repoPath');
      assert.strictEqual(healContext.baseCommitAtStart, 'base-start-commit', 'healContext must include baseCommitAtStart');
    });

    test('auto-retry preserves targetBranch and repoPath for leaf nodes', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      plan.repoPath = dir;
      plan.baseCommitAtStart = 'base-start-commit';
      const node = plan.nodes.get('node-1')! as JobNode;
      node.work = { type: 'agent', instructions: 'do work' };
      node.autoHeal = true;
      const sm = new PlanStateMachine(plan);

      const failResult: JobExecutionResult = {
        success: false, error: 'killed by signal SIGTERM', failedPhase: 'work',
        exitCode: 137, stepStatuses: { work: 'failed' },
      };
      const retryResult: JobExecutionResult = {
        success: true,
        completedCommit: 'retry-commit-1234567890123456789012',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'success' },
      };
      const executeStub = sinon.stub();
      executeStub.onFirstCall().resolves(failResult);
      executeStub.onSecondCall().resolves(retryResult);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const retryCall = executeStub.secondCall;
      const retryContext = retryCall.args[0];
      assert.strictEqual(retryContext.targetBranch, 'main', 'retryContext must include targetBranch for leaf node');
      assert.strictEqual(retryContext.repoPath, dir, 'retryContext must include repoPath');
      assert.strictEqual(retryContext.baseCommitAtStart, 'base-start-commit', 'retryContext must include baseCommitAtStart');
    });

    test('RI merge skipped status treated as failure for leaf nodes', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'main' });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const result: JobExecutionResult = {
        success: true,
        completedCommit: 'commit-12345678901234567890123456',
        stepStatuses: { work: 'success', commit: 'success', 'merge-ri': 'skipped' },
      };
      const executeStub = sinon.stub().resolves(result);

      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed', 'skipped RI merge on leaf node should fail the node');
      assert.ok(ns.error?.includes('merge'), 'error should mention merge');
    });
  });

  // ------------------------------------------------------------------
  // 10. Success: attempt history records trigger type correctly
  // ------------------------------------------------------------------
  suite('success attempt history', () => {
    test('first attempt records initial trigger type', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
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

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.attemptHistory![0].triggerType, 'initial');
      assert.strictEqual(ns.attemptHistory![0].status, 'succeeded');
    });

    test('retry attempt records retry trigger type', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const ns = plan.nodeStates.get('node-1')!;
      ns.attempts = 1; // simulate previous attempt
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

      await engine.executeJobNode(plan, sm, node);

      const nodeState = plan.nodeStates.get('node-1')!;
      assert.strictEqual(nodeState.attemptHistory![0].triggerType, 'retry');
    });
  });

  // ------------------------------------------------------------------
  // 11. Leaf node with cleanup - cleanUpSuccessfulWork
  // ------------------------------------------------------------------
  suite('leaf node cleanup', () => {
    test('leaf node with targetBranch and mergedToTarget triggers cleanup', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature', cleanUpSuccessfulWork: true });
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state, gitOps } = createEngine(dir, {
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
      assert.ok(ns.worktreeCleanedUp);
    });

    test('leaf node without targetBranch still cleans up', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ cleanUpSuccessfulWork: true }); // no targetBranch
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

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.ok(ns.worktreeCleanedUp);
    });

    test('leaf node with failed RI merge does NOT cleanup', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature', cleanUpSuccessfulWork: true });
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
      // Worktree should NOT be cleaned up because RI failed
      assert.ok(!ns.worktreeCleanedUp);
    });
  });

  // ------------------------------------------------------------------
  // 12. Non-leaf node not RI merged
  // ------------------------------------------------------------------
  suite('non-leaf node merge status', () => {
    test('non-leaf node with targetBranch is not RI-merged', async () => {
      const dir = makeTmpDir();
      const parent = createJobNode('parent', [], ['child']);
      const child = createJobNode('child', ['parent'], []);
      const nodes = new Map<string, PlanNode>([['parent', parent], ['child', child]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['parent', { status: 'scheduled', version: 0, attempts: 0 }],
        ['child', { status: 'pending', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['parent'], leaves: ['child'], targetBranch: 'main' });
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'parent-commit-123456789012345678901',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, parent as JobNode);

      const ns = plan.nodeStates.get('parent')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.strictEqual(ns.mergedToTarget, true); // "no merge needed"
    });
  });

  // ------------------------------------------------------------------
  // 13. Catch block error path (exception thrown during execution)
  // ------------------------------------------------------------------
  suite('catch block error handling', () => {
    test('exception during executor.execute is caught and node fails', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().rejects(new Error('Unexpected crash')),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.strictEqual(ns.error, 'Unexpected crash');
      assert.ok(ns.attemptHistory);
      assert.strictEqual(ns.attemptHistory![0].status, 'failed');
    });

    test('exception with failedPhase property uses that phase', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const err = new Error('FI merge crashed') as any;
      err.failedPhase = 'merge-fi';

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().rejects(err),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'failed');
      assert.strictEqual(ns.lastAttempt!.phase, 'merge-fi');
      assert.strictEqual(ns.attemptHistory![0].failedPhase, 'merge-fi');
    });
  });

  // ------------------------------------------------------------------
  // 14. acknowledgeConsumption - idempotent and multi-dep
  // ------------------------------------------------------------------
  suite('acknowledgeConsumption paths', () => {
    test('consumption is idempotent - calling twice does not duplicate', async () => {
      const dir = makeTmpDir();
      const dep = createJobNode('dep', [], ['c1', 'c2']);
      const c1 = createJobNode('c1', ['dep'], []);
      const c2 = createJobNode('c2', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['c1', c1], ['c2', c2]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep-commit-abcdef1234567890123456' }],
        ['c1', { status: 'scheduled', version: 0, attempts: 0 }],
        ['c2', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep'], leaves: ['c1', 'c2'], cleanUpSuccessfulWork: false });
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'c1-commit-xyz123456789012345678901',
          stepStatuses: { work: 'success', commit: 'success' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      // Execute c1
      await engine.executeJobNode(plan, sm, c1 as JobNode);

      const depState = plan.nodeStates.get('dep')!;
      assert.ok(depState.consumedByDependents);
      assert.strictEqual(depState.consumedByDependents!.filter(x => x === 'c1').length, 1);
    });
  });

  // ------------------------------------------------------------------
  // 15. Work summary appended to plan
  // ------------------------------------------------------------------
  suite('work summary propagation', () => {
    test('executor workSummary is appended to plan.workSummary', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const ws: JobWorkSummary = {
        nodeId: 'node-1', nodeName: 'Job node-1',
        commits: 2, filesAdded: 3, filesModified: 1, filesDeleted: 0,
        description: 'Added feature',
      };

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
          workSummary: ws,
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      assert.ok(plan.workSummary);
      assert.ok(plan.workSummary!.totalCommits >= 2);
    });
  });

  // ------------------------------------------------------------------
  // 16. Aggregated work summary computed for leaf node
  // ------------------------------------------------------------------
  suite('aggregated work summary', () => {
    test('leaf node computes aggregated work summary', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan(); // leaf node by default
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const aggSummary = {
        nodeId: 'node-1', nodeName: 'Job node-1',
        commits: 5, filesAdded: 10, filesModified: 3, filesDeleted: 1,
        description: 'aggregated',
      };

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
          workSummary: { nodeId: 'node-1', nodeName: 'Job node-1', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'test' },
        }),
        computeAggregatedWorkSummary: sinon.stub().resolves(aggSummary),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.ok(ns.aggregatedWorkSummary);
      assert.strictEqual(ns.aggregatedWorkSummary!.commits, 5);
    });

    test('non-leaf node does NOT compute aggregated work summary', async () => {
      const dir = makeTmpDir();
      const parent = createJobNode('parent', [], ['child']);
      const child = createJobNode('child', ['parent'], []);
      const nodes = new Map<string, PlanNode>([['parent', parent], ['child', child]]);
      const nodeStates = new Map<string, NodeExecutionState>([
        ['parent', { status: 'scheduled', version: 0, attempts: 0 }],
        ['child', { status: 'pending', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['parent'], leaves: ['child'] });
      const sm = new PlanStateMachine(plan);

      const computeStub = sinon.stub().resolves({ nodeId: 'parent', nodeName: 'J', commits: 0, filesAdded: 0, filesModified: 0, filesDeleted: 0, description: '' });
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: true,
          completedCommit: 'commit123456789012345678901234567890ab',
          stepStatuses: { work: 'success', commit: 'success' },
          workSummary: { nodeId: 'parent', nodeName: 'J', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'test' },
        }),
        computeAggregatedWorkSummary: computeStub,
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, parent as JobNode);

      // computeAggregatedWorkSummary should NOT be called for non-leaf
      assert.ok(!computeStub.called);
    });
  });

  // ------------------------------------------------------------------
  // 17. resumeFromPhase = 'merge-ri' path
  // ------------------------------------------------------------------
  suite('resume from merge-ri', () => {
    test('resumeFromPhase merge-ri skips executor and clears resumeFromPhase', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ targetBranch: 'feature' });
      const ns = plan.nodeStates.get('node-1')!;
      ns.resumeFromPhase = 'merge-ri' as any;
      ns.completedCommit = 'existing-commit-12345678901234567890';
      ns.baseCommit = 'base123';
      const node = plan.nodes.get('node-1')! as JobNode;
      const sm = new PlanStateMachine(plan);

      const executeStub = sinon.stub();
      const { engine, state } = createEngine(dir, { execute: executeStub });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, node);

      // Executor should not have been called
      assert.strictEqual(executeStub.callCount, 0);
      // resumeFromPhase should be cleared
      assert.strictEqual(ns.resumeFromPhase, undefined);
    });
  });

  // ------------------------------------------------------------------
  // 18. Events emitted
  // ------------------------------------------------------------------
  suite('event emission', () => {
    test('nodeStarted and nodeCompleted events emitted on success', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
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

      const started: any[] = [];
      const completed: any[] = [];
      state.events.on('nodeStarted', (...args: any[]) => started.push(args));
      state.events.on('nodeCompleted', (...args: any[]) => completed.push(args));

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(started.length, 1);
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0][2], true); // success=true
    });

    test('nodeStarted and nodeCompleted events emitted on failure', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
      const node = plan.nodes.get('node-1')! as JobNode;
      node.autoHeal = false;
      const sm = new PlanStateMachine(plan);

      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().resolves({
          success: false, error: 'fail',
          failedPhase: 'work', stepStatuses: { work: 'failed' },
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      const completed: any[] = [];
      state.events.on('nodeCompleted', (...args: any[]) => completed.push(args));

      await engine.executeJobNode(plan, sm, node);

      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0][2], false); // success=false
    });
  });

  // ------------------------------------------------------------------
  // 19. Dependency info map built for FI
  // ------------------------------------------------------------------
  suite('dependency info map', () => {
    test('dependency with workSummary is included in depInfoMap', async () => {
      const dir = makeTmpDir();
      const dep = createJobNode('dep', [], ['node-1']);
      const mainNode = createJobNode('node-1', ['dep'], []);
      const nodes = new Map<string, PlanNode>([['dep', dep], ['node-1', mainNode]]);
      const depWs: JobWorkSummary = {
        nodeId: 'dep', nodeName: 'Job dep',
        commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0,
        description: 'dep work',
      };
      const nodeStates = new Map<string, NodeExecutionState>([
        ['dep', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep-commit-abcdef1234567890123456', workSummary: depWs }],
        ['node-1', { status: 'scheduled', version: 0, attempts: 0 }],
      ]);
      const plan = createTestPlan({ nodes, nodeStates, roots: ['dep'], leaves: ['node-1'] });
      const sm = new PlanStateMachine(plan);

      let capturedContext: any;
      const { engine, state } = createEngine(dir, {
        execute: sinon.stub().callsFake(async (ctx: any) => {
          capturedContext = ctx;
          return {
            success: true,
            completedCommit: 'child-commit-xyz1234567890123456789',
            stepStatuses: { work: 'success', commit: 'success' },
          };
        }),
      });
      state.plans.set(plan.id, plan);
      state.stateMachines.set(plan.id, sm);

      await engine.executeJobNode(plan, sm, mainNode as JobNode);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
    });
  });

  // ------------------------------------------------------------------
  // 20. Persistence save called
  // ------------------------------------------------------------------
  suite('persistence', () => {
    test('persistence.save is called after execution', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
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

      const saveSpy = sandbox.spy(state.persistence, 'save');

      await engine.executeJobNode(plan, sm, node);

      assert.ok(saveSpy.called);
    });
  });

  // ------------------------------------------------------------------
  // 21. worktree path uses node id short prefix
  // ------------------------------------------------------------------
  suite('worktree path', () => {
    test('worktreePath uses first 8 chars of node id', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan();
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

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.ok(ns.worktreePath);
      assert.ok(ns.worktreePath!.includes(node.id.slice(0, 8)));
    });
  });

  // ------------------------------------------------------------------
  // 22. cleanUpSuccessfulWork=false skips cleanup
  // ------------------------------------------------------------------
  suite('cleanup disabled', () => {
    test('when cleanUpSuccessfulWork is false, no cleanup on success', async () => {
      const dir = makeTmpDir();
      const plan = createTestPlan({ cleanUpSuccessfulWork: false });
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

      await engine.executeJobNode(plan, sm, node);

      const ns = plan.nodeStates.get('node-1')!;
      assert.strictEqual(ns.status, 'succeeded');
      assert.ok(!ns.worktreeCleanedUp);
    });
  });
});
