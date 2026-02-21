/**
 * @fileoverview Unit tests for updateJobHandler module
 * Tests the update_copilot_plan_job MCP tool handler.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as validation from '../../../mcp/validation';

function makeMockPlan(overrides?: Record<string, any>): any {
  const jobs = new Map();
  const nodeStates = new Map();
  
  jobs.set('node-1', {
    id: 'node-1',
    producerId: 'job-1',
    name: 'Job 1',
    type: 'job',
    dependencies: [],
    dependents: [],
    work: { agent: { instructions: 'old' } },
  });
  
  nodeStates.set('node-1', { 
    status: 'failed',
    attempts: 1,
    stepStatuses: {},
  });
  
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan' },
    jobs,
    nodeStates,
    isPaused: false,
    definition: {},
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, any>): any {
  const plan = makeMockPlan();
  return {
    PlanRunner: {
      getPlan: sinon.stub().returns(plan),
      savePlan: sinon.stub(),
      emit: sinon.stub(),
      resume: sinon.stub().resolves(),
      ...overrides,
    },
    PlanRepository: {
      writeNodeSpec: sinon.stub().resolves(),
    },
    workspacePath: '/workspace',
    configProvider: {
      getConfig: sinon.stub().returns(undefined),
    },
  };
}

suite('updateJobHandler', () => {
  let sandbox: sinon.SinonSandbox;
  let validateFoldersStub: sinon.SinonStub;
  let validateUrlsStub: sinon.SinonStub;
  let validateModelsStub: sinon.SinonStub;
  let validatePsStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    validateFoldersStub = sandbox.stub(validation, 'validateAllowedFolders').resolves({ valid: true });
    validateUrlsStub = sandbox.stub(validation, 'validateAllowedUrls').resolves({ valid: true });
    validateModelsStub = sandbox.stub(validation, 'validateAgentModels').resolves({ valid: true });
    validatePsStub = sandbox.stub(validation, 'validatePowerShellCommands').returns({ valid: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleUpdatePlanJob', () => {
    test('should return error when planId is missing', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const result = await handleUpdatePlanJob({ jobId: 'job-1', work: {} }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when jobId is missing', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const result = await handleUpdatePlanJob({ planId: 'plan-1', work: {} }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('jobId'));
    });

    test('should accept nodeId as alias for jobId', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const ctx = makeCtx();
      const result = await handleUpdatePlanJob({ planId: 'plan-1', nodeId: 'node-1', work: {} }, ctx);
      assert.strictEqual(result.success, true);
    });

    test('should return error when no stage updates provided', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('At least one stage'));
    });

    test('should validate allowed folders', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      validateFoldersStub.resolves({ valid: false, error: 'Invalid folder' });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        work: {},
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid folder'));
    });

    test('should validate allowed URLs', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      validateUrlsStub.resolves({ valid: false, error: 'Invalid URL' });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        work: {},
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid URL'));
    });

    test('should validate agent models', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      validateModelsStub.resolves({ valid: false, error: 'Invalid model' });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        work: { agent: { model: 'invalid' } },
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid model'));
    });

    test('should reject PowerShell 2>&1 redirects', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      validatePsStub.returns({ valid: false, error: 'PowerShell redirect' });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        work: {},
      }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PowerShell redirect'));
    });

    test('should return error when plan not found', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const ctx = makeCtx({ getPlan: sinon.stub().returns(undefined) });
      const result = await handleUpdatePlanJob({ planId: 'not-found', jobId: 'job-1', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return error when job not found', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const ctx = makeCtx();
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'not-found', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    test('should return error for non-job nodes', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      plan.jobs.get('node-1').type = 'group';
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'job-1', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not a job'));
    });

    test('should prevent updating snapshot validation job', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      plan.jobs.get('node-1').producerId = '__snapshot-validation__';
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'job-1', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Snapshot Validation'));
      assert.ok(result.error.includes('auto-managed'));
    });

    test('should prevent updating running jobs', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'running';
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'job-1', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('currently running'));
    });

    test('should prevent updating scheduled jobs', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'scheduled';
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'job-1', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('currently scheduled'));
    });

    test('should prevent updating succeeded jobs', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'succeeded';
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ planId: 'plan-1', jobId: 'job-1', work: {} }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('already completed'));
    });

    test('should update work spec', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(plan.jobs.get('node-1').work);
      assert.ok(result.hasNewWork);
    });

    test('should update prechecks spec', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        prechecks: { command: 'check' },
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(plan.jobs.get('node-1').prechecks);
      assert.ok(result.hasNewPrechecks);
    });

    test('should update postchecks spec', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        postchecks: { command: 'verify' },
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(plan.jobs.get('node-1').postchecks);
      assert.ok(result.hasNewPostchecks);
    });

    test('should update multiple stages', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
        prechecks: { command: 'check' },
        postchecks: { command: 'verify' },
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.hasNewWork);
      assert.ok(result.hasNewPrechecks);
      assert.ok(result.hasNewPostchecks);
    });

    test('should write specs to repository when plan has definition', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      assert.ok(ctx.PlanRepository.writeNodeSpec.calledWith('plan-1', 'job-1', 'work'));
    });

    test('should clear step statuses from resetToStage onward', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const nodeState = plan.nodeStates.get('node-1');
      nodeState.stepStatuses = {
        prechecks: 'completed',
        work: 'completed',
        postchecks: 'completed',
        commit: 'completed',
      };
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.strictEqual(nodeState.stepStatuses.prechecks, 'completed');
      assert.strictEqual(nodeState.stepStatuses.work, undefined);
      assert.strictEqual(nodeState.stepStatuses.postchecks, undefined);
      assert.strictEqual(nodeState.stepStatuses.commit, undefined);
    });

    test('should set resumeFromPhase for nodes that have executed', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const nodeState = plan.nodeStates.get('node-1');
      nodeState.status = 'failed';
      nodeState.attempts = 1;
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.strictEqual(nodeState.resumeFromPhase, 'work');
    });

    test('should NOT set resumeFromPhase for never-executed nodes', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const nodeState = plan.nodeStates.get('node-1');
      nodeState.status = 'pending';
      nodeState.attempts = 0;
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.strictEqual(nodeState.resumeFromPhase, undefined);
    });

    test('should respect explicit resetToStage parameter', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const nodeState = plan.nodeStates.get('node-1');
      nodeState.attempts = 1;
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        postchecks: { command: 'verify' },
        resetToStage: 'prechecks',
      }, ctx);
      
      assert.strictEqual(nodeState.resumeFromPhase, 'prechecks');
    });

    test('should save plan and emit events', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.ok(ctx.PlanRunner.savePlan.calledWith('plan-1'));
      assert.ok(ctx.PlanRunner.emit.calledWith('planUpdated', 'plan-1'));
    });

    test('should resume plan if not paused', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.ok(ctx.PlanRunner.resume.calledWith('plan-1'));
    });

    test('should NOT resume plan if paused', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan({ isPaused: true });
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.ok(!ctx.PlanRunner.resume.called);
    });

    test('should allow null to clear specs', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      plan.jobs.get('node-1').prechecks = { command: 'old' };
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        prechecks: null,
      }, ctx);
      
      assert.strictEqual(plan.jobs.get('node-1').prechecks, undefined);
    });

    test('should handle repository write errors gracefully', async () => {
      const { handleUpdatePlanJob } = require('../../../mcp/handlers/plan/updateJobHandler');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      ctx.PlanRepository.writeNodeSpec.rejects(new Error('Write failed'));
      
      // Should not throw, just log warning
      const result = await handleUpdatePlanJob({ 
        planId: 'plan-1',
        jobId: 'job-1',
        work: { agent: { instructions: 'new' } },
      }, ctx);
      
      assert.strictEqual(result.success, true);
    });
  });
});
