/**
 * @fileoverview Interface for context pressure monitoring.
 *
 * Tracks token usage per agent delegation and computes pressure levels
 * to detect when an agent's context window is filling up. The monitor
 * receives typed events from a log parser — it does no I/O or raw parsing.
 *
 * @module interfaces/IContextPressureMonitor
 */

import type { Disposable } from './IPulseEmitter';

/**
 * Which execution phase spawned this agent instance.
 *
 * All three user-facing phases (prechecks, work, postchecks) accept AgentSpec
 * and route through ICopilotRunner — each gets its own monitor via
 * ContextPressureHandlerFactory. Only 'work' delegations are eligible
 * for checkpoint splitting.
 */
export type AgentPhase = 'prechecks' | 'work' | 'postchecks' | 'auto-heal';

/**
 * Snapshot of context pressure state for a single agent delegation.
 */
export interface ContextPressureState {
  // ── Instance identity (set once at monitor creation) ──

  /** Plan this delegation belongs to */
  readonly planId: string;
  /** Node this delegation is executing */
  readonly nodeId: string;
  /** Attempt number (1-based) — distinguishes retries */
  readonly attemptNumber: number;
  /** Which execution phase spawned this agent instance */
  readonly agentPhase: AgentPhase;

  // ── Token tracking (updated per turn via parser events) ──

  /** Model's max prompt tokens (from parser 'model_info' event) */
  maxPromptTokens: number | undefined;
  /** Model's max context window (from parser 'model_info' event) */
  maxContextWindow: number | undefined;
  /** Latest input_tokens value from most recent 'turn_usage' event */
  currentInputTokens: number;
  /** History of input_tokens per turn (for growth rate analysis) */
  tokenHistory: number[];

  // ── Derived state ──

  /** Current pressure level */
  level: 'normal' | 'elevated' | 'critical';
  /** Whether a compaction event was detected */
  compactionDetected: boolean;
  /** Timestamp of last update */
  lastUpdated: number;

  // ── Real-time AI usage (accumulated from debug log per-turn events) ──

  /** Per-model accumulated token usage */
  modelBreakdown?: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    turns: number;
  }>;
  /** Total LLM turns observed */
  totalTurns?: number;
  /** Average turns per second */
  turnsPerSecond?: number;
}

/**
 * Monitors context pressure for a single Copilot CLI agent delegation.
 *
 * Receives token usage, model limits, and compaction events from the
 * Process Output Bus via ContextPressureHandler. Pure logic — no I/O,
 * no filesystem, no raw log parsing.
 *
 * @example
 * ```typescript
 * const monitor = container.resolve<IContextPressureMonitor>(Tokens.IContextPressureMonitor);
 * monitor.recordTurnUsage(45000, 1200);
 * monitor.setModelLimits(136000, 200000);
 * const state = monitor.getState();
 * // state.level === 'normal' | 'elevated' | 'critical'
 * ```
 */
export interface IContextPressureMonitor {
  /** Record a turn's token usage (from parser 'turn_usage' event) */
  recordTurnUsage(inputTokens: number, outputTokens: number): void;
  /** Set model limits (from parser 'model_info' event) */
  setModelLimits(maxPromptTokens: number, maxContextWindow: number): void;
  /** Record a compaction event (from parser 'compaction' event) */
  recordCompaction(): void;
  /** Update real-time AI usage breakdown (called by handler after accumulating) */
  setAiUsage(data: { modelBreakdown: ContextPressureState['modelBreakdown']; totalTurns: number; turnsPerSecond: number }): void;
  /** Get current pressure state */
  getState(): ContextPressureState;
  /** Register callback for pressure level changes */
  onPressureChange(callback: (level: 'normal' | 'elevated' | 'critical', state: ContextPressureState) => void): Disposable;
  /** Reset for a new session */
  reset(): void;
}
