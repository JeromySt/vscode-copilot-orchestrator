/**
 * @fileoverview Comprehensive unit tests for MCP Plan Tools
 * 
 * Tests cover:
 * - Tool definition structure and schemas
 * - Input schema validation  
 * - All plan tool definitions exported correctly
 * - Tool metadata (name, description, inputSchema)
 * - Schema validation for edge cases
 * 
 * Target: 95%+ line coverage for tools/planTools.ts
 */

import { suite, test, setup } from 'mocha';
import * as assert from 'assert';
import { 
  getPlanToolDefinitions
} from '../../../mcp/tools/planTools';
import { McpTool } from '../../../mcp/types';

suite('MCP Plan Tools Unit Tests', () => {
  let planTools: McpTool[];
  
  setup(async () => {
    planTools = await getPlanToolDefinitions();
  });
  
  suite('getPlanToolDefinitions', () => {
    test('should return array of tool definitions', () => {
      assert.ok(Array.isArray(planTools));
      assert.ok(planTools.length > 0);
    });
    
    test('should have valid tool structure', () => {
      planTools.forEach(tool => {
        assert.ok(tool.name);
        assert.ok(tool.description);
        assert.ok(tool.inputSchema);
        assert.strictEqual(typeof tool.name, 'string');
        assert.strictEqual(typeof tool.description, 'string');
        assert.strictEqual(typeof tool.inputSchema, 'object');
      });
    });
  });
  
  suite('getAllToolDefinitions', () => {
    test('should include plan tools', async () => {
      const { getAllToolDefinitions } = await import('../../../mcp/tools');
      const allTools = await getAllToolDefinitions();
      const allToolNames = allTools.map(tool => tool.name);
      const planToolNames = planTools.map(tool => tool.name);
      
      planToolNames.forEach(planToolName => {
        assert.ok(allToolNames.includes(planToolName));
      });
    });
  
  suite('create_copilot_plan tool', () => {
    let createPlanTool: McpTool;
    
    setup(() => {
      createPlanTool = planTools.find(tool => tool.name === 'create_copilot_plan')!;
      assert.ok(createPlanTool, 'create_copilot_plan tool should exist');
    });
    
    test('should have correct basic structure', () => {
      assert.strictEqual(createPlanTool.name, 'create_copilot_plan');
      assert.ok(createPlanTool.description);
      assert.ok(createPlanTool.inputSchema);
    });
    
    test('should have valid JSON schema', () => {
      const schema = createPlanTool.inputSchema;
      
      assert.strictEqual(schema.type, 'object');
      assert.ok(schema.properties);
      assert.ok(schema.required);
      assert.ok(Array.isArray(schema.required));
    });
    
    test('should require name field', () => {
      const schema = createPlanTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('name'));
      assert.ok(schema.properties.name);
      assert.strictEqual(schema.properties.name.type, 'string');
    });
    
    test('should have jobs array property', () => {
      const schema = createPlanTool.inputSchema;
      
      assert.ok(schema.properties.jobs);
      assert.strictEqual(schema.properties.jobs.type, 'array');
      assert.ok(schema.properties.jobs.items);
    });
    
    test('should have optional properties', () => {
      const schema = createPlanTool.inputSchema;
      
      // Optional plan-level properties
      assert.ok(schema.properties.baseBranch);
      assert.ok(schema.properties.targetBranch);
      assert.ok(schema.properties.maxParallel);
      assert.ok(schema.properties.startPaused);
      assert.ok(schema.properties.cleanUpSuccessfulWork);
    });
  });
  });

  suite('Schema validation', () => {
    
    test('tool names should follow naming convention', () => {
      planTools.forEach(tool => {
        // Most tools follow copilot_ prefix convention
        if (tool.name.includes('copilot')) {
          assert.ok(tool.name.includes('copilot_') || tool.name.includes('_copilot_'));
        }
        
        // Should use snake_case
        assert.ok(tool.name.match(/^[a-z][a-z0-9_]*$/), 
          `Tool name ${tool.name} should be snake_case`);
      });
    });
    
    test('descriptions should be non-empty', () => {
      planTools.forEach(tool => {
        assert.ok(tool.description);
        assert.ok(tool.description.trim().length > 0);
        assert.ok(tool.description.length > 10, 
          `Tool ${tool.name} description should be meaningful`);
      });
    });
  });
  
  suite('Edge cases', () => {
    test('should handle tools array mutations safely', async () => {
      const tools1 = await getPlanToolDefinitions();
      const tools2 = await getPlanToolDefinitions();
      
      // Modifying one array should not affect the other
      tools1.push({} as any);
      assert.notStrictEqual(tools1.length, tools2.length);
    });
    
    test('should handle schema property mutations safely', async () => {
      const tools1 = await getPlanToolDefinitions();
      const tools2 = await getPlanToolDefinitions();
      
      const firstTool1 = tools1[0];
      const firstTool2 = tools2[0];
      
      if (firstTool1 && firstTool2) {
        // Modifying schema should not affect other instances
        (firstTool1.inputSchema as any).additionalProperty = 'test';
        assert.ok(!(firstTool2.inputSchema as any).additionalProperty);
      }
    });
  });
});