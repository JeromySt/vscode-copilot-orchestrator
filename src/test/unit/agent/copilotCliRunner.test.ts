/**
 * @fileoverview Unit tests for Copilot CLI Runner - Folder Security
 *
 * Tests cover:
 * - buildCommand uses --allow-paths instead of --allow-all-paths
 * - buildCommand includes worktree path in allowed paths
 * - buildCommand handles additional allowedFolders
 * - buildCommand handles empty allowedFolders
 */

import * as assert from 'assert';
import * as path from 'path';
import { CopilotCliRunner } from '../../../agent/copilotCliRunner';

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
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Copilot CLI Runner - Folder Security', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  test('buildCommand uses --add-dir instead of --allow-all-paths', () => {
    const runner = new CopilotCliRunner();
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: __dirname  // Use real path that exists
    });
    
    assert.ok(cmd.includes('--add-dir'), 'Command should include --add-dir');
    assert.ok(!cmd.includes('--allow-all-paths'), 'Command should NOT include --allow-all-paths');
  });

  test('buildCommand includes worktree path in allowed paths', () => {
    const runner = new CopilotCliRunner();
    const testPath = __dirname;  // Use real path
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: testPath
    });
    
    // The path is JSON.stringify'd in the command, so check for quoted version
    const jsonQuotedPath = JSON.stringify(testPath);
    assert.ok(cmd.includes(jsonQuotedPath), `Command should include JSON-quoted worktree path: ${jsonQuotedPath}`);
  });

  test('buildCommand includes additional allowedFolders', () => {
    const runner = new CopilotCliRunner();
    const worktreePath = __dirname;
    const srcPath = path.resolve(__dirname, '..', '..', '..');  // Real path to src/
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: worktreePath,
      allowedFolders: [srcPath]
    });
    
    const normalizedWorktree = worktreePath;
    const normalizedSrc = path.resolve(srcPath);
    
    assert.ok(cmd.includes(JSON.stringify(normalizedWorktree)), `Command should include worktree path: ${normalizedWorktree}`);
    assert.ok(cmd.includes(JSON.stringify(normalizedSrc)), `Command should include src path: ${normalizedSrc}`);
  });

  test('buildCommand handles empty allowedFolders', () => {
    const runner = new CopilotCliRunner();
    const testPath = __dirname;
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: testPath,
      allowedFolders: []
    });
    
    // Should only include worktree
    assert.ok(cmd.includes(JSON.stringify(testPath)), 'Command should include worktree path');
    // Count occurrences of --add-dir (should be 1 for just the worktree)
    const matches = cmd.match(/--add-dir/g);
    assert.ok(matches, 'Should have --add-dir flag');
    assert.strictEqual(matches!.length, 1, 'Should have exactly one --add-dir flag');
  });

  test('buildCommand filters out non-existent paths', () => {
    const runner = new CopilotCliRunner();
    const worktreePath = __dirname;
    const existingPath = path.resolve(__dirname, '..', '..', '..');
    const nonExistentPath = '/absolutely/nonexistent/path/that/does/not/exist/12345';
    
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: worktreePath,
      allowedFolders: [existingPath, nonExistentPath]
    });
    
    const normalizedWorktree = worktreePath;
    const normalizedExisting = path.resolve(existingPath);
    
    assert.ok(cmd.includes(JSON.stringify(normalizedWorktree)), 'Command should include worktree path');
    assert.ok(cmd.includes(JSON.stringify(normalizedExisting)), 'Command should include existing path');
    assert.ok(!cmd.includes(nonExistentPath), 'Command should NOT include non-existent path');
  });

  test('buildCommand with no cwd and no allowedFolders uses current directory', () => {
    const runner = new CopilotCliRunner();
    const cmd = runner.buildCommand({
      task: 'test task'
    });
    
    // Should use fallback with explicit cwd via --add-dir
    assert.ok(cmd.includes('--add-dir'), 'Command should include --add-dir');
  });

  test('buildCommand includes all standard flags', () => {
    const runner = new CopilotCliRunner();
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: __dirname
    });
    
    assert.ok(cmd.includes('copilot'), 'Command should start with copilot');
    assert.ok(cmd.includes('-p'), 'Command should include -p flag');
    assert.ok(cmd.includes('--stream off'), 'Command should include --stream off');
    assert.ok(cmd.includes('--add-dir'), 'Command should include --add-dir');
    assert.ok(cmd.includes('--allow-all-tools'), 'Command should include --allow-all-tools');
  });

  test('buildCommand with multiple allowedFolders uses multiple --add-dir flags', () => {
    const runner = new CopilotCliRunner();
    const worktreePath = __dirname;
    const srcPath = path.resolve(__dirname, '..', '..', '..');
    const testPath = path.resolve(__dirname, '..');
    
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: worktreePath,
      allowedFolders: [srcPath, testPath]
    });
    
    // Count occurrences of --add-dir (should be 3: worktree + 2 additional)
    const matches = cmd.match(/--add-dir/g);
    assert.ok(matches, 'Should have --add-dir flags');
    assert.strictEqual(matches!.length, 3, 'Should have three --add-dir flags (worktree + 2 additional)');
  });
});
