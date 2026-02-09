/**
 * @fileoverview Unit tests for CopilotStatsParser
 *
 * Tests cover:
 * - Each stat type independently (premium requests, API time, session time, code changes)
 * - Duration parsing helper (seconds, minutes, hours, decimals)
 * - Token count parsing helper (plain numbers, 'k' suffix, 'm' suffix)
 * - Full multi-line Copilot output
 * - Multiple model breakdowns
 * - Edge cases: missing fields, partial output, various prefixes
 * - Parser should NOT depend on line prefixes like [copilot] or timestamps
 */

import * as assert from 'assert';
import { CopilotStatsParser, parseDuration, parseTokenCount } from '../../../agent/copilotStatsParser';

suite('CopilotStatsParser', () => {

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
  // Individual stat types
  // =========================================================================
  suite('individual stat parsing', () => {
    test('parses premium requests', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total usage est:        3 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
    });

    test('parses API time spent', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('API time spent:         32s');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.apiTimeSeconds, 32);
    });

    test('parses total session time', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total session time:     55s');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.sessionTimeSeconds, 55);
    });

    test('parses total code changes', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total code changes:     +12 -5');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 12, linesRemoved: 5 });
    });

    test('parses zero code changes', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total code changes:     +0 -0');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 0, linesRemoved: 0 });
    });

    test('parses API time with complex duration', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('API time spent:         1m 30s');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.apiTimeSeconds, 90);
    });
  });

  // =========================================================================
  // Prefix handling
  // =========================================================================
  suite('prefix handling', () => {
    test('parses lines with [copilot] prefix', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('[copilot] Total usage est:        3 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
    });

    test('parses lines with timestamp and info prefix', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('[12:46:20 PM] [INFO] [copilot] Total usage est:        5 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 5);
    });

    test('parses lines without any prefix', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total usage est:        7 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 7);
    });

    test('parses lines with mixed prefix styles', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('[copilot] Total usage est:        3 Premium requests');
      parser.feedLine('[12:00:00 AM] [INFO] [copilot] API time spent:         45s');
      parser.feedLine('Total session time:     1m 20s');
      const metrics = parser.getMetrics();
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
      const parser = new CopilotStatsParser();
      parser.feedLine('Breakdown by AI model:');
      parser.feedLine('claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)');
      const metrics = parser.getMetrics();
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
      const parser = new CopilotStatsParser();
      parser.feedLine('Breakdown by AI model:');
      parser.feedLine('claude-opus-4.6         100k in, 5k out, 50k cached (Est. 2 Premium requests)');
      parser.feedLine('gpt-4.1                 200k in, 10k out (Est. 4 Premium requests)');
      const metrics = parser.getMetrics();
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
      const parser = new CopilotStatsParser();
      parser.feedLine('Breakdown by AI model:');
      parser.feedLine('claude-sonnet-4         50k in, 2k out');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].premiumRequests, undefined);
    });

    test('parses model breakdown with [copilot] prefix', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('[copilot] Breakdown by AI model:');
      parser.feedLine('[copilot] claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'claude-opus-4.6');
    });
  });

  // =========================================================================
  // Full output
  // =========================================================================
  suite('full multi-line output', () => {
    test('parses complete Copilot CLI summary', () => {
      const parser = new CopilotStatsParser();
      const lines = [
        '[copilot] Total usage est:        3 Premium requests',
        '[copilot] API time spent:         32s',
        '[copilot] Total session time:     55s',
        '[copilot] Total code changes:     +0 -0',
        '[copilot] Breakdown by AI model:',
        '[copilot] claude-opus-4.6         231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)',
      ];
      for (const line of lines) {
        parser.feedLine(line);
      }
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 3);
      assert.strictEqual(metrics.apiTimeSeconds, 32);
      assert.strictEqual(metrics.sessionTimeSeconds, 55);
      assert.deepStrictEqual(metrics.codeChanges, { linesAdded: 0, linesRemoved: 0 });
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'claude-opus-4.6');
      assert.strictEqual(metrics.durationMs, 0); // Not measured by parser
    });

    test('parses output interspersed with other log lines', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('[copilot] Some other output line');
      parser.feedLine('[copilot] Total usage est:        5 Premium requests');
      parser.feedLine('[copilot] More random log output');
      parser.feedLine('[copilot] API time spent:         1m 5s');
      parser.feedLine('[copilot] Total session time:     2m');
      parser.feedLine('[copilot] Total code changes:     +42 -17');
      const metrics = parser.getMetrics();
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
      const parser = new CopilotStatsParser();
      parser.feedLine('random log line');
      parser.feedLine('another random line');
      assert.strictEqual(parser.getMetrics(), undefined);
    });

    test('returns undefined for empty input', () => {
      const parser = new CopilotStatsParser();
      assert.strictEqual(parser.getMetrics(), undefined);
    });

    test('handles empty lines gracefully', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('');
      parser.feedLine('   ');
      parser.feedLine('Total usage est:        1 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 1);
    });

    test('partial output returns only parsed fields', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total usage est:        10 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 10);
      assert.strictEqual(metrics.apiTimeSeconds, undefined);
      assert.strictEqual(metrics.sessionTimeSeconds, undefined);
      assert.strictEqual(metrics.codeChanges, undefined);
      assert.strictEqual(metrics.modelBreakdown, undefined);
    });

    test('model breakdown stops when non-model line follows', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Breakdown by AI model:');
      parser.feedLine('gpt-4.1                 100k in, 5k out');
      parser.feedLine('Total usage est:        2 Premium requests');
      // After 'Total usage est' line, parsingModels should be false
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.premiumRequests, 2);
    });

    test('handles fractional premium requests', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total usage est:        1.5 Premium requests');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 1.5);
    });

    test('durationMs defaults to 0', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('API time spent:         10s');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.durationMs, 0);
    });

    test('model with slash in name', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Breakdown by AI model:');
      parser.feedLine('openai/gpt-4.1          500k in, 20k out (Est. 5 Premium requests)');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.ok(metrics.modelBreakdown);
      assert.strictEqual(metrics.modelBreakdown.length, 1);
      assert.strictEqual(metrics.modelBreakdown[0].model, 'openai/gpt-4.1');
      assert.strictEqual(metrics.modelBreakdown[0].inputTokens, 500000);
      assert.strictEqual(metrics.modelBreakdown[0].outputTokens, 20000);
      assert.strictEqual(metrics.modelBreakdown[0].premiumRequests, 5);
    });

    test('singular Premium request', () => {
      const parser = new CopilotStatsParser();
      parser.feedLine('Total usage est:        1 Premium request');
      const metrics = parser.getMetrics();
      assert.ok(metrics);
      assert.strictEqual(metrics.premiumRequests, 1);
    });
  });
});
