/**
 * @fileoverview Scripted process output definitions for integration testing.
 *
 * Provides typed script definitions and a library of example stdout/stderr/log
 * scripts that exercise every handler in the process output bus system.
 * Each script replays real-world output patterns at controlled timing.
 *
 * @module plan/testing/processScripts
 */

// ─── Script Types ──────────────────────────────────────────────────────────

/**
 * A single line of output with optional delay from the previous line.
 */
export interface ScriptedLine {
  /** The text content of the line (no trailing newline needed). */
  text: string;
  /** Delay in ms before emitting this line (from previous line or process start). */
  delayMs?: number;
}

/**
 * Entries to write to a log file on disk so the log-file tailer can pick them up.
 */
export interface LogFileScript {
  /** Relative path from the worktree root (e.g., 'debug.log'). */
  relativePath: string;
  /** Lines to append to the file over time. */
  lines: ScriptedLine[];
}

/**
 * Full script for a single process invocation. Defines stdout, stderr,
 * log-file entries, and exit behavior.
 */
export interface ProcessScript {
  /** Human-readable label for debugging. */
  label: string;

  /** Match criteria — which spawn() call this script handles. */
  match: ScriptMatchCriteria;

  /** Stdout lines emitted over time. */
  stdout: ScriptedLine[];

  /** Stderr lines (optional). */
  stderr?: ScriptedLine[];

  /** Log-file entries written to disk for tailers. */
  logFiles?: LogFileScript[];

  /** Exit code when the process completes. */
  exitCode: number;

  /** Delay in ms before process "finishes" (after all output). Default: 100ms. */
  exitDelayMs?: number;

  /** Simulate kill signal instead of clean exit. */
  signal?: NodeJS.Signals;

  /** If true, this script can only be consumed once (removed from registry after use). */
  consumeOnce?: boolean;

  /**
   * Checkpoint manifest to write to the worktree's `.orchestrator/checkpoint-manifest.json`
   * BEFORE the process exits. When set, the execution engine's checkpoint detection
   * will find this manifest and trigger the fan-out/fan-in DAG reshape.
   */
  checkpointManifest?: Record<string, unknown>;
}

/**
 * Criteria for matching a spawn() call to a script.
 * All specified fields must match. Unspecified fields match anything.
 */
export interface ScriptMatchCriteria {
  /** Regex or string to match against the command. */
  command?: string | RegExp;
  /** String that must appear in one of the args. */
  argsContain?: string;
  /** String that must appear in the cwd option. */
  cwdContain?: string;
  /** Exact match on the process label (for ManagedProcess matching). */
  processLabel?: string;
}

// ─── Example Script Catalog ────────────────────────────────────────────────

/**
 * Example stdout lines that trigger the SessionIdHandler.
 * Emits a UUID-format session ID early in the process output.
 */
export function sessionIdLines(sessionId = '550e8400-e29b-41d4-a716-446655440000'): ScriptedLine[] {
  return [
    { text: `Starting session: ${sessionId}`, delayMs: 200 },
  ];
}

/**
 * Example stdout lines that trigger the StatsHandler.
 * Covers all regex patterns: premium requests, API time, session time,
 * code changes, model breakdown header, and individual model lines.
 */
export function statsLines(opts?: {
  premiumRequests?: number;
  apiTime?: string;
  sessionTime?: string;
  linesAdded?: number;
  linesRemoved?: number;
  models?: Array<{ model: string; input: string; output: string; cached?: string; premium?: number }>;
}): ScriptedLine[] {
  const o = {
    premiumRequests: 1.5,
    apiTime: '1m 30s',
    sessionTime: '2h 5m 10s',
    linesAdded: 245,
    linesRemoved: 18,
    models: [
      { model: 'claude-sonnet-4', input: '450.2k', output: '12.5k', cached: '5.3k', premium: 1.2 },
      { model: 'gpt-4o', input: '123.4k', output: '45.6k', premium: 0.3 },
    ],
    ...opts,
  };

  const lines: ScriptedLine[] = [
    { text: `Total usage est: ${o.premiumRequests} Premium requests`, delayMs: 50 },
    { text: `API time spent: ${o.apiTime}`, delayMs: 30 },
    { text: `Total session time: ${o.sessionTime}`, delayMs: 30 },
    { text: `Total code changes: +${o.linesAdded} -${o.linesRemoved}`, delayMs: 30 },
    { text: 'Breakdown by AI model:', delayMs: 30 },
  ];

  for (const m of o.models) {
    let line = `  ${m.model} ${m.input} in, ${m.output} out`;
    if (m.cached) { line += `, ${m.cached} cached`; }
    if (m.premium !== undefined) { line += ` (Est. ${m.premium} Premium requests)`; }
    lines.push({ text: line, delayMs: 20 });
  }

  return lines;
}

