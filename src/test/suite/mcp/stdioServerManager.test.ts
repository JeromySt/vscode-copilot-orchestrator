/**
 * @fileoverview Unit tests for StdioMcpServerManager
 *
 * Tests cover:
 * - Status transitions (start/stop)
 * - isRunning() reflects status
 * - getEndpoint() returns 'stdio'
 * - transport property is 'stdio'
 * - onStatusChange callback firing
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { StdioMcpServerManager } from '../../../mcp/mcpServerManager';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('StdioMcpServerManager', () => {

  function createManager(): StdioMcpServerManager {
    // Use the real VS Code extension context from the test host
    const context = {
      subscriptions: [] as vscode.Disposable[],
    } as unknown as vscode.ExtensionContext;
    return new StdioMcpServerManager(context);
  }

  test('transport is stdio', () => {
    const manager = createManager();
    assert.strictEqual(manager.transport, 'stdio');
  });

  test('getEndpoint returns stdio', () => {
    const manager = createManager();
    assert.strictEqual(manager.getEndpoint(), 'stdio');
  });

  test('isRunning is false initially', () => {
    const manager = createManager();
    assert.strictEqual(manager.isRunning(), false);
  });

  test('start sets isRunning to true', () => {
    const manager = createManager();
    manager.start();
    assert.strictEqual(manager.isRunning(), true);
  });

  test('stop sets isRunning to false', () => {
    const manager = createManager();
    manager.start();
    manager.stop();
    assert.strictEqual(manager.isRunning(), false);
  });

  test('onStatusChange fires on start', () => {
    const manager = createManager();
    const statuses: string[] = [];
    manager.onStatusChange((s) => statuses.push(s));
    manager.start();
    assert.deepStrictEqual(statuses, ['connected']);
  });

  test('onStatusChange fires on stop', () => {
    const manager = createManager();
    const statuses: string[] = [];
    manager.start();
    manager.onStatusChange((s) => statuses.push(s));
    manager.stop();
    assert.deepStrictEqual(statuses, ['stopped']);
  });

  test('unsubscribe removes listener', () => {
    const manager = createManager();
    const statuses: string[] = [];
    const unsub = manager.onStatusChange((s) => statuses.push(s));
    unsub();
    manager.start();
    assert.deepStrictEqual(statuses, []);
  });
});
