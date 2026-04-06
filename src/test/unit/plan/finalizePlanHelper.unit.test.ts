import * as assert from 'assert';
import * as sinon from 'sinon';
import { finalizePlanInRunner } from '../../../plan/finalizePlanHelper';

suite('finalizePlanHelper', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('returns error when plan not found', async () => {
    const planRunner = { get: sandbox.stub().returns(undefined) } as any;
    const planRepo = {} as any;
    const result = await finalizePlanInRunner('missing', planRunner, planRepo);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('not found'));
  });

  test('returns error when plan is not in scaffolding state', async () => {
    const plan = { spec: { status: 'pending' } };
    const planRunner = { get: sandbox.stub().returns(plan) } as any;
    const planRepo = {} as any;
    const result = await finalizePlanInRunner('p1', planRunner, planRepo);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('scaffolding'));
  });

  test('finalizes plan, syncs state, and resumes when startPaused=false', async () => {
    const plan = {
      spec: { status: 'scaffolding', name: 'Test' },
      stateVersion: 0,
      isPaused: true,
      resumeAfterPlan: undefined,
      jobs: new Map(),
      nodeStates: new Map(),
      producerIdToNodeId: new Map(),
      roots: [],
      leaves: [],
    };
    const finalized = {
      spec: { name: 'Test' },
      jobs: new Map([['n1', { id: 'n1' }]]),
      nodeStates: new Map([['n1', { status: 'ready' }]]),
      producerIdToNodeId: new Map([['job1', 'n1']]),
      roots: ['n1'],
      leaves: ['n1'],
      groups: new Map(),
      groupStates: new Map(),
      groupPathToId: new Map(),
      targetBranch: 'feat/test',
      definition: { getWorkSpec: async () => undefined },
    };
    const deleteSpy = sandbox.stub().returns(true);
    const registerSpy = sandbox.stub();
    const resumeSpy = sandbox.stub().resolves(true);
    const getSpy = sandbox.stub();
    getSpy.onFirstCall().returns(plan);      // first call: check scaffolding
    getSpy.onSecondCall().returns(plan);      // after re-register: return updated plan
    const planRunner = {
      get: getSpy,
      registerPlan: registerSpy,
      resume: resumeSpy,
      _state: { plans: new Map([['p1', plan]]), stateMachines: new Map() },
      _lifecycle: { state: { plans: new Map([['p1', plan]]), stateMachines: new Map() } },
    } as any;
    const planRepo = { finalize: sandbox.stub().resolves(finalized) } as any;

    const result = await finalizePlanInRunner('p1', planRunner, planRepo, { startPaused: false });
    assert.strictEqual(result.success, true);
    assert.ok(planRepo.finalize.calledOnce);
    assert.ok(registerSpy.calledOnce);
    assert.ok(resumeSpy.calledOnce);
    assert.strictEqual((plan.spec as any).status, 'pending');
  });

  test('starts paused when startPaused is true (default)', async () => {
    const plan = {
      spec: { status: 'scaffolding', name: 'Test' },
      stateVersion: 0,
      resumeAfterPlan: undefined,
      isPaused: true,
      jobs: new Map(),
      nodeStates: new Map(),
      producerIdToNodeId: new Map(),
      roots: [],
      leaves: [],
    };
    const finalized = {
      jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
      roots: [], leaves: [], groups: new Map(), groupStates: new Map(),
      groupPathToId: new Map(), targetBranch: 'main', definition: undefined,
    };
    const planRunner = {
      get: sandbox.stub().returns(plan),
      delete: sandbox.stub().returns(true),
      registerPlan: sandbox.stub(),
      resume: sandbox.stub().resolves(true),
    } as any;
    const planRepo = { finalize: sandbox.stub().resolves(finalized) } as any;

    await finalizePlanInRunner('p1', planRunner, planRepo);
    assert.strictEqual(plan.isPaused, true);
    assert.ok(!planRunner.resume.called); // should NOT resume when paused
  });

  test('forces paused when resumeAfterPlan is set', async () => {
    const plan = {
      spec: { status: 'scaffolding', name: 'Test' },
      stateVersion: 0,
      resumeAfterPlan: 'other-plan',
      isPaused: false,
      jobs: new Map(),
      nodeStates: new Map(),
      producerIdToNodeId: new Map(),
      roots: [],
      leaves: [],
    };
    const finalized = {
      jobs: new Map(), nodeStates: new Map(), producerIdToNodeId: new Map(),
      roots: [], leaves: [], groups: new Map(), groupStates: new Map(),
      groupPathToId: new Map(), targetBranch: 'main', definition: undefined,
    };
    const planRunner = {
      get: sandbox.stub().returns(plan),
      delete: sandbox.stub().returns(true),
      registerPlan: sandbox.stub(),
      resume: sandbox.stub().resolves(true),
    } as any;
    const planRepo = { finalize: sandbox.stub().resolves(finalized) } as any;

    await finalizePlanInRunner('p1', planRunner, planRepo, { startPaused: false });
    assert.strictEqual(plan.isPaused, true); // forced paused despite startPaused=false
    assert.ok(!planRunner.resume.called);
  });
});
