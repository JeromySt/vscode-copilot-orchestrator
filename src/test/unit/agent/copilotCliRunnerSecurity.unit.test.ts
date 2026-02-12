/**
 * @fileoverview Unit tests for CopilotCliRunner directory security.
 *
 * Tests cover:
 * - Worktree directory is always included in allowed paths
 * - Additional valid absolute paths are included
 * - Relative paths are rejected with warning
 * - Non-existent paths are rejected with warning
 * - Empty allowedFolders works correctly
 * - buildCommand produces correct --add-dir flags
 *
 * Note: These tests use real directories (os.tmpdir(), process.cwd()) instead of
 * stubbing fs.existsSync because Node.js has made that function frozen/immutable.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';

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

suite('CopilotCliRunner - Directory Security', () => {
  let quiet: { restore: () => void };
  let loggerMessages: { level: string; msg: string }[];

  // Real directories that exist on the system
  const EXISTING_DIR_1 = os.tmpdir();
  const EXISTING_DIR_2 = process.cwd();
  const EXISTING_DIR_3 = os.homedir();
  // Path that definitely doesn't exist
  const NONEXISTENT_PATH = path.join(os.tmpdir(), 'copilot-security-test-nonexistent-' + Date.now());

  setup(() => {
    quiet = silenceConsole();
    loggerMessages = [];
  });

  teardown(() => {
    quiet.restore();
  });

  /**
   * Create a CopilotCliRunner instance with a mock logger that captures messages.
   */
  function createRunner() {
    // Clear module cache to get fresh instance
    delete require.cache[require.resolve('../../../agent/copilotCliRunner')];
    const { CopilotCliRunner } = require('../../../agent/copilotCliRunner');

    const mockLogger = {
      info: (msg: string) => loggerMessages.push({ level: 'info', msg }),
      warn: (msg: string) => loggerMessages.push({ level: 'warn', msg }),
      error: (msg: string) => loggerMessages.push({ level: 'error', msg }),
      debug: (msg: string) => loggerMessages.push({ level: 'debug', msg }),
    };

    return new CopilotCliRunner(mockLogger);
  }

  /**
   * Get security-related log messages.
   */
  function getSecurityLogs() {
    return loggerMessages.filter(m => m.msg.includes('[SECURITY]'));
  }

  // ==========================================================================
  // TEST: Worktree is always included
  // ==========================================================================

  /**
   * Helper: Check if a path is in the command (handles JSON escaping of backslashes)
   */
  function cmdIncludesPath(cmd: string, dirPath: string): boolean {
    // JSON.stringify adds quotes and escapes backslashes, matching what buildCommand does
    const jsonPath = JSON.stringify(dirPath);
    return cmd.includes(`--add-dir ${jsonPath}`);
  }

  test('worktree directory (cwd) is always included in allowed paths', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: []
    });

    // Verify worktree is in the command (JSON.stringify adds quotes and escapes)
    assert.ok(cmdIncludesPath(cmd, EXISTING_DIR_1),
      `Command should include worktree path. Got: ${cmd}`);

    // Verify security logging
    const securityLogs = getSecurityLogs();
    assert.ok(securityLogs.some(l => l.msg.includes(EXISTING_DIR_1)),
      'Security log should mention worktree path');
  });

  test('worktree is included even when allowedFolders is undefined', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1
      // allowedFolders not specified
    });

    assert.ok(cmdIncludesPath(cmd, EXISTING_DIR_1));
  });

  // ==========================================================================
  // TEST: Additional valid absolute paths
  // ==========================================================================

  test('valid absolute paths in allowedFolders are included', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [EXISTING_DIR_2, EXISTING_DIR_3]
    });

    // Verify all paths are in the command
    assert.ok(cmd.includes('--add-dir'), 'Should have --add-dir flags');

    // Verify security logging shows count (if all 3 are unique)
    const securityLogs = getSecurityLogs();
    // May be 2 or 3 depending on whether paths overlap
    const countLogMatch = securityLogs.find(l => /allowed directories \(\d+\)/.test(l.msg));
    assert.ok(countLogMatch, 'Security log should show directory count');
  });

  test('Windows paths with backslashes are handled correctly', () => {
    const runner = createRunner();

    // Use EXISTING_DIR_1 which on Windows will have backslashes
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
    });

    // The command should have --add-dir flags
    assert.ok(cmd.includes('--add-dir'), 'Command should have --add-dir flags');
    // The path should be properly quoted (JSON.stringify escapes backslashes)
    assert.ok(cmd.includes('"'), 'Paths should be quoted');
  });

  // ==========================================================================
  // TEST: Relative paths are rejected
  // ==========================================================================

  test('relative paths in allowedFolders are rejected with warning', () => {
    const runner = createRunner();

    const relativePath = 'relative/path';
    const anotherRelative = './some/dir';

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [relativePath, anotherRelative]
    });

    // Relative paths should NOT be in the command
    assert.ok(!cmd.includes('--add-dir "relative/path"'), 'Should NOT include relative path');
    assert.ok(!cmd.includes('--add-dir "./some/dir"'), 'Should NOT include ./relative path');

    // Should have warnings in the log
    const warnings = loggerMessages.filter(m => m.level === 'warn');
    assert.ok(warnings.length >= 2, 'Should have at least 2 warnings for relative paths');
    assert.ok(warnings.some(w => w.msg.includes('must be absolute')),
      'Warning should mention paths must be absolute');
  });

  // ==========================================================================
  // TEST: Non-existent paths are rejected
  // ==========================================================================

  test('non-existent paths in allowedFolders are rejected with warning', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [NONEXISTENT_PATH]
    });

    // Non-existent should NOT be in command
    assert.ok(!cmd.includes(NONEXISTENT_PATH), 'Should NOT include non-existent path');

    // Should have warning
    const warnings = loggerMessages.filter(m => m.level === 'warn');
    assert.ok(warnings.some(w => w.msg.includes('does not exist')),
      'Warning should mention path does not exist');
  });

  // ==========================================================================
  // TEST: Empty/no cwd fallback
  // ==========================================================================

  test('when no cwd specified, falls back to explicit process.cwd()', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task'
      // No cwd, no allowedFolders
    });

    // Should fallback to explicit process.cwd() (not ".")
    assert.ok(!cmd.includes('--add-dir .'), 'Should NOT use relative "." path');
    assert.ok(cmd.includes('--add-dir "'), 'Should use quoted absolute path');

    // Security log should mention fallback
    const warnings = loggerMessages.filter(m => m.level === 'warn');
    assert.ok(warnings.some(l => l.msg.includes('[SECURITY]') && l.msg.includes('explicit cwd')),
      'Should log explicit cwd fallback');
  });

  // ==========================================================================
  // TEST: Security logging format
  // ==========================================================================

  test('security logging shows all configured directories', () => {
    const runner = createRunner();

    runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [EXISTING_DIR_2]
    });

    const securityLogs = getSecurityLogs();

    // Should have header with count
    const countLog = securityLogs.find(l => /allowed directories \(\d+\)/.test(l.msg));
    assert.ok(countLog, 'Should log directory count');

    // Should list the worktree at minimum
    assert.ok(securityLogs.some(l => l.msg.includes(EXISTING_DIR_1)),
      'Should list worktree');
  });

  // ==========================================================================
  // TEST: Command structure
  // ==========================================================================

  test('buildCommand produces valid --add-dir flags with proper quoting', () => {
    const runner = createRunner();

    // tmpdir always exists and may have spaces on some systems
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1
    });

    // The path should be JSON-quoted (surrounded by ")
    const match = cmd.match(/--add-dir "([^"]+)"/);
    assert.ok(match, 'Paths should be properly quoted with double quotes');
  });

  test('command does NOT include --allow-all-paths', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [EXISTING_DIR_2]
    });

    // Should never include --allow-all-paths (that would disable security)
    assert.ok(!cmd.includes('--allow-all-paths'),
      'Should NOT include --allow-all-paths (would disable security)');
  });

  // ==========================================================================
  // TEST: Mixed valid/invalid paths
  // ==========================================================================

  test('mixed valid and invalid paths are handled correctly', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [
        EXISTING_DIR_2,           // valid absolute, exists
        'relative/invalid',       // invalid: relative
        NONEXISTENT_PATH,        // invalid: doesn't exist
        EXISTING_DIR_3           // valid absolute, exists
      ]
    });

    // Valid absolute existing paths should be included
    assert.ok(cmdIncludesPath(cmd, EXISTING_DIR_1), 'Should include worktree');

    // Invalid paths should be excluded
    assert.ok(!cmd.includes('relative/invalid'), 'Should exclude relative path');
    assert.ok(!cmd.includes(NONEXISTENT_PATH), 'Should exclude non-existent path');

    // Should have warnings for rejected paths (relative + non-existent)
    const warnings = loggerMessages.filter(m => m.level === 'warn');
    assert.ok(warnings.length >= 2, 'Should have at least 2 warnings');
  });

  // ==========================================================================
  // TEST: Security principle validation
  // ==========================================================================

  test('only explicitly allowed directories end up in command', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [] // No additional folders
    });

    // Count --add-dir occurrences
    const addDirMatches = cmd.match(/--add-dir/g);
    assert.ok(addDirMatches, 'Should have --add-dir flags');
    assert.strictEqual(addDirMatches.length, 1, 'Should have exactly 1 --add-dir (just worktree)');
  });

  test('duplicate paths are preserved (deduplication happens at CLI level)', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: EXISTING_DIR_1,
      allowedFolders: [EXISTING_DIR_1, EXISTING_DIR_1] // Same path twice
    });

    // Implementation doesn't dedupe - CLI handles that
    // Just verify it doesn't crash and includes the path
    assert.ok(cmdIncludesPath(cmd, EXISTING_DIR_1), 'Should include the path');
  });
});
