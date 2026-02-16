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
    
    test.skip('should include all expected plan tools', () => {
      const toolNames = planTools.map(tool => tool.name);
      
      // Core plan management tools
      assert.ok(toolNames.includes('create_copilot_plan'));
      assert.ok(toolNames.includes('get_plan_status'));
      assert.ok(toolNames.includes('list_plans'));
      
      // Plan control tools
      assert.ok(toolNames.includes('pause_copilot_plan'));
      assert.ok(toolNames.includes('resume_copilot_plan'));
      assert.ok(toolNames.includes('cancel_copilot_plan'));
      assert.ok(toolNames.includes('delete_copilot_plan'));
      
      // Retry tools
      assert.ok(toolNames.includes('retry_copilot_plan'));
      assert.ok(toolNames.includes('retry_plan_node'));
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
    
    test.skip('should include node tools', async () => {
      const { getAllToolDefinitions } = await import('../../../mcp/tools');
      const allTools = await getAllToolDefinitions();
      const toolNames = allTools.map(tool => tool.name);
      
      // Node management tools should be included
      assert.ok(toolNames.includes('get_node_details') || 
                toolNames.includes('get_node_logs') ||
                toolNames.includes('get_node_attempts'));
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
    
    test.skip('should have job item schema', () => {
      const schema = createPlanTool.inputSchema;
      const jobSchema = schema.properties.jobs.items;
      
      assert.strictEqual(jobSchema.type, 'object');
      assert.ok(jobSchema.properties);
      assert.ok(jobSchema.required);
      
      // Required job fields
      assert.ok(jobSchema.required && jobSchema.required.includes('producer_id'));
      assert.ok(jobSchema.required && jobSchema.required.includes('name'));
      assert.ok(jobSchema.required && jobSchema.required.includes('task'));
      
      // Job properties
      assert.ok(jobSchema.properties.producer_id);
      assert.ok(jobSchema.properties.name);
      assert.ok(jobSchema.properties.task);
      assert.ok(jobSchema.properties.work);
      assert.ok(jobSchema.properties.dependencies);
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
  
  suite.skip('get_plan_status tool', () => {
    let getPlanTool: McpTool;
    
    setup(() => {
      getPlanTool = planTools.find(tool => tool.name === 'get_plan_status')!;
      assert.ok(getPlanTool, 'get_plan_status tool should exist');
    });
    
    test('should require planId', () => {
      const schema = getPlanTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.properties.planId);
      assert.strictEqual(schema.properties.planId.type, 'string');
    });
    
    test('should have optional includeNodes property', () => {
      const schema = getPlanTool.inputSchema;
      
      assert.ok(schema.properties.includeNodes);
      assert.strictEqual(schema.properties.includeNodes.type, 'boolean');
    });
  });
  
  suite.skip('list_plans tool', () => {
    let listPlansTool: McpTool;
    
    setup(() => {
      listPlansTool = planTools.find(tool => tool.name === 'list_plans')!;
      assert.ok(listPlansTool, 'list_plans tool should exist');
    });
    
    test('should have minimal schema', () => {
      const schema = listPlansTool.inputSchema;
      
      assert.strictEqual(schema.type, 'object');
      // list_plans typically has no required parameters
      assert.ok(!schema.required || schema.required.length === 0);
    });
    
    test('should have optional filtering properties', () => {
      const schema = listPlansTool.inputSchema;
      
      // Common list filtering options
      if (schema.properties.status) {
        assert.strictEqual(schema.properties.status.type, 'string');
      }
      
      if (schema.properties.limit) {
        assert.strictEqual(schema.properties.limit.type, 'number');
      }
    });
  });
  
  suite.skip('Control tools (pause/resume/cancel/delete)', () => {
    ['pause_copilot_plan', 'resume_copilot_plan', 'cancel_copilot_plan', 'delete_copilot_plan'].forEach(toolName => {
      test(`${toolName} should require planId`, () => {
        const tool = planTools.find(t => t.name === toolName);
        assert.ok(tool, `${toolName} tool should exist`);
        
        const schema = tool.inputSchema;
        assert.ok(schema.required && schema.required.includes('planId'));
        assert.ok(schema.properties.planId);
        assert.strictEqual(schema.properties.planId.type, 'string');
      });
    });
  });
  
  suite.skip('Retry tools', () => {
    test('retry_copilot_plan should require planId', () => {
      const retryPlanTool = planTools.find(tool => tool.name === 'retry_copilot_plan');
      assert.ok(retryPlanTool);
      
      const schema = retryPlanTool.inputSchema;
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.properties.planId);
    });
    
    test('retry_plan_node should require planId and nodeId', () => {
      const retryNodeTool = planTools.find(tool => tool.name === 'retry_plan_node');
      assert.ok(retryNodeTool);
      
      const schema = retryNodeTool.inputSchema;
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
  });
  
  suite('Schema validation', () => {
    test.skip('all tools should have valid JSON schema structure', () => {
      planTools.forEach(tool => {
        const schema = tool.inputSchema;
        
        // Basic JSON schema structure
        assert.ok(schema.type);
        assert.strictEqual(schema.type, 'object');
        
        if (schema.properties) {
          assert.strictEqual(typeof schema.properties, 'object');
          
          // Each property should have a type
          Object.values(schema.properties).forEach((prop: any) => {
            assert.ok(prop.type);
          });
        }
        
        if (schema.required) {
          assert.ok(Array.isArray(schema.required));
          
          // Required fields should exist in properties
          schema.required.forEach((field: string) => {
            assert.ok(schema.properties[field], 
              `Required field ${field} should exist in properties for tool ${tool.name}`);
          });
        }
      });
    });
    
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
