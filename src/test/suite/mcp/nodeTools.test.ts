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
    test('returns a non-empty array', () => {
      const tools = getNodeToolDefinitions();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
    });

    test('all tools have required fields', () => {
      const tools = getNodeToolDefinitions();
      for (const tool of tools) {
        assert.ok(tool.name, `Tool missing name`);
        assert.ok(tool.description, `Tool ${tool.name} missing description`);
        assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assert.strictEqual(tool.inputSchema.type, 'object', `Tool ${tool.name} schema must be object`);
      }
    });

    test('all tool names are unique', () => {
      const tools = getNodeToolDefinitions();
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
      'create_copilot_node',
      'get_copilot_node',
      'list_copilot_nodes',
      'retry_copilot_node',
      'get_copilot_node_failure_context',
    ];

    for (const toolName of expectedTools) {
      test(`includes ${toolName}`, () => {
        const tools = getNodeToolDefinitions();
        const found = tools.find(t => t.name === toolName);
        assert.ok(found, `Expected tool ${toolName} not found`);
      });
    }
  });

  // =========================================================================
  // create_copilot_node SCHEMA
  // =========================================================================
  suite('create_copilot_node schema', () => {
    test('requires nodes array', () => {
      const tools = getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'create_copilot_node')!;
      assert.ok(tool.inputSchema.required?.includes('nodes'));
    });

    test('nodes items require producer_id, task, dependencies', () => {
      const tools = getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'create_copilot_node')!;
      const nodesSchema = tool.inputSchema.properties?.nodes as any;
      assert.ok(nodesSchema);
      assert.ok(nodesSchema.items?.required?.includes('producer_id'));
      assert.ok(nodesSchema.items?.required?.includes('task'));
      assert.ok(nodesSchema.items?.required?.includes('dependencies'));
    });

    test('has optional group property on nodes', () => {
      const tools = getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'create_copilot_node')!;
      const nodesSchema = tool.inputSchema.properties?.nodes as any;
      // group is optional per-node for visual grouping in Mermaid
      assert.ok(nodesSchema.items?.properties?.group);
      // group is NOT in required
      assert.ok(!nodesSchema.items?.required?.includes('group'));
    });
  });

  // =========================================================================
  // get_copilot_node SCHEMA
  // =========================================================================
  suite('get_copilot_node schema', () => {
    test('requires node_id', () => {
      const tools = getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'get_copilot_node')!;
      assert.ok(tool.inputSchema.required?.includes('node_id'));
    });
  });

  // =========================================================================
  // list_copilot_nodes SCHEMA
  // =========================================================================
  suite('list_copilot_nodes schema', () => {
    test('has optional filters', () => {
      const tools = getNodeToolDefinitions();
      const tool = tools.find(t => t.name === 'list_copilot_nodes')!;
      assert.ok(tool.inputSchema.properties?.group_id);
      assert.ok(tool.inputSchema.properties?.status);
      assert.ok(tool.inputSchema.properties?.group_name);
      // None required
      assert.ok(!tool.inputSchema.required || tool.inputSchema.required.length === 0);
    });
  });

  // =========================================================================
  // getAllToolDefinitions AGGREGATION
  // =========================================================================
  suite('getAllToolDefinitions', () => {
    test('includes both plan and node tools', () => {
      const all = getAllToolDefinitions();
      const planTools = getPlanToolDefinitions();
      const nodeTools = getNodeToolDefinitions();

      assert.strictEqual(all.length, planTools.length + nodeTools.length);
    });

    test('no duplicate tool names across plan and node tools', () => {
      const all = getAllToolDefinitions();
      const names = all.map(t => t.name);
      const unique = new Set(names);
      assert.strictEqual(unique.size, names.length, 'Duplicate tool names found across modules');
    });
  });
});
