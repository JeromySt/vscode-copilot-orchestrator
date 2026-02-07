/**
 * @fileoverview Unit tests for MCP plan tool definitions
 *
 * Tests cover:
 * - getPlanToolDefinitions returns valid tool array
 * - PRODUCER_ID_PATTERN regex validation
 * - Tool schema structure validation
 * - getAllToolDefinitions aggregation
 */

import * as assert from 'assert';
import { getPlanToolDefinitions, PRODUCER_ID_PATTERN } from '../../../mcp/tools/planTools';
import { getAllToolDefinitions } from '../../../mcp/tools';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('MCP Plan Tool Definitions', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // PRODUCER_ID_PATTERN
  // =========================================================================
  suite('PRODUCER_ID_PATTERN', () => {
    test('accepts valid lowercase producer_id', () => {
      assert.ok(PRODUCER_ID_PATTERN.test('build'));
      assert.ok(PRODUCER_ID_PATTERN.test('build-step'));
      assert.ok(PRODUCER_ID_PATTERN.test('my-job-123'));
      assert.ok(PRODUCER_ID_PATTERN.test('abc'));
    });

    test('rejects uppercase characters', () => {
      assert.strictEqual(PRODUCER_ID_PATTERN.test('Build'), false);
      assert.strictEqual(PRODUCER_ID_PATTERN.test('BUILD'), false);
    });

    test('rejects too short (< 3 chars)', () => {
      assert.strictEqual(PRODUCER_ID_PATTERN.test('ab'), false);
      assert.strictEqual(PRODUCER_ID_PATTERN.test('a'), false);
    });

    test('rejects special characters', () => {
      assert.strictEqual(PRODUCER_ID_PATTERN.test('build_step'), false);
      assert.strictEqual(PRODUCER_ID_PATTERN.test('build.step'), false);
      assert.strictEqual(PRODUCER_ID_PATTERN.test('build step'), false);
    });

    test('accepts exactly 3 characters', () => {
      assert.ok(PRODUCER_ID_PATTERN.test('abc'));
    });

    test('accepts hyphens and numbers', () => {
      assert.ok(PRODUCER_ID_PATTERN.test('a-1'));
      assert.ok(PRODUCER_ID_PATTERN.test('123'));
      assert.ok(PRODUCER_ID_PATTERN.test('a-b-c'));
    });

    test('rejects empty string', () => {
      assert.strictEqual(PRODUCER_ID_PATTERN.test(''), false);
    });
  });

  // =========================================================================
  // getPlanToolDefinitions
  // =========================================================================
  suite('getPlanToolDefinitions', () => {
    test('returns a non-empty array', () => {
      const tools = getPlanToolDefinitions();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
    });

    test('all tools have required McpTool fields', () => {
      const tools = getPlanToolDefinitions();
      for (const tool of tools) {
        assert.ok(typeof tool.name === 'string', `Tool name should be string: ${tool.name}`);
        assert.ok(tool.name.length > 0, 'Tool name should be non-empty');
        assert.ok(typeof tool.description === 'string', `Tool description should be string: ${tool.name}`);
        assert.ok(tool.description.length > 0, `Tool description should be non-empty: ${tool.name}`);
        assert.ok(tool.inputSchema, `Tool inputSchema should exist: ${tool.name}`);
        assert.strictEqual(tool.inputSchema.type, 'object', `Tool inputSchema type should be object: ${tool.name}`);
        assert.ok(typeof tool.inputSchema.properties === 'object', `Tool inputSchema.properties should be object: ${tool.name}`);
      }
    });

    test('tool names are unique', () => {
      const tools = getPlanToolDefinitions();
      const names = tools.map(t => t.name);
      const uniqueNames = new Set(names);
      assert.strictEqual(names.length, uniqueNames.size, 'Tool names should be unique');
    });

    test('contains creation tools', () => {
      const tools = getPlanToolDefinitions();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('create_copilot_plan'));
      assert.ok(names.includes('create_copilot_job'));
    });

    test('contains status/query tools', () => {
      const tools = getPlanToolDefinitions();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('get_copilot_plan_status'));
      assert.ok(names.includes('list_copilot_plans'));
      assert.ok(names.includes('get_copilot_node_details'));
      assert.ok(names.includes('get_copilot_node_logs'));
      assert.ok(names.includes('get_copilot_node_attempts'));
    });

    test('contains control tools', () => {
      const tools = getPlanToolDefinitions();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('cancel_copilot_plan'));
      assert.ok(names.includes('delete_copilot_plan'));
      assert.ok(names.includes('retry_copilot_plan'));
      assert.ok(names.includes('retry_copilot_plan_node'));
      assert.ok(names.includes('get_copilot_plan_node_failure_context'));
    });

    test('create_copilot_plan requires name and jobs', () => {
      const tools = getPlanToolDefinitions();
      const createPlan = tools.find(t => t.name === 'create_copilot_plan')!;
      assert.ok(createPlan.inputSchema.required);
      assert.ok(createPlan.inputSchema.required.includes('name'));
      assert.ok(createPlan.inputSchema.required.includes('jobs'));
    });

    test('create_copilot_job requires name and task', () => {
      const tools = getPlanToolDefinitions();
      const createJob = tools.find(t => t.name === 'create_copilot_job')!;
      assert.ok(createJob.inputSchema.required);
      assert.ok(createJob.inputSchema.required.includes('name'));
      assert.ok(createJob.inputSchema.required.includes('task'));
    });

    test('get_copilot_plan_status requires id', () => {
      const tools = getPlanToolDefinitions();
      const tool = tools.find(t => t.name === 'get_copilot_plan_status')!;
      assert.ok(tool.inputSchema.required);
      assert.ok(tool.inputSchema.required.includes('id'));
    });
  });

  // =========================================================================
  // getAllToolDefinitions
  // =========================================================================
  suite('getAllToolDefinitions', () => {
    test('returns same tools as getPlanToolDefinitions', () => {
      const all = getAllToolDefinitions();
      const plan = getPlanToolDefinitions();
      assert.strictEqual(all.length, plan.length);
      for (let i = 0; i < all.length; i++) {
        assert.strictEqual(all[i].name, plan[i].name);
      }
    });
  });
});
