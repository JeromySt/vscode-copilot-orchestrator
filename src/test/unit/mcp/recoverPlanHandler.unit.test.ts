/**
 * @fileoverview Unit tests for recoverPlanHandler module
 * Tests the recover_copilot_plan MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', status: 'canceled' },
    jobs: new Map([
      ['node-1', { id: 'node-1', producerId: 'job-1', name: 'Job 1' }],
      ['node-2', { id: 'node-2', producerId: 'job-2', name: 'Job 2' }],
    ]),
    nodeStates: new Map(),
    producerIdToNodeId: new Map(),
    roots: [],
    leaves: [],
    targetBranch: 'copilot_plan/test',
    baseBranch: 'main',
    isPaused: false,
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, any>): any {
  const plan = makeMockPlan();
  
  return {
    PlanRunner: {
      get: sinon.stub().returns(plan),
      getStatus: sinon.stub().returns({ status: 'canceled' }),
    },
    PlanRecovery: {
      canRecover: sinon.stub().returns(true),
      recover: sinon.stub().resolves({
        planId: 'plan-1',
        success: true,
        recoveredBranch: 'copilot_plan/test',
        recoveredWorktrees: ['/repo/.worktrees/plan-1/node-1'],
        recoveredNodes: ['node-1'],
      }),
      analyzeRecoverableNodes: sinon.stub().resolves([
        { nodeId: 'node-1', commitHash: 'commit-1', wasSuccessful: true, dagStatus: 'succeeded', dependencies: [] },
        { nodeId: 'node-2', commitHash: null, wasSuccessful: false, dagStatus: 'failed', dependencies: ['node-1'] },
      ]),
      ...overrides,
    },
    workspacePath: '/workspace',
  };
}

suite('handleRecoverPlan', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns error for missing planId', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const result = await handleRecoverPlan({}, makeCtx());
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  test('returns error when plan is not recoverable', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    ctx.PlanRecovery.canRecover = sinon.stub().returns(false);
    ctx.PlanRunner.getStatus = sinon.stub().returns({ status: 'running' });
    
    const result = await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Cannot recover'));
    assert.ok(result.error?.includes('running'));
  });

  test('returns success with recovery details', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    
    const result = await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.planId, 'plan-1');
    assert.strictEqual(result.recoveredBranch, 'copilot_plan/test');
    assert.strictEqual(result.recoveredNodeCount, 1);
    assert.deepStrictEqual(result.recoveredNodes, ['node-1']);
    assert.ok(result.message.includes('recovered'));
    assert.ok(result.message.includes('PAUSED'));
  });

  test('includes node analysis in response', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    
    const result = await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    assert.strictEqual(result.totalNodeCount, 2);
    assert.strictEqual(result.recoveredNodeCount, 1);
    assert.ok(ctx.PlanRecovery.analyzeRecoverableNodes.calledWith('plan-1'));
  });

  test('passes useCopilotAgent option', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    
    await handleRecoverPlan({ planId: 'plan-1', useCopilotAgent: false }, ctx);
    
    assert.ok(ctx.PlanRecovery.recover.calledWith('plan-1', { useCopilotAgent: false }));
  });

  test('defaults useCopilotAgent to true', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    
    await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    assert.ok(ctx.PlanRecovery.recover.calledWith('plan-1', { useCopilotAgent: true }));
  });

  test('returns error when recovery service not available', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    ctx.PlanRecovery = undefined;
    
    const result = await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('recovery service not available'));
  });

  test('returns error when recovery fails', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    ctx.PlanRecovery.recover = sinon.stub().resolves({
      planId: 'plan-1',
      success: false,
      recoveredBranch: '',
      recoveredWorktrees: [],
      recoveredNodes: [],
      error: 'Recovery operation failed',
    });
    
    const result = await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Recovery operation failed'));
  });

  test('handles analysis errors gracefully', async () => {
    const { handleRecoverPlan } = require('../../../mcp/handlers/plan/recoverPlanHandler');
    const ctx = makeCtx();
    ctx.PlanRecovery.analyzeRecoverableNodes = sinon.stub().rejects(new Error('Analysis failed'));
    
    const result = await handleRecoverPlan({ planId: 'plan-1' }, ctx);
    
    // Should fail because analysis happens before recovery
    assert.strictEqual(result.success, false);
  });
});
