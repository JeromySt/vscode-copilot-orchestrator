/**
 * @fileoverview Unit tests for metricsAggregator
 */
import * as assert from 'assert';
import {
  aggregateMetrics,
  getNodeMetrics,
  getPlanMetrics,
  formatPremiumRequests,
  formatDurationSeconds,
  formatTokenCount,
  formatCodeChanges,
} from '../../../plan/metricsAggregator';
import type { CopilotUsageMetrics, NodeExecutionState, PlanInstance } from '../../../plan/types';

suite('metricsAggregator', () => {
  suite('aggregateMetrics', () => {
    test('returns zero-duration for empty array', () => {
      const result = aggregateMetrics([]);
      assert.strictEqual(result.durationMs, 0);
    });

    test('returns single metric as-is', () => {
      const m: CopilotUsageMetrics = { durationMs: 100, premiumRequests: 5 };
      const result = aggregateMetrics([m]);
      assert.strictEqual(result, m);
    });

    test('sums durations from multiple metrics', () => {
      const result = aggregateMetrics([{ durationMs: 100 }, { durationMs: 200 }]);
      assert.strictEqual(result.durationMs, 300);
    });

    test('sums premiumRequests', () => {
      const result = aggregateMetrics([
        { durationMs: 100, premiumRequests: 3 },
        { durationMs: 200, premiumRequests: 7 },
      ]);
      assert.strictEqual(result.premiumRequests, 10);
    });

    test('sums apiTimeSeconds', () => {
      const result = aggregateMetrics([
        { durationMs: 100, apiTimeSeconds: 1.5 },
        { durationMs: 200, apiTimeSeconds: 2.5 },
      ]);
      assert.strictEqual(result.apiTimeSeconds, 4);
    });

    test('sums sessionTimeSeconds', () => {
      const result = aggregateMetrics([
        { durationMs: 100, sessionTimeSeconds: 10 },
        { durationMs: 200, sessionTimeSeconds: 20 },
      ]);
      assert.strictEqual(result.sessionTimeSeconds, 30);
    });

    test('sums codeChanges', () => {
      const result = aggregateMetrics([
        { durationMs: 100, codeChanges: { linesAdded: 10, linesRemoved: 5 } },
        { durationMs: 200, codeChanges: { linesAdded: 20, linesRemoved: 3 } },
      ]);
      assert.deepStrictEqual(result.codeChanges, { linesAdded: 30, linesRemoved: 8 });
    });

    test('sums turns', () => {
      const result = aggregateMetrics([
        { durationMs: 100, turns: 3 },
        { durationMs: 200, turns: 5 },
      ]);
      assert.strictEqual(result.turns, 8);
    });

    test('sums toolCalls', () => {
      const result = aggregateMetrics([
        { durationMs: 100, toolCalls: 10 },
        { durationMs: 200, toolCalls: 20 },
      ]);
      assert.strictEqual(result.toolCalls, 30);
    });

    test('merges modelBreakdown entries for same model', () => {
      const result = aggregateMetrics([
        { durationMs: 100, modelBreakdown: [{ model: 'gpt-4', inputTokens: 100, outputTokens: 50 }] },
        { durationMs: 200, modelBreakdown: [{ model: 'gpt-4', inputTokens: 200, outputTokens: 100, cachedTokens: 10, premiumRequests: 2 }] },
      ]);
      assert.ok(result.modelBreakdown);
      assert.strictEqual(result.modelBreakdown!.length, 1);
      assert.strictEqual(result.modelBreakdown![0].inputTokens, 300);
      assert.strictEqual(result.modelBreakdown![0].outputTokens, 150);
      assert.strictEqual(result.modelBreakdown![0].cachedTokens, 10);
      assert.strictEqual(result.modelBreakdown![0].premiumRequests, 2);
    });

    test('keeps separate model entries', () => {
      const result = aggregateMetrics([
        { durationMs: 100, modelBreakdown: [{ model: 'gpt-4', inputTokens: 100, outputTokens: 50 }] },
        { durationMs: 200, modelBreakdown: [{ model: 'claude', inputTokens: 200, outputTokens: 100 }] },
      ]);
      assert.ok(result.modelBreakdown);
      assert.strictEqual(result.modelBreakdown!.length, 2);
    });

    test('omits optional fields when not present in any metric', () => {
      const result = aggregateMetrics([{ durationMs: 100 }, { durationMs: 200 }]);
      assert.strictEqual(result.premiumRequests, undefined);
      assert.strictEqual(result.apiTimeSeconds, undefined);
      assert.strictEqual(result.codeChanges, undefined);
    });

    test('merges model breakdown with cachedTokens accumulation', () => {
      const result = aggregateMetrics([
        { durationMs: 100, modelBreakdown: [{ model: 'gpt-4', inputTokens: 100, outputTokens: 50, cachedTokens: 5 }] },
        { durationMs: 200, modelBreakdown: [{ model: 'gpt-4', inputTokens: 200, outputTokens: 100, cachedTokens: 10 }] },
      ]);
      assert.strictEqual(result.modelBreakdown![0].cachedTokens, 15);
    });

    test('merges model breakdown with premiumRequests accumulation', () => {
      const result = aggregateMetrics([
        { durationMs: 100, modelBreakdown: [{ model: 'gpt-4', inputTokens: 100, outputTokens: 50, premiumRequests: 1 }] },
        { durationMs: 200, modelBreakdown: [{ model: 'gpt-4', inputTokens: 200, outputTokens: 100, premiumRequests: 3 }] },
      ]);
      assert.strictEqual(result.modelBreakdown![0].premiumRequests, 4);
    });
  });

  suite('getNodeMetrics', () => {
    test('returns undefined when no metrics anywhere', () => {
      const state: NodeExecutionState = { status: 'succeeded', version: 1, attempts: 1 };
      assert.strictEqual(getNodeMetrics(state), undefined);
    });

    test('returns state.metrics as fallback when no attemptHistory', () => {
      const state: NodeExecutionState = {
        status: 'succeeded', version: 1, attempts: 1,
        metrics: { durationMs: 500, premiumRequests: 2 },
      };
      const result = getNodeMetrics(state);
      assert.ok(result);
      assert.strictEqual(result!.durationMs, 500);
    });

    test('aggregates attempt history metrics', () => {
      const state: NodeExecutionState = {
        status: 'succeeded', version: 1, attempts: 2,
        attemptHistory: [
          { attemptNumber: 1, startedAt: 0, endedAt: 100, status: 'failed', metrics: { durationMs: 100 } },
          { attemptNumber: 2, startedAt: 100, endedAt: 300, status: 'succeeded', metrics: { durationMs: 200 } },
        ],
      };
      const result = getNodeMetrics(state);
      assert.ok(result);
      assert.strictEqual(result!.durationMs, 300);
    });

    test('skips attempts without metrics', () => {
      const state: NodeExecutionState = {
        status: 'succeeded', version: 1, attempts: 2,
        attemptHistory: [
          { attemptNumber: 1, startedAt: 0, endedAt: 100, status: 'failed' },
          { attemptNumber: 2, startedAt: 100, endedAt: 300, status: 'succeeded', metrics: { durationMs: 200 } },
        ],
      };
      const result = getNodeMetrics(state);
      assert.ok(result);
      assert.strictEqual(result!.durationMs, 200);
    });

    test('prefers attemptHistory over state.metrics', () => {
      const state: NodeExecutionState = {
        status: 'succeeded', version: 1, attempts: 1,
        metrics: { durationMs: 999 },
        attemptHistory: [
          { attemptNumber: 1, startedAt: 0, endedAt: 100, status: 'succeeded', metrics: { durationMs: 100 } },
        ],
      };
      const result = getNodeMetrics(state);
      assert.strictEqual(result!.durationMs, 100);
    });
  });

  suite('getPlanMetrics', () => {
    test('returns undefined when no nodes have metrics', () => {
      const plan = {
        nodeStates: new Map([
          ['n1', { status: 'succeeded', version: 1, attempts: 1 } as NodeExecutionState],
        ]),
      } as any as PlanInstance;
      assert.strictEqual(getPlanMetrics(plan), undefined);
    });

    test('aggregates metrics across all nodes', () => {
      const plan = {
        nodeStates: new Map([
          ['n1', { status: 'succeeded', version: 1, attempts: 1, metrics: { durationMs: 100 } } as NodeExecutionState],
          ['n2', { status: 'succeeded', version: 1, attempts: 1, metrics: { durationMs: 200 } } as NodeExecutionState],
        ]),
      } as any as PlanInstance;
      const result = getPlanMetrics(plan);
      assert.ok(result);
      assert.strictEqual(result!.durationMs, 300);
    });
  });

  suite('formatPremiumRequests', () => {
    test('singular form', () => {
      assert.strictEqual(formatPremiumRequests(1), '1 Premium request');
    });
    test('plural form', () => {
      assert.strictEqual(formatPremiumRequests(3), '3 Premium requests');
    });
    test('zero is plural', () => {
      assert.strictEqual(formatPremiumRequests(0), '0 Premium requests');
    });
  });

  suite('formatDurationSeconds', () => {
    test('seconds only', () => {
      assert.strictEqual(formatDurationSeconds(45), '45s');
    });
    test('minutes and seconds', () => {
      assert.strictEqual(formatDurationSeconds(125), '2m 5s');
    });
    test('hours, minutes, seconds', () => {
      assert.strictEqual(formatDurationSeconds(3661), '1h 1m 1s');
    });
    test('zero seconds', () => {
      assert.strictEqual(formatDurationSeconds(0), '0s');
    });
  });

  suite('formatTokenCount', () => {
    test('small count', () => {
      assert.strictEqual(formatTokenCount(500), '500');
    });
    test('thousands', () => {
      assert.strictEqual(formatTokenCount(1500), '1.5k');
    });
    test('millions', () => {
      assert.strictEqual(formatTokenCount(1500000), '1.5m');
    });
    test('exactly 1000', () => {
      assert.strictEqual(formatTokenCount(1000), '1.0k');
    });
    test('exactly 1000000', () => {
      assert.strictEqual(formatTokenCount(1000000), '1.0m');
    });
  });

  suite('formatCodeChanges', () => {
    test('formats additions and removals', () => {
      assert.strictEqual(formatCodeChanges({ linesAdded: 10, linesRemoved: 5 }), '+10 -5');
    });
    test('zero values', () => {
      assert.strictEqual(formatCodeChanges({ linesAdded: 0, linesRemoved: 0 }), '+0 -0');
    });
  });
});
