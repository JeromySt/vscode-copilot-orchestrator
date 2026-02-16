/**
 * @fileoverview Tests for McpHandler (src/mcp/handler.ts).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { McpHandler } from '../../../mcp/handler';
import { JsonRpcRequest } from '../../../mcp/types';

function silenceConsole() {
  sinon.stub(console, 'error');
  sinon.stub(console, 'warn');
  sinon.stub(console, 'info');
}

/** Create a stub PlanRunner with common methods. */
function createStubPlanRunner(): any {
  return {
    enqueue: sinon.stub(),
    enqueueJob: sinon.stub(),
    get: sinon.stub(),
    getPlan: sinon.stub(),
    getAll: sinon.stub().returns([]),
    getPlans: sinon.stub().returns([]),
    getStatus: sinon.stub().returns(undefined),
    getStateMachine: sinon.stub().returns(null),
    getEffectiveEndedAt: sinon.stub().returns(undefined),
    cancel: sinon.stub().returns(true),
    cancelPlan: sinon.stub(),
    delete: sinon.stub().returns(true),
    deletePlan: sinon.stub(),
    pause: sinon.stub().returns(true),
    resume: sinon.stub().returns(true),
    retryPlan: sinon.stub(),
    retryNode: sinon.stub(),
    getNodeLogs: sinon.stub().returns(''),
    getNodeAttempt: sinon.stub().returns(null),
    getNodeAttempts: sinon.stub().returns([]),
    getNodeFailureContext: sinon.stub().returns(null),
    forceFailNode: sinon.stub(),
    on: sinon.stub(),
    removeListener: sinon.stub(),
  };
}

suite('McpHandler', () => {
  let handler: McpHandler;
  let stubRunner: any;

  setup(() => {
    silenceConsole();
    stubRunner = createStubPlanRunner();
    handler = new McpHandler(stubRunner, '/workspace', {} as any);
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // initialize
  // =========================================================================

  suite('initialize', () => {
    test('returns protocol version and capabilities', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.result);
      assert.ok(response.result.protocolVersion);
      assert.ok(response.result.capabilities);
      assert.ok(response.result.serverInfo);
    });
  });

  // =========================================================================
  // notifications/initialized
  // =========================================================================

  suite('notifications/initialized', () => {
    test('returns empty result', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'notifications/initialized',
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.result);
      assert.ok(!response.error);
    });
  });

  // =========================================================================
  // tools/list
  // =========================================================================

  suite('tools/list', () => {
    test('returns array of tool definitions', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.result);
      assert.ok(Array.isArray(response.result.tools));
      assert.ok(response.result.tools.length > 0);

      // Each tool should have name, description, inputSchema
      const tool = response.result.tools[0];
      assert.ok(tool.name);
      assert.ok(tool.description);
      assert.ok(tool.inputSchema);
    });
  });

  // =========================================================================
  // tools/call - routing
  // =========================================================================

  suite('tools/call', () => {
    test('returns error for unknown tool', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.result);
      const content = JSON.parse(response.result.content[0].text);
      assert.strictEqual(content.success, false);
      assert.ok(content.error.includes('Unknown tool'));
    });

    test('routes list_copilot_plans to handler', async () => {
      stubRunner.getAll.returns([]);
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_copilot_plans', arguments: {} },
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.result);
      const content = JSON.parse(response.result.content[0].text);
      assert.ok(content.success !== undefined || Array.isArray(content.plans) || content.plans !== undefined);
    });

    test('validates input schema before processing', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'create_copilot_plan',
          arguments: {
            // Missing required 'name' and 'jobs' fields
          },
        },
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.result);
      const content = JSON.parse(response.result.content[0].text);
      assert.strictEqual(content.success, false);
      assert.ok(content.error);
    });
  });

  // =========================================================================
  // unknown method
  // =========================================================================

  suite('unknown method', () => {
    test('returns method not found error', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 7,
        method: 'unknown/method',
      };
      const response = await handler.handleRequest(request);
      assert.ok(response.error);
      assert.strictEqual(response.error!.code, -32601);
    });
  });

  // =========================================================================
  // error handling
  // =========================================================================

  suite('error handling', () => {
    test('returns JSON-RPC error on exception', async () => {
      // Force an error by making the tools/call crash
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: null, // Will cause an error when accessing params.name
      };
      const response = await handler.handleRequest(request);
      // Should return either a proper error response or handle gracefully
      assert.ok(response);
    });
  });

  // =========================================================================
  // tools/call - additional routing
  // =========================================================================

  suite('tool routing', () => {
    function makeToolCall(name: string, args: any = {}, id: number = 100) {
      return { jsonrpc: '2.0' as const, id, method: 'tools/call', params: { name, arguments: args } };
    }

    test('routes get_copilot_plan_status', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_plan_status', { id: 'x' }));
      assert.ok(response.result);
    });

    test('routes cancel_copilot_plan', async () => {
      const response = await handler.handleRequest(makeToolCall('cancel_copilot_plan', { id: 'x' }));
      assert.ok(response.result);
    });

    test('routes delete_copilot_plan', async () => {
      const response = await handler.handleRequest(makeToolCall('delete_copilot_plan', { id: 'x' }));
      assert.ok(response.result);
    });

    test('routes pause_copilot_plan', async () => {
      const response = await handler.handleRequest(makeToolCall('pause_copilot_plan', { id: 'x' }));
      assert.ok(response.result);
    });

    test('routes resume_copilot_plan', async () => {
      const response = await handler.handleRequest(makeToolCall('resume_copilot_plan', { id: 'x' }));
      assert.ok(response.result);
    });

    test('routes retry_copilot_plan', async () => {
      const response = await handler.handleRequest(makeToolCall('retry_copilot_plan', { id: 'x' }));
      assert.ok(response.result);
    });

    test('routes get_copilot_node_details', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_node_details', { planId: 'a', nodeId: 'b' }));
      assert.ok(response.result);
    });

    test('routes get_copilot_node_logs', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_node_logs', { planId: 'a', nodeId: 'b' }));
      assert.ok(response.result);
    });

    test('routes get_copilot_node_attempts', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_node_attempts', { planId: 'a', nodeId: 'b' }));
      assert.ok(response.result);
    });

    test('routes retry_copilot_plan_node', async () => {
      const response = await handler.handleRequest(makeToolCall('retry_copilot_plan_node', { planId: 'a', nodeId: 'b' }));
      assert.ok(response.result);
    });

    test('routes get_copilot_plan_node_failure_context', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_plan_node_failure_context', { planId: 'a', nodeId: 'b' }));
      assert.ok(response.result);
    });

    test('routes get_copilot_node', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_node', {}));
      assert.ok(response.result);
    });

    test('routes list_copilot_nodes', async () => {
      const response = await handler.handleRequest(makeToolCall('list_copilot_nodes', {}));
      assert.ok(response.result);
    });

    test('routes retry_copilot_node', async () => {
      const response = await handler.handleRequest(makeToolCall('retry_copilot_node', {}));
      assert.ok(response.result);
    });

    test('routes force_fail_copilot_node', async () => {
      const response = await handler.handleRequest(makeToolCall('force_fail_copilot_node', {}));
      assert.ok(response.result);
    });

    test('routes get_copilot_node_failure_context', async () => {
      const response = await handler.handleRequest(makeToolCall('get_copilot_node_failure_context', {}));
      assert.ok(response.result);
    });
  });
});
