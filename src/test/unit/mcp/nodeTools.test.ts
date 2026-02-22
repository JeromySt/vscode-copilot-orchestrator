/**
 * @fileoverview Unit tests for MCP job tool definitions
 *
 * Tests cover:
 * - getJobToolDefinitions returns valid tool array
 * - Tool schema structure validation
 * - getAllToolDefinitions includes both plan and job tools
 * - All new tools have required fields
 */

import * as assert from 'assert';
import { getJobToolDefinitions } from '../../../mcp/tools/jobTools';
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

suite('MCP Job Tool Definitions', () => {
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
  suite('getJobToolDefinitions', () => {
    test('returns a non-empty array', async () => {
      const tools = await getJobToolDefinitions();
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
    });

    test('all tools have required fields', async () => {
      const tools = await getJobToolDefinitions();
      for (const tool of tools) {
        assert.ok(tool.name, `Tool missing name`);
        assert.ok(tool.description, `Tool ${tool.name} missing description`);
        assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assert.strictEqual(tool.inputSchema.type, 'object', `Tool ${tool.name} schema must be object`);
      }
    });

    test('all tool names are unique', async () => {
      const tools = await getJobToolDefinitions();
      const names = tools.map((t: any) => t.name);
      const unique = new Set(names);
      assert.strictEqual(unique.size, names.length, 'Duplicate tool names found');
    });
  });

  // =========================================================================
  // SPECIFIC TOOLS
  // =========================================================================
  suite('Tool existence', () => {
    const expectedTools = [
      'get_copilot_job',
      'list_copilot_jobs',
      'retry_copilot_job',
      'get_copilot_job_failure_context',
    ];

    for (const toolName of expectedTools) {
      test(`includes ${toolName}`, async () => {
        const tools = await getJobToolDefinitions();
        const found = tools.find((t: any) => t.name === toolName);
        assert.ok(found, `Expected tool ${toolName} not found`);
      });
    }
  });

  // =========================================================================
  // get_copilot_job SCHEMA
  // =========================================================================
  suite('get_copilot_job schema', () => {
    test('requires jobId', async () => {
      const tools = await getJobToolDefinitions();
      const tool = tools.find((t: any) => t.name === 'get_copilot_job')!;
      assert.ok(tool.inputSchema.required?.includes('jobId'));
    });
  });

  // =========================================================================
  // list_copilot_jobs SCHEMA
  // =========================================================================
  suite('list_copilot_jobs schema', () => {
    test('has optional filters', async () => {
      const tools = await getJobToolDefinitions();
      const tool = tools.find((t: any) => t.name === 'list_copilot_jobs')!;
      assert.ok(tool.inputSchema.properties?.groupId || tool.inputSchema.properties?.group_id);
      assert.ok(tool.inputSchema.properties?.status);
      assert.ok(tool.inputSchema.properties?.groupName || tool.inputSchema.properties?.group_name);
      // planId is required
      assert.ok(tool.inputSchema.required?.includes('planId'));
    });
  });

  // =========================================================================
  // update_copilot_plan_job SCHEMA
  // =========================================================================
  suite('update_copilot_plan_job schema', () => {
    test('is included in job tools', async () => {
      const tools = await getJobToolDefinitions();
      const tool = tools.find((t: any) => t.name === 'update_copilot_plan_job');
      assert.ok(tool, 'update_copilot_plan_job tool should be included');
    });

    test('requires planId and jobId', async () => {
      const tools = await getJobToolDefinitions();
      const tool = tools.find((t: any) => t.name === 'update_copilot_plan_job')!;
      assert.ok(tool.inputSchema.required?.includes('planId'));
      assert.ok(tool.inputSchema.required?.includes('jobId'));
    });

    test('has optional stage properties', async () => {
      const tools = await getJobToolDefinitions();
      const tool = tools.find((t: any) => t.name === 'update_copilot_plan_job')!;
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
      const tools = await getJobToolDefinitions();
      const tool = tools.find((t: any) => t.name === 'update_copilot_plan_job')!;
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
    test('includes both plan and job tools', async () => {
      const all = await getAllToolDefinitions();
      const planTools = await getPlanToolDefinitions();
      const jobTools = await getJobToolDefinitions();

      assert.strictEqual(all.length, planTools.length + jobTools.length);
    });

    test('no duplicate tool names across plan and job tools', async () => {
      const all = await getAllToolDefinitions();
      const names = all.map((t: any) => t.name);
      const unique = new Set(names);
      assert.strictEqual(unique.size, names.length, 'Duplicate tool names found across modules');
    });
  });
});
