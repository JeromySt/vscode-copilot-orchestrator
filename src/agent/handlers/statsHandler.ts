/**
 * @fileoverview Output handler for Copilot CLI summary statistics from stdout.
 *
 * Implements {@link IOutputHandler} to extract usage metrics from the Copilot
 * CLI stdout summary. This is the Process Output Bus equivalent of the legacy
 * {@link CopilotStatsParser} — same regex logic, new handler contract.
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §6.1
 * @module agent/handlers/statsHandler
 */

import type { IOutputHandler, OutputSource } from '../../interfaces/IOutputHandler';
import { OutputSources } from '../../interfaces/IOutputHandler';
import type { IOutputHandlerFactory, HandlerContext } from '../../interfaces/IOutputHandlerRegistry';
import type { CopilotUsageMetrics, ModelUsageBreakdown, CodeChangeStats } from '../../plan/types';

/**
 * Parse a duration string like '32s', '1m 30s', '2h 5m 10s' into seconds.
 */
export function parseDuration(str: string): number {
  let total = 0;
  const hours = str.match(/([\d.]+)\s*h/);
  const minutes = str.match(/([\d.]+)\s*m(?!s)/);
  const seconds = str.match(/([\d.]+)\s*s/);
  if (hours) { total += parseFloat(hours[1]) * 3600; }
  if (minutes) { total += parseFloat(minutes[1]) * 60; }
  if (seconds) { total += parseFloat(seconds[1]); }
  return total;
}

/**
 * Parse a token count string like '231.5k', '1.2m', or '500' into a number.
 */
export function parseTokenCount(str: string): number {
  const trimmed = str.trim().toLowerCase();
  const mMatch = trimmed.match(/^([\d.]+)m$/);
  if (mMatch) { return parseFloat(mMatch[1]) * 1_000_000; }
  const kMatch = trimmed.match(/^([\d.]+)k$/);
  if (kMatch) { return parseFloat(kMatch[1]) * 1_000; }
  return parseFloat(trimmed);
}

/**
 * Strip any leading prefix such as `[copilot]` or `[12:46:20 PM] [INFO] [copilot]`.
 * Returns the content after the last `]` that precedes real content,
 * or the original line if no brackets are found.
 */
function stripPrefix(line: string): string {
  return line.replace(/^(\s*\[.*?\]\s*)+/, '').trim();
}

/**
 * Output handler that extracts Copilot CLI summary statistics from stdout.
 *
 * Registered via {@link StatsHandlerFactory} for processes with the 'copilot' label.
 * Accumulates metrics line-by-line and exposes them via {@link getMetrics}.
 */
export class StatsHandler implements IOutputHandler {
  readonly name = 'stats';
  readonly sources = [OutputSources.stdout, OutputSources.stderr];
  readonly windowSize = 1;

  private _premiumRequests?: number;
  private _apiTimeSeconds?: number;
  private _sessionTimeSeconds?: number;
  private _codeChanges?: CodeChangeStats;
  private _modelBreakdown?: ModelUsageBreakdown[];
  private _parsingModels = false;
  private _hasAnyMetric = false;
  private _statsStartedAt?: number;

  /**
   * Called for each new stdout line. The window contains the latest line.
   */
  onLine(window: ReadonlyArray<string>, _source: OutputSource): void {
    const line = window[window.length - 1];
    const content = stripPrefix(line);
    if (!content) {
      return;
    }

    // Total usage est: N Premium requests
    const premiumMatch = content.match(/Total usage est:\s+([\d.]+)\s+Premium requests?/i);
    if (premiumMatch) {
      this._premiumRequests = parseFloat(premiumMatch[1]);
      this._hasAnyMetric = true;
      this._statsStartedAt = Date.now();
      this._parsingModels = false;
      return;
    }

    // API time spent: <duration>
    const apiTimeMatch = content.match(/API time spent:\s+(.+)/i);
    if (apiTimeMatch) {
      this._apiTimeSeconds = parseDuration(apiTimeMatch[1].trim());
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      this._parsingModels = false;
      return;
    }

    // Total session time: <duration>
    const sessionTimeMatch = content.match(/Total session time:\s+(.+)/i);
    if (sessionTimeMatch) {
      this._sessionTimeSeconds = parseDuration(sessionTimeMatch[1].trim());
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      this._parsingModels = false;
      return;
    }

    // Total code changes: +N -M
    const codeChangesMatch = content.match(/Total code changes:\s+\+(\d+)\s+-(\d+)/i);
    if (codeChangesMatch) {
      this._codeChanges = {
        linesAdded: parseInt(codeChangesMatch[1], 10),
        linesRemoved: parseInt(codeChangesMatch[2], 10),
      };
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      this._parsingModels = false;
      return;
    }

    // CLI v1.0.34 compact format — "Changes   +N -M" (no "Total code changes:" prefix)
    const compactChangesMatch = content.match(/^Changes\s+\+(\d+)\s+-(\d+)\s*$/i);
    if (compactChangesMatch) {
      this._codeChanges = {
        linesAdded: parseInt(compactChangesMatch[1], 10),
        linesRemoved: parseInt(compactChangesMatch[2], 10),
      };
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      this._parsingModels = false;
      return;
    }

    // CLI v1.0.34 compact format — "Requests  N Premium (Xm Ys)"
    const compactRequestsMatch = content.match(/^Requests\s+([\d.]+)\s+Premium\s+\(([^)]+)\)\s*$/i);
    if (compactRequestsMatch) {
      this._premiumRequests = parseFloat(compactRequestsMatch[1]);
      this._apiTimeSeconds = parseDuration(compactRequestsMatch[2].trim());
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      this._parsingModels = false;
      return;
    }

