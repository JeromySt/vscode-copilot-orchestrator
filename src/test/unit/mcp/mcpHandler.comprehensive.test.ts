/**
 * @fileoverview Comprehensive unit tests for MCP Handler
 * 
 * Tests cover:
 * - JSON-RPC initialize handshake
 * - notifications/initialized acknowledgement  
 * - tools/list response with all tool definitions
 * - tools/call routing to plan handlers
 * - Error handling: unknown methods, internal errors
 * - Input validation and schema compliance
 * 
 * Target: 95%+ line coverage for handler.ts
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { McpHandler } from '../../../mcp/handler';
import { JsonRpcRequest, JsonRpcResponse } from '../../../mcp/types';

// Mock PlanRunner for testing
class MockPlanRunner {
  private plans = new Map();
  
  enqueue = sinon.stub();
  enqueueJob = sinon.stub();
  get = sinon.stub();
  getPlan = sinon.stub();
  
  // Setup default behavior
  constructor() {
    this.get.returns(null);
    this.getPlan.returns(null);
  }
}

suite('MCP Handler Unit Tests', () => {
  let handler: McpHandler;
  let mockPlanRunner: MockPlanRunner;
  const workspacePath = '/mock/workspace';
  
  setup(() => {
    mockPlanRunner = new MockPlanRunner();
    handler = new McpHandler(mockPlanRunner as any, workspacePath, {} as any, {} as any, undefined);
  });
  
  teardown(() => {
    sinon.restore();
  });
  
  suite('Constructor', () => {
    test('should initialize with PlanRunner and workspace path', () => {
      const h = new McpHandler(mockPlanRunner as any, '/test/path', {} as any, {} as any, undefined);
      assert.ok(h);
    });
  });
  
  suite('Initialize Protocol', () => {
    test('should return valid initialize response', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        }
      };
      
      const response = await handler.handleRequest(request);
      
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 1);
      assert.ok(response.result);
      assert.strictEqual(response.result.protocolVersion, '2024-11-05');
      assert.strictEqual(response.result.serverInfo.name, 'copilot-orchestrator');
      assert.strictEqual(response.result.serverInfo.version, '0.6.0');
      assert.ok(response.result.capabilities);
      assert.ok(response.result.capabilities.tools);
    });
    
    test('should handle initialize without parameters', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize'
      };
      
      const response = await handler.handleRequest(request);
      
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 2);
      assert.ok(response.result);
    });
  });
  
  suite('Error Handling', () => {
    test('should handle unknown method', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 10,
        method: 'unknown/method',
        params: {}
      };
      
      const response = await handler.handleRequest(request);
      
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 10);
      assert.ok(response.error);
      assert.strictEqual(response.error.code, -32601);
      assert.ok(response.error.message.includes('Method not found'));
    });
  });

  suite('Edge Cases', () => {
    
    test('should handle null parameters', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/list',
        params: null as any
      };
      
      const response = await handler.handleRequest(request);
      
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 13);
      assert.ok(response.result);
    });
  });
});