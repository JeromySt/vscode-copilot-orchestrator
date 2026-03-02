/**
 * @fileoverview Unit tests for jobHandlers module
 * Tests all job-centric MCP tool handlers.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as validation from '../../../mcp/validation';

// Mock helper functions
function makeMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    getPlan: sinon.stub().returns(undefined),
    getAll: sinon.stub().returns([]),
    getStatus: sinon.stub().returns(undefined),
    getStateMachine: sinon.stub().returns(undefined),
    getEffectiveEndedAt: sinon.stub().returns(undefined),
    cancel: sinon.stub().returns(true),
    delete: sinon.stub().returns(true),
    retryNode: sinon.stub().resolves({ success: true }),
    forceFailNode: sinon.stub().resolves(),
    resume: sinon.stub().resolves(true),
    emit: sinon.stub(),
    ...overrides,
  };
}

function makeMockPlan(overrides?: Record<string, any>): any {
  const jobs = new Map();
  const nodeStates = new Map();
  const producerIdToNodeId = new Map();
  
  jobs.set('node-1', {
    id: 'node-1',
    producerId: 'job-1',
    name: 'Test Job',
    type: 'job',
    dependencies: [],
    dependents: [],
    task: 'Test task',
    work: { agent: { instructions: 'test' } },
  });
  
  nodeStates.set('node-1', {
    status: 'succeeded',
    attempts: 1,
    scheduledAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    baseCommit: 'abc123',
    completedCommit: 'def456',
  });
  
  producerIdToNodeId.set('job-1', 'node-1');
  
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    jobs,
    producerIdToNodeId,
    nodeStates,
    roots: ['node-1'],
    leaves: ['node-1'],
    repoPath: '/workspace',
    baseBranch: 'main',
    targetBranch: 'copilot_plan/test',
    createdAt: Date.now(),
    definition: {
      getWorkSpec: sinon.stub().resolves({ agent: { instructions: 'test' } }),
      getPrechecksSpec: sinon.stub().resolves(undefined),
      getPostchecksSpec: sinon.stub().resolves(undefined),
    },
    ...overrides,
  };
}

function makeCtx(runnerOverrides?: Record<string, any>): any {
  return {
    PlanRunner: makeMockPlanRunner(runnerOverrides),
    workspacePath: '/workspace',
    configProvider: {
      getConfig: sinon.stub().returns(undefined),
    },
  };
}

suite('jobHandlers', () => {
  let sandbox: sinon.SinonSandbox;
  let validateStub: sinon.SinonStub;
  let validateFoldersStub: sinon.SinonStub;
  let validateUrlsStub: sinon.SinonStub;
  let validateModelsStub: sinon.SinonStub;
  let validatePsStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Stub the validator sub-module directly (barrel re-exports use getters)
    const validator = require('../../../mcp/validation/validator');
    validateStub = sandbox.stub(validator, 'validateInput').returns({ valid: true });
    validateFoldersStub = sandbox.stub(validator, 'validateAllowedFolders').resolves({ valid: true });
    validateUrlsStub = sandbox.stub(validator, 'validateAllowedUrls').resolves({ valid: true });
    validateModelsStub = sandbox.stub(validator, 'validateAgentModels').resolves({ valid: true });
    validatePsStub = sandbox.stub(validator, 'validatePowerShellCommands').returns({ valid: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('handleGetJob', () => {
    test('should return error when planId is missing', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleGetJob({ jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when jobId is missing', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleGetJob({ planId: 'plan-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('jobId'));
    });

    test('should return error when plan not found', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleGetJob({ planId: 'not-found', jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should return error when job not found', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleGetJob({ planId: 'plan-1', jobId: 'not-found' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Job not found'));
    });

    test('should return job details by producerId', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleGetJob({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'node-1');
      assert.strictEqual(result.node.producerId, 'job-1');
      assert.strictEqual(result.state.status, 'succeeded');
    });

    test('should return job details by nodeId', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleGetJob({ planId: 'plan-1', jobId: 'node-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.node.id, 'node-1');
    });

    test('should include work spec for job type nodes', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleGetJob({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.node.work);
      assert.ok(result.node.task);
    });

    test('should mark leaf nodes with mergedToTarget status', async () => {
      const { handleGetJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').mergedToTarget = true;
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleGetJob({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.state.isLeaf, true);
      assert.strictEqual(result.state.mergedToTarget, true);
    });
  });

  suite('handleListJobs', () => {
    test('should return error when planId is missing', async () => {
      const { handleListJobs } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleListJobs({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when plan not found', async () => {
      const { handleListJobs } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleListJobs({ planId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should list all jobs in plan', async () => {
      const { handleListJobs } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleListJobs({ planId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.nodes.length, 1);
      assert.strictEqual(result.nodes[0].id, 'node-1');
    });

    test('should filter jobs by status', async () => {
      const { handleListJobs } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.jobs.set('node-2', {
        id: 'node-2',
        producerId: 'job-2',
        name: 'Failed Job',
        type: 'job',
        dependencies: [],
        dependents: [],
      });
      plan.nodeStates.set('node-2', { status: 'failed', attempts: 1 });
      plan.producerIdToNodeId.set('job-2', 'node-2');
      
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleListJobs({ planId: 'plan-1', status: 'failed' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.nodes[0].status, 'failed');
    });

    test('should filter by groupName', async () => {
      const { handleListJobs } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleListJobs({ planId: 'plan-1', groupName: 'Different' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.nodes.length, 0);
    });

    test('should return empty list for non-matching groupName', async () => {
      const { handleListJobs } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleListJobs({ planId: 'plan-1', groupName: 'test' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
    });
  });

  suite('handleGetGroupStatus', () => {
    test('should return error when groupId is missing', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleGetGroupStatus({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('groupId'));
    });

    test('should return error when group not found', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleGetGroupStatus({ groupId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Group not found'));
    });

    test('should return group status', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const status = {
        plan,
        status: 'succeeded',
        counts: { succeeded: 1, failed: 0, pending: 0 },
        progress: 1.0,
      };
      const ctx = makeCtx({ getStatus: sinon.stub().returns(status) });
      const result = await handleGetGroupStatus({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.groupId, 'plan-1');
      assert.strictEqual(result.status, 'succeeded');
      assert.strictEqual(result.progress, 100);
    });

    test('should include effective endedAt', async () => {
      const { handleGetGroupStatus } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const status = {
        plan,
        status: 'succeeded',
        counts: { succeeded: 1 },
        progress: 1.0,
      };
      const endedAt = Date.now();
      const ctx = makeCtx({ 
        getStatus: sinon.stub().returns(status),
        getEffectiveEndedAt: sinon.stub().returns(endedAt),
      });
      const result = await handleGetGroupStatus({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.endedAt, endedAt);
    });
  });

  suite('handleListGroups', () => {
    test('should list all groups', async () => {
      const { handleListGroups } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const sm = {
        computePlanStatus: sinon.stub().returns('succeeded'),
        getStatusCounts: sinon.stub().returns({ succeeded: 1, failed: 0 }),
      };
      const ctx = makeCtx({ 
        getAll: sinon.stub().returns([plan]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await handleListGroups({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.groups[0].groupId, 'plan-1');
    });

    test('should filter groups by status', async () => {
      const { handleListGroups } = require('../../../mcp/handlers/jobHandlers');
      const plan1 = makeMockPlan({ id: 'plan-1' });
      const plan2 = makeMockPlan({ id: 'plan-2' });
      const sm1 = {
        computePlanStatus: sinon.stub().returns('succeeded'),
        getStatusCounts: sinon.stub().returns({ succeeded: 1 }),
      };
      const sm2 = {
        computePlanStatus: sinon.stub().returns('running'),
        getStatusCounts: sinon.stub().returns({ running: 1 }),
      };
      
      const getStateMachineStub = sinon.stub();
      getStateMachineStub.withArgs('plan-1').returns(sm1);
      getStateMachineStub.withArgs('plan-2').returns(sm2);
      
      const ctx = makeCtx({ 
        getAll: sinon.stub().returns([plan1, plan2]),
        getStateMachine: getStateMachineStub,
      });
      
      const result = await handleListGroups({ status: 'succeeded' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.groups[0].status, 'succeeded');
    });

    test('should sort groups by createdAt descending', async () => {
      const { handleListGroups } = require('../../../mcp/handlers/jobHandlers');
      const plan1 = makeMockPlan({ id: 'plan-1', createdAt: 100 });
      const plan2 = makeMockPlan({ id: 'plan-2', createdAt: 200 });
      const sm = {
        computePlanStatus: sinon.stub().returns('pending'),
        getStatusCounts: sinon.stub().returns({}),
      };
      const ctx = makeCtx({ 
        getAll: sinon.stub().returns([plan1, plan2]),
        getStateMachine: sinon.stub().returns(sm),
      });
      const result = await handleListGroups({}, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.groups[0].groupId, 'plan-2'); // Newer first
      assert.strictEqual(result.groups[1].groupId, 'plan-1');
    });
  });

  suite('handleCancelGroup', () => {
    test('should return error when groupId is missing', async () => {
      const { handleCancelGroup } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleCancelGroup({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('groupId'));
    });

    test('should return error when group not found', async () => {
      const { handleCancelGroup } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleCancelGroup({ groupId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Group not found'));
    });

    test('should cancel group successfully', async () => {
      const { handleCancelGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleCancelGroup({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('canceled'));
      assert.ok(ctx.PlanRunner.cancel.calledWith('plan-1'));
    });
  });

  suite('handleDeleteGroup', () => {
    test('should return error when groupId is missing', async () => {
      const { handleDeleteGroup } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleDeleteGroup({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('groupId'));
    });

    test('should return error when group not found', async () => {
      const { handleDeleteGroup } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleDeleteGroup({ groupId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Group not found'));
    });

    test('should delete group successfully', async () => {
      const { handleDeleteGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleDeleteGroup({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('deleted'));
      assert.ok(ctx.PlanRunner.delete.calledWith('plan-1'));
    });
  });

  suite('handleRetryGroup', () => {
    test('should return error when groupId is missing', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleRetryGroup({}, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('groupId'));
    });

    test('should return error when group not found', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleRetryGroup({ groupId: 'not-found' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Group not found'));
    });

    test('should retry all failed jobs when no jobIds provided', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'failed';
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
      });
      const result = await handleRetryGroup({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(ctx.PlanRunner.retryNode.calledWith('plan-1', 'node-1'));
      assert.ok(ctx.PlanRunner.resume.calledWith('plan-1'));
    });

    test('should retry specific jobs when jobIds provided', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
      });
      const result = await handleRetryGroup({ groupId: 'plan-1', jobIds: ['node-1'] }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.retriedNodes.length, 1);
    });

    test('should return error when no failed jobs to retry', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleRetryGroup({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('No failed jobs'));
    });

    test('should pass retry options to retryNode', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'failed';
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
      });
      const result = await handleRetryGroup({ 
        groupId: 'plan-1',
        newWork: { agent: { instructions: 'new' } },
        clearWorktree: true,
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(ctx.PlanRunner.retryNode.calledWith('plan-1', 'node-1', sinon.match({
        newWork: sinon.match.object,
        clearWorktree: true,
      })));
    });

    test('should handle mixed success and failure results', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.jobs.set('node-2', {
        id: 'node-2',
        producerId: 'job-2',
        name: 'Failed Job',
        type: 'job',
        dependencies: [],
        dependents: [],
      });
      plan.nodeStates.set('node-1', { status: 'failed', attempts: 1 });
      plan.nodeStates.set('node-2', { status: 'failed', attempts: 1 });
      
      const retryStub = sinon.stub();
      retryStub.withArgs('plan-1', 'node-1').resolves({ success: true });
      retryStub.withArgs('plan-1', 'node-2').resolves({ success: false, error: 'Cannot retry' });
      
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: retryStub,
      });
      const result = await handleRetryGroup({ groupId: 'plan-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.retriedNodes.length, 1);
      assert.strictEqual(result.errors.length, 1);
    });

    test('should handle exceptions during retry', async () => {
      const { handleRetryGroup } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().rejects(new Error('Retry failed')),
      });
      const result = await handleRetryGroup({ groupId: 'plan-1', jobIds: ['node-1'] }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Retry failed'));
    });
  });

  suite('handleRetryJob', () => {
    test('should return error when planId is missing', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleRetryJob({ jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when jobId is missing', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleRetryJob({ planId: 'plan-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('jobId'));
    });

    test('should validate agent models when new specs provided', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      validateModelsStub.resolves({ valid: false, error: 'Invalid model' });
      const result = await handleRetryJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        newWork: { agent: { model: 'invalid' } },
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid model'));
    });

    test('should validate allowed folders', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      validateFoldersStub.resolves({ valid: false, error: 'Invalid folder' });
      const result = await handleRetryJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        allowedFolders: ['/invalid'],
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid folder'));
    });

    test('should validate allowed URLs', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      validateUrlsStub.resolves({ valid: false, error: 'Invalid URL' });
      const result = await handleRetryJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        allowedUrls: ['bad://url'],
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid URL'));
    });

    test('should reject PowerShell commands with 2>&1', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      validatePsStub.returns({ valid: false, error: 'PowerShell redirect detected' });
      const result = await handleRetryJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        newWork: { command: 'test 2>&1' },
      }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('PowerShell redirect'));
    });

    test('should return error when plan not found', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleRetryJob({ planId: 'not-found', jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should return error when job not found', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleRetryJob({ planId: 'plan-1', jobId: 'not-found' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Job not found'));
    });

    test('should retry job successfully', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
      });
      const result = await handleRetryJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        newWork: { agent: { instructions: 'retry' } },
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('Retry initiated'));
      assert.ok(ctx.PlanRunner.retryNode.calledWith('plan-1', 'node-1'));
      assert.ok(ctx.PlanRunner.resume.calledWith('plan-1'));
    });

    test('should pass retry options correctly', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: true }),
      });
      const result = await handleRetryJob({ 
        planId: 'plan-1', 
        jobId: 'job-1',
        newWork: { agent: { instructions: 'new' } },
        newPrechecks: { command: 'check' },
        newPostchecks: { command: 'verify' },
        clearWorktree: true,
      }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(ctx.PlanRunner.retryNode.calledWith('plan-1', 'node-1', sinon.match({
        newWork: sinon.match.object,
        newPrechecks: sinon.match.object,
        newPostchecks: sinon.match.object,
        clearWorktree: true,
      })));
    });

    test('should handle retry failure', async () => {
      const { handleRetryJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        retryNode: sinon.stub().resolves({ success: false, error: 'Cannot retry' }),
      });
      const result = await handleRetryJob({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Cannot retry'));
    });
  });

  suite('handleForceFailJob', () => {
    test('should return error when planId is missing', async () => {
      const { handleForceFailJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleForceFailJob({ jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when jobId is missing', async () => {
      const { handleForceFailJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleForceFailJob({ planId: 'plan-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('jobId'));
    });

    test('should return error when plan not found', async () => {
      const { handleForceFailJob } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleForceFailJob({ planId: 'not-found', jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should return error when job not found', async () => {
      const { handleForceFailJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleForceFailJob({ planId: 'plan-1', jobId: 'not-found' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Job not found'));
    });

    test('should force fail job successfully', async () => {
      const { handleForceFailJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleForceFailJob({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('force failed'));
      assert.ok(ctx.PlanRunner.forceFailNode.calledWith('plan-1', 'node-1'));
    });

    test('should handle force fail error', async () => {
      const { handleForceFailJob } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
        forceFailNode: sinon.stub().rejects(new Error('Force fail failed')),
      });
      const result = await handleForceFailJob({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Force fail failed'));
    });
  });

  suite('handleJobFailureContext', () => {
    test('should return error when planId is missing', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleJobFailureContext({ jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('planId'));
    });

    test('should return error when jobId is missing', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleJobFailureContext({ planId: 'plan-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('jobId'));
    });

    test('should return error when plan not found', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const result = await handleJobFailureContext({ planId: 'not-found', jobId: 'job-1' }, makeCtx());
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Plan not found'));
    });

    test('should return error when job not found', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleJobFailureContext({ planId: 'plan-1', jobId: 'not-found' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Job not found'));
    });

    test('should return error when job is not in failed state', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleJobFailureContext({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not in failed state'));
    });

    test('should return failure context for failed job', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'failed';
      plan.nodeStates.get('node-1').error = 'Test error';
      plan.nodeStates.get('node-1').lastAttempt = {
        phase: 'work',
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
      const executor = {
        getLogs: sinon.stub().returns([
          { timestamp: Date.now(), phase: 'work', type: 'error', message: 'Failed' },
        ]),
      };
      const ctx = makeCtx({ 
        getPlan: sinon.stub().returns(plan),
      });
      (ctx.PlanRunner as any).executor = executor;
      
      const result = await handleJobFailureContext({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.nodeId, 'node-1');
      assert.strictEqual(result.error, 'Test error');
      assert.strictEqual(result.failedPhase, 'work');
      assert.strictEqual(result.logs.length, 1);
    });

    test('should handle missing executor gracefully', async () => {
      const { handleJobFailureContext } = require('../../../mcp/handlers/jobHandlers');
      const plan = makeMockPlan();
      plan.nodeStates.get('node-1').status = 'failed';
      const ctx = makeCtx({ getPlan: sinon.stub().returns(plan) });
      const result = await handleJobFailureContext({ planId: 'plan-1', jobId: 'job-1' }, ctx);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.logs.length, 0);
    });
  });
});
