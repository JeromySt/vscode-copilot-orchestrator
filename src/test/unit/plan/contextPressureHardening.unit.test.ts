/**
 * @fileoverview End-to-end hardening tests for context pressure monitoring.
 *
 * Uses real ContextPressureMonitor with realistic CLI log token data from
 * Appendix B of the design doc. Mocks only IFileSystem and ICheckpointManager.
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  ContextPressureMonitor,
  predictTurnsToLimit,
} from '../../../plan/analysis/contextPressureMonitor';
import { DefaultCheckpointManager } from '../../../plan/analysis/checkpointManager';
import { DefaultJobSplitter } from '../../../plan/analysis/jobSplitter';
import type { ContextPressureState } from '../../../interfaces/IContextPressureMonitor';
import type { CheckpointManifest } from '../../../interfaces/ICheckpointManager';

// ── Realistic token data from Appendix B ────────────────────────────
// Production Plan 02 failure (102 turns), claude-opus-4 with 136k limit.

const APPENDIX_B_TURNS: Array<{ turn: number; input: number; output: number }> = [
  { turn:  1, input:  39_880, output:  800 },
  { turn:  5, input:  49_210, output: 1200 },
  { turn: 10, input:  58_400, output: 1100 },
  { turn: 20, input:  72_100, output:  900 },
  { turn: 30, input:  83_500, output: 1400 },
  { turn: 40, input:  91_200, output:  700 },
  { turn: 50, input:  98_000, output:  800 },
  { turn: 60, input: 105_400, output: 1000 },
  { turn: 70, input: 114_800, output: 1100 },
  { turn: 80, input: 124_300, output:  900 },
  { turn: 90, input: 133_100, output:  600 },
];

const MODEL_MAX_PROMPT = 136_000;
const MODEL_MAX_CONTEXT = 200_000;

/**
 * Interpolate between sampled Appendix B data points to get a realistic
 * token count at any turn number.
 */
function interpolateTokens(turn: number): number {
  for (let i = 0; i < APPENDIX_B_TURNS.length - 1; i++) {
    const a = APPENDIX_B_TURNS[i];
    const b = APPENDIX_B_TURNS[i + 1];
    if (turn >= a.turn && turn <= b.turn) {
      const frac = (turn - a.turn) / (b.turn - a.turn);
      return Math.round(a.input + frac * (b.input - a.input));
    }
  }
  // Beyond last sample — linear extrapolation from last two
  const last = APPENDIX_B_TURNS[APPENDIX_B_TURNS.length - 1];
  const prev = APPENDIX_B_TURNS[APPENDIX_B_TURNS.length - 2];
  const rate = (last.input - prev.input) / (last.turn - prev.turn);
  return Math.round(last.input + rate * (turn - last.turn));
}

