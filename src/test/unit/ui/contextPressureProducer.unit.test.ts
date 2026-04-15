import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ContextPressureProducer } from '../../../ui/producers/contextPressureProducer';
import { computeSplitRisk, computeGrowthRate } from '../../../ui/webview/controls/contextPressureCard';
import type { ContextPressureState } from '../../../interfaces/IContextPressureMonitor';

function makeState(overrides?: Partial<ContextPressureState>): ContextPressureState {
  return {
    planId: 'p1', nodeId: 'n1', attemptNumber: 1, agentPhase: 'work',
    maxPromptTokens: 136_000, maxContextWindow: 200_000,
    currentInputTokens: 50_000, tokenHistory: [50_000],
    level: 'normal', compactionDetected: false, lastUpdated: 100,
    ...overrides,
  };
}

suite('ContextPressureProducer', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  suite('readFull', () => {
    test('returns state content and lastUpdated cursor', () => {
      const state = makeState({ lastUpdated: 42 });
      const producer = new ContextPressureProducer(() => ({ getState: () => state } as any));
      const result = producer.readFull('p1:n1');
      assert.deepStrictEqual(result, { content: state, cursor: 42 });
    });

    test('returns null when monitor not found', () => {
      const producer = new ContextPressureProducer(() => undefined);
      assert.strictEqual(producer.readFull('p1:n1'), null);
    });
  });

  suite('readDelta', () => {
    test('returns new state when lastUpdated > cursor', () => {
      const state = makeState({ lastUpdated: 200 });
      const producer = new ContextPressureProducer(() => ({ getState: () => state } as any));
      const result = producer.readDelta('p1:n1', 100);
      assert.deepStrictEqual(result, { content: state, cursor: 200 });
    });

    test('returns null when lastUpdated <= cursor', () => {
      const state = makeState({ lastUpdated: 100 });
      const producer = new ContextPressureProducer(() => ({ getState: () => state } as any));
      assert.strictEqual(producer.readDelta('p1:n1', 100), null);
    });
  });
});

suite('computeSplitRisk', () => {
  test('critical level returns Imminent with 0 turns', () => {
    const result = computeSplitRisk(makeState({ level: 'critical' }));
    assert.strictEqual(result.label, 'Imminent');
    assert.strictEqual(result.turnsRemaining, 0);
  });

  test('elevated with turnsLeft < 10 returns High', () => {
    // history grows ~2k/turn, 5k headroom → ~3 turns
    const history = [87_000, 89_000, 91_000, 93_000, 95_000];
    const result = computeSplitRisk(makeState({
      level: 'elevated', maxPromptTokens: 100_000, tokenHistory: history,
    }));
    assert.strictEqual(result.label, 'High');
    assert.ok(result.turnsRemaining < 10);
  });

  test('elevated with turnsLeft >= 20 returns Low', () => {
    const history = [10_000, 12_000, 14_000, 16_000, 18_000];
    const result = computeSplitRisk(makeState({
      level: 'elevated', maxPromptTokens: 200_000, tokenHistory: history,
    }));
    assert.strictEqual(result.label, 'Low');
    assert.ok(result.turnsRemaining >= 20);
  });

  test('normal level returns None', () => {
    const result = computeSplitRisk(makeState({ level: 'normal' }));
    assert.strictEqual(result.label, 'None');
    assert.strictEqual(result.turnsRemaining, Infinity);
  });
});

suite('computeGrowthRate', () => {
  test('5-turn history returns average per-turn growth', () => {
    // Constant 2k growth → EMA weighted average still 2000
    const rate = computeGrowthRate([10_000, 12_000, 14_000, 16_000, 18_000]);
    assert.strictEqual(rate, 2_000);
  });

  test('fewer than 2 turns returns 0', () => {
    assert.strictEqual(computeGrowthRate([10_000]), 0);
    assert.strictEqual(computeGrowthRate([]), 0);
  });
});
