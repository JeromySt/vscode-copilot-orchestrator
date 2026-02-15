/**
 * @fileoverview Unit tests for Node Tool Schema Validation
 *
 * Tests cover:
 * - retry_copilot_node rejects "work" property (should be "newWork")
 * - create_copilot_node validation for unknown properties and required fields
 * - get_copilot_node validation for required node_id
 * - list_copilot_nodes validation for optional filters and status enum
 * - force_fail_copilot_node validation for required node_id
 * - get_copilot_node_failure_context validation for required node_id
 */

import * as assert from 'assert';
import { validateInput } from '../../../mcp/validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
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

suite('Node Tool Schema Validation', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // retry_copilot_node Validation
  // =========================================================================
  suite('retry_copilot_node', () => {
    test('rejects unknown property "work" (should be newWork)', () => {
      const result = validateInput('retry_copilot_node', {
        node_id: 'test-node',
        work: { type: 'agent', instructions: 'Do something' }  // WRONG!
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Unknown property 'work'"), `Error should mention 'work': ${result.error}`);
      assert.ok(result.error?.includes('not allowed'), `Error should mention 'not allowed': ${result.error}`);
    });
    
    test('accepts valid newWork property', () => {
      const result = validateInput('retry_copilot_node', {
        node_id: 'test-node',
        newWork: { type: 'agent', instructions: 'Do something' }
      });
      
      assert.ok(result.valid, `Expected valid, got: ${result.error}`);
    });
    
    test('requires node_id', () => {
      const result = validateInput('retry_copilot_node', {
        newWork: 'echo hello'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Missing required field 'node_id'"), `Error should mention missing node_id: ${result.error}`);
    });

    test('accepts valid newWork as string', () => {
      const result = validateInput('retry_copilot_node', {
        node_id: 'test-node',
        newWork: 'npm run build'
      });
      
      assert.ok(result.valid, `Expected valid with string newWork, got: ${result.error}`);
    });
  });
  
  // =========================================================================
  // get_copilot_node Validation
  // =========================================================================
  suite('get_copilot_node', () => {
    test('requires node_id', () => {
      const result = validateInput('get_copilot_node', {});
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Missing required field 'node_id'"), `Error should mention missing node_id: ${result.error}`);
    });
    
    test('accepts valid node_id', () => {
      const result = validateInput('get_copilot_node', {
        node_id: 'some-uuid'
      });
      
      assert.ok(result.valid, `Expected valid, got: ${result.error}`);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('get_copilot_node', {
        node_id: 'test-node',
        extraProp: 'not allowed'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Unknown property 'extraProp'"), `Error should mention 'extraProp': ${result.error}`);
    });
  });
  
  // =========================================================================
  // list_copilot_nodes Validation
  // =========================================================================
  suite('list_copilot_nodes', () => {
    test('accepts empty input (all optional)', () => {
      const result = validateInput('list_copilot_nodes', {});
      assert.ok(result.valid, `Expected valid with empty input, got: ${result.error}`);
    });
    
    test('validates status enum', () => {
      const result = validateInput('list_copilot_nodes', {
        status: 'invalid-status'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid value'), `Error should mention 'Invalid value': ${result.error}`);
    });

    test('accepts valid status values', () => {
      const validStatuses = ['pending', 'ready', 'scheduled', 'running', 'succeeded', 'failed', 'blocked', 'canceled'];
      for (const status of validStatuses) {
        const result = validateInput('list_copilot_nodes', { status });
        assert.ok(result.valid, `Expected valid for status '${status}', got: ${result.error}`);
      }
    });

    test('accepts valid filter combinations', () => {
      const result = validateInput('list_copilot_nodes', {
        group_id: 'test-group',
        status: 'running',
        group_name: 'Test Group'
      });
      
      assert.ok(result.valid, `Expected valid with filters, got: ${result.error}`);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('list_copilot_nodes', {
        status: 'running',
        invalidFilter: 'not allowed'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Unknown property 'invalidFilter'"), `Error should mention 'invalidFilter': ${result.error}`);
    });
  });
  
  // =========================================================================
  // force_fail_copilot_node Validation
  // =========================================================================
  suite('force_fail_copilot_node', () => {
    test('requires node_id', () => {
      const result = validateInput('force_fail_copilot_node', {
        reason: 'stuck'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Missing required field 'node_id'"), `Error should mention missing node_id: ${result.error}`);
    });

    test('accepts valid input with node_id only', () => {
      const result = validateInput('force_fail_copilot_node', {
        node_id: 'test-node'
      });
      
      assert.ok(result.valid, `Expected valid with node_id only, got: ${result.error}`);
    });

    test('accepts valid input with reason', () => {
      const result = validateInput('force_fail_copilot_node', {
        node_id: 'test-node',
        reason: 'Node appears to be stuck'
      });
      
      assert.ok(result.valid, `Expected valid with reason, got: ${result.error}`);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('force_fail_copilot_node', {
        node_id: 'test-node',
        invalidProp: 'not allowed'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Unknown property 'invalidProp'"), `Error should mention 'invalidProp': ${result.error}`);
    });
  });
  
  // =========================================================================
  // update_copilot_plan_node Validation
  // =========================================================================
  suite('update_copilot_plan_node', () => {
    test('requires planId and nodeId', () => {
      const result = validateInput('update_copilot_plan_node', {});
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Missing required field 'planId'") || result.error?.includes("Missing required field 'nodeId'"), 
                `Error should mention missing required fields: ${result.error}`);
    });

    test('accepts valid minimal input with work', () => {
      const result = validateInput('update_copilot_plan_node', {
        planId: 'plan-123',
        nodeId: 'node-456',
        work: 'npm test'
      });
      
      assert.ok(result.valid, `Expected valid, got: ${result.error}`);
    });

    test('accepts all stage updates', () => {
      const result = validateInput('update_copilot_plan_node', {
        planId: 'plan-123',
        nodeId: 'node-456',
        prechecks: 'npm run lint',
        work: { type: 'agent', instructions: '# Test task' },
        postchecks: { type: 'shell', command: 'echo done', shell: 'bash' }
      });
      
      assert.ok(result.valid, `Expected valid, got: ${result.error}`);
    });

    test('accepts resetToStage parameter', () => {
      const result = validateInput('update_copilot_plan_node', {
        planId: 'plan-123',
        nodeId: 'node-456',
        work: 'npm test',
        resetToStage: 'work'
      });
      
      assert.ok(result.valid, `Expected valid, got: ${result.error}`);
    });

    test('rejects invalid resetToStage values', () => {
      const result = validateInput('update_copilot_plan_node', {
        planId: 'plan-123',
        nodeId: 'node-456',
        work: 'npm test',
        resetToStage: 'invalid-stage'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('resetToStage'), `Error should mention resetToStage: ${result.error}`);
    });

    test('accepts valid resetToStage values', () => {
      const stages = ['prechecks', 'work', 'postchecks'];
      
      for (const stage of stages) {
        const result = validateInput('update_copilot_plan_node', {
          planId: 'plan-123',
          nodeId: 'node-456',
          work: 'npm test',
          resetToStage: stage
        });
        
        assert.ok(result.valid, `Stage '${stage}' should be valid, got: ${result.error}`);
      }
    });

    test('rejects unknown properties', () => {
      const result = validateInput('update_copilot_plan_node', {
        planId: 'plan-123',
        nodeId: 'node-456',
        work: 'npm test',
        unknownProp: 'invalid'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Unknown property 'unknownProp'"), `Error should mention 'unknownProp': ${result.error}`);
    });
  });
  
  // =========================================================================
  // get_copilot_node_failure_context Validation
  // =========================================================================
  suite('get_copilot_node_failure_context', () => {
    test('requires node_id', () => {
      const result = validateInput('get_copilot_node_failure_context', {});
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Missing required field 'node_id'"), `Error should mention missing node_id: ${result.error}`);
    });

    test('accepts valid node_id', () => {
      const result = validateInput('get_copilot_node_failure_context', {
        node_id: 'failed-node-123'
      });
      
      assert.ok(result.valid, `Expected valid, got: ${result.error}`);
    });

    test('rejects unknown properties', () => {
      const result = validateInput('get_copilot_node_failure_context', {
        node_id: 'test-node',
        extraField: 'not allowed'
      });
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Unknown property 'extraField'"), `Error should mention 'extraField': ${result.error}`);
    });
  });
});