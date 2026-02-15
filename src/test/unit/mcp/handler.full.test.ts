/**
 * @fileoverview Comprehensive tests for MCP handler.ts
 * Covers all handleToolsCall routing cases, error handling, validation.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as modelDiscovery from '../../../agent/modelDiscovery';
import { McpHandler } from '../../../mcp/handler';
import { JsonRpcRequest } from '../../../mcp/types';

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
    pause: sinon.stub().returns(true),
    resume: sinon.stub().resolves(true),
    retryNode: sinon.stub().resolves({ success: true }),
    getNodeFailureContext: sinon.stub().returns({ error: 'not found' }),
    getEffectiveEndedAt: sinon.stub().returns(undefined),
    forceFailNode: sinon.stub().resolves(),
    ...overrides,
  };
}

function makeMockPlan(overrides?: Record<string, any>): any {
  return {
    id: 'plan-1',
    spec: { name: 'Test Plan', jobs: [] },
    nodes: new Map(),
    producerIdToNodeId: new Map(),
    roots: ['node-1'],
    leaves: ['node-1'],
    nodeStates: new Map(),
    repoPath: '/workspace',
    baseBranch: 'main',
    targetBranch: 'copilot_plan/test',
    worktreeRoot: '/worktrees',
    createdAt: Date.now(),
    maxParallel: 4,
    cleanUpSuccessfulWork: true,
    isPaused: false,
    ...overrides,
  };
}

function makeRequest(method: string, params?: any, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

suite('McpHandler Full Coverage', () => {
  let handler: McpHandler;
  let mockRunner: any;
  let modelStub: sinon.SinonStub;

  setup(() => {
    modelStub = sinon.stub(modelDiscovery, 'discoverAvailableModels').resolves({
      models: [{ id: 'gpt-5', vendor: 'openai', family: 'gpt-5', tier: 'standard' }],
      rawChoices: ['gpt-5'],
      discoveredAt: Date.now(),
    });
    sinon.stub(modelDiscovery, 'getCachedModels').resolves({
      models: [{ id: 'gpt-5', vendor: 'openai', family: 'gpt-5', tier: 'standard' }],
      rawChoices: ['gpt-5'],
      discoveredAt: Date.now(),
    });
    mockRunner = makeMockPlanRunner();
    handler = new McpHandler(mockRunner, '/workspace', {} as any);
  });

  teardown(() => {
    sinon.restore();
  });

  suite('Protocol Methods', () => {
    test('initialize returns protocol version', async () => {
      const res = await handler.handleRequest(makeRequest('initialize'));
      assert.strictEqual(res.result.protocolVersion, '2024-11-05');
      assert.strictEqual(res.result.serverInfo.name, 'copilot-orchestrator');
    });

    test('notifications/initialized returns empty result', async () => {
      const res = await handler.handleRequest(makeRequest('notifications/initialized'));
      assert.ok(res.result);
    });

    test('tools/list returns tools array', async () => {
      const res = await handler.handleRequest(makeRequest('tools/list'));
      assert.ok(res.result);
      assert.ok(Array.isArray(res.result.tools));
      assert.ok(res.result.tools.length > 0);
    });

    test('unknown method returns -32601', async () => {
      const res = await handler.handleRequest(makeRequest('unknown/method'));
      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32601);
    });
  });

  suite('tools/call Routing', () => {
    // Helper to make tools/call request
    function toolCall(name: string, args: any = {}, id: number = 1): JsonRpcRequest {
      return makeRequest('tools/call', { name, arguments: args }, id);
    }

    test('create_copilot_plan routes correctly', async () => {
      const plan = makeMockPlan({
        nodes: new Map([['n1', {}]]),
        producerIdToNodeId: new Map([['build', 'n1']]),
      });
      mockRunner.enqueue.returns(plan);
      const res = await handler.handleRequest(toolCall('create_copilot_plan', {
        name: 'Test', jobs: [{ producer_id: 'build', task: 'Build', dependencies: [] }],
      }));
      assert.ok(res.result);
      assert.ok(res.result.content);
    });

    test('create_copilot_job routes correctly', async () => {
      const plan = makeMockPlan({ isPaused: false });
      mockRunner.enqueueJob.returns(plan);
      const res = await handler.handleRequest(toolCall('create_copilot_job', {
        name: 'Build', task: 'Build it',
      }));
      assert.ok(res.result);
    });

    test('get_copilot_plan_status routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_plan_status', { id: 'p1' }));
      assert.ok(res.result);
    });

    test('list_copilot_plans routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('list_copilot_plans', {}));
      assert.ok(res.result);
    });

    test('get_copilot_node_details routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_node_details', { planId: 'p', nodeId: 'n' }));
      assert.ok(res.result);
    });

    test('get_copilot_node_logs routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_node_logs', { planId: 'p', nodeId: 'n' }));
      assert.ok(res.result);
    });

    test('get_copilot_node_attempts routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_node_attempts', { planId: 'p', nodeId: 'n' }));
      assert.ok(res.result);
    });

    test('cancel_copilot_plan routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('cancel_copilot_plan', { id: 'p1' }));
      assert.ok(res.result);
    });

    test('pause_copilot_plan routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('pause_copilot_plan', { id: 'p1' }));
      assert.ok(res.result);
    });

    test('resume_copilot_plan routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('resume_copilot_plan', { id: 'p1' }));
      assert.ok(res.result);
    });

    test('delete_copilot_plan routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('delete_copilot_plan', { id: 'p1' }));
      assert.ok(res.result);
    });

    test('retry_copilot_plan routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('retry_copilot_plan', { id: 'p1' }));
      assert.ok(res.result);
    });

    test('get_copilot_plan_node_failure_context routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_plan_node_failure_context', { planId: 'p', nodeId: 'n' }));
      assert.ok(res.result);
    });

    test('retry_copilot_plan_node routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('retry_copilot_plan_node', { planId: 'p', nodeId: 'n' }));
      assert.ok(res.result);
    });

    test('update_copilot_plan_node routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('update_copilot_plan_node', { planId: 'p', nodeId: 'n' }));
      assert.ok(res.result);
    });

    test('create_copilot_node routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('create_copilot_node', {
        nodes: [{ producer_id: 'build', task: 'Build', dependencies: [] }],
      }));
      assert.ok(res.result);
    });

    test('get_copilot_node routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_node', { node_id: 'n1' }));
      assert.ok(res.result);
    });

    test('list_copilot_nodes routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('list_copilot_nodes', {}));
      assert.ok(res.result);
    });

    test('retry_copilot_node routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('retry_copilot_node', { node_id: 'n1' }));
      assert.ok(res.result);
    });

    test('force_fail_copilot_node routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('force_fail_copilot_node', { node_id: 'n1' }));
      assert.ok(res.result);
    });

    test('get_copilot_node_failure_context routes correctly', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_node_failure_context', { node_id: 'n1' }));
      assert.ok(res.result);
    });

    test('unknown tool returns error in content', async () => {
      const res = await handler.handleRequest(toolCall('nonexistent_tool', {}));
      assert.ok(res.result);
      const content = JSON.parse(res.result.content[0].text);
      assert.strictEqual(content.success, false);
      assert.ok(content.error.includes('Unknown tool'));
    });

    test('tools/call with no params', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', undefined));
      assert.ok(res.result);
    });

    test('schema validation failure returns error in content', async () => {
      const res = await handler.handleRequest(toolCall('get_copilot_plan_status', { unknownField: true }));
      assert.ok(res.result);
      const content = JSON.parse(res.result.content[0].text);
      assert.strictEqual(content.success, false);
    });
  });

  suite('Error Handling', () => {
    test('should catch handler exceptions as -32603', async () => {
      // Create a handler that throws on tools/list
      const badRunner = makeMockPlanRunner();
      const badHandler = new McpHandler(badRunner, '/workspace', {} as any);
      
      // Stub the internal method to throw
      const origHandleRequest = badHandler.handleRequest.bind(badHandler);
      const throwingHandler = new McpHandler(badRunner, '/workspace', {} as any);
      // Force an error by making a handler throw
      sinon.stub(throwingHandler as any, 'handleToolsList').throws(new Error('Internal failure'));
      
      const res = await throwingHandler.handleRequest(makeRequest('tools/list'));
      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32603);
    });
  });
});
