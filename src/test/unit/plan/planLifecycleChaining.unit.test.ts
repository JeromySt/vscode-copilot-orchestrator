/**
 * @fileoverview Unit tests for PlanLifecycleManager plan chaining features
 * Tests resumeAfterPlan, notifyDependentPlansOfTermination, and auto-resume logic.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PlanLifecycleManager, PlanRunnerState } from '../../../plan/planLifecycle';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { PlanEventEmitter } from '../../../plan/planEvents';
import { PlanConfigManager } from '../../../plan/configManager';
import type { PlanInstance, JobNode, NodeExecutionState } from '../../../plan/types';
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

function createTestJobNode(id: string, name: string): JobNode {
  return {
    id, producerId: id, name, type: 'job', task: 'test task',
    dependencies: [], dependents: [],
    work: { type: 'shell', command: 'echo test' },
  };
}

function createTestPlan(id = 'plan-1', name = 'Test Plan'): PlanInstance {
  const node = createTestJobNode('node-1', 'Test Job');
  const nodeState: NodeExecutionState = { status: 'pending', attempts: 0, version: 1 };
  return {
    id,
    spec: { name, jobs: [{ producerId: 'node-1', name: 'Test Job', task: 'test', work: 'echo hi' }], baseBranch: 'main' },
    jobs: new Map([['node-1', node]]),
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
    isPaused: false,
  } as PlanInstance;
}

function createState(): PlanRunnerState {
  return {
    plans: new Map(),
    stateMachines: new Map(),
    scheduler: {
      selectNodes: sinon.stub().returns([]),
      getGlobalMaxParallel: sinon.stub().returns(8),
    } as any,
    persistence: {
      save: sinon.stub(),
      saveSync: sinon.stub(),
      loadAll: sinon.stub().returns([]),
      delete: sinon.stub(),
    } as any,
    config: { storagePath: '/tmp/test-plans', defaultRepoPath: '/repo' },
    processMonitor: { isRunning: sinon.stub().returns(false), terminate: sinon.stub().resolves() } as any,
    events: new PlanEventEmitter(),
    configManager: new PlanConfigManager(),
    stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
  };
}

suite('PlanLifecycleManager - Plan Chaining', () => {
  let quiet: { restore: () => void };
  let state: PlanRunnerState;
  let mgr: PlanLifecycleManager;
  let log: ILogger;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    quiet = silenceConsole();
    sandbox = sinon.createSandbox();
    state = createState();
    log = createMockLogger();
    mgr = new PlanLifecycleManager(state, log, {} as any);
  });

  teardown(() => {
    quiet.restore();
    sandbox.restore();
  });

  // ── resumeAfterPlan field ─────────────────────────────────────────

  suite('resumeAfterPlan field', () => {
    test('plan can have resumeAfterPlan set', () => {
      const plan = createTestPlan();
      plan.resumeAfterPlan = 'dependency-plan-id';
      assert.strictEqual(plan.resumeAfterPlan, 'dependency-plan-id');
    });

    test('plan without resumeAfterPlan has undefined field', () => {
      const plan = createTestPlan();
      assert.strictEqual(plan.resumeAfterPlan, undefined);
    });
  });

  // ── notifyDependentPlansOfTermination ─────────────────────────────

  suite('notifyDependentPlansOfTermination', () => {
    test('clears resumeAfterPlan when dependency is canceled', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency Plan');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting Plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm1 as any);

      mgr.cancel(dependencyPlan.id);

      // resumeAfterPlan should be cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
      // waiting plan should remain paused
      assert.strictEqual(waitingPlan.isPaused, true);
    });

    test('clears resumeAfterPlan when dependency is deleted', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency Plan');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting Plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm1 as any);

      mgr.delete(dependencyPlan.id);

      // resumeAfterPlan should be cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
      // waiting plan should remain paused
      assert.strictEqual(waitingPlan.isPaused, true);
    });

    test('persists changes via planRepository when available', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency Plan');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting Plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm1 as any);

      const saveStateSyncStub = sinon.stub();
      state.planRepository = { saveStateSync: saveStateSyncStub } as any;

      mgr.cancel(dependencyPlan.id);

      // Should have called saveStateSync for the waiting plan
      assert.ok(saveStateSyncStub.calledWith(waitingPlan));
    });

    test('handles missing planRepository gracefully', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency Plan');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting Plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm1 as any);

      state.planRepository = undefined;

      // Should not throw
      mgr.cancel(dependencyPlan.id);
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
    });

    test('unblocks multiple dependent plans', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency Plan');
      const waitingPlan1 = createTestPlan('waiting-1', 'Waiting Plan 1');
      const waitingPlan2 = createTestPlan('waiting-2', 'Waiting Plan 2');
      waitingPlan1.resumeAfterPlan = 'dep-plan';
      waitingPlan2.resumeAfterPlan = 'dep-plan';

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan1.id, waitingPlan1);
      state.plans.set(waitingPlan2.id, waitingPlan2);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm1 as any);

      mgr.cancel(dependencyPlan.id);

      assert.strictEqual(waitingPlan1.resumeAfterPlan, undefined);
      assert.strictEqual(waitingPlan2.resumeAfterPlan, undefined);
    });

    test('does not affect plans waiting on different dependencies', () => {
      const dependencyPlan1 = createTestPlan('dep-1', 'Dependency 1');
      const dependencyPlan2 = createTestPlan('dep-2', 'Dependency 2');
      const waitingPlan1 = createTestPlan('waiting-1', 'Waiting Plan 1');
      const waitingPlan2 = createTestPlan('waiting-2', 'Waiting Plan 2');
      waitingPlan1.resumeAfterPlan = 'dep-1';
      waitingPlan2.resumeAfterPlan = 'dep-2';

      state.plans.set(dependencyPlan1.id, dependencyPlan1);
      state.plans.set(dependencyPlan2.id, dependencyPlan2);
      state.plans.set(waitingPlan1.id, waitingPlan1);
      state.plans.set(waitingPlan2.id, waitingPlan2);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan1.id, sm1 as any);

      mgr.cancel(dependencyPlan1.id);

      // Only waiting-1 should be unblocked
      assert.strictEqual(waitingPlan1.resumeAfterPlan, undefined);
      // waiting-2 should still be waiting for dep-2
      assert.strictEqual(waitingPlan2.resumeAfterPlan, 'dep-2');
    });

    test('logs warning with plan names when unblocking', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'My Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'My Waiting Plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm1 = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm1 as any);

      mgr.cancel(dependencyPlan.id);

      // Should have logged a warning with plan names
      const warnCalls = (log.warn as sinon.SinonStub).getCalls();
      const chainingWarning = warnCalls.find(call => 
        call.args[0]?.includes('Dependency plan') && 
        call.args[0]?.includes('unblocking chained plan')
      );
      assert.ok(chainingWarning, 'Should log warning about unblocking chained plan');
    });
  });

  // ── cancel() calls notifyDependentPlansOfTermination ─────────────

  suite('cancel calls notifyDependentPlansOfTermination', () => {
    test('cancel triggers unblocking with reason "canceled"', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm as any);

      mgr.cancel(dependencyPlan.id);

      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
      // Verify the warning message includes "canceled"
      const warnCalls = (log.warn as sinon.SinonStub).getCalls();
      const msg = warnCalls.find(c => c.args[0]?.includes('was canceled'));
      assert.ok(msg, 'Should log that plan was canceled');
    });
  });

  // ── delete() calls notifyDependentPlansOfTermination ─────────────

  suite('delete calls notifyDependentPlansOfTermination', () => {
    test('delete triggers unblocking with reason "deleted"', () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);
      const sm = { cancelAll: sinon.stub(), computePlanStatus: sinon.stub() };
      state.stateMachines.set(dependencyPlan.id, sm as any);

      mgr.delete(dependencyPlan.id);

      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
      // Verify the warning message includes "deleted"
      const warnCalls = (log.warn as sinon.SinonStub).getCalls();
      const msg = warnCalls.find(c => c.args[0]?.includes('was deleted'));
      assert.ok(msg, 'Should log that plan was deleted');
    });
  });

  // ── planComplete handler auto-resume logic ───────────────────────

  suite('planComplete handler - auto-resume on success', () => {
    test('auto-resumes chained plan when dependency succeeds', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);
      const startPumpStub = sinon.stub();

      // Capture the planComplete handler
      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any, startPumpStub);

      // Trigger successful completion
      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // Should have called resume on the waiting plan
      assert.ok(resumeSpy.calledWith(waitingPlan.id, sinon.match.func));
      // resumeAfterPlan should be cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
    });

    test('clears resumeAfterPlan field when auto-resuming', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
    });

    test('only resumes plans that are paused', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPausedPlan = createTestPlan('waiting-1', 'Waiting Paused');
      const waitingRunningPlan = createTestPlan('waiting-2', 'Waiting Running');
      
      waitingPausedPlan.resumeAfterPlan = 'dep-plan';
      waitingPausedPlan.isPaused = true;
      
      waitingRunningPlan.resumeAfterPlan = 'dep-plan';
      waitingRunningPlan.isPaused = false; // Already running

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPausedPlan.id, waitingPausedPlan);
      state.plans.set(waitingRunningPlan.id, waitingRunningPlan);

      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // Should only resume the paused plan
      assert.strictEqual(resumeSpy.callCount, 1);
      assert.ok(resumeSpy.calledWith(waitingPausedPlan.id));
      assert.ok(!resumeSpy.calledWith(waitingRunningPlan.id));
    });

    test('handles multiple chained plans on same dependency', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waiting1 = createTestPlan('waiting-1', 'Waiting 1');
      const waiting2 = createTestPlan('waiting-2', 'Waiting 2');
      
      waiting1.resumeAfterPlan = 'dep-plan';
      waiting1.isPaused = true;
      waiting2.resumeAfterPlan = 'dep-plan';
      waiting2.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waiting1.id, waiting1);
      state.plans.set(waiting2.id, waiting2);

      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // Both waiting plans should be resumed
      assert.strictEqual(resumeSpy.callCount, 2);
      assert.ok(resumeSpy.calledWith(waiting1.id));
      assert.ok(resumeSpy.calledWith(waiting2.id));
    });

    test('logs info when auto-resuming chained plan', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency Plan');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting Plan');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // Should log info about auto-resume
      const infoCalls = (log.info as sinon.SinonStub).getCalls();
      const autoResumeLog = infoCalls.find(c => c.args[0]?.includes('Auto-resuming'));
      assert.ok(autoResumeLog, 'Should log auto-resume action');
    });

    test('handles resume errors gracefully', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      // Make resume fail
      sandbox.stub(mgr, 'resume').rejects(new Error('Resume failed'));

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      // Should not throw — error is caught and logged
      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // Error should be logged
      const errorCalls = (log.error as sinon.SinonStub).getCalls();
      const resumeError = errorCalls.find(c => c.args[0]?.includes('Failed to auto-resume'));
      assert.ok(resumeError, 'Should log resume error');
    });
  });

  // ── planComplete handler - canceled unblocks dependents ──────────

  suite('planComplete handler - canceled unblocks dependents', () => {
    test('canceled status triggers notifyDependentPlansOfTermination', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'canceled' });

      // resumeAfterPlan should be cleared but plan stays paused
      assert.strictEqual(waitingPlan.resumeAfterPlan, undefined);
      assert.strictEqual(waitingPlan.isPaused, true);
    });

    test('does NOT auto-resume when dependency is canceled', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'canceled' });

      // resume should NOT be called
      assert.ok(!resumeSpy.called);
      // Plan should remain paused
      assert.strictEqual(waitingPlan.isPaused, true);
    });
  });

  // ── Failed/partial plans do NOT unblock dependents ───────────────

  suite('failed/partial plans do NOT unblock dependents', () => {
    test('failed plan does not clear resumeAfterPlan', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'failed' });

      // resumeAfterPlan should NOT be cleared — plan can be retried
      assert.strictEqual(waitingPlan.resumeAfterPlan, 'dep-plan');
      assert.strictEqual(waitingPlan.isPaused, true);
    });

    test('partial plan does not clear resumeAfterPlan', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'partial' });

      // resumeAfterPlan should NOT be cleared
      assert.strictEqual(waitingPlan.resumeAfterPlan, 'dep-plan');
      assert.strictEqual(waitingPlan.isPaused, true);
    });

    test('failed plans do not trigger auto-resume', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'failed' });

      // resume should NOT be called
      assert.ok(!resumeSpy.called);
    });
  });

  // ── setupStateMachineListeners with optional startPump ───────────

  suite('setupStateMachineListeners with optional startPump parameter', () => {
    test('accepts startPump parameter', () => {
      const sm = { on: sinon.stub() };
      const startPump = sinon.stub();
      
      // Should not throw
      mgr.setupStateMachineListeners(sm as any, startPump);
      
      assert.ok(sm.on.calledWith('transition'));
      assert.ok(sm.on.calledWith('planComplete'));
    });

    test('works without startPump parameter', () => {
      const sm = { on: sinon.stub() };
      
      // Should not throw
      mgr.setupStateMachineListeners(sm as any);
      
      assert.ok(sm.on.calledWith('transition'));
      assert.ok(sm.on.calledWith('planComplete'));
    });

    test('uses provided startPump when auto-resuming', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      const providedStartPump = sinon.stub();
      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any, providedStartPump);

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // resume should be called with a pump function
      assert.ok(resumeSpy.calledOnce);
      const pumpArg = resumeSpy.firstCall.args[1];
      assert.strictEqual(typeof pumpArg, 'function');
    });

    test('uses no-op pump when startPump not provided', async () => {
      const dependencyPlan = createTestPlan('dep-plan', 'Dependency');
      const waitingPlan = createTestPlan('waiting-plan', 'Waiting');
      waitingPlan.resumeAfterPlan = 'dep-plan';
      waitingPlan.isPaused = true;

      state.plans.set(dependencyPlan.id, dependencyPlan);
      state.plans.set(waitingPlan.id, waitingPlan);

      const resumeSpy = sandbox.stub(mgr, 'resume').resolves(true);

      let planCompleteHandler: (event: any) => Promise<void> = async () => {};
      const sm = {
        on: (event: string, handler: any) => {
          if (event === 'planComplete') { planCompleteHandler = handler; }
        },
      };
      mgr.setupStateMachineListeners(sm as any); // No startPump provided

      await planCompleteHandler({ planId: dependencyPlan.id, status: 'succeeded' });

      // resume should be called with a function (no-op fallback)
      assert.ok(resumeSpy.calledOnce);
      const pumpArg = resumeSpy.firstCall.args[1];
      assert.strictEqual(typeof pumpArg, 'function');
    });
  });
});
