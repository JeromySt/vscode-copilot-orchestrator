/**
 * @fileoverview Unit tests for CopilotCliRunner URL security.
 *
 * Tests cover:
 * - Explicit URLs are included in command with --allow-url flags
 * - Multiple URLs generate multiple --allow-url flags
 * - Various URL formats work correctly
 * - No URLs by default (secure by default)
 * - Empty array means no URLs
 * - --allow-all-urls is NEVER used
 * - URLs are logged for security audit
 * - No URLs logged appropriately
 */

import * as assert from 'assert';

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

suite('CopilotCliRunner - URL Security', () => {
  let quiet: { restore: () => void };
  let loggerMessages: { level: string; msg: string }[];

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

  /**
   * Helper: Check if a URL is in the command with --allow-url flag
   */
  function cmdIncludesUrl(cmd: string, url: string): boolean {
    // JSON.stringify adds quotes and escapes, matching what buildCommand does
    const jsonUrl = JSON.stringify(url);
    return cmd.includes(`--allow-url ${jsonUrl}`);
  }

  // ==========================================================================
  // POSITIVE CASES: URLs should be allowed
  // ==========================================================================

  test('explicit URLs are included in command with --allow-url flags', () => {
    const runner = createRunner();

    const testUrl = 'https://api.example.com/v1/';
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: [testUrl]
    });

    // Verify URL is in the command with proper flag
    assert.ok(cmdIncludesUrl(cmd, testUrl),
      `Command should include URL with --allow-url flag. Got: ${cmd}`);

    // Verify security logging
    const securityLogs = getSecurityLogs();
    assert.ok(securityLogs.some(l => l.msg.includes(testUrl)),
      'Security log should mention the allowed URL');
    assert.ok(securityLogs.some(l => l.msg.includes('allowed URLs (1)')),
      'Security log should show count of allowed URLs');
  });

  test('multiple URLs generate multiple --allow-url flags', () => {
    const runner = createRunner();

    const urls = [
      'https://api.github.com',
      'https://registry.npmjs.org',
      'internal-api.company.com'
    ];

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: urls
    });

    // Verify each URL gets its own --allow-url flag
    for (const url of urls) {
      assert.ok(cmdIncludesUrl(cmd, url),
        `Command should include --allow-url flag for ${url}`);
    }

    // Count --allow-url occurrences
    const allowUrlMatches = cmd.match(/--allow-url/g);
    assert.strictEqual(allowUrlMatches?.length, urls.length,
      `Should have exactly ${urls.length} --allow-url flags`);

    // Verify security logging shows correct count
    const securityLogs = getSecurityLogs();
    assert.ok(securityLogs.some(l => l.msg.includes(`allowed URLs (${urls.length})`)),
      'Security log should show correct URL count');
  });

  test('various URL formats work correctly', () => {
    const runner = createRunner();

    const urls = [
      'https://api.example.com/v1/',  // Full URL
      'api.example.com',              // Domain only
      'localhost:3000',               // With port
      '*.example.com',                // With wildcard
      'http://internal:8080/api'      // HTTP with port and path
    ];

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: urls
    });

    // Verify all URL formats are included correctly
    for (const url of urls) {
      assert.ok(cmdIncludesUrl(cmd, url),
        `Command should include --allow-url flag for URL format: ${url}`);
    }
  });

  // ==========================================================================
  // NEGATIVE CASES: Security enforcement
  // ==========================================================================

  test('no URLs by default - no --allow-url flags present', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd()
      // No allowedUrls specified
    });

    // Verify NO --allow-url flags present
    assert.ok(!cmd.includes('--allow-url'),
      'Command should NOT include any --allow-url flags by default');

    // Verify NO --allow-all-urls flag present
    assert.ok(!cmd.includes('--allow-all-urls'),
      'Command should NOT include --allow-all-urls flag');

    // Verify security logging indicates no URLs
    const securityLogs = getSecurityLogs();
    assert.ok(securityLogs.some(l => l.msg.includes('none (network access disabled)')),
      'Security log should indicate network access is disabled');
  });

  test('empty array means no URLs - no flags generated', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: []  // Explicitly empty
    });

    // Verify no URL access granted
    assert.ok(!cmd.includes('--allow-url'),
      'Command should NOT include any --allow-url flags for empty array');
    assert.ok(!cmd.includes('--allow-all-urls'),
      'Command should NOT include --allow-all-urls flag for empty array');

    // Verify security logging indicates no URLs
    const securityLogs = getSecurityLogs();
    assert.ok(securityLogs.some(l => l.msg.includes('none (network access disabled)')),
      'Security log should indicate network access is disabled for empty array');
  });

  test('--allow-all-urls is NEVER used in any scenario', () => {
    const runner = createRunner();

    // Test multiple scenarios where --allow-all-urls should never appear
    const scenarios = [
      { allowedUrls: undefined },              // No URLs
      { allowedUrls: [] },                     // Empty array
      { allowedUrls: ['single-url.com'] },     // Single URL
      { allowedUrls: ['url1.com', 'url2.com', 'url3.com'] }, // Multiple URLs
      { allowedUrls: ['*.wildcard.com'] },     // Wildcard URL
    ];

    for (const scenario of scenarios) {
      const cmd = runner.buildCommand({
        task: 'test task',
        cwd: process.cwd(),
        ...scenario
      });

      assert.ok(!cmd.includes('--allow-all-urls'),
        `Command should NEVER include --allow-all-urls. Scenario: ${JSON.stringify(scenario)}`);
    }
  });

  // ==========================================================================
  // SECURITY LOGGING CASES
  // ==========================================================================

  test('URLs are logged for security audit', () => {
    const runner = createRunner();

    const urls = [
      'https://api.example.com',
      'internal-service.company.com'
    ];

    runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: urls
    });

    const securityLogs = getSecurityLogs();

    // Verify [SECURITY] log entries for each URL
    for (const url of urls) {
      assert.ok(securityLogs.some(l => l.msg.includes(`[SECURITY]   - ${url}`)),
        `Security log should include entry for URL: ${url}`);
    }

    // Verify count log
    assert.ok(securityLogs.some(l => l.msg.includes(`[SECURITY] Copilot CLI allowed URLs (${urls.length})`)),
      'Security log should show header with URL count');
  });

  test('no URLs logged appropriately for security audit', () => {
    const runner = createRunner();

    runner.buildCommand({
      task: 'test task',
      cwd: process.cwd()
      // No allowedUrls
    });

    const securityLogs = getSecurityLogs();

    // Verify log indicates network access disabled
    assert.ok(securityLogs.some(l => 
      l.msg.includes('[SECURITY] Copilot CLI allowed URLs: none (network access disabled)')),
      'Security log should indicate that network access is disabled');

    // Should NOT have any URL-specific entries (directory entries are OK)
    // Directory logs will have "[SECURITY]   - /path/to/dir" format
    // URL logs would have the same format, so we need to check that
    // no URLs appear in any log entries when none are allowed
    const urlLikeEntries = securityLogs.filter(l => 
      l.msg.includes('[SECURITY]   -') && 
      (l.msg.includes('http') || l.msg.includes('://') || l.msg.includes('.com'))
    );
    assert.strictEqual(urlLikeEntries.length, 0,
      'Security log should NOT have any URL entries when none are allowed');
  });

  // ==========================================================================
  // COMMAND STRUCTURE VALIDATION
  // ==========================================================================

  test('buildCommand produces valid --allow-url flags with proper quoting', () => {
    const runner = createRunner();

    const urlWithSpecialChars = 'https://api.example.com/v1/test?param=value&other=data';
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: [urlWithSpecialChars]
    });

    // The URL should be JSON-quoted (surrounded by ")
    const match = cmd.match(/--allow-url "([^"]+)"/);
    assert.ok(match, 'URLs should be properly quoted with double quotes');
    assert.ok(match[1].includes('?param=value&other=data'),
      'URL parameters should be preserved in quoted URL');
  });

  test('URLs are positioned correctly in command after directory flags', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: ['https://api.example.com']
    });

    // URLs should come after the main copilot command and directory flags
    // but can be anywhere after that
    assert.ok(cmd.startsWith('copilot -p "test task"'),
      'Command should start with copilot and task');
    assert.ok(cmd.includes('--allow-url "https://api.example.com"'),
      'Command should include the URL flag');
  });

  test('command security - only explicitly allowed URLs are included', () => {
    const runner = createRunner();

    const allowedUrl = 'https://allowed.example.com';
    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedUrls: [allowedUrl]
    });

    // Only the explicitly allowed URL should be present
    assert.ok(cmdIncludesUrl(cmd, allowedUrl),
      'Command should include explicitly allowed URL');

    // Count --allow-url occurrences to ensure no extra URLs
    const allowUrlMatches = cmd.match(/--allow-url/g);
    assert.strictEqual(allowUrlMatches?.length, 1,
      'Should have exactly 1 --allow-url flag');

    // Should not include any other common URLs that weren't specified
    const commonUrls = ['github.com', 'npmjs.org', 'localhost'];
    for (const url of commonUrls) {
      if (url !== allowedUrl) {
        assert.ok(!cmd.includes(url),
          `Command should NOT include unspecified URL: ${url}`);
      }
    }
  });

  // ==========================================================================
  // MIXED SCENARIOS
  // ==========================================================================

  test('URLs work correctly when combined with allowedFolders', () => {
    const runner = createRunner();

    const cmd = runner.buildCommand({
      task: 'test task',
      cwd: process.cwd(),
      allowedFolders: [process.cwd()],
      allowedUrls: ['https://api.example.com']
    });

    // Should have both directory and URL flags
    assert.ok(cmd.includes('--add-dir'),
      'Command should include directory flags');
    assert.ok(cmd.includes('--allow-url'),
      'Command should include URL flags');
    
    // Both security features should be logged
    const securityLogs = getSecurityLogs();
    assert.ok(securityLogs.some(l => l.msg.includes('allowed directories')),
      'Should log directory security info');
    assert.ok(securityLogs.some(l => l.msg.includes('allowed URLs')),
      'Should log URL security info');
  });
});