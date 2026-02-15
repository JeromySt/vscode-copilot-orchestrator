/**
 * @fileoverview Comprehensive tests for MCP tool definitions
 * Covers planTools.ts and nodeTools.ts to reach 95%+ coverage.
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as modelDiscovery from '../../../agent/modelDiscovery';

suite('MCP Tool Definitions', () => {
  let discoverStub: sinon.SinonStub;

  setup(() => {
    discoverStub = sinon.stub(modelDiscovery, 'discoverAvailableModels').resolves({
      models: [{ id: 'gpt-5', vendor: 'openai', family: 'gpt-5', tier: 'standard' }],
      rawChoices: ['gpt-5', 'claude-sonnet-4.5'],
      discoveredAt: Date.now(),
    });
  });

  teardown(() => {
    sinon.restore();
  });

  suite('getPlanToolDefinitions', () => {
    test('should return array of plan tool definitions', async () => {
      const { getPlanToolDefinitions } = require('../../../mcp/tools/planTools');
      const tools = await getPlanToolDefinitions();

      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
      const names = tools.map((t: any) => t.name);
      assert.ok(names.includes('create_copilot_plan'));
      assert.ok(names.includes('create_copilot_job'));
      assert.ok(names.includes('get_copilot_plan_status'));
      assert.ok(names.includes('list_copilot_plans'));
      assert.ok(names.includes('get_copilot_node_details'));
      assert.ok(names.includes('get_copilot_node_logs'));
      assert.ok(names.includes('get_copilot_node_attempts'));
      assert.ok(names.includes('cancel_copilot_plan'));
      assert.ok(names.includes('pause_copilot_plan'));
      assert.ok(names.includes('resume_copilot_plan'));
      assert.ok(names.includes('delete_copilot_plan'));
      assert.ok(names.includes('retry_copilot_plan'));
      assert.ok(names.includes('get_copilot_plan_node_failure_context'));
      assert.ok(names.includes('retry_copilot_plan_node'));
    });

    test('each tool has required fields', async () => {
      const { getPlanToolDefinitions } = require('../../../mcp/tools/planTools');
      const tools = await getPlanToolDefinitions();

      for (const tool of tools) {
        assert.ok(tool.name, `Tool missing name`);
        assert.ok(tool.description, `Tool ${tool.name} missing description`);
        assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assert.strictEqual(tool.inputSchema.type, 'object');
        assert.ok(tool.inputSchema.properties);
      }
    });

    test('should use fallback models when discovery returns empty', async () => {
      discoverStub.resolves({ models: [], rawChoices: [], discoveredAt: Date.now() });
      const { getPlanToolDefinitions } = require('../../../mcp/tools/planTools');
      const tools = await getPlanToolDefinitions();
      assert.ok(tools.length > 0);
    });

    test('PRODUCER_ID_PATTERN matches valid ids', () => {
      const { PRODUCER_ID_PATTERN } = require('../../../mcp/tools/planTools');
      assert.ok(PRODUCER_ID_PATTERN.test('build-step'));
      assert.ok(PRODUCER_ID_PATTERN.test('abc'));
      assert.ok(PRODUCER_ID_PATTERN.test('test-123-node'));
      assert.ok(!PRODUCER_ID_PATTERN.test('AB'));
      assert.ok(!PRODUCER_ID_PATTERN.test('a'));
      assert.ok(!PRODUCER_ID_PATTERN.test('UPPERCASE'));
      assert.ok(!PRODUCER_ID_PATTERN.test('has spaces'));
    });
  });

  suite('getNodeToolDefinitions', () => {
    test('should return array of node tool definitions', async () => {
      const { getNodeToolDefinitions } = require('../../../mcp/tools/nodeTools');
      const tools = await getNodeToolDefinitions();

      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
      const names = tools.map((t: any) => t.name);
      assert.ok(names.includes('create_copilot_node'));
      assert.ok(names.includes('get_copilot_node'));
      assert.ok(names.includes('list_copilot_nodes'));
      assert.ok(names.includes('retry_copilot_node'));
      assert.ok(names.includes('force_fail_copilot_node'));
      assert.ok(names.includes('get_copilot_node_failure_context'));
      assert.ok(names.includes('update_copilot_plan_node'));
    });

    test('each tool has required fields', async () => {
      const { getNodeToolDefinitions } = require('../../../mcp/tools/nodeTools');
      const tools = await getNodeToolDefinitions();

      for (const tool of tools) {
        assert.ok(tool.name, `Tool missing name`);
        assert.ok(tool.description, `Tool ${tool.name} missing description`);
        assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assert.strictEqual(tool.inputSchema.type, 'object');
      }
    });

    test('should use fallback models when discovery returns empty', async () => {
      discoverStub.resolves({ models: [], rawChoices: [], discoveredAt: Date.now() });
      const { getNodeToolDefinitions } = require('../../../mcp/tools/nodeTools');
      const tools = await getNodeToolDefinitions();
      assert.ok(tools.length > 0);
    });
  });

  suite('getAllToolDefinitions', () => {
    test('should combine plan and node tools', async () => {
      const { getAllToolDefinitions } = require('../../../mcp/tools');
      const tools = await getAllToolDefinitions();
      assert.ok(Array.isArray(tools));
      // Should have both plan and node tools
      const names = tools.map((t: any) => t.name);
      assert.ok(names.includes('create_copilot_plan'));
      assert.ok(names.includes('create_copilot_node'));
    });
  });
});
