/**
 * @fileoverview Unit tests for McpHandler
 *
 * Tests cover:
 * - JSON-RPC initialize handshake
 * - notifications/initialized acknowledgement
 * - tools/list response
 * - tools/call routing to plan handlers
 * - Unknown method error (-32601)
 * - Internal error handling (-32603)
 */

import * as assert from 'assert';
import { McpHandler } from '../../../mcp/handler';
import { JsonRpcRequest } from '../../../mcp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
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

/** Minimal PlanRunner stub that satisfies the constructor. */
function makeMockPlanRunner(overrides?: Record<string, any>): any {
  return {
    enqueue: () => makeMockPlan(),
    enqueueJob: () => makeMockPlan(),
    get: () => undefined,
    getPlan: () => undefined,
    getAll: () => [],
    getStatus: () => undefined,
    getStateMachine: () => undefined,
    getNodeLogs: () => '',
    getNodeAttempt: () => null,
    getNodeAttempts: () => [],
    cancel: () => true,
    delete: () => true,
    retryNode: () => ({ success: true }),
    resume: () => true,
    getNodeFailureContext: () => ({ error: 'not found' }),
    getEffectiveEndedAt: () => undefined,
    ...overrides,
  };
}

/** Minimal PlanInstance for mock returns. */
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
    ...overrides,
  };
}

