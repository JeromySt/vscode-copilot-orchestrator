/**
 * @fileoverview Unit tests for McpHandler routing dispatch.
 *
 * Tests cover:
 * - Handler routing for scaffold_copilot_plan, add_copilot_plan_job, finalize_copilot_plan
 * - Schema validation integration at handler level
 * - Error handling for malformed requests
 * - Tools/call routing dispatch
 *
 * Target: Coverage for handler.ts routing logic
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { McpHandler } from '../../../mcp/handler';
import { JsonRpcRequest } from '../../../mcp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

/** Minimal PlanRunner stub */
function makeMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    enqueue: sinon.stub().returns(makeMockPlan()),
    enqueueJob: sinon.stub().returns(makeMockPlan()),
    get: sinon.stub().returns(undefined),
    getPlan: sinon.stub().returns(undefined),
    getAll: sinon.stub().returns([]),
    getStatus: sinon.stub().returns(undefined),
    getStateMachine: sinon.stub().returns(undefined),
    getNodeLogs: sinon.stub().returns(''),
    getNodeAttempt: sinon.stub().returns(null),
    getNodeAttempts: sinon.stub().returns([]),
    cancel: sinon.stub().returns(true),
    delete: sinon.stub().returns(true),
    retryNode: sinon.stub().resolves({ success: true }),
    resume: sinon.stub().resolves(true),
    pause: sinon.stub().returns(true),
    getNodeFailureContext: sinon.stub().returns({ error: 'not found' }),
    getEffectiveEndedAt: sinon.stub().returns(undefined),
    registerPlan: sinon.stub(),
    forceFailNode: sinon.stub().resolves(),
    _state: {
      events: {
        emitPlanUpdated: sinon.stub(),
      },
    },
    ...overrides,
  };
}

/** Minimal PlanInstance */
function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    jobs: new Map(),
    producerIdToNodeId: new Map(),
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: new Map(),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    repoPath: '/workspace',
    baseBranch: 'main',
    targetBranch: 'copilot_plan/test',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    maxParallel: 4,
    cleanUpSuccessfulWork: true,
    isPaused: false,
    stateVersion: 1,
    ...overrides,
  };
}

/** Minimal git mock */
function makeMockGit(): any {
  return {
    branches: {
      currentOrNull: sinon.stub().resolves('main'),
      isDefaultBranch: sinon.stub().resolves(false),
      exists: sinon.stub().resolves(true),
      create: sinon.stub().resolves(),
    },
  };
}

/** Minimal PlanRepository mock */
function makeMockPlanRepository(): any {
  return {
    scaffold: sinon.stub().resolves({ id: 'plan-scaffold-1' }),
    addNode: sinon.stub().resolves({
      jobs: new Map(),
      nodeStates: new Map(),
      producerIdToNodeId: new Map(),
      roots: [],
      leaves: [],
      groups: new Map(),
      groupStates: new Map(),
      groupPathToId: new Map(),
    }),
    finalize: sinon.stub().resolves(makeMockPlan({ spec: { name: 'Finalized', status: 'pending' } })),
    getDefinition: sinon.stub().resolves({ id: 'plan-1', status: 'scaffolding', spec: { status: 'scaffolding' } }),
  };
}

