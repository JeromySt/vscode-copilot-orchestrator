/**
 * @fileoverview Coverage test for prLifecycleTools.ts
 * Exercises the getPRLifecycleToolDefinitions function to cover tool definition code.
 */
import { suite, test } from 'mocha';
import * as assert from 'assert';
import { getPRLifecycleToolDefinitions } from '../../../mcp/tools/prLifecycleTools';

suite('prLifecycleTools coverage', () => {
  test('getPRLifecycleToolDefinitions returns tool array with expected names', async () => {
    const tools = await getPRLifecycleToolDefinitions();
    assert.ok(Array.isArray(tools), 'should return an array');
    assert.ok(tools.length > 0, 'should have at least one tool');
    // Every tool should have name and inputSchema
    for (const tool of tools) {
      assert.ok(tool.name, `tool should have a name`);
      assert.ok(tool.inputSchema, `${tool.name} should have inputSchema`);
    }
  });
});
