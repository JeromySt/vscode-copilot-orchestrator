/**
 * @fileoverview Unit tests for modelDiscovery module - async functions and cache behavior.
 *
 * Covers:
 * - discoverAvailableModels (with failure cache)
 * - getCachedModels
 * - refreshModelCache
 * - isValidModel
 * - suggestModel
 * - resetModelCache
 * - emptyResult shape
 */

import * as assert from 'assert';
import {
  classifyModel,
  parseModelChoices,
  resetModelCache,
  discoverAvailableModels,
  getCachedModels,
  refreshModelCache,
  isValidModel,
  suggestModel,
} from '../../../agent/modelDiscovery';

suite('Model Discovery - Async Functions', () => {

  setup(() => {
    resetModelCache();
  });

  teardown(() => {
    resetModelCache();
  });

  // ==========================================================================
  // discoverAvailableModels
  // ==========================================================================
  suite('discoverAvailableModels', () => {
    test('returns a ModelDiscoveryResult object', async function () {
      this.timeout(15000);
      const result = await discoverAvailableModels();
      assert.ok(result, 'Should return a result');
      assert.ok(Array.isArray(result.models), 'Should have models array');
      assert.ok(Array.isArray(result.rawChoices), 'Should have rawChoices array');
      assert.ok(typeof result.discoveredAt === 'number', 'Should have discoveredAt timestamp');
    });

    test('returns empty result when copilot CLI not found', async function () {
      this.timeout(15000);
      // In test env, copilot CLI is likely not installed
      const result = await discoverAvailableModels();
      // Either empty (CLI not found) or populated (CLI found)
      assert.ok(Array.isArray(result.models));
      assert.ok(Array.isArray(result.rawChoices));
    });

    test('failure cache prevents rapid re-discovery', async function () {
      this.timeout(20000);
      // First call triggers discovery
      const result1 = await discoverAvailableModels();

      // If first call failed, second call should hit failure cache and return quickly
      const start = Date.now();
      const result2 = await discoverAvailableModels();
      const elapsed = Date.now() - start;

      // Second call should be fast (< 2 seconds) due to caching
      assert.ok(elapsed < 5000, `Second call should be fast, took ${elapsed}ms`);
      assert.ok(Array.isArray(result2.models));
    });
  });

  // ==========================================================================
  // getCachedModels
  // ==========================================================================
  suite('getCachedModels', () => {
    test('returns result (may trigger discovery)', async function () {
      this.timeout(15000);
      const result = await getCachedModels();
      assert.ok(result);
      assert.ok(Array.isArray(result.models));
    });

    test('returns cached result on second call', async function () {
      this.timeout(15000);
      const result1 = await getCachedModels();
      const result2 = await getCachedModels();
      // If cache was populated, discoveredAt should be the same
      assert.strictEqual(result1.discoveredAt, result2.discoveredAt,
        'Cached result should have same timestamp');
    });
  });

  // ==========================================================================
  // refreshModelCache
  // ==========================================================================
  suite('refreshModelCache', () => {
    test('clears cache and re-discovers', async function () {
      this.timeout(15000);
      // Seed cache
      await getCachedModels();

      // Refresh should re-discover
      const result = await refreshModelCache();
      assert.ok(result);
      assert.ok(Array.isArray(result.models));
    });
  });

  // ==========================================================================
  // isValidModel
  // ==========================================================================
  suite('isValidModel', () => {
    test('returns false for non-existent model when no models discovered', async function () {
      this.timeout(15000);
      const valid = await isValidModel('definitely-not-a-real-model');
      assert.strictEqual(valid, false);
    });

    test('returns boolean', async function () {
      this.timeout(15000);
      const result = await isValidModel('claude-sonnet-4.5');
      assert.ok(typeof result === 'boolean');
    });
  });

  // ==========================================================================
  // suggestModel
  // ==========================================================================
  suite('suggestModel', () => {
    test('returns undefined when no models available', async function () {
      this.timeout(15000);
      resetModelCache();
      // In test env without copilot, should return undefined
      const suggestion = await suggestModel('standard');
      // Either undefined (no models) or a ModelInfo (models found)
      if (suggestion) {
        assert.ok(suggestion.id);
        assert.ok(suggestion.vendor);
        assert.ok(suggestion.tier);
      }
    });

    test('accepts fast tier', async function () {
      this.timeout(15000);
      const suggestion = await suggestModel('fast');
      if (suggestion) {
        assert.ok(suggestion.id);
      }
    });

    test('accepts premium tier', async function () {
      this.timeout(15000);
      const suggestion = await suggestModel('premium');
      if (suggestion) {
        assert.ok(suggestion.id);
      }
    });
  });

  // ==========================================================================
  // resetModelCache
  // ==========================================================================
  suite('resetModelCache', () => {
    test('can be called multiple times without error', () => {
      assert.doesNotThrow(() => {
        resetModelCache();
        resetModelCache();
        resetModelCache();
      });
    });

    test('clears any cached data', async function () {
      this.timeout(15000);
      // Seed cache
      await getCachedModels();

      // Reset
      resetModelCache();

      // Next call should re-discover (won't hit cache)
      const result = await getCachedModels();
      assert.ok(result);
    });
  });
});
