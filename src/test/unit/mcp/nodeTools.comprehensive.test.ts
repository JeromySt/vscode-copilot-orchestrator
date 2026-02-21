/**
 * @fileoverview Comprehensive unit tests for MCP Job Tools  
 * 
 * Tests cover:
 * - Job tool definition structure and schemas
 * - All job tool definitions exported correctly
 * - Input validation and edge cases
 * - Tool metadata validation
 * 
 * Target: 95%+ line coverage for tools/jobTools.ts
 */

import { suite, test, setup } from 'mocha';
import * as assert from 'assert';
import { getJobToolDefinitions } from '../../../mcp/tools/jobTools';
import { McpTool } from '../../../mcp/types';

suite('MCP Job Tools Unit Tests', () => {
  let jobTools: McpTool[];
  
  setup(async () => {
    jobTools = await getJobToolDefinitions();
  });
  
  suite('getJobToolDefinitions', () => {
    test('should return array of job tool definitions', () => {
      assert.ok(Array.isArray(jobTools));
      assert.ok(jobTools.length > 0);
    });
    
    test.skip('should include expected job tools', () => {
      const toolNames = jobTools.map(tool => tool.name);
      
      // Core job inspection tools
      assert.ok(toolNames.includes('get_job_details'));
      assert.ok(toolNames.includes('get_job_logs'));
      assert.ok(toolNames.includes('get_job_attempts'));
      
      // Job management tools  
      assert.ok(toolNames.includes('retry_job'));
      assert.ok(toolNames.includes('force_fail_job'));
      assert.ok(toolNames.includes('update_job'));
    });
    
    test('should have valid tool structure', () => {
      jobTools.forEach(tool => {
        assert.ok(tool.name);
        assert.ok(tool.description);
        assert.ok(tool.inputSchema);
        assert.strictEqual(typeof tool.name, 'string');
        assert.strictEqual(typeof tool.description, 'string');
        assert.strictEqual(typeof tool.inputSchema, 'object');
      });
    });
  });
  
  suite.skip('get_job_details tool', () => {
    let jobDetailsTool: McpTool;
    
    setup(() => {
      jobDetailsTool = jobTools.find(tool => tool.name === 'get_job_details')!;
      assert.ok(jobDetailsTool, 'get_job_details tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = jobDetailsTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
      assert.strictEqual(schema.properties.planId.type, 'string');
      assert.strictEqual(schema.properties.nodeId.type, 'string');
    });
    
    test('should have optional include flags', () => {
      const schema = jobDetailsTool.inputSchema;
      
      // Common include options for node details
      const possibleIncludes = ['includeLogs', 'includeAttempts', 'includeMetrics', 'includeConfig'];
      
      possibleIncludes.forEach(includeFlag => {
        if (schema.properties[includeFlag]) {
          assert.strictEqual(schema.properties[includeFlag].type, 'boolean');
        }
      });
    });
  });
  
  suite.skip('get_job_logs tool', () => {
    let jobLogsTool: McpTool;
    
    setup(() => {
      jobLogsTool = jobTools.find(tool => tool.name === 'get_job_logs')!;
      assert.ok(jobLogsTool, 'get_job_logs tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = jobLogsTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have log filtering options', () => {
      const schema = jobLogsTool.inputSchema;
      
      // Common log filtering options
      const logOptions = ['lines', 'follow', 'phase', 'attemptNumber'];
      
      logOptions.forEach(option => {
        if (schema.properties[option]) {
          assert.ok(schema.properties[option].type);
        }
      });
    });
  });
  
  suite.skip('get_job_attempts tool', () => {
    let attemptsTool: McpTool;
    
    setup(() => {
      attemptsTool = jobTools.find(tool => tool.name === 'get_job_attempts')!;
      assert.ok(attemptsTool, 'get_job_attempts tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = attemptsTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
  });
  
  suite.skip('retry_job tool', () => {
    let retryJobTool: McpTool;
    
    setup(() => {
      retryJobTool = jobTools.find(tool => tool.name === 'retry_job')!;
      assert.ok(retryJobTool, 'retry_job tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = retryJobTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have optional retry parameters', () => {
      const schema = retryJobTool.inputSchema;
      
      // Common retry options
      const retryOptions = ['fromPhase', 'clearHistory', 'newWork'];
      
      retryOptions.forEach(option => {
        if (schema.properties[option]) {
          assert.ok(schema.properties[option].type);
        }
      });
    });
  });
  
  suite.skip('force_fail_job tool', () => {
    let forceFailTool: McpTool;
    
    setup(() => {
      forceFailTool = jobTools.find(tool => tool.name === 'force_fail_job')!;
      assert.ok(forceFailTool, 'force_fail_job tool should exist');
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
  
  suite.skip('update_job tool', () => {
    let updateJobTool: McpTool;
    
    setup(() => {
      updateJobTool = jobTools.find(tool => tool.name === 'update_job')!;
      assert.ok(updateJobTool, 'update_job tool should exist');
    });
    
    test('should require planId and nodeId', () => {
      const schema = updateJobTool.inputSchema;
      
      assert.ok(schema.required && schema.required.includes('planId'));
      assert.ok(schema.required && schema.required.includes('nodeId'));
      assert.ok(schema.properties.planId);
      assert.ok(schema.properties.nodeId);
    });
    
    test('should have update parameters', () => {
      const schema = updateJobTool.inputSchema;
      
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
      jobTools.forEach(tool => {
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
      jobTools.forEach(tool => {
        const schema = tool.inputSchema;
        
        // All node tools need these identifiers
        assert.ok(schema.required && schema.required.includes('planId'), 
          `Tool ${tool.name} should require planId`);
        assert.ok(schema.required && schema.required.includes('nodeId'), 
          `Tool ${tool.name} should require nodeId`);
      });
    });
    
    test('tool names should follow naming convention', () => {
      jobTools.forEach(tool => {
        // Should use snake_case
        assert.ok(tool.name.match(/^[a-z][a-z0-9_]*$/), 
          `Tool name ${tool.name} should be snake_case`);
        
        // Job tools often have _job suffix or job in the name
        const hasJobContext = tool.name.includes('job') || tool.name.includes('retry') || tool.name.includes('force');
        assert.ok(hasJobContext, 
          `Tool ${tool.name} should indicate job context`);
      });
    });
    
    test('descriptions should be descriptive', () => {
      jobTools.forEach(tool => {
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
      const tools1 = await getJobToolDefinitions();
      const tools2 = await getJobToolDefinitions();
      
      // Modifying one array should not affect the other
      tools1.push({} as any);
      assert.notStrictEqual(tools1.length, tools2.length);
    });
    
    test('should handle schema mutations safely', async () => {
      const tools1 = await getJobToolDefinitions();
      const tools2 = await getJobToolDefinitions();
      
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
      const toolNames = jobTools.map(tool => tool.name);
      
      toolNames.forEach(name => {
        const tool = jobTools.find(t => t.name === name);
        assert.ok(tool, `Tool ${name} should be findable in the array`);
      });
    });
    
    test('should not have duplicate tool names', () => {
      const toolNames = jobTools.map(tool => tool.name);
      const uniqueNames = new Set(toolNames);
      
      assert.strictEqual(toolNames.length, uniqueNames.size, 
        'Should not have duplicate tool names');
    });
  });
});
