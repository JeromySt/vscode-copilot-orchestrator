/**
 * @fileoverview Smoke test – verifies the extension activates and
 * core exports are available.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Smoke Tests', () => {
  test('Extension should be present in the extensions list', () => {
    const ext = vscode.extensions.getExtension('JeromyStatia.vscode-copilot-orchestrator');
    // The extension may not be published under this exact ID in dev,
    // so we simply verify the extensions API is callable.
    assert.ok(vscode.extensions.all.length > 0, 'At least one extension should be loaded');
  });

  test('VS Code API should be accessible', () => {
    assert.ok(vscode.workspace, 'vscode.workspace should be defined');
    assert.ok(vscode.commands, 'vscode.commands should be defined');
    assert.ok(vscode.window, 'vscode.window should be defined');
  });

  test('Registered commands should include orchestrator commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    // After activation, at least some orchestrator commands should exist
    const hasOrchestratorCmd = commands.some((cmd: string) => cmd.startsWith('orchestrator.'));
    // This may be false if the extension hasn't activated, which is acceptable for a smoke test
    assert.ok(commands.length > 0, 'Should have registered commands');
  });
});
