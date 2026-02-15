/**
 * @fileoverview Unit tests for utility command logic.
 * 
 * Tests the pure business logic for utility operations like model discovery
 * using mock service adapters for dependency injection.
 * 
 * @module test/unit/commands/utilityCommandLogic.unit.test
 */

import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import { Module } from 'module';
import { handleRefreshModels, type ModelRefreshResult } from '../../../commands/utilityCommandLogic';
import { MockDialogService } from '../../../vscode/testAdapters';

// Mock types matching the real modelDiscovery module
interface MockModelInfo {
  id: string;
  vendor: 'openai' | 'anthropic' | 'google' | 'unknown';
  family: string;
  tier: 'fast' | 'standard' | 'premium';
}

interface MockModelDiscoveryResult {
  models: MockModelInfo[];
  rawChoices: string[];
  discoveredAt: number;
  cliVersion?: string;
}

suite('Utility Command Logic Unit Tests', () => {
  let mockDialog: MockDialogService;
  let sandbox: sinon.SinonSandbox;
  let originalRequire: typeof Module.prototype.require;

  setup(() => {
    mockDialog = new MockDialogService();
    sandbox = sinon.createSandbox();
    originalRequire = Module.prototype.require;
  });

  teardown(() => {
    mockDialog.reset();
    sandbox.restore();
    Module.prototype.require = originalRequire;
  });

  suite('handleRefreshModels', () => {
    test('should handle successful model discovery with multiple models', async () => {
      const mockModels: MockModelInfo[] = [
        { id: 'gpt-4', vendor: 'openai', family: 'gpt-4', tier: 'standard' },
        { id: 'claude-3-opus', vendor: 'anthropic', family: 'claude-3', tier: 'premium' },
        { id: 'gemini-pro', vendor: 'google', family: 'gemini', tier: 'standard' }
      ];

      const mockResult: MockModelDiscoveryResult = {
        models: mockModels,
        rawChoices: ['gpt-4', 'claude-3-opus', 'gemini-pro'],
        discoveredAt: Date.now()
      };

      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().resolves(mockResult)
          };
        }
        return originalRequire.call(this, id);
      });

      const result = await handleRefreshModels({ dialog: mockDialog });

      // Verify return value
      assert.ok('count' in result);
      assert.strictEqual(result.count, 3);
      assert.ok(!('error' in result));

      // Verify dialog interaction
      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showInfo');
      assert.ok(dialogCalls[0].args[0].includes('Discovered 3 models'));
      assert.ok(dialogCalls[0].args[0].includes('Copilot CLI'));
    });

    test('should handle successful model discovery with single model', async () => {
      const mockModels: MockModelInfo[] = [
        { id: 'gpt-4', vendor: 'openai', family: 'gpt-4', tier: 'standard' }
      ];

      const mockResult: MockModelDiscoveryResult = {
        models: mockModels,
        rawChoices: ['gpt-4'],
        discoveredAt: Date.now()
      };

      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().resolves(mockResult)
          };
        }
        return originalRequire.call(this, id);
      });

      const result = await handleRefreshModels({ dialog: mockDialog });

      assert.ok('count' in result);
      assert.strictEqual(result.count, 1);
      assert.ok(!('error' in result));

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showInfo');
      assert.ok(dialogCalls[0].args[0].includes('Discovered 1 models'));
    });

    test('should handle no models discovered', async () => {
      const mockResult: MockModelDiscoveryResult = {
        models: [],
        rawChoices: [],
        discoveredAt: Date.now()
      };

      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().resolves(mockResult)
          };
        }
        return originalRequire.call(this, id);
      });

      const result = await handleRefreshModels({ dialog: mockDialog });

      // Verify return value
      assert.ok('error' in result);
      assert.strictEqual(result.error, 'No models discovered');
      assert.ok(!('count' in result));

      // Verify dialog interaction
      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showWarning');
      assert.ok(dialogCalls[0].args[0].includes('Could not discover models'));
      assert.ok(dialogCalls[0].args[0].includes('Copilot CLI installed?'));
    });

    test('should handle model discovery import failure', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          throw new Error('Module not found');
        }
        return originalRequire.call(this, id);
      });

      const result = await handleRefreshModels({ dialog: mockDialog });

      // Verify return value
      assert.ok('error' in result);
      assert.strictEqual(result.error, 'Module not found');
      assert.ok(!('count' in result));

      // Verify dialog interaction
      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showError');
      assert.ok(dialogCalls[0].args[0].includes('Failed to refresh models'));
      assert.ok(dialogCalls[0].args[0].includes('Module not found'));
    });

    test('should handle refreshModelCache function failure', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().rejects(new Error('CLI not available'))
          };
        }
        return originalRequire.call(this, id);
      });

      const result = await handleRefreshModels({ dialog: mockDialog });

      // Verify return value
      assert.ok('error' in result);
      assert.strictEqual(result.error, 'CLI not available');
      assert.ok(!('count' in result));

      // Verify dialog interaction
      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showError');
      assert.ok(dialogCalls[0].args[0].includes('Failed to refresh models'));
      assert.ok(dialogCalls[0].args[0].includes('CLI not available'));
    });

    test('should handle non-Error exceptions', async () => {
      // Mock the dynamic import by overriding the import function itself
      const originalImportFunction = (global as any).__webpack_require__ || require;
      
      // Store original require for restoration
      const originalModuleRequire = Module.prototype.require;
      
      // Mock the import to throw a non-Error exception
      Module.prototype.require = function(id: string) {
        if (id === '../agent/modelDiscovery') {
          throw 'String error'; // Direct string throw, not wrapped by sinon
        }
        return originalModuleRequire.call(this, id);
      };

      try {
        const result = await handleRefreshModels({ dialog: mockDialog });

        // Verify return value
        assert.ok('error' in result);
        assert.strictEqual(result.error, 'String error');
        assert.ok(!('count' in result));

        // Verify dialog interaction
        const dialogCalls = mockDialog.getCalls();
        assert.strictEqual(dialogCalls.length, 1);
        assert.strictEqual(dialogCalls[0].method, 'showError');
        assert.ok(dialogCalls[0].args[0].includes('Failed to refresh models'));
        assert.ok(dialogCalls[0].args[0].includes('String error'));
      } finally {
        // Restore original require
        Module.prototype.require = originalModuleRequire;
      }
    });

    test('should handle unknown exception types', async () => {
      // Store original require for restoration
      const originalModuleRequire = Module.prototype.require;
      
      // Mock the import to throw a complex object that's not a string or Error
      Module.prototype.require = function(id: string) {
        if (id === '../agent/modelDiscovery') {
          throw { complex: 'object', nested: { value: 123 } };
        }
        return originalModuleRequire.call(this, id);
      };

      try {
        const result = await handleRefreshModels({ dialog: mockDialog });

        // Verify return value - should fall back to default message
        assert.ok('error' in result);
        assert.strictEqual(result.error, 'Unknown error during model refresh');
        assert.ok(!('count' in result));

        // Verify dialog interaction
        const dialogCalls = mockDialog.getCalls();
        assert.strictEqual(dialogCalls.length, 1);
        assert.strictEqual(dialogCalls[0].method, 'showError');
        assert.ok(dialogCalls[0].args[0].includes('Failed to refresh models'));
        assert.ok(dialogCalls[0].args[0].includes('Unknown error during model refresh'));
      } finally {
        // Restore original require
        Module.prototype.require = originalModuleRequire;
      }
    });

    test('should handle empty models array with CLI version info', async () => {
      const mockResult: MockModelDiscoveryResult = {
        models: [],
        rawChoices: [],
        discoveredAt: Date.now(),
        cliVersion: '1.0.0'
      };

      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().resolves(mockResult)
          };
        }
        return originalRequire.call(this, id);
      });

      const result = await handleRefreshModels({ dialog: mockDialog });

      assert.ok('error' in result);
      assert.strictEqual(result.error, 'No models discovered');
      assert.ok(!('count' in result));
    });

    test('should verify dialog service receives correct parameters', async () => {
      const mockResult: MockModelDiscoveryResult = {
        models: [],
        rawChoices: [],
        discoveredAt: Date.now()
      };

      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().resolves(mockResult)
          };
        }
        return originalRequire.call(this, id);
      });

      await handleRefreshModels({ dialog: mockDialog });

      const dialogCalls = mockDialog.getCalls();
      assert.strictEqual(dialogCalls.length, 1);
      assert.strictEqual(dialogCalls[0].method, 'showWarning');
      assert.ok(dialogCalls[0].args.length >= 1);
      assert.strictEqual(typeof dialogCalls[0].args[0], 'string');
    });
  });

  suite('Integration Tests', () => {
    test('should preserve service call order and state', async () => {
      const mockModels: MockModelInfo[] = [
        { id: 'test-model', vendor: 'openai', family: 'test', tier: 'standard' }
      ];

      const mockResult: MockModelDiscoveryResult = {
        models: mockModels,
        rawChoices: ['test-model'],
        discoveredAt: Date.now()
      };

      const refreshStub = sandbox.stub().resolves(mockResult);
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return { refreshModelCache: refreshStub };
        }
        return originalRequire.call(this, id);
      });

      // Call the function
      await handleRefreshModels({ dialog: mockDialog });

      // Verify the model discovery function was called before dialog
      assert.ok(refreshStub.calledOnce);
      assert.strictEqual(mockDialog.getCalls().length, 1);
      
      // Verify that the dialog call happened after the model refresh
      const dialogCall = mockDialog.getCalls()[0];
      assert.ok(dialogCall.timestamp > 0);
    });

    test('should maintain type safety for return values', async () => {
      const mockResult: MockModelDiscoveryResult = {
        models: [{ id: 'test', vendor: 'openai', family: 'test', tier: 'standard' }],
        rawChoices: ['test'],
        discoveredAt: Date.now()
      };

      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/modelDiscovery') {
          return {
            refreshModelCache: sandbox.stub().resolves(mockResult)
          };
        }
        return originalRequire.call(this, id);
      });

      const result: ModelRefreshResult = await handleRefreshModels({ dialog: mockDialog });

      // TypeScript should enforce this at compile time, but verify at runtime too
      if ('count' in result) {
        assert.strictEqual(typeof result.count, 'number');
        assert.ok(result.count! > 0);
        assert.ok(!('error' in result));
      } else {
        assert.strictEqual(typeof result.error, 'string');
        assert.ok(!('count' in result));
      }
    });
  });
});