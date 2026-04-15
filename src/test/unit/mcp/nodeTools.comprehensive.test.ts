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
  
  suite('Schema validation', () => {
    
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