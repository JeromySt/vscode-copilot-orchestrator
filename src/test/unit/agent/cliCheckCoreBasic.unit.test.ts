/**
 * @fileoverview Unit tests for cliCheckCore module functions that can be tested without mocking
 */

import * as assert from 'assert';
import { resetModelCache } from '../../../agent/modelDiscovery';

// Import modules at test runtime to avoid issues
suite('CLI Check Core Testable Functions', () => {
  teardown(() => {
    // Clean up any module state
    resetModelCache();
  });

  suite('module loading and basic functionality', () => {
    test('isCopilotCliAvailable function exists', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      assert.ok(typeof cliCheckCore.isCopilotCliAvailable === 'function');
    });

    test('checkCopilotCliAsync function exists', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      assert.ok(typeof cliCheckCore.checkCopilotCliAsync === 'function');
    });

    test('resetCliCache function exists', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      assert.ok(typeof cliCheckCore.resetCliCache === 'function');
    });

    test('isCliCachePopulated function exists', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      assert.ok(typeof cliCheckCore.isCliCachePopulated === 'function');
    });

    test('resetCliCache can be called without error', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      assert.doesNotThrow(() => {
        cliCheckCore.resetCliCache();
      });
    });

    test('isCliCachePopulated returns boolean', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      const result = cliCheckCore.isCliCachePopulated();
      assert.ok(typeof result === 'boolean');
    });

    test('isCopilotCliAvailable returns boolean on first call', () => {
      // Clear module cache to get fresh state
      const modulePath = require.resolve('../../../agent/cliCheckCore');
      delete require.cache[modulePath];
      
      const cliCheckCore = require('../../../agent/cliCheckCore');
      const result = cliCheckCore.isCopilotCliAvailable();
      assert.ok(typeof result === 'boolean');
    });
  });

  suite('cache state management', () => {
    test('cache starts unpopulated after reset', () => {
      // Clear module cache
      const modulePath = require.resolve('../../../agent/cliCheckCore');
      delete require.cache[modulePath];
      
      const cliCheckCore = require('../../../agent/cliCheckCore');
      cliCheckCore.resetCliCache();
      
      const isPopulated = cliCheckCore.isCliCachePopulated();
      assert.strictEqual(isPopulated, false);
    });

    test('checkCopilotCliAsync returns promise', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      const result = cliCheckCore.checkCopilotCliAsync();
      assert.ok(result instanceof Promise);
      
      // Don't await the promise to avoid actual CLI calls in tests
      result.catch(() => {}); // Silence unhandled promise rejection
    });

    test('multiple calls to resetCliCache work', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      assert.doesNotThrow(() => {
        cliCheckCore.resetCliCache();
        cliCheckCore.resetCliCache();
        cliCheckCore.resetCliCache();
      });
    });
  });

  suite('function call patterns', () => {
    test('isCopilotCliAvailable can be called multiple times', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      
      // Multiple calls should not throw
      assert.doesNotThrow(() => {
        cliCheckCore.isCopilotCliAvailable();
        cliCheckCore.isCopilotCliAvailable();
        cliCheckCore.isCopilotCliAvailable();
      });
    });

    test('functions exist on module export', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      
      // Verify all expected exports exist
      const expectedExports = [
        'isCopilotCliAvailable',
        'checkCopilotCliAsync', 
        'resetCliCache',
        'isCliCachePopulated'
      ];
      
      expectedExports.forEach(exportName => {
        assert.ok(cliCheckCore[exportName], `Export ${exportName} should exist`);
        assert.ok(typeof cliCheckCore[exportName] === 'function', `Export ${exportName} should be a function`);
      });
    });
  });

  suite('edge cases', () => {
    test('calling functions after module reload', () => {
      // Clear and reload module
      const modulePath = require.resolve('../../../agent/cliCheckCore');
      delete require.cache[modulePath];
      
      const cliCheckCore1 = require('../../../agent/cliCheckCore');
      const result1 = cliCheckCore1.isCopilotCliAvailable();
      
      // Clear and reload again
      delete require.cache[modulePath];
      const cliCheckCore2 = require('../../../agent/cliCheckCore');
      const result2 = cliCheckCore2.isCopilotCliAvailable();
      
      assert.ok(typeof result1 === 'boolean');
      assert.ok(typeof result2 === 'boolean');
    });

    test('cache state persists within same module instance', () => {
      const cliCheckCore = require('../../../agent/cliCheckCore');
      
      cliCheckCore.resetCliCache();
      const initial = cliCheckCore.isCliCachePopulated();
      
      // Cache state should be consistent within same instance
      const second = cliCheckCore.isCliCachePopulated();
      assert.strictEqual(initial, second);
    });
  });
});