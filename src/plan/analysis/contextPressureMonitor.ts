/**
 * @fileoverview Context Pressure Monitor implementation.
 *
 * Tracks token usage per agent delegation and computes pressure levels
 * using threshold-based classification, compaction override detection,
 * and weighted EMA growth rate prediction.
 *
 * This module is **pure logic** — no I/O, no filesystem, no raw log parsing.
 * It receives events from the Process Output Bus via ContextPressureHandler.
 *
 * @module plan/analysis/contextPressureMonitor
 */

import type {
  AgentPhase,
  ContextPressureState,
  IContextPressureMonitor,
} from '../../interfaces/IContextPressureMonitor';
import type { Disposable } from '../../interfaces/IPulseEmitter';
import type { IConfigProvider } from '../../interfaces/IConfigProvider';
import { Logger } from '../../core/logger';

const log = Logger.for('context-pressure');

// ── Fallback model caps when model_info is never received ──

const FALLBACK_MAX_PROMPT_TOKENS: Record<string, number> = {
  'claude-opus-4': 136_000,
  'claude-sonnet-4': 136_000,
  'gpt-4.1': 800_000,
  'gpt-4o': 100_000,
};

/** Conservative default when model is unknown */
const DEFAULT_FALLBACK_MAX_PROMPT = 100_000;

// ── Default thresholds ──

const DEFAULT_ELEVATED_THRESHOLD = 0.50;
const DEFAULT_CRITICAL_THRESHOLD = 0.75;
const COMPACTION_OVERRIDE_THRESHOLD = 0.60;
const GROWTH_TURNS_ESCALATION = 5;
const EMA_WEIGHT_FACTOR = 1.5;
const MAX_HISTORY_WINDOW = 10;
const MIN_HISTORY_FOR_PREDICTION = 3;

/**
 * Predict how many turns remain before the context limit is reached
 * using a weighted exponential moving average of token growth.
 *
 * Recent turns are weighted more heavily (factor 1.5 exponential decay)
 * to account for bursty growth patterns (e.g., large file reads).
 */
export function predictTurnsToLimit(history: number[], maxTokens: number): number {
  if (history.length < MIN_HISTORY_FOR_PREDICTION) { return Infinity; }

  const recent = history.slice(-MAX_HISTORY_WINDOW);
  const growths = recent.slice(1).map((v, i) => v - recent[i]);

  // Weight recent turns more heavily (exponential decay, factor 1.5)
  const weights = growths.map((_, i) => Math.pow(EMA_WEIGHT_FACTOR, i));
  const weightedSum = growths.reduce((sum, g, i) => sum + g * weights[i], 0);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const weightedAvgGrowth = weightedSum / weightTotal;

  if (weightedAvgGrowth <= 0) { return Infinity; }
  return (maxTokens - history[history.length - 1]) / weightedAvgGrowth;
}

/**
 * Default implementation of IContextPressureMonitor.
 *
 * Created per agent delegation (transient). Tracks token usage, computes
 * pressure levels, fires callbacks on level transitions.
 */
export class ContextPressureMonitor implements IContextPressureMonitor {
  private readonly _state: ContextPressureState;
  private readonly _listeners: Array<(level: 'normal' | 'elevated' | 'critical', state: ContextPressureState) => void> = [];
  private readonly _elevatedThreshold: number;
  private readonly _criticalThreshold: number;

  constructor(
    planId: string,
    nodeId: string,
    attemptNumber: number,
    agentPhase: AgentPhase,
    private readonly _config?: IConfigProvider,
  ) {
    this._elevatedThreshold = this._readThreshold('elevatedThreshold', DEFAULT_ELEVATED_THRESHOLD);
    this._criticalThreshold = this._readThreshold('criticalThreshold', DEFAULT_CRITICAL_THRESHOLD);

    this._state = {
      planId,
      nodeId,
      attemptNumber,
      agentPhase,
      maxPromptTokens: undefined,
      maxContextWindow: undefined,
      currentInputTokens: 0,
      tokenHistory: [],
      level: 'normal',
      compactionDetected: false,
      lastUpdated: Date.now(),
    };

    log.debug('Monitor created', { planId, nodeId, attemptNumber, agentPhase });
  }

  recordTurnUsage(inputTokens: number, outputTokens: number): void {
    // In pretty-printed debug logs, input_tokens and output_tokens arrive on
    // separate lines. Only overwrite the running input-token count when we
    // actually saw a non-zero input_tokens value — otherwise an output-only
    // line would reset the pressure bar to zero.
    if (inputTokens > 0) {
      this._state.currentInputTokens = inputTokens;
      this._state.tokenHistory.push(inputTokens);
    }
    this._state.lastUpdated = Date.now();

    log.debug('Turn usage recorded', {
      planId: this._state.planId,
      nodeId: this._state.nodeId,
      inputTokens,
      outputTokens,
      turnCount: this._state.tokenHistory.length,
    });

    this._recomputeLevel();
  }

