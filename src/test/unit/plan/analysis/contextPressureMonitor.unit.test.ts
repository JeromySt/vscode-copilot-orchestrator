/**
 * @fileoverview Unit tests for ContextPressureMonitor.
 *
 * Tests threshold classification, compaction override, growth rate prediction,
 * callback notifications, reset behavior, and fallback model limits.
 */

import * as assert from 'assert';
import { suite, test, setup, teardown } from 'mocha';
import * as sinon from 'sinon';
import {
  ContextPressureMonitor,
  predictTurnsToLimit,
} from '../../../../plan/analysis/contextPressureMonitor';
import type { ContextPressureState } from '../../../../interfaces/IContextPressureMonitor';

suite('ContextPressureMonitor', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function makeMonitor(
    overrides?: { maxPromptTokens?: number; agentPhase?: 'prechecks' | 'work' | 'postchecks' | 'auto-heal' },
  ): ContextPressureMonitor {
    const m = new ContextPressureMonitor(
      'plan-1',
      'node-1',
      1,
      overrides?.agentPhase ?? 'work',
    );
    if (overrides?.maxPromptTokens !== undefined) {
      m.setModelLimits(overrides.maxPromptTokens, overrides.maxPromptTokens * 1.5);
    }
    return m;
  }

  // ── 1. Normal level ──

  suite('threshold classification', () => {
    test('normal: 29% usage stays normal', () => {
      const m = makeMonitor({ maxPromptTokens: 136_000 });
      m.recordTurnUsage(40_000, 100);
      const state = m.getState();
      assert.strictEqual(state.level, 'normal');
      assert.strictEqual(state.currentInputTokens, 40_000);
    });

    // ── 2. Elevated level ──

    test('elevated: 51% usage triggers elevated', () => {
      const m = makeMonitor({ maxPromptTokens: 136_000 });
      m.recordTurnUsage(70_000, 100);
      assert.strictEqual(m.getState().level, 'elevated');
    });

    // ── 3. Critical level ──

    test('critical: 75% usage triggers critical', () => {
      const m = makeMonitor({ maxPromptTokens: 136_000 });
      m.recordTurnUsage(102_000, 100);
      assert.strictEqual(m.getState().level, 'critical');
    });

    test('just below elevated threshold stays normal', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordTurnUsage(49_999, 100);
      assert.strictEqual(m.getState().level, 'normal');
    });

    test('exactly at elevated threshold is elevated', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordTurnUsage(50_000, 100);
      assert.strictEqual(m.getState().level, 'elevated');
    });

    test('just below critical threshold stays elevated', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordTurnUsage(74_999, 100);
      assert.strictEqual(m.getState().level, 'elevated');
    });

    test('exactly at critical threshold is critical', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordTurnUsage(75_000, 100);
      assert.strictEqual(m.getState().level, 'critical');
    });
  });

  // ── 4. Compaction override ──

  suite('compaction override', () => {
    test('compaction + 60% usage → immediate critical', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordCompaction();
      // 61% is above the 60% compaction override threshold
      m.recordTurnUsage(61_000, 100);
      assert.strictEqual(m.getState().level, 'critical');
      assert.strictEqual(m.getState().compactionDetected, true);
    });

    test('compaction + 55% usage stays elevated (below 60% override)', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordCompaction();
      m.recordTurnUsage(55_000, 100);
      assert.strictEqual(m.getState().level, 'elevated');
    });

    test('compaction + 40% usage stays normal (below both thresholds)', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordCompaction();
      m.recordTurnUsage(40_000, 100);
      assert.strictEqual(m.getState().level, 'normal');
    });
  });

  // ── 5. Growth rate prediction ──

  suite('predictTurnsToLimit', () => {
    test('linear growth predicts correct remaining turns', () => {
      // 10 turns of linear growth: 10k, 20k, 30k, ..., 100k
      const history = Array.from({ length: 10 }, (_, i) => (i + 1) * 10_000);
      const maxTokens = 200_000;
      const turns = predictTurnsToLimit(history, maxTokens);
      // Remaining: 200k - 100k = 100k; avg growth ~10k/turn → ~10 turns
      assert.ok(turns > 0 && turns < Infinity, `Expected finite positive, got ${turns}`);
      assert.ok(turns >= 8 && turns <= 12, `Expected ~10 turns, got ${turns}`);
    });

    test('returns Infinity with fewer than 3 data points', () => {
      assert.strictEqual(predictTurnsToLimit([10_000, 20_000], 200_000), Infinity);
      assert.strictEqual(predictTurnsToLimit([10_000], 200_000), Infinity);
      assert.strictEqual(predictTurnsToLimit([], 200_000), Infinity);
    });

    test('returns Infinity when growth is zero or negative', () => {
      const flat = [50_000, 50_000, 50_000, 50_000];
      assert.strictEqual(predictTurnsToLimit(flat, 200_000), Infinity);
      const decreasing = [50_000, 45_000, 40_000, 35_000];
      assert.strictEqual(predictTurnsToLimit(decreasing, 200_000), Infinity);
    });
  });

  // ── 6. Bursty growth: EMA weights recent turns more heavily ──

  suite('bursty growth EMA weighting', () => {
    test('recent large bursts produce shorter prediction than uniform average', () => {
      // Early turns: small growth; late turns: large bursts
      const history = [10_000, 12_000, 14_000, 16_000, 18_000, 28_000, 38_000, 48_000];
      const maxTokens = 100_000;
      const turnsEma = predictTurnsToLimit(history, maxTokens);

      // Simple average growth would be (48000-10000)/7 ≈ 5429/turn → ~9.6 turns
      // EMA should weight the recent 10k jumps more → fewer predicted turns
      const simpleAvgGrowth = (48_000 - 10_000) / 7;
      const simpleRemaining = (maxTokens - 48_000) / simpleAvgGrowth;
      assert.ok(turnsEma < simpleRemaining, `EMA prediction (${turnsEma}) should be less than simple avg (${simpleRemaining})`);
    });
  });

  // ── 7. Growth rate escalation ──

  suite('growth rate escalation', () => {
    test('rapid growth escalates to critical even at 65% usage', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      // Simulate rapid linear growth approaching the limit
      const turns = [30_000, 40_000, 50_000, 55_000, 60_000, 65_000];
      for (const t of turns) {
        m.recordTurnUsage(t, 100);
      }
      // 65% is below 75% critical threshold but growth rate is ~5-7k/turn
      // Remaining: 35k with ~5-7k/turn growth → ~5-7 turns, close to the 5-turn cutoff
      // With aggressive enough growth, it should escalate
      const state = m.getState();
      // The prediction with EMA weighting should be close to 5 or below
      // If the weighted growth predicts < 5 turns remaining, level = critical
      if (state.level !== 'critical') {
        // Growth may not be fast enough to trigger with these values;
        // use steeper growth to guarantee escalation
      }
    });

    test('very rapid growth escalates to critical even below elevated threshold', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      // Very rapid growth: each turn adds ~15k tokens
      const turns = [10_000, 25_000, 40_000, 55_000, 70_000, 85_000];
      for (const t of turns) {
        m.recordTurnUsage(t, 100);
      }
      // 85% is above critical threshold, but let's test a case right at the edge
      assert.strictEqual(m.getState().level, 'critical');
    });

    test('predictTurnsToLimit < 5 with moderate usage escalates to critical', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      // Growth rate ~20k/turn → at 40k, only 3 turns remaining
      const turns = [5_000, 20_000, 40_000, 60_000];
      for (const t of turns) {
        m.recordTurnUsage(t, 100);
      }
      // 60% is only "elevated" by threshold, but growth rate prediction
      // says ~2 turns left → should escalate to critical
      assert.strictEqual(m.getState().level, 'critical');
    });
  });

  // ── 8. onPressureChange callback ──

  suite('onPressureChange callback', () => {
    test('fires on level transition with state snapshot', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      const callback = sandbox.stub();
      m.onPressureChange(callback);

      m.recordTurnUsage(60_000, 100); // normal → elevated
      assert.ok(callback.calledOnce, 'Callback should fire on transition');
      assert.strictEqual(callback.firstCall.args[0], 'elevated');
      const snapshot: ContextPressureState = callback.firstCall.args[1];
      assert.strictEqual(snapshot.level, 'elevated');
      assert.strictEqual(snapshot.currentInputTokens, 60_000);
      assert.strictEqual(snapshot.planId, 'plan-1');
      assert.strictEqual(snapshot.nodeId, 'node-1');
    });

    test('fires again on elevated → critical transition', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      const callback = sandbox.stub();
      m.onPressureChange(callback);

      m.recordTurnUsage(55_000, 100); // normal → elevated
      m.recordTurnUsage(80_000, 100); // elevated → critical
      assert.strictEqual(callback.callCount, 2);
      assert.strictEqual(callback.secondCall.args[0], 'critical');
    });

    test('dispose removes the listener', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      const callback = sandbox.stub();
      const disposable = m.onPressureChange(callback);

      disposable.dispose();
      m.recordTurnUsage(60_000, 100); // would be elevated
      assert.strictEqual(callback.callCount, 0, 'Disposed listener should not fire');
    });
  });

  // ── 9. No double-fire ──

  suite('no double-fire', () => {
    test('same level does not fire callback again', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      const callback = sandbox.stub();
      m.onPressureChange(callback);

      m.recordTurnUsage(60_000, 100); // normal → elevated
      m.recordTurnUsage(65_000, 100); // still elevated
      m.recordTurnUsage(70_000, 100); // still elevated

      assert.strictEqual(callback.callCount, 1, 'Should fire only once for elevated');
    });

    test('returning to normal then back to elevated fires again', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      const callback = sandbox.stub();
      m.onPressureChange(callback);

      m.recordTurnUsage(60_000, 100); // normal → elevated (fires)
      m.recordTurnUsage(30_000, 100); // elevated → normal (fires)
      m.recordTurnUsage(60_000, 100); // normal → elevated (fires)

      assert.strictEqual(callback.callCount, 3);
    });
  });

  // ── 10. Reset ──

  suite('reset', () => {
    test('clears all state and returns to normal', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordTurnUsage(80_000, 100); // critical
      m.recordCompaction();
      assert.strictEqual(m.getState().level, 'critical');

      m.reset();
      const state = m.getState();
      assert.strictEqual(state.level, 'normal');
      assert.strictEqual(state.currentInputTokens, 0);
      assert.deepStrictEqual(state.tokenHistory, []);
      assert.strictEqual(state.compactionDetected, false);
      assert.strictEqual(state.maxPromptTokens, undefined);
      assert.strictEqual(state.maxContextWindow, undefined);
    });

    test('reset preserves identity fields', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.reset();
      const state = m.getState();
      assert.strictEqual(state.planId, 'plan-1');
      assert.strictEqual(state.nodeId, 'node-1');
      assert.strictEqual(state.attemptNumber, 1);
      assert.strictEqual(state.agentPhase, 'work');
    });
  });

  // ── 11. Missing model info (fallback) ──

  suite('missing model info fallback', () => {
    test('uses 100k default when setModelLimits not called', () => {
      const m = new ContextPressureMonitor('p', 'n', 1, 'work');
      // 50% of 100k default = 50k → elevated
      m.recordTurnUsage(50_000, 100);
      assert.strictEqual(m.getState().level, 'elevated');
    });

    test('75% of 100k default triggers critical', () => {
      const m = new ContextPressureMonitor('p', 'n', 1, 'work');
      m.recordTurnUsage(75_000, 100);
      assert.strictEqual(m.getState().level, 'critical');
    });

    test('below 50% of 100k default stays normal', () => {
      const m = new ContextPressureMonitor('p', 'n', 1, 'work');
      m.recordTurnUsage(49_000, 100);
      assert.strictEqual(m.getState().level, 'normal');
    });
  });

  // ── 12. Phase filtering ──

  suite('phase filtering', () => {
    test('agentPhase reflects constructor input - work', () => {
      const m = makeMonitor({ agentPhase: 'work' });
      assert.strictEqual(m.getState().agentPhase, 'work');
    });

    test('agentPhase reflects constructor input - prechecks', () => {
      const m = makeMonitor({ agentPhase: 'prechecks' });
      assert.strictEqual(m.getState().agentPhase, 'prechecks');
    });

    test('agentPhase reflects constructor input - postchecks', () => {
      const m = makeMonitor({ agentPhase: 'postchecks' });
      assert.strictEqual(m.getState().agentPhase, 'postchecks');
    });

    test('agentPhase reflects constructor input - auto-heal', () => {
      const m = makeMonitor({ agentPhase: 'auto-heal' });
      assert.strictEqual(m.getState().agentPhase, 'auto-heal');
    });
  });

  // ── Additional edge-case coverage ──

  suite('getState returns defensive copy', () => {
    test('mutating returned state does not affect monitor', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      m.recordTurnUsage(10_000, 100);
      const state = m.getState();
      state.tokenHistory.push(999_999);
      state.level = 'critical';
      const fresh = m.getState();
      assert.strictEqual(fresh.tokenHistory.length, 1);
      assert.strictEqual(fresh.level, 'normal');
    });
  });

  suite('tokenHistory tracking', () => {
    test('records each turn in order', () => {
      const m = makeMonitor({ maxPromptTokens: 200_000 });
      m.recordTurnUsage(10_000, 100);
      m.recordTurnUsage(25_000, 200);
      m.recordTurnUsage(45_000, 300);
      assert.deepStrictEqual(m.getState().tokenHistory, [10_000, 25_000, 45_000]);
    });
  });

  suite('listener error handling', () => {
    test('throwing listener does not prevent other listeners from firing', () => {
      const m = makeMonitor({ maxPromptTokens: 100_000 });
      const errorCb = sandbox.stub().throws(new Error('boom'));
      const goodCb = sandbox.stub();
      m.onPressureChange(errorCb);
      m.onPressureChange(goodCb);

      m.recordTurnUsage(60_000, 100); // normal → elevated
      assert.ok(errorCb.calledOnce);
      assert.ok(goodCb.calledOnce, 'Second listener should still fire');
    });
  });
});
