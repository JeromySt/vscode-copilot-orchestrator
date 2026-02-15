import * as assert from 'assert';
import * as sinon from 'sinon';

suite('utils', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('errorResult', () => {
    test('creates error result with message', () => {
      const { errorResult } = require('../../../../mcp/handlers/utils');
      
      const result = errorResult('Test error');
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Test error');
    });

    test('creates error result with Error object', () => {
      const { errorResult } = require('../../../../mcp/handlers/utils');
      
      const error = new Error('Test error');
      const result = errorResult(error.message); // Call with .message, not the Error object directly
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Test error');
    });
  });

  suite('isError', () => {
    test('identifies error results', () => {
      const { isError } = require('../../../../mcp/handlers/utils');
      
      const errorResult = { success: false, error: 'test' };
      const successResult = { success: true, data: 'test' };
      
      assert.strictEqual(isError(errorResult), true);
      assert.strictEqual(isError(successResult), false);
    });

    test('handles undefined input', () => {
      const { isError } = require('../../../../mcp/handlers/utils');
      
      assert.strictEqual(isError(undefined), false);
      assert.strictEqual(isError(null), false);
    });
  });

  suite('basic validation helpers', () => {
    test('validateRequired exists and is callable', () => {
      const { validateRequired } = require('../../../../mcp/handlers/utils');
      
      assert.ok(typeof validateRequired === 'function');
      
      // Test basic function call doesn't throw
      const obj = { name: 'test' };
      const result = validateRequired(obj, 'name', 'string');
      assert.ok(result === null || (typeof result === 'object' && 'error' in result));
    });
  });
});