  setModelLimits(maxPromptTokens: number, maxContextWindow: number): void {
    // Only update non-zero values — the debug log may report limits on
    // separate lines, so each call may only have one field populated.
    if (maxPromptTokens > 0) { this._state.maxPromptTokens = maxPromptTokens; }
    if (maxContextWindow > 0) { this._state.maxContextWindow = maxContextWindow; }
    this._state.lastUpdated = Date.now();

    log.info('Model limits set', {
      planId: this._state.planId,
      nodeId: this._state.nodeId,
      maxPromptTokens,
      maxContextWindow,
    });

    this._recomputeLevel();
  }

  recordCompaction(): void {
    this._state.compactionDetected = true;
    this._state.lastUpdated = Date.now();

    log.warn('Compaction detected', {
      planId: this._state.planId,
      nodeId: this._state.nodeId,
      currentInputTokens: this._state.currentInputTokens,
    });

    this._recomputeLevel();
  }

  getState(): ContextPressureState {
    return { ...this._state, tokenHistory: [...this._state.tokenHistory] };
  }

  setAiUsage(data: { modelBreakdown: ContextPressureState['modelBreakdown']; totalTurns: number; turnsPerSecond: number }): void {
    this._state.modelBreakdown = data.modelBreakdown;
    this._state.totalTurns = data.totalTurns;
    this._state.turnsPerSecond = data.turnsPerSecond;
    this._state.lastUpdated = Date.now();
  }

  onPressureChange(
    callback: (level: 'normal' | 'elevated' | 'critical', state: ContextPressureState) => void,
  ): Disposable {
    this._listeners.push(callback);
    return {
      dispose: () => {
        const idx = this._listeners.indexOf(callback);
        if (idx >= 0) { this._listeners.splice(idx, 1); }
      },
    };
  }

  reset(): void {
    this._state.maxPromptTokens = undefined;
    this._state.maxContextWindow = undefined;
    this._state.currentInputTokens = 0;
    this._state.tokenHistory = [];
    this._state.level = 'normal';
    this._state.compactionDetected = false;
    this._state.lastUpdated = Date.now();

    log.info('Monitor reset', {
      planId: this._state.planId,
      nodeId: this._state.nodeId,
    });
  }

  // ── Private helpers ──

  private _getEffectiveMax(): number {
    if (this._state.maxPromptTokens !== undefined) {
      return this._state.maxPromptTokens;
    }
    // Try fallback by known model names
    for (const [model, cap] of Object.entries(FALLBACK_MAX_PROMPT_TOKENS)) {
      // The model name won't be known here without model_info, so use conservative default
      void model;
      void cap;
    }
    return DEFAULT_FALLBACK_MAX_PROMPT;
  }

  private _recomputeLevel(): void {
    const maxTokens = this._getEffectiveMax();
    const previous = this._state.level;

    let newLevel: 'normal' | 'elevated' | 'critical' = 'normal';

    const pressure = this._state.currentInputTokens / maxTokens;

    // Basic threshold classification
    if (pressure >= this._criticalThreshold) {
      newLevel = 'critical';
    } else if (pressure >= this._elevatedThreshold) {
      newLevel = 'elevated';
    }

    // Compaction override: compaction + >60% → immediate critical
    if (
      this._state.compactionDetected &&
      pressure > COMPACTION_OVERRIDE_THRESHOLD &&
      newLevel !== 'critical'
    ) {
      log.warn('Compaction override → critical', {
        planId: this._state.planId,
        nodeId: this._state.nodeId,
        pressure,
      });
      newLevel = 'critical';
    }

    // Growth rate escalation: if predicted turns to limit < 5 → critical
    if (newLevel !== 'critical') {
      const turnsRemaining = predictTurnsToLimit(this._state.tokenHistory, maxTokens);
      if (turnsRemaining < GROWTH_TURNS_ESCALATION) {
        log.warn('Growth rate escalation → critical', {
          planId: this._state.planId,
          nodeId: this._state.nodeId,
          turnsRemaining,
          pressure,
        });
        newLevel = 'critical';
      }
    }

    this._state.level = newLevel;

    if (newLevel !== previous) {
      log.info('Pressure level changed', {
        planId: this._state.planId,
        nodeId: this._state.nodeId,
        from: previous,
        to: newLevel,
        pressure,
        currentInputTokens: this._state.currentInputTokens,
        maxTokens,
      });
      this._notifyListeners(newLevel);
    }
  }

  private _notifyListeners(level: 'normal' | 'elevated' | 'critical'): void {
    const snapshot = this.getState();
    for (const cb of this._listeners) {
      try {
        cb(level, snapshot);
      } catch (err) {
        log.error('Listener error', { error: (err as Error).message });
      }
    }
  }

  private _readThreshold(key: string, fallback: number): number {
    if (!this._config) { return fallback; }
    try {
      return this._config.getConfig<number>('copilotOrchestrator.contextPressure', key, fallback);
    } catch {
      return fallback;
    }
  }
}

/** Fallback model token caps for use when model_info is not received */
export { FALLBACK_MAX_PROMPT_TOKENS };
