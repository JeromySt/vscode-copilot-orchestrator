/**
 * @fileoverview Coverage tests for JobExecutionEngine private methods
 * Targets uncovered utility methods, branch update logic, and cleanup paths.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobExecutionEngine, ExecutionEngineState } from '../../../plan/executionEngine';
import { NodeManager } from '../../../plan/nodeManager';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import type { PlanInstance, JobNode, NodeExecutionState, PlanNode, JobWorkSummary, CommitDetail } from '../../../plan/types';
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
    cleanUpSuccessfulWork: opts?.cleanUpSuccessfulWork ?? true, maxParallel: 4,
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
      createOrReuseDetached: sinon.stub().resolves({ reused: false, baseCommit: 'base123', totalMs: 100 }),
      removeSafe: sinon.stub().resolves(true),
    },
    gitignore: { ensureGitignoreEntries: sinon.stub().resolves(false) },
    repository: {
      updateRef: sinon.stub().resolves(),
      resolveRef: sinon.stub().resolves('target-sha-123'),
      stageFile: sinon.stub().resolves(),
      hasChangesBetween: sinon.stub().resolves(true),
      hasUncommittedChanges: sinon.stub().resolves(false),
      getFileDiff: sinon.stub().resolves(''),
      getStagedFileDiff: sinon.stub().resolves(''),
      getDirtyFiles: sinon.stub().resolves([]),
      resetHard: sinon.stub().resolves(),
      checkoutFile: sinon.stub().resolves(),
      stashPush: sinon.stub().resolves(),
      stashPop: sinon.stub().resolves(),
      stashDrop: sinon.stub().resolves(),
      stashShowFiles: sinon.stub().resolves([]),
      stashShowPatch: sinon.stub().resolves(''),
    },
    merge: {
      mergeWithoutCheckout: sinon.stub().resolves({ success: true, treeSha: 'tree-sha-123' }),
      commitTree: sinon.stub().resolves('new-commit-123'),
    },
    branches: {
      getCommit: sinon.stub().resolves('abc123'),
      currentOrNull: sinon.stub().resolves(null),
    },
  };
}

function makeEngine(): { engine: any; state: ExecutionEngineState; log: ILogger; git: any; nodeManager: NodeManager } {
  const dir = makeTmpDir();
  const state = createEngineState(dir);
  const log = createMockLogger();
  const git = createMockGitOperations();
  const nodeManager = new NodeManager(state as any, log, git);
  const engine = new JobExecutionEngine(state, nodeManager, log, git);
  return { engine, state, log, git, nodeManager };
}

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

  // ============================================================================
  // diffContainsOnlyOrchestratorPatterns
  // ============================================================================

  test('diffContainsOnlyOrchestratorPatterns returns true for orchestrator-only diff', () => {
    const { engine } = makeEngine();
    const diff = [
      'diff --git a/.gitignore b/.gitignore',
      'index abc..def 100644',
      '--- a/.gitignore',
      '+++ b/.gitignore',
      '@@ -1,2 +1,4 @@',
      ' node_modules',
      '+.orchestrator/',
      '+# Copilot Orchestrator',
      '+',
    ].join('\n');
    assert.strictEqual((engine as any).diffContainsOnlyOrchestratorPatterns(diff), true);
  });

  test('diffContainsOnlyOrchestratorPatterns returns false for non-orchestrator changes', () => {
    const { engine } = makeEngine();
    const diff = [
      'diff --git a/.gitignore b/.gitignore',
      '@@ -1,2 +1,3 @@',
      '+dist/',
      '+.orchestrator/',
    ].join('\n');
    assert.strictEqual((engine as any).diffContainsOnlyOrchestratorPatterns(diff), false);
  });

  test('diffContainsOnlyOrchestratorPatterns handles removed orchestrator lines', () => {
    const { engine } = makeEngine();
    const diff = '@@ -1 +1 @@\n-.orchestrator/';
    assert.strictEqual((engine as any).diffContainsOnlyOrchestratorPatterns(diff), true);
  });

  // ============================================================================
  // summarizeCommitFiles
  // ============================================================================

  test('summarizeCommitFiles returns empty string for no changes', () => {
    const { engine } = makeEngine();
    const commit: CommitDetail = {
      hash: 'abc123', shortHash: 'abc1234', message: 'test', author: 'test', date: '2024-01-01',
      filesAdded: [], filesModified: [], filesDeleted: [],
    };
    assert.strictEqual((engine as any).summarizeCommitFiles(commit), '');
  });

  test('summarizeCommitFiles shows added, modified, deleted counts', () => {
    const { engine } = makeEngine();
    const commit: CommitDetail = {
      hash: 'abc123', shortHash: 'abc1234', message: 'test', author: 'test', date: '2024-01-01',
      filesAdded: ['src/a.ts'], filesModified: ['src/b.ts'], filesDeleted: ['src/c.ts'],
    };
    const result = (engine as any).summarizeCommitFiles(commit);
    assert.ok(result.includes('+1'));
    assert.ok(result.includes('~1'));
    assert.ok(result.includes('-1'));
  });

  test('summarizeCommitFiles truncates with more indicator', () => {
    const { engine } = makeEngine();
    const commit: CommitDetail = {
      hash: 'abc123', shortHash: 'abc1234', message: 'test', author: 'test', date: '2024-01-01',
      filesAdded: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], filesModified: [], filesDeleted: [],
    };
    const result = (engine as any).summarizeCommitFiles(commit);
    assert.ok(result.includes('+4'));
    assert.ok(result.includes('more'));
  });

  // ============================================================================
  // logDependencyWorkSummary
  // ============================================================================

  test('logDependencyWorkSummary handles undefined workSummary', () => {
    const { engine, state } = makeEngine();
    (engine as any).logDependencyWorkSummary('plan-1', 'node-1', undefined, 1);
    assert.ok((state.executor!.log as sinon.SinonStub).called);
  });

  test('logDependencyWorkSummary handles empty commitDetails', () => {
    const { engine, state } = makeEngine();
    const ws: JobWorkSummary = {
      nodeId: 'n1', nodeName: 'J', commits: 2, filesAdded: 1,
      filesModified: 3, filesDeleted: 0, description: '',
    };
    (engine as any).logDependencyWorkSummary('plan-1', 'node-1', ws, 1);
    assert.ok((state.executor!.log as sinon.SinonStub).called);
  });

  test('logDependencyWorkSummary logs commit details', () => {
    const { engine, state } = makeEngine();
    const ws: JobWorkSummary = {
      nodeId: 'n1', nodeName: 'J', commits: 1, filesAdded: 1,
      filesModified: 0, filesDeleted: 0, description: '',
      commitDetails: [{
        hash: 'abc', shortHash: 'abc1234', message: 'feat: add thing', author: 'test', date: '2024-01-01',
        filesAdded: ['src/thing.ts'], filesModified: [], filesDeleted: [],
      }],
    };
    (engine as any).logDependencyWorkSummary('plan-1', 'node-1', ws, 1);
    const logCalls = (state.executor!.log as sinon.SinonStub).args;
    assert.ok(logCalls.some((c: any[]) => typeof c[4] === 'string' && c[4].includes('abc1234')));
  });

  // ============================================================================
  // allConsumersConsumed
  // ============================================================================

  test('allConsumersConsumed returns true for leaf with no targetBranch', () => {
    const { engine } = makeEngine();
    const plan = createTestPlan();
    const node = createJobNode('node-1', [], []);
    const state: NodeExecutionState = { status: 'succeeded', version: 0, attempts: 1 };
    assert.strictEqual((engine as any).allConsumersConsumed(plan, node, state), true);
  });

  test('allConsumersConsumed returns false for leaf with targetBranch not merged', () => {
    const { engine } = makeEngine();
    const plan = createTestPlan({ targetBranch: 'main' });
    const node = createJobNode('node-1', [], []);
    const state: NodeExecutionState = { status: 'succeeded', version: 0, attempts: 1, mergedToTarget: false };
    assert.strictEqual((engine as any).allConsumersConsumed(plan, node, state), false);
  });

  test('allConsumersConsumed returns true for leaf with targetBranch merged', () => {
    const { engine } = makeEngine();
    const plan = createTestPlan({ targetBranch: 'main' });
    const node = createJobNode('node-1', [], []);
    const state: NodeExecutionState = { status: 'succeeded', version: 0, attempts: 1, mergedToTarget: true };
    assert.strictEqual((engine as any).allConsumersConsumed(plan, node, state), true);
  });

  test('allConsumersConsumed returns false when not all dependents consumed', () => {
    const { engine } = makeEngine();
    const plan = createTestPlan();
    const node = createJobNode('node-1', [], ['node-2', 'node-3']);
    const state: NodeExecutionState = {
      status: 'succeeded', version: 0, attempts: 1,
      consumedByDependents: ['node-2'],
    };
    assert.strictEqual((engine as any).allConsumersConsumed(plan, node, state), false);
  });

  test('allConsumersConsumed returns true when all dependents consumed', () => {
    const { engine } = makeEngine();
    const plan = createTestPlan();
    const node = createJobNode('node-1', [], ['node-2', 'node-3']);
    const state: NodeExecutionState = {
      status: 'succeeded', version: 0, attempts: 1,
      consumedByDependents: ['node-2', 'node-3'],
    };
    assert.strictEqual((engine as any).allConsumersConsumed(plan, node, state), true);
  });

  // ============================================================================
  // withRiMergeLock
  // ============================================================================

  test('withRiMergeLock serializes access', async () => {
    const { engine } = makeEngine();
    const order: number[] = [];
    const p1 = (engine as any).withRiMergeLock(async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    const p2 = (engine as any).withRiMergeLock(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2]);
  });

  test('withRiMergeLock releases on error', async () => {
    const { engine } = makeEngine();
    try {
      await (engine as any).withRiMergeLock(async () => { throw new Error('boom'); });
    } catch {}
    // Should still work after error
    let ran = false;
    await (engine as any).withRiMergeLock(async () => { ran = true; });
    assert.ok(ran);
  });

  // ============================================================================
  // cleanupWorktree
  // ============================================================================

  test('cleanupWorktree calls git removeSafe', async () => {
    const { engine, git } = makeEngine();
    await (engine as any).cleanupWorktree('/wt/path', '/repo');
    assert.ok(git.worktrees.removeSafe.calledWith('/repo', '/wt/path', { force: true }));
  });

  test('cleanupWorktree handles error gracefully', async () => {
    const { engine, git, log } = makeEngine();
    git.worktrees.removeSafe.rejects(new Error('busy'));
    await (engine as any).cleanupWorktree('/wt/path', '/repo');
    assert.ok((log.warn as sinon.SinonStub).called);
  });

  // ============================================================================
  // acknowledgeConsumption
  // ============================================================================

  test('acknowledgeConsumption tracks consumer', async () => {
    const { engine, state } = makeEngine();
    const depNode = createJobNode('dep-1', [], ['consumer-1']);
    const consumerNode = createJobNode('consumer-1', ['dep-1'], []);
    const depState: NodeExecutionState = { status: 'succeeded', version: 0, attempts: 1, completedCommit: 'abc', worktreePath: '/wt/dep' };
    const plan = createTestPlan({
      nodes: new Map([['dep-1', depNode], ['consumer-1', consumerNode]]),
      nodeStates: new Map([
        ['dep-1', depState],
        ['consumer-1', { status: 'running', version: 0, attempts: 1 }],
      ]),
      leaves: ['consumer-1'],
      roots: ['dep-1'],
      cleanUpSuccessfulWork: false,
    });
    const sm = new PlanStateMachine(plan as any);
    await (engine as any).acknowledgeConsumption(plan, sm, consumerNode);
    assert.ok(depState.consumedByDependents?.includes('consumer-1'));
  });

  test('acknowledgeConsumption deduplicates', async () => {
    const { engine } = makeEngine();
    const depNode = createJobNode('dep-1', [], ['consumer-1']);
    const consumerNode = createJobNode('consumer-1', ['dep-1'], []);
    const depState: NodeExecutionState = {
      status: 'succeeded', version: 0, attempts: 1,
      consumedByDependents: ['consumer-1'],
    };
    const plan = createTestPlan({
      nodes: new Map([['dep-1', depNode], ['consumer-1', consumerNode]]),
      nodeStates: new Map([
        ['dep-1', depState],
        ['consumer-1', { status: 'running', version: 0, attempts: 1 }],
      ]),
      cleanUpSuccessfulWork: false,
    });
    const sm = new PlanStateMachine(plan as any);
    await (engine as any).acknowledgeConsumption(plan, sm, consumerNode);
    assert.strictEqual(depState.consumedByDependents?.filter((c: string) => c === 'consumer-1').length, 1);
  });

  // ============================================================================
  // updateBranchRef (retry logic)
  // ============================================================================

  test('updateBranchRef uses update-ref when not on target branch', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('other-branch');
    const result = await (engine as any).updateBranchRef('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
    assert.ok(git.repository.updateRef.calledOnce);
  });

  test('updateBranchRef uses reset --hard when on target branch (clean)', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('main');
    git.repository.hasUncommittedChanges.resolves(false);
    const result = await (engine as any).updateBranchRef('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
    assert.ok(git.repository.resetHard.calledOnce);
  });

  test('updateBranchRef retries on index.lock error', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('other-branch');
    git.repository.updateRef
      .onFirstCall().rejects(new Error('index.lock'))
      .onSecondCall().resolves();
    const result = await (engine as any).updateBranchRef('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
    assert.strictEqual(git.repository.updateRef.callCount, 2);
  });

  test('updateBranchRef throws non-lock errors', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('other-branch');
    git.repository.updateRef.rejects(new Error('permission denied'));
    await assert.rejects(() => (engine as any).updateBranchRef('/repo', 'main', 'newcommit'), /permission denied/);
  });

  test('updateBranchRefCore with dirty worktree stash flow', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('main');
    git.repository.hasUncommittedChanges.resolves(true);
    git.repository.getDirtyFiles.resolves(['.gitignore', 'src/foo.ts']);
    const result = await (engine as any).updateBranchRefCore('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
    assert.ok(git.repository.stashPush.calledOnce);
    assert.ok(git.repository.resetHard.calledOnce);
    assert.ok(git.repository.stashPop.calledOnce);
  });

  test('updateBranchRefCore returns false when stash fails', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('main');
    git.repository.hasUncommittedChanges.resolves(true);
    git.repository.getDirtyFiles.resolves(['src/foo.ts']);
    git.repository.stashPush.rejects(new Error('could not write index'));
    const result = await (engine as any).updateBranchRefCore('/repo', 'main', 'newcommit');
    assert.strictEqual(result, false);
  });

  test('updateBranchRefCore with only .gitignore dirty (orchestrator changes)', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('main');
    git.repository.hasUncommittedChanges.resolves(true);
    git.repository.getDirtyFiles.resolves(['.gitignore']);
    git.repository.getFileDiff.resolves('+.orchestrator/\n');
    const result = await (engine as any).updateBranchRefCore('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
  });

  test('updateBranchRefCore handles stash pop failure with orchestrator stash', async () => {
    const { engine, git } = makeEngine();
    git.branches.currentOrNull.resolves('main');
    git.repository.hasUncommittedChanges.resolves(true);
    git.repository.getDirtyFiles.resolves(['.gitignore', 'other.txt']);
    git.repository.stashPop.rejects(new Error('conflict'));
    git.repository.stashShowFiles.resolves(['.gitignore']);
    git.repository.stashShowPatch.resolves('+.orchestrator/\n');
    const result = await (engine as any).updateBranchRefCore('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
    assert.ok(git.repository.stashDrop.calledOnce);
  });

  test('updateBranchRefCore handles stash pop failure with user changes', async () => {
    const { engine, git, log } = makeEngine();
    git.branches.currentOrNull.resolves('main');
    git.repository.hasUncommittedChanges.resolves(true);
    git.repository.getDirtyFiles.resolves(['.gitignore', 'other.txt']);
    git.repository.stashPop.rejects(new Error('conflict'));
    git.repository.stashShowFiles.resolves(['.gitignore', 'user-file.txt']);
    const result = await (engine as any).updateBranchRefCore('/repo', 'main', 'newcommit');
    assert.strictEqual(result, true);
    assert.ok((log.warn as sinon.SinonStub).calledWith(sinon.match(/user changes/)));
  });

  // ============================================================================
  // isGitignoreOnlyOrchestratorChanges
  // ============================================================================

  test('isGitignoreOnlyOrchestratorChanges returns true for no diff', async () => {
    const { engine, git } = makeEngine();
    git.repository.getFileDiff.resolves('');
    git.repository.getStagedFileDiff.resolves('');
    const result = await (engine as any).isGitignoreOnlyOrchestratorChanges('/repo');
    assert.strictEqual(result, true);
  });

  test('isGitignoreOnlyOrchestratorChanges checks staged diff when unstaged is empty', async () => {
    const { engine, git } = makeEngine();
    git.repository.getFileDiff.resolves('');
    git.repository.getStagedFileDiff.resolves('+.orchestrator/\n');
    const result = await (engine as any).isGitignoreOnlyOrchestratorChanges('/repo');
    assert.strictEqual(result, true);
  });

  test('isGitignoreOnlyOrchestratorChanges returns false on error', async () => {
    const { engine, git } = makeEngine();
    git.repository.getFileDiff.rejects(new Error('fail'));
    const result = await (engine as any).isGitignoreOnlyOrchestratorChanges('/repo');
    assert.strictEqual(result, false);
  });

  // ============================================================================
  // isStashOnlyOrchestratorGitignore
  // ============================================================================

  test('isStashOnlyOrchestratorGitignore returns false for empty stash', async () => {
    const { engine, git } = makeEngine();
    git.repository.stashShowFiles.resolves([]);
    const result = await (engine as any).isStashOnlyOrchestratorGitignore('/repo');
    assert.strictEqual(result, false);
  });

  test('isStashOnlyOrchestratorGitignore returns false for multiple files', async () => {
    const { engine, git } = makeEngine();
    git.repository.stashShowFiles.resolves(['.gitignore', 'src/foo.ts']);
    const result = await (engine as any).isStashOnlyOrchestratorGitignore('/repo');
    assert.strictEqual(result, false);
  });

  test('isStashOnlyOrchestratorGitignore returns true for orchestrator-only .gitignore', async () => {
    const { engine, git } = makeEngine();
    git.repository.stashShowFiles.resolves(['.gitignore']);
    git.repository.stashShowPatch.resolves('+.orchestrator/\n+# Copilot Orchestrator\n');
    const result = await (engine as any).isStashOnlyOrchestratorGitignore('/repo');
    assert.strictEqual(result, true);
  });

  test('isStashOnlyOrchestratorGitignore returns false on error', async () => {
    const { engine, git } = makeEngine();
    git.repository.stashShowFiles.rejects(new Error('no stash'));
    const result = await (engine as any).isStashOnlyOrchestratorGitignore('/repo');
    assert.strictEqual(result, false);
  });

  // ============================================================================
  // cleanupEligibleWorktrees
  // ============================================================================

  test('cleanupEligibleWorktrees cleans up consumed non-leaf nodes', async () => {
    const { engine, git, state } = makeEngine();
    const depNode = createJobNode('dep-1', [], ['consumer-1']);
    const consumerNode = createJobNode('consumer-1', ['dep-1'], []);
    const wtPath = makeTmpDir();
    const depState: NodeExecutionState = {
      status: 'succeeded', version: 0, attempts: 1,
      worktreePath: wtPath,
      consumedByDependents: ['consumer-1'],
    };
    const plan = createTestPlan({
      nodes: new Map([['dep-1', depNode], ['consumer-1', consumerNode]]),
      nodeStates: new Map([
        ['dep-1', depState],
        ['consumer-1', { status: 'running', version: 0, attempts: 1 }],
      ]),
      leaves: ['consumer-1'],
      roots: ['dep-1'],
    });
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    await (engine as any).cleanupEligibleWorktrees(plan, sm);
    assert.ok(git.worktrees.removeSafe.called);
    assert.strictEqual(depState.worktreeCleanedUp, true);
  });

  test('cleanupEligibleWorktrees skips non-succeeded nodes', async () => {
    const { engine, git, state } = makeEngine();
    const node = createJobNode('node-1');
    const plan = createTestPlan({
      nodes: new Map([['node-1', node]]),
      nodeStates: new Map([['node-1', { status: 'running', version: 0, attempts: 1, worktreePath: '/wt' }]]),
    });
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    await (engine as any).cleanupEligibleWorktrees(plan, sm);
    assert.ok(!git.worktrees.removeSafe.called);
  });

  // ============================================================================
  // execLog
  // ============================================================================

  test('execLog calls executor.log when available', () => {
    const { engine, state } = makeEngine();
    (engine as any).execLog('p1', 'n1', 'work', 'info', 'test message', 1);
    assert.ok((state.executor!.log as sinon.SinonStub).calledWith('p1', 'n1', 'work', 'info', 'test message', 1));
  });

  test('execLog does nothing when no executor', () => {
    const dir = makeTmpDir();
    const state = createEngineState(dir);
    state.executor = undefined;
    const log = createMockLogger();
    const git = createMockGitOperations();
    const nodeManager = new NodeManager(state as any, log, git);
    const engine = new JobExecutionEngine(state, nodeManager, log, git);
    // Should not throw
    (engine as any).execLog('p1', 'n1', 'work', 'info', 'test');
  });

  // ============================================================================
  // executeJobNode - error paths
  // ============================================================================

  test('executeJobNode returns early when nodeState is missing', async () => {
    const { engine, state, log, git } = makeEngine();
    const plan = createTestPlan({
      nodeStates: new Map(), // empty - no state for node-1
    });
    const sm = new PlanStateMachine(plan as any);
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    // Should return without error
    assert.ok(!(log.info as sinon.SinonStub).calledWith(sinon.match(/Executing job node/)));
  });

  test('executeJobNode handles worktree creation failure', async () => {
    const { engine, state, log, git } = makeEngine();
    git.worktrees.createOrReuseDetached.rejects(new Error('disk full'));
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.ok(nodeState.error?.includes('disk full'));
    assert.ok(nodeState.stepStatuses?.['merge-fi'] === 'failed');
  });

  test('executeJobNode handles executor failure without auto-heal', async () => {
    const { engine, state, log, git } = makeEngine();
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    // Make executor fail with agent work (no auto-heal for agent failures unless killed)
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: false, error: 'test failure', failedPhase: 'work',
      stepStatuses: { 'merge-fi': 'success', work: 'failed' },
    });
    const node = createJobNode('node-1', [], [], { work: { type: 'agent', instructions: 'test' }, autoHeal: false });
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.strictEqual(nodeState.error, 'test failure');
    assert.ok((sm.transition as sinon.SinonStub).calledWith('node-1', 'failed'));
  });

  test('executeJobNode stores metrics on success', async () => {
    const { engine, state, log, git } = makeEngine();
    const plan = createTestPlan({ targetBranch: undefined, leaves: ['node-1'] });
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success' },
      metrics: { turnsUsed: 5, tokensIn: 1000, tokensOut: 500 },
      phaseMetrics: { work: { durationMs: 5000 } },
      copilotSessionId: 'session-123',
      pid: 12345,
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.strictEqual(nodeState.completedCommit, 'commit-abc');
    assert.strictEqual(nodeState.copilotSessionId, 'session-123');
    assert.ok(nodeState.metrics);
    assert.ok(nodeState.phaseMetrics);
  });

  test('executeJobNode computes aggregated work summary for leaf', async () => {
    const { engine, state, log, git } = makeEngine();
    const plan = createTestPlan({ leaves: ['node-1'] });
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
      workSummary: { nodeId: 'node-1', nodeName: 'Job node-1', commits: 1, filesAdded: 1, filesModified: 0, filesDeleted: 0, description: 'test' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.ok(nodeState.aggregatedWorkSummary);
  });

  test('executeJobNode handles resume from merge-ri', async () => {
    const { engine, state, log, git } = makeEngine();
    const plan = createTestPlan({ targetBranch: 'main', leaves: ['node-1'] });
    const nodeState: NodeExecutionState = {
      status: 'scheduled', version: 0, attempts: 0,
      resumeFromPhase: 'merge-ri',
      completedCommit: 'existing-commit',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success' },
    };
    plan.nodeStates.set('node-1', nodeState);
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    // Should skip executor entirely
    assert.ok(!(state.executor!.execute as sinon.SinonStub).called);
  });

  test('executeJobNode handles reused worktree', async () => {
    const { engine, state, log, git } = makeEngine();
    git.worktrees.createOrReuseDetached.resolves({ reused: true, baseCommit: 'base999', totalMs: 50 });
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    // baseCommit from reused worktree
    assert.strictEqual(nodeState.baseCommit, 'base999');
  });

  test('executeJobNode captures baseCommitAtStart on first worktree', async () => {
    const { engine, state, git } = makeEngine();
    git.worktrees.createOrReuseDetached.resolves({ reused: false, baseCommit: 'first-base', totalMs: 100 });
    const plan = createTestPlan();
    delete (plan as any).baseCommitAtStart;
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    assert.strictEqual(plan.baseCommitAtStart, 'first-base');
  });

  test('executeJobNode logs slow worktree creation', async () => {
    const { engine, state, git, log: mockLog } = makeEngine();
    git.worktrees.createOrReuseDetached.resolves({ reused: false, baseCommit: 'base123', totalMs: 2000 });
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    assert.ok((mockLog.warn as sinon.SinonStub).calledWith(sinon.match(/Slow worktree/)));
  });

  test('executeJobNode handles gitignore update failure gracefully', async () => {
    const { engine, state, git, log: mockLog } = makeEngine();
    git.gitignore.ensureGitignoreEntries.rejects(new Error('EACCES'));
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    assert.ok((mockLog.warn as sinon.SinonStub).calledWith(sinon.match(/Failed to update .gitignore/)));
  });

  test('executeJobNode stages gitignore when modified', async () => {
    const { engine, state, git } = makeEngine();
    git.gitignore.ensureGitignoreEntries.resolves(true); // modified
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    assert.ok(git.repository.stageFile.calledOnce);
  });

  test('executeJobNode builds dependency info map', async () => {
    const { engine, state, git } = makeEngine();
    const depNode = createJobNode('dep-1', [], ['node-1']);
    const mainNode = createJobNode('node-1', ['dep-1'], []);
    const depState: NodeExecutionState = {
      status: 'succeeded', version: 0, attempts: 1,
      completedCommit: 'dep-commit-abc',
      workSummary: { nodeId: 'dep-1', nodeName: 'Job dep-1', commits: 1, filesAdded: 0, filesModified: 1, filesDeleted: 0, description: '' },
    };
    const mainState: NodeExecutionState = { status: 'scheduled', version: 0, attempts: 0 };
    const plan = createTestPlan({
      nodes: new Map([['dep-1', depNode], ['node-1', mainNode]]),
      nodeStates: new Map([['dep-1', depState], ['node-1', mainState]]),
      leaves: ['node-1'],
      roots: ['dep-1'],
    });
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns(['base-commit', 'dep-commit-abc']);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-final',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    await engine.executeJobNode(plan, sm, mainNode);
    // Verify dependencyCommits were passed to executor
    const executeCall = (state.executor!.execute as sinon.SinonStub).firstCall;
    const ctx = executeCall.args[0];
    assert.ok(ctx.dependencyCommits);
    assert.strictEqual(ctx.dependencyCommits.length, 1);
    assert.strictEqual(ctx.dependencyCommits[0].commit, 'dep-commit-abc');
  });

  test('executeJobNode cleans leaf worktree on success when cleanUpSuccessfulWork', async () => {
    const { engine, state, git } = makeEngine();
    const wtPath = makeTmpDir();
    git.worktrees.createOrReuseDetached.resolves({ reused: false, baseCommit: 'base123', totalMs: 100, worktreePath: wtPath });
    const plan = createTestPlan({ leaves: ['node-1'], cleanUpSuccessfulWork: true });
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: 'commit-abc',
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    // mergedToTarget should be true since merge-ri succeeded
    assert.strictEqual(nodeState.mergedToTarget, true);
  });

  test('executeJobNode falls back to baseCommit when no completedCommit', async () => {
    const { engine, state, git } = makeEngine();
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: true, completedCommit: undefined,
      stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
    });
    const node = createJobNode('node-1');
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.strictEqual(nodeState.completedCommit, 'base123');
  });

  // ============================================================================
  // Auto-heal paths
  // ============================================================================

  test('executeJobNode auto-heals non-agent failure', async () => {
    const { engine, state, git } = makeEngine();
    const wtDir = makeTmpDir();
    // Create .github/instructions directory for heal file writing
    const instrDir = path.join(wtDir, '.github', 'instructions');
    fs.mkdirSync(instrDir, { recursive: true });
    git.worktrees.createOrReuseDetached.resolves({ reused: false, baseCommit: 'base123', totalMs: 100 });
    const plan = createTestPlan();
    // Use real worktree path so fs operations work
    plan.worktreeRoot = wtDir;
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub)
      .onFirstCall().resolves({
        success: false, error: 'exit code 1', failedPhase: 'work', exitCode: 1,
        stepStatuses: { 'merge-fi': 'success', work: 'failed' },
      })
      .onSecondCall().resolves({
        success: true, completedCommit: 'healed-commit',
        stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
        workSummary: { nodeId: 'node-1', nodeName: 'J', commits: 1, filesAdded: 0, filesModified: 1, filesDeleted: 0, description: 'healed' },
        metrics: { turnsUsed: 3 },
        phaseMetrics: { work: { durationMs: 2000 } },
      });
    const node = createJobNode('node-1', [], [], { work: { type: 'shell', command: 'npm test' } });
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.strictEqual(nodeState.completedCommit, 'healed-commit');
    assert.ok(nodeState.autoHealAttempted?.work);
  });

  test('executeJobNode auto-retries externally killed agent', async () => {
    const { engine, state, git } = makeEngine();
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub)
      .onFirstCall().resolves({
        success: false, error: 'killed by signal SIGTERM', failedPhase: 'work',
        stepStatuses: { 'merge-fi': 'success', work: 'failed' },
      })
      .onSecondCall().resolves({
        success: true, completedCommit: 'retry-commit',
        stepStatuses: { 'merge-fi': 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
        copilotSessionId: 'retry-session',
      });
    const node = createJobNode('node-1', [], [], { work: { type: 'agent', instructions: 'do stuff' } });
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.strictEqual(nodeState.completedCommit, 'retry-commit');
    assert.strictEqual(nodeState.copilotSessionId, 'retry-session');
  });

  test('executeJobNode handles auto-retry failure for killed agent', async () => {
    const { engine, state, git } = makeEngine();
    const plan = createTestPlan();
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub)
      .onFirstCall().resolves({
        success: false, error: 'killed by signal SIGKILL', failedPhase: 'work',
        stepStatuses: { 'merge-fi': 'success', work: 'failed' },
      })
      .onSecondCall().resolves({
        success: false, error: 'failed again', failedPhase: 'work',
        stepStatuses: { 'merge-fi': 'success', work: 'failed' },
        metrics: { turnsUsed: 2 },
        phaseMetrics: { work: { durationMs: 1000 } },
      });
    const node = createJobNode('node-1', [], [], { work: { type: 'agent', instructions: 'do stuff' } });
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.ok(nodeState.error?.includes('Auto-retry failed'));
    assert.ok((sm.transition as sinon.SinonStub).calledWith('node-1', 'failed'));
  });

  test('executeJobNode auto-heal failure records attempt history', async () => {
    const { engine, state, git } = makeEngine();
    const wtDir = makeTmpDir();
    git.worktrees.createOrReuseDetached.resolves({ reused: false, baseCommit: 'base123', totalMs: 100 });
    const plan = createTestPlan();
    plan.worktreeRoot = wtDir;
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub)
      .onFirstCall().resolves({
        success: false, error: 'exit code 1', failedPhase: 'work', exitCode: 1,
        stepStatuses: { 'merge-fi': 'success', work: 'failed' },
      })
      .onSecondCall().resolves({
        success: false, error: 'heal failed too', failedPhase: 'work',
        stepStatuses: { 'merge-fi': 'success', work: 'failed' },
        metrics: { turnsUsed: 1 },
        phaseMetrics: { work: { durationMs: 500 } },
      });
    const node = createJobNode('node-1', [], [], { work: { type: 'shell', command: 'npm test' } });
    await engine.executeJobNode(plan, sm, node);
    const nodeState = plan.nodeStates.get('node-1')!;
    assert.ok(nodeState.error?.includes('Auto-heal failed'));
    assert.ok(nodeState.attemptHistory!.length >= 2);
    const healAttempt = nodeState.attemptHistory!.find(a => a.triggerType === 'auto-heal');
    assert.ok(healAttempt);
  });

  test('executeJobNode skips auto-heal when already attempted', async () => {
    const { engine, state, git } = makeEngine();
    const plan = createTestPlan();
    const nodeState: NodeExecutionState = {
      status: 'scheduled', version: 0, attempts: 0,
      autoHealAttempted: { work: true },
    };
    plan.nodeStates.set('node-1', nodeState);
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub).resolves({
      success: false, error: 'exit code 1', failedPhase: 'work', exitCode: 1,
      stepStatuses: { 'merge-fi': 'success', work: 'failed' },
    });
    const node = createJobNode('node-1', [], [], { work: { type: 'shell', command: 'npm test' } });
    await engine.executeJobNode(plan, sm, node);
    // Should fail without attempting auto-heal
    assert.strictEqual((state.executor!.execute as sinon.SinonStub).callCount, 1);
  });

  test('executeJobNode auto-heals prechecks phase', async () => {
    const { engine, state, git } = makeEngine();
    const wtDir = makeTmpDir();
    const instrDir = path.join(wtDir, '.github', 'instructions');
    fs.mkdirSync(instrDir, { recursive: true });
    fs.writeFileSync(path.join(instrDir, 'orchestrator-job-abc.instructions.md'), 'test');
    git.worktrees.createOrReuseDetached.resolves({ reused: false, baseCommit: 'base123', totalMs: 100 });
    const plan = createTestPlan();
    plan.worktreeRoot = wtDir;
    sandbox.stub(state.persistence, 'save');
    const sm = new PlanStateMachine(plan as any);
    sandbox.stub(sm, 'transition');
    sandbox.stub(sm, 'getBaseCommitsForNode').returns([]);
    (state.executor!.execute as sinon.SinonStub)
      .onFirstCall().resolves({
        success: false, error: 'lint failed', failedPhase: 'prechecks', exitCode: 1,
        stepStatuses: { 'merge-fi': 'success', prechecks: 'failed' },
      })
      .onSecondCall().resolves({
        success: true, completedCommit: 'healed-commit',
        stepStatuses: { 'merge-fi': 'success', prechecks: 'success', work: 'success', commit: 'success', 'merge-ri': 'success' },
      });
    const node = createJobNode('node-1', [], [], {
      prechecks: { type: 'shell', command: 'npm run lint' },
    });
    await engine.executeJobNode(plan, sm, node);
    const ns = plan.nodeStates.get('node-1')!;
    assert.strictEqual(ns.completedCommit, 'healed-commit');
  });
});
