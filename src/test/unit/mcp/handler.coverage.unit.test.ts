/**
 * Coverage tests for src/mcp/handler.ts
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { McpHandler } from '../../../mcp/handler';
import type { JsonRpcRequest } from '../../../mcp/types';

suite('McpHandler - coverage', () => {
  let sandbox: sinon.SinonSandbox;
  let handler: McpHandler;
  let mockPlanRunner: any;
  let mockGit: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockPlanRunner = {
      enqueue: sandbox.stub(),
      get: sandbox.stub(),
      getAll: sandbox.stub().returns([]),
      cancel: sandbox.stub(),
      delete: sandbox.stub(),
      pause: sandbox.stub(),
      resume: sandbox.stub(),
      retryNode: sandbox.stub(),
      forceFailNode: sandbox.stub(),
    };
    mockGit = {
      repository: {
        getCurrentBranch: sandbox.stub().resolves('main'),
      }
    };
    handler = new McpHandler(mockPlanRunner, '/workspace', mockGit);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('handleInitialize returns protocol version and capabilities', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    };
    
    const response = await handler.handleRequest(request);
    assert.strictEqual(response.jsonrpc, '2.0');
    assert.strictEqual(response.id, 1);
    assert.ok(response.result);
    assert.ok(response.result.protocolVersion);
    assert.ok(response.result.capabilities);
    assert.ok(response.result.serverInfo);
  });

  test('handleInitializedNotification returns empty result', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'notifications/initialized',
      params: {}
    };
    
    const response = await handler.handleRequest(request);
    assert.strictEqual(response.jsonrpc, '2.0');
    assert.strictEqual(response.id, 2);
    assert.deepStrictEqual(response.result, {});
  });

  test('handleToolsList returns tool definitions', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {}
    };
    
    const response = await handler.handleRequest(request);
    assert.strictEqual(response.jsonrpc, '2.0');
    assert.ok(response.result);
    assert.ok(Array.isArray(response.result.tools));
    assert.ok(response.result.tools.length > 0);
  });

  test('handleRequest returns error for unknown method', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'unknown_method',
      params: {}
    };
    
    const response = await handler.handleRequest(request);
    assert.strictEqual(response.jsonrpc, '2.0');
    assert.ok(response.error);
    assert.strictEqual(response.error.code, -32601);
    assert.ok(response.error.message.includes('Method not found'));
  });

  test('handleRequest catches and returns internal errors', async () => {
    const badHandler = new McpHandler(null as any, '/workspace', mockGit);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'get_copilot_plan_status',
        arguments: { planId: 'plan-1' }
      }
    };
    
    const response = await badHandler.handleRequest(request);
    // When planRunner is null, the handler should catch the error
    // and return an error response or a tool result with isError
    assert.ok(response.result || response.error);
  });

  test('handleToolsCall validates schema', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'create_copilot_plan',
        arguments: {
          // Missing required fields
        }
      }
    };
    
    const response = await handler.handleRequest(request);
    assert.strictEqual(response.jsonrpc, '2.0');
    const content = JSON.parse(response.result.content[0].text);
    assert.strictEqual(content.success, false);
    assert.ok(content.error);
    assert.strictEqual(response.result.isError, true);
  });

  test('handleToolsCall returns error for unknown tool', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'unknown_tool',
        arguments: {}
      }
    };
    
    const response = await handler.handleRequest(request);
    const content = JSON.parse(response.result.content[0].text);
    assert.strictEqual(content.success, false);
    assert.ok(content.error.includes('Unknown tool'));
  });

  test('handleToolsCall injects _meta in result', async () => {
    mockPlanRunner.getAll.returns([]);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'list_copilot_plans',
        arguments: {}
      }
    };
    
    const response = await handler.handleRequest(request);
    const content = JSON.parse(response.result.content[0].text);
    assert.ok(content._meta);
    assert.ok(content._meta.version);
    assert.ok(content._meta.buildCommit);
    assert.ok(content._meta.buildTimestamp);
  });

  test('handleToolsCall sets isError flag on failure', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'cancel_copilot_plan',
        arguments: {
          planId: 'nonexistent'
        }
      }
    };
    
    mockPlanRunner.cancel.returns(false);
    const response = await handler.handleRequest(request);
    assert.strictEqual(response.result.isError, true);
  });
});
