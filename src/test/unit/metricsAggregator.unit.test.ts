/**
 * @fileoverview Unit tests for metricsAggregator
 *
 * Tests cover:
 * - Single metric aggregation (identity)
 * - Multiple metrics aggregation with same model
 * - Multiple metrics with different models
 * - Node-level aggregation from attempt history
 * - Plan-level aggregation
 * - Formatting functions
 * - Edge cases: undefined fields, empty arrays
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
} from '../../plan/metricsAggregator';
import type { CopilotUsageMetrics, NodeExecutionState, PlanInstance } from '../../plan/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
		restore: () => {
			console.log = origLog;
			console.debug = origDebug;
			console.warn = origWarn;
			console.error = origError;
		},
	};
}

function makeMetrics(overrides: Partial<CopilotUsageMetrics> = {}): CopilotUsageMetrics {
	return { durationMs: 1000, ...overrides };
}

function makeNodeState(overrides: Partial<NodeExecutionState> = {}): NodeExecutionState {
	return {
		status: 'succeeded',
		version: 1,
		attempts: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('metricsAggregator', () => {
	let silence: { restore: () => void };

	setup(() => { silence = silenceConsole(); });
	teardown(() => { silence.restore(); });

	// -----------------------------------------------------------------------
	// aggregateMetrics
	// -----------------------------------------------------------------------

	suite('aggregateMetrics', () => {
		test('empty array returns zero-duration metric', () => {
			const result = aggregateMetrics([]);
			assert.strictEqual(result.durationMs, 0);
		});

		test('single metric returns identity', () => {
			const m = makeMetrics({
				premiumRequests: 5,
				turns: 3,
				toolCalls: 10,
				durationMs: 2000,
			});
			const result = aggregateMetrics([m]);
			assert.strictEqual(result, m);
		});

		test('sums numeric fields', () => {
			const a = makeMetrics({
				premiumRequests: 2,
				apiTimeSeconds: 1.5,
				sessionTimeSeconds: 10,
				durationMs: 1000,
				turns: 5,
				toolCalls: 8,
				codeChanges: { linesAdded: 10, linesRemoved: 3 },
			});
			const b = makeMetrics({
				premiumRequests: 3,
				apiTimeSeconds: 2.5,
				sessionTimeSeconds: 20,
				durationMs: 2000,
				turns: 7,
				toolCalls: 12,
				codeChanges: { linesAdded: 20, linesRemoved: 5 },
			});

			const result = aggregateMetrics([a, b]);

			assert.strictEqual(result.premiumRequests, 5);
			assert.strictEqual(result.apiTimeSeconds, 4);
			assert.strictEqual(result.sessionTimeSeconds, 30);
			assert.strictEqual(result.durationMs, 3000);
			assert.strictEqual(result.turns, 12);
			assert.strictEqual(result.toolCalls, 20);
			assert.deepStrictEqual(result.codeChanges, { linesAdded: 30, linesRemoved: 8 });
		});

		test('merges model breakdown entries with same model', () => {
			const a = makeMetrics({
				modelBreakdown: [
					{ model: 'gpt-4', inputTokens: 100, outputTokens: 50, premiumRequests: 1 },
				],
			});
			const b = makeMetrics({
				modelBreakdown: [
					{ model: 'gpt-4', inputTokens: 200, outputTokens: 100, premiumRequests: 2 },
				],
			});

			const result = aggregateMetrics([a, b]);

			assert.ok(result.modelBreakdown);
			assert.strictEqual(result.modelBreakdown!.length, 1);
			assert.strictEqual(result.modelBreakdown![0].model, 'gpt-4');
			assert.strictEqual(result.modelBreakdown![0].inputTokens, 300);
			assert.strictEqual(result.modelBreakdown![0].outputTokens, 150);
			assert.strictEqual(result.modelBreakdown![0].premiumRequests, 3);
		});

		test('keeps different models separate', () => {
			const a = makeMetrics({
				modelBreakdown: [
					{ model: 'gpt-4', inputTokens: 100, outputTokens: 50 },
				],
			});
			const b = makeMetrics({
				modelBreakdown: [
					{ model: 'claude-opus', inputTokens: 200, outputTokens: 100 },
				],
			});

			const result = aggregateMetrics([a, b]);

			assert.ok(result.modelBreakdown);
			assert.strictEqual(result.modelBreakdown!.length, 2);
			const gpt4 = result.modelBreakdown!.find(m => m.model === 'gpt-4');
			const claude = result.modelBreakdown!.find(m => m.model === 'claude-opus');
			assert.ok(gpt4);
			assert.ok(claude);
			assert.strictEqual(gpt4!.inputTokens, 100);
			assert.strictEqual(claude!.inputTokens, 200);
		});

		test('handles undefined optional fields gracefully', () => {
			const a = makeMetrics({ durationMs: 500 });
			const b = makeMetrics({ durationMs: 300 });

			const result = aggregateMetrics([a, b]);

			assert.strictEqual(result.durationMs, 800);
			assert.strictEqual(result.premiumRequests, undefined);
			assert.strictEqual(result.turns, undefined);
			assert.strictEqual(result.modelBreakdown, undefined);
		});

		test('sums cachedTokens in model breakdown', () => {
			const a = makeMetrics({
				modelBreakdown: [
					{ model: 'gpt-4', inputTokens: 100, outputTokens: 50, cachedTokens: 20 },
				],
			});
			const b = makeMetrics({
				modelBreakdown: [
					{ model: 'gpt-4', inputTokens: 100, outputTokens: 50, cachedTokens: 30 },
				],
			});

			const result = aggregateMetrics([a, b]);
			assert.strictEqual(result.modelBreakdown![0].cachedTokens, 50);
		});
	});

	// -----------------------------------------------------------------------
	// getNodeMetrics
	// -----------------------------------------------------------------------

	suite('getNodeMetrics', () => {
		test('returns undefined when no metrics exist', () => {
			const state = makeNodeState();
			assert.strictEqual(getNodeMetrics(state), undefined);
		});

		test('returns current metrics when no attempt history', () => {
			const metrics = makeMetrics({ premiumRequests: 3 });
			const state = makeNodeState({ metrics });
			const result = getNodeMetrics(state);
			assert.ok(result);
			assert.strictEqual(result!.premiumRequests, 3);
		});

		test('aggregates metrics from attempt history', () => {
			const latestMetrics = makeMetrics({ premiumRequests: 3, durationMs: 700 });
			const state = makeNodeState({
				attemptHistory: [
					{
						attemptNumber: 1,
						status: 'failed',
						startedAt: 0,
						endedAt: 100,
						metrics: makeMetrics({ premiumRequests: 2, durationMs: 500 }),
					},
					{
						attemptNumber: 2,
						status: 'succeeded',
						startedAt: 100,
						endedAt: 200,
						metrics: latestMetrics,
					},
				],
				metrics: latestMetrics,
			});

			const result = getNodeMetrics(state);
			assert.ok(result);
			// state.metrics is same ref as latest attempt — should not double-count
			assert.strictEqual(result!.premiumRequests, 5);
			assert.strictEqual(result!.durationMs, 1200);
		});

		test('deduplicates when state.metrics is same reference as latest attempt metrics', () => {
			const latestMetrics = makeMetrics({ premiumRequests: 4, durationMs: 800 });
			const state = makeNodeState({
				attemptHistory: [
					{
						attemptNumber: 1,
						status: 'succeeded',
						startedAt: 0,
						endedAt: 100,
						metrics: latestMetrics,
					},
				],
				metrics: latestMetrics,
			});

			const result = getNodeMetrics(state);
			assert.ok(result);
			// Same reference — should only count once
			assert.strictEqual(result!.premiumRequests, 4);
			assert.strictEqual(result!.durationMs, 800);
		});

		test('ignores state.metrics when attemptHistory exists (prevents double-counting after deserialization)', () => {
			const state = makeNodeState({
				attemptHistory: [
					{
						attemptNumber: 1,
						status: 'failed',
						startedAt: 0,
						endedAt: 100,
						metrics: makeMetrics({ premiumRequests: 1, durationMs: 100 }),
					},
				],
				metrics: makeMetrics({ premiumRequests: 2, durationMs: 200 }),
			});

			const result = getNodeMetrics(state);
			assert.ok(result);
			// Only attemptHistory metrics should be counted (state.metrics is ignored)
			assert.strictEqual(result!.premiumRequests, 1);
			assert.strictEqual(result!.durationMs, 100);
		});

		test('returns undefined when attempt history exists but has no metrics', () => {
			const state = makeNodeState({
				attemptHistory: [
					{
						attemptNumber: 1,
						status: 'failed',
						startedAt: 0,
						endedAt: 100,
					},
				],
				metrics: makeMetrics({ premiumRequests: 2 }),
			});

			const result = getNodeMetrics(state);
			// When attemptHistory exists, state.metrics is ignored (even if attemptHistory has no metrics)
			assert.strictEqual(result, undefined);
		});

		test('prevents double-counting after JSON deserialization (separate object instances)', () => {
			// Simulate loading plan from disk: attemptHistory and state.metrics have identical VALUES
			// but are separate object instances (not ===)
			const originalMetrics = makeMetrics({ premiumRequests: 5, durationMs: 1000, sessionTimeSeconds: 10 });
			const state = makeNodeState({
				attemptHistory: [
					{
						attemptNumber: 1,
						status: 'succeeded',
						startedAt: 0,
						endedAt: 100,
						metrics: makeMetrics({ premiumRequests: 5, durationMs: 1000, sessionTimeSeconds: 10 }),
					},
				],
				metrics: JSON.parse(JSON.stringify(originalMetrics)), // Simulate deserialization
			});

			const result = getNodeMetrics(state);
			assert.ok(result);
			// Should only count attemptHistory metrics once, not double-count state.metrics
			assert.strictEqual(result!.premiumRequests, 5);
			assert.strictEqual(result!.durationMs, 1000);
			assert.strictEqual(result!.sessionTimeSeconds, 10);
		});

		// Additional tests as per task instructions
		test('getNodeMetrics does not double-count with single attempt', () => {
			const metrics = { durationMs: 1000, sessionTimeSeconds: 100 };
			const state: NodeExecutionState = {
				status: 'succeeded',
				version: 1,
				attempts: 1,
				metrics,
				attemptHistory: [{
					attemptNumber: 1,
					status: 'succeeded',
					startedAt: 0,
					endedAt: 1000,
					metrics // Same object reference
				}]
			};
			const result = getNodeMetrics(state);
			assert.strictEqual(result?.sessionTimeSeconds, 100); // NOT 200
		});

		test('getNodeMetrics does not double-count after JSON round-trip', () => {
			const originalState = {
				status: 'succeeded' as const,
				version: 1,
				attempts: 1,
				metrics: { durationMs: 1000, sessionTimeSeconds: 100 },
				attemptHistory: [{
					attemptNumber: 1,
					status: 'succeeded' as const,
					startedAt: 0,
					endedAt: 1000,
					metrics: { durationMs: 1000, sessionTimeSeconds: 100 }
				}]
			};
			// Simulate JSON round-trip (creates new object instances)
			const state = JSON.parse(JSON.stringify(originalState));
			const result = getNodeMetrics(state);
			assert.strictEqual(result?.sessionTimeSeconds, 100); // NOT 200
		});

		test('getNodeMetrics correctly sums multiple attempts', () => {
			const state: NodeExecutionState = {
				status: 'succeeded',
				version: 1,
				attempts: 2,
				metrics: { durationMs: 2000, sessionTimeSeconds: 200 },
				attemptHistory: [
					{ attemptNumber: 1, status: 'failed', startedAt: 0, endedAt: 1000, metrics: { durationMs: 1000, sessionTimeSeconds: 100 } },
					{ attemptNumber: 2, status: 'succeeded', startedAt: 1000, endedAt: 3000, metrics: { durationMs: 2000, sessionTimeSeconds: 200 } }
				]
			};
			const result = getNodeMetrics(state);
			// Should sum both attempts: 100 + 200 = 300, NOT 100 + 200 + 200 = 500
			assert.strictEqual(result?.sessionTimeSeconds, 300);
		});

		test('getNodeMetrics handles legacy data without attemptHistory', () => {
			const state: NodeExecutionState = {
				status: 'succeeded',
				version: 1,
				attempts: 1,
				metrics: { durationMs: 1000, sessionTimeSeconds: 100 }
				// No attemptHistory
			};
			const result = getNodeMetrics(state);
			assert.strictEqual(result?.sessionTimeSeconds, 100);
		});
	});

	// -----------------------------------------------------------------------
	// getPlanMetrics
	// -----------------------------------------------------------------------

	suite('getPlanMetrics', () => {
		test('returns undefined when no node has metrics', () => {
			const plan = {
				nodeStates: new Map([
					['n1', makeNodeState()],
					['n2', makeNodeState()],
				]),
			} as unknown as PlanInstance;

			assert.strictEqual(getPlanMetrics(plan), undefined);
		});

		test('aggregates metrics from all nodes', () => {
			const plan = {
				nodeStates: new Map([
					['n1', makeNodeState({ metrics: makeMetrics({ premiumRequests: 2, durationMs: 100 }) })],
					['n2', makeNodeState({ metrics: makeMetrics({ premiumRequests: 3, durationMs: 200 }) })],
				]),
			} as unknown as PlanInstance;

			const result = getPlanMetrics(plan);
			assert.ok(result);
			assert.strictEqual(result!.premiumRequests, 5);
			assert.strictEqual(result!.durationMs, 300);
		});

		test('getPlanMetrics correctly sums multiple nodes without double-counting', () => {
			// Test plan-level aggregation with nodes that have attemptHistory
			const plan = {
				nodeStates: new Map([
					['n1', makeNodeState({
						metrics: { durationMs: 1000, sessionTimeSeconds: 100 },
						attemptHistory: [{
							attemptNumber: 1,
							status: 'succeeded',
							startedAt: 0,
							endedAt: 1000,
							metrics: { durationMs: 1000, sessionTimeSeconds: 100 }
						}]
					})],
					['n2', makeNodeState({
						metrics: { durationMs: 2000, sessionTimeSeconds: 200 },
						attemptHistory: [
							{ attemptNumber: 1, status: 'failed', startedAt: 0, endedAt: 1000, metrics: { durationMs: 800, sessionTimeSeconds: 80 } },
							{ attemptNumber: 2, status: 'succeeded', startedAt: 1000, endedAt: 3000, metrics: { durationMs: 2000, sessionTimeSeconds: 200 } }
						]
					})],
					['n3', makeNodeState({
						metrics: { durationMs: 500, sessionTimeSeconds: 50 }
						// No attemptHistory (legacy data)
					})],
				]),
			} as unknown as PlanInstance;

			const result = getPlanMetrics(plan);
			assert.ok(result);
			// n1: 100 (single attempt, no double-count)
			// n2: 80 + 200 = 280 (two attempts, no double-count)
			// n3: 50 (legacy data)
			// Total: 100 + 280 + 50 = 430
			assert.strictEqual(result!.sessionTimeSeconds, 430);
			// Duration: n1=1000, n2=800+2000=2800, n3=500 => 4300
			assert.strictEqual(result!.durationMs, 4300);
		});
	});

	// -----------------------------------------------------------------------
	// formatPremiumRequests
	// -----------------------------------------------------------------------

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

	// -----------------------------------------------------------------------
	// formatDurationSeconds
	// -----------------------------------------------------------------------

	suite('formatDurationSeconds', () => {
		test('seconds only', () => {
			assert.strictEqual(formatDurationSeconds(32), '32s');
		});

		test('minutes and seconds', () => {
			assert.strictEqual(formatDurationSeconds(90), '1m 30s');
		});

		test('hours, minutes and seconds', () => {
			assert.strictEqual(formatDurationSeconds(3930), '1h 5m 30s');
		});

		test('zero seconds', () => {
			assert.strictEqual(formatDurationSeconds(0), '0s');
		});

		test('exact minutes', () => {
			assert.strictEqual(formatDurationSeconds(120), '2m 0s');
		});

		test('exact hours', () => {
			assert.strictEqual(formatDurationSeconds(3600), '1h 0m 0s');
		});
	});

	// -----------------------------------------------------------------------
	// formatTokenCount
	// -----------------------------------------------------------------------

	suite('formatTokenCount', () => {
		test('under 1000', () => {
			assert.strictEqual(formatTokenCount(500), '500');
		});

		test('thousands', () => {
			assert.strictEqual(formatTokenCount(231500), '231.5k');
		});

		test('millions', () => {
			assert.strictEqual(formatTokenCount(1200000), '1.2m');
		});

		test('exact thousand', () => {
			assert.strictEqual(formatTokenCount(1000), '1.0k');
		});

		test('exact million', () => {
			assert.strictEqual(formatTokenCount(1000000), '1.0m');
		});
	});

	// -----------------------------------------------------------------------
	// formatCodeChanges
	// -----------------------------------------------------------------------

	suite('formatCodeChanges', () => {
		test('formats added and removed', () => {
			assert.strictEqual(formatCodeChanges({ linesAdded: 10, linesRemoved: 3 }), '+10 -3');
		});

		test('zero changes', () => {
			assert.strictEqual(formatCodeChanges({ linesAdded: 0, linesRemoved: 0 }), '+0 -0');
		});
	});
});