/**
 * Example stdout line that triggers the TaskCompleteHandler.
 */
export function taskCompleteLines(): ScriptedLine[] {
  return [
    { text: 'Task complete', delayMs: 100 },
  ];
}

/**
 * Example debug-log lines that trigger the ContextPressureHandler.
 * Simulates rising token usage toward the critical threshold.
 *
 * @param level - 'normal' (~30%), 'elevated' (~60%), or 'critical' (~80%)
 * @param longRunning - If true, uses delays matching a ~2 minute execution timeline
 */
export function contextPressureLogLines(level: 'normal' | 'elevated' | 'critical' = 'normal', longRunning = false): ScriptedLine[] {
  const maxPrompt = 136000;
  const maxWindow = 200000;

  // Delays: short (default) vs long-running (~2min spaced)
  const shortDelay = 500;

  const usageByLevel = {
    normal: [
      { input: 20000, output: 1200, delayMs: longRunning ? 10000 : shortDelay },
      { input: 35000, output: 2400, delayMs: longRunning ? 15000 : shortDelay },
    ],
    elevated: [
      { input: 20000, output: 1200, delayMs: longRunning ? 8000 : shortDelay },
      { input: 50000, output: 3000, delayMs: longRunning ? 12000 : shortDelay },
      { input: 75000, output: 5000, delayMs: longRunning ? 10000 : shortDelay },
    ],
    critical: [
      // Phase 1 (~25s): Normal pressure — light token usage
      { input: 20000, output: 1200, delayMs: longRunning ? 8000 : shortDelay },
      { input: 35000, output: 2400, delayMs: longRunning ? 10000 : shortDelay },
      { input: 48000, output: 3800, delayMs: longRunning ? 8000 : shortDelay },
      // Phase 2 (~25s): Elevated pressure — growing usage
      { input: 62000, output: 5200, delayMs: longRunning ? 10000 : shortDelay },
      { input: 78000, output: 7000, delayMs: longRunning ? 8000 : shortDelay },
      { input: 92000, output: 8500, delayMs: longRunning ? 8000 : shortDelay },
      // Phase 3 (~20s): Critical pressure — approaching limit
      { input: 105000, output: 10000, delayMs: longRunning ? 8000 : shortDelay },
      { input: 115000, output: 11500, delayMs: longRunning ? 6000 : shortDelay },
      { input: 120000, output: 12000, delayMs: longRunning ? 5000 : shortDelay },
    ],
  };

  const lines: ScriptedLine[] = [
    {
      text: `{"max_prompt_tokens": ${maxPrompt}, "max_context_window_tokens": ${maxWindow}}`,
      delayMs: longRunning ? 2000 : 200,
    },
  ];

  for (const usage of usageByLevel[level]) {
    // Include model name so the handler can extract it from the window
    lines.push({
      text: `{"kind": "assistant_usage", "model": "claude-sonnet-4", "input_tokens": ${usage.input}, "output_tokens": ${usage.output}, "cache_read_tokens": ${Math.round(usage.input * 0.85)}}`,
      delayMs: usage.delayMs,
    });
  }

  if (level === 'critical') {
    lines.push({
      text: '{"event": "context_truncation", "truncateBasedOn": "tokenCount"}',
      delayMs: 300,
    });
  }

  return lines;
}

// ─── Pre-Built Scripts for Common Scenarios ────────────────────────────────

/**
 * Script for a successful agent job with full handler coverage.
 * Exercises: SessionIdHandler, StatsHandler, TaskCompleteHandler.
 */
export function successfulAgentScript(label: string, match: ScriptMatchCriteria): ProcessScript {
  return {
    label,
    match,
    stdout: [
      ...sessionIdLines(),
      { text: 'Copilot is working on the task...', delayMs: 300 },
      { text: 'Applying changes to src/main.ts', delayMs: 500 },
      { text: 'Running tests to verify...', delayMs: 400 },
      ...statsLines(),
      ...taskCompleteLines(),
    ],
    exitCode: 0,
    exitDelayMs: 200,
  };
}

/**
 * Script for a successful shell command (simple exit 0).
 */
export function successfulShellScript(label: string, match: ScriptMatchCriteria, output?: string[]): ProcessScript {
  return {
    label,
    match,
    stdout: (output || ['OK']).map((text, i) => ({ text, delayMs: i === 0 ? 100 : 50 })),
    exitCode: 0,
    exitDelayMs: 100,
  };
}

