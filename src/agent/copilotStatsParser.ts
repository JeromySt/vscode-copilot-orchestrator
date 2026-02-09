/**
 * @fileoverview Parser for Copilot CLI summary statistics from stdout.
 *
 * Copilot CLI prints usage stats to stdout when it completes. This parser
 * accepts lines one at a time via {@link CopilotStatsParser.feedLine} and
 * builds up a {@link CopilotUsageMetrics} object.
 *
 * @module agent/copilotStatsParser
 */

import type { CopilotUsageMetrics, ModelUsageBreakdown, CodeChangeStats } from '../plan/types';

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
  // Remove all leading bracket groups like [copilot], [12:46:20 PM], [INFO]
  return line.replace(/^(\s*\[.*?\]\s*)+/, '').trim();
}

/**
 * Parser for Copilot CLI summary statistics emitted to stdout.
 *
 * Usage:
 * ```typescript
 * const parser = new CopilotStatsParser();
 * for (const line of lines) {
 *   parser.feedLine(line);
 * }
 * const metrics = parser.getMetrics();
 * ```
 */
export class CopilotStatsParser {
  private premiumRequests?: number;
  private apiTimeSeconds?: number;
  private sessionTimeSeconds?: number;
  private codeChanges?: CodeChangeStats;
  private modelBreakdown?: ModelUsageBreakdown[];
  private parsingModels = false;
  private hasAnyMetric = false;

  /**
   * Feed a single line of stdout to the parser.
   */
  feedLine(line: string): void {
    const content = stripPrefix(line);
    if (!content) {
      return;
    }

    // Total usage est: N Premium requests
    const premiumMatch = content.match(/Total usage est:\s+([\d.]+)\s+Premium requests?/i);
    if (premiumMatch) {
      this.premiumRequests = parseFloat(premiumMatch[1]);
      this.hasAnyMetric = true;
      this.parsingModels = false;
      return;
    }

    // API time spent: <duration>
    const apiTimeMatch = content.match(/API time spent:\s+(.+)/i);
    if (apiTimeMatch) {
      this.apiTimeSeconds = parseDuration(apiTimeMatch[1].trim());
      this.hasAnyMetric = true;
      this.parsingModels = false;
      return;
    }

    // Total session time: <duration>
    const sessionTimeMatch = content.match(/Total session time:\s+(.+)/i);
    if (sessionTimeMatch) {
      this.sessionTimeSeconds = parseDuration(sessionTimeMatch[1].trim());
      this.hasAnyMetric = true;
      this.parsingModels = false;
      return;
    }

    // Total code changes: +N -M
    const codeChangesMatch = content.match(/Total code changes:\s+\+(\d+)\s+-(\d+)/i);
    if (codeChangesMatch) {
      this.codeChanges = {
        linesAdded: parseInt(codeChangesMatch[1], 10),
        linesRemoved: parseInt(codeChangesMatch[2], 10),
      };
      this.hasAnyMetric = true;
      this.parsingModels = false;
      return;
    }

    // Breakdown by AI model:
    if (/Breakdown by AI model:/i.test(content)) {
      this.parsingModels = true;
      this.hasAnyMetric = true;
      return;
    }

    // Model breakdown line (only when parsingModels is true)
    // e.g. "claude-opus-4.6   231.5k in, 1.3k out, 158.2k cached (Est. 3 Premium requests)"
    if (this.parsingModels) {
      const modelMatch = content.match(
        /^([\w./-]+)\s+([\d.]+[km]?)\s+in,\s+([\d.]+[km]?)\s+out(?:,\s+([\d.]+[km]?)\s+cached)?(?:\s+\(Est\.\s+([\d.]+)\s+Premium requests?\))?/i
      );
      if (modelMatch) {
        if (!this.modelBreakdown) {
          this.modelBreakdown = [];
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
        this.modelBreakdown.push(breakdown);
      }
    }
  }

  /**
   * Returns the accumulated metrics, or `undefined` if no stats were found.
   */
  getMetrics(): CopilotUsageMetrics | undefined {
    if (!this.hasAnyMetric) {
      return undefined;
    }
    const metrics: CopilotUsageMetrics = {
      durationMs: 0, // Measured externally by the orchestrator
    };
    if (this.premiumRequests !== undefined) { metrics.premiumRequests = this.premiumRequests; }
    if (this.apiTimeSeconds !== undefined) { metrics.apiTimeSeconds = this.apiTimeSeconds; }
    if (this.sessionTimeSeconds !== undefined) { metrics.sessionTimeSeconds = this.sessionTimeSeconds; }
    if (this.codeChanges) { metrics.codeChanges = this.codeChanges; }
    if (this.modelBreakdown) { metrics.modelBreakdown = this.modelBreakdown; }
    return metrics;
  }
}

export default CopilotStatsParser;
