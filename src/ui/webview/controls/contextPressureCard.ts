/**
 * @fileoverview Context pressure card control — displays token usage pressure.
 *
 * Subscribes to {@link Topics.CONTEXT_PRESSURE_UPDATE} and renders a progress
 * bar showing context window fill percentage, status label, growth rate,
 * and split risk information.
 *
 * @module ui/webview/controls/contextPressureCard
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import type { ContextPressureState } from '../../../interfaces/IContextPressureMonitor';

/** Default max prompt tokens when model info is unavailable. */
const DEFAULT_MAX_PROMPT = 136_000;

/** Minimum turns of history required for growth rate display. */
const MIN_HISTORY_FOR_GROWTH = 3;

/** Maximum recent turns to use for growth/prediction calculations. */
const MAX_HISTORY_WINDOW = 10;

/** EMA weight factor for growth rate calculation. */
const EMA_WEIGHT_FACTOR = 1.5;

/**
 * Compute split risk from context pressure state.
 */
export function computeSplitRisk(state: ContextPressureState): {
  label: string;
  turnsRemaining: number;
  description: string;
} {
  if (state.level === 'critical') {
    return {
      label: 'Imminent',
      turnsRemaining: 0,
      description: 'Checkpoint sentinel written — agent will split on next turn',
    };
  }

  const maxTokens = state.maxPromptTokens ?? DEFAULT_MAX_PROMPT;
  const turnsLeft = computeTurnsToLimit(state.tokenHistory, maxTokens);

  if (state.level === 'elevated') {
    if (turnsLeft < 10) {
      return {
        label: 'High',
        turnsRemaining: turnsLeft,
        description: `~${turnsLeft} turns of headroom at current growth rate`,
      };
    }
    if (turnsLeft < 20) {
      return {
        label: 'Moderate',
        turnsRemaining: turnsLeft,
        description: `~${turnsLeft} turns remaining before checkpoint threshold`,
      };
    }
    return {
      label: 'Low',
      turnsRemaining: turnsLeft,
      description: `~${turnsLeft} turns of headroom`,
    };
  }

  return { label: 'None', turnsRemaining: Infinity, description: 'Context usage is healthy' };
}

/**
 * Compute weighted EMA growth rate (tokens per turn) from token history.
 * Returns 0 if insufficient data.
 */
export function computeGrowthRate(history: number[]): number {
  if (history.length < MIN_HISTORY_FOR_GROWTH) { return 0; }

  const recent = history.slice(-MAX_HISTORY_WINDOW);
  const growths = recent.slice(1).map((v, i) => v - recent[i]);
  if (growths.length === 0) { return 0; }

  const weights = growths.map((_, i) => Math.pow(EMA_WEIGHT_FACTOR, i));
  const weightedSum = growths.reduce((sum, g, i) => sum + g * weights[i], 0);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const avg = weightedSum / weightTotal;

  return avg > 0 ? Math.round(avg) : 0;
}

/**
 * Predict turns remaining before context limit using weighted EMA.
 */
function computeTurnsToLimit(history: number[], maxTokens: number): number {
  const rate = computeGrowthRate(history);
  if (rate <= 0 || history.length === 0) { return Infinity; }
  const remaining = maxTokens - history[history.length - 1];
  if (remaining <= 0) { return 0; }
  return Math.round(remaining / rate);
}

/** Format a token count for display (e.g. 136000 → "136k"). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}

/** Status icon for pressure level. */
function statusIcon(level: string): string {
  if (level === 'critical') { return '🔴'; }
  if (level === 'elevated') { return '⚠'; }
  return '✅';
}

/** Capitalize first letter. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** CSS color variable for pressure level. */
function barColorVar(level: string): string {
  if (level === 'critical') { return 'var(--vscode-charts-red)'; }
  if (level === 'elevated') { return 'var(--vscode-charts-yellow)'; }
  return 'var(--vscode-charts-green)';
}

