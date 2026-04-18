/**
 * @fileoverview Unit tests for StatsHandler
 *
 * Tests cover:
 * - parseDuration helper (seconds, minutes, hours, decimals)
 * - parseTokenCount helper (plain numbers, 'k' suffix, 'm' suffix)
 * - Each stat type independently (premium requests, API time, session time, code changes)
 * - Full multi-line Copilot output
 * - Multiple model breakdowns with various formats
 * - Prefix handling ([copilot], timestamps, no prefix)
 * - getStatsStartedAt() returns timestamp when stats start
 * - getMetrics() returns correct values after feeding known lines
 * - Factory creates handler correctly
 * - Edge cases: missing fields, partial output, empty input
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { suite, test, setup, teardown } from 'mocha';
import { StatsHandler, StatsHandlerFactory, parseDuration, parseTokenCount } from '../../../../agent/handlers/statsHandler';
import { OutputSources } from '../../../../interfaces/IOutputHandler';

suite('StatsHandler', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  /** Helper: feed a line into the handler via its onLine interface */
  function feedLine(handler: StatsHandler, line: string): void {
    handler.onLine([line], OutputSources.stdout);
  }

  // =========================================================================
  // parseDuration helper
  // =========================================================================
  suite('parseDuration', () => {
    test('parses seconds only', () => {
      assert.strictEqual(parseDuration('32s'), 32);
    });

    test('parses decimal seconds', () => {
      assert.strictEqual(parseDuration('32.5s'), 32.5);
    });

    test('parses minutes and seconds', () => {
      assert.strictEqual(parseDuration('1m 30s'), 90);
    });

    test('parses hours, minutes, and seconds', () => {
      assert.strictEqual(parseDuration('2h 5m 10s'), 7510);
    });

    test('parses hours and minutes without seconds', () => {
      assert.strictEqual(parseDuration('1h 30m'), 5400);
    });

    test('parses minutes only', () => {
      assert.strictEqual(parseDuration('5m'), 300);
    });

    test('parses hours only', () => {
      assert.strictEqual(parseDuration('2h'), 7200);
    });

    test('returns 0 for empty string', () => {
      assert.strictEqual(parseDuration(''), 0);
    });
  });

  // =========================================================================
  // parseTokenCount helper
  // =========================================================================
  suite('parseTokenCount', () => {
    test('parses plain integer', () => {
      assert.strictEqual(parseTokenCount('500'), 500);
    });

    test('parses k suffix', () => {
      assert.strictEqual(parseTokenCount('1.3k'), 1300);
    });

    test('parses large k suffix', () => {
      assert.strictEqual(parseTokenCount('231.5k'), 231500);
    });

    test('parses m suffix', () => {
      assert.strictEqual(parseTokenCount('1.2m'), 1200000);
    });

    test('parses uppercase K', () => {
      assert.strictEqual(parseTokenCount('5K'), 5000);
    });

    test('parses uppercase M', () => {
      assert.strictEqual(parseTokenCount('2M'), 2000000);
    });

    test('handles whitespace', () => {
      assert.strictEqual(parseTokenCount('  1.5k  '), 1500);
    });
  });

  // =========================================================================
  // Handler interface properties
  // =========================================================================
  suite('handler properties', () => {
    test('has correct name', () => {
      const handler = new StatsHandler();
      assert.strictEqual(handler.name, 'stats');
    });

    test('has correct sources', () => {
      const handler = new StatsHandler();
      assert.deepStrictEqual(handler.sources, [OutputSources.stdout, OutputSources.stderr]);
    });

    test('has windowSize of 1', () => {
      const handler = new StatsHandler();
      assert.strictEqual(handler.windowSize, 1);
    });
  });

  // =========================================================================
  // Individual stat types
  // =========================================================================
  suite('individual stat parsing', () => {
    test('parses premium requests', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total usage est:        3 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
    });

    test('parses API time spent', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'API time spent:         32s');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.apiTimeSeconds, 32);
    });

    test('parses total session time', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total session time:     55s');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.sessionTimeSeconds, 55);
    });

    test('parses total code changes', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total code changes:     +12 -5');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 12, linesRemoved: 5 });
    });

    test('parses zero code changes', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total code changes:     +0 -0');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 0, linesRemoved: 0 });
    });

    test('parses API time with complex duration', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'API time spent:         1m 30s');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.apiTimeSeconds, 90);
    });
  });

  // =========================================================================
  // Prefix handling
  // =========================================================================
  suite('prefix handling', () => {
    test('parses lines with [copilot] prefix', () => {
      const handler = new StatsHandler();
      feedLine(handler, '[copilot] Total usage est:        3 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
    });

    test('parses lines with timestamp and info prefix', () => {
      const handler = new StatsHandler();
      feedLine(handler, '[12:46:20 PM] [INFO] [copilot] Total usage est:        5 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 5);
    });

    test('parses lines without any prefix', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total usage est:        7 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 7);
    });

    test('parses lines with mixed prefix styles', () => {
      const handler = new StatsHandler();
      feedLine(handler, '[copilot] Total usage est:        3 Premium requests');
      feedLine(handler, '[12:00:00 AM] [INFO] [copilot] API time spent:         45s');
      feedLine(handler, 'Total session time:     1m 20s');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
      assert.strictEqual(metrics.apiTimeSeconds, 45);
      assert.strictEqual(metrics.sessionTimeSeconds, 80);
    });
  });

  // =========================================================================
  // Model breakdown
  // =========================================================================
  suite('model breakdown', () => {
    test('parses single model breakdown', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Breakdown by AI model:');
      feedLine(handler, 'claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'claude-opus-4.6');
      assert.strictEqual(metrics.modelBreakdown[0].inputTokens, 231500);
      assert.strictEqual(metrics.modelBreakdown[0].outputTokens, 1300);
      assert.strictEqual(metrics.modelBreakdown[0].cachedTokens, 158200);
      assert.strictEqual(metrics.modelBreakdown[0].premiumRequests, 3);
    });

    test('parses multiple model breakdowns', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Breakdown by AI model:');
      feedLine(handler, 'claude-opus-4.6         100k in, 5k out, 50k cached (Est. 2 Premium requests)');
      feedLine(handler, 'gpt-4.1                 200k in, 10k out (Est. 4 Premium requests)');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 2);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'claude-opus-4.6');
      assert.strictEqual(metrics.modelBreakdown[0].inputTokens, 100000);
      assert.strictEqual(metrics.modelBreakdown[0].cachedTokens, 50000);
      assert.strictEqual(metrics.modelBreakdown[1].model, 'gpt-4.1');
      assert.strictEqual(metrics.modelBreakdown[1].inputTokens, 200000);
      assert.strictEqual(metrics.modelBreakdown[1].outputTokens, 10000);
      assert.strictEqual(metrics.modelBreakdown[1].cachedTokens, undefined);
    });

    test('parses model breakdown without premium requests', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Breakdown by AI model:');
      feedLine(handler, 'claude-sonnet-4         50k in, 2k out');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].premiumRequests, undefined);
    });

    test('parses model breakdown with [copilot] prefix', () => {
      const handler = new StatsHandler();
      feedLine(handler, '[copilot] Breakdown by AI model:');
      feedLine(handler, '[copilot] claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'claude-opus-4.6');
    });

    test('model with slash in name', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Breakdown by AI model:');
      feedLine(handler, 'openai/gpt-4.1          500k in, 20k out (Est. 5 Premium requests)');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'openai/gpt-4.1');
      assert.strictEqual(metrics.modelBreakdown[0].inputTokens, 500000);
      assert.strictEqual(metrics.modelBreakdown[0].outputTokens, 20000);
      assert.strictEqual(metrics.modelBreakdown[0].premiumRequests, 5);
    });
  });

  // =========================================================================
  // getStatsStartedAt
  // =========================================================================
  suite('getStatsStartedAt', () => {
    test('returns undefined before any stats lines', () => {
      const handler = new StatsHandler();
      assert.strictEqual(handler.getStatsStartedAt(), undefined);
    });

    test('returns undefined after non-stats lines', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'random log line');
      feedLine(handler, 'another random line');
      assert.strictEqual(handler.getStatsStartedAt(), undefined);
    });

    test('returns timestamp after premium requests line', () => {
      const handler = new StatsHandler();
      const before = Date.now();
      feedLine(handler, 'Total usage est:        3 Premium requests');
      const after = Date.now();
      const ts = handler.getStatsStartedAt();
      assert.ok(ts !== undefined);
      assert.ok(ts >= before && ts <= after);
    });

    test('returns timestamp after API time line', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'API time spent:         32s');
      assert.ok(handler.getStatsStartedAt() !== undefined);
    });

    test('returns timestamp after session time line', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total session time:     55s');
      assert.ok(handler.getStatsStartedAt() !== undefined);
    });

    test('returns timestamp after code changes line', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total code changes:     +12 -5');
      assert.ok(handler.getStatsStartedAt() !== undefined);
    });

    test('returns timestamp after breakdown header', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Breakdown by AI model:');
      assert.ok(handler.getStatsStartedAt() !== undefined);
    });
  });

  // =========================================================================
  // Full output
  // =========================================================================
  suite('full multi-line output', () => {
    test('parses complete Copilot CLI summary', () => {
      const handler = new StatsHandler();
      const lines = [
        '[copilot] Total usage est:        3 Premium requests',
        '[copilot] API time spent:         32s',
        '[copilot] Total session time:     55s',
        '[copilot] Total code changes:     +0 -0',
        '[copilot] Breakdown by AI model:',
        '[copilot] claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)',
      ];
      for (const line of lines) {
        feedLine(handler, line);
      }
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
      assert.strictEqual(metrics.apiTimeSeconds, 32);
      assert.strictEqual(metrics.sessionTimeSeconds, 55);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 0, linesRemoved: 0 });
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'claude-opus-4.6');
      assert.strictEqual(metrics.durationMs, 0);
    });

    test('parses output interspersed with other log lines', () => {
      const handler = new StatsHandler();
      feedLine(handler, '[copilot] Some other output line');
      feedLine(handler, '[copilot] Total usage est:        5 Premium requests');
      feedLine(handler, '[copilot] More random log output');
      feedLine(handler, '[copilot] API time spent:         1m 5s');
      feedLine(handler, '[copilot] Total session time:     2m');
      feedLine(handler, '[copilot] Total code changes:     +42 -17');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 5);
      assert.strictEqual(metrics.apiTimeSeconds, 65);
      assert.strictEqual(metrics.sessionTimeSeconds, 120);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 42, linesRemoved: 17 });
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  suite('edge cases', () => {
    test('returns undefined when no stats are found', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'random log line');
      feedLine(handler, 'another random line');
      assert.strictEqual(handler.getMetrics(), undefined);
    });

    test('returns undefined for empty input', () => {
      const handler = new StatsHandler();
      assert.strictEqual(handler.getMetrics(), undefined);
    });

    test('handles empty lines gracefully', () => {
      const handler = new StatsHandler();
      feedLine(handler, '');
      feedLine(handler, '   ');
      feedLine(handler, 'Total usage est:        1 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 1);
    });

    test('partial output returns only parsed fields', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total usage est:        10 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 10);
      assert.strictEqual(metrics.apiTimeSeconds, undefined);
      assert.strictEqual(metrics.sessionTimeSeconds, undefined);
      assert.strictEqual(metrics.codeChanges, undefined);
      assert.strictEqual(metrics.modelBreakdown, undefined);
    });

    test('model breakdown stops when non-model line follows', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Breakdown by AI model:');
      feedLine(handler, 'gpt-4.1                 100k in, 5k out');
      feedLine(handler, 'Total usage est:        2 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.premiumRequests, 2);
    });

    test('handles fractional premium requests', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total usage est:        1.5 Premium requests');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 1.5);
    });

    test('durationMs defaults to 0', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'API time spent:         10s');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.durationMs, 0);
    });

    test('singular Premium request', () => {
      const handler = new StatsHandler();
      feedLine(handler, 'Total usage est:        1 Premium request');
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 1);
    });
  });

  // =========================================================================
  // StatsHandlerFactory
  // =========================================================================
  suite('StatsHandlerFactory', () => {
    test('has correct name', () => {
      assert.strictEqual(StatsHandlerFactory.name, 'stats');
    });

    test('has correct processFilter', () => {
      assert.deepStrictEqual(StatsHandlerFactory.processFilter, ['copilot']);
    });

    test('creates a StatsHandler instance', () => {
      const handler = StatsHandlerFactory.create({ processLabel: 'copilot' });
      assert.ok(handler);
      assert.ok(handler instanceof StatsHandler);
      assert.strictEqual(handler.name, 'stats');
    });

    test('created handler works correctly', () => {
      const handler = StatsHandlerFactory.create({ processLabel: 'copilot' }) as StatsHandler;
      assert.ok(handler);
      handler.onLine(['Total usage est:        3 Premium requests'], OutputSources.stdout);
      const metrics = handler.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
    });
  });
});
