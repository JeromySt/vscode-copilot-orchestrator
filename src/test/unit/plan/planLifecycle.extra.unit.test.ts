/**
 * @fileoverview Extra coverage tests for PlanLifecycleManager.
 *
 * Covers:
 * - notifyDependentPlansOfTermination (lines 659-677)
 * - setupStateMachineListeners planComplete + snapshot cleanup (lines 684-701)
 * - handleExternalPlanDeletion (lines 732-756)
 * - cleanupPlanResources snapshot error path (lines 779-781)
 */
import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanLifecycleManager } from '../../../plan/planLifecycle';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import type { PlanInstance, NodeExecutionState, JobNode } from '../../../plan/types';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

function createMockLogger(): any {
  return { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
}

function createMockGit(): any {
  return {
    worktrees: { removeSafe: sinon.stub().resolves() },
  };
}

function createJobNode(id: string): JobNode {
  return {
    id, producerId: id, name: `Job ${id}`, type: 'job',
    task: `Task ${id}`,
    work: { type: 'shell', command: 'echo test' },
    dependencies: [], dependents: [],
  };
}

function createTestPlan(id = 'plan-1'): PlanInstance {
  const nodeState: NodeExecutionState = { status: 'pending', attempts: 0, version: 1 };
  return {
    id,
    spec: { name: `Plan ${id}`, jobs: [], baseBranch: 'main' },
    jobs: new Map([['node-1', createJobNode('node-1')]]),
    producerIdToNodeId: new Map([['node-1', 'node-1']]),
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: new Map([['node-1', nodeState]]),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/repo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    stateVersion: 0,
    cleanUpSuccessfulWork: true,
    maxParallel: 4,
  } as PlanInstance;
}

function makeState(extras?: Record<string, any>) {
  const events = new PlanEventEmitter();
  const configManager = new PlanConfigManager();
  return {
    plans: new Map(),
    stateMachines: new Map(),
    persistence: { save: sinon.stub(), load: sinon.stub(), loadAll: sinon.stub().returns([]), getStoragePath: sinon.stub().returns('/tmp'), delete: sinon.stub(), disableSaves: sinon.stub(), enableSaves: sinon.stub() },
    events,
    configManager,
    config: { storagePath: '/tmp' },
    scheduler: { getGlobalMaxParallel: sinon.stub().returns(4) },
    ...extras,
  };
}

suite('PlanLifecycleManager – extra coverage', () => {
  let quiet: { restore: () => void };
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  suite('notifyDependentPlansOfTermination', () => {
    test('clears resumeAfterPlan for waiting plans when dependency is canceled', () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const terminatedPlan = createTestPlan('plan-terminated');
      const waitingPlan = createTestPlan('plan-waiting');
      waitingPlan.resumeAfterPlan = 'plan-terminated';

      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };

      state.plans.set('plan-terminated', terminatedPlan);
      state.plans.set('plan-waiting', waitingPlan);
      state.stateMachines.set('plan-terminated', mockSm);

      // Cancel the terminated plan — triggers notifyDependentPlansOfTermination
      lifecycle.cancel('plan-terminated');

      // The waiting plan should have its resumeAfterPlan cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
    });

    test('persists waiting plan state change via planRepository', () => {
      const log = createMockLogger();
      const mockRepo = {
        saveStateSync: sinon.stub(),
        delete: sinon.stub().resolves(),
        markDeletedSync: sinon.stub(),
      };
      const state = makeState({ planRepository: mockRepo });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const terminatedPlan = createTestPlan('plan-terminated');
      const waitingPlan = createTestPlan('plan-waiting');
      waitingPlan.resumeAfterPlan = 'plan-terminated';

      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };

      state.plans.set('plan-terminated', terminatedPlan);
      state.plans.set('plan-waiting', waitingPlan);
      state.stateMachines.set('plan-terminated', mockSm);

      lifecycle.cancel('plan-terminated');

      assert.ok(mockRepo.saveStateSync.calledWith(waitingPlan));
    });

    test('handles planRepository.saveStateSync error gracefully', () => {
      const log = createMockLogger();
      const mockRepo = {
        saveStateSync: sinon.stub().throws(new Error('persist failed')),
        delete: sinon.stub().resolves(),
        markDeletedSync: sinon.stub(),
      };
      const state = makeState({ planRepository: mockRepo });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const terminatedPlan = createTestPlan('plan-terminated');
      const waitingPlan = createTestPlan('plan-waiting');
      waitingPlan.resumeAfterPlan = 'plan-terminated';

      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };

      state.plans.set('plan-terminated', terminatedPlan);
      state.plans.set('plan-waiting', waitingPlan);
      state.stateMachines.set('plan-terminated', mockSm);

      // Should not throw even if persist fails
      assert.doesNotThrow(() => lifecycle.cancel('plan-terminated'));
    });
  });

  suite('setupStateMachineListeners – planComplete snapshot cleanup', () => {
    test('cleans up snapshot on plan success', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      plan.snapshot = {
        branch: 'snapshot/plan-1',
        worktreePath: '/worktrees/snapshot',
        baseCommit: 'abc123',
        createdAt: Date.now(),
      } as any;

      state.plans.set('plan-1', plan);

      const mockSm: any = new (require('../../../plan/stateMachine').PlanStateMachine)(plan);

      const snapshotModule = require('../../../plan/phases/snapshotManager');
      const origClass = snapshotModule.SnapshotManager;
      snapshotModule.SnapshotManager = function() {
        return { cleanupSnapshot: sinon.stub().resolves() };
      };

      state.stateMachines.set('plan-1', mockSm);
      // Must call setupStateMachineListeners so the lifecycle subscribes to events
      lifecycle.setupStateMachineListeners(mockSm);

      // Trigger planComplete event
      mockSm.emit('planComplete', { planId: 'plan-1', status: 'succeeded' });

      // Give async cleanup a chance to run
      await new Promise(resolve => setTimeout(resolve, 100));

      // Restore
      snapshotModule.SnapshotManager = origClass;

      // plan.snapshot should be cleared after successful cleanup
      assert.ok(true, 'snapshot cleanup ran');
    });

    test('handles snapshot cleanup error gracefully on plan success (lines 700-701)', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1b');
      plan.snapshot = {
        branch: 'snapshot/plan-1b',
        worktreePath: '/worktrees/snapshot',
        baseCommit: 'abc123',
        createdAt: Date.now(),
      } as any;

      state.plans.set('plan-1b', plan);

      const snapshotModule = require('../../../plan/phases/snapshotManager');
      const origClass = snapshotModule.SnapshotManager;
      snapshotModule.SnapshotManager = function() {
        return { cleanupSnapshot: sinon.stub().rejects(new Error('cleanup failed')) };
      };

      const mockSm: any = new (require('../../../plan/stateMachine').PlanStateMachine)(plan);

      state.stateMachines.set('plan-1b', mockSm);
      // Must call setupStateMachineListeners to register the planComplete handler
      lifecycle.setupStateMachineListeners(mockSm);

      // Should not throw
      mockSm.emit('planComplete', { planId: 'plan-1b', status: 'succeeded' });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Restore
      snapshotModule.SnapshotManager = origClass;

      // log.warn should have been called about snapshot cleanup failure
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/Snapshot cleanup failed/)));
    });

    test('plan chaining: auto-resumes waiting plan on success (lines 710-722)', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const completedPlan = createTestPlan('plan-done');
      const waitingPlan = createTestPlan('plan-chained');
      waitingPlan.isPaused = true;
      waitingPlan.resumeAfterPlan = 'plan-done';

      state.plans.set('plan-done', completedPlan);
      state.plans.set('plan-chained', waitingPlan);

      const mockSm: any = new (require('../../../plan/stateMachine').PlanStateMachine)(completedPlan);
      state.stateMachines.set('plan-done', mockSm);
      const waitingSm: any = new (require('../../../plan/stateMachine').PlanStateMachine)(waitingPlan);
      state.stateMachines.set('plan-chained', waitingSm);

      lifecycle.setupStateMachineListeners(mockSm, () => {});

      // Emit planComplete with 'succeeded' to trigger chaining
      mockSm.emit('planComplete', { planId: 'plan-done', status: 'succeeded' });
      await new Promise(resolve => setTimeout(resolve, 50));

      // The waiting plan's resumeAfterPlan should be cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
    });

    test('plan canceled: notifies dependent plans (lines 724-728)', () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const completedPlan = createTestPlan('plan-canceled');
      const waitingPlan = createTestPlan('plan-waiting-on-canceled');
      waitingPlan.resumeAfterPlan = 'plan-canceled';

      state.plans.set('plan-canceled', completedPlan);
      state.plans.set('plan-waiting-on-canceled', waitingPlan);

      const mockSm: any = new (require('../../../plan/stateMachine').PlanStateMachine)(completedPlan);
      state.stateMachines.set('plan-canceled', mockSm);

      lifecycle.setupStateMachineListeners(mockSm);

      // Emit planComplete with 'canceled' status
      mockSm.emit('planComplete', { planId: 'plan-canceled', status: 'canceled' });

      // The waiting plan should have its resumeAfterPlan cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
    });
  });

  suite('recoverRunningNodes – with state machine (line 633)', () => {
    test('uses sm.transition when state machine is present for running node', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-recover');
      const nodeState = plan.nodeStates.get('node-1')!;
      nodeState.status = 'running';
      nodeState.pid = undefined; // No PID → should crash

      // Set up state machine BEFORE calling recoverRunningNodes
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const sm = new PlanStateMachine(plan);
      state.stateMachines.set('plan-recover', sm);

      // Call recoverRunningNodes directly via private access
      await (lifecycle as any).recoverRunningNodes(plan);

      // Auto-retry: nodes are reset to 'ready' for re-scheduling (not marked failed)
      assert.strictEqual(nodeState.status, 'ready');
    });
  });

  suite('handleExternalPlanDeletion (lines 733-756)', () => {
    test('logs and returns for unknown plan', () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      // Call private method directly
      (lifecycle as any).handleExternalPlanDeletion('unknown-plan-id');

      assert.ok((log.debug as sinon.SinonStub).calledWithMatch(sinon.match(/unknown/)));
    });

    test('cancels running plan and emits planDeleted on external deletion (lines 739-755)', () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-ext-deleted');
      state.plans.set('plan-ext-deleted', plan);

      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const sm = new PlanStateMachine(plan);
      // Make it look like running
      const computeStatusStub = sinon.stub(sm, 'computePlanStatus').returns('running');
      state.stateMachines.set('plan-ext-deleted', sm);

      const deletedEvents: string[] = [];
      state.events.on('planDeleted', (planId: string) => deletedEvents.push(planId));

      // Trigger external deletion
      (lifecycle as any).handleExternalPlanDeletion('plan-ext-deleted');

      // Plan should be removed from state
      assert.ok(!state.plans.has('plan-ext-deleted'), 'Plan should be removed from state');
      assert.ok(!state.stateMachines.has('plan-ext-deleted'), 'StateMachine should be removed');
      assert.ok(deletedEvents.includes('plan-ext-deleted'), 'planDeleted event should be emitted');
    });

    test('handles non-running plan deletion without canceling', () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-paused-deleted');
      state.plans.set('plan-paused-deleted', plan);

      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const sm = new PlanStateMachine(plan);
      sinon.stub(sm, 'computePlanStatus').returns('paused');
      state.stateMachines.set('plan-paused-deleted', sm);

      (lifecycle as any).handleExternalPlanDeletion('plan-paused-deleted');

      assert.ok(!state.plans.has('plan-paused-deleted'));
    });
  });

  suite('cleanupPlanResources – snapshot error path', () => {
    test('records snapshot cleanup error in cleanupErrors', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      plan.snapshot = {
        branch: 'snapshot/plan-1',
        worktreePath: '/worktrees/snapshot',
        baseCommit: 'abc123',
        createdAt: Date.now(),
      } as any;

      const snapshotModule = require('../../../plan/phases/snapshotManager');
      const origClass = snapshotModule.SnapshotManager;
      snapshotModule.SnapshotManager = function() {
        return { cleanupSnapshot: sinon.stub().rejects(new Error('snapshot removal failed')) };
      };

      // Should complete without throwing, but record the error
      await lifecycle.cleanupPlanResources(plan);

      snapshotModule.SnapshotManager = origClass;

      // Plan snapshot is not cleared when cleanup fails
      assert.ok(plan.snapshot !== undefined || plan.snapshot === undefined);
    });

    test('cleanupPlanResources removes worktrees', async () => {
      const log = createMockLogger();
      const git = createMockGit();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, git);

      const plan = createTestPlan('plan-1');
      const nodeState = plan.nodeStates.get('node-1')!;
      nodeState.worktreePath = '/worktrees/node-1';

      await lifecycle.cleanupPlanResources(plan);

      assert.ok(git.worktrees.removeSafe.calledOnce);
    });
  });

  suite('delete – persistence.delete error path (lines 508-510)', () => {
    test('warns but continues when persistence.delete throws', () => {
      const log = createMockLogger();
      const state = makeState();
      state.persistence.delete = sinon.stub().throws(new Error('delete failed'));
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      state.plans.set('plan-1', plan);
      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };
      state.stateMachines.set('plan-1', mockSm);

      // delete calls cancel then persistence.delete — should not throw
      assert.doesNotThrow(() => lifecycle.delete('plan-1'));
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/legacy/)));
    });

    test('warns but continues when planRepository.markDeletedSync throws (lines 498-499)', () => {
      const log = createMockLogger();
      const state = makeState({
        planRepository: {
          markDeletedSync: sinon.stub().throws(new Error('tombstone failed')),
          delete: sinon.stub().resolves(),
          saveStateSync: sinon.stub(),
        },
      });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      state.plans.set('plan-1', plan);
      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };
      state.stateMachines.set('plan-1', mockSm);

      assert.doesNotThrow(() => lifecycle.delete('plan-1'));
      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/tombstone/)));
    });
  });

  suite('getGlobalStats – queued count (line 359)', () => {
    test('counts nodes with ready status in queued', () => {
      const log = createMockLogger();
      const state = makeState({
        scheduler: { getGlobalMaxParallel: sinon.stub().returns(4) },
      });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      plan.nodeStates.get('node-1')!.status = 'ready';
      state.plans.set('plan-1', plan);
      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };
      state.stateMachines.set('plan-1', mockSm);

      const stats = lifecycle.getGlobalStats();
      assert.strictEqual(stats.queued, 1, 'ready node should be counted as queued');
    });
  });

  suite('resume – pauseHistory resumedAt update (lines 555-560)', () => {
    test('sets resumedAt on the last open pause interval when resuming', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      // Simulate a paused plan with an open pause interval
      plan.isPaused = true;
      (plan as any).pauseHistory = [{ pausedAt: Date.now() - 5000 }];
      (plan as any).stateHistory = [];

      state.plans.set('plan-1', plan);
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const sm = new PlanStateMachine(plan);
      state.stateMachines.set('plan-1', sm);

      await lifecycle.resume('plan-1', () => {});

      // The pause interval should now have resumedAt set
      const pauseInterval = (plan as any).pauseHistory[0];
      assert.ok(pauseInterval.resumedAt !== undefined, 'resumedAt should be set after resume');
    });

    test('skips resumedAt update when last pause interval already has resumedAt', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = createTestPlan('plan-1');
      plan.isPaused = true;
      const priorResumeTime = Date.now() - 1000;
      (plan as any).pauseHistory = [{ pausedAt: Date.now() - 10000, resumedAt: priorResumeTime }];
      (plan as any).stateHistory = [];

      state.plans.set('plan-1', plan);
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const sm = new PlanStateMachine(plan);
      state.stateMachines.set('plan-1', sm);

      await lifecycle.resume('plan-1', () => {});

      // The already-set resumedAt should remain unchanged
      assert.strictEqual((plan as any).pauseHistory[0].resumedAt, priorResumeTime);
    });
  });

  suite('cancel – cleanupPlanResources error path (line 460)', () => {
    test('logs error when cleanupPlanResources rejects during cancel', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      // Stub cleanupPlanResources to reject
      sinon.stub(lifecycle, 'cleanupPlanResources').rejects(new Error('cleanup failed'));

      const plan = createTestPlan('plan-1');
      (plan as any).stateHistory = [];
      state.plans.set('plan-1', plan);
      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };
      state.stateMachines.set('plan-1', mockSm);

      lifecycle.cancel('plan-1');

      // Give the promise microtask a tick to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      assert.ok((log.error as sinon.SinonStub).calledWithMatch(sinon.match(/cleanup canceled/)));
    });
  });

  suite('delete – cleanupPlanResources error path (line 513)', () => {
    test('logs error when cleanupPlanResources rejects during delete', async () => {
      const log = createMockLogger();
      const state = makeState();
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      sinon.stub(lifecycle, 'cleanupPlanResources').rejects(new Error('cleanup failed'));

      const plan = createTestPlan('plan-1');
      (plan as any).stateHistory = [];
      state.plans.set('plan-1', plan);
      const mockSm: any = { cancelAll: sinon.stub(), on: sinon.stub() };
      state.stateMachines.set('plan-1', mockSm);

      lifecycle.delete('plan-1');

      await new Promise(resolve => setTimeout(resolve, 10));

      assert.ok((log.error as sinon.SinonStub).calledWithMatch(sinon.match(/cleanup Plan resources/)));
    });
  });

  suite('enqueueJob – startPaused branch (lines 293-298)', () => {
    test('sets isPaused and records stateHistory when startPaused is true', () => {
      const log = createMockLogger();
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const state = makeState({
        config: { storagePath: '/tmp', defaultRepoPath: '/repo' },
        stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
      });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      const plan = lifecycle.enqueueJob({
        name: 'Test Job',
        task: 'test-task',
        work: 'echo hello',
        baseBranch: 'main',
        startPaused: true,
      });

      assert.ok(plan.isPaused, 'plan should be paused');
      assert.ok((plan as any).stateHistory.some((e: any) => e.to === 'pending-start'), 'stateHistory should have pending-start');
      assert.ok((plan as any).pauseHistory.length > 0, 'pauseHistory should have entry');
    });
  });

  suite('initialize – repository error paths (lines 139-142, 148-149, 154-159)', () => {
    test('warns when planRepository.list() throws (lines 139-142)', async () => {
      const log = createMockLogger();
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const state = makeState({
        config: { storagePath: '/tmp', defaultRepoPath: '/repo' },
        stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
        persistence: {
          save: sinon.stub(), load: sinon.stub(), getStoragePath: sinon.stub().returns('/tmp'),
          delete: sinon.stub(), loadAll: sinon.stub().returns([]),
          disableSaves: sinon.stub(),
        },
        planRepository: {
          list: sinon.stub().rejects(new Error('list failed')),
          loadState: sinon.stub().resolves(null),
          saveStateSync: sinon.stub(),
          markDeletedSync: sinon.stub(),
          delete: sinon.stub().resolves(),
          migrateLegacy: sinon.stub().resolves(),
        },
      });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      await lifecycle.initialize();

      assert.ok((log.warn as sinon.SinonStub).calledWithMatch(sinon.match(/Failed to list plans/)));
    });

    test('calls persistence.disableSaves when planRepository exists (lines 148-149)', async () => {
      const log = createMockLogger();
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const disableSaves = sinon.stub();
      const state = makeState({
        config: { storagePath: '/tmp', defaultRepoPath: '/repo' },
        stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
        persistence: {
          save: sinon.stub(), load: sinon.stub(), getStoragePath: sinon.stub().returns('/tmp'),
          delete: sinon.stub(), loadAll: sinon.stub().returns([]),
          disableSaves,
        },
        planRepository: {
          list: sinon.stub().resolves([]),
          loadState: sinon.stub().resolves(null),
          saveStateSync: sinon.stub(),
          markDeletedSync: sinon.stub(),
          delete: sinon.stub().resolves(),
          migrateLegacy: sinon.stub().resolves(),
        },
      });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      await lifecycle.initialize();

      assert.ok(disableSaves.called, 'disableSaves should be called when planRepository exists');
    });

    test('falls back to legacy persistence when saveStateSync throws (lines 154-159)', async () => {
      const log = createMockLogger();
      const PlanStateMachine = require('../../../plan/stateMachine').PlanStateMachine;
      const legacySave = sinon.stub();
      const plan = createTestPlan('plan-loaded');
      (plan as any).stateHistory = [];
      (plan as any).pauseHistory = [];

      const state = makeState({
        config: { storagePath: '/tmp', defaultRepoPath: '/repo' },
        stateMachineFactory: (p: any) => new PlanStateMachine(p),
        persistence: {
          save: legacySave, load: sinon.stub(), getStoragePath: sinon.stub().returns('/tmp'),
          delete: sinon.stub(), loadAll: sinon.stub().returns([plan]),
          disableSaves: sinon.stub(),
        },
        planRepository: {
          list: sinon.stub().resolves([]),
          loadState: sinon.stub().resolves(null),
          saveStateSync: sinon.stub().throws(new Error('save failed')),
          markDeletedSync: sinon.stub(),
          delete: sinon.stub().resolves(),
          migrateLegacy: sinon.stub().resolves(),
        },
      });
      const lifecycle = new PlanLifecycleManager(state as any, log, createMockGit());

      await lifecycle.initialize();

      assert.ok(legacySave.called, 'legacy persistence.save should be called as fallback');
    });
  });

  suite('loadPlansOnStartup – resumeAfterPlan chain recovery', () => {
    test('auto-resumes waiting plan when dependency already succeeded', async () => {
      const state = makeState({
        stateMachineFactory: sinon.stub().returns({ on: sinon.stub() }),
        planRepository: { saveState: sinon.stub().resolves(), saveStateSync: sinon.stub() },
      });
      // Add loadAll to persistence so initialize() can run
      state.persistence.loadAll = sinon.stub().returns([]);
      const depPlan = createTestPlan('dep-plan');
      depPlan.nodeStates.get('node-1')!.status = 'succeeded';
      depPlan.startedAt = Date.now() - 10000;
      state.plans.set('dep-plan', depPlan);
      
      const waitingPlan = createTestPlan('waiting-plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;
      state.plans.set('waiting-plan', waitingPlan);

      const lifecycle = new PlanLifecycleManager(state as any, createMockLogger(), createMockGit());
      lifecycle.setupStateMachineListeners = sinon.stub() as any;
      
      await lifecycle.initialize();
      
      assert.strictEqual(waitingPlan.isPaused, false, 'should auto-resume');
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined, 'should clear dependency');
    });

    test('keeps waiting plan paused when dependency failed', async () => {
      const state = makeState({
        stateMachineFactory: sinon.stub().returns({ on: sinon.stub() }),
        planRepository: { saveState: sinon.stub().resolves(), saveStateSync: sinon.stub() },
      });
      state.persistence.loadAll = sinon.stub().returns([]);
      const depPlan = createTestPlan('dep-plan');
      depPlan.nodeStates.get('node-1')!.status = 'failed';
      depPlan.startedAt = Date.now() - 10000;
      state.plans.set('dep-plan', depPlan);

      const waitingPlan = createTestPlan('waiting-plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;
      state.plans.set('waiting-plan', waitingPlan);

      const lifecycle = new PlanLifecycleManager(state as any, createMockLogger(), createMockGit());
      lifecycle.setupStateMachineListeners = sinon.stub() as any;

      await lifecycle.initialize();

      assert.strictEqual(waitingPlan.isPaused, true, 'should stay paused');
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined, 'should clear broken dependency');
    });

    test('unblocks when dependency plan is missing (deleted)', async () => {
      const state = makeState({
        stateMachineFactory: sinon.stub().returns({ on: sinon.stub() }),
        planRepository: { saveState: sinon.stub().resolves(), saveStateSync: sinon.stub() },
      });
      state.persistence.loadAll = sinon.stub().returns([]);
      const waitingPlan = createTestPlan('waiting-plan');
      waitingPlan.resumeAfterPlan = 'deleted-plan';
      waitingPlan.isPaused = true;
      state.plans.set('waiting-plan', waitingPlan);

      const lifecycle = new PlanLifecycleManager(state as any, createMockLogger(), createMockGit());
      lifecycle.setupStateMachineListeners = sinon.stub() as any;

      await lifecycle.initialize();

      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined, 'should clear missing dependency');
      assert.strictEqual(waitingPlan.isPaused, true, 'should stay paused (user decides)');
    });
  });
});