/**
 * Context pressure card control.
 *
 * Renders a progress bar showing context window fill percentage,
 * growth rate, split risk, and checkpoint banner at critical level.
 */
export class ContextPressureCard extends SubscribableControl {
  private readonly _elementId: string;

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this._elementId = elementId;
    this.subscribe(Topics.CONTEXT_PRESSURE_UPDATE, (data?: ContextPressureState) => this.update(data));
  }

  update(data?: ContextPressureState): void {
    const el = this.getElement(this._elementId);
    if (!el) { return; }

    if (!data) {
      el.style.display = 'none';
      return;
    }

    // Show card when we have either pressure data (maxPromptTokens) or model usage data
    const hasTokenData = !!data.maxPromptTokens;
    const hasModelUsage = data.modelBreakdown && data.modelBreakdown.length > 0;
    if (!hasTokenData && !hasModelUsage) {
      el.style.display = 'none';
      return;
    }

    const maxTokens = data.maxPromptTokens || data.maxContextWindow || 0;

    // Pressure bar section (only when we have token limits)
    let pressureBarHtml = '';
    if (maxTokens > 0 && data.currentInputTokens > 0) {
      const pct = Math.round((data.currentInputTokens / maxTokens) * 100);
      const clampedPct = Math.min(pct, 100);
      const risk = computeSplitRisk(data);
      const growth = computeGrowthRate(data.tokenHistory);
      const color = barColorVar(data.level);

      let detailsHtml = `<span>input_tokens: ${formatTokens(data.currentInputTokens)}</span>`;
      if (growth > 0) {
        detailsHtml += `<span>~${formatTokens(growth)}/turn</span>`;
      }
      if (risk.turnsRemaining < Infinity) {
        detailsHtml += `<span>~${risk.turnsRemaining} turns remaining</span>`;
      }

      let bannerHtml = '';
      if (data.level === 'critical') {
        bannerHtml = `<div class="context-pressure-checkpoint-banner">
          ⑃ Agent will checkpoint on next turn boundary.
          Remaining work will be split into sub-jobs.
        </div>`;
      }

      pressureBarHtml = `
        <div class="context-pressure-bar-container">
          <div class="context-pressure-bar context-pressure-${data.level}" style="width:${clampedPct}%;background:${color}"></div>
        </div>
        <div class="context-pressure-stats">${pct}% of ${formatTokens(maxTokens)}</div>
        <div class="context-pressure-details">${detailsHtml}</div>
        <div class="context-pressure-status context-pressure-${data.level}">
          Status: ${statusIcon(data.level)} ${capitalize(data.level)}${risk.label !== 'None' ? ` · Split risk: ${risk.label}` : ''}
        </div>
        ${bannerHtml}`;
    }

    // Real-time model token breakdown
    let modelHtml = '';
    if (data.modelBreakdown && data.modelBreakdown.length > 0) {
      const rows = data.modelBreakdown.map(m => {
        const cached = m.cachedTokens ? `, ${formatTokens(m.cachedTokens)} cached` : '';
        return `<div class="model-row"><span class="model-name">${m.model}</span> ${formatTokens(m.inputTokens)} in, ${formatTokens(m.outputTokens)} out${cached} (${m.turns} turns)</div>`;
      }).join('');
      const tps = data.turnsPerSecond ? ` · ${data.turnsPerSecond.toFixed(1)} turns/min` : '';
      modelHtml = `<div class="context-pressure-models">
        <div class="model-breakdown-label">Model Usage (${data.totalTurns || 0} turns${tps}):</div>
        <div class="model-breakdown">${rows}</div>
      </div>`;
    }

    el.style.display = '';
    // Force the parent attempt section visible when pressure data arrives
    var parentSection = el.closest('.attempt-section');
    if (parentSection) { (parentSection as HTMLElement).style.display = ''; }
    el.innerHTML = `<div class="context-pressure-section">
      <div class="context-pressure-label">🧠 Context Window</div>
      ${pressureBarHtml}
      ${modelHtml}
    </div>`;

    this.publishUpdate(data);
  }
}
