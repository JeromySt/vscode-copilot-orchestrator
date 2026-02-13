/**
 * @fileoverview Additional cliCheckCore tests for cache behavior and async checks.
 *
 * Covers:
 * - Cache populated state transitions
 * - checkCopilotCliAsync actual resolution
 * - isCopilotCliAvailable cache hits
 * - resetCliCache state transitions
 */

import * as assert from 'assert';

suite('CLI Check Core - Cache & Async Coverage', () => {

  function getFreshModule() {
    const modulePath = require.resolve('../../../agent/cliCheckCore');
    delete require.cache[modulePath];
    return require('../../../agent/cliCheckCore');
  }

  teardown(() => {
    // Clean up module cache
    const modulePath = require.resolve('../../../agent/cliCheckCore');
    if (require.cache[modulePath]) {
      const mod = require(modulePath);
      mod.resetCliCache();
    }
  });

  test('isCliCachePopulated is false after reset', () => {
    const mod = getFreshModule();
    mod.resetCliCache();
    assert.strictEqual(mod.isCliCachePopulated(), false);
  });

  test('isCopilotCliAvailable returns true optimistically on first call', () => {
    const mod = getFreshModule();
    mod.resetCliCache();
    const result = mod.isCopilotCliAvailable();
    assert.strictEqual(result, true, 'Should return true optimistically on first call');
  });

  test('second call to isCopilotCliAvailable uses cached value', () => {
    const mod = getFreshModule();
    mod.resetCliCache();
    // First call starts async check
    mod.isCopilotCliAvailable();
    // Second call should return same optimistic value
    const result2 = mod.isCopilotCliAvailable();
    assert.strictEqual(typeof result2, 'boolean');
  });

  test('checkCopilotCliAsync resolves to boolean', async function () {
    this.timeout(30000);
    const mod = getFreshModule();
    const result = await mod.checkCopilotCliAsync();
    assert.ok(typeof result === 'boolean', 'Should resolve to boolean');
  });

  test('cache is populated after checkCopilotCliAsync completes', async function () {
    this.timeout(30000);
    const mod = getFreshModule();
    mod.resetCliCache();
    assert.strictEqual(mod.isCliCachePopulated(), false);

    await mod.checkCopilotCliAsync();
    assert.strictEqual(mod.isCliCachePopulated(), true, 'Cache should be populated after async check');
  });

  test('isCopilotCliAvailable returns cached value after async check', async function () {
    this.timeout(30000);
    const mod = getFreshModule();
    mod.resetCliCache();

    const asyncResult = await mod.checkCopilotCliAsync();
    const cachedResult = mod.isCopilotCliAvailable();
    assert.strictEqual(cachedResult, asyncResult, 'Should return cached async result');
  });

  test('reset then re-check cycle works', async function () {
    this.timeout(30000);
    const mod = getFreshModule();

    // Check
    await mod.checkCopilotCliAsync();
    assert.strictEqual(mod.isCliCachePopulated(), true);

    // Reset
    mod.resetCliCache();
    assert.strictEqual(mod.isCliCachePopulated(), false);

    // Re-check
    await mod.checkCopilotCliAsync();
    assert.strictEqual(mod.isCliCachePopulated(), true);
  });

  test('checkCopilotCliAsync handles repeated calls', async function () {
    this.timeout(30000);
    const mod = getFreshModule();

    // Start two async checks in parallel
    const [result1, result2] = await Promise.all([
      mod.checkCopilotCliAsync(),
      mod.checkCopilotCliAsync(),
    ]);

    assert.strictEqual(typeof result1, 'boolean');
    assert.strictEqual(typeof result2, 'boolean');
  });
});