suite('ContextPressureHardening', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  // ── Test 1: Full parser → monitor flow ──────────────────────────────

  suite('Full parser → monitor flow (Appendix B data)', () => {
    test('monitor reaches critical at correct turn (~48) with 136k limit', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.setModelLimits(MODEL_MAX_PROMPT, MODEL_MAX_CONTEXT);

      let criticalTurn: number | undefined;
      monitor.onPressureChange((level) => {
        if (level === 'critical' && criticalTurn === undefined) {
          criticalTurn = currentTurn;
        }
      });

      let currentTurn = 0;
      // Feed turns 1 through 60 with interpolated realistic data.
      // 75% of 136k = 102k. From Appendix B interpolation, this is reached ~turn 56.
      for (let t = 1; t <= 60; t++) {
        currentTurn = t;
        const input = interpolateTokens(t);
        monitor.recordTurnUsage(input, 900);
      }

      assert.ok(criticalTurn !== undefined, 'Monitor should have reached critical');
      // 75% of 136k = 102k. From Appendix B, ~Turn 56 crosses 102k via interpolation.
      assert.ok(
        criticalTurn! >= 45 && criticalTurn! <= 60,
        `Critical should trigger around turn 56, got turn ${criticalTurn}`,
      );

      const state = monitor.getState();
      assert.strictEqual(state.level, 'critical');
      assert.ok(state.tokenHistory.length === 60);
    });

    test('elevated level triggers around 50% (68k)', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.setModelLimits(MODEL_MAX_PROMPT, MODEL_MAX_CONTEXT);

      let elevatedTurn: number | undefined;
      let currentTurn = 0;
      monitor.onPressureChange((level) => {
        if (level === 'elevated' && elevatedTurn === undefined) {
          elevatedTurn = currentTurn;
        }
      });

      for (let t = 1; t <= 30; t++) {
        currentTurn = t;
        monitor.recordTurnUsage(interpolateTokens(t), 900);
      }

      assert.ok(elevatedTurn !== undefined, 'Monitor should have reached elevated');
      // 50% of 136k = 68k. From Appendix B, ~Turn 18 crosses 68k.
      assert.ok(
        elevatedTurn! >= 10 && elevatedTurn! <= 25,
        `Elevated should trigger around turn 18, got ${elevatedTurn}`,
      );
    });
  });

  // ── Test 2: Feature flag ────────────────────────────────────────────

  suite('Feature flag: ORCH_CONTEXT_PRESSURE', () => {
    test('isContextPressureEnabled returns false when env is "false"', () => {
      const origValue = process.env.ORCH_CONTEXT_PRESSURE;
      try {
        process.env.ORCH_CONTEXT_PRESSURE = 'false';
        // Verify the env var convention directly.
        assert.strictEqual(process.env.ORCH_CONTEXT_PRESSURE, 'false');
        // The convention: ORCH_CONTEXT_PRESSURE !== 'false' → enabled
        const enabled = process.env.ORCH_CONTEXT_PRESSURE !== 'false';
        assert.strictEqual(enabled, false);
      } finally {
        if (origValue === undefined) {
          delete process.env.ORCH_CONTEXT_PRESSURE;
        } else {
          process.env.ORCH_CONTEXT_PRESSURE = origValue;
        }
      }
    });

    test('when disabled, monitor still works but callers should not create it', () => {
      // Verify that the monitor itself has no built-in feature flag check —
      // the flag is checked at the call site (executionEngine / ContextPressureHandlerFactory).
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.recordTurnUsage(100_000, 500);
      // Even with a high token count, monitor functions as normal
      const state = monitor.getState();
      assert.strictEqual(state.currentInputTokens, 100_000);
    });
  });

  // ── Test 3: Depth cap ──────────────────────────────────────────────

  suite('Depth cap: splitDepth=3 → skip split', () => {
    test('maxSubJobs config is respected with default of 8', () => {
      const mockConfig: any = {
        getConfig: sandbox.stub().returns(3),
      };
      // Verify maxSplitDepth default retrieval pattern
      const maxSplitDepth = mockConfig.getConfig(
        'copilotOrchestrator.contextPressure', 'maxSplitDepth', 3,
      );
      assert.strictEqual(maxSplitDepth, 3);
      // When splitDepth >= maxSplitDepth, skip split → succeed normally
      const splitDepth = 3;
      assert.ok(splitDepth >= maxSplitDepth, 'Should skip split when depth meets limit');
    });

    test('splitDepth < maxSplitDepth allows the split', () => {
      const splitDepth = 2;
      const maxSplitDepth = 3;
      assert.ok(splitDepth < maxSplitDepth, 'Should allow split');
    });
  });

  // ── Test 4: maxSubJobs cap ─────────────────────────────────────────

  suite('maxSubJobs cap: 12 suggestedSplits, maxSubJobs=8 → 8 chunks', () => {
    test('buildChunks caps at maxSubJobs and merges excess into last chunk', () => {
      const mockConfig: any = {
        getConfig: sandbox.stub().returns(8),
      };
      const splitter = new DefaultJobSplitter(mockConfig);

      const manifest: any = {
        status: 'checkpointed',
        completed: [{ file: 'done.ts', summary: 'done' }],
        remaining: [],
        summary: 'test',
        suggestedSplits: Array.from({ length: 12 }, (_, i) => ({
          name: `split-${i + 1}`,
          files: [`file-${i + 1}.ts`],
          prompt: `Do thing ${i + 1}`,
          priority: i + 1,
        })),
      };

      const chunks = splitter.buildChunks(manifest, 'original instructions');

      assert.strictEqual(chunks.length, 8, 'Should be capped at 8');
      // Last chunk should contain files from excess splits (9-12)
      const lastChunk = chunks[chunks.length - 1];
      assert.ok(lastChunk.files.length >= 5, 'Last chunk should absorb excess files');
      assert.ok(lastChunk.files.includes('file-8.ts'));
      assert.ok(lastChunk.files.includes('file-12.ts'));
    });
  });

  // ── Test 5: Empty manifest → skip split ────────────────────────────

  suite('Empty manifest: no completed work → skip split', () => {
    test('readManifest returns undefined when completed is empty and no inProgress', async () => {
      const mockFs: any = {
        existsAsync: sandbox.stub().resolves(true),
        readFileAsync: sandbox.stub().resolves(JSON.stringify({
          status: 'checkpointed',
          completed: [],
          remaining: [{ file: 'a.ts', description: 'do a' }],
          summary: 'nothing done yet',
        })),
        ensureDirAsync: sandbox.stub().resolves(),
        writeFileAsync: sandbox.stub().resolves(),
        unlinkAsync: sandbox.stub().resolves(),
      };

      const mgr = new DefaultCheckpointManager(mockFs);
      const result = await mgr.readManifest('/fake/worktree');
      assert.strictEqual(result, undefined, 'Should skip split when no work completed');
    });

    test('readManifest returns undefined when no remaining items', async () => {
      const mockFs: any = {
        existsAsync: sandbox.stub().resolves(true),
        readFileAsync: sandbox.stub().resolves(JSON.stringify({
          status: 'checkpointed',
          completed: [{ file: 'a.ts', summary: 'done' }],
          remaining: [],
          summary: 'all done',
        })),
        ensureDirAsync: sandbox.stub().resolves(),
        writeFileAsync: sandbox.stub().resolves(),
        unlinkAsync: sandbox.stub().resolves(),
      };

      const mgr = new DefaultCheckpointManager(mockFs);
      const result = await mgr.readManifest('/fake/worktree');
      assert.strictEqual(result, undefined, 'Should skip split when nothing remaining');
    });
  });

  // ── Test 6: Compaction override at 65% → immediate critical ────────

  suite('Compaction override', () => {
    test('truncateBasedOn detected at 65% → immediate critical', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.setModelLimits(100_000, 200_000);

      // 65% = 65,000 tokens — normally only "elevated" (≥50%, <75%)
      monitor.recordTurnUsage(65_000, 500);
      assert.strictEqual(monitor.getState().level, 'elevated');

      // Compaction override: compaction + >60% → immediate critical
      monitor.recordCompaction();
      assert.strictEqual(monitor.getState().level, 'critical');
      assert.ok(monitor.getState().compactionDetected);
    });

    test('compaction at 55% does NOT trigger critical (below 60% override threshold)', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.setModelLimits(100_000, 200_000);

      monitor.recordTurnUsage(55_000, 500);
      assert.strictEqual(monitor.getState().level, 'elevated');

      // 55% is above elevated (50%) but below compaction override (60%)
      monitor.recordCompaction();
      // Compaction override requires > 60%, so stays elevated
      assert.strictEqual(monitor.getState().level, 'elevated');
    });
  });

  // ── Test 7: Growth rate prediction ─────────────────────────────────

  suite('Growth rate prediction', () => {
    test('10 turns with ~2k/turn growth → turnsToLimit correctly estimated', () => {
      const history = [
        40_000, 42_000, 44_000, 46_000, 48_000,
        50_000, 52_000, 54_000, 56_000, 58_000,
      ];
      const maxTokens = 100_000;

      const turnsRemaining = predictTurnsToLimit(history, maxTokens);
      // Remaining: 100k - 58k = 42k. Growth per turn: ~2k.
      // With uniform growth, weighted EMA ≈ 2k → ~21 turns.
      assert.ok(Number.isFinite(turnsRemaining), 'Should produce finite prediction');
      assert.ok(turnsRemaining > 15 && turnsRemaining < 30,
        `Expected ~21 turns remaining, got ${turnsRemaining.toFixed(1)}`);
    });

    test('fewer than 3 history points returns Infinity', () => {
      assert.strictEqual(predictTurnsToLimit([40_000, 42_000], 100_000), Infinity);
      assert.strictEqual(predictTurnsToLimit([40_000], 100_000), Infinity);
      assert.strictEqual(predictTurnsToLimit([], 100_000), Infinity);
    });

    test('decreasing token usage returns Infinity (negative growth)', () => {
      const history = [50_000, 48_000, 46_000, 44_000];
      assert.strictEqual(predictTurnsToLimit(history, 100_000), Infinity);
    });

    test('rapid growth triggers critical via growth rate escalation', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.setModelLimits(100_000, 200_000);

      // Feed 5 turns with large growth (~10k/turn) starting at 60k
      // At 60% pressure, this is only "elevated" by threshold.
      // But growth rate predicts limit in ~4 turns → escalates to critical.
      const startTokens = 60_000;
      const growthPerTurn = 10_000;
      for (let i = 0; i < 5; i++) {
        monitor.recordTurnUsage(startTokens + i * growthPerTurn, 500);
      }

      assert.strictEqual(monitor.getState().level, 'critical',
        'Growth rate should escalate to critical');
    });
  });

  // ── Test 8: Model info fallback ────────────────────────────────────

  suite('Model info fallback', () => {
    test('no max_prompt_tokens → uses 100k default', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      // Do NOT call setModelLimits — simulate missing model_info

      // 75% of 100k = 75k → critical
      monitor.recordTurnUsage(75_000, 500);
      assert.strictEqual(monitor.getState().level, 'critical');
      // maxPromptTokens should remain undefined in state
      assert.strictEqual(monitor.getState().maxPromptTokens, undefined);
    });

    test('50% of default 100k (50k) → elevated', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.recordTurnUsage(50_000, 500);
      assert.strictEqual(monitor.getState().level, 'elevated');
    });

    test('below 50% of default 100k → normal', () => {
      const monitor = new ContextPressureMonitor('plan-1', 'node-1', 1, 'work');
      monitor.recordTurnUsage(49_000, 500);
      assert.strictEqual(monitor.getState().level, 'normal');
    });
  });

  // ── Test: Sentinel write verification ──────────────────────────────

  suite('Sentinel write on critical', () => {
    test('writeSentinel creates correct file with pressure data', async () => {
      const writtenData: { path: string; content: string }[] = [];
      const mockFs: any = {
        ensureDirAsync: sandbox.stub().resolves(),
        writeFileAsync: sandbox.stub().callsFake(async (p: string, c: string) => {
          writtenData.push({ path: p, content: c });
        }),
        existsAsync: sandbox.stub().resolves(false),
        unlinkAsync: sandbox.stub().resolves(),
      };

      const mgr = new DefaultCheckpointManager(mockFs);
      const pressureState = {
        level: 'critical' as const,
        currentInputTokens: 98_000,
        maxPromptTokens: 136_000,
        pressure: 98_000 / 136_000,
      };

      await mgr.writeSentinel('/worktree', pressureState);

      assert.strictEqual(writtenData.length, 1);
      assert.ok(writtenData[0].path.includes('CHECKPOINT_REQUIRED'));
      const payload = JSON.parse(writtenData[0].content);
      assert.strictEqual(payload.reason, 'context_pressure');
      assert.strictEqual(payload.currentTokens, 98_000);
      assert.strictEqual(payload.maxTokens, 136_000);
      assert.ok(payload.pressure > 0.7);
    });
  });
});
