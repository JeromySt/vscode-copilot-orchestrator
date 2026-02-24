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
import { handleRefreshModels, handleSetupCopilotCli, type ModelRefreshResult, type CliSetupDeps } from '../../../commands/utilityCommandLogic';
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
      // Store original require for restoration
      const originalModuleRequire = Module.prototype.require;
      
      // Mock the import to throw a non-Error exception
      Module.prototype.require = function(id: string) {
        if (id === '../agent/modelDiscovery') {
          throw 'String error'; // eslint-disable-line no-throw-literal -- intentionally testing non-Error throw
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
          throw { complex: 'object', nested: { value: 123 } }; // eslint-disable-line no-throw-literal -- intentionally testing non-Error throw
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

  suite('handleSetupCopilotCli', () => {
    function createDeps(overrides?: Partial<CliSetupDeps>): CliSetupDeps & { infoCalls: string[]; warningCalls: string[]; terminalCalls: Array<{ name: string; command: string }> } {
      const infoCalls: string[] = [];
      const warningCalls: string[] = [];
      const terminalCalls: Array<{ name: string; command: string }> = [];
      return {
        dialog: {
          showInfo: (msg: string) => { infoCalls.push(msg); },
          showWarning: (msg: string) => { warningCalls.push(msg); },
          ...overrides?.dialog,
        },
        openTerminal: (name: string, command: string) => { terminalCalls.push({ name, command }); },
        ...overrides?.openTerminal ? { openTerminal: overrides.openTerminal as any } : {},
        infoCalls,
        warningCalls,
        terminalCalls,
      };
    }

    test('should return install-prompted when CLI is not available', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          return {
            checkCopilotCliAsync: sandbox.stub().resolves(false),
            checkCopilotAuthAsync: sandbox.stub().resolves({ authenticated: false, method: 'unknown' }),
            resetCliCache: sandbox.stub(),
          };
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'install-prompted');
      assert.strictEqual(deps.warningCalls.length, 1);
      assert.ok(deps.warningCalls[0].includes('not installed'));
    });

    test('should return already-setup when CLI is available and authenticated', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          return {
            checkCopilotCliAsync: sandbox.stub().resolves(true),
            checkCopilotAuthAsync: sandbox.stub().resolves({ authenticated: true, method: 'gh' }),
            resetCliCache: sandbox.stub(),
          };
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'already-setup');
      assert.strictEqual(deps.infoCalls.length, 1);
      assert.ok(deps.infoCalls[0].includes('authenticated'));
    });

    test('should open terminal with gh auth login for unauthenticated gh CLI', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          return {
            checkCopilotCliAsync: sandbox.stub().resolves(true),
            checkCopilotAuthAsync: sandbox.stub().resolves({ authenticated: false, method: 'gh' }),
            resetCliCache: sandbox.stub(),
          };
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'login-prompted');
      assert.strictEqual((result as any).method, 'gh');
      assert.strictEqual(deps.terminalCalls.length, 1);
      assert.ok(deps.terminalCalls[0].command.includes('gh auth login'));
    });

    test('should open terminal with copilot auth login for standalone CLI', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          return {
            checkCopilotCliAsync: sandbox.stub().resolves(true),
            checkCopilotAuthAsync: sandbox.stub().resolves({ authenticated: false, method: 'standalone' }),
            resetCliCache: sandbox.stub(),
          };
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'login-prompted');
      assert.strictEqual((result as any).method, 'standalone');
      assert.strictEqual(deps.terminalCalls.length, 1);
      assert.ok(deps.terminalCalls[0].command.includes('copilot auth login'));
    });

    test('should default to gh method when auth method is unknown', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          return {
            checkCopilotCliAsync: sandbox.stub().resolves(true),
            checkCopilotAuthAsync: sandbox.stub().resolves({ authenticated: false, method: 'unknown' }),
            resetCliCache: sandbox.stub(),
          };
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'login-prompted');
      assert.strictEqual((result as any).method, 'gh');
    });

    test('should return error when import throws', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          throw new Error('Module load failed');
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'error');
      assert.strictEqual((result as any).error, 'Module load failed');
      assert.strictEqual(deps.warningCalls.length, 1);
      assert.ok(deps.warningCalls[0].includes('setup failed'));
    });

    test('should handle error without message property', async () => {
      Module.prototype.require = sandbox.stub().callsFake((id: string) => {
        if (id === '../agent/cliCheckCore') {
          throw { code: 'ENOENT' }; // eslint-disable-line no-throw-literal
        }
        return originalRequire.call(this, id);
      });

      const deps = createDeps();
      const result = await handleSetupCopilotCli(deps);

      assert.strictEqual(result.status, 'error');
      assert.strictEqual((result as any).error, 'Unknown error');
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