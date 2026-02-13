/**
 * @fileoverview AI usage stats control — displays token counts and costs.
 *
 * Subscribes to {@link Topics.AI_USAGE_UPDATE} and renders model breakdown,
 * token counts, and premium request metrics.
 *
 * @module ui/webview/controls/aiUsageStats
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Model usage breakdown entry. */
export interface ModelBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  premiumRequests?: number;
}

/** Data delivered with each update. */
export interface AiUsageData {
  premiumRequests?: number;
  apiTimeSeconds?: number;
  sessionTimeSeconds?: number;
  modelBreakdown?: ModelBreakdown[];
}

/**
 * Format a token count with k/m suffixes.
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}m`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
  return `${n}`;
}

/**
 * Format duration in seconds to human-readable.
 */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) { return `${h}h ${m}m ${s}s`; }
  if (m > 0) { return `${m}m ${s}s`; }
  return `${s}s`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * AI usage stats control.
 */
export class AiUsageStats extends SubscribableControl {
  private elementId: string;

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
    this.subscribe(Topics.AI_USAGE_UPDATE, (data?: AiUsageData) => this.update(data));
  }

  update(data?: AiUsageData): void {
    if (!data) { return; }
    const el = this.getElement(this.elementId);
    if (!el) { return; }

    const parts: string[] = [];
    if (data.premiumRequests !== undefined) {
      parts.push(`<span class="metric-item">🎫 ${data.premiumRequests} req</span>`);
    }
    if (data.apiTimeSeconds !== undefined) {
      parts.push(`<span class="metric-item">⏱ API: ${formatDuration(data.apiTimeSeconds)}</span>`);
    }
    if (data.sessionTimeSeconds !== undefined) {
      parts.push(`<span class="metric-item">🕐 Session: ${formatDuration(data.sessionTimeSeconds)}</span>`);
    }

    let modelHtml = '';
    if (data.modelBreakdown && data.modelBreakdown.length > 0) {
      const rows = data.modelBreakdown.map(m => {
        const cached = m.cachedTokens ? `, ${formatTokenCount(m.cachedTokens)} cached` : '';
        const reqs = m.premiumRequests !== undefined ? ` (${m.premiumRequests} req)` : '';
        return `<div class="model-row"><span class="model-name">${escapeHtml(m.model)}</span> ${formatTokenCount(m.inputTokens)} in, ${formatTokenCount(m.outputTokens)} out${cached}${reqs}</div>`;
      }).join('');
      modelHtml = `<div class="model-breakdown">${rows}</div>`;
    }

    el.innerHTML = `<div class="metrics-stats-grid">${parts.join('')}</div>${modelHtml}`;
    el.style.display = parts.length > 0 || modelHtml ? '' : 'none';
    this.publishUpdate(data);
  }
}
