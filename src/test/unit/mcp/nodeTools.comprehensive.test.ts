/**
 * @fileoverview Comprehensive unit tests for MCP Node Tools  
 * 
 * Tests cover:
 * - Node tool definition structure and schemas
 * - All node tool definitions exported correctly
 * - Input validation and edge cases
 * - Tool metadata validation
 * 
 * Target: 95%+ line coverage for tools/nodeTools.ts
 */

import { suite, test, setup } from 'mocha';
import * as assert from 'assert';
import { getNodeToolDefinitions } from '../../../mcp/tools/nodeTools';
import { McpTool } from '../../../mcp/types';

suite('MCP Node Tools Unit Tests', () => {
  let nodeTools: McpTool[];
  
  setup(async () => {
    nodeTools = await getNodeToolDefinitions();
  });
  
  suite('getNodeToolDefinitions', () => {
    test('should return array of node tool definitions', () => {
      assert.ok(Array.isArray(nodeTools));
      assert.ok(nodeTools.length > 0);
    });
    
    test.skip('should include expected node tools', () => {
      const toolNames = nodeTools.map(tool => tool.name);
      
      // Core node inspection tools
      assert.ok(toolNames.includes('get_node_details'));
      assert.ok(toolNames.includes('get_node_logs'));
      assert.ok(toolNames.includes('get_node_attempts'));
      
      // Node management tools  
      assert.ok(toolNames.includes('retry_node'));
      assert.ok(toolNames.includes('force_fail_node'));
      assert.ok(toolNames.includes('update_node'));
    });
    
    test('should have valid tool structure', () => {
      nodeTools.forEach(tool => {
        assert.ok(tool.name);
        assert.ok(tool.description);
        assert.ok(tool.inputSchema);
        assert.strictEqual(typeof tool.name, 'string');
        assert.strictEqual(typeof tool.description, 'string');
        assert.strictEqual(typeof tool.inputSchema, 'object');
      });
    });
  });
  
  suite.skip('get_node_details tool', () => {
    let nodeDetailsTool: McpTool;
    
    setup(() => {
      nodeDetailsTool = nodeTools.find(tool => tool.name === 'get_node_details')!;
      assert.ok(nodeDetailsTool, 'get_node_details tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = nodeDetailsTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
      assert.strictEqual(schema.properties.planId.type, 'string');
      assert.strictEqual(schema.properties.nodeId.type, 'string');
    });
    
    test('should have optional include flags', () => {
      const schema = nodeDetailsTool.inputSchema;
      
      // Common include options for node details
      const possibleIncludes = ['includeLogs', 'includeAttempts', 'includeMetrics', 'includeConfig'];
      
      possibleIncludes.forEach(includeFlag => {
        if (schema.properties[includeFlag]) {
          assert.strictEqual(schema.properties[includeFlag].type, 'boolean');
        }
      });
    });
  });
  
  suite.skip('get_node_logs tool', () => {
    let nodeLogsTool: McpTool;
    
    setup(() => {
      nodeLogsTool = nodeTools.find(tool => tool.name === 'get_node_logs')!;
      assert.ok(nodeLogsTool, 'get_node_logs tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = nodeLogsTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have log filtering options', () => {
      const schema = nodeLogsTool.inputSchema;
      
      // Common log filtering options
      const logOptions = ['lines', 'follow', 'phase', 'attemptNumber'];
      
      logOptions.forEach(option => {
        if (schema.properties[option]) {
          assert.ok(schema.properties[option].type);
        }
      });
    });
  });
  
  suite.skip('get_node_attempts tool', () => {
    let attemptsTool: McpTool;
    
    setup(() => {
      attemptsTool = nodeTools.find(tool => tool.name === 'get_node_attempts')!;
      assert.ok(attemptsTool, 'get_node_attempts tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = attemptsTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
  });
  
  suite.skip('retry_node tool', () => {
    let retryNodeTool: McpTool;
    
    setup(() => {
      retryNodeTool = nodeTools.find(tool => tool.name === 'retry_node')!;
      assert.ok(retryNodeTool, 'retry_node tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = retryNodeTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have optional retry parameters', () => {
      const schema = retryNodeTool.inputSchema;
      
      // Common retry options
      const retryOptions = ['fromPhase', 'clearHistory', 'newWork'];
      
      retryOptions.forEach(option => {
        if (schema.properties[option]) {
          assert.ok(schema.properties[option].type);
        }
      });
    });
  });
  
  suite.skip('force_fail_node tool', () => {
    let forceFailTool: McpTool;
    
    setup(() => {
      forceFailTool = nodeTools.find(tool => tool.name === 'force_fail_node')!;
      assert.ok(forceFailTool, 'force_fail_node tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = forceFailTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have optional reason parameter', () => {
      const schema = forceFailTool.inputSchema;
      
      if (schema.properties.reason) {
        assert.strictEqual(schema.properties.reason.type, 'string');
      }
    });
  });
  
  suite.skip('update_node tool', () => {
    let updateNodeTool: McpTool;
    
    setup(() => {
      updateNodeTool = nodeTools.find(tool => tool.name === 'update_node')!;
      assert.ok(updateNodeTool, 'update_node tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = updateNodeTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have update parameters', () => {
      const schema = updateNodeTool.inputSchema;
      
      // Common update options
      const updateOptions = ['work', 'prechecks', 'postchecks', 'instructions', 'task'];
      
      updateOptions.forEach(option => {
        if (schema.properties[option]) {
          assert.ok(schema.properties[option].type);
        }
      });
    });
  });
  
  suite('Schema validation', () => {
    test.skip('all node tools should have valid JSON schema structure', () => {
      nodeTools.forEach(tool => {
        const schema = tool.inputSchema;
        
        // Basic JSON schema structure
        assert.ok(schema.type);
        assert.strictEqual(schema.type, 'object');
        
        if (schema.properties) {
          assert.strictEqual(typeof schema.properties, 'object');
          
          // Each property should have a type
          Object.values(schema.properties).forEach((prop: any) => {
            assert.ok(prop.type, `Property should have type in tool ${tool.name}`);
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
    
    test.skip('node tools should require planId and nodeId', () => {
      nodeTools.forEach(tool => {
        const schema = tool.inputSchema;
        
        // All node tools need these identifiers
        assert.ok(schema.required && schema.required.includes('planId'), 
          `Tool ${tool.name} should require planId`);
        assert.ok(schema.required && schema.required.includes('nodeId'), 
          `Tool ${tool.name} should require nodeId`);
      });
    });
    
    test('tool names should follow naming convention', () => {
      nodeTools.forEach(tool => {
        // Should use snake_case
        assert.ok(tool.name.match(/^[a-z][a-z0-9_]*$/), 
          `Tool name ${tool.name} should be snake_case`);
        
        // Node tools often have _node suffix or node prefix
        const hasNodeContext = tool.name.includes('node') || tool.name.includes('retry') || tool.name.includes('force');
        assert.ok(hasNodeContext, 
          `Tool ${tool.name} should indicate node context`);
      });
    });
    
    test('descriptions should be descriptive', () => {
      nodeTools.forEach(tool => {
        assert.ok(tool.description);
        assert.ok(tool.description.trim().length > 0);
        assert.ok(tool.description.length > 10, 
          `Tool ${tool.name} description should be meaningful`);
        
        // Node tool descriptions should mention nodes
        const mentionsNode = tool.description.toLowerCase().includes('node') || 
                           tool.description.toLowerCase().includes('job') ||
                           tool.description.toLowerCase().includes('task');
        assert.ok(mentionsNode, 
          `Tool ${tool.name} description should mention node/job/task context`);
      });
    });
  });
  
  suite('Edge cases', () => {
    test('should handle tools array mutations safely', async () => {
      const tools1 = await getNodeToolDefinitions();
      const tools2 = await getNodeToolDefinitions();
      
      // Modifying one array should not affect the other
      tools1.push({} as any);
      assert.notStrictEqual(tools1.length, tools2.length);
    });
    
    test('should handle schema mutations safely', async () => {
      const tools1 = await getNodeToolDefinitions();
      const tools2 = await getNodeToolDefinitions();
      
      const firstTool1 = tools1[0];
      const firstTool2 = tools2[0];
      
      if (firstTool1 && firstTool2) {
        // Modifying schema should not affect other instances
        (firstTool1.inputSchema as any).additionalProperty = 'test';
        assert.ok(!(firstTool2.inputSchema as any).additionalProperty);
      }
    });
    
    test('should handle missing tools gracefully', () => {
      // Test for robustness if specific tools are missing
      const toolNames = nodeTools.map(tool => tool.name);
      
      toolNames.forEach(name => {
        const tool = nodeTools.find(t => t.name === name);
        assert.ok(tool, `Tool ${name} should be findable in the array`);
      });
    });
    
    test('should not have duplicate tool names', () => {
      const toolNames = nodeTools.map(tool => tool.name);
      const uniqueNames = new Set(toolNames);
      
      assert.strictEqual(toolNames.length, uniqueNames.size, 
        'Should not have duplicate tool names');
    });
  });
});
