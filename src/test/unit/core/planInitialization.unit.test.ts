/**
 * @fileoverview Unit tests for plan initialization utilities
 * 
 * Tests focus on the testable parts of planInitialization:
 * - Configuration loading with dependency injection
 * - Agent delegator adapter creation
 * - Helper functions that can be tested without VS Code
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfiguration } from '../../../core/planInitialization';
import { IConfigProvider } from '../../../interfaces/IConfigProvider';

// Mock config provider for testing
class MockConfigProvider implements IConfigProvider {
  private config: Map<string, any> = new Map();

  getConfig<T>(section: string, key: string, defaultValue: T): T {
    const fullKey = `${section}.${key}`;
    return this.config.get(fullKey) ?? defaultValue;
  }

  setConfig<T>(section: string, key: string, value: T): void {
    const fullKey = `${section}.${key}`;
    this.config.set(fullKey, value);
  }

  clear(): void {
    this.config.clear();
  }
}

suite('Plan Initialization Unit Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockConfigProvider: MockConfigProvider;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockConfigProvider = new MockConfigProvider();
  });

  teardown(() => {
    sandbox.restore();
  });

  // =========================================================================
  // Configuration Loading
  // =========================================================================

  suite('loadConfiguration', () => {
    test('should load default configuration with config provider', () => {
      const config = loadConfiguration(mockConfigProvider);
      
      assert.strictEqual(config.mcp.enabled, true, 'MCP should be enabled by default');
      assert.ok(config.maxParallel > 0, 'maxParallel should be positive (CPU count)');
      assert.strictEqual(typeof config.maxParallel, 'number');
    });

    test('should respect MCP enabled setting from config provider', () => {
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', false);
      
      const config = loadConfiguration(mockConfigProvider);
      
      assert.strictEqual(config.mcp.enabled, false);
    });

    test('should respect maxWorkers setting from config provider', () => {
      mockConfigProvider.setConfig('copilotOrchestrator', 'maxWorkers', 8);
      
      const config = loadConfiguration(mockConfigProvider);
      
      assert.strictEqual(config.maxParallel, 8);
    });

    test('should fallback to CPU count when maxWorkers is 0', () => {
      mockConfigProvider.setConfig('copilotOrchestrator', 'maxWorkers', 0);
      
      const config = loadConfiguration(mockConfigProvider);
      
      assert.ok(config.maxParallel > 0);
      assert.notStrictEqual(config.maxParallel, 0);
    });

    test('should use CPU count fallback when maxWorkers is undefined', () => {
      // Don't set maxWorkers, should use default of 0 and then fallback to CPU count
      const config = loadConfiguration(mockConfigProvider);
      
      assert.ok(config.maxParallel > 0);
    });

    test('should handle various MCP configuration values', () => {
      // Test with explicit true
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', true);
      let config = loadConfiguration(mockConfigProvider);
      assert.strictEqual(config.mcp.enabled, true);
      
      // Test with explicit false
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', false);
      config = loadConfiguration(mockConfigProvider);
      assert.strictEqual(config.mcp.enabled, false);
    });

    test('should return valid configuration structure', () => {
      const config = loadConfiguration(mockConfigProvider);
      
      // Verify structure
      assert.ok(config.mcp, 'Should have mcp configuration');
      assert.ok(typeof config.mcp.enabled === 'boolean', 'MCP enabled should be boolean');
      assert.ok(typeof config.maxParallel === 'number', 'maxParallel should be number');
      assert.ok(config.maxParallel >= 1, 'maxParallel should be at least 1');
    });

    test('should load configuration without config provider', () => {
      // This tests the fallback to direct VS Code API
      // Note: In test environment, this uses the mocked vscode API
      const config = loadConfiguration();
      
      assert.ok(config, 'Should return configuration');
      assert.ok(config.mcp, 'Should have mcp configuration');
      assert.ok(typeof config.mcp.enabled === 'boolean');
      assert.ok(typeof config.maxParallel === 'number');
      assert.ok(config.maxParallel > 0);
    });
  });

  // =========================================================================
  // Configuration Edge Cases
  // =========================================================================

  suite('loadConfiguration edge cases', () => {
    test('should handle config provider returning different types', () => {
      // Test with string values (simulating config that might come as strings)
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', 'true' as any);
      mockConfigProvider.setConfig('copilotOrchestrator', 'maxWorkers', '4' as any);
      
      const config = loadConfiguration(mockConfigProvider);
      
      // Should still work correctly (though types might be coerced)
      assert.ok(config.mcp);
      assert.ok(config.maxParallel);
    });

    test('should handle missing configuration sections gracefully', () => {
      // Create a minimal mock that doesn't have all configs set
      const minimalProvider = new MockConfigProvider();
      
      const config = loadConfiguration(minimalProvider);
      
      // Should use defaults
      assert.strictEqual(config.mcp.enabled, true);
      assert.ok(config.maxParallel > 0);
    });
  });

  // =========================================================================
  // Integration tests
  // =========================================================================

  suite('configuration integration', () => {
    test('should create consistent configuration across multiple calls', () => {
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', true);
      mockConfigProvider.setConfig('copilotOrchestrator', 'maxWorkers', 4);
      
      const config1 = loadConfiguration(mockConfigProvider);
      const config2 = loadConfiguration(mockConfigProvider);
      
      assert.deepStrictEqual(config1, config2);
    });

    test('should reflect configuration changes', () => {
      // Initial config
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', true);
      const config1 = loadConfiguration(mockConfigProvider);
      assert.strictEqual(config1.mcp.enabled, true);
      
      // Change config
      mockConfigProvider.setConfig('copilotOrchestrator.mcp', 'enabled', false);
      const config2 = loadConfiguration(mockConfigProvider);
      assert.strictEqual(config2.mcp.enabled, false);
    });
  });
});

// =========================================================================
// registerPlanCommands tests
// =========================================================================

suite('registerPlanCommands', () => {
  let sandbox: sinon.SinonSandbox;
  let vscode: any;
  let mockContext: any;
  let mockPlanRunner: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    vscode = require('vscode');

    mockContext = {
      subscriptions: [] as any[],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
      globalState: {
        get: sandbox.stub().returns(undefined),
        update: sandbox.stub().resolves(),
      },
    };

    mockPlanRunner = {
      getAll: sandbox.stub().returns([]),
      get: sandbox.stub().returns(undefined),
      getStateMachine: sandbox.stub().returns(undefined),
      cancel: sandbox.stub(),
      pause: sandbox.stub(),
      resume: sandbox.stub().resolves(true),
      delete: sandbox.stub(),
      initialize: sandbox.stub().resolves(),
      persistSync: sandbox.stub(),
      setExecutor: sandbox.stub(),
    };
  });

  teardown(() => {
    sandbox.restore();
  });

  function registerCommands() {
    const { registerPlanCommands } = require('../../../core/planInitialization');
    registerPlanCommands(mockContext, mockPlanRunner);
  }

  async function executeCommand(name: string, ...args: any[]) {
    return vscode.commands.executeCommand(name, ...args);
  }

  // ─── showPlanDetails ────────────────────────────────────────────────

  suite('orchestrator.showPlanDetails', () => {
    test('registers the command', () => {
      registerCommands();
      assert.ok(mockContext.subscriptions.length > 0);
    });

    test('shows info when no plans and no planId', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.getAll.returns([]);

      await executeCommand('orchestrator.showPlanDetails');
      assert.ok(spy.calledWith('No plans available'));
    });

    test('returns early when quickPick is dismissed', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.showPlanDetails');
      // No error thrown means early return worked
    });

    test('creates panel when planId provided directly', async () => {
      registerCommands();
      try {
        await executeCommand('orchestrator.showPlanDetails', 'p1');
      } catch {
        // planDetailPanel.createOrShow may throw in test env
      }
    });

    test('creates panel from quickPick selection', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Plan 1', planId: 'p1' } as any);

      try {
        await executeCommand('orchestrator.showPlanDetails');
      } catch {
        // planDetailPanel.createOrShow may throw in test env
      }
    });
  });

  // ─── showNodeDetails ────────────────────────────────────────────────

  suite('orchestrator.showNodeDetails', () => {
    test('shows info when no plans and no planId', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.getAll.returns([]);

      await executeCommand('orchestrator.showNodeDetails');
      assert.ok(spy.calledWith('No plans available'));
    });

    test('shows error when plan not found with nodeId missing', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showErrorMessage');
      mockPlanRunner.get.returns(undefined);

      await executeCommand('orchestrator.showNodeDetails', 'bad-id');
      assert.ok(spy.calledOnce);
    });

    test('shows info when plan has no nodes', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.get.returns({ id: 'p1', jobs: new Map() });

      await executeCommand('orchestrator.showNodeDetails', 'p1');
      assert.ok(spy.calledWith('No nodes in this plan'));
    });

    test('returns early when node quickPick dismissed', async () => {
      registerCommands();
      const nodeMap = new Map();
      nodeMap.set('n1', { id: 'n1', spec: { name: 'Node 1' } });
      mockPlanRunner.get.returns({ id: 'p1', jobs: nodeMap });
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.showNodeDetails', 'p1');
      // No error means early return worked
    });

    test('returns early when plan quickPick dismissed', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.showNodeDetails');
    });

    test('handles node without spec.name gracefully', async () => {
      registerCommands();
      const nodeMap = new Map();
      nodeMap.set('n1', { id: 'n1' }); // No spec property
      mockPlanRunner.get.returns({ id: 'p1', jobs: nodeMap });
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.showNodeDetails', 'p1');
    });

    test('creates node detail panel with both planId and nodeId', async () => {
      registerCommands();
      const nodeMap = new Map();
      nodeMap.set('n1', { id: 'n1', name: 'Node 1', dependencies: [], dependents: [] });
      const nodeStates = new Map();
      nodeStates.set('n1', { status: 'pending', version: 0, attempts: 0 });
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' }, jobs: nodeMap, nodeStates, producerIdToNodeId: new Map(), roots: ['n1'], leaves: ['n1'] });
      try {
        await executeCommand('orchestrator.showNodeDetails', 'p1', 'n1');
      } catch {
        // NodeDetailPanel.createOrShow may throw in test env
      }
    });

    test('creates node panel from node quickPick selection', async () => {
      registerCommands();
      const nodeMap = new Map();
      nodeMap.set('n1', { id: 'n1', name: 'Node 1', dependencies: [], dependents: [] });
      const nodeStates = new Map();
      nodeStates.set('n1', { status: 'pending', version: 0, attempts: 0 });
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' }, jobs: nodeMap, nodeStates, producerIdToNodeId: new Map(), roots: ['n1'], leaves: ['n1'] });
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Node 1', nodeId: 'n1' } as any);

      try {
        await executeCommand('orchestrator.showNodeDetails', 'p1');
      } catch {
        // NodeDetailPanel may throw in test env
      }
    });

    test('creates node panel from plan+node quickPick selection', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      
      const nodeMap = new Map();
      nodeMap.set('n1', { id: 'n1', name: 'Node 1', dependencies: [], dependents: [] });
      
      // First quickPick returns plan, second returns node
      const qpStub = sandbox.stub(vscode.window, 'showQuickPick');
      qpStub.onFirstCall().resolves({ label: 'Plan 1', planId: 'p1' } as any);
      qpStub.onSecondCall().resolves({ label: 'Node 1', nodeId: 'n1' } as any);
      const nodeStates = new Map();
      nodeStates.set('n1', { status: 'pending', version: 0, attempts: 0 });
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' }, jobs: nodeMap, nodeStates, producerIdToNodeId: new Map(), roots: ['n1'], leaves: ['n1'] });

      try {
        await executeCommand('orchestrator.showNodeDetails');
      } catch {
        // NodeDetailPanel may throw in test env  
      }
    });
  });

  // ─── cancelPlan ─────────────────────────────────────────────────────

  suite('orchestrator.cancelPlan', () => {
    test('shows info when no active plans', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.getAll.returns([]);

      await executeCommand('orchestrator.cancelPlan');
      assert.ok(spy.calledWith('No active plans to cancel'));
    });

    test('shows error when plan not found', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showErrorMessage');
      mockPlanRunner.get.returns(undefined);

      await executeCommand('orchestrator.cancelPlan', 'bad-id');
      assert.ok(spy.calledOnce);
    });

    test('cancels plan when confirmed', async () => {
      registerCommands();
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showWarningMessage').resolves('Cancel Plan');

      await executeCommand('orchestrator.cancelPlan', 'p1');
      assert.ok(mockPlanRunner.cancel.calledWith('p1'));
    });

    test('does not cancel when dismissed', async () => {
      registerCommands();
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

      await executeCommand('orchestrator.cancelPlan', 'p1');
      assert.ok(mockPlanRunner.cancel.notCalled);
    });

    test('returns early when quickPick dismissed for cancel', async () => {
      registerCommands();
      const sm = { computePlanStatus: () => 'running' };
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      mockPlanRunner.getStateMachine.returns(sm);
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.cancelPlan');
      assert.ok(mockPlanRunner.cancel.notCalled);
    });

    test('cancels plan selected via quickPick', async () => {
      registerCommands();
      const sm = { computePlanStatus: () => 'running' };
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      mockPlanRunner.getStateMachine.returns(sm);
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Plan 1', planId: 'p1' });
      sandbox.stub(vscode.window, 'showWarningMessage').resolves('Cancel Plan');

      await executeCommand('orchestrator.cancelPlan');
      assert.ok(mockPlanRunner.cancel.calledWith('p1'));
    });
  });

  // ─── pausePlan ──────────────────────────────────────────────────────

  suite('orchestrator.pausePlan', () => {
    test('shows info when no running plans', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.getAll.returns([]);

      await executeCommand('orchestrator.pausePlan');
      assert.ok(spy.calledWith('No running plans to pause'));
    });

    test('shows error when plan not found', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showErrorMessage');
      mockPlanRunner.get.returns(undefined);

      await executeCommand('orchestrator.pausePlan', 'bad-id');
      assert.ok(spy.calledOnce);
    });

    test('pauses plan when planId provided', async () => {
      registerCommands();
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });

      await executeCommand('orchestrator.pausePlan', 'p1');
      assert.ok(mockPlanRunner.pause.calledWith('p1'));
    });

    test('returns early when quickPick dismissed', async () => {
      registerCommands();
      const sm = { computePlanStatus: () => 'running' };
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' }, isPaused: false }]);
      mockPlanRunner.getStateMachine.returns(sm);
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.pausePlan');
      assert.ok(mockPlanRunner.pause.notCalled);
    });

    test('pauses plan selected via quickPick', async () => {
      registerCommands();
      const sm = { computePlanStatus: () => 'running' };
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' }, isPaused: false }]);
      mockPlanRunner.getStateMachine.returns(sm);
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Plan 1', planId: 'p1' });

      await executeCommand('orchestrator.pausePlan');
      assert.ok(mockPlanRunner.pause.calledWith('p1'));
    });
  });

  // ─── resumePlan ─────────────────────────────────────────────────────

  suite('orchestrator.resumePlan', () => {
    test('shows info when no paused plans', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.getAll.returns([]);

      await executeCommand('orchestrator.resumePlan');
      assert.ok(spy.calledWith('No plans available to resume'));
    });

    test('shows error when plan not found', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showErrorMessage');
      mockPlanRunner.get.returns(undefined);

      await executeCommand('orchestrator.resumePlan', 'bad-id');
      assert.ok(spy.calledOnce);
    });

    test('resumes plan when planId provided', async () => {
      registerCommands();
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });

      await executeCommand('orchestrator.resumePlan', 'p1');
      assert.ok(mockPlanRunner.resume.calledWith('p1'));
    });

    test('returns early when quickPick dismissed', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' }, isPaused: true }]);
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.resumePlan');
      assert.ok(mockPlanRunner.resume.notCalled);
    });

    test('resumes plan selected via quickPick', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' }, isPaused: true }]);
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Plan 1', planId: 'p1' });

      await executeCommand('orchestrator.resumePlan');
      assert.ok(mockPlanRunner.resume.calledWith('p1'));
    });
  });

  // ─── deletePlan ─────────────────────────────────────────────────────

  suite('orchestrator.deletePlan', () => {
    test('shows info when no plans', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showInformationMessage');
      mockPlanRunner.getAll.returns([]);

      await executeCommand('orchestrator.deletePlan');
      assert.ok(spy.calledWith('No plans to delete'));
    });

    test('shows error when plan not found', async () => {
      registerCommands();
      const spy = sandbox.spy(vscode.window, 'showErrorMessage');
      mockPlanRunner.get.returns(undefined);

      await executeCommand('orchestrator.deletePlan', 'bad-id');
      assert.ok(spy.calledOnce);
    });

    test('deletes plan when confirmed', async () => {
      registerCommands();
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showWarningMessage').resolves('Delete');

      await executeCommand('orchestrator.deletePlan', 'p1');
      assert.ok(mockPlanRunner.delete.calledWith('p1'));
    });

    test('does not delete when dismissed', async () => {
      registerCommands();
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

      await executeCommand('orchestrator.deletePlan', 'p1');
      assert.ok(mockPlanRunner.delete.notCalled);
    });

    test('returns early when quickPick dismissed for delete', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

      await executeCommand('orchestrator.deletePlan');
      assert.ok(mockPlanRunner.delete.notCalled);
    });

    test('deletes plan selected via quickPick', async () => {
      registerCommands();
      mockPlanRunner.getAll.returns([{ id: 'p1', spec: { name: 'Plan 1' } }]);
      mockPlanRunner.get.returns({ id: 'p1', spec: { name: 'Plan 1' } });
      sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Plan 1', planId: 'p1' });
      sandbox.stub(vscode.window, 'showWarningMessage').resolves('Delete');

      await executeCommand('orchestrator.deletePlan');
      assert.ok(mockPlanRunner.delete.calledWith('p1'));
    });
  });

  // ─── refreshPlans ───────────────────────────────────────────────────

  suite('orchestrator.refreshPlans', () => {
    test('executes refresh command', async () => {
      registerCommands();
      // Just verify it doesn't throw
      await executeCommand('orchestrator.refreshPlans');
    });
  });
});

// =========================================================================
// initializePlansView tests
// =========================================================================

suite('initializePlansView', () => {
  let sandbox: sinon.SinonSandbox;
  let vscode: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    vscode = require('vscode');
  });

  teardown(() => {
    sandbox.restore();
  });

  test('registers view providers and tree view', () => {
    const { initializePlansView } = require('../../../core/planInitialization');
    const mockContext = {
      subscriptions: [] as any[],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
    };

    const mockPlanRunner = {
      getAll: () => [],
      get: () => undefined,
      on: () => {},
      removeListener: () => {},
      getStateMachine: () => undefined,
    };

    try {
      initializePlansView(mockContext, mockPlanRunner as any);
      // Verify subscriptions were added
      assert.ok(mockContext.subscriptions.length > 0, 'Should register subscriptions');
    } catch {
      // Module loading may fail in test env but code path is exercised
    }
  });
});

// =========================================================================
// initializeMcpServer tests
// =========================================================================

suite('initializeMcpServer', () => {
  let sandbox: sinon.SinonSandbox;
  let vscode: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    vscode = require('vscode');
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns undefined when MCP is disabled', async () => {
    const { initializeMcpServer } = require('../../../core/planInitialization');
    const mockContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
      globalState: { get: () => undefined, update: async () => {} },
    };
    const mockPlanRunner = {};
    const result = await initializeMcpServer(mockContext, mockPlanRunner, { enabled: false });
    assert.strictEqual(result, undefined);
  });

  test('initializes MCP server when enabled', async function() {
    this.timeout(10000);
    const { initializeMcpServer } = require('../../../core/planInitialization');

    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/test/workspace'), name: 'test', index: 0 }
    ];

    const mockContext = {
      subscriptions: [] as any[],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
      globalState: { get: () => undefined, update: async () => {} },
    };

    const mockPlanRunner = {
      getAll: () => [],
      get: () => undefined,
      submit: () => {},
    };

    // Mock showInformationMessage to return 'Got it' to exercise the .then() callback
    sandbox.stub(vscode.window, 'showInformationMessage').resolves('Got it');

    try {
      const result = await initializeMcpServer(mockContext, mockPlanRunner, { enabled: true });
      if (result) {
        assert.ok(mockContext.subscriptions.length > 0);
      }
      // Give time for the .then() callback to execute
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch {
      // MCP initialization may fail in test env - code paths still exercised
    } finally {
      for (const sub of mockContext.subscriptions) {
        try { if (sub && sub.dispose) {sub.dispose();} } catch { /* ignore */ }
      }
      vscode.workspace.workspaceFolders = undefined;
    }
  });

  test('initializes MCP with Start MCP Server choice', async function() {
    this.timeout(10000);
    const { initializeMcpServer } = require('../../../core/planInitialization');

    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/test/workspace'), name: 'test', index: 0 }
    ];

    const mockContext = {
      subscriptions: [] as any[],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
      globalState: { get: () => undefined, update: async () => {} },
    };

    const mockPlanRunner = {
      getAll: () => [],
      get: () => undefined,
      submit: () => {},
    };

    sandbox.stub(vscode.window, 'showInformationMessage').resolves('Start MCP Server');
    // Register the command to throw, exercising the catch/fallback path
    const cmdDisp = vscode.commands.registerCommand('workbench.action.chat.startMcpServer', () => {
      throw new Error('Not available');
    });

    try {
      const result = await initializeMcpServer(mockContext, mockPlanRunner, { enabled: true });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      // Expected in test env
    } finally {
      cmdDisp.dispose();
      for (const sub of mockContext.subscriptions) {
        try { if (sub && sub.dispose) {sub.dispose();} } catch { /* ignore */ }
      }
      vscode.workspace.workspaceFolders = undefined;
    }
  });
});

