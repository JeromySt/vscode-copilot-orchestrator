/**
 * @fileoverview Unit tests for MCP node tool definitions
 *
 * Tests cover:
 * - getNodeToolDefinitions returns valid tool array
 * - Tool schema structure validation
 * - getAllToolDefinitions includes both plan and node tools
 * - All new tools have required fields
 */

import * as assert from 'assert';
import { getNodeToolDefinitions } from '../../../mcp/tools/nodeTools';
import { getPlanToolDefinitions } from '../../../mcp/tools/planTools';
import { getAllToolDefinitions } from '../../../mcp/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

suite('MCP Node Tool Definitions', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // TOOL ARRAY
  // =========================================================================
  suite('getNodeToolDefinitions', () => {
    test('returns a non-empty array', async () => {
      const tools = await getNodeToolDefinitions();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
    });

    test('all tools have required fields', async () => {
      const tools = await getNodeToolDefinitions();
      for (const tool of tools) {
        assert.ok(tool.name, `Tool missing name`);
        assert.ok(tool.description, `Tool ${tool.name} missing description`);
        assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assert.strictEqual(tool.inputSchema.type, 'object', `Tool ${tool.name} schema must be object`);
      }
    });

    test('all tool names are unique', async () => {
      const tools = await getNodeToolDefinitions();
      const names = tools.map(t => t.name);
      const unique = new Set(names);
      assert.strictEqual(unique.size, names.length, 'Duplicate tool names found');
    });
  });

  // =========================================================================
  // SPECIFIC TOOLS
  // =========================================================================
  suite('Tool existence', () => {
    const expectedTools = [
      'get_copilot_node',
      'list_copilot_nodes',
      'retry_copilot_node',
      'get_copilot_node_failure_context',
    ];

    for (const toolName of expectedTools) {
      test(`includes ${toolName}`, async () => {
        const tools = await getNodeToolDefinitions();
        const found = tools.find(t => t.name === toolName);
        assert.ok(found, `Expected tool ${toolName} not found`);
      });
    }
  });

  // =========================================================================
  // get_copilot_node SCHEMA
  // =========================================================================
  suite('get_copilot_node schema', () => {
    test('requires node_id', async () => {
      const tools = await getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'get_copilot_node')!;
      assert.ok(tool.inputSchema.required?.includes('node_id'));
    });
  });

  // =========================================================================
  // list_copilot_nodes SCHEMA
  // =========================================================================
  suite('list_copilot_nodes schema', () => {
    test('has optional filters', async () => {
      const tools = await getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'list_copilot_nodes')!;
      assert.ok(tool.inputSchema.properties?.group_id);
      assert.ok(tool.inputSchema.properties?.status);
      assert.ok(tool.inputSchema.properties?.group_name);
      // None required
      assert.ok(!tool.inputSchema.required || tool.inputSchema.required.length === 0);
    });
  });

  // =========================================================================
  // update_copilot_plan_node SCHEMA
  // =========================================================================
  suite('update_copilot_plan_node schema', () => {
    test('is included in node tools', async () => {
      const tools = await getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'update_copilot_plan_node');
      assert.ok(tool, 'update_copilot_plan_node tool should be included');
    });

    test('requires planId and nodeId', async () => {
      const tools = await getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'update_copilot_plan_node')!;
      assert.ok(tool.inputSchema.required?.includes('planId'));
      assert.ok(tool.inputSchema.required?.includes('nodeId'));
    });

    test('has optional stage properties', async () => {
      const tools = await getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'update_copilot_plan_node')!;
      const properties = tool.inputSchema.properties as any;
      assert.ok(properties.prechecks, 'should have prechecks property');
      assert.ok(properties.work, 'should have work property');
      assert.ok(properties.postchecks, 'should have postchecks property');
      
      // These should not be required since at least one must be provided
      assert.ok(!tool.inputSchema.required?.includes('prechecks'));
      assert.ok(!tool.inputSchema.required?.includes('work'));
      assert.ok(!tool.inputSchema.required?.includes('postchecks'));
    });

    test('has resetToStage enum property', async () => {
      const tools = await getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'update_copilot_plan_node')!;
      const properties = tool.inputSchema.properties as any;
      assert.ok(properties.resetToStage, 'should have resetToStage property');
      assert.strictEqual(properties.resetToStage.type, 'string');
      assert.deepStrictEqual(properties.resetToStage.enum, ['prechecks', 'work', 'postchecks']);
    });
  });

  // =========================================================================
  // getAllToolDefinitions AGGREGATION
  // =========================================================================
  suite('getAllToolDefinitions', () => {
    test('includes both plan and node tools', async () => {
      const all = await getAllToolDefinitions();
      const planTools = await getPlanToolDefinitions();
      const nodeTools = await getNodeToolDefinitions();

      assert.strictEqual(all.length, planTools.length + nodeTools.length);
    });

    test('no duplicate tool names across plan and node tools', async () => {
      const all = await getAllToolDefinitions();
      const names = all.map(t => t.name);
      const unique = new Set(names);
      assert.strictEqual(unique.size, names.length, 'Duplicate tool names found across modules');
    });
  });
});