function makeRequest(method: string, params?: any, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('McpHandler Routing Dispatch', () => {
  let quiet: { restore: () => void };
  let mockRunner: any;
  let mockGit: any;
  let mockPlanRepository: any;
  let handler: McpHandler;

  setup(() => {
    quiet = silenceConsole();
    mockRunner = makeMockPlanRunner();
    mockGit = makeMockGit();
    mockPlanRepository = makeMockPlanRepository();
    handler = new McpHandler(
      mockRunner, 
      '/workspace', 
      mockGit, 
      undefined, 
      mockPlanRepository
    );
  });

  teardown(() => {
    quiet.restore();
    sinon.restore();
  });

  // =========================================================================
  // scaffold_copilot_plan routing
  // =========================================================================
  suite('scaffold_copilot_plan routing', () => {
    test('routes scaffold_copilot_plan to handleScaffoldPlan', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'scaffold_copilot_plan',
        arguments: { name: 'Test Scaffold' },
      }));

      assert.ok(res.result);
      assert.ok(res.result.content);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.ok(parsed.planId);
      assert.ok(mockPlanRepository.scaffold.calledOnce);
    });

    test('validates scaffold_copilot_plan input schema', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'scaffold_copilot_plan',
        arguments: {}, // Missing required name
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error);
    });

    test('returns planId and message on successful scaffold', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'scaffold_copilot_plan',
        arguments: { 
          name: 'My Plan',
          baseBranch: 'main',
          maxParallel: 4,
        },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.ok(parsed.planId);
      assert.ok(parsed.message.includes('scaffold'));
    });

    test('handles scaffold errors gracefully', async () => {
      mockPlanRepository.scaffold.rejects(new Error('Scaffold failed'));

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'scaffold_copilot_plan',
        arguments: { name: 'Test' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('Scaffold failed'));
    });
  });

  // =========================================================================
  // add_copilot_plan_job routing
  // =========================================================================
  suite('add_copilot_plan_job routing', () => {
    test('routes add_copilot_plan_job to handleAddPlanNode', async () => {
      mockRunner.get.returns({
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        stateVersion: 0,
      });

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'add_copilot_plan_job',
        arguments: {
          planId: 'plan-1',
          producerId: 'build-job',
          task: 'Build the app',
          work: 'npm run build',
        },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.ok(mockPlanRepository.addNode.calledOnce);
    });

    test('validates add_copilot_plan_job required fields', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'add_copilot_plan_job',
        arguments: {
          planId: 'plan-1',
          // Missing producer_id and task
        },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error);
    });

    test('validates producer_id pattern', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'add_copilot_plan_job',
        arguments: {
          planId: 'plan-1',
          producerId: 'INVALID', // uppercase
          task: 'Build',
        },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
    });

    test('handles add node errors', async () => {
      mockPlanRepository.addNode.rejects(new Error('Duplicate producer_id'));

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'add_copilot_plan_job',
        arguments: {
          planId: 'plan-1',
          producerId: 'build-job',
          task: 'Build',
          work: 'npm run build',
        },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('Duplicate'));
    });
  });

  // =========================================================================
  // finalize_copilot_plan routing
  // =========================================================================
  suite('finalize_copilot_plan routing', () => {
    test('routes finalize_copilot_plan to handleFinalizePlan', async () => {
      mockRunner.get.returns({
        spec: { status: 'scaffolding', name: 'Test' },
        jobs: new Map(),
        nodeStates: new Map(),
        producerIdToNodeId: new Map(),
        roots: [],
        leaves: [],
        groups: new Map(),
        groupStates: new Map(),
        groupPathToId: new Map(),
        stateVersion: 0,
        isPaused: true,
      });

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'finalize_copilot_plan',
        arguments: { planId: 'plan-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.ok(mockPlanRepository.finalize.calledOnce);
    });

    test('validates finalize_copilot_plan required fields', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'finalize_copilot_plan',
        arguments: {}, // Missing planId
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error);
    });

    test('handles finalize errors', async () => {
      mockPlanRepository.finalize.rejects(new Error('Circular dependency'));

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'finalize_copilot_plan',
        arguments: { planId: 'plan-1' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('Circular dependency'));
    });

    test('returns jobMapping on success', async () => {
      const planWithNodes = makeMockPlan();
      planWithNodes.producerIdToNodeId = new Map([
        ['build', 'node-1'],
        ['test', 'node-2'],
      ]);
      planWithNodes.spec = { name: 'Test', status: 'pending' };
      mockPlanRepository.finalize.resolves(planWithNodes);
      mockRunner.get.returns(planWithNodes);

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'finalize_copilot_plan',
        arguments: { planId: 'plan-1', startPaused: false },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.ok(parsed.jobMapping);
      assert.strictEqual(parsed.jobMapping['build'], 'node-1');
      assert.strictEqual(parsed.jobMapping['test'], 'node-2');
    });
  });

  // =========================================================================
  // Node-centric tool routing
  // =========================================================================
  suite('node-centric tool routing', () => {
    test('routes get_copilot_job', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_job',
        arguments: { jobId: 'node-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      // Will fail since node not found, but routing works
      assert.ok('success' in parsed);
    });

    test('routes list_copilot_jobs', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_jobs',
        arguments: {},
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });

    test('routes retry_copilot_job', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'retry_copilot_job',
        arguments: { jobId: 'node-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });

    test('routes force_fail_copilot_job', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'force_fail_copilot_job',
        arguments: { jobId: 'node-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });

    test('routes get_copilot_job_failure_context', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_job_failure_context',
        arguments: { jobId: 'node-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });
  });

  // =========================================================================
  // Plan control tool routing
  // =========================================================================
  suite('plan control tool routing', () => {
    test('routes pause_copilot_plan', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'pause_copilot_plan',
        arguments: { id: 'plan-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });

    test('routes resume_copilot_plan', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'resume_copilot_plan',
        arguments: { id: 'plan-1' },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });

    test('routes reshape_copilot_plan', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'reshape_copilot_plan',
        arguments: {
          planId: 'plan-1',
          operations: [{ type: 'add_node', spec: { producerId: 'new', task: 'Test', dependencies: [] } }],
        },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });

    test('routes update_copilot_plan_job', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'update_copilot_plan_job',
        arguments: {
          planId: 'plan-1',
          nodeId: 'node-1',
          work: 'npm run build',
        },
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.ok('success' in parsed);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  suite('error handling', () => {
    test('returns JSON-RPC error for unknown method', async () => {
      const res = await handler.handleRequest(makeRequest('unknown/method'));

      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32601);
      assert.ok(res.error.message.includes('Method not found'));
    });

    test('returns error for unknown tool name', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('Unknown tool'));
    });

    test('handles null arguments gracefully', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: null,
      }));

      // Should not throw
      assert.ok(res.result);
    });

    test('handles undefined arguments gracefully', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
    });

    test('catches and wraps handler exceptions', async () => {
      mockRunner.getAll.throws(new Error('Internal failure'));

      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }));

      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32603);
      assert.ok(res.error.message.includes('Internal failure'));
    });
  });

  // =========================================================================
  // Response format
  // =========================================================================
  suite('response format', () => {
    test('tools/call returns content array with text type', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }));

      assert.ok(res.result);
      assert.ok(Array.isArray(res.result.content));
      assert.strictEqual(res.result.content[0].type, 'text');
      assert.ok(typeof res.result.content[0].text === 'string');
    });

    test('content text is valid JSON', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }));

      const text = res.result.content[0].text;
      assert.doesNotThrow(() => JSON.parse(text));
    });

    test('echoes request id in response', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }, 'custom-id-123'));

      assert.strictEqual(res.id, 'custom-id-123');
    });

    test('always includes jsonrpc version', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }));

      assert.strictEqual(res.jsonrpc, '2.0');
    });
  });
});
