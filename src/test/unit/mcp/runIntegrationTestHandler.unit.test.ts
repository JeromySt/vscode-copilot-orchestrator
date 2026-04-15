/**
 * @fileoverview Unit tests for the run_copilot_integration_test MCP handler.
 *
 * Validates the handler creates a plan with the correct structure,
 * returns proper response shape, and handles errors gracefully.
 *
 * @module test/unit/mcp/runIntegrationTestHandler.unit.test
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { handleRunIntegrationTest } from '../../../mcp/handlers/plan/runIntegrationTestHandler';
import type { PlanHandlerContext } from '../../../mcp/handlers/utils';

suite('handleRunIntegrationTest', () => {
  let sandbox: sinon.SinonSandbox;
  let mockCtx: PlanHandlerContext;
  let enqueueStub: sinon.SinonStub;

  function makeMockPlan(id: string) {
    const jobs = new Map();
    const nodeStates = new Map();
    const producerIdToNodeId = new Map();

    // Simulate the plan structure
    const jobEntries = [
      ['node-1', { producerId: 'root-setup', name: 'Project Setup', type: 'job' }],
      ['node-2', { producerId: 'parallel-agent', name: 'Agent Work', type: 'job' }],
      ['node-3', { producerId: 'parallel-shell', name: 'Shell Command', type: 'job' }],
      ['node-4', { producerId: 'pressure-agent', name: 'Context Pressure', type: 'job' }],
      ['node-5', { producerId: 'auto-heal-job', name: 'Auto-Heal', type: 'job' }],
      ['node-6', { producerId: 'always-fails', name: 'Permanent Failure', type: 'job' }],
      ['node-7', { producerId: 'blocked-downstream', name: 'Blocked', type: 'job' }],
      ['node-8', { producerId: 'postchecks-fail', name: 'Postcheck Failure', type: 'job' }],
      ['node-9', { producerId: 'no-changes', name: 'No Changes', type: 'job' }],
      ['node-10', { producerId: 'process-job', name: 'Process Execution', type: 'job' }],
      ['node-11', { producerId: 'final-merge', name: 'Final Merge', type: 'job' }],
    ] as const;

    for (const [nodeId, node] of jobEntries) {
      jobs.set(nodeId, node);
      nodeStates.set(nodeId, { status: 'pending' });
      producerIdToNodeId.set(node.producerId, nodeId);
    }

    return {
      id,
      jobs,
      nodeStates,
      producerIdToNodeId,
      spec: { name: 'Full Integration Test Plan', startPaused: true },
    };
  }

  setup(() => {
    sandbox = sinon.createSandbox();

    const mockPlan = makeMockPlan('test-plan-123');
    enqueueStub = sandbox.stub().returns(mockPlan);

    mockCtx = {
      workspacePath: '/tmp/test-workspace',
      PlanRunner: {
        enqueue: enqueueStub,
        get: sandbox.stub(),
        getPlan: sandbox.stub(),
        getAll: sandbox.stub().returns([]),
        getStatus: sandbox.stub(),
        cancel: sandbox.stub(),
        delete: sandbox.stub(),
        pause: sandbox.stub(),
        resume: sandbox.stub(),
        savePlan: sandbox.stub(),
      } as any,
      git: {
        currentBranch: sandbox.stub().resolves('main'),
        branchExists: sandbox.stub().resolves(false),
        branchExistsLocal: sandbox.stub().resolves(false),
        branchExistsRemote: sandbox.stub().resolves(false),
        createBranchLocal: sandbox.stub().resolves(),
        getRepositoryRoot: sandbox.stub().resolves('/tmp/test-workspace'),
      } as any,
      configProvider: {
        getConfig: sandbox.stub().returns(undefined),
      } as any,
      PlanRepository: {
        readPlanMetadata: sandbox.stub().returns(undefined),
      } as any,
    } as any;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns success with plan ID and job mapping', async () => {
    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.planId, 'test-plan-123');
    assert.ok(result.jobs);
    assert.ok(result.descriptions);
    assert.ok(result.instructions);
  });

  test('creates plan with expected job count', async () => {
    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.strictEqual(result.jobCount, 11);
  });

  test('includes script count in response', async () => {
    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.ok(result.scriptCount > 0, 'Should have scripts for the test plan');
  });

  test('passes custom name to plan spec', async () => {
    await handleRunIntegrationTest({ name: 'Custom Test' }, mockCtx);

    assert.ok(enqueueStub.calledOnce);
    const spec = enqueueStub.firstCall.args[0];
    assert.strictEqual(spec.name, 'Custom Test');
  });

  test('passes maxParallel to plan spec', async () => {
    await handleRunIntegrationTest({ maxParallel: 2 }, mockCtx);

    const spec = enqueueStub.firstCall.args[0];
    assert.strictEqual(spec.maxParallel, 2);
  });

  test('starts paused by default', async () => {
    await handleRunIntegrationTest({}, mockCtx);

    const spec = enqueueStub.firstCall.args[0];
    assert.strictEqual(spec.startPaused, true);
  });

  test('can start unpaused when requested', async () => {
    await handleRunIntegrationTest({ startPaused: false }, mockCtx);

    const spec = enqueueStub.firstCall.args[0];
    assert.strictEqual(spec.startPaused, false);
  });

  test('returns error when no workspace path', async () => {
    mockCtx.workspacePath = undefined as any;

    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('workspace'));
  });

  test('returns error on enqueue failure', async () => {
    enqueueStub.throws(new Error('enqueue failed'));

    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('enqueue failed'));
  });

  test('includes job descriptions in response', async () => {
    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.ok(result.descriptions['root-setup']);
    assert.ok(result.descriptions['always-fails']);
    assert.ok(result.descriptions['blocked-downstream']);
  });

  test('includes usage instructions in response', async () => {
    const result = await handleRunIntegrationTest({}, mockCtx);

    assert.ok(Array.isArray(result.instructions));
    assert.ok(result.instructions.length > 0);
    assert.ok(result.instructions.some((i: string) => i.includes('resume_copilot_plan')));
  });
});
