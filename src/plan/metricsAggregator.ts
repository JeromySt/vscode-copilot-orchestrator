/**
 * @fileoverview Metrics Aggregation Utility
 *
 * Aggregates CopilotUsageMetrics at multiple levels:
 * - Phase-level (individual invocations)
 * - Attempt-level (single execution attempt)
 * - Node-level (all attempts for a node)
 * - Plan-level (all nodes in a plan)
 *
 * @module plan/metricsAggregator
 */

import { CopilotUsageMetrics, ModelUsageBreakdown, NodeExecutionState, AttemptRecord } from './types';
import type { PlanInstance } from './types';

/**
 * Combine an array of metrics into a single aggregate.
 */
export function aggregateMetrics(metrics: CopilotUsageMetrics[]): CopilotUsageMetrics {
	if (metrics.length === 0) {
		return { durationMs: 0 };
	}
	if (metrics.length === 1) {
		return metrics[0];
	}

	let premiumRequests = 0;
	let apiTimeSeconds = 0;
	let sessionTimeSeconds = 0;
	let linesAdded = 0;
	let linesRemoved = 0;
	let durationMs = 0;
	let turns = 0;
	let toolCalls = 0;
	let hasPremium = false;
	let hasApi = false;
	let hasSession = false;
	let hasCode = false;
	let hasTurns = false;
	let hasToolCalls = false;
	const modelMap = new Map<string, ModelUsageBreakdown>();

	for (const m of metrics) {
		durationMs += m.durationMs;

		if (m.premiumRequests !== undefined) {
			hasPremium = true;
			premiumRequests += m.premiumRequests;
		}
		if (m.apiTimeSeconds !== undefined) {
			hasApi = true;
			apiTimeSeconds += m.apiTimeSeconds;
		}
		if (m.sessionTimeSeconds !== undefined) {
			hasSession = true;
			sessionTimeSeconds += m.sessionTimeSeconds;
		}
		if (m.codeChanges) {
			hasCode = true;
			linesAdded += m.codeChanges.linesAdded;
			linesRemoved += m.codeChanges.linesRemoved;
		}
		if (m.turns !== undefined) {
			hasTurns = true;
			turns += m.turns;
		}
		if (m.toolCalls !== undefined) {
			hasToolCalls = true;
			toolCalls += m.toolCalls;
		}
		if (m.modelBreakdown) {
			for (const b of m.modelBreakdown) {
				const existing = modelMap.get(b.model);
				if (existing) {
					existing.inputTokens += b.inputTokens;
					existing.outputTokens += b.outputTokens;
					if (b.cachedTokens !== undefined) {
						existing.cachedTokens = (existing.cachedTokens ?? 0) + b.cachedTokens;
					}
					if (b.premiumRequests !== undefined) {
						existing.premiumRequests = (existing.premiumRequests ?? 0) + b.premiumRequests;
					}
				} else {
					modelMap.set(b.model, { ...b });
				}
			}
		}
	}

	const result: CopilotUsageMetrics = { durationMs };
	if (hasPremium) { result.premiumRequests = premiumRequests; }
	if (hasApi) { result.apiTimeSeconds = apiTimeSeconds; }
	if (hasSession) { result.sessionTimeSeconds = sessionTimeSeconds; }
	if (hasCode) { result.codeChanges = { linesAdded, linesRemoved }; }
	if (hasTurns) { result.turns = turns; }
	if (hasToolCalls) { result.toolCalls = toolCalls; }
	if (modelMap.size > 0) { result.modelBreakdown = Array.from(modelMap.values()); }

	return result;
}

/**
 * Compute aggregate metrics for a node by combining current metrics
 * and all attempt history metrics, avoiding double-counting.
 */
export function getNodeMetrics(state: NodeExecutionState): CopilotUsageMetrics | undefined {
	const allMetrics: CopilotUsageMetrics[] = [];

	// Collect attempt history metrics
	if (state.attemptHistory) {
		for (const attempt of state.attemptHistory) {
			if (attempt.metrics) {
				allMetrics.push(attempt.metrics);
			}
		}
	}

	// Add current metrics, but avoid double-counting if it matches the latest attempt
	if (state.metrics) {
		const latestAttempt = state.attemptHistory?.[state.attemptHistory.length - 1];
		if (!latestAttempt || latestAttempt.metrics !== state.metrics) {
			allMetrics.push(state.metrics);
		}
	}

	if (allMetrics.length === 0) {
		return undefined;
	}

	return aggregateMetrics(allMetrics);
}

/**
 * Compute aggregate metrics for the entire plan by combining metrics from all nodes.
 */
export function getPlanMetrics(plan: PlanInstance): CopilotUsageMetrics | undefined {
	const allMetrics: CopilotUsageMetrics[] = [];

	for (const [, state] of plan.nodeStates) {
		const nodeMetrics = getNodeMetrics(state);
		if (nodeMetrics) {
			allMetrics.push(nodeMetrics);
		}
	}

	if (allMetrics.length === 0) {
		return undefined;
	}

	return aggregateMetrics(allMetrics);
}

/**
 * Format premium request count (e.g. '3 Premium requests', '1 Premium request').
 */
export function formatPremiumRequests(n: number): string {
	return `${n} Premium request${n === 1 ? '' : 's'}`;
}

/**
 * Format duration in human-readable form.
 */
export function formatDurationSeconds(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);

	if (h > 0) {
		return `${h}h ${m}m ${s}s`;
	}
	if (m > 0) {
		return `${m}m ${s}s`;
	}
	return `${s}s`;
}

/**
 * Format large token counts.
 */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}m`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(1)}k`;
	}
	return `${n}`;
}

/**
 * Format code changes as '+N -M'.
 */
export function formatCodeChanges(changes: { linesAdded: number; linesRemoved: number }): string {
	return `+${changes.linesAdded} -${changes.linesRemoved}`;
}
