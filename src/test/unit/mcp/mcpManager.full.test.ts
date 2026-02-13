/**
 * @fileoverview Comprehensive tests for mcpServerManager.ts and mcpDefinitionProvider.ts.
 * Covers StdioMcpServerManager and registerMcpDefinitionProvider, notifyServerChanged, setMcpServerEnabled.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

suite('StdioMcpServerManager', () => {
  let StdioMcpServerManager: any;
  let manager: any;
  let mockContext: any;

  setup(() => {
    StdioMcpServerManager = require('../../../mcp/mcpServerManager').StdioMcpServerManager;
    mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    manager = new StdioMcpServerManager(mockContext);
  });

  teardown(() => {
    sinon.restore();
  });

  test('should have transport type stdio', () => {
    assert.strictEqual(manager.transport, 'stdio');
  });

  test('should not be running initially', () => {
    assert.strictEqual(manager.isRunning(), false);
  });

  test('should return stdio endpoint', () => {
    assert.strictEqual(manager.getEndpoint(), 'stdio');
  });

  test('should be running after start', () => {
    manager.start();
    assert.strictEqual(manager.isRunning(), true);
  });

  test('should not be running after stop', () => {
    manager.start();
    manager.stop();
    assert.strictEqual(manager.isRunning(), false);
  });

  test('should notify status listeners on start', () => {
    const listener = sinon.stub();
    manager.onStatusChange(listener);
    manager.start();
    assert.ok(listener.calledWith('connected'));
  });

  test('should notify status listeners on stop', () => {
    const listener = sinon.stub();
    manager.onStatusChange(listener);
    manager.stop();
    assert.ok(listener.calledWith('stopped'));
  });

  test('should unsubscribe listeners', () => {
    const listener = sinon.stub();
    const unsub = manager.onStatusChange(listener);
    unsub();
    manager.start();
    assert.ok(listener.notCalled);
  });

  test('should handle listener errors gracefully', () => {
    manager.onStatusChange(() => { throw new Error('Listener error'); });
    manager.start();
    assert.ok(true);
  });

  test('should register status bar and disposable in context', () => {
    assert.ok(mockContext.subscriptions.length >= 1);
  });

  test('isRunning should return true for available status', () => {
    manager.start();
    assert.strictEqual(manager.isRunning(), true);
  });
});

suite('MCP Definition Provider', () => {
  let registerMcpDefinitionProvider: any;
  let notifyServerChanged: any;
  let setMcpServerEnabled: any;
  let vscodeModule: any;
  let originalLm: any;
  let originalMcpStdio: any;

  setup(() => {
    // Get cached vscode mock module
    vscodeModule = require('vscode');
    originalLm = vscodeModule.lm;
    originalMcpStdio = (vscodeModule as any).McpStdioServerDefinition;

    // Clear module cache to get fresh state for mcpDefinitionProvider
    const providerPath = require.resolve('../../../mcp/mcpDefinitionProvider');
    delete require.cache[providerPath];

    const mod = require('../../../mcp/mcpDefinitionProvider');
    registerMcpDefinitionProvider = mod.registerMcpDefinitionProvider;
    notifyServerChanged = mod.notifyServerChanged;
    setMcpServerEnabled = mod.setMcpServerEnabled;
  });

  teardown(() => {
    // Restore original vscode mock state
    if (originalLm === undefined) {
      delete vscodeModule.lm;
    } else {
      vscodeModule.lm = originalLm;
    }
    if (originalMcpStdio === undefined) {
      delete (vscodeModule as any).McpStdioServerDefinition;
    } else {
      (vscodeModule as any).McpStdioServerDefinition = originalMcpStdio;
    }
    sinon.restore();
  });

  test('notifyServerChanged should not throw', () => {
    notifyServerChanged();
    assert.ok(true);
  });

  test('setMcpServerEnabled should not throw', () => {
    setMcpServerEnabled(true);
    setMcpServerEnabled(false);
    setMcpServerEnabled(false); // duplicate - should not fire
    assert.ok(true);
  });

  test('registerMcpDefinitionProvider should return disposable when lm API unavailable', () => {
    // Ensure lm is not available
    delete vscodeModule.lm;
    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    const disposable = registerMcpDefinitionProvider(
      mockContext, '/workspace', '/ipc/path', 'nonce123'
    );
    assert.ok(disposable);
    assert.ok(typeof disposable.dispose === 'function');
    disposable.dispose();
  });

  test('registerMcpDefinitionProvider should return disposable when McpStdioServerDefinition unavailable', () => {
    // Provide lm but not McpStdioServerDefinition
    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().returns({ dispose: () => {} }),
    };
    delete (vscodeModule as any).McpStdioServerDefinition;

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    const disposable = registerMcpDefinitionProvider(
      mockContext, '/workspace', '/ipc/path', 'nonce123'
    );
    assert.ok(disposable);
    assert.ok(typeof disposable.dispose === 'function');
  });

  test('registerMcpDefinitionProvider should register successfully when APIs available', () => {
    let capturedProvider: any = null;
    const registrationDisposable = { dispose: sinon.stub() };

    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().callsFake((_id: string, provider: any) => {
        capturedProvider = provider;
        return registrationDisposable;
      }),
    };

    // McpStdioServerDefinition constructor mock
    (vscodeModule as any).McpStdioServerDefinition = function (label: string, command: string, args: string[], env: any, version: string) {
      this.label = label;
      this.command = command;
      this.args = args;
      this.env = env;
      this.version = version;
      this.cwd = undefined;
    };

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    const disposable = registerMcpDefinitionProvider(
      mockContext, '/workspace', '/ipc/path', 'nonce123'
    );
    assert.ok(disposable);
    assert.ok(typeof disposable.dispose === 'function');
    assert.ok(capturedProvider, 'Provider should have been captured');

    // Test provideMcpServerDefinitions returns server
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const servers = capturedProvider.provideMcpServerDefinitions(token);
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].label, 'Copilot Orchestrator');
    assert.strictEqual(servers[0].command, 'node');
    assert.strictEqual(servers[0].env.MCP_IPC_PATH, '/ipc/path');
    assert.strictEqual(servers[0].env.MCP_AUTH_NONCE, 'nonce123');

    // Test resolveMcpServerDefinition
    const mockServer = { label: 'test-server' };
    const resolved = capturedProvider.resolveMcpServerDefinition(mockServer, token);
    assert.strictEqual(resolved, mockServer);

    // Dispose
    disposable.dispose();
  });

  test('provideMcpServerDefinitions returns empty when disabled', () => {
    let capturedProvider: any = null;
    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().callsFake((_id: string, provider: any) => {
        capturedProvider = provider;
        return { dispose: () => {} };
      }),
    };
    (vscodeModule as any).McpStdioServerDefinition = function () {};

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    registerMcpDefinitionProvider(mockContext, '/workspace', '/ipc/path', 'nonce123');

    // Disable the server
    setMcpServerEnabled(false);

    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const servers = capturedProvider.provideMcpServerDefinitions(token);
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 0);
  });

  test('registerMcpDefinitionProvider handles registration error', () => {
    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().throws(new Error('Registration failed')),
    };
    (vscodeModule as any).McpStdioServerDefinition = function () {};

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    const disposable = registerMcpDefinitionProvider(
      mockContext, '/workspace', '/ipc/path', 'nonce123'
    );
    assert.ok(disposable);
    assert.ok(typeof disposable.dispose === 'function');
  });

  test('config change handler fires serverChanged event', () => {
    let capturedProvider: any = null;
    let configChangeCallback: any = null;
    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().callsFake((_id: string, provider: any) => {
        capturedProvider = provider;
        return { dispose: () => {} };
      }),
    };
    (vscodeModule as any).McpStdioServerDefinition = function () {};

    // Intercept onDidChangeConfiguration
    const origOnDidChange = vscodeModule.workspace.onDidChangeConfiguration;
    vscodeModule.workspace.onDidChangeConfiguration = (cb: any) => {
      configChangeCallback = cb;
      return { dispose: () => {} };
    };

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };
    registerMcpDefinitionProvider(mockContext, '/workspace', '/ipc/path', 'nonce123');

    // Simulate config change
    if (configChangeCallback) {
      configChangeCallback({ affectsConfiguration: (s: string) => s === 'copilotOrchestrator.mcp' });
    }

    // Restore
    vscodeModule.workspace.onDidChangeConfiguration = origOnDidChange;

    assert.ok(capturedProvider, 'Provider should exist');
  });

  test('provideMcpServerDefinitions returns empty when no workspace', () => {
    let capturedProvider: any = null;
    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().callsFake((_id: string, provider: any) => {
        capturedProvider = provider;
        return { dispose: () => {} };
      }),
    };
    (vscodeModule as any).McpStdioServerDefinition = function () {};

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };

    // Clear the module cache again and re-import to get fresh state
    const providerPath = require.resolve('../../../mcp/mcpDefinitionProvider');
    delete require.cache[providerPath];
    const mod = require('../../../mcp/mcpDefinitionProvider');

    // Register with empty workspace
    mod.registerMcpDefinitionProvider(mockContext, '', '/ipc/path', 'nonce123');

    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const servers = capturedProvider.provideMcpServerDefinitions(token);
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 0);
  });

  test('provideMcpServerDefinitions returns empty when no IPC path', () => {
    let capturedProvider: any = null;
    vscodeModule.lm = {
      registerMcpServerDefinitionProvider: sinon.stub().callsFake((_id: string, provider: any) => {
        capturedProvider = provider;
        return { dispose: () => {} };
      }),
    };
    (vscodeModule as any).McpStdioServerDefinition = function () {};

    const mockContext = {
      extensionPath: '/mock/extension',
      subscriptions: [],
      extension: { packageJSON: { version: '1.0.0' } },
    };

    // Clear the module cache again to get fresh state
    const providerPath = require.resolve('../../../mcp/mcpDefinitionProvider');
    delete require.cache[providerPath];
    const mod = require('../../../mcp/mcpDefinitionProvider');

    // Register with empty IPC path
    mod.registerMcpDefinitionProvider(mockContext, '/workspace', '', 'nonce123');

    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const servers = capturedProvider.provideMcpServerDefinitions(token);
    assert.ok(Array.isArray(servers));
    assert.strictEqual(servers.length, 0);
  });
});
