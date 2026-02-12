/**
 * @fileoverview Unit tests for URL validation
 *
 * Tests cover:
 * - validateAllowedUrls accepts valid HTTPS/HTTP URLs
 * - validateAllowedUrls accepts domain-only and wildcard formats  
 * - validateAllowedUrls blocks dangerous schemes (file:, javascript:, data:, ftp:)
 * - validateAllowedUrls rejects malformed URLs
 * - validateAllowedUrls validates nested structures (groups, retries)
 * - validateAllowedUrls skips validation for non-agent work types
 */

import * as assert from 'assert';
import { validateAllowedUrls } from '../../../mcp/validation/validator';

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
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('validateAllowedUrls', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  suite('valid URLs', () => {
    test('should accept https URLs', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'Do something',
            allowedUrls: ['https://api.example.com', 'https://github.com/api/v3']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, true);
    });

    test('should accept http URLs', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'Do something',
            allowedUrls: ['http://internal-api.local:8080']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, true);
    });

    test('should accept domain-only format', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'Do something',
            allowedUrls: ['api.example.com', 'registry.npmjs.org']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, true);
    });

    test('should accept wildcard domains', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'Do something',
            allowedUrls: ['*.example.com', '*.github.com']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, true);
    });
  });

  suite('blocked schemes', () => {
    test('should reject file:// URLs', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'Do something',
            allowedUrls: ['file:///etc/passwd']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Blocked URL scheme'));
      assert.ok(result.error?.includes('file:'));
    });

    test('should reject javascript: URLs', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'X',
            allowedUrls: ['javascript:alert(1)']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Blocked URL scheme'));
    });

    test('should reject data: URLs', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'X',
            allowedUrls: ['data:text/html,<script>evil()</script>']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Blocked URL scheme'));
    });

    test('should reject ftp:// URLs', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'X',
            allowedUrls: ['ftp://files.example.com']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid URL scheme'));
      assert.ok(result.error?.includes('Only http:// and https://'));
    });
  });

  suite('malformed URLs', () => {
    test('should reject URLs with invalid format', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'X',
            allowedUrls: ['https://']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Malformed URL'));
    });

    test('should reject single-word domains', async () => {
      const input = {
        jobs: [{
          producer_id: 'test',
          task: 'Test',
          work: {
            type: 'agent',
            instructions: 'X',
            allowedUrls: ['localhost']
          }
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Invalid URL format'));
    });
  });

  suite('nested structures', () => {
    test('should validate URLs in nested groups', async () => {
      const input = {
        jobs: [],
        groups: [{
          name: 'backend',
          jobs: [{
            producer_id: 'test',
            task: 'Test',
            work: {
              type: 'agent',
              instructions: 'X',
              allowedUrls: ['file:///etc/shadow']
            }
          }]
        }]
      };
      const result = await validateAllowedUrls(input, 'create_copilot_plan');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('/groups/0/jobs/0/work/allowedUrls[0]'));
    });

    test('should validate URLs in newWork for retries', async () => {
      const input = {
        planId: 'test-plan',
        nodeId: 'test-node',
        newWork: {
          type: 'agent',
          instructions: 'Retry',
          allowedUrls: ['javascript:void(0)']
        }
      };
      const result = await validateAllowedUrls(input, 'retry_copilot_plan_node');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('/newWork/allowedUrls[0]'));
    });
  });

  test('should pass when agent has no allowedUrls', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: { type: 'agent', instructions: 'Do something' }
      }]
    };
    const result = await validateAllowedUrls(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });

  test('should skip validation for non-agent work types', async () => {
    const input = {
      jobs: [{
        producer_id: 'test',
        task: 'Test',
        work: {
          type: 'shell',
          command: 'echo hello'
        }
      }]
    };
    const result = await validateAllowedUrls(input, 'create_copilot_plan');
    assert.strictEqual(result.valid, true);
  });
});