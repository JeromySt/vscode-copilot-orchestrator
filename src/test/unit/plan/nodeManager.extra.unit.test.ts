/**
 * @fileoverview Extra unit tests for NodeManager covering:
 * - Line 374: plan.definition?.getWorkSpec(nodeId) when jobNode.work is undefined
 * - Lines 416-423: hasNewPostchecks && failedPhase === 'postchecks' branch
 * - Lines 461-462: clearWorktree with resetHard/clean calls
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeManager } from '../../../plan/nodeManager';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import { PlanStateMachine } from '../../../plan/stateMachine';
import type { PlanInstance, NodeExecutionState, JobNode } from '../../../plan/types';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodemgr-extra-'));
  tmpDirs.push(dir);
  return dir;
}

function createJobNode(id: string, opts: Partial<JobNode> = {}): JobNode {
  return {
    id, producerId: id, name: `Job ${id}`, type: 'job',
    task: `Task ${id}`,
    work: { type: 'shell', command: 'echo test' },
    dependencies: [], dependents: [], ...opts,
  };
}

function createMockGit(overrides?: Record<string, any>): any {
  return {
    branches: { exists: sinon.stub().resolves(true), current: sinon.stub().resolves('main') },
    repository: {
      fetch: sinon.stub().resolves(),
      resetHard: sinon.stub().resolves(),
      clean: sinon.stub().resolves(),
    },
    worktrees: { removeSafe: sinon.stub().resolves() },
    ...overrides,
  };
}

function makeState(dir: string, planId: string, plan: PlanInstance, git?: any) {
  const sm = new PlanStateMachine(plan);
  const persistence = new PlanPersistence(dir);
  const events = new PlanEventEmitter();
  return {
    plans: new Map([[planId, plan]]),
    stateMachines: new Map([[planId, sm]]),
    persistence,
    events,
    processMonitor: { isRunning: sinon.stub().returns(false), terminate: sinon.stub().resolves() } as any,
    executor: {} as any,
  };
}

function createFailedPlan(nodeWork?: JobNode['work']): PlanInstance {
  const node = createJobNode('n1', { work: nodeWork });
  return {
    id: 'plan-1',
    spec: { name: 'Test', jobs: [], baseBranch: 'main' },
    jobs: new Map([['n1', node]]),
    producerIdToNodeId: new Map([['n1', 'n1']]),
    roots: ['n1'], leaves: ['n1'],
    nodeStates: new Map([['n1', { status: 'failed', version: 1, attempts: 1 } as NodeExecutionState]]),
    groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
    repoPath: '/repo', baseBranch: 'main',
    worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
    cleanUpSuccessfulWork: false, maxParallel: 4,
  };
}

suite('NodeManager - extra coverage', () => {
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

  suite('retryNode - plan.definition.getWorkSpec fallback (line 374)', () => {
    test('uses plan.definition.getWorkSpec when jobNode.work is undefined', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan(undefined); // work is undefined
      const node = plan.jobs.get('n1') as JobNode;
      node.work = undefined; // Ensure work is falsy

      // Add definition with getWorkSpec
      const getWorkSpec = sinon.stub().resolves({ type: 'shell', command: 'echo from-definition' });
      (plan as any).definition = { getWorkSpec };

      const state = makeState(dir, 'plan-1', plan);
      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1');
      assert.strictEqual(result.success, true);
      // getWorkSpec should have been called as fallback
      assert.ok(getWorkSpec.calledWith('n1'));
    });

    test('isAgentWork detection via resolvedWork from definition', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan(undefined);
      const node = plan.jobs.get('n1') as JobNode;
      node.work = undefined;

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.copilotSessionId = 'session-abc';
      nodeState.lastAttempt = { phase: 'work', startTime: Date.now(), endTime: Date.now(), error: 'agent failed' };

      // Return agent work spec from definition
      const agentWork = { type: 'agent', instructions: 'fix it' };
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(agentWork) };

      const state = makeState(dir, 'plan-1', plan);
      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1');
      assert.strictEqual(result.success, true);
    });

    test('handles null definition gracefully (getWorkSpec not called)', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan(undefined);
      const node = plan.jobs.get('n1') as JobNode;
      node.work = undefined;
      (plan as any).definition = undefined;

      const state = makeState(dir, 'plan-1', plan);
      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1');
      assert.strictEqual(result.success, true);
    });
  });

  suite('retryNode - hasNewPostchecks && failedPhase === postchecks (lines 415-423)', () => {
    test('sets resumeFromPhase to postchecks when postchecks failed and newPostchecks provided', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.lastAttempt = { phase: 'postchecks', startTime: Date.now(), endTime: Date.now(), error: 'checks failed' };
      // resumeFromPhase is not set
      nodeState.resumeFromPhase = undefined;

      const state = makeState(dir, 'plan-1', plan);
      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPostchecks: { type: 'shell', command: 'echo new-checks' },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(nodeState.resumeFromPhase, 'postchecks');
    });

    test('does not override resumeFromPhase if already at earlier phase', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.lastAttempt = { phase: 'postchecks', startTime: Date.now(), endTime: Date.now(), error: 'checks failed' };
      // Set resumeFromPhase to an earlier phase (work is index 3, postchecks is index 5)
      nodeState.resumeFromPhase = 'work' as any;

      const state = makeState(dir, 'plan-1', plan);
      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPostchecks: { type: 'shell', command: 'echo new-checks' },
      });
      assert.strictEqual(result.success, true);
      // resumeFromPhase should remain at 'work' (earlier phase takes priority)
      assert.strictEqual(nodeState.resumeFromPhase, 'work');
    });

    test('overrides resumeFromPhase when postchecks is earlier than existing', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.lastAttempt = { phase: 'postchecks', startTime: Date.now(), endTime: Date.now(), error: 'failed' };
      // merge-ri is later than postchecks, so postchecks should take priority
      nodeState.resumeFromPhase = 'merge-ri' as any;

      const state = makeState(dir, 'plan-1', plan);
      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPostchecks: { type: 'shell', command: 'echo new-checks' },
      });
      assert.strictEqual(result.success, true);
      // postchecks (idx 5) < merge-ri (idx 6), so postchecks should win
      assert.strictEqual(nodeState.resumeFromPhase, 'postchecks');
    });
  });

  suite('retryNode - clearWorktree with resetHard and clean (lines 460-465)', () => {
    test('calls resetHard and clean when clearWorktree=true and no upstream deps', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const mockGit = createMockGit();

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.worktreePath = '/worktrees/n1';
      nodeState.baseCommit = 'abc123';

      const state = makeState(dir, 'plan-1', plan, mockGit);
      const mgr = new NodeManager(state as any, createMockLogger(), mockGit);

      const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });
      assert.strictEqual(result.success, true);
      // resetHard and clean should be called
      assert.ok(mockGit.repository.resetHard.calledWith('/worktrees/n1', 'abc123'));
      assert.ok(mockGit.repository.clean.calledWith('/worktrees/n1'));
    });

    test('does not call resetHard if baseCommit is missing', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const mockGit = createMockGit();

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.worktreePath = '/worktrees/n1';
      nodeState.baseCommit = undefined; // No base commit

      const state = makeState(dir, 'plan-1', plan, mockGit);
      const mgr = new NodeManager(state as any, createMockLogger(), mockGit);

      const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });
      assert.strictEqual(result.success, true);
      // resetHard should NOT be called without baseCommit
      assert.ok(mockGit.repository.resetHard.notCalled);
    });

    test('handles resetHard failure gracefully (warns and continues)', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const mockGit = createMockGit({
        repository: {
          fetch: sinon.stub().resolves(),
          resetHard: sinon.stub().rejects(new Error('cannot reset')),
          clean: sinon.stub().resolves(),
        },
      });

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.worktreePath = '/worktrees/n1';
      nodeState.baseCommit = 'abc123';

      const state = makeState(dir, 'plan-1', plan, mockGit);
      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, mockGit);

      // Should not throw - error is warned and execution continues
      const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });
      assert.strictEqual(result.success, true);
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/reset/)));
    });

    test('returns error when clearWorktree=true and upstream deps have commits', async () => {
      const dir = makeTmpDir();

      // Create plan with n1 depending on dep1
      const dep1: JobNode = createJobNode('dep1', { dependencies: [], dependents: ['n1'] });
      const n1: JobNode = createJobNode('n1', { dependencies: ['dep1'], dependents: [] });

      const plan: PlanInstance = {
        id: 'plan-1',
        spec: { name: 'Test', jobs: [], baseBranch: 'main' },
        jobs: new Map([['n1', n1], ['dep1', dep1]]),
        producerIdToNodeId: new Map([['n1', 'n1'], ['dep1', 'dep1']]),
        roots: ['dep1'], leaves: ['n1'],
        nodeStates: new Map([
          ['n1', { status: 'failed', version: 1, attempts: 1, worktreePath: '/wt' } as NodeExecutionState],
          ['dep1', { status: 'succeeded', version: 1, attempts: 1, completedCommit: 'abc' } as NodeExecutionState],
        ]),
        groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
        repoPath: '/repo', baseBranch: 'main',
        worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
        cleanUpSuccessfulWork: false, maxParallel: 4,
      };

      const sm = new PlanStateMachine(plan);
      const persistence = new PlanPersistence(dir);
      const events = new PlanEventEmitter();
      const state = {
        plans: new Map([['plan-1', plan]]),
        stateMachines: new Map([['plan-1', sm]]),
        persistence, events,
        processMonitor: { isRunning: sinon.stub().returns(false) } as any,
        executor: {} as any,
      };

      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());
      const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });

      // Should fail because upstream dep has commits
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('upstream dependencies'));
    });
  });

  suite('retryNode - git fetch before worktree clear (line 453-456)', () => {
    test('calls git fetch before clearing worktree', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const mockGit = createMockGit();

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.worktreePath = '/worktrees/n1';
      nodeState.baseCommit = 'abc123';

      const state = makeState(dir, 'plan-1', plan, mockGit);
      const mgr = new NodeManager(state as any, createMockLogger(), mockGit);

      await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });

      // fetch should be called before resetHard
      assert.ok(mockGit.repository.fetch.calledBefore(mockGit.repository.resetHard));
    });

    test('handles fetch failure gracefully before worktree clear', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const mockGit = createMockGit({
        repository: {
          fetch: sinon.stub().rejects(new Error('fetch failed')),
          resetHard: sinon.stub().resolves(),
          clean: sinon.stub().resolves(),
        },
      });

      const nodeState = plan.nodeStates.get('n1')!;
      nodeState.worktreePath = '/worktrees/n1';
      nodeState.baseCommit = 'abc123';

      const state = makeState(dir, 'plan-1', plan, mockGit);
      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, mockGit);

      // Should not throw - fetch failure is a warning, not fatal
      const result = await mgr.retryNode('plan-1', 'n1', { clearWorktree: true });
      assert.strictEqual(result.success, true);
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/fetch/)));
    });
  });

  suite('retryNode - planRepository write paths (lines 325-365)', () => {
    test('writes newWork spec to planRepository when definition is present', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const writeNodeSpec = sinon.stub().resolves();
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = { writeNodeSpec, saveStateSync: sinon.stub() };

      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newWork: { type: 'shell', command: 'echo updated' },
      });
      assert.strictEqual(result.success, true);
      assert.ok(writeNodeSpec.calledWithMatch('plan-1', 'n1', 'work', sinon.match.any));
    });

    test('warns if writing newWork spec to planRepository fails', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = {
        writeNodeSpec: sinon.stub().rejects(new Error('write failed')),
        saveStateSync: sinon.stub(),
      };

      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, createMockGit());

      // Should not throw
      const result = await mgr.retryNode('plan-1', 'n1', {
        newWork: { type: 'shell', command: 'echo updated' },
      });
      assert.strictEqual(result.success, true);
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/newWork/)));
    });

    test('writes newPrechecks spec to planRepository when not null', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const writeNodeSpec = sinon.stub().resolves();
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = { writeNodeSpec, saveStateSync: sinon.stub() };

      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPrechecks: { type: 'shell', command: 'echo pre-check' },
      });
      assert.strictEqual(result.success, true);
      assert.ok(writeNodeSpec.calledWithMatch('plan-1', 'n1', 'prechecks', sinon.match.any));
    });

    test('skips writing newPrechecks to store when null (delete)', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const writeNodeSpec = sinon.stub().resolves();
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = { writeNodeSpec, saveStateSync: sinon.stub() };

      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', { newPrechecks: null });
      assert.strictEqual(result.success, true);
      // writeNodeSpec should NOT be called for null prechecks (deletion)
      const preCheckCalls = writeNodeSpec.args.filter((a: any[]) => a[2] === 'prechecks');
      assert.strictEqual(preCheckCalls.length, 0);
    });

    test('writes newPostchecks spec to planRepository when not null', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      const writeNodeSpec = sinon.stub().resolves();
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = { writeNodeSpec, saveStateSync: sinon.stub() };

      const mgr = new NodeManager(state as any, createMockLogger(), createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPostchecks: { type: 'shell', command: 'echo post-check' },
      });
      assert.strictEqual(result.success, true);
      assert.ok(writeNodeSpec.calledWithMatch('plan-1', 'n1', 'postchecks', sinon.match.any));
    });

    test('warns if writing newPostchecks spec to planRepository fails', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = {
        writeNodeSpec: sinon.stub().rejects(new Error('postchecks write error')),
        saveStateSync: sinon.stub(),
      };

      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPostchecks: { type: 'shell', command: 'echo post-check' },
      });
      assert.strictEqual(result.success, true);
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/newPostchecks/)));
    });

    test('warns if writing newPrechecks spec to planRepository fails (lines 347-349)', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      (plan as any).definition = { getWorkSpec: sinon.stub().resolves(null) };

      const state = makeState(dir, 'plan-1', plan);
      (state as any).planRepository = {
        writeNodeSpec: sinon.stub().rejects(new Error('prechecks write error')),
        saveStateSync: sinon.stub(),
      };

      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, createMockGit());

      const result = await mgr.retryNode('plan-1', 'n1', {
        newPrechecks: { type: 'shell', command: 'echo pre-check' },
      });
      assert.strictEqual(result.success, true);
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/newPrechecks/)));
    });
  });

  suite('forceFailNode – executor cancel and processMonitor error paths', () => {
    test('handles executor.cancel throwing (lines 241-246)', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      // Set node to running so forceFailNode can proceed
      (plan.nodeStates.get('n1') as NodeExecutionState).status = 'running';
      (plan.nodeStates.get('n1') as NodeExecutionState).pid = undefined;

      const state = makeState(dir, 'plan-1', plan);
      // Add executor with cancel that throws
      (state as any).executor = {
        cancel: sinon.stub().throws(new Error('cancel failed')),
      };

      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, createMockGit());

      // Should not throw - error is caught and logged at debug level
      await assert.doesNotReject(() => mgr.forceFailNode('plan-1', 'n1'));
      assert.ok((log.debug as sinon.SinonStub).calledWithMatch(sinon.match(/cancel/)));
    });

    test('handles processMonitor.terminate throwing (lines 253-255)', async () => {
      const dir = makeTmpDir();
      const plan = createFailedPlan({ type: 'shell', command: 'echo work' });
      (plan.nodeStates.get('n1') as NodeExecutionState).status = 'running';
      (plan.nodeStates.get('n1') as NodeExecutionState).pid = 12345;

      const state = makeState(dir, 'plan-1', plan);
      (state as any).processMonitor = {
        isRunning: sinon.stub().returns(true),
        terminate: sinon.stub().rejects(new Error('terminate failed')),
      };
      (state as any).executor = {};

      const log = createMockLogger();
      const mgr = new NodeManager(state as any, log, createMockGit());

      // Should not throw - error is caught and logged at debug level
      await assert.doesNotReject(() => mgr.forceFailNode('plan-1', 'n1'));
      assert.ok((log.debug as sinon.SinonStub).calledWithMatch(sinon.match(/kill process/)));
    });
  });
});
