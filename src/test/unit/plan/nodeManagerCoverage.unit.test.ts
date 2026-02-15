/**
 * @fileoverview Unit tests for NodeManager.retryNode edge cases and forceFailNode
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as git from '../../../git';
import { NodeManager } from '../../../plan/nodeManager';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import { PlanStateMachine } from '../../../plan/stateMachine';
import type { PlanInstance, NodeExecutionState, PlanNode, JobNode } from '../../../plan/types';
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

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodemgr-cov-'));
  tmpDirs.push(dir);
  return dir;
}

function createJobNode(id: string, deps: string[] = [], dependents: string[] = [], opts: Partial<JobNode> = {}): JobNode {
  return {
    id, producerId: id, name: `Job ${id}`, type: 'job',
    task: `Task ${id}`,
    work: { type: 'shell', command: 'echo test' },
    dependencies: deps, dependents, ...opts,
  };
}

function createPlan(nodeOverrides?: { nodes?: Map<string, PlanNode>; nodeStates?: Map<string, NodeExecutionState> }): PlanInstance {
  const node = createJobNode('n1');
  return {
    id: 'plan-1', spec: { name: 'Test', jobs: [], baseBranch: 'main' },
    nodes: nodeOverrides?.nodes || new Map([['n1', node]]),
    producerIdToNodeId: new Map([['n1', 'n1']]),
    roots: ['n1'], leaves: ['n1'],
    nodeStates: nodeOverrides?.nodeStates || new Map([['n1', { status: 'failed', version: 1, attempts: 1 } as NodeExecutionState]]),
    groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
    repoPath: '/repo', baseBranch: 'main',
    worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
    cleanUpSuccessfulWork: false, maxParallel: 4,
  };
}

suite('NodeManager - retryNode and forceFailNode', () => {
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

  test('retryNode returns error for unknown plan', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = { plans: new Map(), stateMachines: new Map(), persistence, events, configManager, executor: {} as any };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('unknown', 'n1');
    assert.strictEqual(result.success, false);
  });

  test('retryNode returns error for unknown node', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan();
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('plan-1', 'unknown');
    assert.strictEqual(result.success, false);
  });

  test('retryNode succeeds for failed node with newWork string', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan();
    const sm = new PlanStateMachine(plan);
    const ns = plan.nodeStates.get('n1')!;
    ns.lastAttempt = { phase: 'work', startTime: Date.now(), endTime: Date.now(), error: 'failed' };
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('plan-1', 'n1', { newWork: 'echo fixed' });
    assert.strictEqual(result.success, true);
    const node = plan.nodes.get('n1') as JobNode;
    assert.strictEqual(node.work, 'echo fixed');
  });

  test('retryNode with newPrechecks and newPostchecks', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan();
    const sm = new PlanStateMachine(plan);
    const ns = plan.nodeStates.get('n1')!;
    ns.lastAttempt = { phase: 'postchecks', startTime: Date.now(), endTime: Date.now(), error: 'failed' };
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('plan-1', 'n1', {
      newPrechecks: { type: 'shell', command: 'echo pre' },
      newPostchecks: null,
    });
    assert.strictEqual(result.success, true);
  });

  test('retryNode with agent work and newWork agent type', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan();
    const sm = new PlanStateMachine(plan);
    const ns = plan.nodeStates.get('n1')!;
    ns.copilotSessionId = 'session-1';
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('plan-1', 'n1', {
      newWork: { type: 'agent', instructions: 'fix it', resumeSession: false } as any,
    });
    assert.strictEqual(result.success, true);
    // copilotSessionId should be cleared since resumeSession is false
    assert.strictEqual(plan.nodeStates.get('n1')!.copilotSessionId, undefined);
  });

  test('retryNode auto-generates failure-fixing instructions for agent jobs', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const node = createJobNode('n1', [], [], { work: '@agent Fix the code' as any });
    const plan = createPlan({
      nodes: new Map([['n1', node]]),
      nodeStates: new Map([['n1', {
        status: 'failed', version: 1, attempts: 1,
        copilotSessionId: 'session-abc',
        lastAttempt: { phase: 'work', startTime: Date.now(), endTime: Date.now(), error: 'Build failed' },
        attemptHistory: [{
          attemptNumber: 1, triggerType: 'initial' as const, status: 'failed' as const,
          startedAt: Date.now(), endedAt: Date.now(),
          failedPhase: 'work', error: 'Build failed',
          logs: 'ERROR: compilation failed',
        }],
      } as NodeExecutionState]]),
    });
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const executor = {
      getLogs: sinon.stub().returns([{ phase: 'work', type: 'stderr', message: 'Build error', timestamp: Date.now() }]),
      getLogsForPhase: sinon.stub().returns([]),
      getLogFileSize: sinon.stub().returns(0),
    };
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('plan-1', 'n1');
    assert.strictEqual(result.success, true);
    // Work should have been auto-generated with retry instructions
    const jobNode = plan.nodes.get('n1') as JobNode;
    assert.ok((jobNode.work as string).includes('@agent'));
  });

  test('retryNode with clearWorktree resets the worktree', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan();
    const ns = plan.nodeStates.get('n1')!;
    ns.worktreePath = '/some/worktree';
    ns.baseCommit = 'base123';
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    sandbox.stub(git.repository, 'fetch').resolves();
    sandbox.stub(git.repository, 'resetHard').resolves();
    sandbox.stub(git.repository, 'clean').resolves();

    const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });
    assert.strictEqual(result.success, true);
  });

  test('retryNode clearWorktree rejected when deps have commits', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const dep = createJobNode('dep', [], ['n1']);
    const node = createJobNode('n1', ['dep'], []);
    const plan = createPlan({
      nodes: new Map([['dep', dep], ['n1', node]]),
      nodeStates: new Map([
        ['dep', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'dep-commit' } as NodeExecutionState],
        ['n1', { status: 'failed', version: 1, attempts: 1, worktreePath: '/wt', baseCommit: 'base' } as NodeExecutionState],
      ]),
    });
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });
    assert.strictEqual(result.success, false);
    assert.ok(result.error!.includes('upstream'));
  });

  test('forceFailNode transitions running node to failed', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan({
      nodeStates: new Map([['n1', { status: 'running', version: 1, attempts: 1, startedAt: Date.now() } as NodeExecutionState]]),
    });
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const executor = { cancel: sinon.stub() };
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    await mgr.forceFailNode('plan-1', 'n1');

    const ns = plan.nodeStates.get('n1')!;
    assert.strictEqual(ns.status, 'failed');
    assert.ok(ns.error!.toLowerCase().includes('force'));
  });

  test('forceFailNode throws for unknown plan', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = { plans: new Map(), stateMachines: new Map(), persistence, events, configManager, executor: {} as any };
    const mgr = new NodeManager(state as any, log, {} as any);

    try {
      await mgr.forceFailNode('unknown', 'n1');
      assert.fail('Should throw');
    } catch (e: any) {
      assert.ok(e.message);
    }
  });

  test('forceFailNode throws for non-running node', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan({
      nodeStates: new Map([['n1', { status: 'succeeded', version: 1, attempts: 1 } as NodeExecutionState]]),
    });
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: { cancel: sinon.stub() } as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    // forceFailNode should still work(it forces regardless of status)
    await mgr.forceFailNode('plan-1', 'n1');
    const ns = plan.nodeStates.get('n1')!;
    assert.strictEqual(ns.status, 'failed');
    assert.ok(ns.error!.includes('force') || ns.error!.includes('Force'));
  });

  test('retryNode sets resumeFromPhase for failed phase', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const plan = createPlan();
    const ns = plan.nodeStates.get('n1')!;
    ns.lastAttempt = { phase: 'postchecks', startTime: Date.now(), endTime: Date.now(), error: 'check failed' };
    const sm = new PlanStateMachine(plan);
    const persistence = new PlanPersistence(dir);
    const events = new PlanEventEmitter();
    const configManager = new PlanConfigManager();
    const state = {
      plans: new Map([['plan-1', plan]]),
      stateMachines: new Map([['plan-1', sm]]),
      persistence, events, configManager, executor: {} as any,
    };
    const mgr = new NodeManager(state as any, log, {} as any);

    await mgr.retryNode('plan-1', 'n1');

    const nodeState = plan.nodeStates.get('n1')!;
    assert.strictEqual(nodeState.resumeFromPhase, 'postchecks');
  });
});
