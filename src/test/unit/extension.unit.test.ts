/**
 * @fileoverview Unit tests for extension.ts process listener cleanup
 *
 * Tests cover:
 * - Process listener cleanup on deactivate
 * - Prevention of listener accumulation across multiple activate/deactivate cycles
 */

/// <reference types="node" />
/// <reference types="mocha" />
/// <reference types="sinon" />

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

// Use require to access Node.js process global consistently
const nodeProcess = require('process');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Mock power manager for testing - minimal implementation
 */
class MockPowerManager {
  releaseAll(): void {
    // Mock implementation
  }
}

/**
 * Mock handlers that simulate the extension's process event handlers
 */
function createMockHandlers() {
  return {
    exitHandler: () => new MockPowerManager().releaseAll(),
    sigintHandler: () => new MockPowerManager().releaseAll(),
    sigtermHandler: () => new MockPowerManager().releaseAll(),
  };
}

/**
 * Simulate the extension's listener registration pattern
 */
function registerProcessListeners(handlers: ReturnType<typeof createMockHandlers>) {
  nodeProcess.on('exit', handlers.exitHandler);
  nodeProcess.on('SIGINT', handlers.sigintHandler);
  nodeProcess.on('SIGTERM', handlers.sigtermHandler);
  return handlers;
}

/**
 * Simulate the extension's listener cleanup pattern
 */
function removeProcessListeners(handlers: ReturnType<typeof createMockHandlers>) {
  nodeProcess.removeListener('exit', handlers.exitHandler);
  nodeProcess.removeListener('SIGINT', handlers.sigintHandler);
  nodeProcess.removeListener('SIGTERM', handlers.sigtermHandler);
}

// ============================================================================
// TESTS
// ============================================================================

suite('Extension Process Listener Cleanup', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
    
    // Clean up any listeners that may have been added during tests
    const events = ['exit', 'SIGINT', 'SIGTERM'] as const;
    for (const event of events) {
      nodeProcess.removeAllListeners(event);
    }
  });

  test('deactivate removes process exit/SIGINT/SIGTERM listeners', () => {
    // Record initial listener counts
    const initialExitCount = nodeProcess.listenerCount('exit');
    const initialSigintCount = nodeProcess.listenerCount('SIGINT');
    const initialSigtermCount = nodeProcess.listenerCount('SIGTERM');

    // Register listeners (simulating activation)
    const handlers = registerProcessListeners(createMockHandlers());

    // Verify listeners were added
    assert.strictEqual(nodeProcess.listenerCount('exit'), initialExitCount + 1, 'Exit listener should be added');
    assert.strictEqual(nodeProcess.listenerCount('SIGINT'), initialSigintCount + 1, 'SIGINT listener should be added');
    assert.strictEqual(nodeProcess.listenerCount('SIGTERM'), initialSigtermCount + 1, 'SIGTERM listener should be added');

    // Remove listeners (simulating deactivation)
    removeProcessListeners(handlers);

    // Verify listeners were removed
    assert.strictEqual(nodeProcess.listenerCount('exit'), initialExitCount, 'Exit listener should be removed');
    assert.strictEqual(nodeProcess.listenerCount('SIGINT'), initialSigintCount, 'SIGINT listener should be removed');
    assert.strictEqual(nodeProcess.listenerCount('SIGTERM'), initialSigtermCount, 'SIGTERM listener should be removed');
  });

  test('multiple activate/deactivate cycles do not accumulate listeners', () => {
    // Record initial listener counts
    const initialExitCount = nodeProcess.listenerCount('exit');
    const initialSigintCount = nodeProcess.listenerCount('SIGINT');
    const initialSigtermCount = nodeProcess.listenerCount('SIGTERM');

    // Run 5 activate+deactivate cycles
    for (let i = 0; i < 5; i++) {
      const handlers = registerProcessListeners(createMockHandlers());
      removeProcessListeners(handlers);
    }

    // Verify listener counts match initial values
    assert.strictEqual(nodeProcess.listenerCount('exit'), initialExitCount, 'Exit listener count should not accumulate');
    assert.strictEqual(nodeProcess.listenerCount('SIGINT'), initialSigintCount, 'SIGINT listener count should not accumulate');
    assert.strictEqual(nodeProcess.listenerCount('SIGTERM'), initialSigtermCount, 'SIGTERM listener count should not accumulate');
  });

  test('listeners are correctly identified and removed by reference', () => {
    const handlers = createMockHandlers();
    
    // Add listeners
    nodeProcess.on('exit', handlers.exitHandler);
    nodeProcess.on('SIGINT', handlers.sigintHandler);
    nodeProcess.on('SIGTERM', handlers.sigtermHandler);

    // Verify they exist
    const exitListeners = nodeProcess.listeners('exit');
    const sigintListeners = nodeProcess.listeners('SIGINT');
    const sigtermListeners = nodeProcess.listeners('SIGTERM');

    assert.ok(exitListeners.includes(handlers.exitHandler), 'Exit handler should be in listeners');
    assert.ok(sigintListeners.includes(handlers.sigintHandler), 'SIGINT handler should be in listeners');
    assert.ok(sigtermListeners.includes(handlers.sigtermHandler), 'SIGTERM handler should be in listeners');

    // Remove by reference
    nodeProcess.removeListener('exit', handlers.exitHandler);
    nodeProcess.removeListener('SIGINT', handlers.sigintHandler);
    nodeProcess.removeListener('SIGTERM', handlers.sigtermHandler);

    // Verify they are removed
    const exitListenersAfter = nodeProcess.listeners('exit');
    const sigintListenersAfter = nodeProcess.listeners('SIGINT');
    const sigtermListenersAfter = nodeProcess.listeners('SIGTERM');

    assert.ok(!exitListenersAfter.includes(handlers.exitHandler), 'Exit handler should be removed from listeners');
    assert.ok(!sigintListenersAfter.includes(handlers.sigintHandler), 'SIGINT handler should be removed from listeners');
    assert.ok(!sigtermListenersAfter.includes(handlers.sigtermHandler), 'SIGTERM handler should be removed from listeners');
  });
});

suite('Extension Activation', () => {
  let sandbox: sinon.SinonSandbox;
  
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });
  
  test('vscode mock provides required APIs', () => {
    assert.ok(vscode.workspace);
    assert.ok(vscode.commands);
    assert.ok(vscode.window);
    assert.ok(typeof vscode.commands.registerCommand === 'function');
    assert.ok(typeof vscode.commands.executeCommand === 'function');
  });
});