    // CLI v1.0.34 compact format — "Tokens    ↑ X • ↓ Y • Z (cached)"
    // Bullet may be Unicode '•' (U+2022) or ASCII fallback; arrows are '↑' / '↓'.
    const compactTokensMatch = content.match(
      /^Tokens\s+[↑\^]\s*([\d.]+[km]?)\s*[•·*]\s*[↓v]\s*([\d.]+[km]?)(?:\s*[•·*]\s*([\d.]+[km]?)\s*\(cached\))?\s*$/i
    );
    if (compactTokensMatch) {
      const inputTokens = parseTokenCount(compactTokensMatch[1]);
      const outputTokens = parseTokenCount(compactTokensMatch[2]);
      const cached = compactTokensMatch[3] ? parseTokenCount(compactTokensMatch[3]) : undefined;
      // Synthesize a single-model breakdown entry so downstream code (which derives
      // tokenUsage from modelBreakdown) keeps working even when no per-model lines
      // appear (the v1.0.34 compact format omits them on short runs).
      if (!this._modelBreakdown || this._modelBreakdown.length === 0) {
        const entry: ModelUsageBreakdown = { model: 'unknown', inputTokens, outputTokens };
        if (cached !== undefined) { entry.cachedTokens = cached; }
        this._modelBreakdown = [entry];
      }
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      this._parsingModels = false;
      return;
    }

    // Breakdown by AI model:
    if (/Breakdown by AI model:/i.test(content)) {
      this._parsingModels = true;
      this._hasAnyMetric = true;
      if (!this._statsStartedAt) { this._statsStartedAt = Date.now(); }
      return;
    }

    // Model breakdown line (only when _parsingModels is true)
    if (this._parsingModels) {
      const modelMatch = content.match(
        /^([\w./-]+)\s+([\d.]+[km]?)\s+in,\s+([\d.]+[km]?)\s+out(?:,\s+([\d.]+[km]?)\s+cached)?(?:\s+\(Est\.\s+([\d.]+)\s+Premium requests?\))?/i
      );
      if (modelMatch) {
        if (!this._modelBreakdown) {
          this._modelBreakdown = [];
        }
        const breakdown: ModelUsageBreakdown = {
          model: modelMatch[1],
          inputTokens: parseTokenCount(modelMatch[2]),
          outputTokens: parseTokenCount(modelMatch[3]),
        };
        if (modelMatch[4]) {
          breakdown.cachedTokens = parseTokenCount(modelMatch[4]);
        }
        if (modelMatch[5]) {
          breakdown.premiumRequests = parseFloat(modelMatch[5]);
        }
        this._modelBreakdown.push(breakdown);
      }
    }
  }

  /**
   * Returns the timestamp when the CLI started printing stats summary output,
   * or undefined if stats haven't been detected yet.
   */
  getStatsStartedAt(): number | undefined {
    return this._statsStartedAt;
  }

  /**
   * Returns the accumulated metrics, or `undefined` if no stats were found.
   */
  getMetrics(): CopilotUsageMetrics | undefined {
    if (!this._hasAnyMetric) {
      return undefined;
    }
    const metrics: CopilotUsageMetrics = {
      durationMs: 0,
    };
    if (this._premiumRequests !== undefined) { metrics.premiumRequests = this._premiumRequests; }
    if (this._apiTimeSeconds !== undefined) { metrics.apiTimeSeconds = this._apiTimeSeconds; }
    if (this._sessionTimeSeconds !== undefined) { metrics.sessionTimeSeconds = this._sessionTimeSeconds; }
    if (this._codeChanges) { metrics.codeChanges = this._codeChanges; }
    if (this._modelBreakdown) { metrics.modelBreakdown = this._modelBreakdown; }
    return metrics;
  }
}

/**
 * Factory that creates {@link StatsHandler} instances for 'copilot' processes.
 */
export const StatsHandlerFactory: IOutputHandlerFactory = {
  name: 'stats',
  processFilter: ['copilot'],
  create: (_context: HandlerContext): StatsHandler => new StatsHandler(),
};