/**
 * Script for a failing shell command.
 */
export function failingShellScript(label: string, match: ScriptMatchCriteria, stderr?: string[]): ProcessScript {
  return {
    label,
    match,
    stdout: [{ text: 'Starting...', delayMs: 100 }],
    stderr: (stderr || ['Error: command failed']).map((text, i) => ({ text, delayMs: i === 0 ? 200 : 50 })),
    exitCode: 1,
    exitDelayMs: 100,
  };
}

/**
 * Script for a job that fails on first attempt but succeeds on retry.
 * Returns TWO scripts: one with consumeOnce=true that fails, and one that succeeds.
 */
export function failThenSucceedScripts(label: string, match: ScriptMatchCriteria): ProcessScript[] {
  return [
    {
      label: `${label} (fail attempt)`,
      match,
      stdout: [
        ...sessionIdLines('660e8400-e29b-41d4-a716-446655440001'),
        { text: 'Working on task...', delayMs: 300 },
        { text: 'Error: compilation failed', delayMs: 500 },
      ],
      stderr: [
        { text: 'src/broken.ts(12,5): error TS2304: Cannot find name \'missing\'', delayMs: 100 },
      ],
      exitCode: 1,
      exitDelayMs: 100,
      consumeOnce: true,
    },
    {
      label: `${label} (succeed retry)`,
      match,
      stdout: [
        ...sessionIdLines('770e8400-e29b-41d4-a716-446655440002'),
        { text: 'Retrying task with fresh context...', delayMs: 200 },
        { text: 'Fixed the issue, applying changes...', delayMs: 600 },
        ...statsLines({ premiumRequests: 0.8, apiTime: '45s', sessionTime: '1m 20s', linesAdded: 12, linesRemoved: 3 }),
        ...taskCompleteLines(),
      ],
      exitCode: 0,
      exitDelayMs: 200,
    },
  ];
}

/**
 * Script that always fails (for blocked-downstream testing).
 */
export function alwaysFailsScript(label: string, match: ScriptMatchCriteria): ProcessScript {
  return {
    label,
    match,
    stdout: [
      { text: 'Attempting work...', delayMs: 200 },
      { text: 'Fatal: unrecoverable error', delayMs: 500 },
    ],
    stderr: [
      { text: 'FATAL: Cannot proceed - missing required dependency', delayMs: 100 },
    ],
    exitCode: 1,
    exitDelayMs: 100,
  };
}

/**
 * Script for a job that produces no changes (expectsNoChanges path).
 */
export function noChangesScript(label: string, match: ScriptMatchCriteria): ProcessScript {
  return {
    label,
    match,
    stdout: [
      { text: 'Analyzing code...', delayMs: 200 },
      { text: 'All checks passed, no changes needed.', delayMs: 400 },
      ...statsLines({
        premiumRequests: 0.2,
        apiTime: '10s',
        sessionTime: '15s',
        linesAdded: 0,
        linesRemoved: 0,
        models: [{ model: 'claude-sonnet-4', input: '50k', output: '2k' }],
      }),
      ...taskCompleteLines(),
    ],
    exitCode: 0,
    exitDelayMs: 100,
  };
}

/**
 * Script for a postcheck that fails (tests fail).
 */
export function failingPostcheckScript(label: string, match: ScriptMatchCriteria): ProcessScript {
  return {
    label,
    match,
    stdout: [
      { text: 'Running tests...', delayMs: 100 },
      { text: '47 passing', delayMs: 300 },
      { text: '3 failing', delayMs: 50 },
    ],
    stderr: [
      { text: 'Test suite failed: 3 of 50 tests failed', delayMs: 100 },
    ],
    exitCode: 1,
    exitDelayMs: 100,
  };
}

/**
 * Script for a successful postcheck.
 */
export function passingPostcheckScript(label: string, match: ScriptMatchCriteria): ProcessScript {
  return {
    label,
    match,
    stdout: [
      { text: 'Running tests...', delayMs: 100 },
      { text: '50 passing', delayMs: 400 },
      { text: '0 failing', delayMs: 50 },
    ],
    exitCode: 0,
    exitDelayMs: 100,
  };
}

/**
 * Git process scripts — simulates common git operations.
 */
export function gitSuccessScript(label: string, match: ScriptMatchCriteria, output?: string[]): ProcessScript {
  return {
    label,
    match,
    stdout: (output || ['']).map((text, i) => ({ text, delayMs: i === 0 ? 50 : 20 })),
    exitCode: 0,
    exitDelayMs: 50,
  };
}
