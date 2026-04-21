/**
 * @fileoverview Merged context pressure handler for the process output bus.
 *
 * Combines three debug-log regex concerns (token usage, model limits,
 * compaction detection) into a single handler backed by one
 * {@link IContextPressureMonitor}. See PROCESS_OUTPUT_BUS_DESIGN.md §6.2.
 *
 * @module agent/handlers/contextPressureHandler
 */

import type { IOutputHandler, OutputSource } from '../../interfaces/IOutputHandler';
import { OutputSources } from '../../interfaces/IOutputHandler';
import type { IOutputHandlerFactory, HandlerContext } from '../../interfaces/IOutputHandlerRegistry';
import type { IContextPressureMonitor } from '../../interfaces/IContextPressureMonitor';
import { ContextPressureMonitor } from '../../plan/analysis/contextPressureMonitor';
import { registerMonitor, unregisterMonitor, getCheckpointManager } from '../../plan/analysis/pressureMonitorRegistry';
import { Logger } from '../../core/logger';

const log = Logger.for('context-pressure');

// ── Regex patterns (from PROCESS_OUTPUT_BUS_DESIGN.md §6.2) ──

const RE_INPUT_TOKENS = /"input_tokens":\s*(\d+)/;
const RE_OUTPUT_TOKENS = /"output_tokens":\s*(\d+)/;
const RE_CACHE_READ_TOKENS = /"cache_read_tokens":\s*(\d+)/;
const RE_MAX_PROMPT = /"max_prompt_tokens":\s*(\d+)/;
const RE_MAX_WINDOW = /"max_context_window_tokens":\s*(\d+)/;
const RE_COMPACTION = /"truncateBasedOn":\s*"tokenCount"/;
const RE_MODEL = /"model":\s*"([^"]+)"/;

/** Per-model accumulated token usage for real-time AI Usage display. */
export interface ModelTokenAccumulator {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  turns: number;
}

/**
 * Single merged handler for all context-pressure patterns on the debug-log source.
 *
 * Listens for token usage, model limits, and compaction events on each line
 * and delegates to the injected {@link IContextPressureMonitor}.
 */
export class ContextPressureHandler implements IOutputHandler {
  readonly name = 'context-pressure';
  readonly sources = [OutputSources.logFile('debug-log')];
  readonly windowSize = 15; // Need lookback for model name near token usage lines

  /** Per-model accumulated token usage. */
  private _modelTokens = new Map<string, ModelTokenAccumulator>();
  /** Total turns across all models. */
  private _totalTurns = 0;
  /** Timestamp of first turn. */
  private _firstTurnAt: number | undefined;

  constructor(private readonly _monitor: IContextPressureMonitor) {}

  onLine(window: ReadonlyArray<string>, _source: OutputSource): void {
    const line = window[window.length - 1];

    // Token usage — also accumulate per-model breakdown
    const inputMatch = RE_INPUT_TOKENS.exec(line);
    const outputMatch = RE_OUTPUT_TOKENS.exec(line);
    if (inputMatch || outputMatch) {
      const inputTokens = inputMatch ? parseInt(inputMatch[1], 10) : 0;
      const outputTokens = outputMatch ? parseInt(outputMatch[1], 10) : 0;

      this._monitor.recordTurnUsage(inputTokens, outputTokens);

      // Extract model name and cache_read_tokens from current line first, then lookback
      let model = 'unknown';
      let cachedTokens = 0;

      // Check current line (scripted output may have everything on one line)
      const lineModelMatch = RE_MODEL.exec(line);
      if (lineModelMatch && !line.includes('max_') && !line.includes('"object"')) {
        model = lineModelMatch[1];
      }
      const lineCacheMatch = RE_CACHE_READ_TOKENS.exec(line);
      if (lineCacheMatch) { cachedTokens = parseInt(lineCacheMatch[1], 10); }

      // Look back in window for model name and cache_read_tokens if not found
      if (model === 'unknown' || !cachedTokens) {
        for (let i = window.length - 2; i >= 0; i--) {
          const prev = window[i];
          if (model === 'unknown') {
            const modelMatch = RE_MODEL.exec(prev);
            if (modelMatch && !prev.includes('max_') && !prev.includes('"object"')) {
              model = modelMatch[1];
            }
          }
          if (!cachedTokens) {
            const cacheMatch = RE_CACHE_READ_TOKENS.exec(prev);
            if (cacheMatch) { cachedTokens = parseInt(cacheMatch[1], 10); }
          }
        }
      }

      // Accumulate per-model
      let acc = this._modelTokens.get(model);
      if (!acc) {
        acc = { model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 };
        this._modelTokens.set(model, acc);
      }
      acc.inputTokens += inputTokens;
      acc.outputTokens += outputTokens;
      acc.cachedTokens += cachedTokens;
      // Only count a turn on the input_tokens line — in pretty-printed debug
      // logs, input_tokens and output_tokens arrive on separate lines and we
      // don't want to double-count a single model call as two turns.
      if (inputTokens > 0) {
        acc.turns++;
        this._totalTurns++;
        if (!this._firstTurnAt) { this._firstTurnAt = Date.now(); }
      }

      // Push accumulated AI usage to monitor for producer delivery
      const usage = this.getModelTokenUsage();
      this._monitor.setAiUsage({
        modelBreakdown: usage.models,
        totalTurns: usage.totalTurns,
        turnsPerSecond: usage.turnsPerSecond,
      });
    }

    // Model limits
    const promptMatch = RE_MAX_PROMPT.exec(line);
    const windowMatch = RE_MAX_WINDOW.exec(line);
    if (promptMatch || windowMatch) {
      this._monitor.setModelLimits(
        promptMatch ? parseInt(promptMatch[1], 10) : 0,
        windowMatch ? parseInt(windowMatch[1], 10) : 0,
      );
    }

    // Compaction
    if (RE_COMPACTION.test(line)) {
      this._monitor.recordCompaction();
    }
  }