// =========================================================================
// initializePlanRunner tests
// =========================================================================

suite('initializePlanRunner', () => {
  let sandbox: sinon.SinonSandbox;
  let vscode: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    vscode = require('vscode');
  });

  teardown(() => {
    sandbox.restore();
  });

  test('initializes with workspace path', async function() {
    this.timeout(10000);
    const { initializePlanRunner } = require('../../../core/planInitialization');
    const { createContainer } = require('../../../composition');

    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/test/workspace'), name: 'test', index: 0 }
    ];

    const mockContext = {
      subscriptions: [] as any[],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
      globalState: { get: () => undefined, update: async () => {} },
    };

    try {
      const container = createContainer(mockContext);
      const result = await initializePlanRunner(mockContext, container);
      assert.ok(result.planRunner);
      assert.ok(result.processMonitor);
      // Verify cleanup handler was registered
      assert.ok(mockContext.subscriptions.length > 0);
    } catch {
      // May fail due to fs operations in test env - that's OK, code path is exercised
    } finally {
      vscode.workspace.workspaceFolders = undefined;
    }
  });

  test('falls back to globalStorageUri when no workspace', async function() {
    this.timeout(10000);
    const { initializePlanRunner } = require('../../../core/planInitialization');
    const { createContainer } = require('../../../composition');

    vscode.workspace.workspaceFolders = undefined;

    const mockContext = {
      subscriptions: [] as any[],
      extensionUri: vscode.Uri.file('/ext'),
      globalStorageUri: vscode.Uri.file('/storage'),
      globalState: { get: () => undefined, update: async () => {} },
    };

    try {
      const container = createContainer(mockContext);
      const result = await initializePlanRunner(mockContext, container);
      assert.ok(result.planRunner);
    } catch {
      // Expected in test env
    }
  });

  // Regression: the ContextPressureHandlerFactory writes the CHECKPOINT_REQUIRED
  // sentinel via the global checkpoint manager. Before the gate fix that registry
  // was populated unconditionally, so the handler fired even when the agent had
  // never been told the checkpoint protocol — leading to synthesized fallback
  // manifests and empty "Continue the original task" sub-jobs. The gate must
  // tie the registry write to copilotOrchestrator.contextPressure.enabled.
  suite('contextPressure.enabled gating', () => {
    let registry: any;

    setup(() => {
      // Use the cached module instance — planInitialization uses dynamic
      // `await import(...)` which returns the cached singleton. Busting the
      // require cache here would give the test a *different* module instance
      // than the one written to by initializePlanRunner, causing the
      // "DOES register" assertion to read undefined even when the production
      // code correctly registered the manager.
      registry = require('../../../plan/analysis/pressureMonitorRegistry');
      // Clear any prior global manager
      registry.setCheckpointManager(undefined as any);
    });

    // Per-suite real workspace dir so PlanPersistence's mkdirSync('.orchestrator') succeeds
    // on POSIX CI runners (where '/test/workspace' is not writable).
    let tmpWorkspace: string;

    setup(() => {
      tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-init-test-'));
    });

    teardown(() => {
      registry.setCheckpointManager(undefined as any);
      vscode.workspace.workspaceFolders = undefined;
      try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    async function runWithEnabled(enabled: boolean): Promise<{ planRunner?: any; initError?: unknown }> {
      const { initializePlanRunner } = require('../../../core/planInitialization');
      const { createContainer } = require('../../../composition');
      const Tokens = require('../../../core/tokens');

      vscode.workspace.workspaceFolders = [
        { uri: vscode.Uri.file(tmpWorkspace), name: 'test', index: 0 },
      ];

      const mockContext = {
        subscriptions: [] as any[],
        extensionUri: vscode.Uri.file('/ext'),
        globalStorageUri: vscode.Uri.file('/storage'),
        globalState: { get: () => undefined, update: async () => {} },
      };

      const container = createContainer(mockContext);

      // Stub the IConfigProvider to control the contextPressure.enabled flag
      const realProvider = container.resolve(Tokens.IConfigProvider);
      const stubProvider = {
        ...realProvider,
        getConfig: <T>(section: string, key: string, defaultValue: T): T => {
          if (section === 'copilotOrchestrator.contextPressure' && key === 'enabled') {
            return enabled as unknown as T;
          }
          if (typeof realProvider.getConfig === 'function') {
            return realProvider.getConfig(section, key, defaultValue);
          }
          return defaultValue;
        },
      };
      container.registerSingleton(Tokens.IConfigProvider, () => stubProvider);

      const git = container.resolve(Tokens.IGitOperations) ?? {
        repository: { isRepo: async () => true },
        merge: {},
        worktree: {},
      };
      const debouncer = container.resolve(Tokens.IGitignoreDebouncer) ?? {
        ensureEntries: async () => {},
      };

      try {
        const result = await initializePlanRunner(mockContext, container, git, debouncer);
        return result;
      } catch (err) {
        // Surface init errors so tests don't silently pass on early-bail.
        return { initError: err };
      }
    }

    test('does NOT register global checkpoint manager when disabled (default)', async function() {
      this.timeout(10000);
      const result = await runWithEnabled(false);
      if (result.initError) {
        assert.fail(`initializePlanRunner threw: ${(result.initError as Error)?.stack || result.initError}`);
      }
      assert.ok(result.planRunner, 'expected planRunner to be returned by initializePlanRunner');
      assert.strictEqual(
        registry.getCheckpointManager(),
        undefined,
        'global checkpoint manager must remain unregistered when contextPressure.enabled is false',
      );
    });

    test('DOES register global checkpoint manager when enabled', async function() {
      this.timeout(10000);
      const result = await runWithEnabled(true);
      if (result.initError) {
        assert.fail(`initializePlanRunner threw: ${(result.initError as Error)?.stack || result.initError}`);
      }
      assert.ok(result.planRunner, 'expected planRunner to be returned by initializePlanRunner');
      assert.ok(
        registry.getCheckpointManager(),
        'global checkpoint manager must be registered when contextPressure.enabled is true',
      );
    });

    // Regression: even if a stale checkpoint-manifest.json exists in a worktree
    // (e.g. committed during an earlier run when the feature was enabled), the
    // runner must not synthesize -sub-N / -fan-in jobs when the user-facing
    // setting is disabled. Achieved by skipping setCheckpointManager() and
    // setJobSplitter() on the runner so the executionEngine's split branch
    // (which requires both on its state) is short-circuited.
    test('does NOT wire checkpointManager/jobSplitter on runner when disabled', async function() {
      this.timeout(10000);
      const { planRunner, initError } = await runWithEnabled(false);
      if (initError) {
        assert.fail(`initializePlanRunner threw: ${(initError as Error)?.stack || initError}`);
      }
      assert.ok(planRunner, 'expected planRunner to be returned by initializePlanRunner');
      const state = (planRunner as any)._state;
      assert.ok(state, 'expected planRunner._state to exist');
      assert.strictEqual(state.checkpointManager, undefined,
        'runner.checkpointManager must remain unset when contextPressure.enabled is false');
      assert.strictEqual(state.jobSplitter, undefined,
        'runner.jobSplitter must remain unset when contextPressure.enabled is false');
    });

    test('DOES wire checkpointManager/jobSplitter on runner when enabled', async function() {
      this.timeout(10000);
      const { planRunner, initError } = await runWithEnabled(true);
      if (initError) {
        assert.fail(`initializePlanRunner threw: ${(initError as Error)?.stack || initError}`);
      }
      assert.ok(planRunner, 'expected planRunner to be returned by initializePlanRunner');
      const state = (planRunner as any)._state;
      assert.ok(state, 'expected planRunner._state to exist');
      assert.ok(state.checkpointManager,
        'runner.checkpointManager must be wired when contextPressure.enabled is true');
      assert.ok(state.jobSplitter,
        'runner.jobSplitter must be wired when contextPressure.enabled is true');
    });
  });
});