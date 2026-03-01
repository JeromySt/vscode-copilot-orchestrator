/**
 * @fileoverview Unit tests for plan state history types.
 * 
 * Verifies that the new history tracking interfaces serialize/deserialize correctly
 * and maintain backward compatibility with plans that don't have these fields.
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import type { 
  PlanStateChange, 
  PauseInterval, 
  PhaseTiming, 
  PlanInstance,
  AttemptRecord,
  NodeExecutionState
} from '../../../../plan/types/plan';

suite('State History Types', () => {
  suite('PlanStateChange', () => {
    test('should accept valid state change object', () => {
      const stateChange: PlanStateChange = {
        status: 'running',
        timestamp: Date.now(),
        reason: 'started',
      };
      
      assert.strictEqual(typeof stateChange.status, 'string');
      assert.strictEqual(typeof stateChange.timestamp, 'number');
      assert.strictEqual(stateChange.reason, 'started');
    });

    test('should work without optional reason field', () => {
      const stateChange: PlanStateChange = {
        status: 'paused',
        timestamp: Date.now(),
      };
      
      assert.strictEqual(stateChange.status, 'paused');
      assert.strictEqual(stateChange.reason, undefined);
    });
  });

  suite('PauseInterval', () => {
    test('should accept valid pause interval', () => {
      const interval: PauseInterval = {
        pausedAt: Date.now(),
        resumedAt: Date.now() + 1000,
        reason: 'user',
      };
      
      assert.strictEqual(typeof interval.pausedAt, 'number');
      assert.strictEqual(typeof interval.resumedAt, 'number');
      assert.strictEqual(interval.reason, 'user');
    });

    test('should work with currently paused interval', () => {
      const interval: PauseInterval = {
        pausedAt: Date.now(),
        reason: 'startPaused',
      };
      
      assert.strictEqual(typeof interval.pausedAt, 'number');
      assert.strictEqual(interval.resumedAt, undefined);
    });
  });

  suite('PhaseTiming', () => {
    test('should accept valid phase timing', () => {
      const timing: PhaseTiming = {
        phase: 'work',
        startedAt: Date.now(),
        endedAt: Date.now() + 5000,
      };
      
      assert.strictEqual(timing.phase, 'work');
      assert.strictEqual(typeof timing.startedAt, 'number');
      assert.strictEqual(typeof timing.endedAt, 'number');
    });

    test('should work with running phase', () => {
      const timing: PhaseTiming = {
        phase: 'prechecks',
        startedAt: Date.now(),
      };
      
      assert.strictEqual(timing.phase, 'prechecks');
      assert.strictEqual(timing.endedAt, undefined);
    });
  });

  suite('Backward Compatibility', () => {
    test('PlanInstance should work without stateHistory', () => {
      const plan: Partial<PlanInstance> = {
        id: 'plan-001',
        stateVersion: 1,
        // No stateHistory or pauseHistory
      };
      
      assert.strictEqual(plan.stateHistory, undefined);
      assert.strictEqual(plan.pauseHistory, undefined);
    });

    test('PlanInstance should work with stateHistory', () => {
      const plan: Partial<PlanInstance> = {
        id: 'plan-002',
        stateVersion: 1,
        stateHistory: [
          { from: '', to: 'pending', timestamp: 1000 },
          { from: 'pending', to: 'running', timestamp: 2000, reason: 'started' },
        ],
        pauseHistory: [
          { pausedAt: 3000, resumedAt: 4000, reason: 'user' },
        ],
      };
      
      assert.strictEqual(plan.stateHistory?.length, 2);
      assert.strictEqual(plan.pauseHistory?.length, 1);
    });

    test('AttemptRecord should work without phaseTiming', () => {
      const attempt: Partial<AttemptRecord> = {
        attemptNumber: 1,
        status: 'succeeded',
        startedAt: 1000,
        endedAt: 2000,
        // No phaseTiming
      };
      
      assert.strictEqual(attempt.phaseTiming, undefined);
    });

    test('AttemptRecord should work with phaseTiming', () => {
      const attempt: Partial<AttemptRecord> = {
        attemptNumber: 1,
        status: 'succeeded',
        startedAt: 1000,
        endedAt: 5000,
        phaseTiming: [
          { phase: 'merge-fi', startedAt: 1000, endedAt: 1500 },
          { phase: 'prechecks', startedAt: 1500, endedAt: 2000 },
          { phase: 'work', startedAt: 2000, endedAt: 4000 },
          { phase: 'commit', startedAt: 4000, endedAt: 4500 },
          { phase: 'merge-ri', startedAt: 4500, endedAt: 5000 },
        ],
      };
      
      assert.strictEqual(attempt.phaseTiming?.length, 5);
      assert.strictEqual(attempt.phaseTiming?.[0].phase, 'merge-fi');
    });

    test('NodeExecutionState should work without transitionLog', () => {
      const state: Partial<NodeExecutionState> = {
        status: 'running',
        version: 1,
        attempts: 1,
        // No transitionLog
      };
      
      assert.strictEqual(state.transitionLog, undefined);
    });

    test('NodeExecutionState should work with transitionLog', () => {
      const state: Partial<NodeExecutionState> = {
        status: 'running',
        version: 3,
        attempts: 1,
        transitionLog: [
          { from: 'pending', to: 'ready', timestamp: 1000 },
          { from: 'ready', to: 'running', timestamp: 2000 },
        ],
      };
      
      assert.strictEqual(state.transitionLog?.length, 2);
      assert.strictEqual(state.transitionLog?.[0].from, 'pending');
      assert.strictEqual(state.transitionLog?.[0].to, 'ready');
    });
  });

  suite('Serialization', () => {
    test('should serialize and deserialize stateHistory', () => {
      const original = [
        { status: 'pending', timestamp: 1000 },
        { status: 'running', timestamp: 2000, reason: 'started' },
        { status: 'paused', timestamp: 3000, reason: 'user-paused' },
      ];
      
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json);
      
      assert.deepStrictEqual(parsed, original);
    });

    test('should serialize and deserialize pauseHistory', () => {
      const original = [
        { pausedAt: 1000, resumedAt: 2000, reason: 'user' },
        { pausedAt: 3000, reason: 'startPaused' },
      ];
      
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json);
      
      assert.deepStrictEqual(parsed, original);
    });

    test('should serialize and deserialize phaseTiming', () => {
      const original = [
        { phase: 'work', startedAt: 1000, endedAt: 5000 },
        { phase: 'commit', startedAt: 5000, endedAt: 6000 },
      ];
      
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json);
      
      assert.deepStrictEqual(parsed, original);
    });

    test('should serialize and deserialize transitionLog', () => {
      const original = [
        { from: 'pending', to: 'ready', timestamp: 1000 },
        { from: 'ready', to: 'running', timestamp: 2000 },
      ];
      
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json);
      
      assert.deepStrictEqual(parsed, original);
    });
  });
});