function makeRequest(method: string, params?: any, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('McpHandler', () => {
  let quiet: { restore: () => void };
  let handler: McpHandler;

  setup(() => {
    quiet = silenceConsole();
    handler = new McpHandler(makeMockPlanRunner(), '/workspace', {} as any);
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // Initialize
  // =========================================================================
  suite('initialize', () => {
    test('returns protocol version and capabilities', async () => {
      const res = await handler.handleRequest(makeRequest('initialize'));
      assert.strictEqual(res.jsonrpc, '2.0');
      assert.strictEqual(res.id, 1);
      assert.ok(res.result);
      assert.strictEqual(res.result.protocolVersion, '2024-11-05');
      assert.deepStrictEqual(res.result.capabilities, { tools: {} });
      assert.strictEqual(res.result.serverInfo.name, 'copilot-orchestrator');
      assert.ok(res.result.serverInfo.version);
    });

    test('echoes request id', async () => {
      const res = await handler.handleRequest(makeRequest('initialize', undefined, 42));
      assert.strictEqual(res.id, 42);
    });
  });

  // =========================================================================
  // notifications/initialized
  // =========================================================================
  suite('notifications/initialized', () => {
    test('returns empty success response', async () => {
      const res = await handler.handleRequest(makeRequest('notifications/initialized'));
      assert.strictEqual(res.jsonrpc, '2.0');
      assert.ok(res.result);
      assert.deepStrictEqual(res.result, {});
    });
  });

  // =========================================================================
  // tools/list
  // =========================================================================
  suite('tools/list', () => {
    test('returns an array of tools', async () => {
      const res = await handler.handleRequest(makeRequest('tools/list'));
      assert.ok(res.result);
      assert.ok(Array.isArray(res.result.tools));
      assert.ok(res.result.tools.length > 0);
    });

    test('each tool has name, description, and inputSchema', async () => {
      const res = await handler.handleRequest(makeRequest('tools/list'));
      for (const tool of res.result.tools) {
        assert.ok(typeof tool.name === 'string', `tool.name should be string`);
        assert.ok(typeof tool.description === 'string', `tool.description should be string`);
        assert.ok(tool.inputSchema, `tool.inputSchema should exist`);
        assert.strictEqual(tool.inputSchema.type, 'object');
      }
    });

    test('includes expected tool names', async () => {
      const res = await handler.handleRequest(makeRequest('tools/list'));
      const names = res.result.tools.map((t: any) => t.name);
      assert.ok(names.includes('create_copilot_plan'));
      assert.ok(names.includes('create_copilot_job'));
      assert.ok(names.includes('get_copilot_plan_status'));
      assert.ok(names.includes('list_copilot_plans'));
      assert.ok(names.includes('cancel_copilot_plan'));
    });
  });

  // =========================================================================
  // tools/call - routing
  // =========================================================================
  suite('tools/call', () => {
    test.skip('routes create_copilot_job and returns content array', async () => {
      const mockPlan = makeMockPlan();
      const mockRunner = makeMockPlanRunner({
        enqueueJob: () => mockPlan,
      });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'create_copilot_job',
        arguments: { 
          name: 'Test Job', 
          task: 'Do something', 
          work: 'echo ok',
          baseBranch: 'main',       // Provide explicit branch to skip git resolution
          targetBranch: 'feature/test',  // Provide explicit branch to skip git resolution
        },
      }));

      assert.ok(res.result);
      assert.ok(Array.isArray(res.result.content));
      assert.strictEqual(res.result.content[0].type, 'text');
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.planId, 'plan-1');
    });

    test('routes list_copilot_plans', async () => {
      const mockRunner = makeMockPlanRunner({ getAll: () => [] });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.count, 0);
    });

    test('returns error for unknown tool', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      }));

      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('Unknown tool'));
    });

    test('routes cancel_copilot_plan', async () => {
      const mockRunner = makeMockPlanRunner({ cancel: () => true });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'cancel_copilot_plan',
        arguments: { id: 'plan-1' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
    });

    test('routes delete_copilot_plan', async () => {
      const mockRunner = makeMockPlanRunner({ delete: () => true });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'delete_copilot_plan',
        arguments: { id: 'plan-1' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
    });

    test('handles missing arguments gracefully', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_plan_status',
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
    });
  });

  // =========================================================================
  // Unknown method
  // =========================================================================
  suite('unknown method', () => {
    test('returns -32601 error', async () => {
      const res = await handler.handleRequest(makeRequest('foo/bar'));
      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32601);
      assert.ok(res.error.message.includes('Method not found'));
    });
  });

  // =========================================================================
  // Internal error handling
  // =========================================================================
  suite('error handling', () => {
    test('returns -32603 on thrown error', async () => {
      const mockRunner = makeMockPlanRunner({
        getAll: () => { throw new Error('boom'); },
      });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'list_copilot_plans',
        arguments: {},
      }));

      assert.ok(res.error);
      assert.strictEqual(res.error.code, -32603);
      assert.ok(res.error.message.includes('boom'));
    });

    test('JSON-RPC response always has jsonrpc 2.0 field', async () => {
      const res = await handler.handleRequest(makeRequest('unknown'));
      assert.strictEqual(res.jsonrpc, '2.0');
    });
  });

  // =========================================================================
  // tools/call - get_copilot_plan_status
  // =========================================================================
  suite('tools/call - get_copilot_plan_status', () => {
    test('returns error when plan not found', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_plan_status',
        arguments: { id: 'nonexistent' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('not found'));
    });

    test('returns plan status when found', async () => {
      const mockPlan = makeMockPlan();
      const mockRunner = makeMockPlanRunner({
        getStatus: (id: string) => id === 'plan-1' ? {
          plan: mockPlan,
          status: 'running',
          counts: { pending: 0, ready: 0, running: 1, succeeded: 0, failed: 0 },
          progress: 0.5,
        } : undefined,
        getEffectiveEndedAt: () => undefined,
      });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_plan_status',
        arguments: { id: 'plan-1' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.planId, 'plan-1');
      assert.strictEqual(parsed.status, 'running');
      assert.strictEqual(parsed.progress, 50);
    });
  });

  // =========================================================================
  // tools/call - get_copilot_node_details
  // =========================================================================
  suite('tools/call - get_copilot_node_details', () => {
    test('returns error when required fields missing', async () => {
      const res = await handler.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_node_details',
        arguments: { planId: 'plan-1' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, false);
      assert.ok(parsed.error.includes('nodeId'));
    });

    test('returns node details when found', async () => {
      const node = {
        id: 'node-1',
        producerId: 'build',
        name: 'Build',
        type: 'job',
        task: 'Build the app',
        dependencies: [],
        dependents: [],
      };
      const nodeState = {
        status: 'succeeded',
        attempts: 1,
        startedAt: 1000,
        endedAt: 2000,
      };
      const mockPlan = makeMockPlan({
        nodes: new Map([['node-1', node]]),
        nodeStates: new Map([['node-1', nodeState]]),
        producerIdToNodeId: new Map([['build', 'node-1']]),
      });
      const mockRunner = makeMockPlanRunner({
        get: (id: string) => id === 'plan-1' ? mockPlan : undefined,
      });
      const h = new McpHandler(mockRunner, '/workspace', {} as any);

      const res = await h.handleRequest(makeRequest('tools/call', {
        name: 'get_copilot_node_details',
        arguments: { planId: 'plan-1', nodeId: 'node-1' },
      }));

      const parsed = JSON.parse(res.result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.node.id, 'node-1');
      assert.strictEqual(parsed.node.producerId, 'build');
      assert.strictEqual(parsed.state.status, 'succeeded');
    });
  });
});
