/**
 * @fileoverview Unit tests for PlanLifecycleManager cleanup and edge cases
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanLifecycleManager } from '../../../plan/planLifecycle';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import type { PlanInstance, NodeExecutionState, PlanNode, JobNode } from '../../../plan/types';
import type { ILogger } from '../../../interfaces/ILogger';
import { PlanStateMachine } from '../../../plan/stateMachine';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-test-'));
  tmpDirs.push(dir);
  return dir;
}

function createJobNode(id: string, deps: string[] = [], dependents: string[] = []): JobNode {
  return {
    id, producerId: id, name: `Job ${id}`, type: 'job',
    task: `Task ${id}`,
    work: { type: 'shell', command: 'echo test' },
    dependencies: deps, dependents,
  };
}

function makeState(dir: string, extras?: Record<string, any>) {
  const persistence = new PlanPersistence(dir);
  const events = new PlanEventEmitter();
  const configManager = new PlanConfigManager();
  return {
    plans: new Map(), stateMachines: new Map(),
    persistence, events, configManager,
    config: { storagePath: dir },
    ...extras,
  };
}

suite('PlanLifecycleManager', () => {
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

  test('cleanupPlanResources removes worktrees and log files', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();

    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'plan-1_node-1.log'), 'test log');
    fs.writeFileSync(path.join(logsDir, 'plan-1_node-2.log'), 'test log 2');
    fs.writeFileSync(path.join(logsDir, 'plan-2_node-1.log'), 'other plan');

    const state = makeState(dir, { executor: { storagePath: dir } });
    const mockGit = {
      worktrees: { removeSafe: sinon.stub().resolves() },
      gitignore: { ensureGitignoreEntries: sinon.stub().resolves(true) },
    };
    const lifecycle = new PlanLifecycleManager(state as any, log, mockGit as any);

    const worktreeDir = makeTmpDir();
    const plan: PlanInstance = {
      id: 'plan-1', spec: { name: 'Test', jobs: [], baseBranch: 'main' },
      nodes: new Map([['node-1', createJobNode('node-1')]]),
      producerIdToNodeId: new Map(),
      roots: ['node-1'], leaves: ['node-1'],
      nodeStates: new Map([['node-1', { status: 'succeeded', version: 1, attempts: 1, worktreePath: worktreeDir } as NodeExecutionState]]),
      groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
      repoPath: '/repo', baseBranch: 'main',
      worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
      cleanUpSuccessfulWork: false, maxParallel: 4,
    };

    await lifecycle.cleanupPlanResources(plan);

    assert.ok(mockGit.worktrees.removeSafe.called);
    assert.ok(!fs.existsSync(path.join(logsDir, 'plan-1_node-1.log')));
    assert.ok(!fs.existsSync(path.join(logsDir, 'plan-1_node-2.log')));
    assert.ok(fs.existsSync(path.join(logsDir, 'plan-2_node-1.log')));
  });

  test('cleanupPlanResources handles worktree removal error', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const state = makeState(dir);
    const mockGit = {
      worktrees: { removeSafe: sinon.stub().rejects(new Error('Cannot remove')) },
    };
    const lifecycle = new PlanLifecycleManager(state as any, log, mockGit as any);

    const plan: PlanInstance = {
      id: 'plan-1', spec: { name: 'Test', jobs: [], baseBranch: 'main' },
      nodes: new Map(), producerIdToNodeId: new Map(),
      roots: [], leaves: [],
      nodeStates: new Map([['n1', { status: 'succeeded', version: 1, attempts: 1, worktreePath: '/nonexistent' } as NodeExecutionState]]),
      groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
      repoPath: '/repo', baseBranch: 'main',
      worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
      cleanUpSuccessfulWork: false, maxParallel: 4,
    };

    await lifecycle.cleanupPlanResources(plan);

    assert.ok((log.warn as sinon.SinonStub).called);
  });

  test('cleanupPlanResources with no executor still works', async () => {
    const dir = makeTmpDir();
    const log = createMockLogger();
    const state = makeState(dir);
    const lifecycle = new PlanLifecycleManager(state as any, log, {} as any);

    const plan: PlanInstance = {
      id: 'plan-1', spec: { name: 'Test', jobs: [], baseBranch: 'main' },
      nodes: new Map(), producerIdToNodeId: new Map(),
      roots: [], leaves: [],
      nodeStates: new Map(),
      groups: new Map(), groupStates: new Map(), groupPathToId: new Map(),
      repoPath: '/repo', baseBranch: 'main',
      worktreeRoot: '/worktrees', createdAt: Date.now(), stateVersion: 0,
      cleanUpSuccessfulWork: false, maxParallel: 4,
    };

    await lifecycle.cleanupPlanResources(plan);
    assert.ok((log.info as sinon.SinonStub).calledWithMatch(sinon.match(/cleanup completed/i)));
  });
});