  /** Expose the monitor for UI producers that need to read pressure state */
  get monitor(): IContextPressureMonitor {
    return this._monitor;
  }

  /** Get accumulated per-model token usage for real-time AI Usage display. */
  getModelTokenUsage(): { models: ModelTokenAccumulator[]; totalTurns: number; turnsPerSecond: number } {
    const models = Array.from(this._modelTokens.values());
    const elapsed = this._firstTurnAt ? (Date.now() - this._firstTurnAt) / 1000 : 0;
    const turnsPerSecond = elapsed > 5 ? (this._totalTurns / elapsed) * 60 : 0; // turns per minute, only after 5s warmup
    return { models, totalTurns: this._totalTurns, turnsPerSecond };
  }

  dispose(): void {
    const state = this._monitor.getState();
    unregisterMonitor(state.planId, state.nodeId);
  }
}

/**
 * Factory that creates {@link ContextPressureHandler} instances for copilot processes.
 *
 * Returns `undefined` when planId or nodeId is missing (e.g. model discovery,
 * CLI check — not a plan job), or when the context-pressure feature is
 * disabled (no global checkpoint manager registered).
 */
export const ContextPressureHandlerFactory: IOutputHandlerFactory = {
  name: 'context-pressure',
  processFilter: ['copilot'],
  create: (ctx: HandlerContext): IOutputHandler | undefined => {
    if (!ctx.planId || !ctx.nodeId) {
      return undefined;
    }
    // Feature gate: planInitialization only registers the global checkpoint
    // manager when copilotOrchestrator.contextPressure.enabled is true. When
    // it's absent we short-circuit the entire detection path — no monitor is
    // created, no token tracking, no sentinel writes, no DAG reshape. This
    // makes the setting fully authoritative: OFF means OFF end-to-end.
    if (!getCheckpointManager()) {
      return undefined;
    }
    const monitor = new ContextPressureMonitor(ctx.planId, ctx.nodeId, 1, 'work');
    registerMonitor(ctx.planId, ctx.nodeId, monitor);

    // Subscribe to pressure transitions and write the checkpoint sentinel
    // when level becomes critical. The agent picks up the sentinel and
    // initiates the checkpoint protocol.
    if (ctx.worktreePath) {
      const worktreePath = ctx.worktreePath;
      let sentinelWritten = false;
      monitor.onPressureChange((level, state) => {
        if (level !== 'critical' || sentinelWritten) { return; }
        const mgr = getCheckpointManager();
        if (!mgr) {
          log.warn('Pressure critical but no checkpoint manager registered — cannot write sentinel', {
            planId: ctx.planId, nodeId: ctx.nodeId,
          });
          return;
        }
        sentinelWritten = true;
        const adaptedState = {
          level: state.level,
          currentInputTokens: state.currentInputTokens,
          maxPromptTokens: state.maxPromptTokens ?? 0,
          pressure: state.maxPromptTokens
            ? state.currentInputTokens / state.maxPromptTokens
            : 0,
        };
        mgr.writeSentinel(worktreePath, adaptedState).then(() => {
          log.info('Checkpoint sentinel written for critical pressure', {
            planId: ctx.planId,
            nodeId: ctx.nodeId,
            worktreePath,
            currentInputTokens: state.currentInputTokens,
            maxPromptTokens: state.maxPromptTokens,
          });
        }).catch(err => {
          log.error('Failed to write checkpoint sentinel', {
            planId: ctx.planId,
            nodeId: ctx.nodeId,
            error: String(err),
          });
        });
      });
    } else {
      log.warn('No worktreePath in handler context — checkpoint sentinel cannot be written on critical pressure', {
        planId: ctx.planId, nodeId: ctx.nodeId,
      });
    }

    return new ContextPressureHandler(monitor);
  },
};
